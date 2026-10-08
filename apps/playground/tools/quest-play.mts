/**
 * quest-play — the zone pipeline's runtime quest gate: PLAYS every quest through the real server systems.
 *
 *   npx tsx tools/quest-play.mts --project <p> --scene <scene> [--quest <id,id> | --plan <quests.json> | --all] [--changed] [--walk] [--out <dir>]
 *
 * --plan <file>  play the quests a zone plan lists (its `quests[].id`), not every quest of the project.
 * --changed      a quest already proven is NOT played again: each passing row of the last report carries a digest of
 *                what its proof read (the quest, the entities and dialogues it names, the creatures it sends the player
 *                to kill and their spawn areas, the items it names, any instance scene it enters). Only quests whose
 *                digest differs are played, plus the quests they require (their state has to exist to accept them);
 *                the rest are carried over into the new report as `kept`.
 *
 * Logic lint reads quest JSON; this boots the scene headless the way `serve()` does (content + project scripts,
 * HeadlessWorld, TerrainStreamer, a GameServer with its NpcManager and SpawnAreaManager, sanctuaries) and joins ONE
 * player over an in-memory loopback transport — a real RoomClient, so every request travels the wire path a
 * browser's does: input intents, and `npc.talk` / `npc.choose` / `combat.cast.request` as peer events the
 * authority checks against `owner/<body>`. Outcomes are decided by the `npc` builtin and `quest-log`; this tool
 * only asks and watches the replicated journal (quests/<body>), sheet (character/<body>) and conversation.
 *
 * Per quest, in `requires` order: reach the giver, accept through its dialogue (the tool searches the dialogue
 * graph for the choice carrying `acceptQuest`), complete each objective, hand in to `turnIn`, and assert the
 * journal went active -> ready -> complete and the rewards (xp, coins, items) arrived.
 *
 *   default   teleports to each target (proves state machine, ids, items, dialogue actions)
 *   --walk    every site out in the world (visit area, kill camp, an NPC off the road/town network) is walked BACK
 *             toward the giver until the body joins a road or a town (town-walk proves those), watching for one-way
 *             descents (a fall or a slide steeper than the controller climbs, higher than its jump/step reach);
 *             then the recorded route is walked FORWARD from the join point to the site — the forward walk is the
 *             proof. Rows: proven forward | one-way drop | no route. NPCs in town are reached by teleport.
 *
 * Blocks: every source, objective kind, `when` condition and `then` consequence is dispatched through @hitreg/core's
 * quest block registry. A block that is not registered, or registered without a proof here (DRIVERS / CONDITIONS),
 * FAILS the quest. A world condition (clock, weather) is first BROKEN and the step attempted (no progress allowed),
 * then made to hold; a step with `after` is attempted before its predecessors (no progress allowed); `interact` and
 * `perform` also prove a too-far request is refused; a `presence` source is proven absent (talk refused) outside its
 * condition, present inside it, and kept through a conversation while the condition lapses.
 *
 * Objective evidence: `proven` (done through the real system: a conversation, standing in the area, a kill by the
 * player's own cast requests, an item handed over by a dialogue), `simulated` (kill: an authority-side
 * combat.damage; collect: granted by inventory.give or already carried before the quest began), `failed`.
 * A quest with any simulated objective is at best `partial`.
 *
 * Instances: a step whose objective names a `scene` (an instance behind a `portal`, written by `zonegen bind`) is done
 * THERE. The body goes to the world scene's portal into that scene and through it (a walk-through trigger is walked
 * into with movement intents from its way-back anchor; an interact portal gets a player.interact), the `portal`
 * builtin decides and emits portal.travel, and the trip is serve()'s transfer in process: the portal record
 * (portalDeparture), a commit of playerSnapshot into a real PlayerStore, the handoff and bye, and a join on the
 * instance's own host (its own HeadlessWorld + GameServer, booted on first use) that LOADS that save — journal, sheet,
 * bags and coins arrive through the save, and the row checks they did. The step runs through the same drivers (targets
 * inside reached by teleport as in the world); the body then leaves through the instance's way-back portal (walked
 * from the anchor it landed on) and lands at the world portal's return anchor. Such a step is `proven` only when the
 * trip in, the step and the trip out all happened; `trips` in the report lists every hop.
 *
 * Output: <out>/quest-play.json (default projects/<p>/authoring/reports/quest-play/). Exit 1 if any quest fails.
 * Read-only: nothing under assets/ is written (the recipe save hook is not attached).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  GameServer,
  HeadlessWorld,
  NpcManager,
  SpawnAreaManager,
  TerrainStreamer,
  defaultEvents,
  defaultRegistry,
  defaultScripts,
  extractPlayerTemplate,
  loadContent,
  loadProjectScripts,
  playerSnapshot,
  PlayerStore,
  playgroundRoots,
  resolveServerVoxelWorld,
  type PlayerIdentity,
  type PlayerTemplate,
} from "../../../packages/server/src/index.ts";
import * as THREE from "three";
import { LoopbackHub, RoomClient } from "@hitreg/net";
import {
  conditionBlockNames,
  DEFAULT_PERFORM_ACTIONS,
  INTERACT_RANGE,
  MemoryPlayerDataBackend,
  objectiveArea,
  PORTAL_EVENTS,
  portalDeparture,
  portalKey,
  portalVolumeOf,
  type PortalTravel,
  type SceneDoc,
  QUEST_EVENTS,
  questBlocks,
  questSource,
  questState,
  questSchema,
  sanctuariesFromPois,
  WORLD_HOUR_KEY,
  WORLD_WEATHER_KEY,
  SANCTUARIES_KEY,
  testCondition,
  type CharacterSheet,
  type Conversation,
  type Dialogue,
  type DialogueAction,
  type DialogueChoice,
  type DialogueCondition,
  type DialogueFacts,
  type NpcMemory,
  type PoiDoc,
  type Quest,
  type QuestJournal,
  type RegionDoc,
  type SanctuaryCircle,
  type WorldFacts,
} from "@hitreg/core";
import { QuestLog } from "@hitreg/scripting";
import { jumpArc } from "@hitreg/scripting";
import { DEFAULT_CHARACTER } from "@hitreg/physics";
import { walkOut, walkPoints, type ClimbLimits, type P2, type P3, type WalkDeps, type WalkResult } from "./_quest-walk.mts";

// ---- args ---------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);
const projectName = opt("project", "");
const sceneName = opt("scene", "");
const planFile = opt("plan", "");
const onlyQuest = planFile ? (JSON.parse(fs.readFileSync(path.resolve(planFile), "utf8")) as { quests: { id: string }[] }).quests.map((q) => q.id).join(",") : opt("quest", "");
const CHANGED = flag("changed");
const WALK = flag("walk");
if (!projectName || !sceneName) {
  console.error("usage: quest-play --project <p> --scene <scene> [--quest <id,id> | --plan <quests.json> | --all] [--changed] [--walk] [--out <dir>]");
  process.exit(2);
}
const playground = path.resolve(".");
const projectDir = path.resolve("projects", projectName);
const outDir = path.resolve(opt("out", path.join(projectDir, "authoring/reports/quest-play")));
const t0 = Date.now();
const log = (s: string): void => console.log(s);

// ---- boot: serve() minus sockets — one host per scene a quest goes to ----------------------------------------------
// The world scene boots first; an instance (a dungeon behind a `portal`) boots the first time a step happens there
// and stays up for the run, the way a layer outlives a dungeon run. Exactly one host ticks: the one the body is in.
const content = loadContent(playgroundRoots(playground));
const PEER = "quest-player";
const BODY = `player:${PEER}`;
/**
 * The save authority main is in a cluster: a real PlayerStore. A portal trip commits the body here (playerSnapshot:
 * sheet, bags, coins, quest journal, NPC memory, the portal record) and the destination's GameServer loads that save
 * on join (`persistence.load`, at the committed revision) — serve()'s moveOut + join with the sockets taken out.
 * The player is anonymous until its first trip, so the world scene's first join is exactly the one it always was.
 */
const store = new PlayerStore(new MemoryPlayerDataBackend(), "quest-play");
let identified = false;
let committedRev: Record<string, number> = {};
const identity = (): PlayerIdentity => ({ playerId: `acct-${PEER}`, characterId: PEER, name: "Quest Player", rev: committedRev });
interface Host {
  scene: string; doc: SceneDoc; world: HeadlessWorld; terrain: TerrainStreamer | null; template: PlayerTemplate; spawnAt: P3;
  hub: LoopbackHub; server: GameServer; npcs: NpcManager; spawnAreas: SpawnAreaManager; client: RoomClient | null;
  /** portal.travel events the portal builtin emitted in this world (the trip a layer turns into a transfer). */
  travels: PortalTravel[]; refusals: string[];
}
const hosts = new Map<string, Host>();
async function bootHost(scene: string): Promise<Host> {
  const doc = content.scenes.get(scene);
  if (!doc) throw new Error(`no scene "${scene}"`);
  const events = defaultEvents();
  const scripts = defaultScripts(events);
  const report = await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
  for (const s of report.skipped) log(`  script skipped: ${s.file}: ${s.reason}`);
  const world = await HeadlessWorld.create({
    doc, assets: content.assets, registry: defaultRegistry(), events, scripts,
    exclude: (_id, e) => e.tags.includes("player"),
  });
  const voxel = resolveServerVoxelWorld(world.base);
  const terrain = voxel ? new TerrainStreamer(world, voxel, { pool: false }) : null;
  const template = extractPlayerTemplate(world.expanded);
  if (!template) throw new Error(`scene ${scene} has no player template`);
  const authored = (template.entities[template.rootId]?.components["transform"] as { position?: number[] } | undefined)?.position ?? [0, 2, 0];
  const spawnAt: P3 = [authored[0]!, terrain ? Math.max(authored[1]!, terrain.groundHeight(authored[0]!, authored[2]!) + 1.2) : authored[1]!, authored[2]!];
  const hub = new LoopbackHub({ manualFlush: true });
  const server = new GameServer({
    world, transport: hub.connect("host"), terrain, scene, playerTemplate: template,
    spawnPoint: () => spawnAt, snapshotEvery: 600, reconnectGraceSeconds: 0,
    identityOf: (peer) => (identified && peer === PEER ? identity() : undefined),
    persistence: { load: (id, sc) => store.load(id.playerId, sc, id.rev ?? {}), commit: (id, input) => store.commit(id.playerId, input) },
    commitEverySeconds: 0,
  });
  const npcs = new NpcManager(server, { respawnSeconds: 20 });
  const spawnAreas = new SpawnAreaManager(server, npcs);
  if (terrain) {
    // sanctuaries, as serve() publishes them (the combat scripts read them)
    const recipe = terrain.resolved.field.recipe;
    const regions: ReadonlyArray<RegionDoc> = recipe?.regions ?? [];
    const pois: ReadonlyArray<PoiDoc> = recipe?.features.pois ?? [];
    const list: SanctuaryCircle[] = sanctuariesFromPois(pois);
    for (const region of regions) {
      if (!region.tags.includes("safe")) continue;
      const [cx, cz] = region.hub ?? region.polygon.reduce<[number, number]>((a, p) => [a[0] + p[0] / region.polygon.length, a[1] + p[1] / region.polygon.length], [0, 0]);
      let r = 0;
      for (const [x, z] of region.polygon) r = Math.max(r, Math.hypot(x - cx, z - cz));
      if (r > 0) list.push([cx, cz, r, terrain.groundHeight(cx, cz)]);
    }
    world.netState.set(SANCTUARIES_KEY, list);
  }
  const h: Host = { scene, doc, world, terrain, template, spawnAt, hub, server, npcs, spawnAreas, client: null, travels: [], refusals: [] };
  // the run's watchers, on every world the body visits
  world.afterStep.add(() => watchJournal(h));
  world.eventBus.on("combat.killed", (p) => {
    kills.push(p as { victimId: string; killerId: string | null });
    if ((p as { victimId?: string }).victimId === BODY) deaths++;
  });
  world.eventBus.on(PORTAL_EVENTS.travel, (p) => h.travels.push(p as PortalTravel));
  world.eventBus.on("character.refused", (p) => {
    const r = p as { actorId?: string; error?: string };
    if (r.actorId === BODY && typeof r.error === "string") h.refusals.push(r.error);
  });
  hosts.set(scene, h);
  return h;
}

// the current host's parts, as plain bindings: every driver below reads them, and a portal trip swaps them
let current!: Host;
let doc!: SceneDoc;
let world!: HeadlessWorld;
let terrain: TerrainStreamer | null = null;
let hub!: LoopbackHub;
let server!: GameServer;
let npcs!: NpcManager;
let spawnAreas!: SpawnAreaManager;
let client!: RoomClient;
let net!: HeadlessWorld["netState"];
let walkDeps: WalkDeps | null = null;
let recipeFeatures: ReturnType<typeof featuresOf> = undefined;
function featuresOf(t: TerrainStreamer | null) { return t?.resolved.field.recipe.features; }
function switchTo(h: Host): void {
  current = h; doc = h.doc; world = h.world; terrain = h.terrain; hub = h.hub; server = h.server; npcs = h.npcs; spawnAreas = h.spawnAreas;
  client = h.client!; net = h.world.netState; recipeFeatures = featuresOf(h.terrain);
  walkDeps = h.terrain ? { world: h.world, terrain: h.terrain, field: h.terrain.resolved.field as unknown as WalkDeps["field"], bodyId: BODY, runSpeed: RUN, stepWith: (v, j) => stepWith(v, j), tick: () => tick() } : null;
}
const flushAsync = async (): Promise<void> => { for (let i = 0; i < 4; i++) { hub.flush(); await new Promise((r) => setTimeout(r, 0)); } };
let seq = 0;
function tick(n = 1): void {
  for (let i = 0; i < n; i++) { hub.flush(); server.tick(); }
  hub.flush();
}
/** Connect the loopback client to a host and wait for the body (a save load on join is asynchronous). */
async function joinHost(h: Host): Promise<void> {
  h.client = new RoomClient(h.hub.connect(PEER), "host");
  h.client.join("Quest Player");
  switchTo(h);
  for (let i = 0; i < 40 && !world.entities.has(BODY); i++) { await flushAsync(); server.tick(); await flushAsync(); }
  if (!world.entities.has(BODY)) throw new Error(`the loopback player never joined ${h.scene}`);
}
// journal transitions and kills are recorded across every host
interface Transition { status: string; tick: number; sim: number; wallMs: number }
const transitions = new Map<string, Transition[]>();
const kills: Array<{ victimId: string; killerId: string | null }> = [];
/** Times the test player has died (an endure or a walk that was interrupted by a death says so). */
let deaths = 0;
function watchJournal(h: Host): void {
  const j = h.world.netState.get(`quests/${BODY}`) as QuestJournal | undefined;
  if (!j) return;
  for (const [id, st] of Object.entries(j.quests)) {
    const list = transitions.get(id) ?? [];
    if (list.at(-1)?.status !== st.status) {
      list.push({ status: st.status, tick: h.world.tick, sim: +(h.world.timeMs / 1000).toFixed(2), wallMs: Date.now() - t0 });
      transitions.set(id, list);
    }
  }
}

