/**
 * SpawnAreaManager — the population exists only where players are.
 *
 * A `spawnArea` component (core schema) marks a place with a pack of NPC
 * templates. Nothing is spawned at boot. The first player inside `radius`
 * wakes the area: its NPCs spawn (once) and simulate; when no player has
 * been inside `sleepRadius` for `idleSeconds`, the pack is PAUSED in place
 * — scripts suspended, bodies pulled out of the physics world, the ground
 * under them free to unload — and resumed exactly where it stood when
 * someone comes back. A layer's cost therefore scales with its players,
 * not with the size of the world, which is what makes whole-world layers
 * affordable (docs/hosting.md).
 *
 * The pack's home, leash and roam radius are handed to each NPC's root
 * script as params (`home`, `leash`, `roam`, `spawnArea`) for the brain to
 * honour; the manager fences at 1.5× the leash as a backstop so a bug in a
 * brain cannot drag a pack into a transfer band.
 *
 * `clearToTransfer(peerId)` is the layer's default transfer gate: nobody
 * is moved between layers within sight of an awake pack, so a swap never
 * shows enemies blinking.
 */

import type { EntityDoc, SpawnAreaData } from "@hitreg/core";
import type { GameServer } from "./server.js";
import type { NpcManager } from "./npcs.js";

export interface SpawnAreaRecord {
  id: string;
  position: [number, number, number];
  data: SpawnAreaData;
  awake: boolean;
  /** Root ids of the NPCs this area owns (empty until first woken). */
  npcIds: string[];
  /** Last tick a player was inside the sleep radius. */
  lastNearTick: number;
  wokeCount: number;
}

export interface SpawnAreaManagerOptions {
  /** Ticks between residency checks (default 20 → 3 Hz at 60 Hz). */
  every?: number;
  /** Extra metres beyond `radius` a transfer is refused within (default 20). */
  transferMargin?: number;
}

export class SpawnAreaManager {
  readonly areas = new Map<string, SpawnAreaRecord>();
  private readonly every: number;
  private readonly transferMargin: number;
  private readonly fenced = new Set<string>();

  constructor(
    readonly server: GameServer,
    readonly npcs: NpcManager,
    opts: SpawnAreaManagerOptions = {},
  ) {
    this.every = opts.every ?? 20;
    this.transferMargin = opts.transferMargin ?? 20;
    for (const [id, e] of server.world.entities) this.adopt(id, e);
    server.world.afterStep.add(this.afterStep);
  }

  /** Register an entity carrying `spawnArea` (authored, or added at runtime). */
  adopt(id: string, entity: EntityDoc): SpawnAreaRecord | null {
    const data = entity.components["spawnArea"] as SpawnAreaData | undefined;
    if (!data) return null;
    const p = this.server.world.positionOf(id) ?? [0, 0, 0];
    const record: SpawnAreaRecord = { id, position: p, data, awake: false, npcIds: [], lastNearTick: -1, wokeCount: 0 };
    this.areas.set(id, record);
    return record;
  }

  dispose(): void {
    this.server.world.afterStep.delete(this.afterStep);
  }

