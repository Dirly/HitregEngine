/**
 * GameServer — a RoomHost around a HeadlessWorld.
 *
 * Everything a P2P host tab does in `net-presence.ts` + `main.ts`, with no
 * local player and no renderer:
 *
 *   commands up:    movement intent → PlayerDriver; `event` → EventBus (to-authority only)
 *   snapshots down: players (authoritative positions + applied seq) and each
 *                   peer's interest-managed slice of the replicated world
 *   reliable down:  replicated events (bus outbox), netState deltas, and the
 *                   `world` module — entity docs for everything spawned at
 *                   runtime (players, NPCs) so clients can build them
 *
 * The snapshot shape is exactly what `NetPresence.ingestSnapshot` already
 * parses, so a tab connecting here reuses its whole peer-side path.
 */

import {
  RoomHost,
  computeView,
  dueThisTick,
  type Transport,
  type ReplicaEntry,
} from "@hitreg/net";
import {
  BADGE_NETSTATE,
  CAMP_SECONDS,
  PLAYER_LOGOUT_EVENT,
  bagKeeper,
  CAST_NETSTATE,
  corpseClaimed,
  releaseCorpse,
  HAND_NETSTATE,
  isLootLocked,
  isTransferLocked,
  LOOT_LOCK_NETSTATE,
  LOOT_NETSTATE,
  LOOT_SAVE_NETSTATE,
  packSavedBags,
  unpackSavedBags,
  PERSISTED_PLAYER_NAMESPACES,
  PORTAL_NETSTATE,
  resolvePortalArrival,
  WaterIndex,
  waterQuery,
  waterVolumes,
  type CharacterBuild,
  type EntityDoc,
  type LootBag,
  type NetObjectData,
  type NetStateDelta,
  type Profiler,
  type RecipeEdit,
  type WorldRecipe,
} from "@hitreg/core";
import type { HeadlessWorld } from "./world.js";
import type { TerrainStreamer } from "./terrain.js";
import { sightRadius } from "./sight.js";
import type { CommitInput, PlayerSave } from "./cluster/player-store.js";

export type LeaveReason = "leave" | "grace" | "transfer" | "replaced" | "kicked" | "logout" | "closing";
import {
  extractPlayerTemplate,
  instantiatePlayer,
  PlayerDriver,
  type PlayerRecord,
  type PlayerTemplate,
} from "./players.js";

export const WORLD_MODULE = "world";

/** `world` module messages, host → client. */
export type WorldModuleMessage =
  | { t: "spawn"; entities: Record<string, EntityDoc>; self?: string }
  | { t: "despawn"; ids: string[] }
  /** Private camp progress. Null ends/cancels it; zero means the save is being confirmed. */
  | { t: "camp"; remaining: number | null; reason?: string }
  /** The server saved the character and accepted its intentional logout. */
  | { t: "logout" }
  /** A player's link dropped (body held for the grace window) or came back. */
  | { t: "presence"; peerId: string; linked: boolean }
  /** The world recipe changed (terraform): re-register it and re-stream. */
  | { t: "recipe"; id: string; recipe: WorldRecipe }
  /**
   * Go there now: say bye here, dial `url` with `ticket`. The body here is
   * torn down the moment the client leaves (no grace); the save was
   * committed before this was sent, and the ticket binds the destination
   * to that revision.
   */
  | { t: "transfer"; url: string; ticket: string; reason: string; srv?: string; scene?: string };

/**
 * Where a body spawning in `scene` stands: a portal arrival recorded in the
 * save (`portal/<bodyId>.arrive` for THIS scene — an anchor in the scene, or a
 * return point) wins, then the saved per-scene position, then `fallback`.
 * `records` is the save's records with the arrival consumed. Shared by
 * `GameServer.join` and the headless portal harness, so both land a
 * traveller the same way. Bodies already standing on the anchor (other
 * players of the world) push a newcomer to the next free spot — along the
 * anchor's forward line when it declares a `portalAnchor.corridor`.
 */
export function arrivalFor(
  world: HeadlessWorld,
  scene: string,
  save: PlayerSave | null,
  fallback: () => [number, number, number],
): { at: [number, number, number]; yaw: number; records: Record<string, unknown>; anchor: string | null; portal: boolean } {
  const records: Record<string, unknown> = { ...(save?.records ?? {}) };
  const occupied: [number, number, number][] = [];
  if (save) {
    for (const key of world.netState.keys("player/")) {
      const body = world.netState.get(key);
      const at = typeof body === "string" ? world.positionOf(body) : null;
      if (at) occupied.push(at);
    }
  }
  const arrival = save ? resolvePortalArrival(records[PORTAL_NETSTATE], scene, world.expanded.entities, occupied) : null;
  if (arrival) {
    records[PORTAL_NETSTATE] = arrival.next;
    return { at: arrival.position, yaw: arrival.yaw, records, anchor: arrival.anchor, portal: true };
  }
  return { at: save?.position ?? fallback(), yaw: save?.yaw ?? 0, records, anchor: null, portal: false };
}

/**
 * Save-before-spawn: the saved sheet, the per-character records (quests, NPC
 * memory, the vault, the bind, the portal trip) and the creation build go into
 * netState BEFORE the body's scripts start, so the scripts that own them find
 * them and keep them. With `scene`, the character's saved loot bags lying in
 * that scene are live again (`lootbag/<id>`, core loot.ts); the rest wait in
 * `lootbags/<bodyId>`.
 */
export function seedPlayerState(world: HeadlessWorld, bodyId: string, sheet: unknown, records: Record<string, unknown>, build?: CharacterBuild, label = bodyId, scene?: string): void {
  if (sheet !== null && sheet !== undefined && !world.netState.set(`character/${bodyId}`, sheet)) {
    console.warn(`[server] saved sheet for ${label} failed validation — starting fresh`);
  }
  if (scene !== undefined && records[LOOT_SAVE_NETSTATE] !== undefined) {
    const { live, dormant } = unpackSavedBags(records[LOOT_SAVE_NETSTATE], scene, world.timeMs);
    for (const [id, bag] of live) {
      if (!world.netState.set(`${LOOT_NETSTATE}/${id}`, { ...bag, owner: bodyId })) console.warn(`[server] saved loot bag ${id} for ${label} failed validation — dropped`);
    }
    records = { ...records, [LOOT_SAVE_NETSTATE]: dormant ? { ...dormant, owner: bodyId } : undefined };
  }
  for (const [ns, value] of Object.entries(records)) {
    if (!(PERSISTED_PLAYER_NAMESPACES as readonly string[]).includes(ns) || value === null || value === undefined) continue;
    if (!world.netState.set(`${ns}/${bodyId}`, value)) console.warn(`[server] saved ${ns} for ${label} failed validation — starting fresh`);
  }
  if (build && !world.netState.set(`build/${bodyId}`, build)) console.warn(`[server] creation build for ${label} failed validation — ignored`);
}

/**
 * The bags lying live in this world that are `bodyId`'s to keep (`lootbag/<id>`): those it owns, and its own
 * CORPSE even while a killer's claim holds it (core `bagKeeper`) — never a corpse it holds a claim on.
 */
function liveBagsOf(world: HeadlessWorld, bodyId: string): Array<[string, LootBag]> {
  const out: Array<[string, LootBag]> = [];
  for (const key of world.netState.keys(`${LOOT_NETSTATE}/`)) {
    const bag = world.netState.get(key) as LootBag | undefined;
    if (bag && bagKeeper(bag) === bodyId) out.push([key.slice(LOOT_NETSTATE.length + 1), bag]);
  }
  return out;
}

/** What the save authority stores about a body: the sheet the scripts maintain, its records (its live loot bags packed in), and where it stands. */
export function playerSnapshot(world: HeadlessWorld, bodyId: string, scene: string): CommitInput {
  const object = world.objects.get(bodyId);
  const records: Record<string, unknown> = Object.fromEntries(PERSISTED_PLAYER_NAMESPACES.map((ns) => [ns, world.netState.get(`${ns}/${bodyId}`)]));
  const bags = liveBagsOf(world, bodyId);
  if (bags.length > 0 || records[LOOT_SAVE_NETSTATE] !== undefined) {
    records[LOOT_SAVE_NETSTATE] = packSavedBags(bodyId, records[LOOT_SAVE_NETSTATE], bags, scene, world.timeMs);
  }
  return {
    sheet: world.netState.get(`character/${bodyId}`),
    records,
    scene,
    position: world.positionOf(bodyId),
    yaw: object ? object.rotation.y : 0,
  };
}

/**
 * Forget a departed body's session state (its saved records went with the commit). Its loot bags go too — body
 * bags always (a chance belongs to one session), item bags unless `keepBags` (nothing saved them: with no save
 * authority they stay in the world for their owner to come back to until they expire).
 */
export function clearPlayerState(world: HeadlessWorld, bodyId: string, peerId: string, opts: { keepBags?: boolean } = {}): void {
  for (const [id, bag] of liveBagsOf(world, bodyId)) if (bag.body !== undefined || !opts.keepBags) world.netState.delete(`${LOOT_NETSTATE}/${id}`);
  // a departing KILLER's claim on someone's corpse ends now: it passes to its dead character (and their lock lifts)
  for (const key of world.netState.keys(`${LOOT_NETSTATE}/`)) {
    const bag = world.netState.get(key) as LootBag | undefined;
    if (!bag || bag.owner !== bodyId || !corpseClaimed(bag)) continue;
    const released = releaseCorpse(bag);
    if (released) world.netState.set(key, released);
    else world.netState.delete(key);
    const lockKey = `${LOOT_LOCK_NETSTATE}/${bag.corpse}`;
    if ((world.netState.get(lockKey) as { bag?: string } | undefined)?.bag === key.slice(LOOT_NETSTATE.length + 1)) world.netState.delete(lockKey);
  }
  for (const key of world.netState.keys(`combat/${bodyId}.`)) world.netState.delete(key);
  for (const key of world.netState.keys(`cooldown/${bodyId}.`)) world.netState.delete(key);
  // `hand` (the weapon set in hand) too: a stale set, or a swap pending, must not survive a reconnect;
  // `notice` likewise: a body that left sneaking must not come back unnoticeable
  for (const ns of ["character", "build", HAND_NETSTATE, CAST_NETSTATE, BADGE_NETSTATE, "landing", "notice", "transferLock", LOOT_LOCK_NETSTATE, "owner", "name", ...PERSISTED_PLAYER_NAMESPACES]) world.netState.delete(`${ns}/${bodyId}`);
  world.netState.delete(`player/${peerId}`);
}

/** Who a peer is, from the ticket it presented (absent on an open dev server). */
export interface PlayerIdentity {
  playerId: string;
  characterId: string;
  /** Server-signed save identity; absent on older tickets, which use the account id. */
  saveId?: string;
  name: string;
  /** Revisions a transfer ticket promised the save is at. */
  rev?: Record<string, number>;
  /** Character-creation build from the ticket; seeds a fresh sheet (netState build/<bodyId>). */
  build?: CharacterBuild;
}

/** The save authority's two calls. Without one, nothing persists (dev). */
export interface PlayerPersistence {
  load(identity: PlayerIdentity, scene: string): Promise<PlayerSave>;
  commit(identity: PlayerIdentity, input: CommitInput): Promise<Record<string, number>>;
}

