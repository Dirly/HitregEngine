/**
 * dress — furnish a space by NAMING things: a prop, a wall, a socket. Never a transform.
 *
 *   npx tsx tools/dress.mts sockets ...                                    (measure a space: tools/dress-sockets.mts)
 *   npx tsx tools/dress.mts manifest --project <p> --map <id> [--level n]  the designer's view of a space
 *   npx tsx tools/dress.mts check    --project <p> --plan <file|id> [--quiet]   resolve; exit 1 on violations; writes
 *                                    <project>/authoring/dressing/reports/<plan>.report.json (never beside the plan: tools/_dress-report.mts);
 *                                    the LAST line is `CHECK <plan>: N placements, V violations, W warnings -> ok|FAILED`;
 *                                    --quiet prints only the findings and that line (use it after the first full look)
 *   npx tsx tools/dress.mts apply    --project <p> --plan <file|id> --scene <name|file> --at x,y,z --yaw <deg> [--parent <entity>] [--poi <id>] [--no-batch] [--dry]
 *                                    --lights-only: a plan of lit fixtures only (dress fixtures) in an unfurnished building; its
 *                                    unfurnished-room violations are waived for the apply, its check still fails
 *                                    (every added entity is tagged poi:<id>: --poi, else the site socket map's job, else the
 *                                    <poi>-<area> plan id prefix of a POI job; tools/_dress-poi.mts)
 *   npx tsx tools/dress.mts retag    --project <p> --scene <name|file> [--plan <file|id>] [--poi <id>] [--dry]   tag dressing
 *                                    installed before that rule with its poi:<id> (one set-tags batch, inverse saved)
 *   npx tsx tools/dress.mts unclear  --project <p> --plan <file|id> --scene <name|file>   remove the plan's vegetation clearings from the world
 *                                    (apply writes one per room on a voxel-world scene: owner dress-<plan>, room bounds + 2 m,
 *                                    scatter cleared, cover kept outdoors EXCEPT under every dwelling / fire / bedding: those get their own
 *                                    footprint disc with cover CLEARED (+1.5 m, 3 m at a fire; `check` fails one that stands on kept cover);
 *                                    plan `clearing` tunes it, false / --no-clearing skips it)
 *   npx tsx tools/dress.mts fixtures --project <p> --map <id> [--plan <file|id>] [--dry]   lit fixtures on the map's fixture anchors
 *   npx tsx tools/dress.mts report   --project <p> --plan <file|id>   readable authoring/dressing/reports/<plan>.md (check writes it on a pass)
 *   npx tsx tools/dress.mts review   --project <p> --plan <file|id> | --all   per room: centre clutter, wall share, scale/culture
 *                                    violations, and the plan's violations by code (never writes anything; exit 0)
 *     check/review also take --space '<json>' (override the plan's `space` { kind, scale, cultures } for a trial) and
 *     --scene <name|file> --at x,y,z: the scene's decals, statues and catalogued props NOT placed by this plan are read into
 *     the map frame, so no prop stands in a decal's projection or overlaps placed geometry
 *   npx tsx tools/dress.mts overrides <project> [--summary] [--json]   what the OWNER changed by hand (editor), by item, reason
 *                                    class (floating = moved down, moved, swapped, deleted, added...) and prop; read it before dressing
 *   npx tsx tools/dress.mts owner-apply --project <p> --scene <name> [--dry]   re-apply the owner's edits to installer-placed props
 *                                    (authoring/owner-overrides/<scene>.json); installers run it LAST
 *   OWNER OVERRIDES (packages/core dressing/owner.ts): the editor writes the owner's edits of a dressed prop to <plan>.owner.json;
 *                                    check/apply/review resolve the plan, then apply them LAST (deleted never re-added, moved never
 *                                    moved or re-seated, added kept); manifest prints them as FIXED. --no-owner ignores them (a trial).
 *   npx tsx tools/dress.mts walk     --project <p> --plan <file|id> --scene <name>   the REAL player body through the installed
 *                                    building (tools/dress-walk.mts): door -> every ground-floor room and stair foot, and up
 *                                    each stair to the upper rooms (all gated, exit 1); <plan>.walk.json + report
 *
 * Density and walkability (packages/core resolveDressing): the lane is the project's player capsule (characters/player
 * collider, 0.8 m) + 0.05 m each side, measured against each prop's real footprint, to every room, stair, stair
 * approach/head ('A' cells), doorway and to every chair/table/bed side and clearance front. Per room: at most 30% of the
 * free floor under solid props (50% storage/cellar), a small loose-container budget (sacks, crates, barrels, boxes),
 * a low minimum. `manifest` prints all of it before anything is placed. Flame-only fixtures (`anchorKinds`) go only
 * on the building's own anchors of that kind.
 *
 * fixtures writes (or extends) a plan with one item per fixture anchor the plan does not already use: FIXTURE_DEFAULTS
 * picks the prefab (hearth/forge -> fixtures/hearth-fire sized from the anchor's `size`, sconce -> fixtures/sconce-fire,
 * lantern -> fixtures/lantern-glow, chandelier -> fixtures/chandelier-a-lit, candle-niche -> fixtures/niche-candle-lit;
 * chimney-top gets nothing until the project has a smoke effect). Item ids are `fx-<anchor>`. A designer overrides one
 * by editing that item's `prop` (or its `props`); an anchor already used by any item is left alone, so re-running
 * never undoes a choice. The result goes through `check` and `apply` like any plan.
 *
 * Common option: --props <dir> overlays prop declarations (files <dir>/<prefab id>.json holding a prefab doc or a bare
 * `dressing` object) on top of the project's prefabs; for trials and fixtures, never needed for real props.
 *
 * Files (under projects/<p>/): authoring/dressing/sockets/<id>.json (socket-map), .../sets/<id>.json (dressing-set),
 * .../plans/<id>.json (dressing-plan). Prop declarations: the ROOT entity's `components.dressing` of
 * assets/prefabs/<prefab id>.json. Resolution is @hitreg/core's resolveDressing; this file only loads, prints and installs.
 *
 * apply writes ONE ops batch through applyOps: it removes every entity of this plan (ids `dress-<plan>-…`) then adds one
 * room group (culling unit) per room with one prefab instance per placement under it, fixed props opted into static batching
 * by prefab override (--no-batch turns that off; flames/lights and live prefabs never opt in), and saves the inverse batch
 * to <plan>.inverse.json. With --parent the --at/--yaw are in
 * the parent's frame. Entity ids replace "/" with "--".
 *
 * QUEST OBJECTS: an item with `quest: { entity, readable?, radius?, dialogue? }` is a quest object the zone's quest plan
 * declares (quests.json `entities[]`, kind object|readable, `location` = the plan's town (`<town>--<building>` plan id)
 * or its POI). check refuses an undeclared / other-location / duplicate entity and warns for a declared object of the
 * location that no plan places; apply gives the placed instance (a set's anchor piece) the entity id EXACTLY, tags
 * `quest-object interactable zone:<z>` + `town:<t> building:<b>` / `poi:<id>`, and the `npc` builtin (face false,
 * radius 2.5, dialogue zones/<zone>/<entity>, places = the zone's places table). Re-apply replaces it. _dress-quest.mts.
 */
import fs from "node:fs";
import { materialFamilyFinding, STONE_NAME, type PrefabLike } from "./_material-family.mts";
import { kindSizes, outrankedIds, outrankFindings, realSizeExemptIds, realSizeIssue, supersededIds } from "./_prop-real-size.mts";
import { dressReportFile } from "./_dress-report.mts";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  applyOps,
  ComponentRegistry,
  registerCoreComponents,
  dressingSchema,
  dressingSetSchema,
  dressingPlanSchema,
  dressingSpaceSchema,
  mergeVocabulary,
  type DressingVocabulary,
  type DressingDecal,
  type DressingObstacle,
  socketMapSchema,
  resolveDressing,
  roomBudget,
  placeableFloor,
  standStretches,
  isLooseClutter,
  HEAD_STEP,
  type DressingData,
  type DressingPlan,
  type DressingPlanInput,
  type DressingSet,
  type DressingResolveResult,
  type SocketLevel,
  type SocketMap,
  type Op,
  applyOwnerOverrides,
  ownerOverridesSchema,
  sceneOwnerOps,
  rebaseOwnerOverrides,
  type OwnerOverrides,
} from "@hitreg/core";

import { controllerLimits } from "./dress-steps.mts";
import { applyBatchesToSceneFile, applyOpsToSceneFile } from "./_scene-write.mts";
import { fieldOfScene, seatPlaced } from "./float.mts";
import { repeatsInOps, solveLine, solveScenePieces, spreadSpots, type SolveRow } from "./_place-solve.mts";
import { skinPlacedOps } from "./rock-skins.mts";
import { measure, prefabGeometry } from "./_prop-geometry.mts";
import { dressPoiId, poiJobIds, retagOps } from "./_dress-poi.mts";
import { questAddOp, questDecls, questFindings, placesFor, planTown } from "./_dress-quest.mts";
import { questPlacements } from "@hitreg/core";
import { closure, findAsset, PROJECTS } from "./_closure.mjs";
import {propPolicy} from './_prop-curation.mts';
import { worldRecipeSchema, clearingSchema, needsClearedCover, discCleared, type ClearingDoc } from "@hitreg/core";

/** A prefab file through the project's dependsOn closure (a world's props live in world-kit); own path when none. */
const prefabAt = (proj: string, id: string): string => findAsset(proj, `prefabs/${id}.json`) ?? path.join(proj, "assets", "prefabs", `${id}.json`);
/** The first existing `rel` across the project and its dependsOn closure, else the project's own path. */
const inClosure = (proj: string, rel: string): string => { for (const p of closure(proj) as string[]) { const f = path.join(PROJECTS, p, rel); if (fs.existsSync(f)) return f; } return path.join(proj, rel); };

const PLAYGROUND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Comfort added on each side of the player capsule for a furnishing lane (steering slack, the controller's skin). */
const LANE_COMFORT = 0.05;
/** The player's real body (characters/player collider, read by dress-steps' controllerLimits) and the lane derived from it. */
function bodyLane(proj: string): { radius: number; height: number; laneWidth: number; source: string } {
  const lim = controllerLimits(path.resolve(PLAYGROUND, "../.."), proj);
  return { radius: lim.radius, height: lim.height, laneWidth: +(2 * (lim.radius + LANE_COMFORT)).toFixed(3), source: "assets/prefabs/characters/player.json collider" };
}
/**
 * A hung prop and its chain links (`<id>--chain-<k>`, k = 0 at the prop) move as ONE piece when the seat step re-seats
 * any of them: the TOP link's correction (it hangs from the real ceiling, which the socket map's head can miss by half a
 * metre under a steep roof) is applied to every link and the prop. Seating the links one by one opened a 0.53 m gap in
 * the Reeve's hall chain (f-house 2026-10-29: the upper links rose to the roof, the lower ones and the chandelier stayed).
 */
export function rigidChains(doc: { entities: Record<string, any> }, ops: any[]): any[] {
  const LINK = /^(.*)--chain-(\d+)$/;
  const groups = new Map<string, { k: number; op: any }[]>();
  for (const op of ops) {
    const m = op.op === "set-component" && op.component === "transform" ? LINK.exec(String(op.id)) : null;
    if (m) (groups.get(m[1]!) ?? groups.set(m[1]!, []).get(m[1]!)!).push({ k: Number(m[2]), op });
  }
  if (!groups.size) return ops;
  const out = ops.filter((op) => {
    const id = String(op.id ?? "");
    const m = LINK.exec(id);
    return !(m && groups.has(m[1]!)) && !groups.has(id);
  });
  for (const [base, links] of groups) {
    const top = links.reduce((a, b) => (b.k > a.k ? b : a));
    const was = doc.entities[top.op.id]?.components?.transform?.position;
    if (!was) continue;
    const dy = top.op.data.position[1] - was[1];
    const members = [base, ...Object.keys(doc.entities).filter((id) => id.startsWith(`${base}--chain-`))];
    for (const id of members) {
      const t = doc.entities[id]?.components?.transform;
      if (!t) continue;
      const p = t.position ?? [0, 0, 0];
      out.push({ op: "set-component", id, component: "transform", data: { ...t, position: [p[0], +(p[1] + dy).toFixed(4), p[2]] } });
    }
  }
  return out;
}

const [cmd, ...argv] = process.argv.slice(2);

function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  // `--yaw=-179.9` (the form a negative value invites) once fell through to the default and installed a room turned 180 degrees
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? undefined : eq.slice(name.length + 3);
}
const flag = (name: string): boolean => argv.includes(`--${name}`);
function need(name: string): string {
  const v = opt(name);
  if (!v) fail(`missing --${name}`);
  return v!;
}
function fail(msg: string): never {
  console.error(`dress: ${msg}`);
  process.exit(2);
}
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
const f2 = (v: number): string => (Math.abs(v) < 0.005 ? "0.00" : v.toFixed(2));

// ---- project files --------------------------------------------------------

function projectDir(): string {
  const p = need("project");
  const dir = path.join(PLAYGROUND, "projects", p);
  if (!fs.existsSync(dir)) fail(`no project ${dir}`);
  return dir;
}
const dressDir = (proj: string, kind: "sockets" | "sets" | "plans"): string => kind === "sets" ? inClosure(proj, "authoring/dressing/sets") : path.join(proj, "authoring", "dressing", kind);

