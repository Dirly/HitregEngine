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
import type { EntityDoc, NetObjectData, RecipeEdit, WorldRecipe } from "@hitreg/core";
import type { HeadlessWorld } from "./world.js";
import type { TerrainStreamer } from "./terrain.js";
import type { CommitInput, PlayerSave } from "./cluster/player-store.js";

export type LeaveReason = "leave" | "grace" | "transfer" | "replaced" | "kicked" | "closing";
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
  | { t: "transfer"; url: string; ticket: string; reason: string };

/** Who a peer is, from the ticket it presented (absent on an open dev server). */
export interface PlayerIdentity {
  playerId: string;
  characterId: string;
  name: string;
  /** Revisions a transfer ticket promised the save is at. */
  rev?: Record<string, number>;
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
   * down (default 30). A tab that re-dials with the same peer id inside the
   * window gets its body back where it stood — a dropped link is not a death.
   */
  reconnectGraceSeconds?: number;
  /** Called with the new recipe after every successful terraform (persist it — the recipe is the save). */
  onRecipeChanged?: (id: string, recipe: WorldRecipe) => void;
}

interface RemoteInputCommand {
  t: "input";
  seq?: unknown;
  v?: unknown;
  jump?: unknown;
  yaw?: unknown;
  p?: unknown;
}

