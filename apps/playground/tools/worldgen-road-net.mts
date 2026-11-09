/**
 * `worldgen road-net <world> [--png <out.png>] [--window x0,z0,x1,z1] [--json]`: the road NETWORK read as a map reader
 * reads it (Derek 2026-10-31: "a lot of criss-crossing and overlapping"). Prints the graph (pieces, metres, junctions,
 * components) and every fault tools/_road-network.mts finds — crossings that are no crossroads, side-by-side runs,
 * redundant links, stubs, and spurs to nowhere — and with --png draws them over the world's base map
 * (assets/maps/<world>.base.png). Exit 1 on a failing fault (spurs are reported, not failed). The `roads` status row
 * runs the same measure.
 *
 * --fold <id>[,<id>...] [--write]: fold existing roads into the rest of the network, in the order given
 * (tools/_road-network.mts foldRoadDoc): a stretch within 15 m of another road for over 40 m is that road's and is cut
 * out; the kept stretches are the doc SLICED (the solved tread and banks unchanged, so the ground under them does not
 * move) and end on the road they meet. An id is one exact piece (`path-x` is the first piece only; list `path-x.s2` too),
 * or a route base no piece is named after (all its pieces).
 * Without --write: what it would do, and the network after (--png draws the after). With --write: recipe edits,
 * inverse kept (worldgen op <world> --undo <it>). For a road built before the routers folded into the network.
 * The fold is lips-checked (foldRoadsChecked): a fault it adds keeps the tread there, or the fold is refused;
 * --no-lips skips the check on a dry run only. A --write records a ROAD TRIM in the world-order stages file.
 */
import fs from "node:fs";
import { applyRecipeEdits, type RecipeEdit, type RoadDoc, type WorldRecipe } from "@hitreg/core";
import { exceptNetwork, type NetException, measureNetwork, networkFaults, isNetworkRoad, baseRoadId, foldRoadDoc, nearestOn, resample, JOIN_M, PIECE_GAP_M, PARALLEL_M, PARALLEL_RUN_M, type NetPlace, type NetworkReport, type XZ } from "./_road-network.mts";
import path from "node:path";
import { loadStages, saveStages, recordRoadTrim } from "./world-order.mts";

/** The inverse of a fold, beside the recipe's authoring side folder (as `worldgen road` keeps its own). */
function keepInverse(file: string, recipe: WorldRecipe, inverse: RecipeEdit[], explicit?: string): string {
  const out = explicit ?? path.join(path.dirname(file), "..", "..", "authoring", "terrain", "undo", `${recipe.name}.road-net-fold.${new Date().toISOString().replace(/[:.]/g, "-")}.inverse.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ world: recipe.name, what: "road-net-fold", edits: inverse }, null, 1)}
`);
  return out;
}