function loadMap(proj: string, id: string): { map: SocketMap; file: string; raw: string } {
  const file = path.join(dressDir(proj, "sockets"), `${id}.json`);
  if (!fs.existsSync(file)) fail(`no socket map ${path.relative(PLAYGROUND, file)} (measure it with \`dress sockets\`)`);
  const raw = fs.readFileSync(file, "utf8");
  const parsed = socketMapSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) fail(`socket map ${id} is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return { map: parsed.data, file, raw };
}

function planFile(proj: string, ref: string): string {
  if (fs.existsSync(ref) && ref.endsWith(".json")) return path.resolve(ref);
  const file = path.join(dressDir(proj, "plans"), `${ref}.json`);
  if (!fs.existsSync(file)) fail(`no plan ${ref} (looked for ${path.relative(PLAYGROUND, file)})`);
  return file;
}

/** The owner's hand edits to a plan's props: `<plan>.owner.json` beside the plan (packages/core dressing/owner.ts). */
const ownerFileOf = (planFile: string): string => planFile.replace(/\.json$/, ".owner.json");
function loadOwner(file: string): { owner: OwnerOverrides | null; raw: string } {
  if (!fs.existsSync(file)) return { owner: null, raw: "" };
  const raw = fs.readFileSync(file, "utf8");
  const parsed = ownerOverridesSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) fail(`owner overrides ${file} are invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return { owner: parsed.data, raw };
}

function loadPlan(file: string): { plan: DressingPlan; raw: string } {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = dressingPlanSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) fail(`plan ${file} is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return { plan: parsed.data, raw };
}

/** Prop declarations and sets, cached, with every file read recorded for the staleness hash. */
function sources(proj: string) {
  const builderPolicy=propPolicy(PROJECTS,path.basename(proj));
  const overlay = opt("props");
  const used = new Map<string, string>();
  const problems: string[] = [];
  const props = new Map<string, DressingData | undefined>();
  const sets = new Map<string, DressingSet | undefined>();
  let successors: Map<string, string> | undefined; // a set authored with a superseded piece places its successor
  const successor = (id: string): string => (successors ??= supersededIds((closure(proj) as string[]).map((p) => path.join(PROJECTS, p)))).get(id) ?? id;
  const prop = (id: string): DressingData | undefined => {
    const excluded=builderPolicy.excluded(id);
    if(excluded){problems.push(`${id}: OWNER EXCLUDED by ${excluded.project} (${excluded.id})${excluded.note?': '+excluded.note:''}`);used.set(`curation:${id}`,JSON.stringify(excluded));return undefined;}
    if (props.has(id)) return props.get(id);
    let decl: DressingData | undefined;
    const files = [...(overlay ? [path.resolve(overlay, `${id}.json`)] : []), prefabAt(proj, id)];
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const doc = readJson(file) as { root?: string; entities?: Record<string, { components?: Record<string, unknown> }> } & Record<string, unknown>;
      const raw = doc.entities && doc.root ? doc.entities[doc.root]?.components?.dressing : doc.mount ? doc : undefined;
      used.set(`prop:${id}`, JSON.stringify(raw ?? null));
      if (raw === undefined) break;
      const parsed = dressingSchema.safeParse(raw);
      if (parsed.success) decl = parsed.data;
      else problems.push(`prop ${id} (${path.relative(PLAYGROUND, file)}): invalid dressing: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      break;
    }
    if (!used.has(`prop:${id}`)) used.set(`prop:${id}`, "missing");
    props.set(id, decl);
    return decl;
  };
  const set = (id: string): DressingSet | undefined => {
    if (sets.has(id)) return sets.get(id);
    const file = path.join(dressDir(proj, "sets"), `${id}.json`);
    let s: DressingSet | undefined;
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      used.set(`set:${id}`, raw);
      const parsed = dressingSetSchema.safeParse(JSON.parse(raw));
      if (parsed.success) s = { ...parsed.data, items: parsed.data.items.map((i) => ({ ...i, prop: successor(i.prop) })) };
      else problems.push(`set ${id}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    } else used.set(`set:${id}`, "missing");
    sets.set(id, s);
    return s;
  };
  return { prop, set, used, problems };
}

// ---- ASCII plans ----------------------------------------------------------

/** Cell glyphs: free floor shows its room digit, unroofed floor 'o', the rest as stored. */
function asciiLevel(lv: SocketLevel, marks: Map<string, string> = new Map()): string[] {
  const k = lv.columns > 110 ? 2 : 1; // downsample very large spaces
  const cols = Math.ceil(lv.columns / k), rows = Math.ceil(lv.rows / k), s = lv.step * k;
  const rank = (ch: string): number => "SWDEAH#x.o ".indexOf(ch) + 1 || 10;
  const out: string[] = [];
  // X ruler (plain ASCII, so every glyph is one column): '|' marks the column whose LEFT edge is that whole metre;
  // the label above ends on its tick. Every 2 m when cramped.
  const every = s * 4 >= 1 ? 1 : 2;
  const ruler = Array(cols).fill(" "), ticks = Array(cols).fill(" ");
  for (let m = Math.ceil(lv.origin[0] / every) * every; m <= lv.origin[0] + cols * s + 1e-9; m += every) {
    const exact = (m - lv.origin[0]) / s, c = Math.round(exact);
    if (Math.abs(exact - c) > 1e-6 || c < 0 || c >= cols) continue;
    ticks[c] = "|";
    const lab = String(m), c0 = c - lab.length + 1;
    if (c0 >= 0 && ruler.slice(Math.max(0, c0 - 1), c + 1).every((x) => x === " ")) for (let i = 0; i < lab.length; i++) ruler[c0 + i] = lab[i];
  }
  out.push(`   x ${ruler.join("")}`, `     ${ticks.join("")}`);
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const mark = marks.get(`${c * k},${r * k}`) ?? (k > 1 ? (marks.get(`${c * k + 1},${r * k}`) ?? marks.get(`${c * k},${r * k + 1}`) ?? marks.get(`${c * k + 1},${r * k + 1}`)) : undefined);
      if (mark) {
        line += mark;
        continue;
      }
      // Pick the most significant glyph of the k x k block.
      let best = " ", room = ".";
      for (let dr = 0; dr < k; dr++)
        for (let dc = 0; dc < k; dc++) {
          const ch = lv.cells[r * k + dr]?.[c * k + dc];
          if (ch === undefined) continue;
          if (rank(ch) < rank(best)) best = ch;
          if (ch === ".") room = lv.room[r * k + dr]?.[c * k + dc] ?? ".";
        }
      line += best === "." ? (room === "." ? "." : room) : best;
    }
    const z = lv.origin[1] + r * s;
    const zl = Math.abs(z - Math.round(z)) < s / 2 - 1e-9 && Math.abs(z - Math.round(z)) < 1e-6 ? String(Math.round(z)) : "";
    out.push(`${zl.padStart(4)} ${line}`);
  }
  out.push(`   z  1 char = ${f2(s)} m; rulers give the low edge of a cell (x of its left side, z of its top); digit = room index, # wall, S stair, W well, D doorway, E entry lane, H hearth clearance (no solid prop), A stair approach/foot/head (no solid prop, must stay reachable), x walking path (reserved: no solid prop; a rug may cross it), o unroofed, ' ' outside`);
  return out;
}

/** Interruptions between a wall's free spans (doors, windows, openings), as t ranges. */
function gapsText(spans: [number, number][], len: number): string {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]), gaps: string[] = [];
  let t = 0;
  for (const [a, b] of sorted) {
    if (a - t > 0.01) gaps.push(`${f2(t)}..${f2(a)}`);
    t = Math.max(t, b);
  }
  if (len - t > 0.01) gaps.push(`${f2(t)}..${f2(len)}`);
  return gaps.length ? `  blocked ${gaps.join(" ")}` : "";
}

/** Stair, well, doorway and entry-lane extents (cell edges, metres), one line per kind. */
function zoneLines(lv: SocketLevel): string[] {
  const out: string[] = [];
  const C = lv.columns, R = lv.rows;
  for (const [ch, name] of [["S", "stairs"], ["W", "wells"], ["D", "doorways"], ["E", "entry lanes"], ["A", "stair approaches/heads (keep clear)"]] as const) {
    const seen = new Uint8Array(C * R), parts: string[] = [];
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        if (seen[r * C + c] || lv.cells[r]?.[c] !== ch) continue;
        let c0 = c, c1 = c, r0 = r, r1 = r;
        const st = [r * C + c];
        seen[r * C + c] = 1;
        while (st.length) {
          const k = st.pop()!, kc = k % C, kr = (k - kc) / C;
          c0 = Math.min(c0, kc); c1 = Math.max(c1, kc); r0 = Math.min(r0, kr); r1 = Math.max(r1, kr);
          for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nc = kc + dc!, nr = kr + dr!;
            if (nc < 0 || nr < 0 || nc >= C || nr >= R || seen[nr * C + nc] || lv.cells[nr]?.[nc] !== ch) continue;
            seen[nr * C + nc] = 1;
            st.push(nr * C + nc);
          }
        }
        const x = (i: number) => lv.origin[0] + i * lv.step, z = (i: number) => lv.origin[1] + i * lv.step;
        parts.push(`x ${f2(x(c0))}..${f2(x(c1 + 1))} z ${f2(z(r0))}..${f2(z(r1 + 1))}`);
      }
    if (parts.length) out.push(`${name}: ${parts.join("; ")}`);
  }
  return out;
}

const facing = (n: [number, number]): string => {
  const ax = Math.abs(n[0]) > 0.98 ? (n[0] > 0 ? "+X" : "-X") : Math.abs(n[1]) > 0.98 ? (n[1] > 0 ? "+Z" : "-Z") : "";
  return ax ? `faces ${ax}` : `faces (${f2(n[0])},${f2(n[1])})`;
};

function manifest(): void {
  const proj = projectDir();
  const { map } = loadMap(proj, need("map"));
  const only = opt("level");
  const lines: string[] = [`MAP ${map.id}${map.source ? `  (from ${map.source.model})` : ""}`];
  // the owner's hand edits on plans of this map are FIXED: a dresser never moves, re-adds or replaces them
  for (const f of ownerFiles(proj)) {
    const planOf = f.file.replace(/\.owner\.json$/, ".json");
    if (!f.data.plan || !fs.existsSync(planOf) || (readJson(planOf) as { map?: string }).map !== map.id) continue;
    lines.push(`OWNER OVERRIDES on plan ${f.data.plan} (FIXED: the owner placed these by hand. Never move, re-add or replace them; keep other props clear of them. \`dress overrides\` lists why):`);
    for (const o of f.data.overrides) lines.push(`  ${ownerLine(o)}`);
  }
  const body = bodyLane(proj);
  lines.push(
    `walkable lane: ${f2(body.laneWidth)} m = the player capsule (${f2(body.radius * 2)} m wide, ${f2(body.height)} m tall) + ${f2(LANE_COMFORT)} m each side. It must reach every room, ` +
      `stair, stair approach/head ('A'), doorway, and the side of every chair, table and bed and the front of anything with a clearance. ` +
      `The map's walking paths ('x') are that lane, reserved in advance: place solid props only on what is left ('.', the room digits); rugs may cross a path.`,
    `density (per room, below): FEWER, BETTER THINGS. min = fewest items; cover = most floor solid props may cover (a lived-in room is mostly open floor); ` +
      `loose = most sacks/crates/barrels/boxes standing on the floor (more go on shelves, in a storage room, or are left out). Flame-only fixtures (hearth/sconce/lantern fire) go on the building's own anchors via \`dress fixtures\`, never on a wall.`,
  );
  lines.push(
    "PLACE BY INTENT: { kind: \"auto\", room, prefer?: wall|corner|open|near, near?: <earlier item id | hearth | door | stair | anchor kind>, wall? } and the resolver picks the spot " +
      "(check prints it). Explicit places still work: floor {level, at:[x,z], yaw} | wall {wall, t, height?} | ceiling {level, at, drop} | on {item, socket?} | anchor {anchor}.",
    "WALLS: every t, span and stretch is measured LEFT TO RIGHT as seen from INSIDE the room, standing facing that wall (a = its left end). " +
      "`stand` = stretches where a piece can stand with its back to the wall (solid wall behind, placeable floor 0.5 m deep in front); `hang` = solid wall for hung items.",
    "coords: map-local metres, +X right, +Z down the page, yaw 0 = facing +Z, 90 = +X.",
  );
  if (map.entry) lines.push(`entry: door at (${f2(map.entry.position[0])}, ${f2(map.entry.position[1])}), ${facing(map.entry.facing).replace("faces", "leads")} into the building`);
  for (const lv of map.levels) {
    if (only !== undefined && Number(only) !== lv.level) continue;
    lines.push("", `LEVEL ${lv.level}  floor y ${f2(lv.floorY)}`);
    lines.push(...asciiLevel(lv));
    lines.push(...zoneLines(lv));
    if (lv.paths.length) {
      lines.push("walking paths ('x', reserved before anything is placed: no solid prop may touch one; rugs may cross; centre line from where it leaves the network):");
      for (const p of lv.paths) lines.push(`  ${p.id} ${p.name}: ${p.points.map(([x, z]) => `(${f2(x)}, ${f2(z)})`).join(" -> ")}`);
    } else lines.push("walking paths: none in this map (regenerate it with `dress sockets` to reserve them)");
    const floor = new Map(placeableFloor(lv).map((f) => [f.room, f.placeable]));
    lines.push("rooms (id: free floor m², ceiling min..max | PLACEABLE floor for solid props after paths and keep-clear zones | limits: fewest items, cover ceiling = share of PLACEABLE floor, loose containers [storage/cellar room]):");
    for (const r of lv.rooms) {
      const left = floor.get(r.id) ?? 0, b = roomBudget(r.area, "", left), s = roomBudget(r.area, "storage", left);
      lines.push(
        `  ${r.id}: ${f2(r.area)} m², ceiling ${f2(r.minHead)}..${r.maxHead >= 8.75 ? "open" : f2(r.maxHead)} m  (x ${f2(r.bbox[0])}..${f2(r.bbox[1])}, z ${f2(r.bbox[2])}..${f2(r.bbox[3])}, digit ${r.index.toString(36)})` +
          ` | ${left > 0 ? `placeable ${f2(left)} m² (${Math.round((left / r.area) * 100)}%)` : "NOTHING placeable: wall, hung, ceiling items and rugs only"}` +
          ` | at least ${b.minItems} items, cover <= ${b.maxCoverM2} m² (${Math.round(b.maxCover * 100)}% of placeable), loose <= ${b.loose} [storage room: ${s.maxCoverM2} m², ${s.loose}]`,
      );
    }
    lines.push("walls (id: length, usable height, facing | stand: free stretches with their lengths | hang: solid wall), t left to right seen from inside:");
    for (const w of lv.walls) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), st = standStretches(lv, w);
      const fmt = (rs: [number, number][]) => rs.map(([a, b]) => `${f2(a)}..${f2(b)} (${f2(b - a)} m)`).join(", ") || "none";
      lines.push(`  ${w.id} (room ${w.room}): ${f2(len)} m, h ${f2(w.height)}, ${facing(w.normal)} | stand ${fmt(st)} | hang ${fmt(w.spans)}${gapsText(w.spans, len)}`);
    }
  }
  if (map.anchors.length) {
    lines.push("", "anchors (id kind mount level position yaw):");
    for (const a of map.anchors) lines.push(`  ${a.id} ${a.kind} ${a.mount} L${a.level} (${a.position.map(f2).join(", ")}) ${a.yaw}°${a.outdoor ? " outdoor" : ""}${a.kind.startsWith("stair-") ? "  (the way onto a stair: keep clear, place nothing)" : ""}`);
  }
  console.log(lines.join("\n"));
}