  private playerPositions(): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (const player of this.server.players.values()) {
      if (player.disconnectedAt !== null) continue;
      const p = this.server.world.positionOf(player.bodyId);
      if (p) out.push(p);
    }
    return out;
  }

  private static nearest(from: [number, number, number], points: Array<[number, number, number]>): number {
    let best = Infinity;
    for (const p of points) {
      const d = Math.hypot(p[0] - from[0], p[2] - from[2]);
      if (d < best) best = d;
    }
    return best;
  }

  private afterStep = (): void => {
    const world = this.server.world;
    const tick = world.tick;
    if (tick % this.every !== 0) return;
    const players = this.playerPositions();
    for (const area of this.areas.values()) {
      const d = SpawnAreaManager.nearest(area.position, players);
      if (!area.awake) {
        if (d <= area.data.radius) this.wake(area);
        continue;
      }
      if (d <= Math.max(area.data.sleepRadius, area.data.radius)) area.lastNearTick = tick;
      else if (tick - area.lastNearTick >= Math.round(area.data.idleSeconds / world.fixedDt)) this.sleep(area);
      if (area.awake) this.fence(area);
    }
  };

  /** Spawn the pack the first time; resume it in place afterwards. */
  wake(area: SpawnAreaRecord): void {
    const world = this.server.world;
    area.awake = true;
    area.lastNearTick = world.tick;
    area.wokeCount++;
    if (area.npcIds.length === 0) {
      let n = 0;
      for (const spawn of area.data.spawns) {
        for (let i = 0; i < spawn.count; i++) {
          const angle = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * spawn.spread;
          const x = area.position[0] + Math.cos(angle) * r;
          const z = area.position[2] + Math.sin(angle) * r;
          const y = this.server.terrain ? this.server.terrain.groundHeight(x, z) + 1.2 : area.position[1];
          const id = `${area.id}#${spawn.template}#${++n}`;
          const record = this.npcs.spawn(spawn.template, [x, y, z], {
            id,
            yaw: Math.random() * Math.PI * 2,
            params: { home: area.position, leash: area.data.leash, roam: area.data.roam, spawnArea: area.id },
          });
          if (record) area.npcIds.push(record.id);
          else console.warn(`[server:spawn-areas] ${area.id}: unknown template "${spawn.template}"`);
        }
      }
      return;
    }
    // resume: bodies back into the sim where they stood, scripts restarted
    for (const rootId of area.npcIds) {
      if (!this.server.paused.has(rootId)) continue;
      const ids = world.subtree(rootId);
      const docs: Record<string, EntityDoc> = {};
      for (const id of ids) {
        const entity = world.entities.get(id);
        if (!entity) continue;
        const doc = structuredClone(entity);
        if (id === rootId) {
          const p = world.positionOf(id);
          const q = world.quaternionOf(id);
          const transform = (doc.components["transform"] ?? {}) as Record<string, unknown>;
          doc.components["transform"] = { ...transform, ...(p ? { position: p } : {}), ...(q ? { rotation: q } : {}) };
        }
        docs[id] = doc;
      }
      const p = world.positionOf(rootId);
      if (p) this.server.terrain?.ensureAround(p[0], p[2], 1);
      world.sim.addEntities({ ...world.base, entities: docs });
      world.scripts.resumeEntities(ids);
      this.server.paused.delete(rootId);
    }
  }

  /** Pause in place: scripts off, bodies out of the physics world, positions kept on the objects. */
  sleep(area: SpawnAreaRecord): void {
    const world = this.server.world;
    area.awake = false;
    for (const rootId of area.npcIds) {
      if (!world.entities.has(rootId) || this.server.paused.has(rootId)) continue;
      const ids = world.subtree(rootId);
      world.scripts.suspendEntities(ids);
      world.sim.removeEntities(ids);
      world.anims.delete(rootId);
      world.animLayers.delete(rootId);
      this.server.paused.add(rootId);
    }
  }

  /** Backstop leash: a body 1.5× past its leash is put back home. */
  private fence(area: SpawnAreaRecord): void {
    const world = this.server.world;
    const limit = area.data.leash * 1.5;
    for (const rootId of area.npcIds) {
      if (this.server.paused.has(rootId)) continue;
      const p = world.positionOf(rootId);
      if (!p) continue;
      const d = Math.hypot(p[0] - area.position[0], p[2] - area.position[2]);
      if (d <= limit) continue;
      if (!this.fenced.has(rootId)) {
        this.fenced.add(rootId);
        console.warn(`[server:spawn-areas] ${rootId} strayed ${d.toFixed(0)} m from ${area.id} (leash ${area.data.leash}) — fenced back home; the brain should honour its \`leash\` param`);
      }
      const home = area.position;
      const y = this.server.terrain ? this.server.terrain.groundHeight(home[0], home[2]) + 1.2 : home[1];
      world.sim.setPosition(rootId, [home[0], y, home[2]]);
    }
  }

  /** No awake pack within radius + margin of this player's body. */
  clearToTransfer(peerId: string): boolean {
    const player = this.server.players.get(peerId);
    if (!player) return false;
    const p = this.server.world.positionOf(player.bodyId);
    if (!p) return true;
    for (const area of this.areas.values()) {
      if (!area.awake) continue;
      const d = Math.hypot(area.position[0] - p[0], area.position[2] - p[2]);
      if (d <= area.data.radius + this.transferMargin) return false;
    }
    return true;
  }

  list(): Array<{ id: string; position: [number, number, number]; awake: boolean; npcs: number; woke: number }> {
    return [...this.areas.values()].map((a) => ({ id: a.id, position: a.position, awake: a.awake, npcs: a.npcIds.length, woke: a.wokeCount }));
  }
}
