/**
 * Players on a dedicated server.
 *
 * A joining peer gets a BODY: the scene's `player`-tagged subtree, cloned
 * under fresh ids (`player:<peerId>`, children `player:<peerId>/<child>`),
 * with every script param that named the old root rewritten to the new one
 * (`actor: "player"` → `actor: "player:p-…"`), so a combat-actor / caster pair
 * authored for the single-player body works unchanged for every player.
 *
 * Two versions of that subtree exist on purpose:
 *
 * - the SERVER doc drops the body's `third-person-controller` (input is per
 *   tab; the server has none) and adds `netObject` so the body replicates;
 *   {@link PlayerDriver} moves it from the peer's movement intent instead.
 * - the CLIENT doc keeps the controller: the owning tab runs it locally as
 *   its prediction, exactly the loop it runs single-player.
 *
 * Ownership lives in netState (`owner/<bodyId>`, `player/<peerId>`) so any
 * authoritative script can check who is allowed to act as whom.
 */

import type { EntityDoc, SceneDoc } from "@hitreg/core";
import type { HeadlessWorld } from "./world.js";

export const PLAYER_TAG = "player";
/** The engine's client-predicted movement script; the server drives the body itself. */
export const CLIENT_CONTROLLER = "third-person-controller";

export interface PlayerTemplate {
  rootId: string;
  /** Expanded docs of the root and its descendants, keyed by original id. */
  entities: Record<string, EntityDoc>;
  /** Controller params (speed, jump …) the driver clamps against. */
  controller: Record<string, unknown>;
}

/** Pull the `player`-tagged subtree out of an EXPANDED scene doc. */
export function extractPlayerTemplate(expanded: SceneDoc): PlayerTemplate | null {
  const rootId = Object.entries(expanded.entities).find(
    ([, e]) => e.parent === null && e.tags.includes(PLAYER_TAG),
  )?.[0];
  if (!rootId) return null;
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) {
    for (const [id, e] of Object.entries(expanded.entities)) {
      if (e.parent === ids[i] && !ids.includes(id)) ids.push(id);
    }
  }
  const entities: Record<string, EntityDoc> = {};
  for (const id of ids) entities[id] = structuredClone(expanded.entities[id]!);
  const script = entities[rootId]!.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
  return {
    rootId,
    entities,
    controller: script?.name === CLIENT_CONTROLLER ? { ...(script.params ?? {}) } : {},
  };
}

export function playerBodyId(peerId: string): string {
  return `player:${peerId}`;
}

/** Deep-rewrite every string equal to an old id (script params reference ids by value). */
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

export interface SpawnedPlayerDocs {
  bodyId: string;
  /** What the server simulates (controller stripped, netObject added). */
  server: Record<string, EntityDoc>;
  /** What clients build (controller kept for the owner's prediction). */
  client: Record<string, EntityDoc>;
}

/** Instantiate the template for one peer at a world position. */
export function instantiatePlayer(
  template: PlayerTemplate,
  peerId: string,
  at: [number, number, number],
  yaw = 0,
): SpawnedPlayerDocs {
  const bodyId = playerBodyId(peerId);
  const map = new Map<string, string>();
  for (const id of Object.keys(template.entities)) {
    map.set(id, id === template.rootId ? bodyId : `${bodyId}/${id}`);
  }
  const client: Record<string, EntityDoc> = {};
  for (const [oldId, entity] of Object.entries(template.entities)) {
    // only references get rewritten: parent + component data (script params
    // name ids by value). Tags and names are labels, not references — the
    // root's id is literally "player", the same word as its tag.
    const doc: EntityDoc = {
      ...structuredClone(entity),
      parent: entity.parent === null ? null : (map.get(entity.parent) ?? entity.parent),
      components: rewriteIds(entity.components, map) as Record<string, unknown>,
    };
    if (oldId === template.rootId) {
      const transform = (doc.components["transform"] ?? {}) as Record<string, unknown>;
      doc.components["transform"] = {
        ...transform,
        position: at,
        rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
      };
      doc.components["netObject"] = { authority: "host", sync: { transform: true, animation: true }, relevancy: "always", radius: 50, sendEvery: 1 };
      doc.name = bodyId;
    }
    client[map.get(oldId)!] = doc;
  }
  const server: Record<string, EntityDoc> = structuredClone(client);
  const body = server[bodyId]!;
  const script = body.components["script"] as { name?: string } | undefined;
  if (script?.name === CLIENT_CONTROLLER) delete body.components["script"];
  return { bodyId, server, client };
}

/** A peer's latest movement intent, as the P2P host already accepts it. */
export interface MovementIntent {
  v: [number, number];
  jump: boolean;
  yaw: number;
  seq: number;
  /** Server time (ms) it arrived. */
  at: number;
}

export interface PlayerRecord {
  peerId: string;
  name: string;
  bodyId: string;
  /** Every entity id the player owns (body + children). */
  ids: string[];
  input: MovementIntent | null;
  /** Last input seq the driver applied (echoed in snapshots for reconciliation). */
  appliedSeq: number;
}