// ---- check ----------------------------------------------------------------

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** The dressing vocabulary: core's DRESSING_VOCABULARY + authoring/dressing/vocabulary.json of the props' project and this project. */
function vocabulary(proj: string): DressingVocabulary {
  const files = [opt("props") ? path.resolve(opt("props")!, "../../authoring/dressing/vocabulary.json") : "", inClosure(proj, "authoring/dressing/vocabulary.json")];
  let v = mergeVocabulary();
  for (const f of files) if (f && fs.existsSync(f)) { const x = readJson(f) as Partial<DressingVocabulary>; v = mergeVocabulary({ scales: [...v.scales, ...(x.scales ?? [])], cultures: [...v.cultures, ...(x.cultures ?? [])] }); }
  return v;
}

type Q = [number, number, number, number];
const qrot = (q: Q, v: [number, number, number]): [number, number, number] => {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/**
 * What is already in the scene where this plan goes, in the MAP frame (--at x,y,z, --yaw deg as for apply): every decal's
 * projection box, and the footprint of every statue and every catalogued prop instance this plan did not place (other
 * plans' props, hand-placed set pieces). Statues are measured from their model.
 */
function sceneContext(proj: string, plan: DressingPlan, map: SocketMap): { decals: DressingDecal[]; obstacles: DressingObstacle[] } {
  const sceneRef = opt("scene")!;
  const file = fs.existsSync(sceneRef) ? sceneRef : path.join(proj, "assets", "scenes", sceneRef.endsWith(".json") ? sceneRef : `${sceneRef}.scene.json`);
  if (!fs.existsSync(file)) fail(`no scene ${sceneRef}`);
  const at = opt("at")!.split(",").map(Number) as [number, number, number], yaw = (Number(opt("yaw") ?? 0) * Math.PI) / 180;
  const E = (readJson(file) as { entities: Record<string, { name?: string; parent?: string | null; tags?: string[]; components: Record<string, any> }> }).entities;
  const world = (id: string): { p: [number, number, number]; q: Q; s: number } => {
    const e = E[id]!, t = e.components.transform ?? {};
    const lp = (t.position ?? [0, 0, 0]) as [number, number, number], lq = (t.rotation ?? [0, 0, 0, 1]) as Q, ls = Array.isArray(t.scale) ? t.scale[1] : 1;
    if (!e.parent || !E[e.parent]) return { p: lp, q: lq, s: ls };
    const P = world(e.parent), r = qrot(P.q, [lp[0] * P.s, lp[1] * P.s, lp[2] * P.s]);
    return { p: [P.p[0] + r[0], P.p[1] + r[1], P.p[2] + r[2]], q: qmul(P.q, lq), s: P.s * ls };
  };
  // world -> map: subtract the install offset, undo the install yaw
  const c = Math.cos(-yaw), sn = Math.sin(-yaw);
  const toMap = (v: [number, number, number]): [number, number, number] => { const x = v[0] - at[0], z = v[2] - at[2]; return [x * c + z * sn, v[1] - at[1], -x * sn + z * c]; };
  const dirToMap = (v: [number, number, number]): [number, number, number] => [v[0] * c + v[2] * sn, v[1], -v[0] * sn + v[2] * c];
  const yawOfQ = (q: Q): number => { const f = qrot(q, [0, 0, 1]); return Math.atan2(f[0], f[2]); };
  const lo = Math.min(...map.levels.map((l) => l.floorY)) - 1, hi = Math.max(...map.levels.map((l) => l.floorY)) + 12;
  const levelOf = (y: number): number => map.levels.reduce((best, l) => (l.floorY <= y + 0.5 && l.floorY >= (map.levels.find((x) => x.level === best)?.floorY ?? -Infinity) ? l.level : best), map.levels[0]!.level);
  const own = `dress-${idPart(plan.id)}-`;
  const decals: DressingDecal[] = [], obstacles: DressingObstacle[] = [];
  const measured = new Map<string, [number, number, number] | null>();
  const assets = path.join(proj, "assets");
  for (const [id, e] of Object.entries(E)) {
    if (!e.components.transform) continue;
    const w = world(id), m = toMap(w.p);
    if (m[1] < lo || m[1] > hi) continue;
    if (e.components.decal) {
      const d = e.components.decal;
      decals.push({ id, position: m, direction: dirToMap(qrot(w.q, (d.direction ?? [0, 0, -1]) as [number, number, number])), size: d.size ?? [1, 1], depth: d.depth ?? 0.25, rotation: d.rotation ?? 0, label: d.texture });
      continue;
    }
    const pf = e.components.prefab?.prefabId as string | undefined;
    if (!pf || id.startsWith(own) || (e.tags ?? []).includes(`dress:${plan.id}`)) continue; // own instances, quest objects included, are removed by apply: never obstacles
    let size: [number, number, number] | null | undefined = src0(proj)(pf)?.size as [number, number, number] | undefined;
    if (!size && (e.tags ?? []).includes("statue")) {
      if (!measured.has(pf)) { try { measured.set(pf, measure(prefabGeometry(assets, pf)).size as [number, number, number]); } catch { measured.set(pf, null); } }
      size = measured.get(pf);
    }
    if (!size) continue;
    const yawM = ((yawOfQ(w.q) - yaw) * 180) / Math.PI;
    obstacles.push({ id, level: levelOf(m[1]), at: [m[0], m[2]], size: [size[0] * w.s, size[2] * w.s], yaw: yawM, height: size[1] * w.s, note: e.name ?? pf });
  }
  return { decals, obstacles };
}
let srcCache: ReturnType<typeof sources> | undefined;
const src0 = (proj: string) => (srcCache ??= sources(proj)).prop;

function resolvePlan(proj: string, file: string) {
  const { plan, raw: planRaw } = loadPlan(file);
  const { map, raw: mapRaw } = loadMap(proj, plan.map);
  const src = sources(proj);
  const body = bodyLane(proj);
  const spaceOpt = opt("space");
  if (spaceOpt) plan.space = dressingSpaceSchema.parse(JSON.parse(spaceOpt));
  const scene = opt("scene") && opt("at") ? sceneContext(proj, plan, map) : { decals: [], obstacles: [] };
  // OWNER: what the owner placed by hand stands where they put it — every other item keeps clear of it (an obstacle)
  const loaded = flag("no-owner") ? { owner: null, raw: "" } : loadOwner(ownerFileOf(file));
  // the owner's edits were recorded against the frame the plan was installed with: re-base them onto this --at/--yaw
  const atOpt = opt("at")?.split(",").map(Number);
  const owner = loaded.owner && atOpt?.length === 3 && atOpt.every(Number.isFinite) ? rebaseOwnerOverrides(loaded.owner, { at: atOpt as [number, number, number], yaw: Number(opt("yaw") ?? 0) }) : loaded.owner;
  const ownerRaw = loaded.raw;
  // The owner's state goes INTO the plan before it resolves, so every other item works around it: a moved floor item
  // becomes a floor place at the owner's spot (what stands on it resolves on it there), a swapped one takes the new
  // prop's footprint, a deleted one gives its room back (kept only while something stands on it). Owner-added floor
  // props are obstacles. After resolving, the owner's exact values are applied last (applyOwnerOverrides).
  for (const o of owner?.overrides ?? []) {
    const item = plan.items.find((i) => i.id === o.item);
    if (item && !o.added) {
      if (o.deleted) {
        if (!plan.items.some((i) => i.place.kind === "on" && i.place.item === item.id)) plan.items = plan.items.filter((i) => i !== item);
        continue;
      }
      if (o.set.prop && item.prop) item.prop = o.set.prop;
      const d = src.prop(item.prop);
      if (o.set.pos && item.prop && d?.mount === "floor" && (item.place.kind === "floor" || item.place.kind === "auto" || item.place.kind === "wall"))
        item.place = { kind: "floor", level: 0, at: [o.set.pos[0], o.set.pos[2]], yaw: o.set.yaw ?? 0 };
      continue;
    }
    if (!o.added || o.deleted || !o.set.pos) continue;
    const d = src.prop(o.set.prop ?? "");
    if (!d?.size || d.mount !== "floor" || d.solid === false) continue;
    const k = o.set.scale ?? 1;
    plan.obstacles.push({ id: `owner:${o.item}`, level: 0, at: [o.set.pos[0], o.set.pos[2]], size: [d.size[0]! * k, d.size[2]! * k], yaw: o.set.yaw ?? 0, height: d.size[1]! * k, note: "placed by the owner (fixed)" });
  }
  const result = resolveDressing({ plan, map, prop: src.prop, set: src.set, options: { laneWidth: body.laneWidth }, vocabulary: vocabulary(proj), ...scene });
  for (const p of src.problems) result.violations.push({ item: "", code: "decl-invalid", message: p });
  // QUEST OBJECTS: an item's quest.entity must be declared by the zone's quest plan at this plan's town or place
  // (_dress-quest.mts); a declared object of that location in no plan is a warning
  {
    const poi = dressPoiId({ planId: plan.id, mapSource: (map as { source?: { model?: string } }).source?.model ?? null, flag: opt("poi") ?? null, jobIds: poiJobIds(proj) });
    const q = questFindings(proj, file, plan, poi);
    result.violations.push(...q.violations);
    result.warnings.push(...q.warnings);
  }
  // Instance prop values must name props the prefab declares (expandScene would throw on apply otherwise).
  for (const item of plan.items) {
    if (!item.props || !item.prop) continue;
    const declared = prefabProps(proj, item.prop);
    for (const k of Object.keys(item.props))
      if (!declared.includes(k))
        result.violations.push({ item: item.id, code: "unknown-prop", message: `${item.prop} declares no prop "${k}" (it has: ${declared.join(", ") || "none"})` });
  }
  // real size per kind at the place's scale (room scale, else the plan's space scale, else the scale it was made for)
  const catalogs = inClosure(proj, "authoring/prop-catalogs.json");
  const sizes = kindSizes(fs.existsSync(catalogs) ? (readJson(catalogs) as { realSize?: Parameters<typeof kindSizes>[0] }).realSize : undefined);
  const scales = vocabulary(proj).scales;
  const sizeExempt = realSizeExemptIds((closure(proj) as string[]).map((p) => path.join(PROJECTS, p))); // catalogue rows' realSizeExempt
  for (const p of result.placements) {
    if (/\/chain-\d+$/.test(p.id)) continue; // generated links are stretched on purpose
    if (sizeExempt.has(p.prop)) continue;
    const d = src.prop(p.prop);
    if (!d) continue;
    // A plain object or captured human cargo declared any-scale keeps its physical
    // dimensions; its host culture must not turn it into giant-sized manufacture.
    const scale = d.scale === "any" ? "any" : ((p.room ? plan.rooms[p.room]?.scale : undefined) ?? plan.space?.scale ?? d.scale);
    const issue = realSizeIssue(p.prop, d.size, scale, scales, sizes);
    if (issue) result.violations.push({ item: p.id, code: "wrong-size", message: `${p.prop}: ${issue}${scale ? "" : " (the place declares no scale: human assumed)"}` });
  }
  // owner-made props outrank stand-ins: a superseded prop placed directly, or a prop whose role the owner's prop owns
  // (catalogue supersededFor) without it on or beside it, is a warning (tools/_prop-real-size.mts outrankFindings)
  {
    const roots = (closure(proj) as string[]).map((p) => path.join(PROJECTS, p));
    result.warnings.push(...outrankFindings(result.placements, outrankedIds(roots), supersededIds(roots)));
  }
  // MATERIAL FAMILY: in a dungeon (plan space.kind "dungeon") that owns a palette (<project>/dc-palette), stone props wear
  // the dungeon's stone: a foreign stone material is a violation unless the item swaps it via props.material (_material-family.mts)
  {
    const pname = path.basename(proj);
    const palette = `${pname}/dc-palette`;
    if (plan.space?.kind === "dungeon" && findAsset(proj, `materials/${palette}.json`)) {
      const load = (id: string): PrefabLike | null => { const pf = prefabAt(proj, id); return fs.existsSync(pf) ? (readJson(pf) as PrefabLike) : null; };
      const isStone = (m: string): boolean => {
        if (STONE_NAME.test(m)) return true;
        const mf = findAsset(proj, `materials/${m}.json`);
        return !!mf && (readJson(mf) as { shader?: string }).shader === "terrain-splat";
      };
      for (const item of plan.items) {
        if (!item.prop) continue;
        const v = materialFamilyFinding({ id: item.id, prop: item.prop, props: item.props as Record<string, unknown> | undefined }, load, isStone, `${pname}/`, palette);
        if (v) result.violations.push(v);
      }
    }
  }
  // OWNER, LAST: deleted items never come back, edited ones take the owner's values (and what stands ON them follows),
  // owner-added ones join; the owner's own placements are fixed, so their findings are warnings, never refusals
  const hostOf = new Map(plan.items.filter((i) => i.place.kind === "on").map((i) => [i.id, (i.place as { item: string }).item]));
  const own = applyOwnerOverrides(result.placements, owner, hostOf);
  result.placements = own.placements;
  const ownerHit = (id: string): boolean => [...own.fixed, ...own.deleted].some((o) => id === o || id.startsWith(o + "/") || id === `owner:${o}`);
  const gone = (id: string): boolean => own.deleted.some((o) => id === o || id.startsWith(o + "/"));
  for (const v of result.violations.filter((v) => ownerHit(v.item))) if (!gone(v.item)) result.warnings.push({ ...v, code: `owner-fixed:${v.code}`, message: `(owner placed it; kept) ${v.message}` });
  result.violations = result.violations.filter((v) => !ownerHit(v.item));
  result.warnings = result.warnings.filter((w) => !gone(w.item));
  for (const id of own.stale) result.warnings.push({ item: id, code: "owner-stale", message: `the owner edited "${id}", which this plan no longer has (the override is kept; remove it from ${path.basename(ownerFileOf(file))} if the item is gone for good)` });
  if (owner?.overrides.length) console.log(`OWNER: ${own.fixed.size} prop(s) fixed by the owner, ${own.deleted.length} deleted (never re-added), ${own.added.length} added by the owner — ${path.relative(PLAYGROUND, ownerFileOf(file))}`);
  const h = crypto.createHash("sha256");
  h.update(planRaw).update("\0").update(mapRaw).update("\0").update(ownerRaw);
  for (const k of [...src.used.keys()].sort()) h.update("\0" + k + "\0" + src.used.get(k));
  return { plan, map, result, hash: h.digest("hex").slice(0, 16), src, body, owner, own };
}

/** Names of the props a prefab declares (its tunable knobs), [] when it has none or does not exist. */
function prefabProps(proj: string, prefabId: string): string[] {
  const file = prefabAt(proj, prefabId);
  if (!fs.existsSync(file)) return [];
  return Object.keys((readJson(file) as { props?: Record<string, unknown> }).props ?? {});
}

function printCheck(plan: DressingPlan, map: SocketMap, result: DressingResolveResult, quiet = false): void {
  const lines: string[] = [`PLAN ${plan.id} on map ${map.id}: ${result.placements.length} placements, ${result.violations.length} violations, ${result.warnings.length} warnings`];
  const main = result.placements.filter((p) => !/\/chain-\d+$/.test(p.id));
  const letter = new Map(main.map((p, i) => [p.id, LETTERS[i] ?? "*"]));
  for (const lv of map.levels) {
    const here = main.filter((p) => p.level === lv.level);
    if (!here.length) continue;
    const marks = new Map<string, string>();
    for (const p of here) {
      const c = Math.floor((p.position[0] - lv.origin[0]) / lv.step), r = Math.floor((p.position[2] - lv.origin[1]) / lv.step);
      if (!marks.has(`${c},${r}`)) marks.set(`${c},${r}`, letter.get(p.id)!); // a host keeps its letter; what sits on it is in the list
    }
    lines.push("", `LEVEL ${lv.level}`, ...asciiLevel(lv, marks).slice(0, -1));
  }
  lines.push("", "items (letter id prop room x,y,z yaw°):");
  const chains = new Map<string, number>();
  for (const p of result.placements) {
    const m = /^(.*)\/chain-\d+$/.exec(p.id);
    if (m) chains.set(m[1]!, (chains.get(m[1]!) ?? 0) + 1);
  }
  for (const p of main) {
    const yaw = Math.round((p.yaw * 180) / Math.PI);
    lines.push(`  ${letter.get(p.id)} ${p.id} ${p.prop} ${p.room || "-"} ${p.position.map(f2).join(",")} ${yaw}°${chains.get(p.id) ? ` +${chains.get(p.id)} chain` : ""}`);
  }
  const placed = new Set(result.placements.map((p) => p.id));
  const unplaced = result.violations.filter((v) => v.item && !placed.has(v.item) && !plan.rooms[v.item] && !map.levels.some((l) => l.rooms.some((r) => r.id === v.item)));
  if (unplaced.length) lines.push(`  (not placed: ${[...new Set(unplaced.map((v) => v.item))].join(", ")})`);
  const autoLines = autoText(result);
  if (autoLines.length) lines.push("", ...autoLines);
  const fmt = (v: { item: string; code: string; message: string }): string => `  ${v.item ? `[${letter.get(v.item) ?? "-"}] ${v.item}` : "(plan)"} ${v.code}: ${v.message}`;
  const findings = [...(result.violations.length ? ["VIOLATIONS:", ...result.violations.map(fmt)] : []), ...(result.warnings.length ? ["WARNINGS:", ...result.warnings.map(fmt)] : [])];
  if (quiet) { const out = [...autoText(result), ...findings]; if (out.length) console.log(out.join("\n")); return; } // --quiet: the auto spots and findings only, no plan
  lines.push("", ...(result.violations.length ? [] : ["no violations"]), ...findings);
  console.log(lines.join("\n"));
}

/** The spot chosen for each `auto` item, in plan syntax (paste one over its auto place to freeze it). */
function autoText(result: DressingResolveResult): string[] {
  if (!result.auto?.length) return [];
  const place = (p: DressingPlan["items"][number]["place"]): string => {
    switch (p.kind) {
      case "wall": return `{ "kind": "wall", "wall": "${p.wall}", "t": ${f2(p.t)}${p.height !== undefined ? `, "height": ${f2(p.height)}` : ""} }`;
      case "floor": return `{ "kind": "floor", "level": ${p.level}, "at": [${f2(p.at[0])}, ${f2(p.at[1])}], "yaw": ${p.yaw} }`;
      case "ceiling": return `{ "kind": "ceiling", "level": ${p.level}, "at": [${f2(p.at[0])}, ${f2(p.at[1])}], "drop": ${f2(p.drop)} }`;
      default: return JSON.stringify(p);
    }
  };
  return ["auto spots (earlier items win; paste one over its auto place to freeze it):", ...result.auto.map((a) => `  ${a.item}: ${place(a.place)}${a.mirror ? ` + "mirror": true` : ""}  (${a.note})`)];
}

/** One place, one bucket of lights (tools/light-buckets.json, or the project's authoring/light-buckets.json). */
function lightBucketNotes(proj: string, plan: { lights?: string }, props: string[]): string[] {
  const own = path.join(proj, "authoring", "light-buckets.json");
  const file = fs.existsSync(own) ? own : path.join(PLAYGROUND, "tools", "light-buckets.json");
  if (!fs.existsSync(file)) return [];
  const buckets = (JSON.parse(fs.readFileSync(file, "utf8")) as { buckets: Record<string, { use: string[] }> }).buckets;
  const known = new Set(Object.values(buckets).flatMap((b) => b.use));
  const lights = [...new Set(props.filter((p) => known.has(p)))];
  if (!lights.length) return [];
  if (plan.lights) {
    const b = buckets[plan.lights];
    if (!b) return [`plan names lights "${plan.lights}", which is not a bucket (${Object.keys(buckets).join(", ")})`];
    const out = lights.filter((l) => !b.use.includes(l));
    return out.length ? [`${out.join(", ")} ${out.length > 1 ? "are" : "is"} not in the "${plan.lights}" bucket (${b.use.join(", ")})`] : [];
  }
  const fits = Object.entries(buckets).filter(([, b]) => lights.every((l) => b.use.includes(l))).map(([k]) => k);
  return fits.length ? [] : [`the plan's lights (${lights.join(", ")}) fit no single bucket; pick one of ${Object.keys(buckets).join(", ")} and name it with "lights"`];
}

function check(): void {
  const proj = projectDir();
  const file = planFile(proj, need("plan"));
  const resolved = resolvePlan(proj, file);
  const { plan, map, result, hash } = resolved;
  const quiet = flag("quiet");
  { const cf = coverFindings(proj, file, plan, map, resolved.src, result.placements); result.violations.push(...cf.violations); result.warnings.push(...cf.warnings); }
  for (const w of lightBucketNotes(proj, plan as unknown as { lights?: string }, result.placements.map((p) => p.prop))) console.log(`LIGHTS: ${w}`);
  printCheck(plan, map, result, quiet);
  const report = dressReportFile(file);
  fs.mkdirSync(path.dirname(report), { recursive: true });
  // a report an older dress left beside the plan is replaced by this one in the reports dir
  const legacy = file.replace(/\.json$/, ".report.json");
  if (legacy !== report && fs.existsSync(legacy)) fs.rmSync(legacy);
  fs.writeFileSync(
    report,
    JSON.stringify({ plan: plan.id, map: map.id, hash, ok: result.violations.length === 0, checkedAt: new Date().toISOString(), ...result }, null, 1),
  );
  if (!quiet) console.log(`report -> ${path.relative(PLAYGROUND, report)} (hash ${hash})`);
  if (!result.violations.length) console.log(`readable report -> ${path.relative(PLAYGROUND, writeReport(proj, resolved))}`);
  // ONE last line to find the verdict by
  console.log(`CHECK ${plan.id}: ${result.placements.length} placements, ${result.violations.length} violations, ${result.warnings.length} warnings -> ${result.violations.length ? "FAILED" : "ok"}`);
  process.exit(result.violations.length ? 1 : 0);
}

// ---- apply ----------------------------------------------------------------

const idPart = (s: string): string => s.replace(/\//g, "--");

/** yaw (about +Y) * tilt (a placement's pose rotation, e.g. a book laid flat), as a quaternion [x, y, z, w]. */
function yawTilt(yaw: number, tilt?: [number, number, number, number]): number[] {
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2);
  const [x, y, z, w] = tilt ?? [0, 0, 0, 1];
  return [cy * x + sy * z, cy * y + sy * w, cy * z - sy * x, cy * w - sy * y].map((v) => +v.toFixed(6));
}

/** Components that make a prefab live (behaviour, animation, deformation, nested prefabs, light/flame): never batched. */
const LIVE = ["prefab", "script", "scripts", "animator", "clothSway", "rigidBody", "rigidbody", "light", "particles", "vfx"];

/**
 * Static-batching opt-in for a fixed placement, exactly as authoring/purchased-assets/batch-town-furnishings.mjs does
 * it: a prefab override setting `mesh.static` on every non-moving, non-wind glTF mesh of the prefab. Nothing for
 * props declaring `fire` (flames and lights stay live) or any prefab carrying a LIVE component.
 */
function staticOverrides(proj: string, prefabId: string, fire: boolean): { path: string; value: boolean }[] {
  if (fire) return [];
  const file = prefabAt(proj, prefabId);
  if (!fs.existsSync(file)) return [];
  const prefab = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as {
    entities: Record<string, { components: Record<string, { moving?: boolean; source?: { kind?: string; wind?: unknown } } | undefined> }>;
  };
  const ents = Object.entries(prefab.entities ?? {});
  if (ents.some(([, e]) => Object.keys(e.components ?? {}).some((k) => LIVE.includes(k)))) return [];
  return ents
    .filter(([, e]) => {
      const m = e.components?.mesh;
      return m && !m.moving && m.source?.kind === "asset" && !m.source.wind;
    })
    .map(([local]) => ({ path: `${local}/components/mesh/static`, value: true }));
}

function apply(): void {
  const proj = projectDir();
  const file = planFile(proj, need("plan"));
  const { plan, map, result, hash, src, owner, own } = resolvePlan(proj, file);
  // --lights-only: a building lit before it is furnished (town-lights: every house lit inside at night). The plan may
  // hold ONLY lit fixtures, and the only violations it may carry are the unfurnished-room ones; its `dress check` still
  // FAILS, so the town's `interiors` row stays MISSING until the rooms are furnished.
  const LIGHTS_ONLY_CODES = new Set(["room-empty", "room-sparse", "room-missing"]);
  const lightsOnly = flag("lights-only");
  if (lightsOnly) {
    const notLit = (plan.items ?? []).filter((i) => !/^fixtures\/|-lit\b|candle|lantern|lamp|torch|brazier|hearth|chandelier|sconce/i.test(String(i.prop ?? "")));
    if (notLit.length) fail(`--lights-only: ${notLit.length} item(s) are not lit fixtures (${notLit.slice(0, 3).map((i) => `${i.id} ${i.prop}`).join(", ")})`);
  }
  const blocking = result.violations.filter((v) => !(lightsOnly && LIGHTS_ONLY_CODES.has(v.code)));
  if (blocking.length) {
    printCheck(plan, map, result);
    fail(`refused: the plan has ${blocking.length} violation(s); fix them (dress check) before applying`);
  }
  if (lightsOnly && result.violations.length) console.log(`lights-only: ${result.violations.length} unfurnished-room finding(s) waived for this apply; dress check still fails until the rooms are furnished`);
  const sceneRef = need("scene");
  const sceneFile = fs.existsSync(sceneRef) && sceneRef.endsWith(".json") ? path.resolve(sceneRef) : path.join(proj, "assets", "scenes", `${sceneRef}.scene.json`);
  if (!fs.existsSync(sceneFile)) fail(`no scene ${sceneFile}`);
  const at = need("at").split(",").map(Number);
  if (at.length !== 3 || at.some((v) => !Number.isFinite(v))) fail("--at wants x,y,z");
  const yawDeg = Number(opt("yaw") ?? 0);
  if (!Number.isFinite(yawDeg)) fail("--yaw wants degrees");
  const parent = opt("parent") ?? null;
  const yaw0 = (yawDeg * Math.PI) / 180, c = Math.cos(yaw0), s = Math.sin(yaw0);

  const scene = readJson(sceneFile) as { entities: Record<string, { parent: string | null; tags?: string[] }> }; // re-read: the editor autosaves
  if (parent && !scene.entities[parent]) fail(`--parent ${parent} is not an entity of ${path.basename(sceneFile)}`);
  const prefix = `dress-${idPart(plan.id)}-`;
  // every entity apply adds carries poi:<id> (tools/_dress-poi.mts): the POI's walk, site sockets and gates see its dressing
  const poi = dressPoiId({ planId: plan.id, mapSource: (map as { source?: { model?: string } }).source?.model ?? null, flag: opt("poi") ?? null, jobIds: poiJobIds(proj) });
  const poiTags = poi ? [`poi:${poi}`] : [];
  if (!poi) console.log(`poi: no POI job matches plan ${plan.id} (no --poi, no site socket source, no <poi>-<area> id): its entities carry no poi:<id> tag`);
  const ownerIds = new Set((owner?.overrides ?? []).filter((o) => o.added && o.entity).map((o) => o.entity!));
  const ops: Op[] = [];
  // The tag check keeps plan "a/b" from removing plan "a/b-2"'s entities, which share the id prefix.
  const mine = Object.keys(scene.entities).filter((id) => (id.startsWith(prefix) || ownerIds.has(id) || (scene.entities[id]!.tags ?? []).includes("quest-object")) && (scene.entities[id]!.tags ?? []).includes(`dress:${plan.id}`));
  for (const id of mine) if (!mine.includes(scene.entities[id]!.parent ?? "")) ops.push({ op: "remove-entity", id });
  const removed = ops.length;
  // One group per room: a room is one culling unit and its furniture never batches with another room or the shell
  // (docs/performance-lessons.md "Imported furnishings"). Rooms take the documented furnishing default
  // `culling: { interior: true, reveal: 12 }`; placements with no room (outdoor anchors) get one clutter group with
  // `culling: { minScreenPx: 6 }` (docs/culling.md "Authoring a POI or a building").
  // A site socket map (tools/site-sockets.mts) is OUTDOORS: its one room is an open area, so it culls as clutter, never as
  // an interior (interior + reveal 12 hid a whole yard until the player stood in it).
  const siteMap = /handoff \(site /.test(String((map as { source?: { model?: string } }).source?.model ?? ""));
  const groupOf = (room: string): string => (room ? `${prefix}room-${idPart(room)}` : `${prefix}outdoor`);
  for (const room of [...new Set(result.placements.map((p) => p.room))]) {
    const role = room ? plan.rooms[room]?.role : "";
    ops.push({
      op: "add-entity",
      id: groupOf(room),
      entity: {
        name: room ? `${plan.id} ${room}${role ? ` (${role})` : ""}` : `${plan.id} outside`,
        parent,
        tags: ["dressing", `dress:${plan.id}`, ...poiTags],
        components: {
          transform: {}, culling: room && !siteMap ? { interior: true, reveal: 12 } : { minScreenPx: 6 },
          // Build a room ahead of its reveal distance, rather than fetching/decoding every hidden interior with
          // the whole town. A generous keep band prevents doorway or street-boundary rebuilds.
          ...(room && !siteMap ? { placeStream: { distance: 32, keepPadding: 48, footprintPadding: 2 } } : {}),
        },
      },
    });
  }
  const batch = !flag("no-batch");
  let batched = 0;
  const itemProps = new Map(plan.items.filter((i) => i.props && Object.keys(i.props).length).map((i) => [i.id, i.props!]));
  // owner-added props keep the entity id the editor gave them (the scene and the overrides file stay in step)
  const ownerEntity = new Map((owner?.overrides ?? []).filter((o) => o.added && o.entity).map((o) => [o.item, o.entity!]));
  // QUEST OBJECTS keep their quest entity id exactly (the zone's quest plan binds to it); _dress-quest.mts
  const quests = questPlacements(plan, result.placements);
  const entityOf = (id: string): string => quests.get(id)?.entity ?? ownerEntity.get(id) ?? prefix + idPart(id);
  const decls = quests.size ? questDecls(proj) : [];
  for (const q of quests.values()) {
    const e = scene.entities[q.entity];
    if (e && !(e.tags ?? []).includes(`dress:${plan.id}`)) fail(`quest entity ${q.entity} is already in the scene, placed by something else (tags ${(e.tags ?? []).join(", ")}): remove it with its own installer's inverse first`);
  }
  for (const p of result.placements) {
    const quest = quests.get(p.id);
    const overrides = batch && !quest ? staticOverrides(proj, p.prop, src.prop(p.prop)?.fire ?? false) : [];
    if (overrides.length) batched++;
    const [lx, ly, lz] = p.position;
    const position = [at[0]! + lx * c + lz * s, at[1]! + ly, at[2]! - lx * s + lz * c].map((v) => +v.toFixed(4));
    const y = yaw0 + p.yaw;
    const add = {
      op: "add-entity" as const,
      id: entityOf(p.id),
      entity: {
        name: `${p.id}: ${p.prop}`,
        parent: groupOf(p.room),
        tags: ["dressing", `dress:${plan.id}`, ...poiTags, ...(own.fixed.has(p.id) ? ["owner-fixed"] : [])],
        components: {
          transform: { position, rotation: yawTilt(y, p.tilt), scale: p.scale ?? [1, 1, 1] },
          prefab: { prefabId: p.prop, ...(itemProps.has(p.id) && plan.items.find((i) => i.id === p.id)?.prop === p.prop ? { props: itemProps.get(p.id) } : {}), ...(overrides.length ? { overrides } : {}) },
        } as Record<string, unknown>,
      },
    };
    if (quest) {
      const decl = decls.find((d) => d.id === quest.entity);
      const op = questAddOp(add, quest, { decl, planId: plan.id, poi, places: decl ? placesFor(proj, decl.world, decl.zone, planTown(plan.id)?.town ?? null) : undefined });
      console.log(`quest object: ${op.id} <- item ${p.id} (${p.prop}), npc ${JSON.stringify((op.entity.components["script"] as { params: unknown }).params)}`);
      ops.push(op as Op);
    } else ops.push(add as Op);
  }
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  let { doc, inverse } = applyOps(scene as never, ops, reg);
  // every batch below is re-applied onto the FRESH scene under its lock at write time (tools/_scene-write.mts)
  const batches: Op[][] = [ops];
  // SEAT (voxel/seat.ts): the plan's y is the socket map's floor, measured earlier; every placed prop is now
  // measured on the REAL solid under its footprint (DC floors, decks, colliders, the field) by its catalogue contact
  // and re-seated in a second batch — the inverse undoes both. No support at all is reported, not hidden.
  if (!flag("no-seat")) {
    // the owner's own placements are where the owner put them: never re-seated
    const placed = new Set(result.placements.filter((p) => !own.fixed.has(p.id)).map((p) => entityOf(p.id)));
    // in passes (as float --fix): a candle placed on a crate's PLANNED top stays in the air when the crate itself is then
    // re-seated onto the real floor (the plan's floor y 10 cm off the rock), so the next pass sets it on the crate's new top
    let seat = seatPlaced(path.basename(proj), doc as never, placed), moved = 0;
    seat.ops = rigidChains(doc as never, seat.ops);
    for (let pass = 0; pass < 4 && seat.ops.length; pass++) {
      const second = applyOps(doc, seat.ops, reg);
      batches.push(seat.ops as Op[]);
      doc = second.doc;
      inverse = [...second.inverse, ...inverse];
      moved += seat.ops.length;
      seat = seatPlaced(path.basename(proj), doc as never, placed);
      seat.ops = rigidChains(doc as never, seat.ops);
    }
    console.log(`seat: ${moved} re-seats of ${placed.size} props on the real floor${seat.unsupported.length ? `; ${seat.unsupported.length} with NO support (move them in the plan): ${seat.unsupported.slice(0, 6).map((r) => r.id.slice(prefix.length)).join(", ")}` : ""}`);
  }
  // THE PLACEMENT SOLVER (t-place 2026-10-30, Derek: "Am I close to a doorway? I should delete myself"): every floor prop
  // this apply placed is judged in plan against the scene's structure data — door / gate / stair / hearth clear zones
  // (the WFC buildings' markers, props' declared openings) and every solid structure's base — and moved out (its
  // placeRule tolerance, 1.5 m by default) or DROPPED with the reason; a moved prop is seated again on the real floor.
  // Owner-fixed props and quest objects are where their owner put them. `--no-solve` skips it.
  let solverRows: SolveRow[] = [];
  // OPT-IN (`--solve`) until it matches legacy on Red Dial and the smalls (coordinator 2026-10-30: its unsupported-prop
  // relocation pushed three heaps into one 5 m cell, failing site-spread)
  if (flag("solve") && !flag("no-solve")) {
    const floorIds = new Set(result.placements.filter((p) => !own.fixed.has(p.id) && !quests.has(p.id) && (src.prop(p.prop)?.mount ?? "floor") === "floor").map((p) => entityOf(p.id)));
    const sv = solveScenePieces(path.basename(proj), doc as never, () => 0, floorIds, { movable: true, removeDropped: true, keepY: true });
    solverRows = sv.rows.filter((r) => r.status !== "ok");
    if (sv.ops.length) {
      const fourth = applyOps(doc, sv.ops as Op[], reg);
      batches.push(sv.ops as Op[]);
      doc = fourth.doc;
      inverse = [...fourth.inverse, ...inverse];
      // a moved prop stands on the real floor at its new spot
      const moved = new Set(sv.rows.filter((r) => r.status === "moved").map((r) => r.id));
      const again = moved.size ? seatPlaced(path.basename(proj), doc as never, moved) : { ops: [] as unknown[] };
      if (again.ops.length) { const fifth = applyOps(doc, again.ops as Op[], reg); batches.push(again.ops as Op[]); doc = fifth.doc; inverse = [...fifth.inverse, ...inverse]; }
    }
    // NO SUPPORT on the real floor (a heap straddling a step, a crate over a lip): the solver's candidate spots, nearest
    // first within 1.5 m, each seated on the real floor; the first one the seat supports is kept, else the prop is DROPPED
    // with its reason (never left floating for the float gate to catch)
    const loose = seatPlaced(path.basename(proj), doc as never, floorIds).unsupported.map((r) => r.id).filter((id) => doc.entities[id]);
    // SPREAD (site-spread, coordinator 2026-10-30: three heaps pushed into one 5 m cell): the nearest supported spot that
    // never puts 3+ of the plan's props in one 5 m cell (spreadSpots), else the prop is dropped
    const others = (id: string): [number, number][] => [...floorIds].filter((o) => o !== id && doc.entities[o]).map((o) => { const q = (doc.entities[o]!.components.transform as { position: number[] }).position; return [q[0]!, q[2]!]; });
    for (const id of loose) {
      const t0 = doc.entities[id]!.components.transform as { position: number[] };
      let fixed = false;
      for (const [dx, dz] of spreadSpots([t0.position[0]!, t0.position[2]!], others(id))) {
        const tryOps = [{ op: "set-component", id, component: "transform", data: { ...t0, position: [t0.position[0]! + dx, t0.position[1]!, t0.position[2]! + dz] } }] as Op[];
        const trial = applyOps(doc, tryOps, reg).doc, st = seatPlaced(path.basename(proj), trial as never, new Set([id]));
        if (st.unsupported.length) continue;
        const all = [...tryOps, ...(st.ops as Op[])], app = applyOps(doc, all, reg);
        batches.push(all); doc = app.doc; inverse = [...app.inverse, ...inverse]; fixed = true;
        solverRows.push({ id, prefab: String((doc.entities[id]!.components.prefab as { prefabId?: string } | undefined)?.prefabId ?? ""), status: "moved", notes: [`no support on the real floor at its spot: moved ${Math.round(Math.hypot(dx, dz) * 100) / 100} m`], moved: Math.round(Math.hypot(dx, dz) * 100) / 100 });
        break;
      }
      if (fixed) continue;
      const rm = [{ op: "remove-entity", id }] as Op[], app = applyOps(doc, rm, reg);
      batches.push(rm); doc = app.doc; inverse = [...app.inverse, ...inverse];
      solverRows.push({ id, prefab: "", status: "dropped", reason: "no support on the real floor within 1.5 m (a step, a lip or a hole under it)", notes: [] });
    }
    if (solverRows.length) console.log(`solver: ${solverRows.filter((r) => r.status === "moved").length} moved, ${solverRows.filter((r) => r.status === "dropped").length} dropped of ${floorIds.size} floor props:\n  ${solverRows.slice(0, 12).map(solveLine).join("\n  ")}`);
    const lint = repeatsInOps(ops);
    if (lint.length) console.log(`REPEATS: this apply writes ${lint.length} repeated inline structure(s) (anything repeated is one prefab): ${lint.map((f) => `${f.rule} ${f.key} x${f.ids.length}`).join("; ")}`);
  }
  // SKIN (voxel/rock-cap.ts): a placed rock is the stone of its place and wears the ground's cap, as the scatter rocks
  // beside it do: the world's rock material + the resolver's rockCap per instance (no material per instance)
  {
    const placed = new Set(result.placements.map((p) => entityOf(p.id)));
    const field = fieldOfScene(path.basename(proj), doc as never);
    const skin = field ? skinPlacedOps(path.basename(proj), doc, field, placed) : { ops: [], changed: [] };
    if (skin.ops.length) {
      const third = applyOps(doc, skin.ops, reg);
      batches.push(skin.ops as Op[]);
      doc = third.doc;
      inverse = [...third.inverse, ...inverse];
      console.log(`skin: ${skin.changed.length} placed rock(s) take their place's stone and cap (worldgen rock-skins)`);
    }
  }
  const inverseFile = file.replace(/\.json$/, ".inverse.json");
  // CLEARING: trees must never grow through a dressed room — one vegetation clearing per room in the scene's world
  // GRASS RULE (Derek: "grass and high grass should be cleared below a hut"): outdoors the room disc keeps cover, but every
  // dwelling / fire / bedding footprint gets its own disc with cover CLEARED (+1.5 m, 3 m round a fire)
  const footprints = siteMap ? coverFootprints(src, result.placements).map((d) => ({ ...d, center: [+(at[0]! + d.center[0] * c + d.center[1] * s).toFixed(2), +(at[2]! - d.center[0] * s + d.center[1] * c).toFixed(2)] as [number, number], cover: true })) : [];
  const clearing = plan.clearing === false || flag("no-clearing") ? null : dressClearings(proj, doc, plan.id, [...roomDiscs(map, result.placements, at, c, s, plan.clearing?.pad ?? 2), ...footprints], plan.clearing?.cover ?? !siteMap, flag("dry"));
  console.log(`${flag("dry") ? "DRY RUN: would apply" : "applied"} one batch to ${path.relative(PLAYGROUND, sceneFile)}: removed ${removed} previous root(s) of ${prefix}*, added ${new Set(result.placements.map((p) => p.room)).size} room group(s) + ${result.placements.length} prefab instances, ${batched} opted into static batching${batch ? "" : " (--no-batch)"} (plan hash ${hash})${result.warnings.length ? `; ${result.warnings.length} warnings (dress check)` : ""}`);
  if (flag("dry")) return;
  inverse = applyBatchesToSceneFile(sceneFile, batches, (d, o) => applyOps(d, o, reg), { label: `dress apply ${plan.id}`, trailer: "" }).inverse;
  // the frame is recorded so the editor can write the owner's edits back in the plan's own (map-local) frame
  fs.writeFileSync(inverseFile, JSON.stringify({ plan: plan.id, scene: path.relative(PLAYGROUND, sceneFile), hash, frame: { at, yaw: yawDeg }, parent, ops: inverse, ...(clearing ? { clearings: clearing } : {}), ...(solverRows.length ? { solver: solverRows } : {}) }, null, 1));
  console.log(`inverse -> ${path.relative(PLAYGROUND, inverseFile)}`);
}

// ---- clearings (vegetation kept off dressed rooms) -------------------------

/** Map-frame discs (cover to CLEAR) under every placed dwelling, fire and bedding: catalogue footprint + 1.5 m (3 m at a fire). */
function coverFootprints(src: ReturnType<typeof sources>, placements: { id: string; prop: string; position: number[] }[]): { room: string; center: [number, number]; radius: number }[] {
  const out: { room: string; center: [number, number]; radius: number }[] = [];
  for (const p of placements) {
    const d = src.prop(p.prop) as { fire?: boolean; mount?: string; category?: string; size?: number[] } | undefined;
    const kind = needsClearedCover(p.prop, d);
    if (!kind) continue;
    const half = d?.size ? Math.hypot(d.size[0]!, d.size[2]!) / 2 : 2;
    out.push({ room: `fp-${p.id}`, center: [p.position[0]!, p.position[2]!], radius: +(half + (kind === "fire" ? 3 : 1.5)).toFixed(2) });
  }
  return out;
}

/** The grass rule at check time: a dwelling / fire on an outdoor site must stand on cover the world clears (or that apply will). */
function coverFindings(proj: string, file: string, plan: DressingPlan, map: SocketMap, src: ReturnType<typeof sources>, placements: { id: string; prop: string; position: number[] }[]): { violations: { item: string; code: string; message: string }[]; warnings: { item: string; code: string; message: string }[] } {
  const out = { violations: [] as { item: string; code: string; message: string }[], warnings: [] as { item: string; code: string; message: string }[] };
  const siteMap = /handoff \(site /.test(String((map as { source?: { model?: string } }).source?.model ?? ""));
  if (!siteMap) return out;
  const fps = coverFootprints(src, placements);
  if (!fps.length) return out;
  const sceneRef = opt("scene");
  const sceneDoc = sceneRef ? readJson(fs.existsSync(sceneRef) ? sceneRef : path.join(proj, "assets", "scenes", `${sceneRef}.scene.json`)) : null;
  const worldFile = sceneDoc ? sceneWorldFile(proj, sceneDoc) : findAsset(path.basename(proj), `worlds/${path.basename(proj)}.json`) ?? null;
  const world = worldFile ? ((readJson(worldFile) as { features?: { clearings?: { center?: [number, number]; radius?: number; cover?: boolean }[] } }).features?.clearings ?? []) : [];
  const applied = fs.existsSync(file.replace(/.json$/, ".inverse.json"));
  for (const d of fps) {
    if (discCleared(d.center, d.radius - 0.05, world)) continue;
    const item = d.room.slice(3);
    if (plan.clearing === false) out.violations.push({ item, code: "cover-not-cleared", message: `${item} is a dwelling/fire on an outdoor site but the plan sets clearing: false: ground cover grows through it (clear footprint + 1.5 m, 3 m at a fire)` });
    else if (applied) out.violations.push({ item, code: "cover-not-cleared", message: `${item} stands on uncleared ground cover in ${worldFile ? path.relative(PLAYGROUND, worldFile) : "the world"} (applied before the grass rule): re-run dress apply to write its cover-cleared footprint clearing` });
    else out.warnings.push({ item, code: "cover-cleared-on-apply", message: `${item}: apply writes a cover-cleared footprint clearing r ${d.radius} m` });
  }
  return out;
}

/** World discs, one per room the plan furnishes: its socket-map bbox (or, outdoors with no room, its placements) + pad. */
function roomDiscs(map: { levels: { rooms: { id: string; bbox: [number, number, number, number] }[] }[] }, placements: { room: string; position: number[] }[], at: number[], c: number, s: number, pad: number): { room: string; center: [number, number]; radius: number }[] {
  const out: { room: string; center: [number, number]; radius: number }[] = [];
  const world = (lx: number, lz: number): [number, number] => [+(at[0]! + lx * c + lz * s).toFixed(2), +(at[2]! - lx * s + lz * c).toFixed(2)];
  for (const room of [...new Set(placements.map((p) => p.room))]) {
    let box: [number, number, number, number] | undefined;
    for (const lv of map.levels) box ??= lv.rooms.find((r) => r.id === room)?.bbox;
    if (!box) {
      const ps = placements.filter((p) => p.room === room);
      box = [Math.min(...ps.map((p) => p.position[0]!)), Math.max(...ps.map((p) => p.position[0]!)), Math.min(...ps.map((p) => p.position[2]!)), Math.max(...ps.map((p) => p.position[2]!))];
    }
    const [x0, x1, z0, z1] = box;
    out.push({ room: room || "outdoor", center: world((x0 + x1) / 2, (z0 + z1) / 2), radius: +(Math.hypot(x1 - x0, z1 - z0) / 2 + pad).toFixed(2) });
  }
  return out;
}

const clearingOwner = (planId: string): string => `dress-${idPart(planId)}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/** The world recipe file a scene streams (its voxelWorld), or null for a scene without one (a dungeon). */
function sceneWorldFile(proj: string, doc: unknown): string | null {
  let worldId: string | undefined;
  for (const e of Object.values((doc as { entities: Record<string, { components?: { voxelWorld?: { world?: string } } }> }).entities)) worldId ??= e.components?.voxelWorld?.world;
  return worldId ? findAsset(path.basename(proj), `worlds/${worldId}.json`) ?? null : null;
}

/**
 * Replace the plan's clearings (owner `dress-<plan>`) in the scene's world with `discs`. Clearings of every other owner
 * (poi-dressing, a town's plots ...) are left exactly as they are. Returns what was there before (the inverse), or null
 * when the scene has no voxel world.
 */
function dressClearings(proj: string, doc: unknown, planId: string, discs: { room: string; center: [number, number]; radius: number; cover?: boolean }[], cover: boolean, dry: boolean, remove = false): { world: string; owner: string; before: ClearingDoc[]; after: string[] } | null {
  const file = sceneWorldFile(proj, doc);
  if (!file) return null;
  const owner = clearingOwner(planId);
  const raw = readJson(file) as { features: { clearings?: ClearingDoc[] } };
  const all = raw.features.clearings ?? [];
  const before = all.filter((cl) => cl.owner === owner);
  const next: ClearingDoc[] = remove ? [] : discs.map((d) => clearingSchema.parse({ id: `${owner}-${d.room}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"), center: d.center, radius: d.radius, feather: 3, keep: 0, scatter: true, cover: d.cover ?? cover, owner }));
  const kept = all.filter((cl) => cl.owner !== owner && !next.some((n) => n.id === cl.id));
  raw.features.clearings = [...kept, ...next];
  if (raw.features.clearings.length === 0) delete raw.features.clearings;
  const parsed = worldRecipeSchema.safeParse(raw);
  if (!parsed.success) fail(`clearing: refusing to write an invalid world ${file}: ${parsed.error.issues[0]?.message}`);
  console.log(`clearing: ${remove ? "removed" : "wrote"} ${remove ? before.length : next.length} vegetation clearing(s) owner ${owner} in ${path.relative(PLAYGROUND, file)}${remove ? "" : ` (scatter cleared, cover ${cover ? "cleared" : "kept"}; ${before.length} replaced)`}${dry ? " — DRY RUN, not written" : ""}`);
  if (!dry) fs.writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}
`);
  return { world: path.relative(PLAYGROUND, file), owner, before, after: next.map((n) => n.id) };
}

function unclear(): void {
  const proj = projectDir();
  const file = planFile(proj, need("plan"));
  const plan = dressingPlanSchema.parse(readJson(file));
  const sceneRef = need("scene");
  const sceneFile = fs.existsSync(sceneRef) && sceneRef.endsWith(".json") ? path.resolve(sceneRef) : path.join(proj, "assets", "scenes", `${sceneRef}.scene.json`);
  if (!fs.existsSync(sceneFile)) fail(`no scene ${sceneFile}`);
  if (!dressClearings(proj, readJson(sceneFile), plan.id, [], false, flag("dry"), true)) console.log("clearing: the scene has no voxel world; nothing to remove");
}

// ---- report / walk --------------------------------------------------------

const reportsDir = (proj: string): string => path.join(proj, "authoring", "dressing", "reports");
const md = (s: unknown): string => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function placeText(place: DressingPlan["items"][0]["place"]): string {
  switch (place.kind) {
    case "floor": return `floor L${place.level} [${place.at.map(f2).join(", ")}]${place.yaw ? ` ${place.yaw}°` : ""}`;
    case "wall": return `wall ${place.wall} at ${f2(place.t)} m${place.height !== undefined ? `, ${f2(place.height)} m up` : ""}`;
    case "ceiling": return `ceiling L${place.level} [${place.at.map(f2).join(", ")}]${place.drop ? `, drop ${f2(place.drop)} m` : ""}`;
    case "on": return `on ${place.item}${place.socket ? `.${place.socket}` : ""}`;
    case "anchor": return `anchor ${place.anchor}`;
    case "auto": return `auto in ${place.room}${place.prefer ? `, ${place.prefer}` : ""}${place.near ? ` near ${place.near}` : ""}`;
  }
}

/**
 * The readable furnishing report (authoring/dressing/reports/<plan>.md): rooms with role and occupants and their
 * density against the limits, every item with where and why, the check's findings and the last real-body walk.
 */
function writeReport(proj: string, r: ReturnType<typeof resolvePlan>): string {
  const { plan, map, result, hash, src, body } = r;
  const ok = result.violations.length === 0;
  const L: string[] = [`# Furnishing report: ${plan.id}`, ""];
  L.push(`Socket map \`${map.id}\`${map.source ? ` (from \`${map.source.model}\`)` : ""}. Plan hash \`${hash}\`, checked ${new Date().toISOString().slice(0, 16).replace("T", " ")}.`);
  L.push(`Check: **${ok ? "ok" : "FAILED"}**, ${plan.items.length} plan entries -> ${result.placements.length} placements, ${result.violations.length} violations, ${result.warnings.length} warnings.`);
  L.push(`Walkable lane ${f2(body.laneWidth)} m = player capsule ${f2(body.radius * 2)} m wide x ${f2(body.height)} m tall + ${f2(LANE_COMFORT)} m comfort each side (${body.source}).`, "");
  // rooms
  L.push("## Rooms", "", "| Room | Level | Role | Also used as | Who | Wealth | Free floor | Items (min) | Solid cover (ceiling) | Loose on floor (budget) |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const lv of map.levels)
    for (const room of lv.rooms) {
      const spec = plan.rooms[room.id], role = spec?.role ?? "";
      const b = roomBudget(room.area, role);
      const here = result.placements.filter((p) => p.room === room.id && !/\/chain-\d+$/.test(p.id));
      let cover = 0, loose = 0;
      for (const p of here) {
        const d = src.prop(p.prop);
        if (!d || d.mount !== "floor" || !d.solid) continue;
        const item = plan.items.find((i) => i.id === p.id);
        if (item && item.place.kind === "anchor") continue;
        cover += d.size[0] * d.size[2];
        if (isLooseClutter(d)) loose++;
      }
      const pct = room.area ? Math.round((cover / room.area) * 100) : 0;
      L.push(`| ${room.id} | ${lv.level} | ${md(role || "-")} | ${md(spec?.also?.join(", ") || "-")} | ${md(spec?.owner || "-")} | ${md(spec?.wealth || "-")} | ${f2(room.area)} m² | ${here.length} (${b.minItems}) | ${f2(cover)} m², ${pct}% (${Math.round(b.maxCover * 100)}%)${cover > b.maxCoverM2 ? " **over**" : ""} | ${loose} (${b.loose})${loose > b.loose ? " **over**" : ""} |`);
    }
  // declared role zones of open-plan rooms (plan.zones)
  if (result.zones?.length) {
    L.push("", "## Zones", "", "| Zone | Level | Role | Area | Items (min) | Wall items (min) | Lights |", "|---|---|---|---|---|---|---|");
    for (const z of result.zones)
      L.push(`| ${md(z.zone)} | ${z.level} | ${md(z.role || "-")} | ${f2(z.area)} m² | ${z.items} (${z.minItems || "open"}) | ${z.wall.length} (${z.minWall})${z.wall.length ? `: ${md(z.wall.join(", "))}` : ""} | ${z.lights} |`);
  }
  // items
  L.push("", "## Items", "", "| Item | Prop or set | Where | Room | Why |", "|---|---|---|---|---|");
  for (const item of plan.items) {
    const pl = result.placements.find((p) => p.id === item.id || p.id.startsWith(`${item.id}/`));
    L.push(`| ${md(item.id)} | ${md(item.prop || `set ${item.set}`)} | ${md(placeText(item.place))}${pl ? ` -> (${pl.position.map(f2).join(", ")})` : " -> not placed"} | ${pl?.room || "-"} | ${md(item.note || "")} |`);
  }
  // findings
  const fmt = (v: { item: string; code: string; message: string }): string => `- \`${v.code}\` ${v.item ? `**${md(v.item)}**: ` : ""}${md(v.message)}`;
  L.push("", "## Check", "");
  if (ok && !result.warnings.length) L.push("No violations, no warnings.");
  if (result.violations.length) L.push("### Violations", "", ...result.violations.map(fmt), "");
  if (result.warnings.length) L.push("### Warnings", "", ...result.warnings.map(fmt), "");
  // walk
  const walkFile = path.join(dressDir(proj, "plans"), `${plan.id}.walk.json`);
  L.push("", "## Real-body walk", "");
  if (!fs.existsSync(walkFile)) L.push(`Not walked yet: \`npx tsx tools/dress.mts walk --project ${path.basename(proj)} --plan ${plan.id} --scene <scene>\`.`);
  else {
    const w = JSON.parse(fs.readFileSync(walkFile, "utf8")) as import("./dress-walk.mts").WalkReport;
    L.push(`Scene \`${w.scene}\`, building \`${w.building}\`, walked ${w.walkedAt.slice(0, 16).replace("T", " ")} with the real player body (${f2(w.capsule.radius * 2)} x ${f2(w.capsule.height)} m) among ${w.props} solid installed props. Ground floor: **${w.groundOk ? "ok" : "FAILED"}**, upper floors: **${w.upperOk === false ? "FAILED" : w.upperOk ? "ok" : "not walked"}** (both gate the walk).`, "");
    L.push("| Route | Result | Reached | Feet y (floor) | Planned | Stuck points |", "|---|---|---|---|---|---|");
    for (const x of w.routes) {
      const res = !x.finished ? "FAIL" : x.stuck.length ? "needed a jump" : "ok";
      const st = x.stuck.map((s) => `at ${s.along} m [${s.at.join(", ")}] ${s.jumped ? "(got past)" : "(no way past)"}, nearest prop ${md(s.nearestProp)}`).join("; ") || md(x.note ?? "-");
      L.push(`| ${x.id} | ${res} | ${x.reached} / ${x.metres} m | ${x.feetY} (${x.wantY}) | ${x.planned} | ${st} |`);
    }
  }
  fs.mkdirSync(reportsDir(proj), { recursive: true });
  const out = path.join(reportsDir(proj), `${plan.id}.md`);
  fs.writeFileSync(out, L.join("\n") + "\n");
  return out;
}

function report(): void {
  const proj = projectDir();
  const file = planFile(proj, need("plan"));
  const r = resolvePlan(proj, file);
  const out = writeReport(proj, r);
  console.log(`report -> ${path.relative(PLAYGROUND, out)} (${r.result.violations.length} violations, ${r.result.warnings.length} warnings)`);
}

/**
 * review: one summary per plan, never writing anything. Per room: wall share (furniture backed on or hung on a wall),
 * centre clutter 0..100 (solid non-set-piece props reaching the room's keep-clear middle), scale/culture violations;
 * per declared plan zone (`zones[]`, the role zones of an open-plan room): items, wall items, lights;
 * then the plan's violations by code. --all reviews every plan of the project (ids rime-hall-*.json, not reports).
 */
const RULE_WARNINGS = new Set(["chapel-altar", "chapel-pews", "no-chandelier", "zone-sparse"]);
function review(): void {
  const proj = projectDir();
  const files = flag("all")
    ? fs.readdirSync(dressDir(proj, "plans")).filter((f) => f.endsWith(".json") && !/\.(report|inverse|parked|walk)\.json$|\.parked\./.test(f)).map((f) => path.join(dressDir(proj, "plans"), f))
    : [planFile(proj, need("plan"))];
  const tot = { plans: 0, violations: 0, centre: 0, scale: 0, culture: 0 };
  for (const file of files) {
    let r: ReturnType<typeof resolvePlan>;
    try { r = resolvePlan(proj, file); } catch (e) { console.log(`REVIEW ${path.basename(file)}: cannot resolve (${(e as Error).message})`); continue; }
    const { plan, result } = r, rv = result.review ?? [];
    const by = new Map<string, number>();
    for (const v of result.violations) by.set(v.code, (by.get(v.code) ?? 0) + 1);
    const sp = plan.space;
    console.log(`REVIEW ${plan.id}${sp ? ` (${sp.kind}${sp.scale ? `, ${sp.scale}` : ""}${sp.cultures.length ? `, ${sp.cultures.join("/")}` : ""})` : ""}: ${result.placements.length} placements, ${result.violations.length} violations` +
      `${by.size ? ` [${[...by].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}]` : ""}, ${result.warnings.length} warnings`);
    for (const x of rv) {
      if (!x.items && !plan.rooms[x.room]) continue;
      console.log(`  ${x.room} ${x.role || "-"} ${x.area.toFixed(0)} m²: ${x.items} items, wall share ${Math.round(x.wallShare * 100)}%, centre ${x.centreM2 ? `${x.centreM2} m², clutter ${x.centreClutter}/100${x.centreItems.length ? ` (${x.centreItems.join(", ")})` : ""}` : "none (too small)"}` +
        `${x.keepCentre ? " [kept clear]" : ""}, scale ${x.scaleViolations}, culture ${x.cultureViolations}` +
        `${x.chandelier === undefined ? "" : `, ridge ${x.ridge?.toFixed(1)} m ${x.chandelier ? "with its chandelier" : "NO CHANDELIER"}`}`);
      tot.centre += x.centreItems.length;
      tot.scale += x.scaleViolations;
      tot.culture += x.cultureViolations;
    }
    // declared role zones of open-plan rooms (plan.zones): each counted on its own
    for (const z of result.zones ?? [])
      console.log(`  zone ${z.zone} L${z.level} ${z.role || "-"} ${z.area.toFixed(0)} m²: ${z.items} items (min ${z.minItems || "open"}), ` +
        `${z.wall.length} wall items (min ${z.minWall})${z.wall.length ? ` [${z.wall.join(", ")}]` : ""}, ${z.lights} lights` +
        `${z.wall.length < z.minWall ? " WALL-SHORT" : ""}${z.items < z.minItems ? " SPARSE" : ""}`);
    // the owner's rulings (2026-10-20) that are warnings: chapels, tall rooms
    for (const w of result.warnings.filter((w) => RULE_WARNINGS.has(w.code))) console.log(`  WARN ${w.code} ${w.item}: ${w.message}`);
    tot.plans++;
    tot.violations += result.violations.length;
  }
  if (files.length > 1) console.log(`REVIEW TOTAL: ${tot.plans} plans, ${tot.violations} violations, ${tot.centre} items in room centres, ${tot.scale} wrong-scale, ${tot.culture} wrong-culture`);
}

async function walk(): Promise<void> {
  const proj = projectDir();
  const file = planFile(proj, need("plan"));
  const r = resolvePlan(proj, file);
  const { walkPlan } = await import("./dress-walk.mts");
  // --out <file> walks without touching the plan's walk record or report (a trial); --speed <m/s> overrides the jog
  const trial = opt("out");
  const out = trial ? path.resolve(trial) : path.join(dressDir(proj, "plans"), `${r.plan.id}.walk.json`);
  const speed = opt("speed") ? Number(opt("speed")) : undefined;
  const w = await walkPlan({ playground: PLAYGROUND, projectDir: proj, planId: r.plan.id, map: r.map, scene: need("scene"), prop: r.src.prop, body: r.body, out, speed });
  console.log(`walk -> ${path.relative(PLAYGROUND, out)}${trial ? " (trial: plan report untouched)" : `; report -> ${path.relative(PLAYGROUND, writeReport(proj, r))}`}`);
  const upper = w.routes.filter((x) => x.kind === "upper" && (!x.finished || x.stuck.length));
  if (upper.length) console.log(`UPPER FLOORS: ${upper.map((x) => x.id).join(", ")} did not get there cleanly`);
  console.log(`WALK ${r.plan.id}: ${w.ok ? "ok" : "FAILED"}; ground floor ${w.groundOk ? "ok" : "FAILED"} (${w.routes.filter((x) => x.kind === "ground").length} routes), upper ${w.routes.filter((x) => x.kind === "upper").length - upper.length}/${w.routes.filter((x) => x.kind === "upper").length} ok`);
  process.exit(w.ok ? 0 : 1);
}

// ---- fixtures -------------------------------------------------------------

/**
 * The default lit prefab per fixture-anchor kind (anchors come from a building's `.markers.json` via `dress sockets`).
 * `props` derives instance prop values from the anchor (a hearth's opening width picks the fire size); everything
 * else is the prefab's own defaults, so the look stays editable in one file (docs/prop-cataloging.md "Lit fixtures").
 */
/** A fixture item id from its anchor id: kit markers are named `<model>:<kind>-<n>`, and a plan item id takes letters, digits, . _ - only. */
const fxId = (anchor: string): string => `fx-${anchor.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
const FIXTURE_DEFAULTS: Record<string, { prop: string; props?: (a: SocketMap["anchors"][number]) => Record<string, unknown> | undefined } | null> = {
  hearth: { prop: "fixtures/hearth-fire", props: hearthSize },
  forge: { prop: "fixtures/hearth-fire", props: hearthSize },
  sconce: { prop: "fixtures/sconce-fire" },
  lantern: { prop: "fixtures/lantern-glow" },
  chandelier: { prop: "fixtures/chandelier-a-lit" },
  "candle-niche": { prop: "fixtures/niche-candle-lit" },
  "chimney-top": null, // a smoke point: nothing until the project has a smoke effect
};
/**
 * A fire opening 1.4 m or wider burns the large hearth fire with an ember bed spread to ~70% of the opening; narrower
 * ones keep the prefab defaults (the small fire, sized for the kit's 0.9 m opening). Light colour/intensity/range are
 * never set here: they stay the prefab's, so one edit of fixtures/hearth-fire.json retunes every hearth.
 */
const EMBER_BED_W = 0.655; // poi-props/loose-embers-embers.glb, metres across
function hearthSize(a: SocketMap["anchors"][number]): Record<string, unknown> | undefined {
  const [w, , d] = a.size ?? [];
  if (w === undefined || w < 1.4) return undefined;
  const sx = +((w * 0.7) / EMBER_BED_W).toFixed(2), sz = +(Math.min(d ?? w, w) * 0.6 / EMBER_BED_W).toFixed(2);
  return { fire: "env/fire-hearth-large", bed: [sx, 1, Math.max(1, sz)] };
}

function fixtures(): void {
  const proj = projectDir();
  const { map } = loadMap(proj, need("map"));
  const ref = opt("plan") ?? map.id;
  const file = fs.existsSync(ref) && ref.endsWith(".json") ? path.resolve(ref) : path.join(dressDir(proj, "plans"), `${ref}.json`);
  const existing = fs.existsSync(file) ? (readJson(file) as DressingPlanInput) : { id: ref, map: map.id, rooms: {}, items: [] };
  if (existing.map !== map.id) fail(`plan ${ref} dresses map ${existing.map}, not ${map.id}`);
  const items = [...(existing.items ?? [])];
  const ids = new Set(items.map((i) => i.id));
  const used = new Set(items.filter((i) => i.place?.kind === "anchor").map((i) => (i.place as { anchor: string }).anchor));
  for (const a of map.anchors) if (ids.has(fxId(a.id))) used.add(a.id); // a ceiling fixture is placed by a ceiling place named after it
  const added: string[] = [], skipped: string[] = [];
  for (const a of map.anchors) {
    if (!(a.kind in FIXTURE_DEFAULTS)) continue;
    const def = FIXTURE_DEFAULTS[a.kind];
    if (used.has(a.id)) { skipped.push(`${a.id} (already placed)`); continue; }
    if (!def) { skipped.push(`${a.id} (${a.kind}: no default fixture)`); continue; }
    if (!fs.existsSync(prefabAt(proj, def.prop))) { skipped.push(`${a.id} (${def.prop} missing)`); continue; }
    let id = fxId(a.id);
    for (let k = 2; ids.has(id); k++) id = `${fxId(a.id)}-${k}`;
    ids.add(id);
    const props = def.props?.(a);
    // A chandelier hangs by a `ceiling` place at the anchor (chain + headroom checked); the drop is ceiling - hook.
    let place: NonNullable<DressingPlanInput["items"]>[number]["place"] = { kind: "anchor", anchor: a.id };
    if (a.mount === "ceiling") {
      const lv = map.levels.find((l) => l.level === a.level);
      if (lv) {
        const c = Math.floor((a.position[0] - lv.origin[0]) / lv.step), r = Math.floor((a.position[2] - lv.origin[1]) / lv.step);
        const hc = lv.head[r]?.[c], head = hc && hc !== "." ? parseInt(hc, 36) * HEAD_STEP : NaN;
        const drop = Number.isFinite(head) ? Math.max(0, +(lv.floorY + head - a.position[1]).toFixed(3)) : 0;
        place = { kind: "ceiling", level: a.level, at: [a.position[0], a.position[2]], yaw: a.yaw, drop };
      }
    }
    items.push({ id, prop: def.prop, place, note: `default ${a.kind} fixture (dress fixtures); change prop/props to override`, ...(props ? { props } : {}) });
    added.push(`${id}: ${def.prop}${props ? ` ${JSON.stringify(props)}` : ""} on ${a.kind} anchor ${a.id}`);
  }
  const plan = { ...existing, items };
  const parsed = dressingPlanSchema.safeParse(plan);
  if (!parsed.success) fail(`the plan would be invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  for (const l of added) console.log(`  + ${l}`);
  for (const l of skipped) console.log(`  = ${l}`);
  console.log(`${flag("dry") ? "DRY RUN: would write" : "wrote"} ${path.relative(PLAYGROUND, file)}: ${added.length} fixture item(s) added, ${skipped.length} anchor(s) left alone${Object.keys(plan.rooms ?? {}).length ? "" : "; plan.rooms is empty: give every room a role before `dress check` passes"}`);
  if (flag("dry") || !added.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(plan, null, 1) + "\n");
}

// ---- owner overrides --------------------------------------------------------

/** Every owner-overrides file of a project: `<plan>.owner.json` beside plans, and authoring/owner-overrides/<scene>.json. */
function ownerFiles(proj: string): { file: string; data: OwnerOverrides }[] {
  const out: { file: string; data: OwnerOverrides }[] = [];
  const walkDir = (dir: string, keep: (f: string) => boolean): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walkDir(f, keep);
      else if (keep(e.name)) {
        const parsed = ownerOverridesSchema.safeParse(JSON.parse(fs.readFileSync(f, "utf8")));
        if (parsed.success) out.push({ file: f, data: parsed.data });
        else console.error(`dress: ${path.relative(PLAYGROUND, f)} is not valid owner overrides: ${parsed.error.issues[0]?.message}`);
      }
    }
  };
  walkDir(path.join(proj, "authoring", "dressing", "plans"), (n) => n.endsWith(".owner.json"));
  walkDir(path.join(proj, "authoring", "owner-overrides"), (n) => n.endsWith(".json"));
  return out;
}