/** Fold the named roads into the rest of the network (see the header). Pure on the recipe; returns edits + a report. */
export function foldRoads(recipe: WorldRecipe, ids: readonly string[], places: readonly NetPlace[] = [], o: { keep?: readonly XZ[] } = {}): { roads: RoadDoc[]; edits: RecipeEdit[]; log: string[] } {
  // pinned points (foldRoadsChecked: a lip the fold would uncover there): a sample within the road's band + KEEP_PAD_M
  // of one keeps its tread
  // The tread ANOTHER route ends on is never cut (2026-10-31 group C: road-weeping-sun ended on road-moon's doubled
  // stretch; folding road-moon cut it and the end snapper re-routed the Sun's own road): such an end is pinned within
  // its join reach (pieces of the same route still chain through the snapper below).
  const keepFor = (doc: RoadDoc, net: readonly RoadDoc[]) => {
    // the whole ground a road shapes: half width + shoulder + its smooth band (s3: a fault 18 m off the line was its)
    const r = (doc.width ?? 4) / 2 + (doc.shoulder ?? 3) + (doc.smooth ?? 0) + KEEP_PAD_M;
    const ends: XZ[] = [];
    for (const q of net) {
      if (q.id === doc.id || baseRoadId(q.id) === baseRoadId(doc.id) || q.points.length < 2) continue;
      for (const [e, fromEnd] of [[q.points[0]!, false], [q.points[q.points.length - 1]!, true]] as const) {
        if (nearestOn(doc.points, [e[0]!, e[1]!]).d > JOIN_M) continue;
        // an end whose road RETRACES the folded one from there (s3 / road-weeping-sun, 85 m on the same line) is a
        // doubling, not a junction: left to the hairpin rule and the snapper below
        if (retraces(q, doc, fromEnd)) continue;
        ends.push([e[0]!, e[1]!]);
      }
    }
    if (!o.keep?.length && !ends.length) return undefined;
    return (p: XZ) => (o.keep ?? []).some((k) => Math.hypot(k[0] - p[0], k[1] - p[1]) <= r) || ends.some((k) => Math.hypot(k[0] - p[0], k[1] - p[1]) <= JOIN_M + 10);
  };
  const townIds = recipe.features.towns.map((t) => t.id);
  let roads = [...recipe.features.roads];
  // A HAIRPIN (2026-10-31 group C): s3 ran east to [1877,760] and road-weeping-sun came straight back west along it from
  // that same point, 85 m of one line twice, serving no place. Folding one leaves the other's tail as an 85 m dead end;
  // the partner (a route sharing an end with the folded one and retracing it from there) is folded against the
  // folded road's ORIGINAL too, so both tails go back to where they part.
  const hairpinPartners = (doc: RoadDoc): { q: RoadDoc; atEnd: boolean }[] => {
    const out: { q: RoadDoc; atEnd: boolean }[] = [];
    const docEnds = [doc.points[0]!, doc.points[doc.points.length - 1]!];
    for (const q of roads) {
      if (q.id === doc.id || baseRoadId(q.id) === baseRoadId(doc.id) || !isNetworkRoad(q, townIds) || q.points.length < 2) continue;
      for (const [e, atEnd] of [[q.points[0]!, false], [q.points[q.points.length - 1]!, true]] as const)
        // a shared end INSIDE a place is an arrival (road-moon leaves from the Sun's door beside road-weeping-sun), never a
        // hairpin; inside = within the place itself (reach less the 40 m approach margin): the s3 turnaround stood 141 m
        // from sunwine-hold (radius 120, reach 160) and serves nothing
        if (!places.some((p) => Math.hypot(p.x - e[0]!, p.z - e[1]!) <= p.reach - PLACE_MARGIN_M) && docEnds.some((d) => Math.hypot(d[0]! - e[0]!, d[1]! - e[1]!) <= JOIN_M) && retraces(q, doc, atEnd)) { out.push({ q, atEnd }); break; }
    }
    return out;
  };
  const edits: RecipeEdit[] = [];
  const log: string[] = [];
  // Replaced roads keep their PLACE in the array: overlapping roads are drawn in array order, so a piece re-added at the
  // end moves the ground where it overlaps another road (2026-10-31 group C: road-moon untouched, yet the ground under
  // need-weeping-sun-face moved 1 m because road-weeping-sun was re-added after it).
  const replace = (oldIds: ReadonlySet<string>, pieces: readonly RoadDoc[]): void => {
    const first = roads.findIndex((r) => oldIds.has(r.id));
    const ins = roads.slice(0, Math.max(0, first)).filter((r) => !oldIds.has(r.id)).length;
    for (const r of roads) if (oldIds.has(r.id)) edits.push({ edit: "remove-feature", kind: "roads", id: r.id });
    pieces.forEach((p, k) => edits.push({ edit: "add-feature", kind: "roads", feature: p, index: ins + k }));
    const rest = roads.filter((r) => !oldIds.has(r.id));
    roads = [...rest.slice(0, ins), ...pieces, ...rest.slice(ins)];
  };
  for (const id of ids) {
    // an exact piece id folds that piece only; a route id with no piece of its own name folds every piece
    const exact = roads.filter((r) => r.id === id);
    const mine = exact.length ? exact : roads.filter((r) => baseRoadId(r.id) === id);
    if (!mine.length) { log.push(`  ${id}: no such road`); continue; }
    const mineIds = new Set(mine.map((r) => r.id));
    const others = roads.filter((r) => !mineIds.has(r.id) && isNetworkRoad(r, townIds));
    const out: RoadDoc[] = [];
    let changed = false, absorbed = 0;
    for (const doc of mine) {
      const folded = foldRoadDoc(doc, others, { snap: 0, keep: keepFor(doc, roads.filter((q) => isNetworkRoad(q, townIds))) }); // a fold only cuts out the doubled stretches: an end already where it was built (a door) is never pulled onto a neighbour
      changed ||= folded.changed;
      absorbed += folded.absorbed;
      out.push(...folded.pieces);
    }
    if (!changed) { log.push(`  ${id}: nothing beside another road; unchanged`); continue; }
    replace(mineIds, out);
    for (const doc of mine) for (const { q } of hairpinPartners(doc)) {
      const cur = roads.find((r) => r.id === q.id);
      if (!cur) continue;
      const t = foldRoadDoc(cur, [doc], { snap: 0, keep: keepFor(cur, roads.filter((x) => isNetworkRoad(x, townIds) && x.id !== cur.id)) });
      if (!t.changed) continue;
      replace(new Set([cur.id]), t.pieces);
      log.push(`  ${cur.id}: a hairpin with ${doc.id} (one line twice from a shared end); its ${t.absorbed} m tail cut back too`);
    }
    log.push(`  ${id}: ${absorbed} m beside other roads cut out; ${mine.length} piece(s) -> ${out.length}${out.length ? ` (${out.map((r) => `${r.id} ${r.points.length} pts`).join(", ")})` : " (the network carries it all)"}`);
  }
  // a road whose end was joined THROUGH a folded stretch (the next piece of a braid strand, a spur off it) is left
  // dangling short of the network: it is snapped onto the nearest road within PIECE_GAP_M, level with its tread
  const before = recipe.features.roads.filter((r) => isNetworkRoad(r, townIds));
  const endD = (r: RoadDoc, set: readonly RoadDoc[], at: number[]): number =>
    Math.min(Infinity, ...set.filter((o) => o.id !== r.id && o.points.length >= 2).map((o) => nearestOn(o.points, [at[0]!, at[1]!]).d));
  for (const r of [...roads]) {
    if (!isNetworkRoad(r, townIds) || r.points.length < 2) continue;
    const ends = [r.points[0]!, r.points[r.points.length - 1]!];
    const now = roads.filter((o) => isNetworkRoad(o, townIds));
    // an end that reaches a place is where it was built to stop (a dead end AT a place is no fault): never pulled away
    const atPlace = (e: number[]) => places.some((p) => Math.hypot(p.x - e[0]!, p.z - e[1]!) <= p.reach);
    const cut = ends.some((e) => !atPlace(e) && endD(r, before, e) <= JOIN_M && endD(r, now, e) > JOIN_M && endD(r, now, e) <= PIECE_GAP_M);
    if (!cut) continue;
    const snapped = foldRoadDoc(r, now.filter((q) => q.id !== r.id), { snap: PIECE_GAP_M, keep: keepFor(r, now) });
    if (!snapped.changed) continue;
    replace(new Set([r.id]), snapped.pieces);
    log.push(`  ${r.id}: its end was joined through a folded stretch; snapped onto the network`);
  }
  return { roads, edits, log };
}