export interface GameServerOptions {
  world: HeadlessWorld;
  transport: Transport;
  terrain?: TerrainStreamer | null;
  /** Scene name — keys the per-scene saved position. Default "scene". */
  scene?: string;
  /** Identity of an authenticated peer; undefined = anonymous (no persistence for it). */
  identityOf?: (peerId: string) => PlayerIdentity | undefined;
  persistence?: PlayerPersistence;
  /** Seconds between periodic saves of every identified player (default 30; 0 = only on leave/transfer). */
  commitEverySeconds?: number;
  /** Extra veto on moving a player right now (in combat, mid-cast …). */
  transferGate?: (peerId: string) => boolean;
  /** Seconds a freshly spawned body is `landing/<bodyId>` (brains leave it alone). Default 5; 0 disables. */
  landingSeconds?: number;
  onPlayerJoined?: (player: PlayerRecord) => void;
  onPlayerLeft?: (player: PlayerRecord, reason: LeaveReason) => void;
  /** Ticks between snapshots (default 3 → 20 Hz at 60 Hz sim). */
  snapshotEvery?: number;
  /** The player subtree to clone per joiner; default: extracted from the world's base scene. */
  playerTemplate?: PlayerTemplate | null;
  /** Where a joiner appears; default: the template's authored position. */
  spawnPoint?: (peerId: string) => [number, number, number];
  maxPlayers?: number;
  /** Ticks between terrain residency passes (default 10). */
  terrainEvery?: number;
  /**
   * Seconds a disconnected player's body stays in the world before it is torn
   * down (default 60). A tab that re-dials with the same peer id inside the
   * window gets its body back where it stood — a dropped link is not a death.
   */
  reconnectGraceSeconds?: number;
  /** Called with the new recipe after every successful terraform (persist it — the recipe is the save). */
  onRecipeChanged?: (id: string, recipe: WorldRecipe) => void;
  /**
   * Tick profiler (`serve --profile`, GET /admin/profile): one frame per tick,
   * scopes for each phase. Pass the same instance to the HeadlessWorld for its
   * physics/scripts split and the per-script rows.
   */
  profiler?: Profiler;
  /**
   * Metres within which a player is sent the creatures, NPCs and other players around it (default 250; 0 = every
   * replica to every player, as before). Entities whose scene doc declares its own `netObject` relevancy keep it.
   * Snapshot size and the work of building them then follow how crowded a player's surroundings are, not the
   * population of the layer; what lies beyond is not shown (the client hides what leaves its view).
   */
  interestRadius?: number;
  /**
   * netState by interest too (default: on whenever interestRadius is): a key about a replicated entity
   * (`combat/<id>.hp`, `cooldown/<id>.x`, `cast/<id>` …) goes only to the peers that can see that entity, its
   * owner and the owner's party; the rest of the state goes to everyone. An entity's keys are sent when it
   * comes into a peer's view and removed when it leaves. Without it every player's regeneration reached every
   * other player in the layer: bytes growing with the square of the population.
   */
  stateInterest?: boolean;
  /**
   * OFF by default (an owner decision): ticks between netState/event deliveries. 3 at 60 Hz = with every
   * snapshot (20 Hz): repeated writes to a key coalesce into one, and a player gets ~3x fewer messages, at up
   * to 33 ms more latency on hits, casts and bars.
   */
  stateEvery?: number;
  /**
   * OFF by default (an owner decision): fields delivered at most this often per second, e.g.
   * `{ stamina: 10, mana: 10, stability: 10 }` — the bars other screens see move at 10 Hz. Only delivery is
   * throttled (the latest value always lands); the authority keeps every write.
   */
  stateHz?: Record<string, number>;
  /**
   * OFF by default (an owner decision): entities farther than `beyond` metres from a player go to it every
   * `every`-th snapshot only — far fighters move choppier on that screen, near ones are untouched.
   */
  farSend?: { beyond: number; every: number } | null;
  /** Ticks at or over this many ms are kept in the slow-tick log (GET /admin/slow-ticks). Default 2× the tick budget. */
  slowTickMs?: number;
}

interface RemoteInputCommand {
  t: "input";
  seq?: unknown;
  v?: unknown;
  jump?: unknown;
  /** Vertical SPEED in m/s while swimming (see swimAim), not a -1..1 intent. */
  vy?: unknown;
  yaw?: unknown;
  p?: unknown;
  /** The client's clock (ms) at send: timing drift is measured against it. */
  ct?: unknown;
}