export interface PlayerDriverOptions {
  /** Hard cap on requested planar speed before gait/params apply (trust boundary). Default 20. */
  maxSpeed?: number;
  /** Milliseconds without input before the body is held still. Default 2000. */
  staleMs?: number;
}

/**
 * Moves player bodies from intent. Mirrors what the P2P host does for its
 * proxies, plus the body's runtime channels the combat scripts drive:
 * `frozen` (dead / staggered) pins it, `speedMult` (armour weight, cast
 * commit) scales the cap, `impulseVel` (a dash, a knockback) owns the
 * horizontal velocity while it lasts.
 */
export class PlayerDriver {
  private readonly world: HeadlessWorld;
  private readonly players: Map<string, PlayerRecord>;
  private readonly maxSpeed: number;
  private readonly staleMs: number;
  private readonly runSpeed: number;
  private readonly sprintSpeed: number;
  private readonly walkSpeed: number;
  private readonly jumpVelocity: number;
  private readonly clips: { idle: string; walk: string; run: string; sprint: string; air: string };

  constructor(
    world: HeadlessWorld,
    players: Map<string, PlayerRecord>,
    controller: Record<string, unknown>,
    opts: PlayerDriverOptions = {},
  ) {
    this.world = world;
    this.players = players;
    this.maxSpeed = opts.maxSpeed ?? 20;
    this.staleMs = opts.staleMs ?? 2000;
    const num = (key: string, fallback: number): number =>
      typeof controller[key] === "number" ? (controller[key] as number) : fallback;
    this.runSpeed = num("speed", 6.5);
    this.sprintSpeed = num("sprintSpeed", 9.5);
    this.walkSpeed = num("walkSpeed", 2.2);
    this.jumpVelocity = num("jump", 8);
    const str = (key: string, fallback: string): string =>
      typeof controller[key] === "string" ? (controller[key] as string) : fallback;
    this.clips = {
      idle: str("idleClip", "Idle"),
      walk: str("walkClip", "Walk"),
      run: str("runClip", "Run"),
      sprint: str("sprintClip", "Sprint"),
      air: str("airClip", "Jump_Loop"),
    };
  }

  /**
   * The clip other clients should see this body play. The client-side
   * controller picks its gait off measured velocity; this is the same ladder
   * (idle / walk / run / sprint, air while off the ground, and the combat
   * scripts' one-shot `actionClip` override) so a remote player animates
   * like a local one.
   */
  private gaitClip(
    ud: { actionClip?: string; actionUntil?: number; frozen?: boolean },
    vx: number,
    vy: number,
    vz: number,
    simNow: number,
  ): string {
    if (ud.actionClip && (ud.actionUntil ?? 0) > simNow) return ud.actionClip;
    if (ud.frozen) return this.clips.idle;
    if (vy > 0.8 || vy < -2) return this.clips.air;
    const moving = Math.hypot(vx, vz);
    if (moving < Math.max(0.15, this.walkSpeed * 0.35)) return this.clips.idle;
    if (moving < (this.walkSpeed + this.runSpeed) / 2) return this.clips.walk;
    if (moving < (this.runSpeed + this.sprintSpeed) / 2) return this.clips.run;
    return this.clips.sprint;
  }

  /** The before-step hook. */
  step = (): void => {
    const sim = this.world.sim;
    const nowMs = Date.now();
    const simNow = this.world.timeMs / 1000;
    for (const player of this.players.values()) {
      const vel = sim.getLinvel(player.bodyId);
      if (!vel) continue;
      const object = this.world.objects.get(player.bodyId);
      const ud = (object?.userData ?? {}) as {
        speedMult?: number;
        frozen?: boolean;
        impulseVel?: [number, number];
        impulseUntil?: number;
        actionClip?: string;
        actionUntil?: number;
      };
      const input = player.input;
      const fresh = input !== null && nowMs - input.at <= this.staleMs;
      let vx = 0;
      let vz = 0;
      let vy = vel[1];
      if (fresh && !ud.frozen) {
        [vx, vz] = input!.v;
        const requested = Math.hypot(vx, vz);
        // clamp: first the absolute trust cap, then what this body may do now
        const cap = Math.min(this.maxSpeed, Math.max(this.runSpeed, this.sprintSpeed) * 1.05 * (ud.speedMult ?? 1));
        if (requested > cap && requested > 0) {
          vx = (vx / requested) * cap;
          vz = (vz / requested) * cap;
        }
        if (input!.jump && Math.abs(vy) < 0.05) vy = this.jumpVelocity;
        player.appliedSeq = input!.seq;
      }
      const driven = !!ud.impulseVel && (ud.impulseUntil ?? 0) > simNow;
      if (driven && !ud.frozen) {
        vx = ud.impulseVel![0];
        vz = ud.impulseVel![1];
      }
      sim.setLinvel(player.bodyId, [vx, vy, vz]);
      if (object && fresh) object.rotation.set(0, input!.yaw, 0);
      this.world.anims.set(player.bodyId, this.gaitClip(ud, vx, vel[1], vz, simNow));
    }
  };
}
