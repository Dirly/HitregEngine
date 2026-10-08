/**
 * Portal harness — carry ONE player from scene A to scene B and back inside one
 * Node process, with the character's state carried exactly the way the cluster
 * carries it (docs/hosting.md → "Portals").
 *
 * Each scene is a `HeadlessWorld` (scripts, physics, the voxel ground where the
 * scene has one, project scripts loaded like `serve` loads them), kept for the
 * harness's lifetime the way a layer outlives a dungeon run. A trip is the
 * cluster's transfer with the sockets taken out: the `portal` builtin clears the
 * traveller and emits `portal.travel`; the harness writes the `portal/<bodyId>`
 * record (`portalDeparture`), commits the body through a real `PlayerStore`
 * (the same `CommitInput` a layer commits), tears the body down, loads the save
 * in the destination (the same `PlayerSave` a layer loads, at the committed
 * revision) and spawns it with `arrivalFor` + `seedPlayerState` — the functions
 * `GameServer.join` uses. Sheet, bags, quest journal, NPC memory, vault, bind
 * and the way back all go through that one payload.
 *
 * @example
 * ```ts
 * import { PortalHarness, loadContent, playgroundRoots } from "@hitreg/server";
 *
 * const content = loadContent(playgroundRoots("apps/playground"));
 * const h = await PortalHarness.start({ content, scene: "proving", at: [3144, 20.2, -333] });
 * h.setRecord("quests", journal);                     // anything the trip should carry
 * const inn = await h.interact("fieldfast-mound-threshold");
 * // inn = { from: "proving", to: "fieldfast-barrow", anchor: "fieldfast-barrow-entry", position, … }
 * expect(h.scene).toBe("fieldfast-barrow");
 * expect(h.record("quests")).toEqual(journal);        // carried
 * h.teleport(h.positionOf("fieldfast-barrow-exit")!); // or h.walkTo(…)
 * const out = await h.interact("fieldfast-barrow-exit");
 * expect(out?.to).toBe("proving");                     // back in the mound's passage
 * await h.close();
 * ```
 */

import {
  MemoryPlayerDataBackend,
  PORTAL_EVENTS,
  QUEST_EVENTS,
  portalDeparture,
  portalKey,
  portalVolumeOf,
  type CharacterSheet,
  type PlayerDataBackend,
  type PortalTravel,
} from "@hitreg/core";
import * as THREE from "three";
import type { LoadedContent } from "./assets.js";
import { PlayerStore, type PlayerSave } from "./cluster/player-store.js";
import { extractPlayerTemplate, instantiatePlayer, PlayerDriver, type PlayerRecord, type PlayerTemplate } from "./players.js";
import { loadProjectScripts } from "./scripts.js";
import { arrivalFor, clearPlayerState, playerSnapshot, seedPlayerState } from "./server.js";
import { TerrainStreamer, resolveServerVoxelWorld } from "./terrain.js";
import { HeadlessWorld, defaultEvents, defaultRegistry, defaultScripts } from "./world.js";

export interface PortalHarnessOptions {
  /** Project content (`loadContent(playgroundRoots(playground))`): every project folder's scenes are reachable. */
  content: LoadedContent;
  /** Scene the player starts in. */
  scene: string;
  /** Where the player starts (default: the scene's authored player position). */
  at?: [number, number, number];
  yaw?: number;
  /** Initial character sheet (default: the character-sheet builtin seeds a fresh one). */
  sheet?: CharacterSheet;
  /** Initial per-character records by namespace (`quests`, `npc`, `vault`, `bind`, `portal`). */
  records?: Record<string, unknown>;
  /** Peer / character id (default "traveller"); the body id is `player:<peerId>`. */
  peerId?: string;
  name?: string;
  /** Persistence backend (default an in-memory one) — pass a file backend to inspect saves. */
  backend?: PlayerDataBackend;
  /** Stream the voxel ground around the body (default true; inline generation, no workers). */
  terrain?: boolean;
  /** Load the projects' own scripts like `serve` does (default true). */
  projectScripts?: boolean;
  log?: (line: string) => void;
}

/** One completed trip. */
export interface PortalTrip {
  from: string;
  to: string;
  portalId: string;
  back: boolean;
  /** Anchor the body landed on (null: a return point). */
  anchor: string | null;
  position: [number, number, number];
  yaw: number;
  /** Revisions the departure committed (what a cluster ticket would bind the destination to). */
  rev: Record<string, number>;
}