/** Does road `q`, from its start (or end), run back along `doc`: still within PARALLEL_M of it PARALLEL_RUN_M m on? */
function retraces(q: RoadDoc, doc: RoadDoc, fromEnd: boolean): boolean {
  const line = resample(q.points, 5);
  const L = line[line.length - 1]?.s ?? 0;
  if (L <= PARALLEL_RUN_M) return false;
  const at = fromEnd ? L - PARALLEL_RUN_M : PARALLEL_RUN_M;
  const probe = line.find((p) => p.s >= at) ?? line[line.length - 1]!;
  return nearestOn(doc.points, probe.p).d <= PARALLEL_M;
}

/** The approach margin in a NetPlace's reach (networkPlaces / networkExtraPlaces: radius + 40). */
export const PLACE_MARGIN_M = 40;

/** Metres past a road's band (half width + shoulder + smooth) within which a pinned point keeps the tread. */
export const KEEP_PAD_M = 8;
/** Rounds of re-folding with more of the tread kept before a fold that still adds lips faults is refused. */
export const FOLD_LIPS_ROUNDS = 4;

/**
 * A fold that frees cells must not uncover a lip (2026-10-31 redstrand group C: road-moon's tread had covered the edge of
 * need-weeping-sun-face, and s3's the edge of road-weeping-sun; folding them away left 5 new on-route faults). Folds, then
 * runs `lipsOf` (the lips gate with the world's exceptions) round the roads it changed, before and after: every NEW fault
 * cell pins the tread there and the fold is redone, up to FOLD_LIPS_ROUNDS; a fold that still adds faults is refused
 * (no edits). `lipsOf` is injected so this stays testable without a world field.
 */