const home = await bootHost(sceneName);
const template = home.template;
const spawnAt = home.spawnAt;
// controller limits (read from the world scene's player template) are needed by switchTo's walk deps
const ctl = (k: string, fallback: number): number => (typeof template.controller[k] === "number" ? (template.controller[k] as number) : fallback);
const RUN = typeof template.controller["speed"] === "number" ? (template.controller["speed"] as number) : 6.5;
await joinHost(home);
tick(60);
// the project's player template fills the bags with every starting weapon; a quest test needs ROOM for what it collects.
// Worn gear stays; everything merely carried is dropped before the first quest (authority-side sheet write).
{
  const sh = net.get(`character/${BODY}`) as { items?: Record<string, { itemId: string; qty: number; equipped?: boolean; slot?: string }> } | undefined;
  if (sh?.items) {
    const kept = Object.fromEntries(Object.entries(sh.items).filter(([, it]) => it.equipped || it.slot));
    const dropped = Object.keys(sh.items).length - Object.keys(kept).length;
    if (dropped > 0) { net.set(`character/${BODY}`, { ...sh, items: kept }); tick(2); log(`  bags: dropped ${dropped} carried starting item(s) to make room`); }
  }
}
log(`booted ${sceneName} in ${Date.now() - t0} ms — ${world.entities.size} entities, ${npcs.list().length} managed NPCs, ${spawnAreas.areas.size} spawn areas${WALK ? ", WALK mode" : ""}`);

// ---- the wire: what a client may send ---------------------------------------------------------------------------
const send = (input: unknown): void => client.sendCommand(input);
const sendEvent = (name: string, payload: unknown): void => send({ t: "event", name, payload });
const sendMove = (v: [number, number], jump = false): void => send({ t: "input", seq: ++seq, v, jump, vy: 0, yaw: Math.atan2(v[0], v[1]) });
const stepWith = (v: [number, number], jump: boolean): void => { sendMove(v, jump); tick(); };
/** What the body can climb back up, read from the player controller the driver uses and the physics character. */
const jumpApex = jumpArc({ jump: ctl("jump", 6.2), riseGravity: ctl("jumpGravity", 1.6), fallGravity: ctl("fallGravity", 2.2), cutGravity: ctl("jumpCutGravity", 3) }).apex;
const LIMITS: ClimbLimits = { reach: Math.max(jumpApex, ctl("stepHeight", 0.35), DEFAULT_CHARACTER.autostep.maxHeight), maxClimb: DEFAULT_CHARACTER.maxSlopeClimbAngle };

// ---- state readers ------------------------------------------------------------------------------------------------
const journal = (): QuestJournal | undefined => net.get(`quests/${BODY}`) as QuestJournal | undefined;
const sheet = (): CharacterSheet | undefined => net.get(`character/${BODY}`) as CharacterSheet | undefined;
/** Items that arrived in the bags right after the player's own kills this run (creature drops), by item id. */
const lootGains: Record<string, number> = {};
const bagTotals = (): Record<string, number> => { const t: Record<string, number> = {}; for (const it of Object.values(sheet()?.items ?? {})) t[it.itemId] = (t[it.itemId] ?? 0) + it.qty; return t; };
const conversation = (): Conversation | undefined => net.get(`dialogue/${BODY}`) as Conversation | undefined;
const pos = (): P3 => world.positionOf(BODY)!;
const dead = (id: string): boolean => net.get(`combat/${id}.dead`) === true;
const owned = (itemId: string): number => Object.values(sheet()?.items ?? {}).reduce((n, s) => n + (s.itemId === itemId ? s.qty : 0), 0);
const simSeconds = (): number => +(world.timeMs / 1000).toFixed(2);

const questFiles = fs.readdirSync(path.join(projectDir, "assets/quests")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const quests = new Map<string, Quest>();
const problemsAtLoad: Record<string, string> = {};
for (const id of questFiles) {
  const a = content.assets.getDataAsset(id);
  const parsed = questSchema.safeParse(a?.data);
  if (a?.type === "quest" && parsed.success) quests.set(id, parsed.data);
  else problemsAtLoad[id] = `quest asset does not load (${parsed.success ? `type ${a?.type}` : parsed.error.issues[0]?.message})`;
}
const questOf = (id: string): Quest | undefined => {
  const a = content.assets.getDataAsset(id);
  return a?.type === "quest" ? (a.data as Quest) : undefined;
};

// journal transitions and kills are watched on every host (bootHost)

// ---- entities ------------------------------------------------------------------------------------------------------
interface NpcInfo { id: string; dialogueId: string; dialogue: Dialogue | null; radius: number; at: P3; readable: boolean; face: boolean; presence: DialogueCondition | null }
function npcInfo(id: string): NpcInfo | null {
  const e = world.entities.get(id);
  const s = e?.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
  if (!e || s?.name !== "npc") return null;
  const dialogueId = String(s.params?.["dialogue"] ?? "");
  const a = dialogueId ? content.assets.getDataAsset(dialogueId) : undefined;
  return { id, dialogueId, dialogue: a?.type === "dialogue" ? (a.data as Dialogue) : null, radius: Number(s.params?.["radius"] ?? 3.5), at: world.positionOf(id)!, readable: s.params?.["readable"] === true, face: s.params?.["face"] !== false,
    presence: s.params?.["presence"] && Object.keys(s.params["presence"] as object).length ? (s.params["presence"] as DialogueCondition) : null };
}
function dialogueHas(d: Dialogue | null, pred: (a: DialogueAction) => boolean): boolean {
  return !!d && Object.values(d.nodes).some((n) => n.choices.some((c) => c.do.some(pred)));
}

// ---- moving the player -----------------------------------------------------------------------------------------------
const walks: Array<WalkResult & { purpose: string; quest: string }> = [];


/** Floors a body could stand on beside `c` (nearest first): free space for a capsule, a floor within 2.5 m of c's height. */
function standPoints(c: P3, r: number): P3[] {
  terrain?.ensureAround(c[0], c[2], 1);
  tick();
  const out: P3[] = [];
  for (const rr of [r, r * 0.7, r * 1.4, r * 0.5, r * 2])
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = c[0] + Math.cos(a) * rr;
      const z = c[2] + Math.sin(a) * rr;
      const hit = world.sim.raycast([x, c[1] + 2.5, z], [0, -1, 0], 6, { solid: true, exclude: [BODY] });
      if (!hit || Math.abs(hit.point[1] - c[1]) > 2.5) continue;
      const near = world.sim.overlapSphere([x, hit.point[1] + 1.1, z], 0.35).filter((id) => !id.startsWith(BODY));
      if (near.length === 0) out.push([x, hit.point[1] + 1.0, z]);
    }
  if (!out.length) out.push([c[0] + r, c[1] + 0.5, c[2]]);
  return out;
}
const standPoint = (c: P3, r: number): P3 => standPoints(c, r)[0]!;
/** Put the body at `p` (logic mode) — the same teleport a respawn uses. */
function teleport(p: P3): void {
  terrain?.ensureAround(p[0], p[2], 1);
  tick();
  world.sim.setPosition(BODY, p);
  tick(30);
}
/** Reach `p`: teleport (logic) or plan + walk (walk mode). Returns a failure string or null. */
function reach(p: P3, _purpose: string, _quest: string, _within = 2): string | null {
  teleport(p);
  return null;
}
/** The known-walkable network a point is on: a road's width (plus a metre), a town's footprint, a gate. */
function onNetwork(p: P3): string | null {
  const x = p[0];
  const z = p[2];
  for (const t of recipeFeatures?.towns ?? []) {
    if (Math.hypot(x - t.center[0], z - t.center[1]) <= t.radius) return `town:${t.id}`;
    for (const g of t.gates ?? []) if (Math.hypot(x - g.at[0], z - g.at[1]) <= 6) return `gate:${t.id}/${g.id}`;
  }
  for (const r of recipeFeatures?.roads ?? []) {
    const half = r.width / 2 + 1;
    const pts = r.points as P2[];
    for (let k = 1; k < pts.length; k++) {
      const [ax, az] = pts[k - 1]!;
      const [bx, bz] = pts[k]!;
      const vx = bx - ax;
      const vz = bz - az;
      const l2 = vx * vx + vz * vz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2));
      if (Math.hypot(x - (ax + vx * u), z - (az + vz * u)) <= half) return `road:${r.id}`;
    }
  }
  return null;
}
interface WalkOutRow {
  verdict: "proven forward" | "one-way drop" | "no route";
  joined: string | null; backMetres: number; forwardMetres?: number; seconds: number; from: P3;
  oneWay?: { at: P3; drop: number; kind: string }; stuck?: P3; reason?: string;
}
/** --walk: from the objective's site (where the body now stands) back toward the giver until a road or town is reached. */
function walkBack(q: Quest, purpose: string): WalkOutRow {
  // toward the giver — unless the giver itself stands off the network (a dock, a camp), then toward the nearest town
  let home = (q.giver ? npcInfo(q.giver)?.at : null) ?? (q.turnIn ? npcInfo(q.turnIn)?.at : null) ?? spawnAt;
  if (!onNetwork(home)) {
    const here = pos();
    const town = [...(recipeFeatures?.towns ?? [])].sort((x, y) => Math.hypot(here[0] - x.center[0], here[2] - x.center[1]) - Math.hypot(here[0] - y.center[0], here[2] - y.center[1]))[0];
    if (town) home = [town.center[0], 0, town.center[1]];
  }
  const site = pos();
  const res = walkOut(walkDeps!, [home[0], home[2]], onNetwork, LIMITS);
  walks.push({ ...res, trail: undefined, purpose: `${purpose} (back)`, quest: q.id });
  const stuck = res.stuck.find((x) => !x.jumped) ?? res.stuck.at(-1);
  const row: WalkOutRow = { verdict: "no route", joined: res.joined ?? null, backMetres: res.reached, seconds: res.seconds, from: res.from };
  if (res.oneWay) {
    row.verdict = "one-way drop";
    row.oneWay = res.oneWay;
    row.reason = `one-way drop at [${res.oneWay.at.join(", ")}] (${res.oneWay.drop} m ${res.oneWay.kind}; climb reach ${LIMITS.reach.toFixed(2)} m)`;
  } else if (!res.joined) {
    if (stuck) row.stuck = stuck.at;
    row.reason = res.unplanned ? `no route: ${res.unplanned.why} (planner stopped at [${res.unplanned.at.join(", ")}])` : `no route: stuck at [${stuck?.at.join(", ") ?? "?"}] after ${res.reached} m (touching ${stuck?.touching.join("; ") || "ground only"})`;
  } else {
    // the proof: from the join point, walk the recorded route FORWARD to the site with the same driver
    const trail = (res.trail ?? []).slice().reverse();
    if (trail.length < 2) { row.verdict = "proven forward"; row.forwardMetres = 0; } else {
    const j0 = trail[0]!;
    teleport(standPoint([j0[0], (terrain?.groundHeight(j0[0], j0[1]) ?? site[1]) + 1, j0[1]], 0.5));
    const fw = walkPoints(walkDeps!, trail, [site[0], site[2]]);
    walks.push({ ...fw, purpose: `${purpose} (forward)`, quest: q.id });
    const end = pos();
    const left = Math.hypot(end[0] - site[0], end[2] - site[2]);
    row.forwardMetres = fw.reached;
    if (fw.finished && left < 6) row.verdict = "proven forward";
    else {
      const fst = fw.stuck.find((x) => !x.jumped) ?? fw.stuck.at(-1);
      row.reason = `no route: the forward walk from ${res.joined} stopped ${Math.round(left)} m short${fst ? ` at [${fst.at.join(", ")}]` : ""}`;
      if (fst) row.stuck = fst.at;
    }
    }
  }
  log(`    walk ${purpose}: ${row.verdict}${row.joined ? ` via ${row.joined} (back ${row.backMetres} m${row.forwardMetres !== undefined ? `, forward ${row.forwardMetres} m` : ""})` : ""}${row.reason ? ` — ${row.reason}` : ""}`);
  if (dead(BODY)) recoverIfDead();
  return row;
}
function reachNpc(n: NpcInfo, purpose: string, quest: string): string | null {
  const stands = standPoints(n.at, 1.6);
  const inRange = (): boolean => { const q = pos(); return Math.hypot(q[0] - n.at[0], q[2] - n.at[2]) <= n.radius && Math.abs(q[1] - n.at[1]) < 4; };
  // NPCs are reached by teleport in both modes (in-town ground is the town-walk gate's); a stand point the body
  // slid off (a wall top, a stair) is retried with the next one
  reach(stands[0]!, purpose, quest, 1.5);
  for (let k = 1; k < Math.min(stands.length, 8) && !inRange(); k++) reach(stands[k]!, `${purpose} (retry ${k})`, quest, 1);
  const p = pos();
  const d = Math.hypot(p[0] - n.at[0], p[2] - n.at[2]);
  if (!inRange()) return `could not stand within talking range of ${n.id} (${d.toFixed(1)} m, dy ${(p[1] - n.at[1]).toFixed(1)})`;
  return null;
}
/** A dead player waits out its respawn (the combat script brings it back at a sanctuary). */
function recoverIfDead(): boolean {
  if (!dead(BODY)) return false;
  for (let i = 0; i < 60 * 20 && dead(BODY); i++) tick();
  tick(30);
  return true;
}

