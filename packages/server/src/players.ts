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
  gaitReadingSpeed,
  groundFollowVy,
  risingByGround,
  readGround,
  probeLeaving,
  airGravityScale,
  extraGravityDv,
  airSteer,
  gaitSpeed,
  leavingGround,
  idleThreshold,
  playbackRate,
  peakAdvanceSpeed,
  ACTION_RATE_MAX,
  swimStateFor,
  swimVy,
  swimming,
  type GaitTuning,
  type SwimState,
  type SwimTuning,
  type WaterAt,
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
  /** Vertical SPEED in m/s while swimming — where the swimmer is pointed, times how fast it swims. Ignored on land. */
  vy: number;
  yaw: number;
  seq: number;
  /** Server time (ms) it arrived. */
  at: number;
  /** The client's own clock (ms) when it sent this input, if it says — what timing drift is measured against. */
  t?: number;
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
  /** World tick that seq was first applied: snapshots say how long it has been in force (`sa`, ms). */
  appliedAt?: number;
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
  /**
   * The action other clients see, and whether it rides a layer — decided when
   * it STARTS and held, as the controller does. Re-decided per tick off the
   * claimed speed, a standing swing whose clip steps in (clipAdvance) would
   * flip to a layer over a run the moment its own lunge crossed the walk line.
   */
  actionShown?: { clip: string; until: number; layered: boolean };
  /** Measured distance from this body's origin to the ground under its feet. */
  groundRest?: number;
  /** The vertical velocity ground-following wrote for it last tick. */
  stickVy?: number;
  /** Sim seconds of its last jump (the grace ground-following stands clear of). */
  jumpAt?: number;
  /** Rising in its own jump (the controller's `jumping`): what jumpGravity / jumpCutGravity shape. */
  jumping?: boolean;
  /** Seconds of continuous airborne evidence — the controller's coyote counter, so both agree when a fall starts. */
  airTime?: number;
  /** Whether this body is in water, and how deep — the swim rules need the last state to hold a mode. */
  swim?: SwimState;
  /**
   * Timing drift (PlayerDriver.measureTiming): the input in force since `tick`, sent at client time `t` with
   * velocity `v`, and the horizontal gap `drift` that a client running the SAME physics would see open up because
   * this server applied inputs for longer or shorter than the client did. Counted, then reset, each time it passes
   * 0.5 m (the client reconciles it away).
   */
  timing?: { seq: number; tick: number; t: number; v: [number, number]; drift: [number, number]; inputs: number; over05: number; maxM: number };
  /** Client prediction vs the authority, measured on every input (GameServer.measureDivergence). */
  divergence?: { samples: number; over05: number; nudges: number; snaps: number; maxM: number; reasons: Record<string, number>; lastAt: number | null; lastPos: [number, number, number] | null };
  /** The [pitch, yaw] the owner last claimed, put back after every physics readback (see PlayerDriver.face). */
  facing?: [number, number];
}

/**
 * Seconds after a full-body action ends in which the next one still counts as
 * CHAINED off it (see gaitClip): a combo's next press lands inside it.
 */
const CHAIN_GRACE = 0.25;

/** How far below a body's origin the ground ray looks, and the slack on contact. */
const PROBE_REACH = 4;
const PROBE_SLACK = 0.3;