export function foldRoadsChecked(recipe: WorldRecipe, ids: readonly string[], places: readonly NetPlace[], lipsOf: (r: WorldRecipe, near: [number, number, number]) => { x: number; z: number; owner: string; kind: string; size: number }[]): { roads: RoadDoc[]; edits: RecipeEdit[]; log: string[]; kept: XZ[]; refused: string[] } {
  const keep: XZ[] = [];
  const rounds: string[] = [];
  const key = (f: { x: number; z: number; kind: string }) => `${f.kind}@${f.x},${f.z}`;
  const baseCache = new Map<string, Set<string>>();
  for (let round = 0; ; round++) {
    const res = foldRoads(recipe, ids, places, { keep });
    if (!res.edits.length) return { ...res, log: [...rounds, ...res.log], kept: keep, refused: [] };
    // the ground the fold changes: every point of a removed or added road
    const changed = new Set(res.edits.map((e) => (e as { id?: string }).id ?? (e as { feature?: RoadDoc }).feature?.id));
    const pts = [...recipe.features.roads, ...res.roads].filter((r) => changed.has(r.id)).flatMap((r) => r.points);
    const xs = pts.map((p) => p[0]!), zs = pts.map((p) => p[1]!);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const near: [number, number, number] = [Math.round(cx), Math.round(cz), Math.ceil(Math.hypot(Math.max(...xs) - cx, Math.max(...zs) - cz) + 40)];
    const nk = near.join(",");
    let before = baseCache.get(nk);
    if (!before) { before = new Set(lipsOf(recipe, near).map(key)); baseCache.set(nk, before); }
    const after = lipsOf(applyRecipeEdits(recipe, res.edits).recipe, near);
    const fresh = after.filter((f) => !before!.has(key(f)));
    rounds.push(`  lips round ${round + 1} near ${nk} [${res.log.map((l) => l.trim().split(":")[0]).join(", ")}] -> ${fresh.length ? fresh.map((f) => `${f.kind} ${f.owner} @${f.x},${f.z} ${f.size.toFixed(2)} m`).join("; ") : "no new faults"}`);
    res.log.unshift(...rounds);
    if (!fresh.length) {
      if (keep.length) res.log.push(`  lips: kept the tread round ${keep.length} point(s) the fold would have uncovered; no new faults`);
      else res.log.push(`  lips: no new faults round [${near.join(",")}]`);
      return { ...res, kept: keep, refused: [] };
    }
    if (round + 1 >= FOLD_LIPS_ROUNDS) {
      const list = fresh.slice(0, 6).map((f) => `${f.kind} ${f.owner} @${f.x},${f.z} ${f.size.toFixed(2)} m`).join("; ");
      return { roads: [...recipe.features.roads], edits: [], log: [...res.log, `  REFUSED: the fold still adds ${fresh.length} lips fault(s) after ${FOLD_LIPS_ROUNDS} rounds (${list}); nothing written`], kept: keep, refused: [...ids] };
    }
    for (const f of fresh) if (!keep.some((k) => k[0] === f.x && k[1] === f.z)) keep.push([f.x, f.z]);
  }
}