function isFiniteVec(v: unknown, len: number): v is number[] {
  return Array.isArray(v) && v.length === len && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

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
  private readonly unsubs: Array<() => void> = [];
  private replicas: ReplicaEntry[] = [];
  private replicaState = new Map<string, { p: [number, number, number]; q: [number, number, number, number]; anim?: string; animL?: string; syncTransform: boolean }>();
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
    this.graceTicks = Math.round((opts.reconnectGraceSeconds ?? 30) / this.world.fixedDt);
    this.onRecipeChanged = opts.onRecipeChanged;
    this.scene = opts.scene ?? "scene";
    this.identityOf = opts.identityOf;
    this.persistence = opts.persistence;
    const commitSeconds = opts.commitEverySeconds ?? 30;
    this.commitTicks = commitSeconds > 0 ? Math.round(commitSeconds / this.world.fixedDt) : 0;
    this.transferGate = opts.transferGate;
    this.onPlayerJoined = opts.onPlayerJoined;
    this.onPlayerLeft = opts.onPlayerLeft;
    this.template = opts.playerTemplate === undefined ? extractPlayerTemplate(this.world.expanded) : opts.playerTemplate;
    const authored = (this.template?.entities[this.template.rootId]?.components["transform"] as { position?: number[] } | undefined)?.position;
    const fallback: [number, number, number] = isFiniteVec(authored, 3)
      ? [authored[0]!, authored[1]!, authored[2]!]
      : [0, 2, 0];
    this.spawnPoint = opts.spawnPoint ?? (() => fallback);
    this.driver = this.template ? new PlayerDriver(this.world, this.players, this.template.controller) : null;
    if (this.driver) this.world.beforeStep.add(this.driver.step);

    this.host = new RoomHost(opts.transport, {
      snapshotEvery: 1, // we gate cadence ourselves (tick() is called every snapshot tick)
      ...(opts.maxPlayers !== undefined ? { maxPeers: opts.maxPlayers } : {}),
    });
    this.host.setStateSource((peerId) => this.buildStateFor(peerId));
    // no transport-level disconnect hook on purpose: the roster diff in
    // syncRoster is the ONE place a player leaves, and it applies the
    // reconnect grace — a socket drop and a `bye` take the same path
    this.unsubs.push(this.host.onCommand((peer, _tick, input) => this.onCommand(peer, input)));
    // a `hello` is the join signal: RoomHost has no roster hook, so the
    // roster is diffed each tick (same as net-presence.ts)

    // Ground under every simulated body BEFORE the first step. Terrain
    // streams around foci, and the authored NPCs exist from tick 0 — without
    // this they fall through a world that has not loaded yet, and every
    // ground probe they make afterwards reads the fallback.
    if (this.terrain) {
      for (const p of this.terrainFoci()) this.terrain.ensureAround(p[0], p[2], 1);
    }
  }

  /**
   * Where terrain must exist: every root entity with a DYNAMIC rigidbody —
   * players and NPCs alike. A body with nothing under it falls forever, so
   * "near a player" is not enough; the world has to be solid wherever the
   * simulation puts weight on it.
   */
  private terrainFoci(): Array<[number, number, number]> {
    const foci: Array<[number, number, number]> = [];
    for (const [id, e] of this.world.entities) {
      if (e.parent !== null) continue;
      if (this.paused.has(id)) continue; // asleep: no weight on the ground, no ground needed
      const rb = e.components["rigidbody"] as { kind?: string } | undefined;
      if (rb?.kind !== "dynamic") continue;
      const p = this.world.positionOf(id);
      if (p) foci.push(p);
    }
    return foci;
  }

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
    if (this.accumulator >= dt) this.accumulator = this.accumulator % dt;
  }

  /** One authoritative tick: roster → terrain → sim + scripts → replication. */
  tick(): void {
    if (this.closed) return;
    const started = performance.now();
    this.syncRoster();
    const tick = this.world.tick;
    if (this.terrain && tick % this.terrainEvery === 0) this.terrain.update(this.terrainFoci());
    this.world.step();
    this.collectReplicas();
    if (this.world.tick % this.snapshotEvery === 0) this.host.tick(this.world.tick);
    const outbox = this.world.eventBus.takeOutbox();
    if (outbox.length > 0) this.host.broadcastEvents(outbox);
    const delta = this.world.netState.takeDelta();
    if (delta) this.host.broadcastState(delta);
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
    this.tickCost.push(performance.now() - started);
    if (this.tickCost.length > 300) this.tickCost.shift();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsub of this.unsubs.splice(0)) unsub();
    for (const peerId of [...this.players.keys()]) this.leave(peerId, "closing");
    this.host.close();
    if (this.driver) this.world.beforeStep.delete(this.driver.step);
  }

  // -- roster --------------------------------------------------------------------

  private syncRoster(): void {
    const roster = new Map(this.host.peers().map((p) => [p.peerId, p.name]));
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
      } else if (this.graceTicks <= 0) {
        this.leave(player.peerId, "leave");
      } else if (player.disconnectedAt === null) {
        player.disconnectedAt = tick;
        player.input = null; // stands still; nobody is steering it
        this.host.broadcastModule(WORLD_MODULE, { t: "presence", peerId: player.peerId, linked: false } satisfies WorldModuleMessage);
      } else if (tick - player.disconnectedAt >= this.graceTicks) {
        this.leave(player.peerId, "grace");
      }
    }
  }

  /** Drop a socket (the transport is a WebSocket host in production; a loopback hub in tests may not support it). */
  private kick(peerId: string, reason: string): void {
    const t = this.transport as { disconnect?: (peer: string, reason?: string) => void };
    t.disconnect?.(peerId, reason);
  }

  /** Same peer id back inside the grace window: hand the body back, resend the world. */
  private rejoin(player: PlayerRecord, name: string): void {
    player.disconnectedAt = null;
    player.name = name;
    this.peerViews.delete(player.peerId);
    this.host.sendStateTo(player.peerId, this.world.netState.snapshot());
    const entities: Record<string, EntityDoc> = {};
    for (const [id, doc] of this.runtimeDocs) entities[id] = doc;
    this.host.sendModule(player.peerId, WORLD_MODULE, {
      t: "spawn",
      entities,
      ...(player.bodyId ? { self: player.bodyId } : {}),
    } satisfies WorldModuleMessage);
    this.host.broadcastModule(WORLD_MODULE, { t: "presence", peerId: player.peerId, linked: true } satisfies WorldModuleMessage, player.peerId);
  }

  private join(peerId: string, name: string, identity: PlayerIdentity | null, save: PlayerSave | null): void {
    // a saved position wins over the spawn point (the character stands where it logged out)
    const at: [number, number, number] = save?.position ?? this.spawnPoint(peerId);
    const yaw = save?.yaw ?? 0;
    let ids: string[] = [];
    let bodyId = "";
    if (this.template) {
      // the ground has to exist before the body lands on it
      this.terrain?.ensureAround(at[0], at[2], 1);
      const spawned = instantiatePlayer(this.template, peerId, at, yaw);
      bodyId = spawned.bodyId;
      ids = Object.keys(spawned.server);
      // the saved sheet goes into netState BEFORE the character-sheet script
      // starts, so it finds a sheet and keeps it instead of seeding a fresh one
      if (save?.sheet !== null && save?.sheet !== undefined) {
        if (!this.world.netState.set(`character/${bodyId}`, save.sheet)) {
          console.warn(`[server] saved sheet for ${peerId} failed validation — starting fresh`);
        }
      }
      this.world.addEntities({ ...this.world.base, entities: spawned.server });
      for (const [id, doc] of Object.entries(spawned.client)) this.runtimeDocs.set(id, doc);
      this.world.netState.set(`owner/${bodyId}`, peerId);
      this.world.netState.set(`player/${peerId}`, bodyId);
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
    this.host.sendStateTo(peerId, this.world.netState.snapshot());
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
    // a transferred player was committed before the handoff; everyone else saves now
    if (reason !== "transfer") {
      void this.commit(peerId).catch((error: unknown) => {
        console.warn(`[server] final save for ${peerId} failed:`, error instanceof Error ? error.message : error);
      });
    }
    this.players.delete(peerId);
    this.peerViews.delete(peerId);
    if (player.ids.length > 0) {
      this.world.removeEntities(player.ids, { silent: true });
      for (const id of player.ids) this.runtimeDocs.delete(id);
      for (const key of this.world.netState.keys(`combat/${player.bodyId}.`)) this.world.netState.delete(key);
      for (const key of this.world.netState.keys(`cooldown/${player.bodyId}.`)) this.world.netState.delete(key);
      this.world.netState.delete(`character/${player.bodyId}`);
      this.world.netState.delete(`owner/${player.bodyId}`);
      this.world.netState.delete(`player/${peerId}`);
      this.host.broadcastModule(WORLD_MODULE, { t: "despawn", ids: player.ids } satisfies WorldModuleMessage);
    }
    this.world.eventBus.emit("player.left", { peerId });
    this.onPlayerLeft?.(player, reason);
  }

  // -- persistence + transfer ------------------------------------------------------

  /** What the save authority stores: the sheet the scripts maintain, and where the body stands. */
  private snapshotFor(player: PlayerRecord): CommitInput {
    const object = this.world.objects.get(player.bodyId);
    return {
      sheet: this.world.netState.get(`character/${player.bodyId}`),
      scene: this.scene,
      position: this.world.positionOf(player.bodyId),
      yaw: object ? object.rotation.y : 0,
    };
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
    return this.transferGate ? this.transferGate(peerId) : true;
  }

  /**
   * Hand the client to another server. The caller has committed and holds a
   * ticket for the destination; this sends the instruction and marks the
   * body so its bye tears it down immediately (no grace) without a second
   * save. Returns false if the player is not here.
   */
  handoff(peerId: string, to: { url: string; ticket: string; reason: string }): boolean {
    const player = this.players.get(peerId);
    if (!player || player.disconnectedAt !== null) return false;
    player.transferring = this.world.tick;
    player.input = null;
    this.host.sendModule(peerId, WORLD_MODULE, { t: "transfer", url: to.url, ticket: to.ticket, reason: to.reason } satisfies WorldModuleMessage);
    return true;
  }

  // -- commands --------------------------------------------------------------------

  private onCommand(peer: string, input: unknown): void {
    const player = this.players.get(peer);
    if (!player || player.disconnectedAt !== null || player.transferring !== null) return;
    const cmd = input as { t?: unknown } | null;
    if (cmd?.t === "event") {
      const e = cmd as { name?: unknown; payload?: unknown };
      if (typeof e.name === "string") this.world.eventBus.injectFromPeer(peer, [{ name: e.name, payload: e.payload }]);
      return;
    }
    if (cmd?.t !== "input") return;
    const c = cmd as RemoteInputCommand;
    if (!isFiniteVec(c.v, 2)) return;
    player.input = {
      v: [c.v[0]!, c.v[1]!],
      jump: c.jump === true,
      yaw: typeof c.yaw === "number" && Number.isFinite(c.yaw) ? c.yaw : 0,
      seq: typeof c.seq === "number" && Number.isFinite(c.seq) ? c.seq : 0,
      at: Date.now(),
    };
  }

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

  /** Which entities replicate: `netObject`, or the implicit script+rigidbody default. */
  private collectReplicas(): void {
    const replicas: ReplicaEntry[] = [];
    const state = new Map<string, { p: [number, number, number]; q: [number, number, number, number]; anim?: string; animL?: string; syncTransform: boolean }>();
    for (const [id, e] of this.world.entities) {
      const netObj = e.components["netObject"] as NetObjectData | undefined;
      const implicit = e.components["script"] !== undefined && e.components["rigidbody"] !== undefined;
      if (!netObj && !implicit) continue;
      if (netObj?.authority === "owner") continue;
      const p = this.world.positionOf(id);
      const q = this.world.quaternionOf(id);
      if (!p || !q) continue;
      const syncAnim = netObj?.sync.animation ?? true;
      const anim = syncAnim ? this.world.anims.get(id) : undefined;
      const animL = syncAnim ? this.world.animLayers.get(id) : undefined;
      replicas.push({
        id,
        p,
        relevancy: netObj?.relevancy ?? "always",
        radius: netObj?.radius ?? 50,
        sendEvery: netObj?.sendEvery ?? 1,
      });
      state.set(id, {
        p: [r3(p[0]), r3(p[1]), r3(p[2])],
        q: [r3(q[0]), r3(q[1]), r3(q[2]), r3(q[3])],
        ...(anim ? { anim } : {}),
        ...(animL ? { animL } : {}),
        syncTransform: netObj?.sync.transform ?? true,
      });
    }
    this.replicas = replicas;
    this.replicaState = state;
  }

  private buildPlayers(): Record<string, { position: [number, number, number]; yaw: number; name: string; seq: number }> {
    const out: Record<string, { position: [number, number, number]; yaw: number; name: string; seq: number }> = {};
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
      };
    }
    return out;
  }

  /** One peer's snapshot — see net-presence.ts `buildStateFor` for the shape. */
  buildStateFor(peerId?: string): unknown {
    const state: Record<string, unknown> = { players: this.buildPlayers() };
    if (!peerId) return state;
    const player = this.players.get(peerId);
    const own = new Set(player?.ids ?? []);
    const center = player ? this.world.positionOf(player.bodyId) : null;
    const prev = this.peerViews.get(peerId) ?? new Set<string>();
    const visible = this.replicas.filter((r) => !own.has(r.id));
    const { view, entered, left } = computeView(center, visible, prev);
    this.peerViews.set(peerId, view);
    const enteredSet = new Set(entered);
    const updates: Record<string, unknown> = {};
    const tick = this.world.tick;
    for (const r of visible) {
      if (!view.has(r.id)) continue;
      const s = this.replicaState.get(r.id);
      if (!s || !s.syncTransform) continue;
      if (!enteredSet.has(r.id) && !dueThisTick(r, tick)) continue;
      updates[r.id] = {
        p: s.p,
        q: s.q,
        ...(s.anim ? { anim: s.anim } : {}),
        ...(s.animL ? { animL: s.animL } : {}),
      };
    }
    state["entities"] = { managed: visible.map((r) => r.id), updates, removed: left };
    return state;
  }

  /** Diagnostics for an admin endpoint. */
  stats(): Record<string, unknown> {
    const sorted = [...this.tickCost].sort((a, b) => a - b);
    const q = (f: number): number => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]! * 100) / 100 : 0);
    return {
      tick: this.world.tick,
      /** ms per tick over the last 300 ticks; the budget is 1000/hz (16.7 at 60 Hz). */
      tickMs: { p50: q(0.5), p95: q(0.95), max: sorted.length ? Math.round(sorted[sorted.length - 1]! * 100) / 100 : 0, budget: Math.round(this.world.fixedDt * 1000 * 100) / 100 },
      players: [...this.players.values()].map((p) => ({
        peerId: p.peerId,
        name: p.name,
        bodyId: p.bodyId,
        position: this.world.positionOf(p.bodyId),
        inputAge: p.input ? Date.now() - p.input.at : null,
        linked: p.disconnectedAt === null,
        ...(p.identity ? { characterId: p.identity.characterId, playerId: p.identity.playerId } : {}),
        ...(p.transferring !== null ? { transferring: true } : {}),
      })),
      accepting: this.accepting,
      paused: this.paused.size,
      entities: this.world.entities.size,
      replicas: this.replicas.length,
      terrainCells: this.terrain?.cells().length ?? 0,
      netStateKeys: this.world.netState.keys().length,
    };
  }
}