interface Hosted {
  world: HeadlessWorld;
  terrain: TerrainStreamer | null;
  template: PlayerTemplate | null;
  players: Map<string, PlayerRecord>;
  travels: PortalTravel[];
  refusals: string[];
  dispose: () => void;
}

export class PortalHarness {
  readonly store: PlayerStore;
  readonly peerId: string;
  readonly name: string;
  /** Every trip taken, in order. */
  readonly hops: PortalTrip[] = [];
  /** Lines the portals refused with (`character.refused` for this body), newest last. */
  readonly refusals: string[] = [];
  private readonly worlds = new Map<string, Hosted>();
  private current!: Hosted;
  private currentScene = "";
  private player: PlayerRecord | null = null;
  private readonly playerId: string;

  private constructor(private readonly opts: PortalHarnessOptions) {
    this.peerId = opts.peerId ?? "traveller";
    this.playerId = `acct-${this.peerId}`;
    this.name = opts.name ?? "Traveller";
    this.store = new PlayerStore(opts.backend ?? new MemoryPlayerDataBackend(), "portal-harness");
  }

  /** Boot the starting scene and spawn the player in it. */
  static async start(opts: PortalHarnessOptions): Promise<PortalHarness> {
    const h = new PortalHarness(opts);
    const hosted = await h.host(opts.scene);
    const fallback = h.templatePosition(hosted);
    await h.store.commit(h.playerId, {
      sheet: opts.sheet,
      records: opts.records ?? {},
      scene: opts.scene,
      position: opts.at ?? fallback,
      yaw: opts.yaw ?? 0,
    });
    h.spawn(opts.scene, hosted, await h.store.load(h.playerId, opts.scene));
    return h;
  }

  /** Scene the player is in now. */
  get scene(): string {
    return this.currentScene;
  }
  get world(): HeadlessWorld {
    return this.current.world;
  }
  /** The player's body entity id in the current world. */
  get bodyId(): string {
    return this.player?.bodyId ?? "";
  }

  /** The player's body position (or any entity's). */
  positionOf(id = this.bodyId): [number, number, number] | null {
    return this.current.world.positionOf(id);
  }
  /** The character sheet as the authority holds it now. */
  sheet(): CharacterSheet | undefined {
    return this.current.world.netState.get(`character/${this.bodyId}`) as CharacterSheet | undefined;
  }
  /** A per-character record (`quests`, `npc`, `vault`, `bind`, `portal`) as the authority holds it now. */
  record(ns: string): unknown {
    return this.current.world.netState.get(`${ns}/${this.bodyId}`);
  }
  /** Write a per-character record (or the sheet: ns "character") as the authority would. */
  setRecord(ns: string, value: unknown): boolean {
    return this.current.world.netState.set(`${ns}/${this.bodyId}`, value);
  }

  /** Advance the current world `ticks` fixed steps (terrain follows the body). */
  step(ticks = 1): void {
    const h = this.current;
    for (let i = 0; i < ticks; i++) {
      if (h.terrain && h.world.tick % 10 === 0) {
        const p = this.positionOf();
        if (p) h.terrain.update([p]);
      }
      h.world.step();
    }
  }

  /** Put the body somewhere (ground is made under it first). */
  teleport(position: [number, number, number]): void {
    this.current.terrain?.ensureAround(position[0], position[2], 1);
    this.current.world.sim.setPosition(this.bodyId, position);
    this.current.world.sim.setLinvel(this.bodyId, [0, 0, 0]);
  }

  /** Walk toward a point with movement intent (the authority's driver), until within `within` m or `seconds` pass. */
  walkTo(target: [number, number, number], opts: { within?: number; seconds?: number; speed?: number } = {}): boolean {
    const within = opts.within ?? 1;
    const ticks = Math.round((opts.seconds ?? 20) / this.current.world.fixedDt);
    let seq = 0;
    for (let i = 0; i < ticks && this.player; i++) {
      const p = this.positionOf();
      if (!p) return false;
      const dx = target[0] - p[0];
      const dz = target[2] - p[2];
      const d = Math.hypot(dx, dz);
      if (d <= within) {
        this.player.input = null;
        return true;
      }
      const v = opts.speed ?? 4;
      this.player.input = { v: [(dx / d) * v, (dz / d) * v], jump: false, vy: 0, yaw: Math.atan2(dx, dz), seq: ++seq, at: Date.now() };
      this.step(1);
    }
    if (this.player) this.player.input = null;
    return false;
  }