const v3 = (v?: number[]): string => (v ? `[${v.map(f2).join(", ")}]` : "-");
function ownerLine(o: OwnerOverrides["overrides"][number]): string {
  const what = o.added ? `ADDED ${o.set.prop} at ${v3(o.set.pos)}` : o.deleted ? "DELETED (never re-add)" : [
    o.set.prop && o.set.prop !== o.from?.prop ? `swapped ${o.from?.prop ?? "?"} -> ${o.set.prop}` : "",
    o.set.pos ? `at ${v3(o.set.pos)}${o.from?.pos ? ` (was ${v3(o.from.pos)})` : ""}` : "",
    o.set.yaw !== undefined ? `yaw ${f2(o.set.yaw)}°` : "",
    o.set.scale !== undefined && o.set.scale !== 1 ? `scale ${f2(o.set.scale)}` : "",
  ].filter(Boolean).join(", ");
  return `${o.item}${o.from?.prop && !o.added ? ` (${o.from.prop})` : ""}: ${what}  [${o.reasons.join(", ") || "kept"}]${o.note ? ` "${o.note}"` : ""}`;
}

/**
 * dress overrides <project> [--summary] [--json]: what the owner changed by hand, per file and item, then by reason
 * class (floating = moved down, sunk = moved up, moved, rotated, scaled, swapped, deleted, added) and by prop.
 * Reviewers and dresser briefs read it: these are the agents' faults the owner had to fix.
 */
