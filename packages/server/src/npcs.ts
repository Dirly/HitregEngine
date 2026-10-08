/**
 * NpcManager — the server's population, managed at runtime.
 *
 * Two jobs:
 *
 * 1. **Runtime spawns.** An NPC is a subtree of entity docs (a body with a
 *    rigidbody + collider + script, and children carrying combat-actor /
 *    combat-caster / a brain) placed at a world point. The manager clones a
 *    TEMPLATE — a subtree already in the scene (a `hero0` to copy) or docs
 *    handed in directly — under fresh ids, rewrites the params that name the
 *    old body, settles it onto the ground, and hands it to `GameServer.spawn`,
 *    which replicates the docs to every client. This is the hook the AI
 *    dungeon master drives: "put three boars here" is one call.
 *
 * 2. **Respawn.** A dead combatant (netState `combat/<id>.dead === true`)
 *    comes back after `respawnSeconds` at its spawn point with fresh pools —
 *    by despawning and re-spawning the subtree, so every script restarts from
 *    onStart the same way it did at boot. Authored scene NPCs get this too;
 *    they respawn in place under the SAME ids (clients already have the doc).
 */

import { createScene, expandScene, type EntityDoc } from "@hitreg/core";
import type { GameServer } from "./server.js";

export interface NpcTemplate {
  rootId: string;
  entities: Record<string, EntityDoc>;
}

export interface NpcRecord {
  id: string;
  /** Template the NPC was spawned from (a scene subtree or a registered template). */
  template: string;
  ids: string[];
  spawnAt: [number, number, number];
  yaw: number;
  /** Server tick the NPC was seen dead, or null while alive. */
  deadSince: number | null;
  /** Scene-authored (true) or spawned at runtime (false) — decides whether clients need the docs. */
  authored: boolean;
  /** The spawn area that owns it (it sleeps and wakes with its pack), or undefined. */
  area?: string;
  /** Never respawned (a pet, a summon): dead is gone, and whoever spawned it removes it. */
  noRespawn?: boolean;
}

/** A template name that is a prefab asset rather than a scene subtree: `prefab:<prefabId>`. */
export const PREFAB_TEMPLATE = "prefab:";

export interface NpcManagerOptions {
  /** Seconds a dead combatant lies before respawning; 0 disables. Default 20. */
  respawnSeconds?: number;
  /** Register every scene subtree whose root carries one of these tags as both a template and a managed NPC. Default ["npc"]. */
  npcTags?: string[];
  /**
   * NPCs no spawn area owns (authored ones, admin spawns) sleep like a pack does: paused in place when no
   * player has been within `sleepRadius` metres for `idleSeconds`, resumed when one comes within
   * `wakeRadius`. Without it every authored creature in the world thinks, probes the ground and holds
   * terrain loaded around itself with nobody there. `false` keeps them all awake. Defaults: 120 / 90 / 10.
   */
  dormancy?: { sleepRadius?: number; wakeRadius?: number; idleSeconds?: number } | false;
}

/** A root id and every descendant in a doc's entities, parents first. */
function subtreeOf(entities: Record<string, EntityDoc>, rootId: string): string[] {
  const out = [rootId];
  const children = new Map<string, string[]>();
  for (const [id, e] of Object.entries(entities)) {
    if (e.parent === null) continue;
    const list = children.get(e.parent);
    if (list) list.push(id);
    else children.set(e.parent, [id]);
  }
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []));
  return out;
}

function rewriteIds(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => rewriteIds(v, map));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteIds(v, map);
    return out;
  }
  return value;
}

export class NpcManager {
  readonly server: GameServer;
  readonly templates = new Map<string, NpcTemplate>();
  readonly npcs = new Map<string, NpcRecord>();
  private readonly respawnTicks: number;
  private counter = 0;
  private readonly dormancy: { sleepRadius: number; wakeRadius: number; idleTicks: number } | null;
  /** Roots this manager paused (not the spawn areas' ones), and the last tick a player was near each awake NPC. */
  private readonly dormant = new Set<string>();
  private readonly nearAt = new Map<string, number>();
  /**
   * Asked when a dead NPC's respawn is due, before it comes back in place: return true when the caller replaced it
   * instead (a spawn area's placeholder rare rolling in that slot, or a dead rare's slot going back to its placeholder).
   */
  respawnHook: ((record: NpcRecord) => boolean) | null = null;