/** The places a road end may arrive at: towns (pad + blend), and the given extra places (reservations, POIs). */
export function networkPlaces(recipe: WorldRecipe, extra: readonly NetPlace[]): NetPlace[] {
  return [
    ...recipe.features.towns.map((t) => ({ id: t.id, x: t.center[0], z: t.center[1], reach: t.radius + t.falloff + 20 })),
    ...extra,
  ];
}

/** The world's documented network exceptions, beside its recipe (<project>/authoring/terrain/<world>.road-net-exceptions.json). */
export function netExceptionsFile(recipeFile: string): string {
  const parts = path.resolve(recipeFile).split(/[\\/]/), at = parts.lastIndexOf("assets");
  const side = at > 1 && parts[at - 2] === "projects" && parts[at + 1] === "worlds" ? path.join(...parts.slice(0, at), "authoring", "terrain") : path.dirname(recipeFile);
  return path.join(side, path.basename(recipeFile).replace(/\.json$/i, ".road-net-exceptions.json"));
}
export function readNetExceptions(recipeFile: string): NetException[] {
  const f = netExceptionsFile(recipeFile);
  if (!fs.existsSync(f)) return [];
  const list = (JSON.parse(fs.readFileSync(f, "utf8")).exceptions ?? []) as NetException[];
  for (const e of list) if (!/^\d{4}-\d{2}-\d{2} /.test(e.ruling ?? "")) throw new Error(`${f}: every exception needs a dated ruling ("YYYY-MM-DD who: why"): ${JSON.stringify(e)}`);
  return list;
}

export function measureRecipeNetwork(recipe: WorldRecipe, extra: readonly NetPlace[]): NetworkReport {
  return measureNetwork(recipe.features.roads, networkPlaces(recipe, extra), recipe.features.towns.map((t) => t.id));
}

/** The `roads` status row: null when the network is clean. */
export function roadsStageCheck(recipe: WorldRecipe, extra: readonly NetPlace[], exceptions: readonly NetException[] = []): string | null {
  if (!recipe.features.roads.some((r) => isNetworkRoad(r, recipe.features.towns.map((t) => t.id)))) return null;
  const faults = networkFaults(exceptNetwork(measureRecipeNetwork(recipe, extra), exceptions).rep);
  return faults ? `${faults} — worldgen road-net <world> --png <out> draws them; re-run paths/trails (they fold into the network) or re-route the road` : null;
}

const COLOURS = ["#ff3b30", "#ffcc00", "#34c759", "#00c7be", "#0a84ff", "#bf5af2", "#ff9f0a", "#ff2d55", "#ffffff", "#64d2ff", "#30d158", "#ac8e68"];