  /**
   * Use an `interactable` entity the way a client does (`player.interact` from
   * this peer). When a portal clears the traveller, the trip is carried out and
   * returned; null = nothing moved (out of range, refused — see `refusals`).
   */
  async interact(entityId: string, opts: { ticks?: number } = {}): Promise<PortalTrip | null> {
    const h = this.current;
    h.travels.length = 0;
    h.world.eventBus.injectFromPeer(this.peerId, [{ name: QUEST_EVENTS.interact, payload: { actorId: this.bodyId, entityId } }]);
    const ticks = opts.ticks ?? 5;
    for (let i = 0; i < ticks && h.travels.length === 0; i++) this.step(1);
    const travel = h.travels.shift();
    return travel ? this.travel(travel) : null;
  }

  /**
   * Walk into a WALK-THROUGH portal (`mode: "trigger"`) the way a player does:
   * movement intent toward the middle of its box (then on through it) until the
   * portal sends the body, or `seconds` pass. Pass `from` to start somewhere
   * first (ground is made under it). Returns the trip, or null when nothing
   * moved (refused — see `refusals` —, a grace still running, never reached).
   */
  async walkThrough(entityId: string, opts: { from?: [number, number, number]; seconds?: number; speed?: number } = {}): Promise<PortalTrip | null> {
    const h = this.current;
    if (opts.from) this.teleport(opts.from);
    const portal = h.world.objects.get(entityId);
    const params = (h.world.expanded.entities[entityId]?.components["script"] as { params?: Record<string, unknown> } | undefined)?.params;
    const vol = portalVolumeOf(params);
    if (!portal || !vol) throw new Error(`walkThrough: "${entityId}" is not a trigger-mode portal in ${this.currentScene}`);
    portal.updateWorldMatrix(true, false);
    const centre = portal.localToWorld(new THREE.Vector3(...vol.offset));
    const start = this.positionOf();
    if (!start) return null;
    // aim through the box: from where the body stands, past the centre by the box's depth
    const dx = centre.x - start[0];
    const dz = centre.z - start[2];
    const d = Math.hypot(dx, dz) || 1;
    const reach = Math.max(vol.half[0], vol.half[2]) * 2 + 1;
    const target: [number, number, number] = [centre.x + (dx / d) * reach, centre.y, centre.z + (dz / d) * reach];
    h.travels.length = 0;
    const ticks = Math.round((opts.seconds ?? 20) / h.world.fixedDt);
    let seq = 0;
    for (let i = 0; i < ticks && this.player && h.travels.length === 0; i++) {
      const p = this.positionOf();
      if (!p) break;
      const tx = target[0] - p[0];
      const tz = target[2] - p[2];
      const td = Math.hypot(tx, tz);
      if (td < 0.3) break;
      const v = opts.speed ?? 4;
      this.player.input = { v: [(tx / td) * v, (tz / td) * v], jump: false, vy: 0, yaw: Math.atan2(tx, tz), seq: ++seq, at: Date.now() };
      this.step(1);
    }
    if (this.player) this.player.input = null;
    const travel = h.travels.shift();
    return travel ? this.travel(travel) : null;
  }

  /**
   * The transfer itself, as a layer does it: record the trip, commit, tear the
   * body down, load the save in the destination at the committed revision,
   * spawn at the arrival. Exposed so a tool can drive a trip it decided itself.
   */
  async travel(travel: PortalTravel): Promise<PortalTrip> {
    const from = this.currentScene;
    const src = this.current;
    const bodyId = this.bodyId;
    const next = portalDeparture(src.world.netState.get(portalKey(bodyId)), travel, { scene: from });
    if (!src.world.netState.set(portalKey(bodyId), next.record)) throw new Error("portal record refused by netState");
    const rev = await this.store.commit(this.playerId, playerSnapshot(src.world, bodyId, from));
    this.despawn();
    const dest = await this.host(next.scene);
    const save = await this.store.load(this.playerId, next.scene, rev);
    const landed = this.spawn(next.scene, dest, save);
    const hop: PortalTrip = { from, to: next.scene, portalId: travel.portalId, back: travel.back, anchor: landed.anchor, position: landed.at, yaw: landed.yaw, rev };
    this.hops.push(hop);
    this.opts.log?.(`[portal-harness] ${from} → ${next.scene} via ${travel.portalId}${landed.anchor ? ` at ${landed.anchor}` : ""}`);
    return hop;
  }

  /** Save where the player stands now (what a layer's periodic commit does). */
  commit(): Promise<Record<string, number>> {
    return this.store.commit(this.playerId, playerSnapshot(this.current.world, this.bodyId, this.currentScene));
  }