  constructor(server: GameServer, opts: NpcManagerOptions = {}) {
    this.server = server;
    const seconds = opts.respawnSeconds ?? 20;
    this.respawnTicks = seconds > 0 ? Math.round(seconds / server.world.fixedDt) : 0;
    const d = opts.dormancy === false ? null : (opts.dormancy ?? {});
    this.dormancy = d
      ? { sleepRadius: d.sleepRadius ?? 120, wakeRadius: Math.min(d.wakeRadius ?? 90, d.sleepRadius ?? 120), idleTicks: Math.round((d.idleSeconds ?? 10) / server.world.fixedDt) }
      : null;
    const tags = opts.npcTags ?? ["npc"];
    const world = server.world;
    // adopt authored NPCs: every root entity with a rigidbody + a combat child, or an npc tag
    const parents = new Set<string>();
    for (const e of world.entities.values()) if (e.parent !== null) parents.add(e.parent);
    for (const [id, e] of world.entities) {
      if (e.parent !== null) continue;
      const tagged = tags.some((t) => e.tags.includes(t));
      const hasBody = e.components["rigidbody"] !== undefined && e.components["script"] !== undefined;
      const combatChild = parents.has(id) && world.netState.get(`combat/${id}.hp`) !== undefined;
      if (!tagged && !(hasBody && combatChild)) continue;
      if (e.tags.includes("player")) continue;
      const ids = world.subtree(id);
      // the template is the WHOLE authored subtree (the scene as expanded), not what this world built of it: the
      // server leaves drawing-only children out of its own world, and a spawned copy's docs go to clients
      const entities: Record<string, EntityDoc> = {};
      for (const eid of subtreeOf(world.expanded.entities, id)) entities[eid] = structuredClone(world.expanded.entities[eid]!);
      this.templates.set(id, { rootId: id, entities });
      const p = world.positionOf(id) ?? [0, 0, 0];
      this.npcs.set(id, { id, template: id, ids, spawnAt: p, yaw: 0, deadSince: null, authored: true });
    }
    // nobody is on yet: every authored NPC starts dormant, so boot neither generates the ground under creatures
    // nobody is near nor simulates them (each wakes, ground first, when a player comes within wakeRadius)
    if (this.dormancy && server.players.size === 0) {
      for (const record of this.npcs.values()) if (server.pauseRoot(record.id)) this.dormant.add(record.id);
    }
    world.afterStep.add(this.afterStep);
    // scripts on the authority ask for NPCs by event (encounter-waves and any later mechanic): spawn a template, remove one
    world.eventBus.on("npc.spawn", (p) => {
      const q = p as { template: string; id: string; at: [number, number, number]; yaw?: number; params?: Record<string, unknown>; props?: Record<string, unknown>; respawn?: boolean };
      if (!this.spawn(q.template, q.at, { id: q.id, yaw: q.yaw ?? 0, params: q.params ?? {}, ...(q.props ? { props: q.props } : {}), ...(q.respawn === false ? { respawn: false } : {}) })) console.warn(`[server:npcs] npc.spawn: unknown template "${q.template}" or id "${q.id}" taken`);
    });
    world.eventBus.on("npc.despawn", (p) => { this.despawn((p as { id: string }).id); });
  }

  /** A template's root doc (a scene subtree or a `prefab:` asset), or null when unknown. */
  templateRoot(name: string): EntityDoc | null {
    const tpl = this.templates.get(name);
    if (tpl) return tpl.entities[tpl.rootId] ?? null;
    if (!name.startsWith(PREFAB_TEMPLATE)) return null;
    const prefab = this.server.world.assets.getPrefab(name.slice(PREFAB_TEMPLATE.length)) as { root?: string; entities?: Record<string, EntityDoc> } | undefined;
    return prefab?.root ? (prefab.entities?.[prefab.root] ?? null) : null;
  }

  /** Register a template by name (a subtree of docs; the root is the one with parent null). */
  register(name: string, entities: Record<string, EntityDoc>): void {
    const rootId = Object.entries(entities).find(([, e]) => e.parent === null)?.[0];
    if (!rootId) throw new Error(`template "${name}": no root entity (parent: null)`);
    this.templates.set(name, { rootId, entities: structuredClone(entities) });
  }

