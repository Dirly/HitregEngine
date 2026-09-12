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
import {
  actionIsLayered,
  GaitTracker,
  groundFollowVy,
  risingByGround,
  gaitSpeed,
  leavingGround,
  playbackRate,
  type GaitTuning,
} from "@hitreg/scripting";
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

/**
 * Params whose value is a WORD, never a reference: a template whose root is
 * called "player" and whose combat script says `faction: "player"` must not
 * end up with a faction of "player:chr-…" — every player in its own faction,
 * and no two able to share one.
 */
const WORD_KEYS = new Set(["faction", "tag", "tags", "name", "label", "team", "party"]);

/** Deep-rewrite every string equal to an old id (script params reference ids by value). */
function rewriteIds(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => rewriteIds(v, map));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = WORD_KEYS.has(k) ? v : rewriteIds(v, map);
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
  /** Server tick the player's link dropped, or null while connected (reconnect grace). */
  disconnectedAt: number | null;
  /** From the ticket; null on an open dev server (then nothing persists for this peer). */
  identity: { playerId: string; characterId: string; name: string; rev?: Record<string, number> } | null;
  /** Latest persisted revisions per namespace (what a transfer ticket will promise). */
  rev: Record<string, number>;
  /** Tick offset for the periodic save, so players do not all save at once. */
  commitPhase: number;
  /** A save in flight (coalesced), or null. */
  committing: Promise<Record<string, number>> | null;
  /** Tick the client was told to go elsewhere, or null. Its bye then tears the body down at once. */
  transferring: number | null;
  /** Gait state for the clip other clients see — created on first step. */
  gait?: GaitTracker;
  /** Measured distance from this body's origin to the ground under its feet. */
  groundRest?: number;
  /** The vertical velocity ground-following wrote for it last tick. */
  stickVy?: number;
  /** Sim seconds of its last jump (the grace ground-following stands clear of). */
  jumpAt?: number;
}