  /** The save as the store holds it for a scene (default: the current one). */
  load(scene = this.currentScene): Promise<PlayerSave> {
    return this.store.load(this.playerId, scene);
  }

  async close(): Promise<void> {
    for (const h of this.worlds.values()) h.dispose();
    this.worlds.clear();
  }

  // -- internals --------------------------------------------------------------------------

  private templatePosition(h: Hosted): [number, number, number] {
    const t = h.template?.entities[h.template.rootId]?.components["transform"] as { position?: number[] } | undefined;
    const p = t?.position;
    return p && p.length === 3 ? [p[0]!, p[1]!, p[2]!] : [0, 2, 0];
  }

  private async host(scene: string): Promise<Hosted> {
    const existing = this.worlds.get(scene);
    if (existing) return existing;
    const { content } = this.opts;
    const doc = content.scenes.get(scene);
    if (!doc) throw new Error(`scene "${scene}" not found (known: ${[...content.scenes.keys()].slice(0, 20).join(", ")}…)`);
    const registry = defaultRegistry();
    const events = defaultEvents();
    const scripts = defaultScripts(events, content.assets);
    if (this.opts.projectScripts !== false) await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
    const world = await HeadlessWorld.create({ doc, assets: content.assets, registry, events, scripts, exclude: (_id, e) => e.tags.includes("player") });
    const voxel = this.opts.terrain === false ? null : resolveServerVoxelWorld(world.base);
    const terrain = voxel ? new TerrainStreamer(world, voxel, { pool: false }) : null;
    const template = extractPlayerTemplate(world.expanded);
    const players = new Map<string, PlayerRecord>();
    const driver = template ? new PlayerDriver(world, players, template.controller) : null;
    if (driver) world.beforeStep.add(driver.step);
    const travels: PortalTravel[] = [];
    const refusals: string[] = [];
    const offTravel = world.eventBus.on(PORTAL_EVENTS.travel, (payload) => travels.push(payload as PortalTravel));
    const offRefused = world.eventBus.on("character.refused", (payload) => {
      const p = payload as { actorId?: string; error?: string };
      if (p.actorId === this.player?.bodyId && typeof p.error === "string") this.refusals.push(p.error);
    });
    const hosted: Hosted = {
      world,
      terrain,
      template,
      players,
      travels,
      refusals,
      dispose: () => {
        offTravel?.();
        offRefused?.();
        terrain?.dispose();
        world.dispose();
      },
    };
    this.worlds.set(scene, hosted);
    return hosted;
  }

  /** GameServer.join without the sockets. */
  private spawn(scene: string, h: Hosted, save: PlayerSave): { at: [number, number, number]; yaw: number; anchor: string | null } {
    if (!h.template) throw new Error(`scene "${scene}" has no player-tagged template to spawn from`);
    const arrival = arrivalFor(h.world, scene, save, () => this.templatePosition(h));
    h.terrain?.ensureAround(arrival.at[0], arrival.at[2], 1);
    const spawned = instantiatePlayer(h.template, this.peerId, arrival.at, arrival.yaw);
    const bodyId = spawned.bodyId;
    seedPlayerState(h.world, bodyId, save.sheet, arrival.records, undefined, this.peerId, scene);
    h.world.addEntities({ ...h.world.base, entities: spawned.server });
    h.world.netState.set(`owner/${bodyId}`, this.peerId);
    h.world.netState.set(`player/${this.peerId}`, bodyId);
    h.world.netState.set(`name/${bodyId}`, this.name);
    h.world.netState.set(`landing/${bodyId}`, h.world.timeMs + 5000);
    const record: PlayerRecord = {
      peerId: this.peerId,
      name: this.name,
      bodyId,
      ids: Object.keys(spawned.server),
      input: null,
      appliedSeq: 0,
      disconnectedAt: null,
      identity: { playerId: this.playerId, characterId: this.peerId, name: this.name },
      rev: { ...save.rev },
      commitPhase: 0,
      committing: null,
      transferring: null,
    };
    h.players.set(this.peerId, record);
    this.player = record;
    this.current = h;
    this.currentScene = scene;
    return { at: arrival.at, yaw: arrival.yaw, anchor: arrival.anchor };
  }

  private despawn(): void {
    const p = this.player;
    if (!p) return;
    const w = this.current.world;
    w.removeEntities(p.ids, { silent: true });
    clearPlayerState(w, p.bodyId, p.peerId);
    this.current.players.delete(p.peerId);
    w.eventBus.emit("player.left", { peerId: p.peerId });
    this.player = null;
  }
}