export interface PlayerDriverOptions {
  /** Hard cap on requested planar speed before gait/params apply (trust boundary). Default 20. */
  maxSpeed?: number;
  /** Milliseconds without input before the body is held still. Default 2000. */
  staleMs?: number;
  /**
   * The water over a point (`@hitreg/core`'s `waterQuery` fits). Without it
   * the server does not know water exists, and a client that swims is a
   * client the authority keeps dragging to the bottom of the lake — so this
   * is not optional in any world that has water in it.
   */
  waterAt?: (x: number, y: number, z: number) => WaterAt | null;
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
  /** The controller's jump shaping and air control — the same arc on both sides (see its params). */
  private readonly jumpShape: { riseGravity: number; fallGravity: number; cutGravity: number };
  private readonly airControl: number;
  /** The controller's strafe/backpedal slow-down, taken back out when reading the gait. */
  private readonly sideSpeedMult: number;
  private readonly stepHeight: number;
  private readonly coyoteTime: number;
  private readonly clips: {
    idle: string;
    walk: string;
    run: string;
    sprint: string;
    air: string;
    /** "" = the model was never told it has one; fall back to the run/idle cycle. */
    swim: string;
    tread: string;
    wade: string;
    wadeIdle: string;
  };
  private readonly tuning: GaitTuning;
  private readonly clipSpeeds: Record<string, number>;
  /**
   * m/s added to a body's speed cap while it has an action playing: the
   * fastest the controller's clipAdvance ever moves a body, at the fastest
   * rate an action is fitted to. A lunge is claimed on top of the stick (see
   * the controller), and a cap that did not know about it would clip every
   * committed swing (speedMult well under 1) as a speed hack.
   */
  private readonly advanceAllowance: number;
  private readonly syncClipSpeed: boolean;
  private readonly gaitDwell: number;
  private readonly fallSpeed: number;
  private readonly slopeTolerance: number;
  private readonly groundStick: number;
  private readonly stepPopCap: number;
  private readonly swimEnabled: boolean;
  private readonly wadeDeepDepth: number;
  /** Radians; mirrors the controller's swimMaxPitch so a peer's body lies at the same angle. */
  private readonly swimMaxPitch: number;
  /** Origin-to-feet per body, read off its collider once. */
  private readonly feet = new Map<string, number>();
  private readonly swimSpeed: number;
  private readonly swim: SwimTuning;
  private readonly waterAt: ((x: number, y: number, z: number) => WaterAt | null) | null;

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
    // defaults mirror the third-person-controller's own params
    this.jumpVelocity = num("jump", 6.2);
    this.jumpShape = {
      riseGravity: num("jumpGravity", 1.6),
      fallGravity: num("fallGravity", 2.2),
      cutGravity: num("jumpCutGravity", 3),
    };
    this.airControl = num("airControl", 0.3);
    this.sideSpeedMult = num("sideSpeedMult", 0.65);
    this.stepHeight = num("stepHeight", 0.35);
    this.coyoteTime = num("coyoteTime", 0.12);
    const str = (key: string, fallback: string): string =>
      typeof controller[key] === "string" ? (controller[key] as string) : fallback;
    this.clips = {
      idle: str("idleClip", "Idle"),
      walk: str("walkClip", "Walk"),
      run: str("runClip", "Run"),
      sprint: str("sprintClip", "Sprint"),
      air: str("airClip", "Jump_Loop"),
      // Wading deep: the crouched cycle, on the same "" convention as the
      // swim clips below — a name the server invents is a name a model may
      // not have, and a remote body frozen on its last pose is worse than a
      // remote body walking through the water.
      wade: str("wadeClip", ""),
      wadeIdle: str("wadeIdleClip", ""),
      // Swim clips DEFAULT to the ground ones, which is the opposite of the
      // client's rule and on purpose: the client can ask the model what clips
      // it has and fall back, and the server cannot. Naming a clip nobody has
      // would freeze every remote swimmer on its last pose. Set `swimClip` /
      // `swimIdleClip` on the controller once the model has them, and both
      // sides use them.
      swim: str("swimClip", ""),
      tread: str("swimIdleClip", ""),
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
    const advance =
      controller["clipAdvance"] && typeof controller["clipAdvance"] === "object"
        ? (controller["clipAdvance"] as Record<string, unknown>)
        : {};
    const advanceScale = Math.max(0, Math.min(2, num("advanceScale", 1)));
    this.advanceAllowance = peakAdvanceSpeed(advance) * advanceScale * ACTION_RATE_MAX;
    // the client's own swim params, so the body the authority moves floats at
    // the same line as the body its owner predicts
    this.swimEnabled = controller["swim"] !== false;
    this.swimSpeed = num("swimSpeed", 3.2);
    this.wadeDeepDepth = num("wadeDeepDepth", 0.8);
    this.swimMaxPitch = (num("swimMaxPitch", 60) * Math.PI) / 180;
    const enterDepth = num("swimEnterDepth", 1.5);
    this.swim = {
      enterDepth,
      exitDepth: Math.min(num("swimExitDepth", 1.25), enterDepth - 0.05),
      floatDepth: num("swimFloatDepth", 0.1),
      buoyancy: num("buoyancy", 3.5),
      climbSpeed: num("swimClimbSpeed", 2.6),
    };
    this.waterAt = opts.waterAt ?? null;
    this.gaitDwell = num("gaitDwell", 0.18);
    this.fallSpeed = num("fallSpeed", 2);
    this.slopeTolerance = num("slopeTolerance", 0.8);
    this.groundStick = num("groundStick", 0.5);
    this.stepPopCap = num("stepPopCap", 2);
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
    swimming_ = false,
    /** The peer's vertical request while swimming — what decides stroke vs tread. */
    dive = 0,
    /** Standing in water deep enough to wade through rather than walk. */
    wading = false,
  ): { clip: string; layer?: string; rate: number; action?: number } {
    const planar = Math.hypot(vx, vz);
    const action = ud.actionClip && (ud.actionUntil ?? 0) > simNow ? ud.actionClip : null;
    // Layered or full-body is decided when the action STARTS (a new clip, or
    // the same one asked for again after its window ran out) and held — the
    // controller's rule, and the only one under which a swing's own lunge
    // cannot flip it onto a layer mid-swing.
    const shown = player.actionShown;
    const until = ud.actionUntil ?? 0;
    let layered: boolean;
    if (action === null) {
      // kept a moment past its end, for the chain rule below
      if (shown && simNow - shown.until > CHAIN_GRACE) player.actionShown = undefined;
      layered = false;
    } else if (shown && shown.clip === action && (until === shown.until || shown.until > simNow)) {
      shown.until = until;
      layered = shown.layered;
    } else {
      // A swing chained straight off a full-body one stays full-body. The
      // claimed speed still carries the last swing's lunge, which the
      // controller takes back out before it asks "is it walking?" and this
      // side cannot (the claim is one number) — read raw, every lunging
      // combo would turn into a layer over a run from its second swing on.
      const chained = shown !== undefined && !shown.layered && simNow - shown.until <= CHAIN_GRACE;
      layered = chained ? false : actionIsLayered(planar, this.tuning, { fullBody: ud.actionFullBody });
      player.actionShown = { clip: action, until, layered };
    }
    // How long the action still has to run. The client fits the clip to it —
    // it is the only side that knows how long the clip is — so a three-second
    // cast is one slow cast there too, not the same second three times.
    const window = action ? Math.max(0, (ud.actionUntil ?? simNow) - simNow) : undefined;
    if (action && !layered) return { clip: action, rate: 1, action: window };
    const layer = layered ? { layer: action! } : {};
    const rest = { ...layer, ...(window !== undefined ? { action: window } : {}) };
    if (ud.frozen) return { clip: this.clips.idle, rate: 1, ...rest };
    // In the water there is no gait ladder and no air clip — a swimmer is not
    // falling — so this branch comes before both. The client's controller
    // makes the same two-way split (stroke / tread) from the same numbers.
    if (swimming_) {
      if (swimming(planar, dive, this.swimSpeed) === "tread") {
        return { clip: this.clips.tread || this.clips.idle, rate: 1, ...rest };
      }
      const clip = this.clips.swim || this.clips.run;
      // A stand-in run cycle depicts a RUN, so it is paid out against the run
      // speed; a real swim clip against the swim speed. Same rule as the client.
      const authored = this.clipSpeeds[clip] ?? (this.clips.swim ? this.swimSpeed : this.runSpeed);
      return {
        clip,
        rate: this.syncClipSpeed ? playbackRate(Math.hypot(planar, vy), authored) : 1,
        ...rest,
      };
    }
    // Thigh-deep: the crouched wade, matching the client's own choice.
    if (wading && (this.clips.wade || this.clips.wadeIdle)) {
      if (planar < idleThreshold(this.tuning)) {
        if (this.clips.wadeIdle) return { clip: this.clips.wadeIdle, rate: 1, ...rest };
      } else if (this.clips.wade) {
        const authored = this.clipSpeeds[this.clips.wade] ?? Math.max(0.3, this.walkSpeed * 0.5);
        return {
          clip: this.clips.wade,
          rate: this.syncClipSpeed ? playbackRate(planar, authored) : 1,
          ...rest,
        };
      }
    }
    // Airborne on the same slope-aware terms the controller uses: a body
    // running downhill descends fast with its feet planted, and calling that a
    // fall is how a remote player ends up gliding in a jump pose.
    if (leavingGround(vy, planar, this.fallSpeed, this.slopeTolerance)) {
      return { clip: this.clips.air, rate: 1, ...rest };
    }
    const tracker = (player.gait ??= new GaitTracker());
    // A strafe or backpedal travels at `sideSpeedMult` of its gait by design;
    // read raw, a sideways run falls under the walk/run line and every other
    // player sees a sped-up walk. Sideways = more than 30° off the facing
    // (keyboard diagonals are 45°), the same correction the controller makes.
    const yaw = this.world.objects.get(player.bodyId)?.rotation.y;
    const sideways =
      yaw !== undefined && planar > 0.2 && vx * Math.sin(yaw) + vz * Math.cos(yaw) < planar * Math.cos(Math.PI / 6);
    const gait = tracker.step(
      gaitReadingSpeed(planar, sideways ? this.sideSpeedMult : 1),
      this.tuning,
      simNow,
      this.gaitDwell,
    );
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
   * The resting distance — how far the ground is when the feet are ON it —
   * comes from the COLLIDER, which states it exactly, and is measured only
   * where the collider cannot say. That is the same rule the client's
   * controller follows, and for the same reason: a body that has just been
   * PUT somewhere — spawned, respawned, teleported home, transferred in from
   * another layer — is AT REST above whatever is under it, which is exactly
   * what a settled body looks like. Recorded then, the resting distance is as
   * long as the drop, and every ground test afterwards reads air as floor:
   * the player walks out over ledges instead of falling down them. Worse here
   * than on the client, where the reading at least had to wait out the air
   * time — a freshly spawned body's first tick has vy = 0 exactly.
   *
   * One query per player per tick.
   */
  private probeGround(
    player: PlayerRecord,
    vy: number,
    vx: number,
    vz: number,
    launched: boolean,
  ): {
    grounded: boolean;
    dist: number;
    rest: number | null;
    normal: [number, number, number] | null;
    step: number;
    reach: number;
  } {
    const sim = this.world.sim;
    const p = this.world.positionOf(player.bodyId);
    if (!sim.raycast || !p) {
      return { grounded: Math.abs(vy) < 0.05, dist: Infinity, rest: null, normal: null, step: 0, reach: 0 };
    }
    if (player.groundRest === undefined) player.groundRest = this.restFromCollider(player) ?? undefined;
    const exclude = [player.bodyId];
    // The controller's own reading — centre ray, footprint ring when the centre
    // reports a gap, step ray ahead — so a lip reads the same on both sides.
    const reading = readGround(
      (dx, dz) => {
        const hit = sim.raycast!([p[0] + dx, p[1], p[2] + dz], [0, -1, 0], PROBE_REACH, { exclude });
        return hit ? { distance: hit.distance, normal: hit.normal } : null;
      },
      {
        rest: player.groundRest ?? 0,
        radius: this.footRadius(player),
        dirX: vx,
        dirZ: vz,
        stepHeight: player.groundRest !== undefined && this.groundStick > 0 ? this.stepHeight : 0,
        slack: PROBE_SLACK,
      },
    );
    if (Number.isFinite(reading.centre) && player.groundRest === undefined && Math.abs(vy) < 1) {
      player.groundRest = reading.centre;
    }
    const rest = player.groundRest ?? null;
    const grounded =
      rest !== null
        ? !probeLeaving({ dist: reading.dist, rest, slack: PROBE_SLACK, stick: this.groundStick, vy, launched })
        : Math.abs(vy) < 0.05;
    return { grounded, dist: reading.dist, rest, normal: reading.normal, step: reading.step, reach: reading.reach };
  }

  /** Horizontal radius of the body's collider, 0 where it cannot say — the controller's footRadius. */
  private footRadius(player: PlayerRecord): number {
    const collider = this.world.entities.get(player.bodyId)?.components["collider"] as
      | { shape?: string; size?: number[] }
      | undefined;
    const size = collider?.size;
    if (!collider || !size) return 0;
    const shape = collider.shape ?? "box";
    if (shape !== "capsule" && shape !== "box" && shape !== "sphere" && shape !== "cylinder") return 0;
    const across = Math.min(size[0] ?? 0, size[2] ?? size[0] ?? 0);
    return across > 0 ? across / 2 : 0;
  }

  /**
   * The water over this body's feet, or null. `groundRest` is the measured
   * origin-to-feet distance for this body; before the first probe answers
   * (a player who spawned in the water) half a standing capsule stands in,
   * exactly as the client's controller assumes.
   */
  private sampleWater(player: PlayerRecord, _vy: number): WaterAt | null {
    if (!this.waterAt || !this.swimEnabled) return null;
    const p = this.world.positionOf(player.bodyId);
    if (!p) return null;
    return this.waterAt(p[0], p[1] - this.footDrop(player), p[2]);
  }

  /**
   * Origin-to-feet for one body, off its COLLIDER — the same number the
   * client's controller uses, and for the same reason: the ground probe's
   * measured resting distance is recorded on the first tick a body looks
   * settled, and a body that spawned in mid-air looks settled.
   */
  private footDrop(player: PlayerRecord): number {
    const cached = this.feet.get(player.bodyId);
    if (cached !== undefined) return cached;
    const drop = this.restFromCollider(player) ?? player.groundRest ?? 0.9;
    this.feet.set(player.bodyId, drop);
    return drop;
  }

  /**
   * How far the ground is when this body is STANDING on it, straight off the
   * collider — half its height less its offset — or null where the collider
   * cannot say. Only the SIZED primitives: a cooked mesh collider ignores
   * `size` entirely, so those bodies fall back to measuring (see probeGround).
   */
  private restFromCollider(player: PlayerRecord): number | null {
    const collider = this.world.entities.get(player.bodyId)?.components["collider"] as
      | { shape?: string; size?: number[]; offset?: number[] }
      | undefined;
    if (!collider) return null;
    const shape = collider.shape ?? "box";
    if (shape !== "capsule" && shape !== "box" && shape !== "sphere" && shape !== "cylinder") return null;
    const height = collider.size?.[1];
    if (!(typeof height === "number" && height > 0)) return null;
    // a collider hung below the origin rests further from it, one lifted nearer
    const reach = height / 2 - (collider.offset?.[1] ?? 0);
    return reach > 0 ? reach : null;
  }

  /**
   * The after-physics hook: a player body's sim rotation is locked, so the
   * readback writes identity over the yaw `step` set, and every script after
   * it (a guard's front arc, a backstab's rear) would judge a body facing +Z.
   * No controller runs here to rewrite it each tick, so this does.
   */
  face = (): void => {
    for (const player of this.players.values()) {
      const object = player.facing ? this.world.objects.get(player.bodyId) : undefined;
      if (object) object.rotation.set(player.facing![0], player.facing![1], 0, "YXZ");
    }
  };

  /**
   * A new input takes over: the one it replaces drove the body here for (ticks × dt) and on its client for
   * (this input's send time − that one's). A client with identical physics is off by velocity × the difference;
   * jitter cancels over time, a server that skips or drops time does not. Totals land in `timingTotals`.
   */
  private measureTiming(player: PlayerRecord, input: MovementIntent, v: [number, number]): void {
    const tm = player.timing;
    if (typeof input.t !== "number") return;
    if (tm && input.seq > tm.seq && input.t >= tm.t) {
      const serverMs = (this.world.tick - tm.tick) * this.world.fixedDt * 1000;
      const clientMs = input.t - tm.t;
      // a gap of seconds is a pause (a tab in the background), not drift
      if (clientMs < 1000) {
        const e = (serverMs - clientMs) / 1000;
        tm.drift[0] += tm.v[0] * e;
        tm.drift[1] += tm.v[1] * e;
        tm.inputs++;
        this.timingTotals.inputs++;
        const size = Math.hypot(tm.drift[0], tm.drift[1]);
        if (size > 0.5) {
          tm.over05++;
          this.timingTotals.over05++;
          tm.maxM = Math.max(tm.maxM, Math.round(size * 100) / 100);
          this.timingTotals.maxM = Math.max(this.timingTotals.maxM, Math.round(size * 100) / 100);
          tm.drift = [0, 0]; // reconciled away on the client
        }
      }
    }
    player.timing = { seq: input.seq, tick: this.world.tick, t: input.t, v: [v[0], v[1]], drift: tm?.drift ?? [0, 0], inputs: tm?.inputs ?? 0, over05: tm?.over05 ?? 0, maxM: tm?.maxM ?? 0 };
  }

  /** Every player's timing drift since the server started (see measureTiming). */
  readonly timingTotals = { inputs: 0, over05: 0, maxM: 0 };

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
        liftUntil?: number;
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
        // clamp: first the absolute trust cap, then what this body may do now —
        // plus, while an action plays and the body is not rooted, the room a
        // clip that steps in needs (advanceAllowance; the controller never
        // advances a body whose speedMult is 0)
        const mult = ud.speedMult ?? 1;
        const acting = !!ud.actionClip && (ud.actionUntil ?? 0) > simNow && mult > 0;
        const cap = Math.min(
          this.maxSpeed,
          Math.max(this.runSpeed, this.sprintSpeed) * 1.05 * mult + (acting ? this.advanceAllowance : 0),
        );
        if (requested > cap && requested > 0) {
          vx = (vx / requested) * cap;
          vz = (vz / requested) * cap;
        }
        if (player.appliedSeq !== input!.seq) {
          player.appliedAt = this.world.tick;
          this.measureTiming(player, input!, [vx, vz]);
        }
        player.appliedSeq = input!.seq;
      }
      const driven = !!ud.impulseVel && (ud.impulseUntil ?? 0) > simNow;
      if (driven && !ud.frozen) {
        vx = ud.impulseVel![0];
        vz = ud.impulseVel![1];
      }
      // Water first: a swimming body has no ground question to answer, and
      // asking it anyway is what drags a swimmer to the bed. Measured at the
      // FEET, using the same resting height the ground probe measured, so the
      // waterline means the same thing here as it does on the client.
      const water = this.sampleWater(player, vy);
      const swimming_ =
        water !== null &&
        water.swim &&
        this.swimEnabled &&
        !ud.frozen &&
        swimStateFor(water.depth, water.surfaceY - water.floorY, player.swim ?? "dry", this.swim) === "swimming";
      player.swim = water === null || water.depth <= 0 ? "dry" : swimming_ ? "swimming" : "wading";
      if (swimming_) {
        // The peer's own aim, clamped against what this body could actually
        // swim: it is a claimed velocity like the horizontal pair, so it gets
        // the same treatment.
        const cap = this.swimSpeed + this.swim.climbSpeed;
        const asked = fresh ? Math.max(-cap, Math.min(cap, input!.vy)) : 0;
        vy = swimVy(water!.depth, asked, this.swim);
        vx += water!.current[0];
        vz += water!.current[1];
        player.stickVy = undefined;
        player.jumping = false;
        player.airTime = 0;
        sim.setLinvel(player.bodyId, [vx, vy, vz]);
        // Peers see the PITCH too. A swimmer's body lies along its travel, and
        // that attitude is half of reading what another player is doing —
        // diving away from you looks nothing like swimming away from you. The
        // owner's controller computes the same angle locally; this is the copy
        // everybody else gets.
        if (object && fresh) {
          const travel = Math.hypot(vx, vz);
          const pitch = Math.max(
            -this.swimMaxPitch,
            Math.min(this.swimMaxPitch, -Math.atan2(asked, Math.max(travel, 0.001))),
          );
          object.rotation.set(pitch, input!.yaw, 0, "YXZ");
          player.facing = [pitch, input!.yaw];
        }
        const swimAnim = this.gaitClip(player, ud, vx, vy, vz, simNow, true, fresh ? input!.vy : 0);
        this.world.anims.set(player.bodyId, swimAnim.clip);
        this.world.animRates.set(player.bodyId, swimAnim.rate);
        if (swimAnim.layer) this.world.animLayers.set(player.bodyId, swimAnim.layer);
        else this.world.animLayers.delete(player.bodyId);
        continue;
      }