// ---- conversations ---------------------------------------------------------------------------------------------------
type Goal = (a: DialogueAction) => boolean;
/** Choices the explorer will take on the way to a goal: nothing that spends, hands in, accepts or opens a window. */
const SAFE = new Set(["setFlag", "clearFlag", "give", "reward", "bindSoul"]);
function facts(npcId: string): DialogueFacts {
  return {
    npcId,
    memory: net.get(`npc/${BODY}`) as NpcMemory | undefined,
    sheet: sheet(),
    journal: journal(),
    quest: questOf,
    metBefore: true,
    bind: null,
    bindPoint: null,
    world: worldNow(),
  };
}
/** First choice index (among `offered` at `node`) on a path to a choice carrying the goal action, or null. */
function route(d: Dialogue, node: string, offered: number[], goal: Goal, f: DialogueFacts): number | null {
  const RESTART = "\u0000restart";
  const starts = (): string[] => d.start.filter((s) => testCondition(s.if, f)).map((s) => s.node);
  const seen = new Set<string>([node]);
  const queue: Array<{ node: string; first: number }> = [];
  const choices = d.nodes[node]?.choices ?? [];
  for (const i of offered) {
    const c = choices[i]!;
    if (c.do.some(goal)) return i;
  }
  for (const i of offered) {
    const c = choices[i]!;
    if (!c.do.every((a) => SAFE.has(a.do))) continue;
    queue.push({ node: c.goto === "end" ? RESTART : c.goto, first: i });
  }
  while (queue.length) {
    const { node: n, first } = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const next = n === RESTART ? starts().map((s) => ({ goto: s, c: null as DialogueChoice | null })) : (d.nodes[n]?.choices ?? []).filter((c) => testCondition(c.if, f)).map((c) => ({ goto: c.goto, c }));
    for (const { goto, c } of next) {
      if (c && c.do.some(goal)) return first;
      if (c && !c.do.every((a) => SAFE.has(a.do))) continue;
      queue.push({ node: c === null ? goto : goto === "end" ? RESTART : goto, first });
    }
  }
  return null;
}
/** Coins the player handed over in dialogue choices this run (a purchase a quest asks for). */
let coinsPaid = 0;
interface ConverseResult { ok: boolean; reason: string; path: string[]; notice: string }
/** Talk to `n` and steer its dialogue to a choice carrying the goal action; the authority runs it. */
function converse(n: NpcInfo, goal: Goal, done: () => boolean): ConverseResult {
  const pathTaken: string[] = [];
  if (!n.dialogue) return { ok: false, reason: `${n.id} has no dialogue asset ("${n.dialogueId}")`, path: pathTaken, notice: "" };
  let lastNotice = "";
  for (let talks = 0; talks < 6; talks++) {
    sendEvent("npc.talk", { actorId: BODY, npcId: n.id });
    tick(4);
    let conv = conversation();
    if (!conv || conv.npc !== n.id) return { ok: false, reason: `npc.talk opened no conversation with ${n.id} (no start node holds, or out of range)`, path: pathTaken, notice: "" };
    for (let steps = 0; steps < 16; steps++) {
      const offered = conv.choices.map((c) => c.index);
      const i = route(n.dialogue, conv.node, offered, goal, facts(n.id));
      if (i === null) {
        sendEvent("npc.leave", { actorId: BODY, npcId: n.id });
        tick(3);
        return { ok: false, reason: `dialogue offers no route to the action from node "${conv.node}" (offered: ${conv.choices.map((c) => JSON.stringify(c.text)).join(", ") || "nothing"})`, path: pathTaken, notice: lastNotice };
      }
      const choice = n.dialogue.nodes[conv.node]!.choices[i]!;
      pathTaken.push(`${conv.node}#${i} "${choice.text}"`);
      const seqBefore = conv.seq;
      sendEvent("npc.choose", { actorId: BODY, npcId: n.id, node: conv.node, index: i });
      tick(4);
      const after = conversation();
      if (after && after.npc === n.id && after.seq > seqBefore && after.notice) {
        lastNotice = after.notice;
        sendEvent("npc.leave", { actorId: BODY, npcId: n.id });
        tick(3);
        return { ok: false, reason: `the NPC refused: "${after.notice}"`, path: pathTaken, notice: after.notice };
      }
      for (const act of choice.do) if (act.do === "pay") coinsPaid += act.coins; // the choice ran: what it cost is not a short reward
      if (choice.do.some(goal)) {
        tick(20);
        if (conversation()?.npc === n.id) { sendEvent("npc.leave", { actorId: BODY, npcId: n.id }); tick(3); }
        return done() ? { ok: true, reason: "", path: pathTaken, notice: "" } : { ok: false, reason: "the choice ran but the journal did not change", path: pathTaken, notice: "" };
      }
      if (!after || after.npc !== n.id) break; // the conversation ended: talk again (the start node may differ now)
      conv = after;
    }
  }
  return { ok: false, reason: "gave up after 6 conversations without reaching the action", path: pathTaken, notice: lastNotice };
}

// ---- objectives ---------------------------------------------------------------------------------------------------------
type Evidence = "proven" | "simulated" | "failed";
interface ObjectiveRow { id: string; kind: string; target: string; required: number; progress: number; result: Evidence; how: string; reason?: string; walk?: WalkOutRow | string; scene?: string; trip?: string }
const progressOf = (q: Quest, oid: string): number => questState(journal(), q.id)?.progress[oid] ?? 0;
const statusOf = (q: Quest): string | undefined => questState(journal(), q.id)?.status;
const objectiveDone = (q: Quest, o: Quest["objectives"][number]): boolean => {
  const st = statusOf(q);
  return st === "ready" || st === "complete" || progressOf(q, o.id) >= o.required;
};
function waitFor(cond: () => boolean, seconds: number): boolean {
  for (let i = 0; i < Math.round(seconds * 60); i++) { if (cond()) return true; tick(); }
  return cond();
}

function doTalk(q: Quest, o: Quest["objectives"][number]): Omit<ObjectiveRow, "id" | "kind" | "target" | "required" | "progress"> {
  const n = npcInfo(o.target);
  if (!n) return { result: "failed", how: "", reason: `talk target "${o.target}" is not an npc entity in the scene` };
  const fail = reachNpc(n, `talk ${o.target}`, q.id);
  if (fail) return { result: "failed", how: "", reason: fail };
  sendEvent("npc.talk", { actorId: BODY, npcId: n.id });
  const ok = waitFor(() => objectiveDone(q, o), 1.5);
  if (conversation()?.npc === n.id) { sendEvent("npc.leave", { actorId: BODY, npcId: n.id }); tick(3); }
  return ok ? { result: "proven", how: `npc.talk with ${n.id}` } : { result: "failed", how: "", reason: `talking to ${n.id} did not advance the objective` };
}

function doVisit(q: Quest, o: Quest["objectives"][number]): Omit<ObjectiveRow, "id" | "kind" | "target" | "required" | "progress"> {
  const area = objectiveArea(q, o);
  if (!area) return { result: "failed", how: "", reason: "visit objective but neither it nor the quest has an `area` — quest-log can never count it" };
  const [x, z] = area.center;
  const y = terrain ? terrain.groundHeight(x, z) + 1.2 : pos()[1];
  const water = terrain?.resolved.field.waterY(x, z) ?? null;
  const fail = reach([x, Math.max(y, (water ?? -Infinity) + 1), z], `visit ${area.label}`, q.id, area.radius * 0.8);
  const ok = waitFor(() => objectiveDone(q, o), 1.5);
  if (ok) return { result: "proven", how: `stood inside the area (r ${area.radius} m) (teleported)${water !== null && water > y - 1.2 ? "; the centre is under water" : ""}` };
  return { result: "failed", how: "", reason: fail ?? "standing at the area centre did not advance the objective" };
}

/** Kill-target match for a body or spawned-copy id: `tag:<tag>` reads the body's (or its template's) tags. */
function killMatch(id: string, target: string): boolean {
  if (!target.startsWith("tag:")) return QuestLog.matchesKill(id, target);
  const tag = target.slice(4);
  const tpl = id.includes("#") ? id.split("#")[1]! : id;
  return !!(world.entities.get(id)?.tags.includes(tag) || doc!.entities[tpl]?.tags.includes(tag));
}
function liveTargets(target: string): string[] {
  const out: string[] = [];
  for (const [id, e] of world.entities) {
    if (e.parent !== null || id === BODY) continue;
    if (!killMatch(id, target)) continue;
    if (server.paused.has(id) || dead(id) || typeof net.get(`combat/${id}.hp`) !== "number") continue;
    out.push(id);
  }
  return out;
}
/** Where the last kill target stood: the site a --walk walk-out starts from. */
let killSite: P3 | null = null;
const d2 = (a: P3, b: readonly number[]): number => Math.hypot(a[0] - b[0]!, a[2] - b[2]!);

function doKill(q: Quest, o: Quest["objectives"][number]): Omit<ObjectiveRow, "id" | "kind" | "target" | "required" | "progress"> {
  const areas = [...spawnAreas.areas.values()].filter((a) => a.data.spawns.some((s) => s.template === o.target || killMatch(`${a.id}#${s.template}#1`, o.target)));
  const notes: string[] = [];
  let real = 0;
  let simulated = 0;
  let killRestored = 0;
  const kills0 = kills.length;
  const anchor = (q.area?.center ?? [pos()[0], pos()[2]]) as P2;
  const anchor3: P3 = [anchor[0], 0, anchor[1]];
  for (let guard = 0; guard < o.required * 4 && !objectiveDone(q, o); guard++) {
    recoverIfDead();
    let candidates = liveTargets(o.target);
    if (candidates.length === 0 && areas.length) {
      // wake the nearest pack of this template (a player inside its radius does it)
      const a = [...areas].sort((x, y) => d2(anchor3, x.position) - d2(anchor3, y.position))[0]!;
      notes.push(`woke ${a.id}${q.area ? ` (${Math.round(d2(anchor3, a.position))} m from the quest area centre)` : ""}`);
      const fail = reach([a.position[0], (terrain?.groundHeight(a.position[0], a.position[2]) ?? a.position[1]) + 1.2, a.position[2]], `kill: reach ${a.id}`, q.id, a.data.radius * 0.6);
      if (fail) return { result: "failed", how: notes.join("; "), reason: fail };
      tick(40);
      candidates = liveTargets(o.target);
      if (candidates.length === 0) { waitFor(() => liveTargets(o.target).length > 0, 25); candidates = liveTargets(o.target); }
    }
    if (candidates.length === 0) {
      // an authored creature (a boss, a named one) sleeps while no player is near (NpcManager dormancy): go to it to wake it
      const sleeping = [...world.entities].filter(([id, e]) => e.parent === null && id !== BODY && server.paused.has(id) && !dead(id) && killMatch(id, o.target)).map(([id]) => id);
      const at = sleeping.map((id) => [id, world.positionOf(id)] as const).filter((x): x is readonly [string, P3] => !!x[1]).sort((x, y) => d2(pos(), x[1]) - d2(pos(), y[1]))[0];
      if (at) {
        notes.push(`woke the sleeping ${at[0]}`);
        const fail = reach([at[1][0], at[1][1] + 1.2, at[1][2]], `kill: reach ${at[0]}`, q.id, 8);
        if (fail) return { result: "failed", how: notes.join("; "), reason: fail };
        waitFor(() => liveTargets(o.target).length > 0, 5);
        candidates = liveTargets(o.target);
      }
    }
    if (candidates.length === 0) return { result: "failed", how: notes.join("; "), reason: `no live entity matches kill target "${o.target}"` };
    const here = pos();
    const victim = candidates.sort((a, b) => d2(here, world.positionOf(a)!) - d2(here, world.positionOf(b)!))[0]!;
    const vp = world.positionOf(victim)!;
    killSite = vp;
    if (d2(here, vp) > 6) {
      const fail = reach(standPoint(vp, 2.5), `kill: reach ${victim}`, q.id, 4);
      if (fail) return { result: "failed", how: notes.join("; "), reason: fail };
    }
    // the fight: steer at it and ask for strikes, as a client does
    const before = kills.length;
    let died = false;
    const won = (): boolean => kills.slice(before).some((k) => k.victimId === victim && k.killerId === BODY);
    const bags0 = bagTotals();
    // 90 s, extended (up to 5 min) while the victim is still losing health: a boss is a long fight, not a stalemate
    let hpMark = Number(net.get(`combat/${victim}.hp`));
    let limit = 60 * 90;
    for (let t = 0; t < limit && !won(); t++) {
      if (t > 0 && t % (60 * 30) === 0) {
        const hpNow = Number(net.get(`combat/${victim}.hp`));
        if (limit - t <= 60 * 30 && hpNow < hpMark && limit < 60 * 300) limit += 60 * 30;
        hpMark = hpNow;
      }
      if (dead(BODY)) { died = true; break; }
      // this gate proves the kill COUNTS for the quest, not that a starter body out-fights the pack: the tool keeps
      // the body alive and says how much health that took (a balance note for the designer)
      if (t % 30 === 0) {
        const hpNow = Number(net.get("combat/" + BODY + ".hp"));
        const hpMax = Number(net.get("combat/" + BODY + ".maxHp") ?? hpNow);
        if (Number.isFinite(hpNow) && hpNow < hpMax * 0.4) { killRestored += hpMax - hpNow; net.set("combat/" + BODY + ".hp", hpMax); }
      }
      const p = pos();
      const v = world.positionOf(victim);
      if (!v || dead(victim)) break;
      const dx = v[0] - p[0];
      const dz = v[2] - p[2];
      const l = Math.hypot(dx, dz) || 1;
      const move: [number, number] = l > 1.6 ? [(dx / l) * RUN, (dz / l) * RUN] : [0, 0];
      if (l < 2.3 && t % 20 === 0) sendEvent("combat.cast.request", { casterId: BODY, abilityId: "strike", aim: [dx / l, dz / l] });
      stepWith(move, false);
    }
    tick(20);
    if (limit > 60 * 90) notes.push(`a long fight: ${Math.round(limit / 60)} s allowed while ${victim} kept losing health`);
    if (won()) { real++; takeLootBags(); const bags1 = bagTotals(); for (const [item, n] of Object.entries(bags1)) if (n > (bags0[item] ?? 0)) lootGains[item] = (lootGains[item] ?? 0) + n - (bags0[item] ?? 0); continue; }
    if (died) { notes.push(`the player died fighting ${victim}`); recoverIfDead(); }
    if (!dead(victim) && world.entities.has(victim)) {
      {
        const vp2 = world.positionOf(victim);
        const bp = pos();
        notes.push(`${victim} still at ${Math.round(Number(net.get(`combat/${victim}.hp`)))}/${Math.round(Number(net.get(`combat/${victim}.maxHp`)))} hp after the fight (${vp2 ? `${d2(bp, vp2).toFixed(1)} m away, dy ${(vp2[1] - bp[1]).toFixed(1)}` : "gone"})`);
      }
      // the narrowest authority-side kill: one combat.damage from the player (what a landed hit becomes)
      const at = world.positionOf(victim)!;
      world.eventBus.emit("combat.damage", { targetId: victim, sourceId: BODY, amount: 1e6, control: 0, point: at });
      tick(20);
      if (kills.some((k) => k.victimId === victim && k.killerId === BODY)) { simulated++; notes.push(`${victim}: authority combat.damage after the cast-request fight did not finish it`); }
    }
    tick(15);
  }
  const ok = waitFor(() => objectiveDone(q, o), 1);
  real = kills.slice(kills0).filter((k) => k.killerId === BODY && killMatch(k.victimId, o.target)).length - simulated; // a cone can drop two
  const how = `${real} kill(s) by the player's own strike requests${simulated ? `, ${simulated} by authority combat.damage` : ""}${notes.length ? `; ${notes.join("; ")}` : ""}${killRestored ? `; BALANCE NOTE: the tool restored ${Math.round(killRestored)} hp during the fight` : ""}`;
  if (!ok) return { result: "failed", how, reason: `objective at ${progressOf(q, o.id)}/${o.required} after ${real + simulated} kill(s)` };
  return { result: simulated ? "simulated" : "proven", how: simulated ? `kill: simulated — ${how}` : how };
}