  /**
   * Spawn a template at a point. `id` defaults to `<template>#<n>`. Returns
   * the record, or null when the template is unknown.
   *
   * `opts.params` reaches EVERY scripted entity in the subtree, not just the
   * root. An entity carries one script, so a character is always at least two
   * of them — body with the controller, a child with the brain — and a spawn
   * area handing down `home`/`leash`/`roam` would otherwise reach the
   * controller (which has no use for them) and miss the brain (whose whole job
   * they are). Scripts ignore params they did not declare, so the spray is
   * free; the spawner wins over an authored value, because the spawn area is
   * the source of truth for where a pack belongs.
   */
  spawn(
    template: string,
    at: [number, number, number],
    opts: { id?: string; yaw?: number; params?: Record<string, unknown>; props?: Record<string, unknown>; respawn?: boolean } = {},
  ): NpcRecord | null {
    if (!this.templates.has(template) && template.startsWith(PREFAB_TEMPLATE)) return this.spawnPrefab(template, at, opts);
    const tpl = this.templates.get(template);
    if (!tpl) return null;
    const id = opts.id ?? `${tpl.rootId}#${++this.counter}`;
    if (this.server.world.entities.has(id)) return null;
    const map = new Map<string, string>();
    for (const oldId of Object.keys(tpl.entities)) {
      map.set(oldId, oldId === tpl.rootId ? id : `${id}/${oldId.startsWith(`${tpl.rootId}-`) ? oldId.slice(tpl.rootId.length + 1) : oldId}`);
    }
    const yaw = opts.yaw ?? 0;
    const entities: Record<string, EntityDoc> = {};
    for (const [oldId, entity] of Object.entries(tpl.entities)) {
      const doc: EntityDoc = {
        ...structuredClone(entity),
        parent: entity.parent === null ? null : (map.get(entity.parent) ?? entity.parent),
        components: rewriteIds(entity.components, map) as Record<string, unknown>,
      };
      if (oldId === tpl.rootId) {
        doc.name = id;
        const transform = (doc.components["transform"] ?? {}) as Record<string, unknown>;
        doc.components["transform"] = { ...transform, position: at, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] };
      }
      if (opts.params) {
        const script = doc.components["script"] as { name: string; params?: Record<string, unknown> } | undefined;
        if (script) script.params = { ...(script.params ?? {}), ...opts.params };
      }
      entities[map.get(oldId)!] = doc;
    }
    // ground first: a body spawned into an unloaded cell falls forever
    this.server.terrain?.ensureAround(at[0], at[2], 1);
    this.server.spawn(entities);
    const area = opts.params?.["spawnArea"];
    const record: NpcRecord = { id, template, ids: Object.keys(entities), spawnAt: at, yaw, deadSince: null, authored: false, ...(typeof area === "string" ? { area } : {}), ...(opts.respawn === false ? { noRespawn: true } : {}) };
    this.npcs.set(id, record);
    return record;
  }

  /**
   * Spawn a PREFAB asset (`prefab:<prefabId>`, e.g. `prefab:mobs/wolf-timber`) as an NPC: the prefab is expanded
   * as one instance under `id` (children `<id>:<local>`), `props` set its declared props (a mob prefab's
   * `actor` is bound to the id automatically), `params` are sprayed over every script like a template spawn.
   * What a pet keeper or a summon uses — no copy of the creature has to stand in the scene.
   */
  private spawnPrefab(
    template: string,
    at: [number, number, number],
    opts: { id?: string; yaw?: number; params?: Record<string, unknown>; props?: Record<string, unknown>; respawn?: boolean },
  ): NpcRecord | null {
    const world = this.server.world;
    const prefabId = template.slice(PREFAB_TEMPLATE.length);
    const prefab = world.assets.getPrefab(prefabId) as { props?: Record<string, unknown> } | undefined;
    if (!prefab) return null;
    const id = opts.id ?? `${prefabId.replace(/[^a-z0-9-]+/gi, "-")}#${++this.counter}`;
    if (world.entities.has(id)) return null;
    const yaw = opts.yaw ?? 0;
    const props: Record<string, unknown> = { ...(opts.props ?? {}) };
    if (prefab.props && "actor" in prefab.props && props["actor"] === undefined) props["actor"] = id;
    const doc = createScene(id);
    doc.entities[id] = {
      name: id,
      parent: null,
      tags: [],
      components: {
        transform: { position: at, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] },
        prefab: { prefabId, props, overrides: [] },
      },
    } as EntityDoc;
    let entities: Record<string, EntityDoc>;
    try {
      entities = expandScene(doc, world.assets, world.registry).entities;
    } catch (error) {
      console.warn(`[server:npcs] ${template}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (opts.params) {
      for (const entity of Object.values(entities)) {
        const script = entity.components["script"] as { name: string; params?: Record<string, unknown> } | undefined;
        if (script) script.params = { ...(script.params ?? {}), ...opts.params };
      }
    }
    this.server.terrain?.ensureAround(at[0], at[2], 1);
    this.server.spawn(entities);
    const record: NpcRecord = { id, template, ids: Object.keys(entities), spawnAt: at, yaw, deadSince: null, authored: false, ...(opts.respawn === false ? { noRespawn: true } : {}) };
    this.npcs.set(id, record);
    return record;
  }

  /** Remove an NPC everywhere (authored ones too — they are gone until a server restart). */
  despawn(id: string): boolean {
    const record = this.npcs.get(id);
    if (!record) return false;
    this.npcs.delete(id);
    this.dormant.delete(id);
    this.nearAt.delete(id);
    this.server.paused.delete(id);
    this.server.despawn(record.ids);
    this.clearCombatState(record.ids);
    return true;
  }

  /**
   * Everything the manager knows, for the admin endpoint.
   *
   * `ai` is whatever the subtree's scripts report from `onDebug` — for a mob
   * that is its state, its target and its threat table. Position and hp tell
   * you WHAT a misbehaving camp is doing; only this tells you why, and on a
   * live layer there is no debugger to reach for.
   */
  list(): Array<NpcRecord & { position: [number, number, number] | null; hp: unknown; dead: boolean; ai: Record<string, unknown> }> {
    const world = this.server.world;
    return [...this.npcs.values()].map((r) => ({
      ...r,
      position: world.positionOf(r.id),
      hp: world.netState.get(`combat/${r.id}.hp`),
      dead: world.netState.get(`combat/${r.id}.dead`) === true,
      // A paused pack has no script instances at all, so this is empty rather
      // than stale — which is the honest answer for something asleep.
      ai: world.scripts.debugTree(r.ids),
    }));
  }

  private clearCombatState(ids: string[]): void {
    const net = this.server.world.netState;
    for (const id of ids) {
      for (const key of net.keys(`combat/${id}.`)) net.delete(key);
      for (const key of net.keys(`cooldown/${id}.`)) net.delete(key);
    }
  }

  /** Watches for deaths (respawn) and for bodies that left the world (teleport home). */
  private afterStep = (): void => {
    const world = this.server.world;
    const tick = world.tick;
    if (this.dormancy && tick % 20 === 0) this.sleepAndWake(tick);
    // Insurance against the one failure that is silent: a body with no
    // ground under it (a cell that failed to load, a bad spawn point) falls
    // forever and its scripts keep running, probing air. Put it back.
    if (tick % 30 === 0) {
      for (const record of this.npcs.values()) {
        if (this.server.paused.has(record.id)) continue; // asleep: no body in the sim to fall
        const p = world.positionOf(record.id);
        if (p && p[1] < record.spawnAt[1] - 60) {
          console.warn(`[server:npcs] ${record.id} fell out of the world (y=${p[1].toFixed(0)}) — returned to spawn`);
          this.server.terrain?.ensureAround(record.spawnAt[0], record.spawnAt[2], 1);
          world.sim.setPosition(record.id, record.spawnAt);
        }
      }
    }
    if (this.respawnTicks === 0) return;
    for (const record of this.npcs.values()) {
      if (record.noRespawn) continue; // a pet or a summon: whoever spawned it removes it
      if (this.server.paused.has(record.id)) continue; // a sleeping pack respawns when it wakes
      const dead = world.netState.get(`combat/${record.id}.dead`) === true;
      if (!dead) {
        record.deadSince = null;
        continue;
      }
      if (record.deadSince === null) {
        record.deadSince = tick;
        continue;
      }
      if (tick - record.deadSince < this.respawnTicks) continue;
      if (!this.groundReady(record.spawnAt)) continue; // its spawn point's cells are on their way
      if (this.respawnHook?.(record)) continue;
      this.respawn(record);
    }
  };

  /** The cells around a point resident, or asked of the generation workers (false until they land). */
  private groundReady(p: readonly number[]): boolean {
    const terrain = this.server.terrain;
    return !terrain || terrain.prefetch(p[0]!, p[2]!, terrain.resolved.streamer.cellSize);
  }

  /** NPCs no area owns: pause the ones nobody has been near for a while, resume the ones somebody reached. */
  private sleepAndWake(tick: number): void {
    const { sleepRadius, wakeRadius, idleTicks } = this.dormancy!;
    const world = this.server.world;
    const players: Array<[number, number, number]> = [];
    for (const player of this.server.players.values()) {
      if (player.disconnectedAt !== null) continue;
      const p = world.positionOf(player.bodyId);
      if (p) players.push(p);
    }
    const nearest = (p: readonly number[]): number => {
      let best = Infinity;
      for (const q of players) best = Math.min(best, Math.hypot(q[0] - p[0]!, q[2] - p[2]!));
      return best;
    };
    for (const record of this.npcs.values()) {
      if (record.area !== undefined) continue; // its pack's area decides
      if (record.noRespawn) continue; // a pet stays awake with its owner
      const p = world.positionOf(record.id);
      if (!p) continue;
      const d = nearest(p);
      if (this.dormant.has(record.id)) {
        if (d > wakeRadius) continue;
        if (!this.groundReady(p)) continue; // asked of the workers; wakes on a later pass
        this.dormant.delete(record.id);
        this.nearAt.set(record.id, tick);
        this.server.resumeRoot(record.id);
        continue;
      }
      if (this.server.paused.has(record.id)) continue; // paused by someone else
      // the idle clock starts at the first look (boot) or the last tick someone was near
      if (d <= sleepRadius || !this.nearAt.has(record.id)) {
        this.nearAt.set(record.id, tick);
        continue;
      }
      if (tick - this.nearAt.get(record.id)! < idleTicks) continue;
      // a dying or dead body finishes its respawn awake (a corpse is paused only once it is back on its feet)
      if (world.netState.get(`combat/${record.id}.dead`) === true) continue;
      if (this.server.pauseRoot(record.id)) this.dormant.add(record.id);
    }
  }

  /** NPCs paused by distance right now (not the spawn areas' sleeping packs). */
  get dormantCount(): number {
    return this.dormant.size;
  }

  /** Tear the subtree down and bring it back fresh at its spawn point, same ids. */
  respawn(record: NpcRecord): void {
    const tpl = this.templates.get(record.template);
    if (!tpl) return;
    const world = this.server.world;
    // rebuild the docs exactly as spawn did, keeping this record's ids
    const docs: Record<string, EntityDoc> = {};
    for (const id of record.ids) {
      const live = world.entities.get(id) ?? this.server.runtimeDocs.get(id);
      if (live) docs[id] = structuredClone(live);
    }
    const root = docs[record.id];
    if (!root) return;
    const transform = (root.components["transform"] ?? {}) as Record<string, unknown>;
    root.components["transform"] = {
      ...transform,
      position: record.spawnAt,
      rotation: [0, Math.sin(record.yaw / 2), 0, Math.cos(record.yaw / 2)],
    };
    // the body's runtime channels (frozen, actionClip …) die with the object
    if (record.authored) {
      // clients already hold this doc: remove + re-add locally, no docs on the wire
      world.removeEntities(record.ids, { silent: true });
      this.clearCombatState(record.ids);
      this.server.terrain?.ensureAround(record.spawnAt[0], record.spawnAt[2], 1);
      world.addEntities({ ...world.base, entities: docs }, { silent: true });
    } else {
      this.server.despawn(record.ids);
      this.clearCombatState(record.ids);
      this.server.terrain?.ensureAround(record.spawnAt[0], record.spawnAt[2], 1);
      this.server.spawn(docs);
    }
    record.deadSince = null;
  }
}