      // Where the ground is, and which way it faces. The client's controller
      // asks the same question of its own copy of the body; if only one of the
      // two follows the ground, every slope is a fight between prediction and
      // authority that the authority wins by yanking the player back.
      // a script that launched the body on purpose owns its rise until its deadline
      const lifted = (ud.liftUntil ?? 0) > simNow;
      if (player.jumping && vy <= 0) player.jumping = false;
      const ground = this.probeGround(player, vy, vx, vz, !!player.jumping || lifted);
      // The controller's sustained-evidence rule, so a fall starts on the same
      // tick on both sides (and with it the heavier fall gravity).
      const dt = this.world.fixedDt;
      player.airTime = ground.grounded ? 0 : (player.airTime ?? 0) + dt;
      const sinceJump = simNow - (player.jumpAt ?? -999);
      const grounded = !(player.airTime > this.coyoteTime || sinceJump < 0.25);
      if (grounded && sinceJump >= 0.25) player.jumping = false;
      const jumpHeld = fresh && input!.jump;
      let tookOff = false;
      if (jumpHeld && grounded) {
        vy = this.jumpVelocity;
        player.jumpAt = simNow;
        player.jumping = true;
        tookOff = true;
      }
      if (!lifted && ground.normal && ground.rest !== null && simNow - (player.jumpAt ?? -999) > 0.25) {
        const follow = groundFollowVy(vx, vz, vy, ground.normal, ground.dist - ground.rest, {
          stick: this.groundStick,
          slopeTolerance: this.slopeTolerance,
          dt,
          ours: risingByGround(vy, player.stickVy ?? null),
          // the same guard the client's controller runs, or a doorway is a
          // fight between a client that stays down and an authority that hops
          popCap: this.stepPopCap,
          step: ground.step,
          stepReach: ground.reach,
          wrote: player.stickVy ?? null,
        });
        player.stickVy = follow ?? undefined;
        if (follow !== null) vy = follow;
      } else player.stickVy = undefined;
      // Jump shaping and air control, exactly as the controller applies them —
      // the client predicts this arc, so the authority has to fly it too.
      // (a frozen body is pinned by the controller with plain gravity, so here too)
      if (!tookOff && !lifted && !ud.frozen && (!grounded || player.jumping)) {
        vy += extraGravityDv(airGravityScale(vy, !!player.jumping, jumpHeld, this.jumpShape), dt);
      }
      if (!grounded && !driven && !ud.frozen) {
        [vx, vz] = airSteer(vel[0], vel[2], vx, vz, fresh && Math.hypot(vx, vz) > 0, this.airControl, dt);
      }
      sim.setLinvel(player.bodyId, [vx, vy, vz]);
      if (object && fresh) {
        object.rotation.set(0, input!.yaw, 0);
        player.facing = [0, input!.yaw];
      }
      const wadingDeep =
        player.swim === "wading" && water !== null && water.depth > this.wadeDeepDepth;
      const anim = this.gaitClip(player, ud, vx, vel[1], vz, simNow, false, 0, wadingDeep);
      this.world.anims.set(player.bodyId, anim.clip);
      this.world.animRates.set(player.bodyId, anim.rate);
      if (anim.layer) this.world.animLayers.set(player.bodyId, anim.layer);
      else this.world.animLayers.delete(player.bodyId);
    }
  };
}