/**
 * A creature's drops land in a loot bag of the killer's at the corpse (netState lootbag/<id>), not in the grid bag:
 * take everything from each earned bag of the player's, as a player stands over the body and presses take-all.
 */
function takeLootBags(): void {
  for (const key of net.keys("lootbag/")) {
    const b = net.get(key) as { owner?: string; body?: string; dropped?: boolean } | undefined;
    if (b?.owner !== BODY || b.body !== undefined || b.dropped) continue;
    sendEvent("inventory.loot", { actorId: BODY, bagId: key.slice("lootbag/".length), all: true });
  }
  tick(10);
}
/** The kill target (`tag:creature:<id>`) of a creature whose template drops the item, or "". */
function dropperOf(item: string): string {
  const drops = (loot: unknown): boolean => String(loot ?? "").split(",").some((x) => x.trim().split(":")[0] === item);
  // a real-bodied creature is one prefab instance: its loot is an override of the prefab's combat-actor
  for (const e of Object.values(doc!.entities)) {
    const pf = e.components["prefab"] as { overrides?: { path: string; value: unknown }[] } | undefined;
    if (!pf?.overrides?.some((o) => o.path.endsWith("/script/params/loot") && drops(o.value))) continue;
    const tag = e.tags.find((t) => t.startsWith("creature:"));
    if (tag) return "tag:" + tag;
  }
  for (const [id, e] of Object.entries(doc!.entities)) {
    const sc = e.components["script"] as { name?: string; params?: { loot?: string } } | undefined;
    if (sc?.name !== "combat-actor" || !String(sc.params?.loot ?? "").split(",").some((x) => x.trim().split(":")[0] === item)) continue;
    let root = id;
    for (let k = 0; k < 8 && doc!.entities[root]?.parent; k++) root = doc!.entities[root]!.parent!;
    const tag = doc!.entities[root]?.tags.find((t) => t.startsWith("creature:"));
    if (tag) return "tag:" + tag;
  }
  return "";
}
/** Items this tool granted itself (authority inventory.give), by item id: such goods are never counted as honest. */
const toolGranted: Record<string, number> = {};
function doCollect(q: Quest, o: Quest["objectives"][number], source: string): Omit<ObjectiveRow, "id" | "kind" | "target" | "required" | "progress"> {
  if (!content.assets.getDataAsset(o.target)) return { result: "failed", how: "", reason: `collect target "${o.target}" is not an item asset` };
  if (objectiveDone(q, o)) {
    if (source === "dialogue") return { result: "proven", how: `handed over by the giver's dialogue (give ${o.target})` };
    // carried on arrival, never granted by this tool, and a creature in the scene drops it: the player looted it from
    // kills earlier in the run (a hold-the-causeway fight, another quest's kills)
    if (!(toolGranted[o.target] ?? 0) && dropperOf(o.target)) return { result: "proven", how: `collect: ${owned(o.target)} ${o.target} already looted from ${dropperOf(o.target)} kills earlier in this run; the objective completed on acceptance` };
    if ((lootGains[o.target] ?? 0) >= o.required) return { result: "proven", how: `collect: ${lootGains[o.target]} ${o.target} dropped by creatures the player killed earlier in this run; the objective completed on acceptance` };
    return { result: "simulated", how: `collect: already carried before the quest began (${source}) — no source named in the quest data; the objective completed the moment it was accepted` };
  }
  // honest sources first. (1) something in the scene whose dialogue hands it over (a cask, a cart, a seller)
  const tried: string[] = [];
  for (const id of world.entities.keys()) {
    if (objectiveDone(q, o)) break;
    const n = npcInfo(id);
    if (!n || !dialogueHas(n.dialogue, (x) => x.do === "give" && x.item === o.target)) continue;
    if (n.presence) driveCondition(n.presence, true);
    const unreached = reachNpc(n, "collect " + o.target + " from " + n.id, q.id);
    if (unreached) { tried.push(n.id + ": " + unreached); continue; }
    let path: string[] = [];
    for (let k = 0; k < o.required * 2 && !objectiveDone(q, o); k++) {
      const before = owned(o.target);
      const r = converse(n, (x) => x.do === "give" && x.item === o.target, () => owned(o.target) > before);
      if (!r.ok) { tried.push(n.id + ": " + r.reason); break; }
      path = r.path;
      tick(20);
    }
    if (waitFor(() => objectiveDone(q, o), 1)) return { result: "proven", how: o.target + " handed over by " + n.id + " (" + path.join(" -> ") + ")" };
  }
  // (2) a creature whose template (a combat-actor, or a prefab body's loot override) drops it: kill those until enough have dropped
  const dropper = dropperOf(o.target);
  if (dropper) {
    // drops are a chance per kill: doKill allows four kills per item wanted and stops when THIS objective is done
    const r = doKill(q, { ...o, target: dropper } as Quest["objectives"][number]);
    if (objectiveDone(q, o)) return { result: r.result === "simulated" ? "simulated" : "proven", how: "looted from " + dropper + ": " + r.how };
    tried.push(`${dropper}: ${r.result}${r.reason ? ` (${r.reason})` : ""}; ${owned(o.target)} carried, objective ${progressOf(q, o.id)}/${o.required}`);
  }
  // no source is named in quest data: grant it (authority-internal inventory.give) and say so
  const need = o.required - progressOf(q, o.id);
  toolGranted[o.target] = (toolGranted[o.target] ?? 0) + need;
  world.eventBus.emit("inventory.give", { actorId: BODY, itemId: o.target, qty: need });
  const ok = waitFor(() => objectiveDone(q, o), 1.5);
  return ok ? { result: "simulated", how: `collect: granted ${need} ${o.target} by inventory.give (no source named in the quest data${tried.length ? `; sources tried: ${tried.join(" | ")}` : ""})` } : { result: "failed", how: "", reason: `granting ${need} ${o.target} did not advance the objective (bags full?)` };
}


// ---- block proofs: every registered action / condition / consequence / source quest-play can drive ---------------------
// A quest naming a block that is not registered, or registered but without a proof here, FAILS: an unproven block must
// never pass as if it worked.
type Res = Omit<ObjectiveRow, "id" | "kind" | "target" | "required" | "progress">;
type Objective = Quest["objectives"][number];
/** Kinds whose driver can be run once more without consuming anything (used for the order and `when` gate proofs). */
const REPEATABLE = new Set(["visit", "talk", "interact", "read", "perform", "endure"]);
const questLogParams = ((): Record<string, unknown> => {
  for (const e of Object.values(template.entities)) {
    const s = e.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
    if (s?.name === "quest-log") return s.params ?? {};
  }
  return {};
})();
const autoOffer = new Set<string>((questLogParams["autoOffer"] as string[] | undefined) ?? []);
const performCooldown = typeof questLogParams["performCooldown"] === "number" ? (questLogParams["performCooldown"] as number) : 1.5;
const performVocab = ((): Set<string> => {
  const names = new Set(DEFAULT_PERFORM_ACTIONS.map((a) => a.name));
  const id = String(questLogParams["performActions"] ?? "");
  const a = id ? content.assets.getDataAsset(id) : undefined;
  if (a?.type === "performActions") for (const x of (a.data as { actions: Array<{ name: string }> }).actions) names.add(x.name);
  return names;
})();
const entityAt = (id: string): P3 | null => (world.entities.has(id) ? (world.positionOf(id) ?? null) : null);
const groundAt = (x: number, z: number): P3 => [x, (terrain ? terrain.groundHeight(x, z) : pos()[1] - 1.2) + 1.2, z];
function worldNow(): WorldFacts {
  const w = net.get(WORLD_WEATHER_KEY) as { precipitation?: number; storm?: number } | undefined;
  const p = pos();
  return {
    hour: typeof net.get(WORLD_HOUR_KEY) === "number" ? (net.get(WORLD_HOUR_KEY) as number) : null,
    weather: w && typeof w.precipitation === "number" ? { precipitation: w.precipitation, storm: w.storm ?? 0 } : null,
    biome: terrain ? terrain.resolved.field.biome(p[0], p[2]).id : null,
  };
}
function reachEntity(id: string, purpose: string, q: Quest, within = INTERACT_RANGE): string | null {
  const at = entityAt(id);
  if (!at) return `entity "${id}" is not in the scene`;
  for (const s of standPoints(at, Math.min(2, within * 0.6)).slice(0, 6)) {
    reach(s, purpose, q.id);
    const p = pos();
    if (Math.hypot(p[0] - at[0], p[2] - at[2]) <= within && Math.abs(p[1] - at[1]) < 4) return null;
  }
  return `could not stand within ${within} m of ${id}`;
}

function doInteract(q: Quest, o: Objective): Res {
  const at = entityAt(o.target);
  if (!at) return { result: "failed", how: "", reason: `interact target "${o.target}" is not in the scene` };
  const p0 = progressOf(q, o.id);
  teleport(standPoint(at, 12));
  sendEvent(QUEST_EVENTS.interact, { actorId: BODY, entityId: o.target });
  tick(30);
  if (progressOf(q, o.id) > p0) return { result: "failed", how: "", reason: `a player.interact from ${d2(pos(), at).toFixed(0)} m counted — the range check is missing` };
  const fail = reachEntity(o.target, `interact ${o.target}`, q);
  if (fail) return { result: "failed", how: "", reason: fail };
  for (let i = 0; i < o.required * 2 && !objectiveDone(q, o); i++) { sendEvent(QUEST_EVENTS.interact, { actorId: BODY, entityId: o.target }); tick(20); }
  return waitFor(() => objectiveDone(q, o), 1.5)
    ? { result: "proven", how: `player.interact at ${o.target} (a request from 12 m was refused)` }
    : { result: "failed", how: "", reason: `interacting with ${o.target} did not advance the objective` };
}