function overridesCmd(): void {
  const name = opt("project") ?? argv.find((a) => !a.startsWith("--"));
  if (!name) fail("usage: dress overrides <project> [--summary] [--json]");
  const proj = path.join(PLAYGROUND, "projects", name!);
  if (!fs.existsSync(proj)) fail(`no project ${proj}`);
  const files = ownerFiles(proj);
  const byReason = new Map<string, Map<string, number>>();
  const byProp = new Map<string, Map<string, number>>();
  let n = 0;
  for (const f of files)
    for (const o of f.data.overrides) {
      n++;
      const prop = o.from?.prop ?? o.set.prop ?? o.item;
      for (const r of o.reasons.length ? o.reasons : ["kept"]) {
        const a = byReason.get(r) ?? new Map<string, number>(); a.set(prop, (a.get(prop) ?? 0) + 1); byReason.set(r, a);
        const b = byProp.get(prop) ?? new Map<string, number>(); b.set(r, (b.get(r) ?? 0) + 1); byProp.set(prop, b);
      }
    }
  if (flag("json")) {
    console.log(JSON.stringify({ project: name, files: files.map((f) => ({ file: path.relative(PLAYGROUND, f.file), ...f.data })), byReason: Object.fromEntries([...byReason].map(([r, m]) => [r, Object.fromEntries(m)])) }, null, 1));
    return;
  }
  if (!flag("summary"))
    for (const f of files) {
      console.log(`${f.data.plan ? `plan ${f.data.plan}` : `scene ${f.data.scene}`}  (${path.relative(PLAYGROUND, f.file)}, ${f.data.frame} frame)`);
      for (const o of f.data.overrides) console.log(`  ${ownerLine(o)}`);
    }
  console.log(`\nBY REASON (${n} owner edit(s) in ${files.length} file(s)):`);
  const order = ["floating", "sunk", "moved", "rotated", "scaled", "swapped", "deleted", "added", "kept"];
  for (const r of order) {
    const m = byReason.get(r);
    if (!m) continue;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${r.padEnd(9)} ${String(total).padStart(3)}  ${[...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, c]) => `${p}${c > 1 ? ` x${c}` : ""}`).join(", ")}`);
  }
  console.log(`BY PROP (most edited first):`);
  for (const [prop, m] of [...byProp].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0)).slice(0, 15))
    console.log(`  ${prop}: ${[...m].map(([r, c]) => `${r}${c > 1 ? ` x${c}` : ""}`).join(", ")}`);
  console.log(`OVERRIDES ${name}: ${n} owner edit(s); floating ${[...(byReason.get("floating")?.values() ?? [])].reduce((a, b) => a + b, 0)}, deleted ${[...(byReason.get("deleted")?.values() ?? [])].reduce((a, b) => a + b, 0)}, swapped ${[...(byReason.get("swapped")?.values() ?? [])].reduce((a, b) => a + b, 0)}`);
}

/**
 * dress owner-apply --project <p> --scene <name|file> [--dry]: bring a scene to the owner's edits of installer-placed
 * props (authoring/owner-overrides/<scene>.json) as ONE ops batch, inverse saved beside it. Installers run it LAST;
 * it is idempotent (nothing to do = no write).
 */
function ownerApply(): void {
  const proj = projectDir();
  const sceneRef = need("scene");
  const sceneFile = fs.existsSync(sceneRef) && sceneRef.endsWith(".json") ? path.resolve(sceneRef) : path.join(proj, "assets", "scenes", `${sceneRef}.scene.json`);
  if (!fs.existsSync(sceneFile)) fail(`no scene ${sceneFile}`);
  const sceneName = path.basename(sceneFile).replace(/\.scene\.json$/, "");
  const file = path.join(proj, "authoring", "owner-overrides", `${sceneName}.json`);
  const { owner } = loadOwner(file);
  if (!owner?.overrides.length) {
    console.log(`owner-apply: no owner overrides for ${sceneName} (${path.relative(PLAYGROUND, file)})`);
    return;
  }
  const scene = readJson(sceneFile) as never;
  const ops = sceneOwnerOps(scene, owner) as Op[];
  if (!ops.length) {
    console.log(`owner-apply: ${sceneName} already matches its ${owner.overrides.length} owner override(s)`);
    return;
  }
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  applyOps(scene, ops, reg); // validates the batch before anything is written
  console.log(`${flag("dry") ? "DRY RUN: would apply" : "applied"} ${ops.length} owner op(s) to ${path.relative(PLAYGROUND, sceneFile)}`);
  if (flag("dry")) return;
  const { inverse } = applyOpsToSceneFile(sceneFile, ops, (d, o) => applyOps(d, o, reg), { label: "dress owner-apply", trailer: "" });
  fs.writeFileSync(file.replace(/\.json$/, ".inverse.json"), JSON.stringify({ scene: path.relative(PLAYGROUND, sceneFile), ops: inverse }, null, 1));
}

/**
 * dress retag --project <p> --scene <name|file> [--plan <file|id>] [--poi <id>] [--dry]: tag dressing installed before
 * apply tagged it — every entity of each plan (tag dress:<plan>) gets poi:<id> (tools/_dress-poi.mts derives it), as ONE
 * set-tags batch; inverse -> authoring/dressing/retag-<scene>.inverse.json (overwritten). Idempotent.
 */
function retag(): void {
  const proj = projectDir();
  const sceneRef = need("scene");
  const sceneFile = fs.existsSync(sceneRef) && sceneRef.endsWith(".json") ? path.resolve(sceneRef) : path.join(proj, "assets", "scenes", `${sceneRef}.scene.json`);
  if (!fs.existsSync(sceneFile)) fail(`no scene ${sceneFile}`);
  const plansDir = path.join(proj, "authoring", "dressing", "plans");
  const files = opt("plan") ? [planFile(proj, opt("plan")!)] : fs.readdirSync(plansDir).filter((f) => /.json$/.test(f) && !/.(inverse|report|owner|walk).json$/.test(f)).map((f) => path.join(plansDir, f));
  const jobs = poiJobIds(proj);
  const scene = readJson(sceneFile) as { entities: Record<string, { tags?: string[]; parent?: string | null }> };
  const ops: Op[] = [];
  let unmatched = 0;
  for (const f of files) {
    let plan: { id?: string; map?: string };
    try { plan = readJson(f) as { id?: string; map?: string }; } catch { continue; }
    if (typeof plan.id !== "string") continue;
    const sm = plan.map ? path.join(proj, "authoring", "dressing", "sockets", `${plan.map}.json`) : null;
    let src: string | null = null;
    try { src = sm && fs.existsSync(sm) ? (readJson(sm) as { source?: { model?: string } }).source?.model ?? null : null; } catch { /* no map */ }
    const poi = dressPoiId({ planId: plan.id, mapSource: src, flag: opt("poi") ?? null, jobIds: jobs });
    if (!poi) { unmatched++; continue; }
    const r = retagOps(scene.entities, plan.id, poi);
    if (r.ops.length) console.log(`  ${plan.id} -> poi:${poi}: ${r.ops.length} entit${r.ops.length === 1 ? "y" : "ies"}`);
    if (r.conflicts.length) console.log(`  ${plan.id}: ${r.conflicts.length} entit${r.conflicts.length === 1 ? "y" : "ies"} already tagged for another poi, left alone (${r.conflicts.slice(0, 3).join(", ")})`);
    ops.push(...(r.ops as Op[]));
  }
  console.log(`retag: ${files.length} plan(s), ${unmatched} with no matching POI job; ${ops.length} entit${ops.length === 1 ? "y" : "ies"} to tag in ${path.relative(PLAYGROUND, sceneFile)}`);
  if (!ops.length || flag("dry")) { if (ops.length) console.log("DRY RUN: nothing written"); return; }
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  const { inverse } = applyOpsToSceneFile(sceneFile, ops, (d, o) => applyOps(d, o, reg), { label: "dress retag", trailer: "" }); // fresh read under the lock
  const inv = path.join(proj, "authoring", "dressing", `retag-${path.basename(sceneFile).replace(/.scene.json$/, "")}.inverse.json`);
  fs.writeFileSync(inv, JSON.stringify({ scene: path.relative(PLAYGROUND, sceneFile), ops: inverse }, null, 1));
  console.log(`inverse -> ${path.relative(PLAYGROUND, inv)}`);
}

// ---- dispatch -------------------------------------------------------------

switch (cmd) {
  case "sockets": {
    const mod = (await import("./dress-sockets.mts")) as { run: (a: string[]) => Promise<void> | void };
    await mod.run(argv);
    break;
  }
  case "manifest":
    manifest();
    break;
  case "check":
    check();
    break;
  case "apply":
    apply();
    break;
  case "fixtures":
    fixtures();
    break;
  case "unclear":
    unclear();
    break;
  case "report":
    report();
    break;
  case "review":
    review();
    break;
  case "walk":
    await walk();
    break;
  case "overrides":
    overridesCmd();
    break;
  case "owner-apply":
    ownerApply();
    break;
  case "retag":
    retag();
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^ \*\/?\s?/, "")).join("\n"));
    process.exit(cmd ? 2 : 0);
}