function isFiniteVec(v: unknown, len: number): v is number[] {
  return Array.isArray(v) && v.length === len && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const NO_PEERS: ReadonlySet<string> = new Set();
/** Payload fields that name the entities an event is about (events by interest, GameServer.shipEvents). */
const EVENT_SUBJECT_FIELDS = ["casterId", "actorId", "targetId", "attackerId", "sourceId", "bodyId", "entityId", "id"] as const;

/** One tick over the slow threshold, kept whole: where its time went and what it was doing. */
export interface SlowTick {
  tick: number;
  at: string;
  ms: number;
  /** Wall ms per tick phase; `step` is the world step (drivers, physics, scripts, after-step hooks such as spawn areas). */
  phases: Record<string, number>;
  /** Work the tick did that explains most spikes: terrain cells generated inline or integrated, statics cooked, entities added. */
  activity: Record<string, number>;
  /** With --profile: the worst scopes by self time. */
  scopes?: string[];
}

/** One replicated entity as last gathered; `ver` moves when anything in it changes. */
interface ReplicaState {
  p: [number, number, number];
  q: [number, number, number, number];
  anim?: string;
  animL?: string;
  animR?: number;
  animD?: number;
  animM?: "hold" | "loop";
  syncTransform: boolean;
  ver: number;
  /** Its snapshot update, built on first send (updateOf): with and without the hold flag. */
  update?: Record<string, unknown>;
  updateHeld?: Record<string, unknown>;
}

/** Per peer: the version and tick of every entity last sent to it, and its managed list. */
interface PeerSent {
  /** `settled`: the last two sends carried the same state (the client knows it stands still). */
  entities: Map<string, { ver: number; at: number; refreshAt: number; settled: boolean }>;
  managedKey: string;
  managedAt: number;
}

/** The snapshot update for a replica state — one object per state and hold flag, shared by every peer. */
function updateOf(s: ReplicaState, hold: boolean): Record<string, unknown> {
  const cached = hold ? s.updateHeld : s.update;
  if (cached) return cached;
  const u: Record<string, unknown> = {
    p: s.p,
    q: s.q,
    ...(hold ? { h: 1 } : {}),
    ...(s.anim ? { anim: s.anim } : {}),
    ...(s.animL ? { animL: s.animL } : {}),
    ...(s.animR !== undefined ? { animR: s.animR } : {}),
    ...(s.animD !== undefined ? { animD: s.animD } : {}),
    ...(s.animM ? { animM: s.animM } : {}),
  };
  if (hold) s.updateHeld = u;
  else s.update = u;
  return u;
}

/** JSON of objects serialised once and reused (snapshot updates and player entries are shared between peers). */
const fragments = new WeakMap<object, string>();
function fragment(value: object): string {
  let json = fragments.get(value);
  if (json === undefined) fragments.set(value, (json = JSON.stringify(value)));
  return json;
}

/**
 * A peer's snapshot state (buildStateFor's shape) as JSON, its shared parts — each entity's update, each
 * player's entry — spliced in from their cached serialisation instead of re-encoded for every peer.
 */
export function snapshotJson(state: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    if (key === "players" && value && typeof value === "object") {
      const players = Object.entries(value as Record<string, object>).map(([id, entry]) => `${JSON.stringify(id)}:${fragment(entry)}`);
      parts.push(`"players":{${players.join(",")}}`);
    } else if (key === "entities" && value && typeof value === "object") {
      const e = value as { updates?: Record<string, object> } & Record<string, unknown>;
      const inner: string[] = [];
      for (const [k, v] of Object.entries(e)) {
        if (k === "updates" && v && typeof v === "object") {
          inner.push(`"updates":{${Object.entries(v as Record<string, object>).map(([id, u]) => `${JSON.stringify(id)}:${fragment(u)}`).join(",")}}`);
        } else inner.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
      }
      parts.push(`"entities":{${inner.join(",")}}`);
    } else parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

function sameReplicaState(a: ReplicaState, b: ReplicaState): boolean {
  return (
    a.p[0] === b.p[0] && a.p[1] === b.p[1] && a.p[2] === b.p[2] &&
    a.q[0] === b.q[0] && a.q[1] === b.q[1] && a.q[2] === b.q[2] && a.q[3] === b.q[3] &&
    a.anim === b.anim && a.animL === b.animL && a.animR === b.animR && a.animD === b.animD && a.animM === b.animM &&
    a.syncTransform === b.syncTransform
  );
}

/** A grid cell key (cells ±32k each way). */
function gridKey(x: number, z: number): number {
  return (x + 32768) * 65536 + (z + 32768);
}

function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash;
}

/** The client's reconciliation thresholds (playground net-session.ts NET_NUDGE_DIST / NET_SNAP_DIST): a gap past these is a visible correction. */
const NUDGE_DIST = 1.0;
const SNAP_DIST = 3.5;

/** Absolute cap on a claimed vertical swim speed, before the driver's own clamp. */
const VERTICAL_CAP = 20;

export class GameServer {
  readonly world: HeadlessWorld;
  readonly host: RoomHost;
  readonly terrain: TerrainStreamer | null;
  private readonly transport: Transport;
  readonly players = new Map<string, PlayerRecord>();
  /** Client-facing docs of every runtime-spawned entity (players, NPCs). */
  readonly runtimeDocs = new Map<string, EntityDoc>();
  private readonly template: PlayerTemplate | null;
  private readonly driver: PlayerDriver | null;
  private readonly spawnPoint: (peerId: string) => [number, number, number];
  private readonly peerViews = new Map<string, Set<string>>();
  private readonly snapshotEvery: number;
  private readonly terrainEvery: number;
  private readonly graceTicks: number;
  private readonly onRecipeChanged: ((id: string, recipe: WorldRecipe) => void) | undefined;
  readonly scene: string;
  private readonly identityOf: ((peerId: string) => PlayerIdentity | undefined) | undefined;
  private readonly persistence: PlayerPersistence | undefined;
  private readonly commitTicks: number;
  private readonly transferGate: ((peerId: string) => boolean) | undefined;
  private readonly landingSeconds: number;
  private readonly onPlayerJoined: ((player: PlayerRecord) => void) | undefined;
  private readonly onPlayerLeft: ((player: PlayerRecord, reason: LeaveReason) => void) | undefined;
  /** Peers whose save is still loading (no body yet). */
  private readonly joining = new Set<string>();
  /** Root entity ids whose simulation is paused (a sleeping spawn area): not terrain foci. */
  readonly paused = new Set<string>();
  /** False while draining: new joins are refused. */
  accepting = true;
  /** Ticks a told-to-transfer player may linger before being torn down anyway. */
  private static readonly TRANSFER_LINGER_TICKS = 900;
  /** Wall-clock cost of the last 300 ticks (ms), for /admin/status. */
  private readonly tickCost: number[] = [];
  /** See GameServerOptions.profiler. */
  readonly profiler: Profiler | null;
  private readonly unsubs: Array<() => void> = [];
  private replicas: ReplicaEntry[] = [];
  /** Entity ids that may replicate (netObject, or script + rigidbody), rebuilt when the entity set changes. */
  private candidates: string[] = [];
  private candidatesVersion = -1;
  private candidateSet = new Set<string>();

  private refreshCandidates(): void {
    if (this.candidatesVersion === this.world.entityVersion) return;
    this.candidatesVersion = this.world.entityVersion;
    this.candidates = [];
    for (const [id, e] of this.world.entities) {
      const netObj = e.components["netObject"] as NetObjectData | undefined;
      const implicit = e.components["script"] !== undefined && e.components["rigidbody"] !== undefined;
      if (!netObj && !implicit) continue;
      if (netObj?.authority === "owner") continue;
      this.candidates.push(id);
    }
    this.candidateSet = new Set(this.candidates);
    this.sights.clear();
  }
  /** Sight radius per replicated root (sight.ts), cleared whenever the entity set changes. */
  private readonly sights = new Map<string, number>();
  private sightOf(id: string, doc: EntityDoc): number {
    let r = this.sights.get(id);
    if (r === undefined) this.sights.set(id, (r = sightRadius(doc, this.interestRadius)));
    return r;
  }
  /** See GameServerOptions.interestRadius (0 = every replica to everyone). */
  readonly interestRadius: number;
  /** Replicas by XZ grid cell (cell = interest radius + margin), and the ones every peer checks (always / wide). */
  private readonly grid = new Map<number, ReplicaEntry[]>();
  private readonly gridWide: ReplicaEntry[] = [];
  private readonly gridCell: number;
  /** See GameServerOptions.stateInterest. */
  private readonly stateInterest: boolean;
  private readonly stateEvery: number;
  private readonly farSend: { beyond: number; every: number } | null;
  private readonly stateHz: Record<string, number> | null;
  private replicaState = new Map<string, ReplicaState>();
  /** Bumped when the SET of replicated ids changes (the `managed` list a peer holds). */
  private replicaSetVersion = 0;
  /** What each peer was last sent: per entity the state version and tick, and its managed list. */
  private readonly peerSent = new Map<string, PeerSent>();
  /** Owner-only netState keys (`audience: "owner"`) and the peer each was last sent to. */
  private readonly ownerOnlySent = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMs: number | null = null;
  private accumulator = 0;
  private closed = false;

  constructor(opts: GameServerOptions) {
    this.world = opts.world;
    this.transport = opts.transport;
    this.terrain = opts.terrain ?? null;
    this.snapshotEvery = opts.snapshotEvery ?? 3;
    this.terrainEvery = opts.terrainEvery ?? 10;
    this.graceTicks = Math.round((opts.reconnectGraceSeconds ?? 60) / this.world.fixedDt);
    this.onRecipeChanged = opts.onRecipeChanged;
    this.profiler = opts.profiler ?? null;
    this.slowTickMs = opts.slowTickMs ?? this.world.fixedDt * 2000;
    this.interestRadius = Math.max(0, opts.interestRadius ?? 250);
    this.gridCell = Math.max(32, this.interestRadius + 10);
    this.stateInterest = this.interestRadius > 0 && (opts.stateInterest ?? true);
    this.stateEvery = Math.max(1, Math.round(opts.stateEvery ?? 1));
    this.farSend = opts.farSend && opts.farSend.every > 1 ? opts.farSend : null;
    this.stateHz = opts.stateHz && Object.keys(opts.stateHz).length > 0 ? opts.stateHz : null;
    this.scene = opts.scene ?? "scene";
    this.identityOf = opts.identityOf;
    this.persistence = opts.persistence;
    const commitSeconds = opts.commitEverySeconds ?? 30;
    this.commitTicks = commitSeconds > 0 ? Math.round(commitSeconds / this.world.fixedDt) : 0;
    this.transferGate = opts.transferGate;
    this.landingSeconds = opts.landingSeconds ?? 5;
    this.onPlayerJoined = opts.onPlayerJoined;
    this.onPlayerLeft = opts.onPlayerLeft;
    this.template = opts.playerTemplate === undefined ? extractPlayerTemplate(this.world.expanded) : opts.playerTemplate;
    const authored = (this.template?.entities[this.template.rootId]?.components["transform"] as { position?: number[] } | undefined)?.position;
    const fallback: [number, number, number] = isFiniteVec(authored, 3)
      ? [authored[0]!, authored[1]!, authored[2]!]
      : [0, 2, 0];
    this.spawnPoint = opts.spawnPoint ?? (() => fallback);
    // The same water the client swims in: authored volumes from the scene plus
    // the streaming world's own sea, lakes and rivers. Without it the
    // authority does not know water exists and hauls every swimmer to the bed.
    const waterIndex = new WaterIndex(waterVolumes(this.world.expanded));
    const exactWater = waterQuery({
      index: waterIndex,
      field: () => this.terrain?.resolved.field ?? null,
    });
    // Feet at or above sea level with no lake or river reaching the point (the field's cheap bucket test):
    // the generated water there is nothing or the sea at depth ≤ 0, which the driver reads as dry either way —
    // so the landform height (the expensive part, per player per tick) is not evaluated for it. Authored
    // volumes are still asked.
    const waterAt = (x: number, y: number, z: number): ReturnType<typeof exactWater> => {
      const field = this.terrain?.resolved.field;
      if (field && y >= field.recipe.seaLevel && !field.waterNear(x, z, x, z)) return waterIndex.sampleAt(x, y, z) ?? null;
      return exactWater(x, y, z);
    };
    this.driver = this.template
      ? new PlayerDriver(this.world, this.players, this.template.controller, { waterAt })
      : null;
    if (this.driver) {
      this.world.beforeStep.add(this.driver.step);
      this.world.afterPhysics.add(this.driver.face);
    }

    this.host = new RoomHost(opts.transport, {
      snapshotEvery: 1, // we gate cadence ourselves (tick() is called every snapshot tick)
      ...(opts.maxPlayers !== undefined ? { maxPeers: opts.maxPlayers } : {}),
    });
    this.host.setStateSource((peerId) => this.buildStateFor(peerId));
    // no transport-level disconnect hook on purpose: the roster diff in
    // syncRoster is the ONE place a player leaves, and it applies the
    // reconnect grace — a socket drop and a `bye` take the same path
    this.unsubs.push(this.host.onCommand((peer, _tick, input) => this.onCommand(peer, input)));
    this.unsubs.push(this.world.eventBus.on(PLAYER_LOGOUT_EVENT, (payload, meta) => {
      if (!meta?.from) return; // a browser cannot choose another player, and a headless server has no local player
      if ((payload as { cancel: boolean }).cancel) this.cancelCamp(meta.from, "Camp cancelled.");
      else this.startCamp(meta.from);
    }));
    // a `hello` is the join signal: RoomHost has no roster hook, so the
    // roster is diffed each tick (same as net-presence.ts)

  }

  /**
   * Ground under every simulated body BEFORE the first step. Terrain streams around foci, and authored bodies
   * exist from tick 0 — without this they fall through a world that has not loaded yet, and every ground probe
   * they make afterwards reads the fallback. Run at the first tick, not in the constructor, so whatever pauses
   * bodies at boot (NpcManager's dormancy) has done so first: a body nobody is near needs no ground.
   */
  private groundPrimed = false;
  private primeGround(): void {
    this.groundPrimed = true;
    if (this.terrain) {
      for (const p of this.terrainFoci()) this.terrain.ensureAround(p[0], p[2], 1);
    } else if (this.world.streamsStatics) {
      for (const p of this.terrainFoci()) this.world.sim.ensureStaticsAround(p[0], p[2]);
    }
  }

  /**
   * Where terrain must exist: every root entity with a DYNAMIC rigidbody —
   * players and NPCs alike. A body with nothing under it falls forever, so
   * "near a player" is not enough; the world has to be solid wherever the
   * simulation puts weight on it.
   */
  private terrainFoci(): Array<[number, number, number]> {
    // the dynamic roots change only when entities come and go: listed once per change, not found per pass
    if (this.dynamicRootsVersion !== this.world.entityVersion) {
      this.dynamicRootsVersion = this.world.entityVersion;
      this.dynamicRoots = [];
      for (const [id, e] of this.world.entities) {
        if (e.parent !== null) continue;
        const rb = e.components["rigidbody"] as { kind?: string } | undefined;
        if (rb?.kind === "dynamic") this.dynamicRoots.push(id);
      }
    }
    const foci: Array<[number, number, number]> = [];
    for (const id of this.dynamicRoots) {
      if (this.paused.has(id)) continue; // asleep: no weight on the ground, no ground needed
      const p = this.world.positionOf(id);
      if (p) foci.push(p);
    }
    return foci;
  }
  private dynamicRoots: string[] = [];
  private dynamicRootsVersion = -1;

  /** Where the template says a player stands (also the `spawnPoint` default). */
  get playerTemplate(): PlayerTemplate | null {
    return this.template;
  }

  // -- lifecycle ---------------------------------------------------------------

  /** Drive the fixed loop off wall-clock. */
  start(): void {
    if (this.timer) return;
    const dtMs = this.world.fixedDt * 1000;
    this.timer = setInterval(() => this.pump(performance.now()), Math.max(1, Math.floor(dtMs / 2)));
  }

  /** Advance from a timestamp — same accumulator the browser loop uses; hand-fed in tests. */
  pump(nowMs: number): void {
    if (this.closed) return;
    // the thread was busy elsewhere (an admin request, a worker's result, GC) for this long since the last pump
    if (this.pumpEndedAt !== null && nowMs - this.pumpEndedAt >= this.slowTickMs) {
      this.stallCount++;
      this.stalls.push({ tick: this.world.tick, at: new Date().toISOString(), ms: r2(nowMs - this.pumpEndedAt) });
      if (this.stalls.length > 40) this.stalls.splice(this.stalls.reduce((m, s, i, a) => (s.ms < a[m]!.ms ? i : m), 0), 1);
    }
    try {
      this.pumpTicks(nowMs);
    } finally {
      this.pumpEndedAt = performance.now();
    }
  }

  private pumpTicks(nowMs: number): void {
    if (this.lastMs === null) {
      this.lastMs = nowMs;
      return;
    }
    this.accumulator += Math.max(0, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    let steps = 0;
    const dt = this.world.fixedDt;
    while (this.accumulator >= dt && steps < 5) {
      this.tick();
      this.accumulator -= dt;
      steps++;
    }
    if (this.accumulator >= dt) {
      // more than five ticks behind: the rest is dropped. Every moving client's prediction keeps that time and
      // the authority never simulates it — each ms here is distance a moving player is pulled back
      const dropped = this.accumulator - (this.accumulator % dt);
      this.lostSimMs += dropped * 1000;
      this.lostAt = performance.now();
      this.accumulator = this.accumulator % dt;
    }
  }

  /** Wall-clock milliseconds of simulation dropped because the loop fell more than five ticks behind (total). */
  private lostSimMs = 0;
  /** performance.now() of the last drop, or of the last slow tick (the "server was late" window). */
  private lostAt = -Infinity;

  /** One authoritative tick: roster → terrain → sim + scripts → replication. */
  tick(): void {
    if (this.closed) return;
    const started = performance.now();
    const profiler = this.profiler?.enabled ? this.profiler : null;
    if (!this.groundPrimed) this.primeGround();
    const before = this.activity();
    profiler?.beginFrame();
    profiler?.begin("roster");
    this.syncRoster();
    profiler?.end();
    const tRoster = performance.now();
    const tick = this.world.tick;
    const streams = this.world.streamsStatics;
    if ((this.terrain || streams) && tick % this.terrainEvery === 0) {
      profiler?.begin("terrain");
      const foci = this.terrainFoci();
      this.terrain?.update(foci);
      // props and buildings stream around the same points as the ground
      if (streams) this.world.sim.updateStatics(foci);
      profiler?.end();
    }
    const tTerrain = performance.now();
    this.world.step();
    this.updateCamps();
    const tStep = performance.now();
    this.host.setTick(this.world.tick);
    if (this.world.tick % this.snapshotEvery === 0) {
      // the replicated state is read only by snapshots: gather it on those ticks
      profiler?.begin("replicas");
      this.collectReplicas();
      this.gathered = { tick: this.world.tick, simMs: this.world.timeMs };
      profiler?.end();
    }
    if (this.gathered) {
      // each peer's snapshot of the last gather goes out on its own phase of the snapshot interval: still
      // 20 Hz for every player, but a crowd's snapshots spread over the ticks instead of piling onto one
      profiler?.begin("snapshots");
      let sent = false;
      for (const { peerId } of this.host.peers()) {
        if ((this.world.tick - this.gathered.tick) % this.snapshotEvery !== this.snapshotPhase(peerId)) continue;
        this.host.sendSnapshotJson(peerId, this.gathered.tick, snapshotJson(this.buildStateFor(peerId) as Record<string, unknown>));
        sent = true;
      }
      if (sent && this.stateInterest) this.updateEntityAudience();
      profiler?.end();
    }
    const tSnap = performance.now();
    profiler?.begin("broadcast");
    // state and events go every tick, or every stateEvery ticks (GameServerOptions.stateEvery: coalesced)
    if (tick % this.stateEvery === 0) {
      const outbox = this.world.eventBus.takeOutbox();
      if (outbox.length > 0) this.shipEvents(outbox);
      const delta = this.throttleState(this.world.netState.takeDelta());
      if (delta || this.interestQueue.size > 0) this.shipState(delta ?? { set: {}, removed: [] });
    }
    profiler?.end();
    const tBroadcast = performance.now();
    if (tick % 600 === 0) this.retryPendingSaves();
    // periodic saves, staggered so 50 players do not all commit on one tick
    if (this.commitTicks > 0 && this.persistence) {
      for (const player of this.players.values()) {
        if (!player.identity || player.transferring !== null || player.committing) continue;
        if ((tick + player.commitPhase) % this.commitTicks !== 0) continue;
        void this.commit(player.peerId).catch((error: unknown) => {
          console.warn(`[server] periodic save for ${player.peerId} failed:`, error instanceof Error ? error.message : error);
        });
      }
    }
    const ended = performance.now();
    const cost = ended - started;
    this.tickCost.push(cost);
    if (this.tickCost.length > 300) this.tickCost.shift();
    profiler?.endFrame();
    if (cost >= 50) this.lostAt = ended; // a tick this long is a late server for every moving client
    if (cost >= this.slowTickMs) {
      const after = this.activity();
      this.recordSlowTick({
        tick,
        at: new Date().toISOString(),
        ms: r2(cost),
        phases: {
          roster: r2(tRoster - started),
          terrain: r2(tTerrain - tRoster),
          step: r2(tStep - tTerrain),
          snapshots: r2(tSnap - tStep),
          broadcast: r2(tBroadcast - tSnap),
          saves: r2(ended - tBroadcast),
        },
        activity: {
          cellsInline: after.inlineLoads - before.inlineLoads,
          cellsInlineMs: r2(after.inlineMs - before.inlineMs),
          cellsIntegrated: after.integrated - before.integrated,
          cellsIntegrateMs: r2(after.integrateMs - before.integrateMs),
          staticsBuilt: after.staticsBuilt - before.staticsBuilt,
          entities: after.entities - before.entities,
          paused: after.paused - before.paused,
        },
        ...(profiler ? { scopes: (profiler.lastSpike()?.scopes ?? []).slice(0, 8).map((s) => `${s.path} ${r2(s.selfMs)}`) } : {}),
      });
    }
  }

  // -- slow ticks ---------------------------------------------------------------------

  /** Ticks at or over this (ms) are kept whole in the slow-tick log (GameServerOptions.slowTickMs). */
  private readonly slowTickMs: number;
  private readonly slowTicks: SlowTick[] = [];
  private slowCounts = { over33: 0, over50: 0, over100: 0, ticks: 0 };
  /** Event-loop time between pumps not spent ticking (another callback held the thread). */
  private readonly stalls: Array<{ tick: number; at: string; ms: number }> = [];
  private stallCount = 0;
  private pumpEndedAt: number | null = null;

  private activity(): { inlineLoads: number; inlineMs: number; integrated: number; integrateMs: number; staticsBuilt: number; entities: number; paused: number } {
    const c = this.terrain?.counters;
    return {
      inlineLoads: c?.inlineLoads ?? 0,
      inlineMs: c?.inlineMs ?? 0,
      integrated: c?.integrated ?? 0,
      integrateMs: c?.integrateMs ?? 0,
      staticsBuilt: this.world.sim.stats().staticsBuiltTotal,
      entities: this.world.entities.size,
      paused: this.paused.size,
    };
  }

  private recordSlowTick(entry: SlowTick): void {
    if (entry.ms >= 33) this.slowCounts.over33++;
    if (entry.ms >= 50) this.slowCounts.over50++;
    if (entry.ms >= 100) this.slowCounts.over100++;
    this.slowTicks.push(entry);
    // keep the 60 worst, not the 60 latest: a long run's one 800 ms stall must survive a hundred 40 ms ones
    if (this.slowTicks.length > 60) {
      let smallest = 0;
      for (let i = 1; i < this.slowTicks.length; i++) if (this.slowTicks[i]!.ms < this.slowTicks[smallest]!.ms) smallest = i;
      this.slowTicks.splice(smallest, 1);
    }
  }

  /** The slow-tick log: counts since the last reset, the worst ticks with phases/activity/scopes, and loop stalls. */
  slowLog(reset = false): Record<string, unknown> {
    const out = {
      thresholdMs: this.slowTickMs,
      ...this.slowCounts,
      ticks: this.world.tick - this.slowCounts.ticks,
      worst: [...this.slowTicks].sort((a, b) => b.ms - a.ms),
      loopStalls: { count: this.stallCount, worst: [...this.stalls].sort((a, b) => b.ms - a.ms).slice(0, 20) },
    };
    if (reset) {
      this.slowTicks.length = 0;
      this.stalls.length = 0;
      this.stallCount = 0;
      this.slowCounts = { over33: 0, over50: 0, over100: 0, ticks: this.world.tick };
    }
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsub of this.unsubs.splice(0)) unsub();
    for (const peerId of [...this.players.keys()]) this.leave(peerId, "closing");
    this.host.close();
    if (this.driver) {
      this.world.beforeStep.delete(this.driver.step);
      this.world.afterPhysics.delete(this.driver.face);
    }
  }

  // -- roster --------------------------------------------------------------------

  private syncRoster(): void {
    const roster = new Map(this.host.peers().map((p) => [p.peerId, p.name]));
    for (const [peerId, w] of [...this.awaitingGround]) {
      if (this.closed) return;
      if (!roster.has(peerId) || this.players.has(peerId)) {
        this.awaitingGround.delete(peerId);
        this.joining.delete(peerId);
        continue;
      }
      this.join(peerId, w.name, w.identity, w.save);
    }
    for (const [peerId, name] of roster) {
      const existing = this.players.get(peerId);
      if (existing) {
        if (existing.disconnectedAt !== null) this.rejoin(existing, name);
        continue;
      }
      if (this.joining.has(peerId)) continue;
      if (!this.accepting) {
        this.kick(peerId, "server draining");
        continue;
      }
      const identity = this.identityOf?.(peerId);
      if (identity && this.persistence) {
        // the save has to exist before the body does: load first, spawn when it lands
        this.joining.add(peerId);
        this.persistence.load(identity, this.scene).then(
          (save) => {
            this.joining.delete(peerId);
            if (this.closed || this.players.has(peerId)) return;
            if (!this.host.peers().some((p) => p.peerId === peerId)) return; // left while loading
            this.join(peerId, identity.name || name, identity, save);
          },
          (error: unknown) => {
            this.joining.delete(peerId);
            console.warn(`[server] could not load the save for ${peerId}:`, error instanceof Error ? error.message : error);
            this.kick(peerId, "save unavailable");
          },
        );
        continue;
      }
      this.join(peerId, name, identity ?? null, null);
    }
    const tick = this.world.tick;
    for (const player of [...this.players.values()]) {
      if (roster.has(player.peerId)) {
        // told to go, still here: the destination has its save; do not keep two bodies forever
        if (player.transferring !== null && tick - player.transferring >= GameServer.TRANSFER_LINGER_TICKS) {
          this.kick(player.peerId, "transfer");
          this.leave(player.peerId, "transfer");
        }
        continue;
      }
      // link gone: hold the body for the grace window, then tear down —
      // unless the player was handed to another server, in which case the
      // bye IS the handoff completing and the body goes at once
      if (player.transferring !== null) {
        this.leave(player.peerId, "transfer");
      } else if (this.graceTicks <= 0 && !this.heldForLoot(player)) {
        this.leave(player.peerId, "leave");
      } else if (player.disconnectedAt === null) {
        player.disconnectedAt = tick;
        player.input = null; // stands still; nobody is steering it
        this.host.broadcastModule(WORLD_MODULE, { t: "presence", peerId: player.peerId, linked: false } satisfies WorldModuleMessage);
      } else if (tick - player.disconnectedAt >= this.graceTicks && !this.heldForLoot(player)) {
        // a body being looted (lootlock/) stays, sheet and all, until the looter's window ends: logging out saves nothing
        this.leave(player.peerId, "grace");
      }
    }
  }

  /**
   * This tick's netState changes out to the peers: shared keys to everyone,
   * an owner-only key (`define(…, { audience: "owner" })`) to the peer that
   * controls its owner body and to nobody else — not even its removal. A key
   * whose owner changes is removed from the old owner's replica.
   */
  private shipState(delta: NetStateDelta): void {
    const store = this.world.netState;
    const interest = this.stateInterest;
    if (!store.hasOwnerOnly && !interest) {
      this.host.broadcastState(delta);
      return;
    }
    const shared: NetStateDelta = { set: {}, removed: [] };
    const own = new Map<string, NetStateDelta>();
    const to = (peer: string): NetStateDelta => {
      let d = own.get(peer);
      if (!d) own.set(peer, (d = { set: {}, removed: [] }));
      return d;
    };
    for (const [key, value] of Object.entries(delta.set)) {
      const owner = store.hasOwnerOnly ? store.audienceOf(key, value) : undefined;
      if (owner === undefined) {
        const subject = interest ? this.entitySubject(key) : null;
        if (subject !== null) {
          for (const peer of this.entityAudience.get(subject) ?? NO_PEERS) to(peer).set[key] = value;
        } else shared.set[key] = value;
        continue;
      }
      const peer = owner ? this.peerOfBody(owner) : null;
      const before = this.ownerOnlySent.get(key);
      if (before && before !== peer) to(before).removed.push(key);
      if (peer) {
        to(peer).set[key] = value;
        this.ownerOnlySent.set(key, peer);
      } else this.ownerOnlySent.delete(key);
    }
    for (const key of delta.removed) {
      if (!store.hasOwnerOnly || store.audienceOf(key, undefined) === undefined) {
        const subject = interest ? this.entitySubject(key) : null;
        if (subject !== null) {
          for (const peer of this.entityAudience.get(subject) ?? NO_PEERS) to(peer).removed.push(key);
        } else shared.removed.push(key);
        continue;
      }
      const before = this.ownerOnlySent.get(key);
      if (before) to(before).removed.push(key);
      this.ownerOnlySent.delete(key);
    }
    // entities that came into (or went out of) what a peer is told about: their keys now, in the same message
    if (interest) this.flushInterestChanges(to);
    // one message per peer: its own keys merged with the shared ones; everyone else gets the shared packet
    for (const [peer, d] of own) {
      for (const [k, v] of Object.entries(shared.set)) if (!(k in d.set)) d.set[k] = v;
      d.removed.push(...shared.removed);
      this.host.sendStateDeltaTo(peer, d);
    }
    this.host.broadcastState(shared, own.size > 0 ? new Set(own.keys()) : undefined);
  }

  /**
   * Replicated events out. With stateInterest, an event that names replicated entities in its payload
   * (EVENT_SUBJECT_FIELDS: a caster, an actor, a target …) goes to the peers told about any of them; one that
   * names none goes to everyone. Each peer gets its events in one message, in order.
   */
  private shipEvents(events: Array<{ name: string; payload: unknown }>): void {
    if (!this.stateInterest) {
      this.host.broadcastEvents(events);
      return;
    }
    let routed = false;
    const audiences: Array<ReadonlySet<string> | null> = events.map((e) => {
      const payload = e.payload as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object") return null;
      let peers: Set<string> | null = null;
      for (const field of EVENT_SUBJECT_FIELDS) {
        const id = payload[field];
        if (typeof id !== "string" || this.entitySubject(`_/${id}`) === null) continue;
        peers ??= new Set();
        for (const peer of this.entityAudience.get(id) ?? NO_PEERS) peers.add(peer);
      }
      if (peers) routed = true;
      return peers;
    });
    if (!routed) {
      this.host.broadcastEvents(events);
      return;
    }
    for (const peer of this.players.keys()) {
      const mine = events.filter((_e, i) => audiences[i] === null || audiences[i]!.has(peer));
      if (mine.length > 0) this.host.sendEventsTo(peer, mine);
    }
  }

  /**
   * GameServerOptions.stateHz: a key whose field is throttled is shipped at most that many times a second —
   * the LATEST value, held back in between (a removal ships at once and drops what was held). The authority's
   * own reads and writes are untouched; only how often other screens are told changes.
   */
  private throttleState(delta: NetStateDelta | null): NetStateDelta | null {
    if (!this.stateHz) return delta;
    const tick = this.world.tick;
    let out = delta;
    if (out) {
      for (const [key, value] of Object.entries(out.set)) {
        const dot = key.lastIndexOf(".");
        const hz = dot >= 0 ? this.stateHz[key.slice(dot + 1)] : undefined;
        if (!hz) continue;
        const next = this.stateNextAt.get(key) ?? 0;
        if (tick >= next) {
          this.stateNextAt.set(key, tick + Math.max(1, Math.round(1 / (hz * this.world.fixedDt))));
          this.stateHeld.delete(key);
        } else {
          this.stateHeld.set(key, value);
          delete out.set[key];
        }
      }
      for (const key of out.removed) {
        this.stateHeld.delete(key);
        this.stateNextAt.delete(key);
      }
    }
    // held values whose time has come
    for (const [key, value] of this.stateHeld) {
      if (tick < (this.stateNextAt.get(key) ?? 0)) continue;
      out ??= { set: {}, removed: [] };
      out.set[key] = value;
      this.stateHeld.delete(key);
      const dot = key.lastIndexOf(".");
      this.stateNextAt.set(key, tick + Math.max(1, Math.round(1 / ((this.stateHz[key.slice(dot + 1)] ?? 60) * this.world.fixedDt))));
    }
    if (out && Object.keys(out.set).length === 0 && out.removed.length === 0) return null;
    return out;
  }
  private readonly stateHeld = new Map<string, unknown>();
  private readonly stateNextAt = new Map<string, number>();

  // -- netState by interest (GameServerOptions.stateInterest) ------------------------------

  /**
   * The replicated entity a key is about — `<ns>/<entityId>` or `<ns>/<entityId>.<field>` — or null for a key
   * about no replicated entity (global state, a party, a loot bag), which goes to everyone. Cached per key
   * until the replicated set changes.
   */
  private entitySubject(key: string): string | null {
    // an entity that replicates — asked of the entities, not of the last snapshot's replicas: a body that just
    // joined has state before its first snapshot, and that state is about it, not global
    this.refreshCandidates();
    if (this.subjectCacheVersion !== this.candidatesVersion) {
      this.subjectCache.clear();
      this.subjectCacheVersion = this.candidatesVersion;
    }
    const cached = this.subjectCache.get(key);
    if (cached !== undefined) return cached;
    const slash = key.indexOf("/");
    let subject: string | null = null;
    if (slash > 0) {
      const dot = key.indexOf(".", slash + 1);
      const id = key.slice(slash + 1, dot < 0 ? key.length : dot);
      subject = this.candidateSet.has(id) ? id : null;
    }
    this.subjectCache.set(key, subject);
    return subject;
  }
  private readonly subjectCache = new Map<string, string | null>();
  private subjectCacheVersion = -1;

  /**
   * Who is told about each entity (rebuilt every snapshot tick, from the views the snapshots just used): the
   * peers that can see it, its owner, and the owner's party (`comms.party/<peerId>`: a party frame shows a
   * mate's bars from across the zone). Diffed against what each peer was told about before: entities new to a
   * peer get their keys sent, entities gone get theirs removed (flushInterestChanges).
   */
  private updateEntityAudience(): void {
    this.entityAudience.clear();
    const add = (entity: string, peer: string): void => {
      const set = this.entityAudience.get(entity);
      if (set) set.add(peer);
      else this.entityAudience.set(entity, new Set([peer]));
    };
    const told = new Map<string, Set<string>>();
    for (const [peer, view] of this.peerViews) {
      const subjects = new Set(view);
      told.set(peer, subjects);
    }
    const parties = new Map<string, PlayerRecord[]>();
    for (const player of this.players.values()) {
      if (!told.has(player.peerId)) told.set(player.peerId, new Set());
      told.get(player.peerId)!.add(player.bodyId);
      const party = this.world.netState.get(`comms.party/${player.peerId}`);
      if (typeof party === "string" && party) {
        const list = parties.get(party);
        if (list) list.push(player);
        else parties.set(party, [player]);
      }
    }
    for (const members of parties.values()) {
      for (const a of members) for (const b of members) if (a !== b) told.get(a.peerId)!.add(b.bodyId);
    }
    for (const [peer, subjects] of told) {
      for (const entity of subjects) add(entity, peer);
      const before = this.peerSubjects.get(peer);
      if (before) {
        for (const entity of subjects) if (!before.has(entity)) this.queueInterest(peer, entity, true);
        for (const entity of before) if (!subjects.has(entity)) this.queueInterest(peer, entity, false);
      } else for (const entity of subjects) this.queueInterest(peer, entity, true);
      this.peerSubjects.set(peer, subjects);
    }
    for (const peer of [...this.peerSubjects.keys()]) if (!told.has(peer)) this.peerSubjects.delete(peer);
  }
  private readonly entityAudience = new Map<string, Set<string>>();
  /** Per peer: the entities it is told about now (view, own body, party mates). */
  private readonly peerSubjects = new Map<string, Set<string>>();
  /** Per peer: entities to catch it up on (true) or to forget (false), sent with the next state message. */
  private readonly interestQueue = new Map<string, Map<string, boolean>>();

  private queueInterest(peer: string, entity: string, enter: boolean): void {
    let q = this.interestQueue.get(peer);
    if (!q) this.interestQueue.set(peer, (q = new Map()));
    q.set(entity, enter);
  }

  /** Catch-up keys for entities a peer is newly told about, removals for ones it no longer is. */
  private flushInterestChanges(to: (peer: string) => NetStateDelta): void {
    if (this.interestQueue.size === 0) return;
    const store = this.world.netState;
    // every entity key, by subject, read once
    const bySubject = new Map<string, string[]>();
    for (const key of store.keys()) {
      const subject = this.entitySubject(key);
      if (subject === null) continue;
      if (store.hasOwnerOnly && store.audienceOf(key, store.get(key)) !== undefined) continue; // owner-only keys route themselves
      const list = bySubject.get(subject);
      if (list) list.push(key);
      else bySubject.set(subject, [key]);
    }
    for (const [peer, q] of this.interestQueue) {
      if (!this.peerSubjects.has(peer)) continue;
      const d = to(peer);
      for (const [entity, enter] of q) {
        for (const key of bySubject.get(entity) ?? []) {
          if (enter) {
            if (!(key in d.set)) d.set[key] = store.get(key);
          } else if (!(key in d.set)) d.removed.push(key);
        }
      }
    }
    this.interestQueue.clear();
  }

  /** The full netState as `peerId` may see it (a joiner's sync): owner-only keys of other owners left out. */
  private stateFor(peerId: string): Record<string, unknown> {
    const store = this.world.netState;
    const all = store.snapshot();
    if (this.stateInterest) {
      // entity keys: its own body only, until entities enter what it is told about (updateEntityAudience)
      const body = this.players.get(peerId)?.bodyId;
      this.peerSubjects.set(peerId, new Set(body ? [body] : []));
      // ...and its own body's changes reach it from now on, not from the next audience pass: a key written in
      // between (a sheet restored from storage a moment after the join, the bar derived from it) is never
      // written again if it does not change, and would never arrive
      if (body) {
        const audience = this.entityAudience.get(body);
        if (audience) audience.add(peerId);
        else this.entityAudience.set(body, new Set([peerId]));
      }
      this.interestQueue.delete(peerId);
      for (const key of Object.keys(all)) {
        const subject = this.entitySubject(key);
        if (subject !== null && subject !== body) delete all[key];
      }
    }
    if (!store.hasOwnerOnly) return all;
    for (const [key, value] of Object.entries(all)) {
      const owner = store.audienceOf(key, value);
      if (owner === undefined) continue;
      if (owner && this.peerOfBody(owner) === peerId) this.ownerOnlySent.set(key, peerId);
      else delete all[key];
    }
    return all;
  }

  /** Whether a disconnected player's body must stay: it is being looted (core `lootlock/<bodyId>`). */
  private heldForLoot(player: PlayerRecord): boolean {
    return !!player.bodyId && isLootLocked(this.world.netState, player.bodyId, this.world.timeMs);
  }

  /** The peer controlling a body (`owner/<bodyId>`, written at join), or null. */
  private peerOfBody(bodyId: string): string | null {
    const peer = this.world.netState.get(`owner/${bodyId}`);
    return typeof peer === "string" ? peer : null;
  }

  /** Drop a socket (the transport is a WebSocket host in production; a loopback hub in tests may not support it). */
  private kick(peerId: string, reason: string): void {
    const t = this.transport as { disconnect?: (peer: string, reason?: string) => void };
    t.disconnect?.(peerId, reason);
  }

  /**
   * End a player's session now (a moderation ban): drop the socket and take
   * the body out at once — saved like any leave, no reconnect grace.
   * Returns false when the player is not here.
   */
  expel(peerId: string, reason: string): boolean {
    this.kick(peerId, reason);
    if (!this.players.has(peerId)) return false;
    this.leave(peerId, "kicked");
    return true;
  }

  /** Same peer id back inside the grace window: hand the body back, resend the world. */
  private rejoin(player: PlayerRecord, name: string): void {
    player.disconnectedAt = null;
    player.name = name;
    this.peerViews.delete(player.peerId);
    this.peerSent.delete(player.peerId);
    this.host.sendStateTo(player.peerId, this.stateFor(player.peerId));
    const entities: Record<string, EntityDoc> = {};
    for (const [id, doc] of this.runtimeDocs) entities[id] = doc;
    this.host.sendModule(player.peerId, WORLD_MODULE, {
      t: "spawn",
      entities,
      ...(player.bodyId ? { self: player.bodyId } : {}),
    } satisfies WorldModuleMessage);
    this.host.broadcastModule(WORLD_MODULE, { t: "presence", peerId: player.peerId, linked: true } satisfies WorldModuleMessage, player.peerId);
  }

  /** Joiners whose landing cells are still being generated (see join), and the tick they started waiting. */
  private readonly awaitingGround = new Map<string, { name: string; identity: PlayerIdentity | null; save: PlayerSave | null; since: number }>();
  /** Ticks a joiner waits for its ground from the workers before it is generated inline anyway (3 s at 60 Hz). */
  private static readonly JOIN_GROUND_WAIT_TICKS = 180;

  private join(peerId: string, name: string, identity: PlayerIdentity | null, save: PlayerSave | null): void {
    // a portal arrival for this scene wins (the anchor it named, or the way
    // back); then the saved position (where it logged out); then the spawn point
    const arrival = arrivalFor(this.world, this.scene, save, () => this.spawnPoint(peerId));
    const at = arrival.at;
    // the landing cells come from the generation workers, not this tick: wait for them (a fresh area costs a
    // cell ~60 ms of generation + marching here), then spawn — past the wait, inline as before
    if (this.template && this.terrain) {
      const since = this.awaitingGround.get(peerId)?.since ?? this.world.tick;
      const ready = this.terrain.prefetch(at[0], at[2], this.terrain.resolved.streamer.cellSize);
      if (!ready && this.world.tick - since < GameServer.JOIN_GROUND_WAIT_TICKS) {
        this.awaitingGround.set(peerId, { name, identity, save, since });
        this.joining.add(peerId);
        return;
      }
      this.awaitingGround.delete(peerId);
      this.joining.delete(peerId);
    }
    const yaw = arrival.yaw;
    let ids: string[] = [];
    let bodyId = "";
    if (this.template) {
      // the ground has to exist before the body lands on it
      this.terrain?.ensureAround(at[0], at[2], 1);
      const spawned = instantiatePlayer(this.template, peerId, at, yaw);
      bodyId = spawned.bodyId;
      ids = Object.keys(spawned.server);
      // the saved sheet, quests, NPC memory, the vault, the portal trip and
      // the creation build go into netState BEFORE the scripts that own them
      // start, so they find them and keep them (a saved sheet ignores the build)
      seedPlayerState(this.world, bodyId, save?.sheet, arrival.records, identity?.build, peerId, this.scene);
      this.world.addEntities({ ...this.world.base, entities: spawned.server });
      for (const [id, doc] of Object.entries(spawned.client)) this.runtimeDocs.set(id, doc);
      this.world.netState.set(`owner/${bodyId}`, peerId);
      this.world.netState.set(`player/${peerId}`, bodyId);
      this.world.netState.set(`name/${bodyId}`, name); // what a party frame or a nameplate shows
      // landing grace: brains leave a body that just logged in / arrived alone for a few seconds
      if (this.landingSeconds > 0) this.world.netState.set(`landing/${bodyId}`, this.world.timeMs + this.landingSeconds * 1000);
      // everyone else learns the newcomer's body; the newcomer gets the whole runtime set below
      this.host.broadcastModule(WORLD_MODULE, { t: "spawn", entities: spawned.client } satisfies WorldModuleMessage, peerId);
    }
    const record: PlayerRecord = {
      peerId,
      name,
      bodyId,
      ids,
      input: null,
      appliedSeq: 0,
      disconnectedAt: null,
      identity,
      rev: { ...(save?.rev ?? {}) },
      commitPhase: Math.floor(Math.random() * 600),
      committing: null,
      transferring: null,
    };
    this.players.set(peerId, record);
    this.world.eventBus.emit("player.joined", { peerId, name });
    this.onPlayerJoined?.(record);
    // joiner sync, in this order on the reliable channel: state, then docs
    this.host.sendStateTo(peerId, this.stateFor(peerId));
    const entities: Record<string, EntityDoc> = {};
    for (const [id, doc] of this.runtimeDocs) entities[id] = doc;
    this.host.sendModule(peerId, WORLD_MODULE, {
      t: "spawn",
      entities,
      ...(bodyId ? { self: bodyId } : {}),
    } satisfies WorldModuleMessage);
  }

  private leave(peerId: string, reason: LeaveReason): void {
    const player = this.players.get(peerId);
    if (!player) return;
    // a transferred player was committed before the handoff; everyone else
    // saves now — and a save that cannot land (main down) is kept and retried
    if (reason !== "transfer" && reason !== "logout" && player.identity && this.persistence) {
      const identity = player.identity;
      const input = this.snapshotFor(player);
      const inFlight = player.committing;
      void (inFlight ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => this.persistence!.commit(identity, input))
        .catch((error: unknown) => {
          console.warn(`[server] final save for ${peerId} failed — queued for retry:`, error instanceof Error ? error.message : error);
          this.pendingSaves.push({ identity, input, attempts: 1 });
        });
    }
    this.camps.delete(peerId);
    this.players.delete(peerId);
    this.peerViews.delete(peerId);
    this.peerSent.delete(peerId);
    this.peerSubjects.delete(peerId);
    this.interestQueue.delete(peerId);
    this.phases.delete(peerId);
    if (player.ids.length > 0) {
      this.world.removeEntities(player.ids, { silent: true });
      for (const id of player.ids) this.runtimeDocs.delete(id);
      clearPlayerState(this.world, player.bodyId, peerId, { keepBags: !(player.identity && this.persistence) });
      this.host.broadcastModule(WORLD_MODULE, { t: "despawn", ids: player.ids } satisfies WorldModuleMessage);
    }
    this.world.eventBus.emit("player.left", { peerId });
    this.onPlayerLeft?.(player, reason);
  }

  // -- persistence + transfer ------------------------------------------------------

  /** What the save authority stores: the sheet the scripts maintain, and where the body stands. */
  private snapshotFor(player: PlayerRecord): CommitInput {
    return playerSnapshot(this.world, player.bodyId, this.scene);
  }

  /**
   * Save one player now. Coalesces: a commit already in flight is returned
   * rather than started twice. Resolves with the revisions written (the
   * ticket for a transfer binds the destination to these). No-op for
   * anonymous peers or without a persistence hook.
   */
  commit(peerId: string): Promise<Record<string, number>> {
    const player = this.players.get(peerId);
    if (!player || !player.identity || !this.persistence) return Promise.resolve({});
    if (player.committing) return player.committing;
    const input = this.snapshotFor(player); // captured synchronously: the body may be gone by the time the write lands
    const identity = player.identity;
    player.committing = this.persistence
      .commit(identity, input)
      .then((rev) => {
        player.rev = { ...player.rev, ...rev };
        return player.rev;
      })
      .finally(() => {
        player.committing = null;
      });
    return player.committing;
  }

  /**
   * May this player be moved right now? Never while dead or already going;
   * then whatever the scene's gate says (combat, an active spawn area in
   * view — the layer wires that in).
   */
  canTransfer(peerId: string): boolean {
    const player = this.players.get(peerId);
    if (!player || player.disconnectedAt !== null || player.transferring !== null) return false;
    if (this.world.netState.get(`combat/${player.bodyId}.dead`) === true) return false;
    // in combat: an authoritative combat script holds the body here for a while after every hit
    if (isTransferLocked(this.world.netState, player.bodyId, this.world.timeMs)) return false;
    // being looted: the looter's window holds the body here
    if (isLootLocked(this.world.netState, player.bodyId, this.world.timeMs)) return false;
    return this.transferGate ? this.transferGate(peerId) : true;
  }

  /**
   * Hand the client to another server. The caller has committed and holds a
   * ticket for the destination; this sends the instruction and marks the
   * body so its bye tears it down immediately (no grace) without a second
   * save. Returns false if the player is not here.
   */
  handoff(peerId: string, to: { url: string; ticket: string; reason: string; srv?: string; scene?: string }): boolean {
    const player = this.players.get(peerId);
    if (!player || player.disconnectedAt !== null) return false;
    player.transferring = this.world.tick;
    player.input = null;
    this.host.sendModule(peerId, WORLD_MODULE, { t: "transfer", url: to.url, ticket: to.ticket, reason: to.reason, ...(to.srv ? { srv: to.srv } : {}), ...(to.scene ? { scene: to.scene } : {}) } satisfies WorldModuleMessage);
    return true;
  }

  /**
   * Saves that failed at leave (main unreachable) wait here and are retried
   * every few seconds until they land — a player logging out during a main
   * outage must not lose their session. Bounded; the oldest is dropped past
   * the cap with a warning, which is the one data-loss path and it is loud.
   */
  private readonly pendingSaves: Array<{ identity: PlayerIdentity; input: CommitInput; attempts: number }> = [];
  private static readonly PENDING_SAVES_MAX = 500;

  private retryPendingSaves(): void {
    if (!this.persistence || this.pendingSaves.length === 0) return;
    const batch = this.pendingSaves.splice(0, 20);
    for (const entry of batch) {
      this.persistence.commit(entry.identity, entry.input).catch((error: unknown) => {
        entry.attempts++;
        if (entry.attempts % 10 === 1) {
          console.warn(`[server] save for ${entry.identity.characterId} still failing (${entry.attempts}×): ${error instanceof Error ? error.message : String(error)}`);
        }
        this.pendingSaves.push(entry);
        if (this.pendingSaves.length > GameServer.PENDING_SAVES_MAX) {
          const dropped = this.pendingSaves.shift()!;
          console.warn(`[server] DROPPED a pending save for ${dropped.identity.characterId} — persistence has been down too long`);
        }
      });
    }
  }

  /** Saves waiting for persistence to come back (diagnostics). */
  get pendingSaveCount(): number {
    return this.pendingSaves.length;
  }

  // -- intentional logout -----------------------------------------------------------

  private readonly camps = new Map<string, { at: [number, number, number]; endsAt: number; remaining: number; saving: boolean }>();

  private campBlock(player: PlayerRecord): string | null {
    if (player.disconnectedAt !== null || player.transferring !== null) return "Camp cancelled: your connection or location changed.";
    if (isLootLocked(this.world.netState, player.bodyId, this.world.timeMs)) return "You cannot camp while your body is being looted.";
    if (isTransferLocked(this.world.netState, player.bodyId, this.world.timeMs)) return "Camp cancelled by combat.";
    if (this.world.netState.get(`combat/${player.bodyId}.dead`) === true) return "You cannot camp while downed.";
    return null;
  }

  private sendCamp(peer: string, remaining: number | null, reason?: string): void {
    this.host.sendModule(peer, WORLD_MODULE, { t: "camp", remaining, ...(reason ? { reason } : {}) } satisfies WorldModuleMessage);
  }

  private cancelCamp(peer: string, reason: string): void {
    if (!this.camps.delete(peer)) return;
    this.sendCamp(peer, null, reason);
  }

  private startCamp(peer: string): void {
    const player = this.players.get(peer);
    if (!player || this.camps.has(peer)) return;
    const block = this.campBlock(player);
    const at = this.world.positionOf(player.bodyId);
    if (block || !at) return this.sendCamp(peer, null, block ?? "Your character has not arrived yet.");
    if (player.input && (Math.hypot(...player.input.v) > 0.01 || player.input.jump || Math.abs(player.input.vy) > 0.01)) return this.sendCamp(peer, null, "Stand still to make camp.");
    // Requests drain during scripts, before HeadlessWorld advances its clock at the end of this step.
    this.camps.set(peer, { at: [...at], endsAt: this.world.timeMs + this.world.fixedDt * 1000 + CAMP_SECONDS * 1000, remaining: CAMP_SECONDS, saving: false });
    this.sendCamp(peer, CAMP_SECONDS);
  }

  private updateCamps(): void {
    for (const [peer, camp] of this.camps) {
      const player = this.players.get(peer);
      if (!player) { this.camps.delete(peer); continue; }
      const block = this.campBlock(player);
      const at = this.world.positionOf(player.bodyId);
      if (block || !at || Math.hypot(at[0] - camp.at[0], at[2] - camp.at[2]) > 0.25) {
        this.cancelCamp(peer, block ?? "Camp cancelled by movement.");
        continue;
      }
      if (camp.saving) continue;
      const remaining = Math.max(0, Math.ceil((camp.endsAt - this.world.timeMs) / 1000));
      if (remaining !== camp.remaining) { camp.remaining = remaining; this.sendCamp(peer, remaining); }
      if (remaining > 0) continue;
      camp.saving = true;
      // Finish an older periodic write, then capture a fresh save. Never acknowledge an older in-flight snapshot.
      void (async () => {
        try {
          if (player.committing) await player.committing;
          if (this.closed || this.camps.get(peer) !== camp || this.players.get(peer) !== player) return;
          await this.commit(peer);
          if (this.closed || this.camps.get(peer) !== camp || this.players.get(peer) !== player) return;
          const blocked = this.campBlock(player);
          if (blocked) return this.cancelCamp(peer, blocked);
          this.host.sendModule(peer, WORLD_MODULE, { t: "logout" } satisfies WorldModuleMessage);
          this.host.removePeer(peer); // prevents a still-connected transport from re-spawning the body next tick
          this.leave(peer, "logout"); // the confirmed save already landed
          this.kick(peer, "logout");
        } catch (error) {
          if (this.closed || this.camps.get(peer) !== camp) return;
          console.warn(`[server] camp save for ${peer} failed:`, error);
          this.cancelCamp(peer, "Your character could not be saved. You are still connected; try again.");
        }
      })();
    }
  }

  // -- commands --------------------------------------------------------------------

  private onCommand(peer: string, input: unknown): void {
    const player = this.players.get(peer);
    if (!player || player.disconnectedAt !== null || player.transferring !== null) return;
    const cmd = input as { t?: unknown } | null;
    if (cmd?.t === "event") {
      const e = cmd as { name?: unknown; payload?: unknown };
      if (typeof e.name === "string") {
        if (e.name !== PLAYER_LOGOUT_EVENT) this.cancelCamp(peer, "Camp cancelled by an action.");
        this.world.eventBus.injectFromPeer(peer, [{ name: e.name, payload: e.payload }]);
      }
      return;
    }
    if (cmd?.t !== "input") return;
    const c = cmd as RemoteInputCommand;
    if (!isFiniteVec(c.v, 2)) return;
    if (Math.hypot(c.v[0]!, c.v[1]!) > 0.01 || c.jump === true || (typeof c.vy === "number" && Math.abs(c.vy) > 0.01)) this.cancelCamp(peer, "Camp cancelled by movement.");
    if (isFiniteVec(c.p, 3)) this.measureDivergence(player, c.p as [number, number, number], c.v as [number, number]);
    player.input = {
      v: [c.v[0]!, c.v[1]!],
      jump: c.jump === true,
      // A vertical SPEED in m/s while swimming (where the swimmer is pointed
      // times how fast it swims, plus its rise/dive keys). Clamped like every
      // other claimed number — intent, never state — and the driver clamps it
      // again against that body's own swim speed.
      vy: typeof c.vy === "number" && Number.isFinite(c.vy) ? Math.max(-VERTICAL_CAP, Math.min(VERTICAL_CAP, c.vy)) : 0,
      yaw: typeof c.yaw === "number" && Number.isFinite(c.yaw) ? c.yaw : 0,
      seq: typeof c.seq === "number" && Number.isFinite(c.seq) ? c.seq : 0,
      at: Date.now(),
      ...(typeof c.ct === "number" && Number.isFinite(c.ct) ? { t: c.ct } : {}),
    };
  }

  // -- divergence (rubber banding, measured where it is decided) -------------------

  /**
   * Every input carries where the client's prediction had the body when it sent it (`p`, never trusted). The
   * body here, when that input arrives, has run the same previous input for about as long — so the gap between
   * the two is the correction that client's reconciliation is about to make. Counted per player, with the
   * likeliest reason: the server fell behind wall-clock (`late`), a movement skill / stagger / launch owned
   * the body (`skill`), the gap is mostly vertical (`vertical`: ground or a collider one side has and the other
   * has not), the body here was held back while the client asked to move (`blocked`: a collider here), else
   * `speed` (the two integrated the same input differently).
   */
  private measureDivergence(player: PlayerRecord, claimed: [number, number, number], v: [number, number]): void {
    const at = this.world.positionOf(player.bodyId);
    if (!at || player.disconnectedAt !== null || player.transferring !== null) return;
    const now = performance.now();
    const d = (player.divergence ??= { samples: 0, over05: 0, nudges: 0, snaps: 0, maxM: 0, reasons: {}, lastAt: null, lastPos: null });
    const dx = claimed[0] - at[0];
    const dy = claimed[1] - at[1];
    const dz = claimed[2] - at[2];
    const flat = Math.hypot(dx, dz);
    const err = Math.hypot(flat, dy);
    // how fast the body here actually went since the previous input, against what was asked
    const moved = d.lastPos && d.lastAt !== null && now > d.lastAt ? Math.hypot(at[0] - d.lastPos[0], at[2] - d.lastPos[2]) / ((now - d.lastAt) / 1000) : null;
    d.lastAt = now;
    d.lastPos = [at[0], at[1], at[2]];
    d.samples++;
    this.divergenceTotals.samples++;
    if (err <= 0.5) return;
    d.over05++;
    this.divergenceTotals.over05++;
    if (err > NUDGE_DIST) {
      d.nudges++;
      this.divergenceTotals.nudges++;
    }
    if (err > SNAP_DIST) {
      d.snaps++;
      this.divergenceTotals.snaps++;
    }
    d.maxM = Math.max(d.maxM, r2(err));
    this.divergenceTotals.maxM = Math.max(this.divergenceTotals.maxM, r2(err));
    const ud = (this.world.objects.get(player.bodyId)?.userData ?? {}) as { impulseUntil?: number; liftUntil?: number; frozen?: boolean };
    const simNow = this.world.timeMs / 1000;
    const asked = Math.hypot(v[0], v[1]);
    const reason =
      now - this.lostAt < 1000
        ? "late"
        : ud.frozen || (ud.impulseUntil ?? -1) > simNow - 0.5 || (ud.liftUntil ?? -1) > simNow - 0.5
          ? "skill"
          : Math.abs(dy) > flat
            ? "vertical"
            : moved !== null && asked > 1 && moved < asked * 0.5
              ? "blocked"
              : "speed";
    d.reasons[reason] = (d.reasons[reason] ?? 0) + 1;
    this.divergenceTotals.reasons[reason] = (this.divergenceTotals.reasons[reason] ?? 0) + 1;
  }

  /** Every player's divergences since the server started (see measureDivergence). */
  private readonly divergenceTotals: { samples: number; over05: number; nudges: number; snaps: number; maxM: number; reasons: Record<string, number> } = {
    samples: 0,
    over05: 0,
    nudges: 0,
    snaps: 0,
    maxM: 0,
    reasons: {},
  };

  // -- runtime spawns (NPCs and anything else an admin or the DM adds) -------------

  /**
   * Add runtime entities from EXPANDED docs and tell every client to build
   * them. `clientDocs` overrides what clients receive (defaults to the same
   * docs).
   */
  spawn(entities: Record<string, EntityDoc>, clientDocs?: Record<string, EntityDoc>): void {
    this.world.addEntities({ ...this.world.base, entities });
    const docs = clientDocs ?? entities;
    for (const [id, doc] of Object.entries(docs)) this.runtimeDocs.set(id, doc);
    this.host.broadcastModule(WORLD_MODULE, { t: "spawn", entities: docs } satisfies WorldModuleMessage);
  }

  /**
   * Pause a root entity's subtree IN PLACE: scripts suspended, bodies out of the physics world, the objects
   * (and their positions) kept, so a client still holding the docs sees nothing change. A paused root is not
   * a terrain focus — the ground under it may unload. Returns false when absent or already paused.
   */
  pauseRoot(rootId: string): boolean {
    const world = this.world;
    if (!world.entities.has(rootId) || this.paused.has(rootId)) return false;
    const ids = world.subtree(rootId);
    world.scripts.suspendEntities(ids);
    world.sim.removeEntities(ids);
    // a paused body stays in sight (a sleeping pack is still inside the interest radius), so it stands in its
    // controller's idle — with no clip the client kept whatever ran last and a pack froze mid-stride
    const script = world.entities.get(rootId)?.components["script"] as { params?: { idleClip?: unknown } } | undefined;
    if (script) world.anims.set(rootId, typeof script.params?.idleClip === "string" ? script.params.idleClip : "Idle");
    else world.anims.delete(rootId);
    world.animLayers.delete(rootId);
    world.animRates.delete(rootId);
    world.freeze(rootId);
    this.paused.add(rootId);
    return true;
  }

  /** Resume a paused root where it stands: ground ensured, bodies back in the sim, scripts restarted. */
  resumeRoot(rootId: string): boolean {
    const world = this.world;
    if (!this.paused.has(rootId)) return false;
    this.paused.delete(rootId);
    if (!world.entities.has(rootId)) return false;
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
    if (p) this.terrain?.ensureAround(p[0], p[2], 1);
    world.markLive(rootId);
    world.sim.addEntities({ ...world.base, entities: docs });
    world.scripts.resumeEntities(ids);
    return true;
  }

  /** Remove runtime entities everywhere. */
  despawn(ids: string[]): void {
    const present = ids.filter((id) => this.world.entities.has(id));
    if (present.length === 0) return;
    this.world.removeEntities(present);
    for (const id of present) this.runtimeDocs.delete(id);
    this.host.broadcastModule(WORLD_MODULE, { t: "despawn", ids: present } satisfies WorldModuleMessage);
  }

  // -- terraform ------------------------------------------------------------------------

  /**
   * Edit the world. The batch is validated and applied atomically to the
   * recipe (`applyRecipeEdits`), touched resident cells re-cook, every
   * client receives the new recipe over the `world` module and re-streams,
   * and the recipe is handed to `onRecipeChanged` to persist. Returns the
   * inverse batch — POST it back to undo. Throws with no change on an
   * invalid edit or when the scene has no voxel world.
   */
  terraform(edits: readonly RecipeEdit[]): { inverse: RecipeEdit[]; added: string[]; touchedCells: [number, number][]; reloaded: string[] } {
    if (!this.terrain) throw new Error("this scene has no voxel world to terraform");
    const { result, reloaded, touchedCells } = this.terrain.applyEdits(edits);
    const id = this.terrain.resolved.data.world;
    this.host.broadcastModule(WORLD_MODULE, { t: "recipe", id, recipe: result.recipe } satisfies WorldModuleMessage);
    this.onRecipeChanged?.(id, result.recipe);
    return { inverse: result.inverse, added: result.added, touchedCells, reloaded };
  }

  // -- replication --------------------------------------------------------------------

  /**
   * Which entities replicate: `netObject`, or the implicit script+rigidbody
   * default. Each entity keeps its state object while nothing in it changes;
   * a change makes a new one with the next `ver`, which is how a snapshot knows
   * what a peer has not seen yet (buildStateFor).
   */
  private collectReplicas(): void {
    const replicas: ReplicaEntry[] = [];
    const simSeconds = this.world.timeMs / 1000;
    const previous = this.replicaState;
    const state = new Map<string, ReplicaState>();
    let setChanged = false;
    // which entities replicate changes only when entities come and go: a streamed world is thousands of
    // terrain props, and asking each of them every snapshot was most of this pass
    this.refreshCandidates();
    const bodies = new Set<string>();
    for (const player of this.players.values()) bodies.add(player.bodyId);
    const interest = this.interestRadius;
    this.grid.clear();
    this.gridWide.length = 0;
    for (const id of this.candidates) {
      const e = this.world.entities.get(id);
      if (!e) continue;
      const netObj = e.components["netObject"] as NetObjectData | undefined;
      const p = this.world.positionOf(id);
      const q = this.world.quaternionOf(id);
      if (!p || !q) continue;
      const syncAnim = netObj?.sync.animation ?? true;
      const anim = syncAnim ? this.world.anims.get(id) : undefined;
      const animL = syncAnim ? this.world.animLayers.get(id) : undefined;
      const animR = syncAnim ? this.world.animRates.get(id) : undefined;
      // Seconds left of a one-shot action (a cast, a swing). The client fits
      // the clip to it — only the client knows how long the clip is — so a
      // long cast plays once, slowly, there as well.
      const ud = this.world.objects.get(id)?.userData as
        | { actionUntil?: number; actionHold?: boolean; actionLoop?: boolean }
        | undefined;
      const until = ud?.actionUntil;
      // a held guard or a channel loop must not replay as a fitted one-shot
      const animM = animL ? (ud?.actionLoop ? "loop" : ud?.actionHold ? "hold" : undefined) : undefined;
      const animD =
        syncAnim && typeof until === "number" && until > simSeconds
          ? r3(until - simSeconds)
          : undefined;
      // interest (GameServerOptions.interestRadius): implicit replicas and player bodies are seen within the
      // radius; a scene that declared its own netObject relevancy keeps it
      const byInterest = interest > 0 && (!netObj || bodies.has(id));
      const entry: ReplicaEntry = {
        id,
        p,
        relevancy: byInterest ? "proximity" : (netObj?.relevancy ?? "always"),
        // a body bigger than a person is seen further (sight.ts): a giant must be seen coming
        radius: byInterest ? (bodies.has(id) ? interest : this.sightOf(id, e)) : (netObj?.radius ?? 50),
        sendEvery: netObj?.sendEvery ?? 1,
      };
      replicas.push(entry);
      if (entry.relevancy === "always" || entry.radius > this.gridCell) this.gridWide.push(entry);
      else {
        const key = gridKey(Math.floor(p[0] / this.gridCell), Math.floor(p[2] / this.gridCell));
        const cell = this.grid.get(key);
        if (cell) cell.push(entry);
        else this.grid.set(key, [entry]);
      }
      const next: ReplicaState = {
        p: [r3(p[0]), r3(p[1]), r3(p[2])],
        q: [r3(q[0]), r3(q[1]), r3(q[2]), r3(q[3])],
        ...(anim ? { anim } : {}),
        ...(animL ? { animL } : {}),
        ...(animR !== undefined && animR !== 1 ? { animR: r3(animR) } : {}),
        ...(animD !== undefined ? { animD } : {}),
        ...(animM ? { animM } : {}),
        syncTransform: netObj?.sync.transform ?? true,
        ver: 0,
      };
      const prev = previous.get(id);
      if (!prev) setChanged = true;
      if (prev && sameReplicaState(prev, next)) state.set(id, prev);
      else {
        next.ver = (prev?.ver ?? 0) + 1;
        state.set(id, next);
      }
    }
    if (setChanged || state.size !== previous.size) this.replicaSetVersion++;
    this.replicas = replicas;
    this.replicaState = state;
  }

  /** The players map, built once per snapshot tick and filtered per peer. */
  private playersThisTick(): ReturnType<GameServer["buildPlayers"]> {
    const tick = this.gathered?.tick ?? this.world.tick;
    if (this.playersCache?.tick !== tick) this.playersCache = { tick, players: this.buildPlayers() };
    return this.playersCache.players;
  }
  /** The last replica gather (tick, sim ms): every snapshot until the next describes it. */
  private gathered: { tick: number; simMs: number } | null = null;
  /** Which tick of the snapshot interval a peer's snapshot goes on (spread round-robin as peers arrive). */
  private readonly phases = new Map<string, number>();
  private nextPhase = 0;
  private snapshotPhase(peerId: string): number {
    let phase = this.phases.get(peerId);
    if (phase === undefined) this.phases.set(peerId, (phase = this.nextPhase++ % this.snapshotEvery));
    return phase;
  }
  private playersCache: { tick: number; players: ReturnType<GameServer["buildPlayers"]> } | null = null;

  private buildPlayers(): Record<string, { position: [number, number, number]; yaw: number; name: string; seq: number; sa: number }> {
    const out: Record<string, { position: [number, number, number]; yaw: number; name: string; seq: number; sa: number }> = {};
    for (const player of this.players.values()) {
      const p = this.world.positionOf(player.bodyId);
      if (!p) continue;
      const object = this.world.objects.get(player.bodyId);
      // players are keyed by peer id for reconciliation; a body in grace has no
      // peer to reconcile, but its ENTITY still replicates like any other
      out[player.peerId] = {
        position: [r3(p[0]), r3(p[1]), r3(p[2])],
        yaw: object ? object.rotation.y : 0,
        name: player.name,
        seq: player.appliedSeq,
        // how long (sim ms) that input has been driving the body: the client compares this position with where it
        // predicted itself the same time after SENDING that input, which takes the round trip out of the comparison
        sa: player.appliedAt === undefined ? 0 : Math.round((this.world.tick - player.appliedAt) * this.world.fixedDt * 1000),
      };
    }
    return out;
  }

  /**
   * One peer's snapshot — see net-presence.ts `buildStateFor` for the shape.
   *
   * Only what this peer has not seen goes out: an entity is sent when it
   * entered the view, when its state changed since the last one sent to this
   * peer (`ver`), once more right after it stopped changing, and every
   * REFRESH_SECONDS anyway, which covers a snapshot the socket dropped. An entity that changes again after being left out is
   * marked `h: 1`, so the client holds it still up to its previous snapshot
   * instead of drifting across the gap. `managed` (the set the client
   * suspends) goes when it changed, and every MANAGED_REFRESH_SECONDS.
   */
  buildStateFor(peerId?: string): unknown {
    // simMs: the authority's script clock, so a client's runtime reads the
    // deadlines this world stamps (staggers, casts, guards) on the same clock
    const allPlayers = this.playersThisTick();
    const state: Record<string, unknown> = { players: allPlayers, simMs: this.gathered?.simMs ?? this.world.timeMs };
    if (!peerId) return state;
    const player = this.players.get(peerId);
    const own = new Set(player?.ids ?? []);
    const center = player ? this.world.positionOf(player.bodyId) : null;
    const prev = this.peerViews.get(peerId) ?? new Set<string>();
    // only what can be near: the wide/always entries plus the 3 x 3 grid cells around this peer — the work per
    // peer follows how crowded its surroundings are, not how many entities the whole layer holds
    const visible: ReplicaEntry[] = [];
    for (const r of this.gridWide) if (!own.has(r.id)) visible.push(r);
    if (center) {
      const gx = Math.floor(center[0] / this.gridCell);
      const gz = Math.floor(center[2] / this.gridCell);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell = this.grid.get(gridKey(gx + dx, gz + dz));
          if (cell) for (const r of cell) if (!own.has(r.id)) visible.push(r);
        }
      }
    }
    const { view, entered, left } = computeView(center, visible, prev);
    if (this.interestRadius > 0) {
      // the players map too: ourselves (reconciliation) and the players whose bodies we can see
      const players: typeof allPlayers = {};
      for (const [id, entry] of Object.entries(allPlayers)) {
        const body = this.players.get(id)?.bodyId;
        if (id === peerId || (body && view.has(body))) players[id] = entry;
      }
      state["players"] = players;
    }
    this.peerViews.set(peerId, view);
    const tick = this.world.tick;
    let sent = this.peerSent.get(peerId);
    if (!sent) {
      sent = { entities: new Map(), managedKey: "", managedAt: 0 };
      this.peerSent.set(peerId, sent);
    }
    for (const id of left) sent.entities.delete(id);
    const enteredSet = new Set(entered);
    const refresh = Math.max(1, Math.round(GameServer.REFRESH_SECONDS / this.world.fixedDt));
    const updates: Record<string, unknown> = {};
    for (const r of visible) {
      if (!view.has(r.id)) continue;
      const s = this.replicaState.get(r.id);
      if (!s || !s.syncTransform) continue;
      const isNew = enteredSet.has(r.id);
      // the cadence counts SNAPSHOTS (a world-tick count with snapshots every 3rd tick starved some entities);
      // past farSend.beyond metres an entity goes every farSend.every-th snapshot (GameServerOptions.farSend)
      const far = this.farSend !== null && center !== null && Math.hypot(r.p[0] - center[0], r.p[2] - center[2]) > this.farSend.beyond;
      const every = Math.max(1, Math.floor(r.sendEvery), far ? this.farSend!.every : 1);
      if (!isNew && every > 1 && !dueThisTick({ ...r, sendEvery: every }, Math.floor(tick / this.snapshotEvery))) continue;
      const last = isNew ? undefined : sent.entities.get(r.id);
      // unchanged and already sent twice in a row (the repeat is what tells the
      // client it STOPPED: with one sample its interpolator would keep
      // extrapolating the last step), and not due a refresh: nothing to say
      if (last && last.ver === s.ver && last.settled && tick < last.refreshAt) continue;
      // left out for at least one of its own sends, and moving again: hold first
      const resumed = !!last && last.ver !== s.ver && tick - last.at > this.snapshotEvery * every;
      updates[r.id] = updateOf(s, resumed);
      if (last) {
        last.settled = last.ver === s.ver;
        last.ver = s.ver;
        last.at = tick;
        last.refreshAt = tick + refresh;
      } else {
        // the first refresh is spread over the window, so a crowd that stands
        // still does not refresh in one burst every second
        sent.entities.set(r.id, { ver: s.ver, at: tick, refreshAt: tick + 1 + (hashId(r.id) % refresh), settled: false });
      }
    }
    const entities: Record<string, unknown> = { updates };
    const managedKey = `${this.replicaSetVersion}|${own.size}`;
    if (managedKey !== sent.managedKey || tick >= sent.managedAt + Math.round(GameServer.MANAGED_REFRESH_SECONDS / this.world.fixedDt)) {
      sent.managedKey = managedKey;
      sent.managedAt = tick;
      // every host-simulated entity, in view or not: the client must not simulate any of them itself
      entities["managed"] = this.replicas.filter((r) => !own.has(r.id)).map((r) => r.id);
    }
    if (left.length > 0) entities["removed"] = left;
    state["entities"] = entities;
    return state;
  }

  /** Seconds between resends of an entity that has not changed (covers a dropped snapshot). */
  private static readonly REFRESH_SECONDS = 1;
  /** Seconds between resends of an unchanged `managed` list. */
  private static readonly MANAGED_REFRESH_SECONDS = 2;

  /** Diagnostics for an admin endpoint. */
  stats(): Record<string, unknown> {
    const sorted = [...this.tickCost].sort((a, b) => a - b);
    const q = (f: number): number => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]! * 100) / 100 : 0);
    return {
      tick: this.world.tick,
      /** ms per tick over the last 300 ticks; the budget is 1000/hz (16.7 at 60 Hz). */
      tickMs: { p50: q(0.5), p95: q(0.95), max: sorted.length ? Math.round(sorted[sorted.length - 1]! * 100) / 100 : 0, budget: Math.round(this.world.fixedDt * 1000 * 100) / 100 },
      /** Since the last /admin/slow-ticks reset: ticks over 33/50/100 ms, and event-loop stalls between ticks. */
      slow: { ...this.slowCounts, ticks: this.world.tick - this.slowCounts.ticks, loopStalls: this.stallCount, lostSimMs: Math.round(this.lostSimMs) },
      /** Client prediction vs this server, per input (see measureDivergence): corrections over 0.5 m / nudges / snaps and why. */
      divergence: this.divergenceTotals,
      /**
       * Corrections a client with the SAME physics would make, from timing alone (PlayerDriver.measureTiming):
       * inputs judged, times the drift passed 0.5 m, the largest. Bots measure this; real clients add `divergence`.
       */
      timing: this.driver?.timingTotals ?? null,
      players: [...this.players.values()].map((p) => ({
        peerId: p.peerId,
        name: p.name,
        bodyId: p.bodyId,
        position: this.world.positionOf(p.bodyId),
        inputAge: p.input ? Date.now() - p.input.at : null,
        ...(p.divergence ? { divergence: { samples: p.divergence.samples, over05: p.divergence.over05, nudges: p.divergence.nudges, snaps: p.divergence.snaps, maxM: p.divergence.maxM, reasons: p.divergence.reasons } } : {}),
        linked: p.disconnectedAt === null,
        ...(p.identity ? { characterId: p.identity.characterId, playerId: p.identity.playerId } : {}),
        ...(p.transferring !== null ? { transferring: true } : {}),
      })),
      accepting: this.accepting,
      paused: this.paused.size,
      pendingSaves: this.pendingSaves.length,
      entities: this.world.entities.size,
      replicas: this.replicas.length,
      terrainCells: this.terrain?.cells().length ?? 0,
      terrainWorkers: this.terrain?.liveWorkers ?? 0,
      /** Running totals: cells generated inline vs integrated (ms), focus-in-a-missing-cell readings, cells held by prefetch. */
      terrain: this.terrain ? { ...this.terrain.counters, inlineMs: Math.round(this.terrain.counters.inlineMs), integrateMs: Math.round(this.terrain.counters.integrateMs), pinned: this.terrain.pinned } : null,
      /** Physics bodies/colliders; `statics*`: prop/building colliders streamed around foci (built now / registered). */
      physics: this.world.sim.stats(),
      netStateKeys: this.world.netState.keys().length,
    };
  }
}