function doDeliver(q: Quest, o: Objective & { kind: "deliver" }): Res {
  if (content.assets.getDataAsset(o.item)?.type !== "item") return { result: "failed", how: "", reason: `deliver item "${o.item}" is not an item asset` };
  const need = o.required - progressOf(q, o.id);
  const had = owned(o.item);
  // the honest source first: an NPC in the scene whose dialogue hands the item over (a sale, a gift)
  let bought = "";
  if (had < need) {
    for (const id of world.entities.keys()) {
      if (owned(o.item) >= need) break;
      const n = npcInfo(id);
      if (!n || !dialogueHas(n.dialogue, (a) => a.do === "give" && a.item === o.item)) continue;
      if (n.presence) driveCondition(n.presence, true);
      if (reachNpc(n, `get ${o.item} from ${n.id}`, q.id)) continue;
      for (let k = 0; k < need && owned(o.item) < need; k++) {
        const before = owned(o.item);
        const r = converse(n, (a) => a.do === "give" && a.item === o.item, () => owned(o.item) > before);
        if (!r.ok) { bought = `${n.id} would not hand it over: ${r.reason}`; break; }
        bought = `${o.item} handed over by ${n.id} (${r.path.join(" -> ")})`;
      }
    }
  }
  const got = owned(o.item);
  if (got < need) { toolGranted[o.item] = (toolGranted[o.item] ?? 0) + need - got; world.eventBus.emit("inventory.give", { actorId: BODY, itemId: o.item, qty: need - got }); tick(10); }
  if (owned(o.item) < need) return { result: "failed", how: "", reason: `could not carry ${need} ${o.item} to the hand-in${bought ? ` (${bought})` : ""}; inventory.give did not land either (bags full?)` };
  const fail = reachEntity(o.target, `deliver to ${o.target}`, q);
  if (fail) return { result: "failed", how: "", reason: fail };
  const before = owned(o.item);
  sendEvent(QUEST_EVENTS.interact, { actorId: BODY, entityId: o.target });
  const ok = waitFor(() => objectiveDone(q, o), 1.5);
  const taken = before - owned(o.item);
  if (!ok) return { result: "failed", how: "", reason: `interacting at ${o.target} with ${before} ${o.item} did not advance the objective` };
  if (taken < need) return { result: "failed", how: "", reason: `the objective advanced but only ${taken}/${need} ${o.item} left the bags` };
  const how = `${taken} ${o.item} taken from the bags at ${o.target}${lootGains[o.item] ? ` (it dropped from the player's own kill earlier in this run: ${lootGains[o.item]} looted)` : ""}`;
  if (got >= need) return { result: "proven", how: bought && had < need ? `${bought}; ${how}` : how };
  return { result: "simulated", how: `deliver: ${how}; ${need - got} granted by inventory.give first (${bought || "no NPC in the scene hands it over"})` };
}

function doRead(q: Quest, o: Objective): Res {
  const n = npcInfo(o.target);
  if (!n) return { result: "failed", how: "", reason: `read target "${o.target}" is not an npc-builtin entity` };
  if (!n.readable) return { result: "failed", how: "", reason: `read target ${o.target} is not readable (npc param readable: true)` };
  const fail = reachNpc(n, `read ${o.target}`, q.id);
  if (fail) return { result: "failed", how: "", reason: fail };
  sendEvent("npc.talk", { actorId: BODY, npcId: n.id });
  tick(4);
  const text = conversation()?.npc === n.id ? conversation()!.text : "";
  const ok = waitFor(() => objectiveDone(q, o), 1.5);
  if (conversation()?.npc === n.id) { sendEvent("npc.leave", { actorId: BODY, npcId: n.id }); tick(3); }
  if (!ok) return { result: "failed", how: "", reason: `opening ${n.id} did not advance the objective` };
  if (!text || /[{}]|\bsomewhere\b/.test(text)) return { result: "failed", how: "", reason: `its text did not resolve: ${JSON.stringify(text)}` };
  return { result: "proven", how: `opened ${n.id}; text resolved: ${JSON.stringify(text.slice(0, 60))}` };
}

function doPerform(q: Quest, o: Objective & { kind: "perform" }): Res {
  if (!performVocab.has(o.action)) return { result: "failed", how: "", reason: `"${o.action}" is not in the perform vocabulary (engine + the quest-log's performActions)` };
  const area = objectiveArea(q, o);
  if (o.target) {
    const fail = reachEntity(o.target, `perform at ${o.target}`, q, Math.min(o.range, INTERACT_RANGE));
    if (fail) return { result: "failed", how: "", reason: fail };
  } else if (area) teleport(groundAt(area.center[0], area.center[1]));
  const wait = Math.ceil(performCooldown * 60) + 6;
  const p0 = progressOf(q, o.id);
  const here = pos();
  sendEvent(QUEST_EVENTS.perform, { actorId: BODY, action: o.action, at: [here[0] + 30, here[1], here[2]] });
  tick(wait);
  if (progressOf(q, o.id) > p0) return { result: "failed", how: "", reason: "a perform claimed 30 m from the body counted — the position check is missing" };
  for (let i = 0; i < o.required * 2 && !objectiveDone(q, o); i++) { sendEvent(QUEST_EVENTS.perform, { actorId: BODY, action: o.action, at: pos() }); tick(wait); }
  return waitFor(() => objectiveDone(q, o), 1)
    ? { result: "proven", how: `player.perform "${o.action}"${o.target ? ` within ${o.range} m of ${o.target}` : area ? ` in ${area.label}` : ""} (a claim 30 m off was refused)` }
    : { result: "failed", how: "", reason: `performing "${o.action}" did not advance the objective` };
}

function doEndure(q: Quest, o: Objective & { kind: "endure" }): Res {
  const area = objectiveArea(q, o);
  if (!area) return { result: "failed", how: "", reason: "endure without an area (objective or quest)" };
  const inside = groundAt(area.center[0], area.center[1]);
  // A place worth enduring is usually held by something. The body stands its ground and strikes whatever comes into
  // reach, as a player would; it never chases, so it stays in the area. A death restarts the count (up to 3 tries).
  let fought = 0;
  /** Health the tool gave back: this gate proves the step's logic (area, window, seconds), not combat balance. */
  let restored = 0;
  const holdGround = (seconds: number, until?: () => boolean): boolean => {
    for (let t = 0; t < Math.round(seconds * 60); t++) {
      if (until?.()) return true;
      if (t % 30 === 0 && !dead(BODY)) {
        const hpNow = Number(net.get(`combat/${BODY}.hp`));
        const hpMax = Number(net.get(`combat/${BODY}.maxHp`) ?? hpNow);
        if (Number.isFinite(hpNow) && hpNow < hpMax * 0.4) { restored += hpMax - hpNow; net.set(`combat/${BODY}.hp`, hpMax); }
      }
      if (t % 20 === 0 && !dead(BODY)) {
        const p = pos();
        let best: P3 | null = null;
        let bestD = 2.6;
        for (const [id, e] of world.entities) {
          if (e.parent !== null || id === BODY || !e.tags.includes("npc") || dead(id) || typeof net.get(`combat/${id}.hp`) !== "number") continue;
          const at = world.positionOf(id);
          if (!at) continue;
          const d = Math.hypot(at[0] - p[0], at[2] - p[2]);
          if (d < bestD) { bestD = d; best = at; }
        }
        if (best) { fought++; sendEvent("combat.cast.request", { casterId: BODY, abilityId: "strike", aim: [(best[0] - p[0]) / (bestD || 1), (best[2] - p[2]) / (bestD || 1)] }); }
      }
      tick();
    }
    return until?.() ?? false;
  };
  teleport(inside);
  holdGround(o.seconds * 0.6);
  recoverIfDead();
  teleport(groundAt(area.center[0] + area.radius + 25, area.center[1]));
  tick(30);
  if (objectiveDone(q, o)) return { result: "failed", how: "", reason: "completed although the body left the area before its seconds were up" };
  const deaths0 = deaths;
  let ok = false;
  let took = 0;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    recoverIfDead();
    teleport(inside);
    const t1 = world.timeMs;
    const d1 = deaths;
    ok = holdGround(o.seconds + 2, () => objectiveDone(q, o) || deaths > d1) && objectiveDone(q, o);
    took = (world.timeMs - t1) / 1000;
  }
  if (!ok) {
    const p = pos();
    const hour = net.get(WORLD_HOUR_KEY);
    return { result: "failed", how: "", reason: `standing ${o.seconds + 2} s inside ${area.label} did not complete it (now ${Math.round(Math.hypot(p[0] - area.center[0], p[2] - area.center[1]))} m from its centre, hp ${net.get(`combat/${BODY}.hp`)}${dead(BODY) ? ", DEAD" : ""}, hour ${typeof hour === "number" ? hour.toFixed(1) : hour}, deaths during the wait: ${deaths - deaths0})` };
  }
  if (took < o.seconds - 0.6) return { result: "failed", how: "", reason: `completed ${took.toFixed(1)} s after coming back: leaving did not start the count over` };
  return { result: "proven", how: `stood ${took.toFixed(1)} s in ${area.label} after leaving midway reset the count${fought ? `; struck back ${fought} time(s)` : ""}${restored ? `; BALANCE NOTE: the tool restored ${Math.round(restored)} hp, a level-${sheet()?.level ?? "?"} body standing here unaided would have died` : ""}${deaths > deaths0 ? `; died ${deaths - deaths0} time(s) holding it before the try that succeeded` : ""}` };
}

const DRIVERS: Record<string, (q: Quest, o: Objective) => Res> = {
  visit: (q, o) => doVisit(q, o),
  kill: (q, o) => doKill(q, o),
  talk: (q, o) => doTalk(q, o),
  collect: () => ({ result: "failed", how: "", reason: "collect is driven with its source (handled by the caller)" }),
  interact: (q, o) => doInteract(q, o),
  read: (q, o) => doRead(q, o),
  deliver: (q, o) => doDeliver(q, o as Objective & { kind: "deliver" }),
  perform: (q, o) => doPerform(q, o as Objective & { kind: "perform" }),
  endure: (q, o) => doEndure(q, o as Objective & { kind: "endure" }),
};

/** Condition proofs: `set` makes a WORLD condition hold or break; character conditions are checked, not forced. */
const CONDITIONS: Record<string, { set?: (c: DialogueCondition, hold: boolean) => void }> = {
  clock: {
    set: (c, hold) => {
      const w = c.clock!;
      const len = (w.to - w.from + 24) % 24 || 24;
      const hour = hold ? (w.from + len / 2) % 24 : (w.to + (24 - len) / 2) % 24;
      // through the day-night script's own /time command, then frozen: the authority's clock republishes its OWN hour
      // every few seconds, so a bare netState write lasts long enough for a talk but not for a 90 s endure step
      const set = world.scripts.runConsoleCommand("time", [String(hour)]);
      if (set?.ok) world.scripts.runConsoleCommand("time", ["freeze"]);
      else net.set(WORLD_HOUR_KEY, hour);
      tick(2);
    },
  },
  weather: {
    set: (c, hold) => {
      const w = c.weather!;
      const cur = (net.get(WORLD_WEATHER_KEY) as Record<string, number> | undefined) ?? {};
      const lo = w.min ?? 0;
      const hi = w.max ?? 1;
      const p = hold ? (lo + hi) / 2 : lo > 0 ? lo / 2 : hi < 1 ? (hi + 1) / 2 : 0;
      const storm = hold ? Math.max(w.storm ?? 0, cur["storm"] ?? 0) : w.storm ? 0 : (cur["storm"] ?? 0);
      // through the weather script's own command, which PINS the front: a bare netState write is overwritten the next
      // time the authority's weather rolls (a presence that needs rain was gone again by the delivery step)
      const mode = p >= 0.55 || storm > 0.3 ? "storm" : p >= 0.25 ? "light" : p > 0.05 ? "drizzle" : "clear";
      const set = world.scripts.runConsoleCommand("weather", [mode]);
      tick(30);
      const now = net.get(WORLD_WEATHER_KEY) as { precipitation?: number } | undefined;
      const got = now?.precipitation ?? -1;
      if (!set?.ok || (hold ? got < lo || got > hi : got >= lo && got <= hi)) {
        net.set(WORLD_WEATHER_KEY, { wind: 0, windAngle: 0, strike: 0, until: 1e12, ...cur, precipitation: p, storm });
        tick(2);
      }
    },
  },
  quest: {}, flag: {}, level: {}, item: {}, coins: {},
};
/** The plain conditions inside a condition: an `all` wrapper is opened (recursively), anything else is one leaf. */
function conditionLeaves(c: DialogueCondition): DialogueCondition[] {
  const all = (c as { all?: DialogueCondition[] }).all;
  return Array.isArray(all) ? all.flatMap(conditionLeaves) : [c];
}
/** Make every drivable world part of a condition hold (or not hold). Returns how many parts were driven. */
function driveCondition(c: DialogueCondition, hold: boolean): number {
  let n = 0;
  for (const leaf of conditionLeaves(c)) for (const k of Object.keys(leaf)) { const set = CONDITIONS[k]?.set; if (set) { set(leaf, hold); n++; } }
  return n;
}
const CONSEQUENCE_BLOCK: Record<string, string> = { setFlag: "flag", clearFlag: "flag" };