export async function drawNetwork(recipe: WorldRecipe, rep: NetworkReport, places: readonly NetPlace[], o: { base: string; extent: number; window: [number, number, number, number]; out: string; scale?: number }): Promise<void> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(o.base).metadata();
  const size = meta.width ?? 2048;
  const mpp = (o.extent * 2) / size;
  const [x0, z0, x1, z1] = o.window;
  const left = Math.max(0, Math.round((x0 + o.extent) / mpp)), top = Math.max(0, Math.round((z0 + o.extent) / mpp));
  const w = Math.min(size - left, Math.round((x1 - x0) / mpp)), h = Math.min(size - top, Math.round((z1 - z0) / mpp));
  const S = o.scale ?? 3, W = w * S, H = h * S;
  const px = (x: number) => (((x - x0) / mpp) * S).toFixed(1), pz = (z: number) => (((z - z0) / mpp) * S).toFixed(1);
  const townIds = recipe.features.towns.map((t) => t.id);
  const net = recipe.features.roads.filter((r) => isNetworkRoad(r, townIds));
  const bases = [...new Set(net.map((r) => baseRoadId(r.id)))];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
  for (const p of places) {
    svg += `<circle cx="${px(p.x)}" cy="${pz(p.z)}" r="${((Math.max(10, p.reach - 40) / mpp) * S).toFixed(1)}" fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="2"/>`;
    svg += `<text x="${(+px(p.x) + 6).toFixed(1)}" y="${(+pz(p.z) - 6).toFixed(1)}" font-family="sans-serif" font-size="13" fill="#fff" stroke="#000" stroke-width="0.5">${p.id}</text>`;
  }
  for (const r of net) {
    const c = COLOURS[bases.indexOf(baseRoadId(r.id)) % COLOURS.length];
    svg += `<polyline points="${r.points.map((p) => `${px(p[0]!)},${pz(p[1]!)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="${r.id.startsWith("road-pb-") ? 2 : 3.5}" stroke-linejoin="round"/>`;
  }
  for (const c of rep.crossings) svg += `<circle cx="${px(c.at[0])}" cy="${pz(c.at[1])}" r="10" fill="none" stroke="#ff00ff" stroke-width="4"/>`;
  for (const c of rep.crossroads) svg += `<circle cx="${px(c.at[0])}" cy="${pz(c.at[1])}" r="6" fill="#fff" stroke="#000"/>`;
  for (const v of rep.overlaps) svg += `<line x1="${px(v.from[0])}" y1="${pz(v.from[1])}" x2="${px(v.to[0])}" y2="${pz(v.to[1])}" stroke="#ff00ff" stroke-width="10" stroke-opacity="0.55"/>`;
  for (const d of rep.deadEnds) svg += `<rect x="${(+px(d.at[0]) - 6).toFixed(1)}" y="${(+pz(d.at[1]) - 6).toFixed(1)}" width="12" height="12" fill="${d.kind === "stub" ? "#ff00ff" : "#ff8800"}"/>`;
  for (const n of rep.nodes) if (n.degree > 2) svg += `<circle cx="${px(n.at[0])}" cy="${pz(n.at[1])}" r="5" fill="#000" stroke="#fff"/>`;
  bases.forEach((b, i) => { svg += `<text x="10" y="${22 + i * 17}" font-family="sans-serif" font-size="14" fill="${COLOURS[i % COLOURS.length]}" stroke="#000" stroke-width="0.5">${b}</text>`; });
  svg += `<text x="10" y="${H - 12}" font-family="sans-serif" font-size="14" fill="#fff" stroke="#000" stroke-width="0.5">${rep.crossings.length} bad crossings (magenta ring) · ${rep.crossroads.length} crossroads (white dot) · ${rep.overlaps.length} side-by-side (magenta bar) · ${rep.redundant.length} redundant · dead ends: magenta stub / orange spur · black dot junction · window ${o.window.join(",")}</text></svg>`;
  const base = await sharp(o.base).extract({ left, top, width: w, height: h }).resize(W, H, { kernel: "nearest" }).toBuffer();
  await sharp(base).composite([{ input: Buffer.from(svg) }]).png().toFile(o.out);
}

export async function commandRoadNet(host: { argv: string[]; recipe: WorldRecipe; file: string; writeRecipe(recipe: WorldRecipe, file: string): void; extra: NetPlace[]; base: string; extent: number; lipsOf?: (r: WorldRecipe, near: [number, number, number]) => { x: number; z: number; owner: string; kind: string; size: number }[] }): Promise<void> {
  const { argv } = host;
  let recipe = host.recipe;
  const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const fold = opt("fold");
  if (fold) {
    const ids = fold.split(",").map((x) => x.trim()).filter(Boolean);
    // --no-lips: fold without the lips check (a what-if only; a --write keeps the check)
    if (argv.includes("--write") && !host.lipsOf) throw new Error("road-net --fold --write needs the lips check (host.lipsOf)");
    const res = (argv.includes("--no-lips") && !argv.includes("--write")) || !host.lipsOf
      ? foldRoads(recipe, ids, networkPlaces(recipe, host.extra))
      : foldRoadsChecked(recipe, ids, networkPlaces(recipe, host.extra), host.lipsOf);
    for (const l of res.log) console.log(l);
    if (res.edits.length) {
      const applied = applyRecipeEdits(recipe, res.edits);
      if (argv.includes("--write")) {
        const inv = keepInverse(host.file, recipe, applied.inverse, opt("inverse"));
        host.writeRecipe(applied.recipe, host.file);
        console.log(`  wrote ${res.edits.length} edit(s); inverse: ${inv}  (worldgen op ${recipe.name} --undo <it>)`);
        // a fold only cuts doubled road cells (the kept tread is not regraded): record it as a ROAD TRIM so the places
        // under it re-check sited / installed by the gates instead of staling their concept and design stages
        const projectDir = path.resolve(path.dirname(host.file), "..", "..");
        const doc = loadStages(projectDir, recipe.name);
        if (doc) {
          const touched = [...fold.split(","), ...res.edits.flatMap((e) => { const x = e as { id?: string; feature?: { id?: string } }; return [x.id ?? "", x.feature?.id ?? ""]; })].map((x) => x.trim()).filter(Boolean);
          const parts = recordRoadTrim(doc, applied.recipe as never, touched, `road-net --fold ${fold}`, "worldgen road-net");
          saveStages(projectDir, doc);
          console.log(`  road trim recorded for ${Object.keys(parts).length} ground part(s): places under it re-check sited / installed only (zonegen stages --recheck <place>)`);
        }
      } else console.log(`  [dry-run] ${res.edits.length} edit(s); not written (--write). The network AFTER:`);
      recipe = applied.recipe;
    }
  }
  const places = networkPlaces(recipe, host.extra);
  const { rep, excepted } = exceptNetwork(measureNetwork(recipe.features.roads, places, recipe.features.towns.map((t) => t.id)), readNetExceptions(host.file));
  if (argv.includes("--json")) console.log(JSON.stringify({ ...rep, nodes: undefined, edges: undefined }, null, 1));
  console.log(`${recipe.name}: ${rep.roads} network road piece(s), ${rep.metres} m, ${rep.nodes.filter((n) => n.degree > 2).length} junction(s), ${rep.components} connected piece(s)`);
  for (const c of rep.crossings) console.log(`  FAIL crossing ${c.a} x ${c.b} at [${c.at.join(",")}]: ${c.angle} deg${c.dy !== null ? `, treads ${c.dy} m apart` : ""}`);
  for (const v of rep.overlaps) console.log(`  FAIL side by side ${v.a} | ${v.b}: ${v.length} m from [${v.from.join(",")}] to [${v.to.join(",")}]`);
  for (const r of rep.redundant) console.log(`  FAIL redundant ${r.road}: ${r.length} m between [${r.ends[0].join(",")}] and [${r.ends[1].join(",")}], the network's way ${r.alternative} m`);
  for (const d of rep.deadEnds) console.log(`  ${d.kind === "stub" ? "FAIL stub" : "note spur"} ${d.road} ends at [${d.at.join(",")}] reaching no place (${d.length} m)`);
  console.log(`  ${rep.crossroads.length} crossroads (>= 35 deg, level treads)`);
  for (const e of excepted) console.log(`  excepted ${e}`);
  const faults = networkFaults(rep);
  console.log(faults ? `FAIL: ${faults}` : "OK: no crossings without a junction, no side-by-side runs, no redundant links, no stubs");
  const png = opt("png");
  if (png) {
    const win = (opt("window") ?? "").split(",").map(Number);
    let window: [number, number, number, number];
    if (win.length === 4 && win.every(Number.isFinite)) window = win as [number, number, number, number];
    else {
      const xs = recipe.features.roads.flatMap((r) => r.points.map((p) => p[0]!)).concat(places.map((p) => p.x));
      const zs = recipe.features.roads.flatMap((r) => r.points.map((p) => p[1]!)).concat(places.map((p) => p.z));
      window = [Math.min(...xs) - 200, Math.min(...zs) - 200, Math.max(...xs) + 200, Math.max(...zs) + 200];
    }
    if (!fs.existsSync(host.base)) throw new Error(`no base map ${host.base}: worldgen map <world> --base`);
    await drawNetwork(recipe, rep, places, { base: host.base, extent: host.extent, window, out: png });
    console.log(`  wrote ${png}`);
  }
  if (faults) process.exitCode = 1;
}