/** How far below a body's origin the ground ray looks, and the slack on contact. */
const PROBE_REACH = 4;
const PROBE_SLACK = 0.3;

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
  private readonly tuning: GaitTuning;
  private readonly clipSpeeds: Record<string, number>;
  private readonly syncClipSpeed: boolean;
  private readonly gaitDwell: number;
  private readonly fallSpeed: number;
  private readonly slopeTolerance: number;
  private readonly groundStick: number;

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
    this.tuning = {
      walkSpeed: this.walkSpeed,
      runSpeed: this.runSpeed,
      sprintSpeed: this.sprintSpeed,
    };
    // The same params the client's controller reads, so the body a peer sees
    // plays the same clip at the same rate as the body its owner sees.
    this.clipSpeeds =
      controller["clipSpeeds"] && typeof controller["clipSpeeds"] === "object"
        ? (controller["clipSpeeds"] as Record<string, number>)
        : {};
    this.syncClipSpeed = controller["syncClipSpeed"] !== false;
    this.gaitDwell = num("gaitDwell", 0.18);
    this.fallSpeed = num("fallSpeed", 2);
    this.slopeTolerance = num("slopeTolerance", 0.8);
    this.groundStick = num("groundStick", 0.5);
  }

  /**
   * The clip other clients should see this body play. The client-side
   * controller picks its gait off measured velocity; this is the same ladder
   * (idle / walk / run / sprint, air while off the ground, and the combat
   * scripts' one-shot `actionClip`) so a remote player animates like a local
   * one — including the split the controller makes between an action that
   * owns the whole body and one that rides on an upper-body LAYER over the
   * gait. Without that split here, a peer would see a caster standing still
   * casting while it slid along the ground.
   *
   * It also carries the playback RATE and, for a one-shot action, how much of
   * its window is left: a clip name alone is half the state, and the half it
   * leaves out is why a remote character's feet skate.
   */
  private gaitClip(
    player: PlayerRecord,
    ud: { actionClip?: string; actionUntil?: number; actionFullBody?: boolean; frozen?: boolean },
    vx: number,
    vy: number,
    vz: number,
    simNow: number,
  ): { clip: string; layer?: string; rate: number; action?: number } {
    const planar = Math.hypot(vx, vz);
    const action = ud.actionClip && (ud.actionUntil ?? 0) > simNow ? ud.actionClip : null;
    const layered = action !== null && actionIsLayered(planar, this.tuning, { fullBody: ud.actionFullBody });
    // How long the action still has to run. The client fits the clip to it —
    // it is the only side that knows how long the clip is — so a three-second
    // cast is one slow cast there too, not the same second three times.
    const window = action ? Math.max(0, (ud.actionUntil ?? simNow) - simNow) : undefined;
    if (action && !layered) return { clip: action, rate: 1, action: window };
    const layer = layered ? { layer: action! } : {};
    const rest = { ...layer, ...(window !== undefined ? { action: window } : {}) };
    if (ud.frozen) return { clip: this.clips.idle, rate: 1, ...rest };
    // Airborne on the same slope-aware terms the controller uses: a body
    // running downhill descends fast with its feet planted, and calling that a
    // fall is how a remote player ends up gliding in a jump pose.
    if (leavingGround(vy, planar, this.fallSpeed, this.slopeTolerance)) {
      return { clip: this.clips.air, rate: 1, ...rest };
    }
    const tracker = (player.gait ??= new GaitTracker());
    const gait = tracker.step(planar, this.tuning, simNow, this.gaitDwell);
    if (gait === "idle") return { clip: this.clips.idle, rate: 1, ...rest };
    const clip = gait === "walk" ? this.clips.walk : gait === "sprint" ? this.clips.sprint : this.clips.run;
    // Rate off the distance actually covered (vertical included, capped), so a
    // remote player's feet stay planted on a hillside as well as a local one's.
    const travelled = Math.hypot(planar, Math.min(Math.abs(vy), planar * 1.2));
    const authored = this.clipSpeeds[clip] ?? gaitSpeed(gait, this.tuning);
    const rate = this.syncClipSpeed ? playbackRate(travelled, authored) : 1;
    return { clip, rate, ...rest };
  }

  /**
   * Cast one downward ray under a player body: how far the ground is, which
   * way it faces, and whether the feet are on it.
   *
   * The resting distance is MEASURED rather than derived from the collider —
   * a body's origin sits at a different height above its feet for every
   * capsule and offset a project authors — so the first reading taken while
   * the body is plainly settled records it, exactly as the client's controller
   * does. One query per player per tick.
   */
  private probeGround(
    player: PlayerRecord,
    vy: number,
  ): { grounded: boolean; dist: number; rest: number | null; normal: [number, number, number] | null } {
    const sim = this.world.sim;
    const p = this.world.positionOf(player.bodyId);
    if (!sim.raycast || !p) return { grounded: Math.abs(vy) < 0.05, dist: Infinity, rest: null, normal: null };
    const hit = sim.raycast(p, [0, -1, 0], PROBE_REACH, { exclude: [player.bodyId] });
    const dist = hit ? hit.distance : Infinity;
    if (hit && player.groundRest === undefined && Math.abs(vy) < 1) player.groundRest = hit.distance;
    const rest = player.groundRest ?? null;
    const grounded = rest !== null ? dist <= rest + PROBE_SLACK : Math.abs(vy) < 0.05;
    return { grounded, dist, rest, normal: hit ? hit.normal : null };
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
        actionFullBody?: boolean;
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
        player.appliedSeq = input!.seq;
      }
      const driven = !!ud.impulseVel && (ud.impulseUntil ?? 0) > simNow;
      if (driven && !ud.frozen) {
        vx = ud.impulseVel![0];
        vz = ud.impulseVel![1];
      }
      // Where the ground is, and which way it faces. The client's controller
      // asks the same question of its own copy of the body; if only one of the
      // two follows the ground, every slope is a fight between prediction and
      // authority that the authority wins by yanking the player back.
      const ground = this.probeGround(player, vy);
      if (fresh && input!.jump && ground.grounded) {
        vy = this.jumpVelocity;
        player.jumpAt = simNow;
      }
      if (ground.normal && ground.rest !== null && simNow - (player.jumpAt ?? -999) > 0.25) {
        const follow = groundFollowVy(vx, vz, vy, ground.normal, ground.dist - ground.rest, {
          stick: this.groundStick,
          slopeTolerance: this.slopeTolerance,
          dt: this.world.fixedDt,
          ours: risingByGround(vy, player.stickVy ?? null),
        });
        player.stickVy = follow ?? undefined;
        if (follow !== null) vy = follow;
      } else player.stickVy = undefined;
      sim.setLinvel(player.bodyId, [vx, vy, vz]);
      if (object && fresh) object.rotation.set(0, input!.yaw, 0);
      const anim = this.gaitClip(player, ud, vx, vel[1], vz, simNow);
      this.world.anims.set(player.bodyId, anim.clip);
      this.world.animRates.set(player.bodyId, anim.rate);
      if (anim.layer) this.world.animLayers.set(player.bodyId, anim.layer);
      else this.world.animLayers.delete(player.bodyId);
    }
  };
}