/** Topological order of a quest's objectives (`after` first). */
function ordered(q: Quest): Objective[] {
  const out: Objective[] = [];
  const left = [...q.objectives];
  while (left.length) {
    const i = left.findIndex((o) => o.after.every((a) => out.some((x) => x.id === a)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

/** Problems with the blocks a quest names: unregistered, or registered without a proof here. */
function blockProblems(q: Quest): string[] {
  const out: string[] = [];
  const src = questSource(q);
  if (!questBlocks.has("source", src.kind)) out.push(`source "${src.kind}" is not a registered quest block`);
  const conds = (c: DialogueCondition | undefined, where: string): void => {
    for (const name of conditionBlockNames(c)) {
      if (!questBlocks.has("condition", name)) out.push(`${where}: condition "${name}" is not a registered quest block`);
      else if (!CONDITIONS[name]) out.push(`${where}: condition block "${name}" has no quest-play proof — it cannot pass`);
    }
  };
  if (src.kind === "auto") conds(src.when, "source");
  for (const o of q.objectives) {
    if (!questBlocks.has("action", o.kind)) out.push(`objective ${o.id}: action "${o.kind}" is not a registered quest block`);
    else if (!DRIVERS[o.kind]) out.push(`objective ${o.id}: action block "${o.kind}" has no quest-play proof — it cannot pass`);
    conds(o.when, `objective ${o.id}`);
    for (const t of o.then) {
      const name = CONSEQUENCE_BLOCK[t.do] ?? t.do;
      if (!questBlocks.has("consequence", name)) out.push(`objective ${o.id}: consequence "${t.do}" is not a registered quest block`);
    }
    if (o.places && content.assets.getDataAsset(o.places)?.type !== "places") out.push(`objective ${o.id}: places "${o.places}" is not a places asset`);
    if ((o.kind === "visit" || o.kind === "endure") && !objectiveArea(q, o)) out.push(`objective ${o.id}: ${o.kind} without an area (objective or quest)`);
    if (o.scene && o.scene !== sceneName) {
      // a step in an instance: its target is checked in that scene's doc (the instance boots on the trip there)
      const d = content.scenes.get(o.scene);
      if (!d) { out.push(`objective ${o.id}: scene "${o.scene}" does not exist`); continue; }
      if (!docPortalsTo(home.doc, o.scene).length) out.push(`objective ${o.id}: no portal in ${sceneName} leads to its scene ${o.scene}`);
      if (["interact", "deliver", "read", "talk", "perform"].includes(o.kind) && o.target && !d.entities[o.target]) out.push(`objective ${o.id}: ${o.kind} target "${o.target}" is not in scene ${o.scene}`);
      continue;
    }
    if ((o.kind === "interact" || o.kind === "deliver") && !world.entities.get(o.target)?.tags.includes("interactable")) out.push(`objective ${o.id}: ${o.kind} target "${o.target}" is not an interactable entity`);
    if (o.kind === "read" && !npcInfo(o.target)?.readable) out.push(`objective ${o.id}: read target "${o.target}" is not a readable npc entity`);
    if (o.kind === "perform" && o.target && !world.entities.has(o.target)) out.push(`objective ${o.id}: perform target "${o.target}" is not in the scene`);
  }
  return out;
}

/** One objective through its block driver, with the `when` gate proven first and its `then` checked after. */
function runObjective(q: Quest, o: Objective): Res {
  const driver = DRIVERS[o.kind];
  if (!driver) return { result: "failed", how: "", reason: `no quest-play proof for action block "${o.kind}"` };
  const drivable = o.when ? Object.keys(o.when).filter((k) => CONDITIONS[k]?.set) : [];
  const notes: string[] = [];
  if (o.when && drivable.length && REPEATABLE.has(o.kind)) {
    for (const k of drivable) CONDITIONS[k]!.set!(o.when, false);
    const p0 = progressOf(q, o.id);
    driver(q, o);
    if (progressOf(q, o.id) > p0) return { result: "failed", how: "", reason: `progressed while its \`when\` (${drivable.join(", ")}) did not hold — the gate is missing` };
    notes.push(`no progress while ${drivable.join("+")} did not hold`);
  }
  for (const k of drivable) CONDITIONS[k]!.set!(o.when!, true);
  const res = driver(q, o);
  if (res.result === "failed") return res;
  if (o.when?.weather?.biomes?.length) {
    const b = worldNow().biome;
    if (!b || !o.when.weather.biomes.includes(b)) return { result: "failed", how: res.how, reason: `completed in biome "${b}", outside the condition's ${o.when.weather.biomes.join("/")}` };
    notes.push(`biome ${b}`);
  }
  for (const t of o.then) {
    const flags = (net.get(`npc/${BODY}`) as NpcMemory | undefined)?.flags ?? {};
    const set = flags[t.flag] === true;
    if (t.do === "setFlag" ? !set : set) return { result: "failed", how: res.how, reason: `then ${t.do} "${t.flag}" did not happen` };
    notes.push(`then ${t.do} ${t.flag}`);
  }
  return notes.length ? { ...res, how: `${res.how}; ${notes.join("; ")}` } : res;
}

// ---- portal trips: a step in an instance scene ----------------------------------------------------------------------
// The body goes the way a player does: to the world scene's portal into the instance, THROUGH it (a walk-through
// trigger is walked into with movement intents; an interact portal gets a player.interact), and the `portal` builtin
// decides (range, condition, arrival grace) and emits portal.travel. The trip is then serve()'s transfer without
// sockets: the portal record (portalDeparture), a commit of playerSnapshot to the PlayerStore, the handoff, the
// client's bye, and a join on the destination host that LOADS that save (arrivalFor puts it on the anchor, or back at
// the way back). Nothing is copied across by hand: journal, sheet, bags and coins arrive through the save.
interface TripRow {
  from: string; to: string; portal: string; mode: string; ok: boolean; how: string; reason?: string;
  anchor?: string | null; at?: P3; carried?: { journal: boolean; bags: boolean; coins: boolean; xp: boolean; rev: Record<string, number> };
}
const trips: TripRow[] = [];
type PortalParams = Record<string, unknown> & { scene?: string; anchor?: string; mode?: string; back?: boolean; returnAnchor?: string };
const portalOf = (id: string): PortalParams | null => {
  const s = world.expanded.entities[id]?.components["script"] as { name?: string; params?: PortalParams } | undefined;
  return s?.name === "portal" ? (s.params ?? {}) : null;
};
/** Portals in the current scene that lead to `scene` (a way back when going home: `back` or naming the scene). */
function portalsTo(scene: string): string[] {
  const out: string[] = [];
  for (const id of world.entities.keys()) {
    const p = portalOf(id);
    if (!p) continue;
    if (scene === sceneName ? p.back === true || p.scene === scene : p.scene === scene && p.back !== true) out.push(id);
  }
  return out;
}
/** Every portal of a scene doc that leads to `scene` (static check, before the instance is booted). */
function docPortalsTo(d: SceneDoc, scene: string): string[] {
  return Object.entries(d.entities).filter(([, e]) => {
    const s = e.components["script"] as { name?: string; params?: PortalParams } | undefined;
    return s?.name === "portal" && s.params?.scene === scene && s.params.back !== true;
  }).map(([id]) => id);
}
const sameItems = (a: CharacterSheet | undefined, b: CharacterSheet | undefined): boolean => {
  const tally = (s: CharacterSheet | undefined): string => JSON.stringify(Object.values(s?.items ?? {}).map((x) => `${x.itemId}:${x.qty}`).sort());
  return tally(a) === tally(b);
};
/** Walk into / interact with a portal of the current scene until the builtin sends the body. */
function usePortal(id: string, approach: P3 | null): { travel: PortalTravel | null; how: string; reason?: string } {
  const p = portalOf(id)!;
  const mode = p.mode === "trigger" ? "trigger" : "interact";
  // a fresh arrival's grace (the builtin refuses for a moment after landing) runs out first
  tick(Math.round((Number(p["arrivalGrace"] ?? 2) + 0.5) * 60));
  current.travels.length = 0;
  current.refusals.length = 0;
  if (mode === "interact") {
    const fail = reachEntity(id, `portal ${id}`, { id: "portal" } as Quest);
    if (fail) return { travel: null, how: "", reason: fail };
    sendEvent(QUEST_EVENTS.interact, { actorId: BODY, entityId: id });
    for (let i = 0; i < 60 && !current.travels.length; i++) tick();
    const travel = current.travels.shift() ?? null;
    return travel ? { travel, how: `player.interact at ${id}` } : { travel, how: "", reason: `interacting with ${id} sent nobody${current.refusals.length ? ` (refused: "${current.refusals.at(-1)}")` : ""}` };
  }
  const vol = portalVolumeOf(p);
  const obj = world.objects.get(id);
  if (!vol || !obj) return { travel: null, how: "", reason: `${id} is a trigger portal without a volume` };
  obj.updateWorldMatrix(true, false);
  const c = obj.localToWorld(new THREE.Vector3(...vol.offset));
  const centre: P3 = [c.x, c.y, c.z];
  // where to come from: the given approach (the anchor the body landed on), else the portal's own way-back anchor,
  // else 4 m out along the portal's facing
  let from = approach;
  if (!from && p.returnAnchor && world.entities.has(p.returnAnchor)) from = world.positionOf(p.returnAnchor);
  if (!from) { const f = obj.localToWorld(new THREE.Vector3(vol.offset[0], vol.offset[1], vol.offset[2] + 4)); from = [f.x, f.y, f.z]; }
  // a landed body position is known floor: stand exactly there (a ring probe can pick a lintel above a passage)
  teleport(approach ?? standPoints(from, 0.4)[0]!);
  // the portal refuses a body still locked by a fight ("You cannot leave in the middle of a fight"): wait it out, as a
  // player does, before walking in
  let waited = 0;
  for (; waited < 60 * 60 && !server.canTransfer(PEER); waited++) tick();
  const start = pos();
  const dx = centre[0] - start[0];
  const dz = centre[2] - start[2];
  const d = Math.hypot(dx, dz) || 1;
  const reachOut = Math.max(vol.half[0], vol.half[2]) * 2 + 1;
  const target: P2 = [centre[0] + (dx / d) * reachOut, centre[2] + (dz / d) * reachOut];
  const startedAt = pos();
  for (let i = 0; i < 60 * 20 && !current.travels.length; i++) {
    const q = pos();
    const tx = target[0] - q[0];
    const tz = target[1] - q[2];
    const td = Math.hypot(tx, tz);
    if (td < 0.3) break;
    stepWith([(tx / td) * RUN * 0.6, (tz / td) * RUN * 0.6], false);
  }
  sendMove([0, 0]);
  const travel = current.travels.shift() ?? null;
  const walked = Math.hypot(pos()[0] - startedAt[0], pos()[2] - startedAt[2]);
  return travel
    ? { travel, how: `walked ${d.toFixed(1)} m from [${startedAt.map((v) => v.toFixed(1)).join(", ")}] into the ${id} trigger${waited > 30 ? ` after waiting ${(waited / 60).toFixed(1)} s for the fight's transfer lock to lapse` : ""}` }
    : { travel, how: "", reason: `walked ${walked.toFixed(1)} m toward ${id} (from [${startedAt.map((v) => v.toFixed(1)).join(", ")}] to [${pos().map((v) => v.toFixed(1)).join(", ")}], portal centre [${centre.map((v) => v.toFixed(1)).join(", ")}]${dead(BODY) ? ", the body is DEAD" : ""}, hp ${net.get(`combat/${BODY}.hp`)}) and it sent nobody${current.refusals.length ? ` (refused: "${current.refusals.at(-1)}")` : ""}` };
}
/** serve()'s portal transfer, in process: record, commit, hand off, bye, load + join at the destination. */
async function transfer(travel: PortalTravel, portal: string, mode: string, how: string): Promise<TripRow> {
  const from = current;
  const row: TripRow = { from: from.scene, to: travel.scene, portal, mode, ok: false, how };
  // moveOut waits for a safe moment (not dead, not transfer-locked by a fight)
  for (let i = 0; i < 60 * 30 && !server.canTransfer(PEER); i++) tick();
  if (!server.canTransfer(PEER)) return { ...row, reason: "the server never allowed the transfer (dead or in combat for 30 s)" };
  const next = portalDeparture(net.get(portalKey(BODY)), travel, { scene: from.scene });
  if (!net.set(portalKey(BODY), next.record)) return { ...row, reason: "portal record refused by netState" };
  const before = { journal: JSON.stringify(journal()?.quests ?? {}), sheet: sheet() };
  const rev = await store.commit(identity().playerId, playerSnapshot(world, BODY, from.scene));
  committedRev = { ...committedRev, ...rev };
  identified = true;
  server.handoff(PEER, { url: `loopback:${next.scene}`, ticket: "", reason: travel.back ? "portal:back" : `portal:${next.scene}`, scene: next.scene });
  client.leave();
  hub.disconnect(PEER); // the socket closes with the bye (a loopback peer id is free again only once disconnected)
  for (let i = 0; i < 120 && world.entities.has(BODY); i++) tick();
  if (world.entities.has(BODY)) return { ...row, reason: `the body was still in ${from.scene} after the bye` };
  from.client = null;
  const dest = hosts.get(next.scene) ?? (log(`  booting instance scene ${next.scene}`), await bootHost(next.scene));
  await joinHost(dest);
  tick(30);
  const after = sheet();
  row.carried = {
    journal: JSON.stringify(journal()?.quests ?? {}) === before.journal,
    bags: sameItems(before.sheet, after),
    coins: (after?.coins ?? -1) === (before.sheet?.coins ?? -2),
    xp: (after?.xp ?? -1) === (before.sheet?.xp ?? -2),
    rev,
  };
  row.anchor = travel.back ? null : (travel.anchor ?? null);
  row.at = pos().map((v) => +v.toFixed(2)) as P3;
  const lost = Object.entries(row.carried).filter(([k, v]) => k !== "rev" && v === false).map(([k]) => k);
  row.ok = lost.length === 0;
  if (!row.ok) row.reason = `arrived without its ${lost.join(", ")} (the save did not carry them)`;
  return row;
}
/**
 * Before going down into an instance a player empties the bags of loot: a boss's drops must have room to land. Carried
 * (not worn) items that no unfinished quest names are dropped by an authority-side sheet write — the same simulation as the
 * boot-time bag clear — and the trip row says how many.
 */
function makeRoom(): number {
  const sh = net.get(`character/${BODY}`) as { items?: Record<string, { itemId: string; qty: number; equipped?: boolean; slot?: string }> } | undefined;
  if (!sh?.items) return 0;
  // items an unfinished quest names (a collect, a delivery, a condition, a reward still to come) stay
  const named = JSON.stringify([...quests.values()].filter((q) => statusOf(q) !== "complete"));
  const kept = Object.fromEntries(Object.entries(sh.items).filter(([, it]) => it.equipped || it.slot || named.includes(`"${it.itemId}"`)));
  const dropped = Object.keys(sh.items).length - Object.keys(kept).length;
  if (dropped > 0) { net.set(`character/${BODY}`, { ...sh, items: kept }); tick(2); }
  return dropped;
}
/** Take the body from the current scene to `scene` through a portal; the trip row is recorded either way. */
async function goTo(scene: string, approach: P3 | null): Promise<TripRow> {
  const ids = portalsTo(scene);
  const emptied = scene !== sceneName && ids.length ? makeRoom() : 0;
  if (emptied) log(`    bags: dropped ${emptied} carried loot stack(s) no quest names before going down into ${scene}`);
  const fail = (reason: string): TripRow => { const r: TripRow = { from: current.scene, to: scene, portal: ids[0] ?? "", mode: "", ok: false, how: "", reason }; trips.push(r); log(`    trip ${r.from} -> ${scene}: FAILED — ${reason}`); return r; };
  if (!ids.length) return fail(`no portal in ${current.scene} leads to ${scene}`);
  recoverIfDead();
  const tries: string[] = [];
  for (const id of ids) {
    const used = usePortal(id, approach);
    if (!used.travel) { tries.push(`${id}: ${used.reason}`); continue; }
    if (used.travel.scene !== scene && !(scene === sceneName && used.travel.back)) { tries.push(`${id}: it leads to ${used.travel.scene}`); continue; }
    const r = await transfer(used.travel, id, String(portalOf(id)?.mode ?? "interact"), used.how);
    if (emptied) r.how += `; before it the tool dropped ${emptied} carried loot stack(s) no quest names (simulated bag clearing)`;
    trips.push(r);
    log(`    trip ${r.from} -> ${r.to} via ${id} (${r.how}): ${r.ok ? `arrived${r.anchor ? ` at ${r.anchor}` : " at the way back"} [${r.at?.join(", ")}], journal+bags+coins carried by the save` : `FAILED — ${r.reason}`}`);
    return r;
  }
  return fail(tries.join(" | "));
}

// ---- what is already proven -------------------------------------------------------------------------------------------
/** Bump when the prover's own logic changes what a pass means: every kept proof is then played again. */
const PROVER_VERSION = 2;
/** Everything a quest's proof reads, as one digest: the same digest as the last passing run means nothing it depends on moved. */
function proofDigest(q: Quest): string {
  const h = createHash("sha256");
  const raw = JSON.stringify(q);
  h.update(`v${PROVER_VERSION}|${sceneName}|${raw}`);
  const ents = doc.entities;
  // entities the quest names (giver, turn-in, targets), with where their parents put them and the words they speak
  for (const id of Object.keys(ents).filter((x) => raw.includes(`"${x}"`)).sort()) {
    let k: string | null | undefined = id;
    for (let n = 0; k && n < 12; n++, k = ents[k]?.parent) h.update(`${k}:${JSON.stringify(k === id ? ents[k] : (ents[k]?.components["transform"] ?? null))}`);
    const dlg = (ents[id]!.components["script"] as { params?: { dialogue?: string } } | undefined)?.params?.dialogue;
    if (dlg) h.update(JSON.stringify(content.assets.getDataAsset(dlg)?.data ?? null));
  }
  // creatures it sends the player to kill: their templates and the spawn areas that field them
  for (const m of raw.matchAll(/tag:(creature:[a-z0-9-]+)/g)) {
    const tpl = Object.entries(ents).filter(([, e]) => e.tags.includes(m[1]!)).map(([id]) => id).sort();
    for (const id of tpl) h.update(`${id}:${JSON.stringify(ents[id])}`);
    for (const [id, e] of Object.entries(ents)) {
      const sa = e.components["spawnArea"] as { spawns?: { template: string }[] } | undefined;
      if (sa?.spawns?.some((x) => tpl.includes(x.template))) h.update(`${id}:${JSON.stringify(e.components)}`);
    }
  }
  // items and other data assets it names, its places table, and any instance scene an objective is in
  for (const o of q.objectives) {
    if (o.target) h.update(JSON.stringify(content.assets.getDataAsset(o.target)?.data ?? null));
    const scene = (o as { scene?: string }).scene;
    if (scene && scene !== sceneName) h.update(JSON.stringify(content.scenes.get(scene) ?? null));
  }
  const places = (q as { places?: string }).places;
  if (places) h.update(JSON.stringify(content.assets.getDataAsset(places)?.data ?? null));
  return h.digest("hex").slice(0, 16);
}
const reportFile = path.join(outDir, "quest-play.json");
const digests = new Map<string, string>([...quests].map(([id, q]) => [id, proofDigest(q)]));
const lastRows = new Map<string, { id: string; status?: string; digest?: string; provenAt?: string }>(
  CHANGED && fs.existsSync(reportFile) ? ((JSON.parse(fs.readFileSync(reportFile, "utf8")) as { quests?: { id: string; status?: string; digest?: string; provenAt?: string }[] }).quests ?? []).map((r) => [r.id, r]) : [],
);
const keptIds: string[] = [];
// --adopt: a passing row written before digests existed is taken as proven at today's digest (a one-time migration);
// --replay <id,id>: these are played whatever their digest says
const ADOPT = flag("adopt");
const REPLAY = new Set(opt("replay", "").split(",").map((x) => x.trim()).filter(Boolean));

// ---- the plan --------------------------------------------------------------------------------------------------------
const order: string[] = [];
{
  const want = new Set<string>();
  const addWithDeps = (id: string): void => { if (want.has(id)) return; want.add(id); for (const r of quests.get(id)?.requires ?? []) addWithDeps(r); };
  const asked = onlyQuest ? onlyQuest.split(",").map((x) => x.trim()).filter(Boolean) : [...quests.keys(), ...Object.keys(problemsAtLoad)]; // one id, a comma list, a plan's list, or all
  for (const id of asked) {
    const last = lastRows.get(id);
    if (CHANGED && last?.status === "pass" && !REPLAY.has(id) && (last.digest ? last.digest === digests.get(id) : ADOPT)) keptIds.push(id);
    else if (onlyQuest) addWithDeps(id);
    else want.add(id);
  }
  if (CHANGED) log(`--changed: ${keptIds.length} of ${asked.length} already proven and unchanged; playing ${want.size}${want.size ? ` (${[...want].join(", ")})` : ""}`);
  const visit = (id: string, stack: string[]): void => {
    if (order.includes(id) || stack.includes(id)) return;
    for (const r of quests.get(id)?.requires ?? []) if (want.has(r)) visit(r, [...stack, id]);
    order.push(id);
  };
  // autoStarted quests first, then file order
  const auto = (template.entities && Object.values(template.entities).flatMap((e) => {
    const s = e.components["script"] as { name?: string; params?: { autoStart?: string[] } } | undefined;
    return s?.name === "quest-log" ? (s.params?.autoStart ?? []) : [];
  })) ?? [];
  for (const id of [...auto.filter((a) => want.has(a)), ...want]) visit(id, []);
}
const autoStart = new Set<string>(Object.values(template.entities).flatMap((e) => {
  const s = e.components["script"] as { name?: string; params?: { autoStart?: string[] } } | undefined;
  return s?.name === "quest-log" ? (s.params?.autoStart ?? []) : [];
}));

interface QuestRow {
  id: string; title: string; status: "pass" | "fail" | "partial"; giver: string; turnIn: string; requires: string[];
  transitions: Transition[]; accept?: { how: string; path: string[] }; turnInPath?: string[];
  digest?: string; kept?: boolean; provenAt?: string;
  objectives: ObjectiveRow[]; rewards?: { expected: { xp: number; coins: number; items: Array<{ itemId: string; qty: number }> }; received: { xp: number; coins: number; items: Record<string, number> }; ok: boolean };
  problems: string[]; seconds: number; walk?: "pass" | "fail" | "in-town";
}
const rows: QuestRow[] = [];

for (const id of order) {
  const tq = Date.now();
  const q = quests.get(id);
  if (!q) {
    rows.push({ id, title: "", status: "fail", giver: "", turnIn: "", requires: [], transitions: [], objectives: [], problems: [problemsAtLoad[id] ?? `quest "${id}" does not exist`], seconds: 0 });
    continue;
  }
  log(`\n${q.id} — ${q.title}`);
  const row: QuestRow = { id: q.id, title: q.title, status: "fail", giver: q.giver, turnIn: q.turnIn, requires: q.requires, transitions: [], objectives: [], problems: [], seconds: 0, digest: digests.get(q.id), provenAt: new Date().toISOString() };
  rows.push(row);
  const finish = (): void => {
    row.transitions = transitions.get(q.id) ?? [];
    row.seconds = +((Date.now() - tq) / 1000).toFixed(1);
    log(`  => ${row.status.toUpperCase()}${row.problems.length ? `: ${row.problems.join(" | ")}` : ""}`);
  };
  recoverIfDead();
  // a quest starts in the world scene (a previous quest's failed way back left the body in an instance)
  if (current.scene !== sceneName) {
    const back = await goTo(sceneName, null);
    if (!back.ok) { row.problems.push(`stuck in ${current.scene}: ${back.reason}`); finish(); continue; }
  }
  // walk mode: every quest starts from the scene's spawn point, independent of where the last one ended
  if (WALK) teleport(spawnAt);

  // -- static dead ends: what the lint cannot see without the scene ------------------------------------------------------
  for (const r of q.requires) {
    if (!quests.has(r)) row.problems.push(`requires "${r}", which is not a quest — the chain can never start`);
    else if (rows.find((x) => x.id === r)?.status === "fail") row.problems.push(`requires "${r}", which failed`);
  }
  const src = questSource(q);
  const giverId = src.kind === "npc" || src.kind === "object" || src.kind === "presence" ? src.ref || q.giver : "";
  const giver = giverId ? npcInfo(giverId) : null;
  if (src.kind === "presence" && giver && !giver.presence) row.problems.push(`presence source ${giverId} has no \`presence\` condition (npc param)`);
  if (src.kind === "presence" && giver?.presence && !conditionLeaves(giver.presence).some((leaf) => Object.keys(leaf).some((k) => CONDITIONS[k]?.set))) row.problems.push(`presence source ${giverId}: its condition has no world part quest-play can drive (clock, weather)`);
  if ((src.kind === "npc" || src.kind === "object" || src.kind === "presence") && !giverId) row.problems.push(`${src.kind} source names no entity (source.ref or giver)`);
  if (giverId && !giver) row.problems.push(`${src.kind} source "${giverId}" is not an npc-builtin entity in scene ${sceneName}`);
  if (giver && !dialogueHas(giver.dialogue, (a) => a.do === "acceptQuest" && a.quest === q.id)) row.problems.push(`${src.kind} source ${giverId}'s dialogue (${giver.dialogueId || "none"}) has no acceptQuest "${q.id}"`);
  if (src.kind === "object" && giver?.face) row.problems.push(`object source ${giverId} turns to face the player (npc param face: false for a thing)`);
  if (src.kind === "auto" && !autoStart.has(q.id) && !autoOffer.has(q.id)) row.problems.push("auto source, but the player's quest-log neither autoStarts nor autoOffers it — nothing ever grants it");
  row.problems.push(...blockProblems(q));
  const turnIn = q.turnIn ? npcInfo(q.turnIn) : null;
  if (q.turnIn && !turnIn) row.problems.push(`turnIn "${q.turnIn}" is not an npc entity in scene ${sceneName}`);
  if (turnIn && !dialogueHas(turnIn.dialogue, (a) => a.do === "turnInQuest" && a.quest === q.id)) row.problems.push(`turnIn ${q.turnIn}'s dialogue (${turnIn.dialogueId || "none"}) has no turnInQuest "${q.id}"`);
  for (const o of q.objectives) {
    if (o.scene && o.scene !== sceneName) {
      const d = content.scenes.get(o.scene);
      if (o.kind === "kill" && d) {
        const tag = o.target.startsWith("tag:") ? o.target.slice(4) : "";
        const hit = Object.entries(d.entities).some(([id, e]) => (tag ? e.tags.includes(tag) : QuestLog.matchesKill(id, o.target)));
        if (!hit) row.problems.push(`objective ${o.id}: kill target "${o.target}" matches no entity in scene ${o.scene}`);
      }
      continue; // blockProblems checked the rest
    }
    if (o.kind === "talk" && !npcInfo(o.target)) row.problems.push(`objective ${o.id}: talk target "${o.target}" is not an npc entity`);
    if (o.kind === "collect" && content.assets.getDataAsset(o.target)?.type !== "item") row.problems.push(`objective ${o.id}: collect target "${o.target}" is not an item`);
    if (o.kind === "kill") {
      const anyEntity = [...world.entities.keys()].some((e) => killMatch(e, o.target));
      const anyArea = [...spawnAreas.areas.values()].some((a) => a.data.spawns.some((s) => killMatch(`${a.id}#${s.template}#1`, o.target)));
      if (!anyEntity && !anyArea) row.problems.push(`objective ${o.id}: kill target "${o.target}" matches no entity and no spawn-area template`);
    }
  }
  for (const r of q.rewardItems) if (content.assets.getDataAsset(r.itemId)?.type !== "item") row.problems.push(`reward item "${r.itemId}" is not an item`);
  if (row.problems.length) { finish(); continue; }

  // -- accept -----------------------------------------------------------------------------------------------------------
  const carriedBefore: Record<string, number> = {};
  for (const o of q.objectives) if (o.kind === "collect") carriedBefore[o.target] = owned(o.target);
  if (giver) {
    const fail = reachNpc(giver, `giver ${giver.id}`, q.id);
    if (fail) { row.problems.push(`giver: ${fail}`); finish(); continue; }
    if (src.kind === "presence" && giver.presence) {
      const presence = giver.presence;
      const drive = (hold: boolean): void => { driveCondition(presence, hold); };
      drive(false);
      sendEvent("npc.talk", { actorId: BODY, npcId: giver.id });
      tick(6);
      if (conversation()?.npc === giver.id) { row.problems.push(`presence: ${giver.id} answered while its condition did not hold`); finish(); continue; }
      drive(true);
      sendEvent("npc.talk", { actorId: BODY, npcId: giver.id });
      tick(6);
      if (conversation()?.npc !== giver.id) { row.problems.push(`presence: ${giver.id} did not answer while its condition held`); finish(); continue; }
      drive(false);
      tick(60);
      const stayed = conversation()?.npc === giver.id;
      sendEvent("npc.leave", { actorId: BODY, npcId: giver.id });
      tick(4);
      if (!stayed) { row.problems.push(`presence: the conversation with ${giver.id} ended when the condition lapsed`); finish(); continue; }
      drive(true);
      log(`  presence: absent outside its condition, present inside it, held through a conversation`);
    }
    const r = converse(giver, (a) => a.do === "acceptQuest" && a.quest === q.id, () => statusOf(q) !== undefined);
    if (!r.ok) { row.problems.push(`accept: ${r.reason}`); row.accept = { how: "failed", path: r.path }; finish(); continue; }
    row.accept = { how: `dialogue ${giver.dialogueId}`, path: r.path };
    log(`  accepted via ${r.path.join(" -> ")}`);
  } else if (autoStart.has(q.id)) {
    waitFor(() => statusOf(q) !== undefined, 2);
    if (statusOf(q) === undefined) { row.problems.push("autoStart quest is not in the fresh journal"); finish(); continue; }
    row.accept = { how: "quest-log autoStart", path: [] };
  } else {
    // auto source via autoOffer: make its world conditions hold and stand in its area; the quest-log takes it up
    const s = src as Extract<typeof src, { kind: "auto" }>;
    if (s.when) driveCondition(s.when, true);
    if (s.area) teleport(groundAt(s.area.center[0], s.area.center[1]));
    waitFor(() => statusOf(q) !== undefined, 2);
    if (statusOf(q) === undefined) { row.problems.push(`auto source never started it (when ${JSON.stringify(s.when ?? {})}${s.area ? `, area ${s.area.label}` : ""})`); finish(); continue; }
    row.accept = { how: `quest-log autoOffer (auto source${s.when ? `, when ${[...conditionBlockNames(s.when)].join("+")}` : ""}${s.area ? `, area ${s.area.label}` : ""})`, path: [] };
  }
  const xp0 = sheet()?.xp ?? 0;
  const coins0 = sheet()?.coins ?? 0;
  const paid0 = coinsPaid;
  const items0: Record<string, number> = {};
  for (const r of q.rewardItems) items0[r.itemId] = owned(r.itemId);
  tick(20);

  // -- objectives -------------------------------------------------------------------------------------------------------
  // order proof: a step that waits on others must not progress before them
  for (const o of q.objectives) {
    if (!o.after.length || o.when || !REPEATABLE.has(o.kind) || objectiveDone(q, o) || (o.scene && o.scene !== sceneName)) continue;
    // nothing to prove when what it waits on is already done (a quest accepted by reading the thing its first step reads)
    if (o.after.every((id) => { const dep = q.objectives.find((x) => x.id === id); return !dep || objectiveDone(q, dep); })) continue;
    const p0 = progressOf(q, o.id);
    DRIVERS[o.kind]?.(q, o);
    if (progressOf(q, o.id) > p0) row.problems.push(`objective ${o.id} progressed before its \`after\` (${o.after.join(", ")}) — order is not enforced`);
    else log(`  order: ${o.id} did not progress before ${o.after.join(", ")}`);
  }
  /** Rows of steps done in an instance: proven only once the body is back out (patched after the return trip). */
  const inInstance: ObjectiveRow[] = [];
  let arrivedAt: P3 | null = null;
  let tripFailed = "";
  for (const o of ordered(q)) {
    const stepScene = o.scene ?? sceneName;
    if (stepScene !== current.scene) {
      // the step happens in another scene: through the portal that leads there (or back out first)
      if (current.scene !== sceneName) {
        const out = await goTo(sceneName, arrivedAt);
        if (!out.ok) { tripFailed = `return from ${out.from}: ${out.reason}`; break; }
      }
      if (stepScene !== sceneName) {
        const inn = await goTo(stepScene, null);
        if (!inn.ok) {
          row.objectives.push({ id: o.id, kind: o.kind, target: o.target, required: o.required, progress: progressOf(q, o.id), result: "failed", how: "", reason: `trip into ${stepScene}: ${inn.reason}` });
          log(`  failed    ${o.kind} ${o.target} — trip into ${stepScene}: ${inn.reason}`);
          break;
        }
        arrivedAt = inn.at ?? null;
      }
    }
    const base = { id: o.id, kind: o.kind, target: o.kind === "visit" || o.kind === "endure" ? (objectiveArea(q, o)?.label ?? "") : o.kind === "deliver" ? `${o.item} -> ${o.target}` : o.kind === "perform" ? `${o.action}${o.target ? ` @ ${o.target}` : ""}` : o.target, required: o.required };
    let res: Omit<ObjectiveRow, "id" | "kind" | "target" | "required" | "progress">;
    if (o.kind === "collect") {
      const gaveByDialogue = (carriedBefore[o.target] ?? 0) < o.required && owned(o.target) >= o.required && !!giver && dialogueHas(giver.dialogue, (a) => a.do === "give" && a.item === o.target);
      res = doCollect(q, o, gaveByDialogue ? "dialogue" : `${carriedBefore[o.target]} in the starting kit`);
    } else if (objectiveDone(q, o)) res = { result: "proven", how: "already complete on arrival" };
    else res = runObjective(q, o);
    // --walk: a site out in the world must connect to the road/town network; the body walks back from it
    let walk: WalkOutRow | string | undefined;
    if (current.scene !== sceneName) {
      const t = trips.at(-1)!;
      walk = `in instance ${current.scene}: entered through ${t.portal} (${t.how}); targets inside reached by teleport`;
    } else if (WALK && walkDeps && res.result !== "failed") {
      const site = o.kind === "visit" || o.kind === "kill";
      const npcAt = o.kind === "talk" ? npcInfo(o.target)?.at : null;
      const inTown = npcAt ? onNetwork(npcAt) : null;
      if (o.kind === "collect") walk = "no site (the quest data names no source)";
      else if (o.kind === "talk" && inTown) walk = `in-town (town-walk gate) — ${inTown}`;
      else if (o.kind === "kill" && killSite) { recoverIfDead(); teleport(standPoint(killSite, 2)); walk = walkBack(q, `kill ${base.target}`); }
      else if (site || npcAt) walk = walkBack(q, `${o.kind} ${base.target}`);
    }
    const orow: ObjectiveRow = { ...base, progress: progressOf(q, o.id), ...res, ...(walk ? { walk } : {}) };
    row.objectives.push(orow);
    if (current.scene !== sceneName) { orow.scene = current.scene; inInstance.push(orow); }
    log(`  ${res.result.padEnd(9)} ${o.kind} ${base.target}${current.scene !== sceneName ? ` [in ${current.scene}]` : ""}${res.reason ? ` — ${res.reason}` : ` — ${res.how}`}`);
    if (res.result === "failed") break;
  }
  // back out to the world scene for what follows (the hand-in), through the instance's way back
  if (!tripFailed && current.scene !== sceneName) {
    recoverIfDead();
    const out = await goTo(sceneName, arrivedAt);
    if (!out.ok) tripFailed = `return from ${out.from}: ${out.reason}`;
  }
  if (inInstance.length) {
    const inn = trips.filter((t) => t.to !== sceneName).at(-1);
    const out = trips.filter((t) => t.to === sceneName).at(-1);
    for (const r of inInstance) {
      if (tripFailed) { r.result = "failed"; r.reason = tripFailed; continue; }
      r.trip = `in through ${inn?.portal} (${inn?.mode}), out through ${out?.portal} (${out?.mode}); journal, bags, coins carried by the save both ways`;
      r.how = `${r.how}; ${r.trip}`;
    }
    if (tripFailed) log(`  failed    the way back — ${tripFailed}`);
  }
  if (tripFailed && !inInstance.length) row.problems.push(tripFailed);
  if (row.objectives.some((o) => o.result === "failed") || row.objectives.length < q.objectives.length) { row.problems.push("an objective could not be completed"); finish(); continue; }
  waitFor(() => statusOf(q) === (q.turnIn ? "ready" : "complete"), 2);

  // -- hand in -----------------------------------------------------------------------------------------------------------
  if (turnIn) {
    if (statusOf(q) !== "ready") { row.problems.push(`objectives done but the journal says "${statusOf(q)}", not ready`); finish(); continue; }
    recoverIfDead();
    const fail = reachNpc(turnIn, `turn in ${turnIn.id}`, q.id);
    if (fail) { row.problems.push(`turn-in: ${fail}`); finish(); continue; }
    const r = converse(turnIn, (a) => a.do === "turnInQuest" && a.quest === q.id, () => statusOf(q) === "complete");
    row.turnInPath = r.path;
    if (!r.ok) {
      row.problems.push(/room in your bags/i.test(r.notice) ? `turn-in refused: the reward does not fit the bags ("${r.notice}")` : `turn-in: ${r.reason}`);
      finish(); continue;
    }
    log(`  handed in via ${r.path.join(" -> ")}`);
  }
  tick(30);

  // -- rewards and the journal's path ---------------------------------------------------------------------------------------------
  const received = { xp: (sheet()?.xp ?? 0) - xp0, coins: (sheet()?.coins ?? 0) - coins0 + (coinsPaid - paid0), items: {} as Record<string, number> };
  for (const r of q.rewardItems) received.items[r.itemId] = owned(r.itemId) - (items0[r.itemId] ?? 0);
  const rewardsOk = received.xp >= q.rewardXp && received.coins >= q.rewardCoins && q.rewardItems.every((r) => (received.items[r.itemId] ?? 0) >= r.qty);
  row.rewards = { expected: { xp: q.rewardXp, coins: q.rewardCoins, items: q.rewardItems }, received, ok: rewardsOk };
  if (!rewardsOk) row.problems.push(`rewards short: got xp ${received.xp}/${q.rewardXp}, coins ${received.coins}/${q.rewardCoins}, items ${JSON.stringify(received.items)}`);
  const seen = (transitions.get(q.id) ?? []).map((t) => t.status);
  const want = q.turnIn ? ["active", "ready", "complete"] : ["active", "complete"];
  const missing = want.filter((s) => !seen.includes(s));
  // a quest whose objectives were already met at acceptance goes straight to ready inside one tick — the authority
  // never wrote "active"; that is a design smell, reported, not a failure of the machine
  if (missing.length === 1 && missing[0] === "active" && seen[0] === want[1]) row.problems.push(`journal skipped "active": the objectives were already met when it was accepted`);
  else if (missing.length) row.problems.push(`journal never reached ${missing.join(", ")} (saw ${seen.join(" -> ") || "nothing"})`);
  if (WALK) {
    const walked = row.objectives.map((o) => o.walk).filter((w): w is WalkOutRow => typeof w === "object");
    row.walk = walked.some((w) => w.verdict !== "proven forward") ? "fail" : walked.length ? "pass" : "in-town";
    for (const w of walked) if (w.verdict !== "proven forward") row.problems.push(`walk from [${w.from.join(", ")}]: ${w.reason}`);
  }
  const complete = statusOf(q) === "complete";
  const anySim = row.objectives.some((o) => o.result === "simulated");
  const hard = row.problems.filter((p) => !p.startsWith("journal skipped"));
  row.status = !complete || hard.length ? "fail" : anySim || row.problems.length ? "partial" : "pass";
  finish();
}

// ---- report ---------------------------------------------------------------------------------------------------------------
// proofs kept from the last run (--changed): carried over as they were, unless this run played them anyway as a prerequisite
for (const id of keptIds) if (!rows.some((r) => r.id === id)) rows.push({ ...(lastRows.get(id) as unknown as QuestRow), kept: true, digest: digests.get(id) });
fs.mkdirSync(outDir, { recursive: true });
const outFile = reportFile;
fs.writeFileSync(outFile, `${JSON.stringify({
  project: projectName, scene: sceneName, mode: WALK ? "walk" : "logic", generated: new Date().toISOString(),
  totalSeconds: +((Date.now() - t0) / 1000).toFixed(1), summary: { pass: rows.filter((r) => r.status === "pass").length, partial: rows.filter((r) => r.status === "partial").length, fail: rows.filter((r) => r.status === "fail").length },
  quests: rows, walks, trips,
}, null, 1)}\n`);
log("\nquest                     status   objectives                               notes");
for (const r of rows) {
  const objs = r.objectives.map((o) => `${o.kind}:${o.result === "proven" ? "ok" : o.result === "simulated" ? "sim" : "FAIL"}`).join(" ");
  const joins = r.objectives.map((o) => (typeof o.walk === "object" ? (o.walk.verdict === "proven forward" ? `${o.kind}: proven forward via ${o.walk.joined} (${o.walk.backMetres}/${o.walk.forwardMetres} m)` : `${o.kind}: ${o.walk.verdict}`) : "")).filter(Boolean).join(", ");
  log(`${r.id.padEnd(25)} ${(r.kept ? "kept" : r.status).padEnd(8)} ${objs.padEnd(40)} ${WALK ? `walk:${(r.walk ?? "-").padEnd(8)} ${joins} ` : ""}${(r.problems[0] ?? "").slice(0, 110)}`);
}
log(`\nwrote ${path.relative(process.cwd(), outFile)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
for (const h of hosts.values()) { h.server.close(); h.terrain?.dispose(); h.world.dispose(); }
process.exit(rows.some((r) => r.status === "fail") ? 1 : 0);
