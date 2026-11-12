/**
 * art-check — the ART gate of a POI job (tools/poi-review/job.mjs gate 15; rules in tools/_art-check.mts). Measures what
 * the job delivers against what stands around it and fails on numbers, not taste:
 *
 *   texel   effective texels/m of every landmark material (UV, triplanar and terrain-splat counted: props measure's
 *           projected texels), every terrain paint and the catalogued props in reach, against the terrain sampled
 *           around each piece (its steep stone for natural rock) and the town standard for built surfaces
 *   ground  the job's OWN terrain (its height patches' raised tops above the sea, its passages' walls and ceilings) as the
 *           terrain draws it (splat at the sample's position + normal, its paint operators included) against the built work
 *           beside it, both AS SEEN (texels/m / the texture's detailScale): a 512 px cliff tile with 4 px marks reads ~7 tx/m
 *   value   mean L* (texture x tint + emissive lift) against the zone ground's L* band (flat terrain samples)
 *   variety coherent materials on emitted architectural parts, with distinct supports/trim/arches/paving beside wall
 *           faces. Legacy texture counts/area/repeats are reported as diagnostics by default; colours still gate.
 *   portal  every landmark opening (depth >= threshold) and the zone brief's dungeon door: a portal (veil + travel
 *           target, in the job's scene ops or the world scene) or handoff.json `doors: [{ name, sealed: true }]`
 *   form    landmark-spec lint: identical hero parts, butted raw-box chains, unbevelled-box share, course scale vs culture
 *           (and the same box rules over the owned scene meshes' world bounds)
 *   measure the POI's OWNED scene entities are pieces too (job scene ops + world entities tagged poi:<id>, with their
 *           descendants): added meshes (surface / asset / primitive) and prefabs >= measure.structureSize are built
 *           `mesh` pieces, smaller prefabs `prop` pieces; a job with no measured surface at all FAILS ("nothing measured")
 *
 *   node node_modules/tsx/dist/cli.mjs tools/art-check.mts <jobDir> [--out <file>] [--thresholds <json>] [--culture giant|human] [--quiet]
 *
 * Writes `<jobDir>/reports/art-check.json` (or --out): { ok, counts, faults[], pieces[], thresholds }. Exit 1 on faults.
 * Exceptions: a dated coordinator ruling in `<jobDir>/quality-exceptions.json` (gates ["art"], match { rule, what? }, pieces,
 * why, ruling "YYYY-MM-DD <who>") moves the matching faults to `excepted` (job.mjs jobExceptions / exceptFaults).
 * Thresholds: tools/_art-check.mts artThresholdsSchema defaults, overridden by <project>/authoring/art-check.json or --thresholds.
 */
import fs from "node:fs";
import { artGroundReference, uvFootprintDetailScale } from "./_art-check.mts";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRecipeEdits, compileLandmarkSpec, compileLandmarkOperator, landmarkOperatorSchema, operatorParams, wallLandmarkParams, createWorldField, isNaturalRole, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { operatorReader } from "./worldgen-operators.mts";
import { architecturalBindings, varietyDiagnostics } from "./_art-check.mts";
import { boxTris, gltfTris, locate, materialTex, preferJobAssets, prefabGeometry, projectedTexels, readJson, texelDensity, trs, type M4, type PropGeometry, type Tri } from "./_prop-geometry.mts";
import { artDoorSchema, artFaults, NOT_PROPS_RE, passageGroundSamples, detailScale, nearPropInstances, artTarget, builtOpPieces, isPortalVeil, mergeJobEntities, unburiedTris, uvRepeatsByMaterial, uvFootprintMean, uvStretchByMaterial, unmeasuredAreas, artThresholdsSchema, materialLstar, ownedEntityIds, textureStats, visibleTris, type ArtInput, type ArtMaterial, type ArtOpening, type ArtPiece, type ArtPortal, type CultureScale, type FormNode, type FormUnit, type TextureStats, specUnits } from "./_art-check.mts";
// @ts-expect-error plain JS module
import { decodePng } from "./_png.mjs";
// @ts-expect-error plain JS module
import { deliveredOps, exceptFaults, jobExceptions, jobParent, jobTier } from "../../../tools/poi-review/job.mjs";
import { placeRuleFor } from "./_place-solve.mts";
import { contrastFindings, groundBandFree } from "./_art-check.mts";
/** The catalogue dressing block of a prefab (its `shelter` flag for `groundBandFree`), null when unreadable. */
const prefabDressing = (pid?: string): { shelter?: boolean } | null => { if (!pid) return null; try { const j = readJson(locate(ASSETS, "prefabs", `${pid}.json`)); return (Object.values(j?.entities ?? {}) as any[]).map((e) => e?.components?.dressing).find(Boolean) ?? null; } catch { return null; } };

type V3 = [number, number, number];
type Op = Record<string, any>;
const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const jobArg = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && !["--quiet"].includes(argv[i - 1]!)));
if (!jobArg) { console.error("usage: art-check <jobDir> [--project <lab> --world <labWorld>] [--out <file>] [--thresholds <json>] [--culture giant|human] [--quiet]"); process.exit(2); }
const jobDir = path.resolve(jobArg);
const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parts = jobDir.split(/[\\/]/);
// measured in the job's own project world, or the preview lab it was built in (--project/--world: _art-check artTarget)
const { project, world } = artTarget(jobDir, { project: flag("project"), world: flag("world") });
const zone = parts[parts.indexOf("zones") + 1];
// a job COPY (place-build --job) names its real project with --home / --home-world
const home = (() => { try { return artTarget(jobDir); } catch (e) { if (!flag("home")) throw e; return { project: flag("home")!, world: flag("home-world") ?? world }; } })(), HOME = path.join(PG, "projects", home.project); // the job's own project: thresholds, zone brief
const PROJ = path.join(PG, "projects", project), ASSETS = path.join(PROJ, "assets");
// the job's own materials/textures first, then the project closure (a job's materials reach the project at install)
preferJobAssets(ASSETS, jobDir);
const recipe: WorldRecipe = worldRecipeSchema.parse(readJson(path.join(ASSETS, "worlds", `${world}.json`)));
const projFile = path.join(HOME, "authoring", "art-check.json");
const T = artThresholdsSchema.parse({ ...(fs.existsSync(projFile) ? readJson(projFile) : {}), ...(flag("thresholds") ? JSON.parse(flag("thresholds")!) : {}) });
const tryJson = (f: string) => { try { return fs.existsSync(f) ? readJson(f) : null; } catch { return null; } };
const hand = tryJson(path.join(jobDir, "handoff.json")) ?? {};

// ---- delivered ops
const worldOps: Op[] = [], sceneOps: Op[] = [];
for (const f of deliveredOps(jobDir) as string[]) {
  const j = tryJson(path.join(jobDir, f));
  const ops: Op[] = Array.isArray(j) ? j : Array.isArray(j?.ops) ? j.ops : j?.op ? [j] : [];
  for (const o of ops) (o?.op === "add-entity" ? sceneOps : worldOps).push(o);
}

// ---- textures and materials
const texCache = new Map<string, TextureStats | null>();
const texStats = (map: unknown): TextureStats | null => {
  if (typeof map !== "string") return null;
  const f = locate(ASSETS, "textures", map);
  if (!texCache.has(f)) { try { texCache.set(f, /\.png$/i.test(f) && fs.existsSync(f) ? textureStats(decodePng(fs.readFileSync(f))) : null); } catch { texCache.set(f, null); } }
  return texCache.get(f)!;
};
// the PICTURE behind a material (art-check variety counts area per picture, not per material id)
const hashCache = new Map<string, string | null>();
const texHash = (map: unknown): string | null => {
  if (typeof map !== "string") return null;
  const f = locate(ASSETS, "textures", map);
  if (!hashCache.has(f)) hashCache.set(f, fs.existsSync(f) ? createHash("sha1").update(fs.readFileSync(f)).digest("hex").slice(0, 16) : null);
  return hashCache.get(f)!;
};
const matJson = (id: string) => tryJson(locate(ASSETS, "materials", `${id}.json`));
// how many pixels one visible mark spans (_art-check detailScale): texels/m AS SEEN = texels/m / this
const detailCache = new Map<string, number | null>();
const detailOf = (map: unknown): number | null => {
  if (typeof map !== "string") return null;
  const f = locate(ASSETS, "textures", map);
  if (!detailCache.has(f)) { try { detailCache.set(f, /\.png$/i.test(f) && fs.existsSync(f) ? detailScale(decodePng(fs.readFileSync(f))) : null); } catch { detailCache.set(f, null); } }
  return detailCache.get(f)!;
};
// decoded pictures for the UV footprint (value of a UV-laid atlas = the texels its triangles sample, _art-check uvFootprintMean)
const imgCache = new Map<string, { width: number; height: number; data: Uint8Array } | null>();
const texImage = (map: unknown) => {
  if (typeof map !== "string") return null;
  const f = locate(ASSETS, "textures", map);
  if (!imgCache.has(f)) { try { imgCache.set(f, /.png$/i.test(f) && fs.existsSync(f) ? decodePng(fs.readFileSync(f)) : null); } catch { imgCache.set(f, null); } }
  return imgCache.get(f)!;
};
/** A glTF-EMBEDDED image (`<model>#image<n>`, no material asset: a Codex prop's painted atlas) measured from its own
 *  bytes: value = the mean of the texels its triangles sample. L (w-temple10 2026-11-03: the sunken temple's three
 *  atlases were mean L* ~22 and read as black blocks at noon, but their L* was null, so the value rule never judged them). */
const embeddedCache = new Map<string, { width: number; height: number; data: Uint8Array } | null>();
function embeddedMaterial(id: string, area: number, texels: number, projected: boolean, natural: boolean, tris: Tri[]): ArtMaterial | null {
  const mine = tris.filter((t) => t.tex?.key === id), bytes = mine.find((t) => t.tex?.bytes)?.tex?.bytes;
  if (!bytes || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  if (!embeddedCache.has(id)) { try { embeddedCache.set(id, decodePng(bytes)); } catch { embeddedCache.set(id, null); } }
  const img = embeddedCache.get(id); if (!img) return null;
  const tex = textureStats(img), m = uvFootprintMean(mine, img, mine[0]?.tex?.flipY ?? false);
  const lstar = materialLstar({ color: "#ffffff" }, m ? { ...tex, mean: m } : tex, null);
  return { id, area, texels, projected, natural, lstar, colours: tex.colours ?? null, lumaSd: tex.lumaSd ?? null, px: [img.width, img.height], map: null, mapHash: createHash("sha1").update(bytes).digest("hex").slice(0, 16), course: null, periodicity: tex.periodicity, seen: null };
}
function describeMaterial(id: string, area: number, texels: number, projected: boolean, natural: boolean, tris?: Tri[]): ArtMaterial {
  const known = matJson(id), md = known ?? {};
  if (!known && tris?.length) { const e = embeddedMaterial(id, area, texels, projected, natural, tris); if (e) return e; }
  const tex = md.shader === "terrain-splat" || md.shader === "rock-cap" ? null : texStats(md.map);
  // a UV-laid material is judged by the texels its own triangles sample, not its whole page (an atlas)
  const own = tex && !projected && !md.triplanar && tris?.length ? (() => { const img = texImage(md.map); const m = img ? uvFootprintMean(tris.filter((t) => (t.material ?? t.tex?.key) === id), img) : null; return m ? { ...tex, mean: m } : null; })() : null;
  const lstar = !known || md.shader === "terrain-splat" || md.shader === "rock-cap" ? null : materialLstar(md, own ?? tex, md.emissiveMap ? texStats(md.emissiveMap) : null);
  const course = tex && tex.periodPx && tex.periodicity >= T.scale.minPeriodicity && texels > 0 ? tex.periodPx / texels : null;
  const uvTris = !projected && !md.triplanar ? tris?.filter(t => (t.material ?? t.tex?.key) === id) : null;
  const uvImage = uvTris?.length ? texImage(md.map) : null;
  const ds = tex ? (uvTris && uvImage ? uvFootprintDetailScale(uvTris, uvImage) : null) ?? detailOf(md.map) : null;
  return { id, area, texels, projected, natural, lstar, colours: tex?.colours ?? null, lumaSd: tex?.lumaSd ?? null, px: tex ? [tex.width, tex.height] : null, map: typeof md.map === "string" ? md.map : null, mapHash: tex ? texHash(md.map) : null, course, periodicity: tex?.periodicity, seen: ds && Number.isFinite(texels) ? texels / ds : null };
}

/** The materials texelDensity could not measure (flat colours, or a mapped material on triangles with no UVs and no
 *  world projection: flagged `noUv`, a texel fault, for BAKED meshes only: scene primitives get their UVs from the
 *  renderer's geometry, which the measure does not model for non-box shapes), described for value like the rest.
 *  An animated `overlay` material (fire/ember beds) is VFX, not a surface: its look is the overlay, never `noUv`. */
function unmeasured(tris: Tri[], measured: Record<string, unknown>, k = 1, baked = false): ArtMaterial[] {
  return [...unmeasuredAreas(tris, measured)].filter(([id]) => id !== "(none)").map(([id, a]) => {
    const md = matJson(id) ?? {}, splat = md.shader === "terrain-splat" || md.shader === "rock-cap";
    const d = describeMaterial(id, a * k, NaN, false, splat || id.startsWith("landmarks/"));
    if (baked && typeof md.map === "string" && !md.triplanar && !md.overlay && !splat && tris.some((t) => t.material === id && (!t.uv || t.uv.length < 3))) d.noUv = true;
    return d;
  });
}

// ---- terrain around a point
const field = createWorldField(recipe);
// what the terrain DRAWS per surface: the world's terrain-splat material layer (tint, map, uvScale), else the recipe surface
// (the per-vertex biome tint is left out on both sides: surfaces and landmark materials are compared untinted)
const splatLayers = ((m) => (m?.shader === "terrain-splat" && m.splat?.layers?.length === recipe.surfaces.length ? m.splat.layers as { color?: string; map?: string; uvScale?: number }[] : null))(recipe.material ? matJson(recipe.material) : null);
// Exclude the job's paint FEATURES from the reference, retaining natural uses of
// the same palette surface elsewhere. Dropping its entire surface biased the band.
const referenceRecipe = artGroundReference(recipe, worldOps);
const referenceField = referenceRecipe === recipe ? field : createWorldField(referenceRecipe);
const surf = recipe.surfaces.map((s, i) => {
  const l = splatLayers?.[i], map = l?.map ?? s.map, uv = l?.uvScale ?? s.uvScale;
  const st = map ? texStats(map) : null;
  return { name: s.name, texels: st ? st.width / uv : NaN, lstar: materialLstar({ color: l?.color ?? (map ? "#ffffff" : s.color) }, st, null), stats: st, uvScale: uv, map };
});
function terrainAround(cx: number, cz: number, r: number): { texels: number; steep: number | null; lstar: number | null; steepSd: number | null } {
  const n = 9, step = (2 * r) / (n - 1);
  let tw = 0, tv = 0, sw = 0, sv = 0, lw = 0, lv = 0, dw = 0, dv = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = cx - r + i * step, z = cz - r + j * step;
    const b = referenceField.biome(x, z), slope = referenceField.slope(x, z);
    b.surface.forEach((w, k) => {
      const s = surf[k]!; if (!(w > 0) || !Number.isFinite(s.texels)) return;
      tw += w; tv += w * s.texels;
      if (slope >= 0.5) { sw += w; sv += w * s.texels; if (s.stats?.lumaSd != null) { dw += w; dv += w * s.stats.lumaSd; } }
      else if (slope < 0.35) { lw += w; lv += w * s.lstar; }
    });
  }
  return { texels: tw ? tv / tw : NaN, steep: sw > 0.5 ? sv / sw : null, lstar: lw ? lv / lw : null, steepSd: dw > 0.5 ? dv / dw : null };
}

// ---- world positions of scene entities (job scene ops + the world scene)
const qrot = (q: number[], v: V3): V3 => {
  const [x, y, z, w] = q as [number, number, number, number];
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const qmul = (a: number[], b: number[]) => [a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!, a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!, a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!, a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!];
function worldOf(ents: Record<string, any>) {
  const memo = new Map<string, { p: V3; q: number[]; s: V3 }>();
  const of = (id: string, depth = 0): { p: V3; q: number[]; s: V3 } => {
    const hit = memo.get(id); if (hit) return hit;
    const e = ents[id], t = e?.components?.transform ?? {};
    const lp = (t.position ?? [0, 0, 0]) as V3, lq = t.rotation ?? [0, 0, 0, 1], ls = (t.scale ?? [1, 1, 1]) as V3;
    let out = { p: lp, q: lq, s: ls };
    if (e?.parent && ents[e.parent] && depth < 32) {
      const pa = of(e.parent, depth + 1), sp = qrot(pa.q, [lp[0] * pa.s[0], lp[1] * pa.s[1], lp[2] * pa.s[2]]);
      out = { p: [pa.p[0] + sp[0], pa.p[1] + sp[1], pa.p[2] + sp[2]], q: qmul(pa.q, lq), s: [pa.s[0] * ls[0], pa.s[1] * ls[1], pa.s[2] * ls[2]] };
    }
    memo.set(id, out); return out;
  };
  return of;
}
const sceneFile = path.join(ASSETS, "scenes", `${world}.scene.json`);
const sceneEnts: Record<string, any> = (tryJson(sceneFile)?.entities ?? {}) as Record<string, any>;
// an INSTALLED job (its ops' root entities stand in the scene) is measured as installed: an op entity the scene no longer
// holds was removed by a later revision (the Kings' Path took out the Kings' Stair) and is not a piece any more
const opRoots = sceneOps.filter((o) => (o.entity ?? o).parent == null).map((o) => o.id);
const installed = opRoots.length > 0 && opRoots.some((id) => sceneEnts[id]);
const jobEnts: Record<string, any> = Object.fromEntries(sceneOps.filter((o) => !installed || sceneEnts[o.id]).map((o) => [o.id, o.entity ?? o]));
/** Material ids of built tiles: a triplanar owned mesh in one of these is built work (town texel standard), not rock. */
const BUILT_MATERIAL = /ashlar|masonry|brick|timber|plank|wood|beam/i;
const allEnts = mergeJobEntities(sceneEnts, jobEnts, installed);
const posOf = worldOf(allEnts);

// ---- pieces
const pieces: ArtPiece[] = [], openings: ArtOpening[] = [], forms: Record<string, FormNode[]> = {}, units: Record<string, FormUnit[]> = {};
const terrain: ArtInput["terrain"] = {}, props: ArtInput["props"] = {}, built: NonNullable<ArtInput["built"]> = {};
const recipeLandmarks = (recipe.features as { landmarks?: { id: string; prefab: string; position: number[]; radius: number }[] }).landmarks ?? [];
const proj = projectedTexels(ASSETS);
const notes: string[] = [];
const euler = (rx: number, ry: number, rz: number) => { const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz); return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx]; };
function formNodes(spec: unknown, scale: number): FormNode[] {
  const c = compileLandmarkSpec(spec, { voxel: 0.5, scale, skipThin: true });
  return c.nodes.map((nd, i) => {
    const n = nd as unknown as Record<string, any>;
    let local: V3[] = [], dims: V3 = [0, 0, 0], area = 0;
    const boxPts = (e: V3): V3[] => [-1, 1].flatMap((a) => [-1, 1].flatMap((b) => [-1, 1].map((cc) => [a * e[0], b * e[1], cc * e[2]] as V3)));
    if (n.shape === "box" || n.shape === "ellipsoid") { dims = n.size as V3; local = boxPts([dims[0] / 2, dims[1] / 2, dims[2] / 2]); area = n.shape === "box" ? 2 * (dims[0] * dims[1] + dims[0] * dims[2] + dims[1] * dims[2]) : Math.PI * (dims[0] * dims[1] + dims[0] * dims[2] + dims[1] * dims[2]) / 1.5; }
    else if (n.shape === "cylinder" || n.shape === "cone" || n.shape === "capsule") { const r = n.radius, h = n.height; dims = [2 * r, h, 2 * r]; local = boxPts([r, h / 2, r]); area = 2 * Math.PI * r * h + 2 * Math.PI * r * r; }
    else if (n.shape === "sphere") { const r = n.radius; dims = [2 * r, 2 * r, 2 * r]; local = boxPts([r, r, r]); area = 4 * Math.PI * r * r; }
    else if (n.shape === "torus") { const R = n.radius, r = n.height; dims = [2 * (R + r), 2 * r, 2 * (R + r)]; local = boxPts([R + r, r, R + r]); area = 4 * Math.PI * Math.PI * R * r; }
    else if (n.shape === "prism") {
      const P = n.polygon as [number, number][], h = n.height as number;
      const xs = P.map((p) => p[0]), zs = P.map((p) => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      dims = [x1 - x0, h, z1 - z0];
      local = boxPts([dims[0] / 2, h / 2, dims[2] / 2]).map((p) => [p[0] + (x0 + x1) / 2, p[1], p[2] + (z0 + z1) / 2] as V3);
      let a2 = 0, per = 0;
      for (let k = 0; k < P.length; k++) { const p = P[k]!, q = P[(k + 1) % P.length]!; a2 += p[0] * q[1] - q[0] * p[1]; per += Math.hypot(q[0] - p[0], q[1] - p[1]); }
      area = per * h + Math.abs(a2);
    }
    else if (n.shape === "mesh") {
      const m = n.mesh as { positions: number[]; indices: number[] };
      const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < m.positions.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, m.positions[k + a]!); hi[a] = Math.max(hi[a]!, m.positions[k + a]!); }
      dims = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      local = boxPts([dims[0] / 2, dims[1] / 2, dims[2] / 2]).map((p) => [p[0] + (lo[0] + hi[0]) / 2, p[1] + (lo[1] + hi[1]) / 2, p[2] + (lo[2] + hi[2]) / 2] as V3);
      for (let t = 0; t < m.indices.length; t += 3) {
        const P = [0, 1, 2].map((e) => m.positions.slice(m.indices[t + e]! * 3, m.indices[t + e]! * 3 + 3));
        const u = P[1]!.map((x, k) => x - P[0]![k]!), w = P[2]!.map((x, k) => x - P[0]![k]!);
        area += Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2;
      }
    }
    const rot = n.rotation ?? [0, 0, 0], R = euler(rot[0], rot[1], rot[2]), t = (n.position ?? [0, 0, 0]) as V3;
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const v of local) { const w: V3 = [R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2] + t[0], R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2] + t[1], R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2] + t[2]]; for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a]!, w[a]!); max[a] = Math.max(max[a]!, w[a]!); } }
    const role = c.roles[i]!;
    return { name: c.names[i]!, role, natural: isNaturalRole(role), op: String(n.op ?? "add"), shape: String(n.shape), dims, min, max, bevel: c.meta[i]?.bevel ?? 0, area };
  });
}
const densCache = new Map<string, { median: number; area: number } | null>();
function propTexels(prefabId: string) {
  if (!densCache.has(prefabId)) { try { const d = texelDensity(prefabGeometry(ASSETS, prefabId), { projected: proj }); densCache.set(prefabId, Number.isFinite(d.median) ? { median: d.median, area: d.texturedArea } : null); } catch { densCache.set(prefabId, null); } }
  return densCache.get(prefabId)!;
}
// creatures (mobs/*, populated spawns) and characters are not "the props around it" (_art-check NOT_PROPS_RE)
const propInstances = Object.entries(allEnts).filter(([, e]) => typeof e?.components?.prefab?.prefabId === "string" && !NOT_PROPS_RE.test(String(e.components.prefab.prefabId)));

// landmark ops and every operator that bakes to a landmark (wall: retaining, ramp…) are built pieces (_art-check builtOpPieces)
const builtPieces = new Map(builtOpPieces(worldOps, recipeLandmarks).map((b) => [b.op, b]));
const tier = jobTier(jobDir) as { id: string; tier: ArtInput["tier"] };
const owned = ownedEntityIds(allEnts, tier.id, Object.keys(jobEnts));
for (const o of worldOps) {
  const built = builtPieces.get(o);
  if (built) {
    const at = built.at, yaw = ((o.yaw ?? 0) * Math.PI) / 180, scale = typeof o.scale === "number" ? o.scale : 1;
    const piece = built.piece;
    const radius = piece?.radius ?? 40;
    const mats: ArtMaterial[] = [];
    if (!piece) notes.push(`landmark ${o.id}: not in the recipe (worldgen op --apply), bake not measured`);
    else {
      try {
        // only what stands above the ground is seen: faces buried in the bank are not laid-down tile (_art-check visibleTris)
        const geo = prefabGeometry(ASSETS, piece.prefab);
        geo.tris = visibleTris(geo.tris, piece.position, (x, z) => field.height(x, z));
        // ... and a built bake's faces buried inside its own solids (treads in treads, a face body under its coping) neither
        if (o.op === "wall" || o.kind === "built") geo.tris = unburiedTris(geo.tris, prefabGeometry(ASSETS, piece.prefab).tris);
        const d = texelDensity(geo, { projected: proj }), stretch = uvStretchByMaterial(geo.tris, T.texel.stretch, (id) => { const md = matJson(id); const img = md?.map ? texImage(md.map) : null; return img ? [img.width, img.height] : undefined; });
        for (const [id, m] of Object.entries(d.byMaterial ?? {})) {
          const md = matJson(id) ?? {};
          const natural = m.projected || id.startsWith("landmarks/") || md.shader === "terrain-splat" || md.shader === "rock-cap";
          const am = describeMaterial(id, m.area, m.median, m.projected, natural, geo.tris);
          if (!m.projected && stretch[id]) am.stretch = stretch[id]; // every face, tops and caps included
          mats.push(am);
        }
        // EVERY part of the bake, not only the ones texelDensity could read: a stamp's lip/trim role on a non-triplanar
        // material has no UVs (it renders one texel) and used to drop out of the report unmeasured (REV-WS2)
        mats.push(...unmeasured(geo.tris, d.byMaterial ?? {}, 1, true));
      } catch (e) { notes.push(`landmark ${o.id}: ${(e as Error).message}`); }
    }
    let architecture: ArtPiece["architecture"];
    let architectureBakeMatchesSource: boolean | undefined;
    if (o.op === "wall" || o.kind === "built") {
      try {
        const reader = operatorReader(recipe, o.id);
        const src = o.source?.file && !o.source.csg ? { ...o.source, csg: tryJson(path.join(PROJ, o.source.file)) ?? tryJson(path.join(PG, o.source.file)) } : o.source;
        const params = o.op === "wall" ? wallLandmarkParams(operatorParams(o), reader, { id: o.id }) : landmarkOperatorSchema.parse(operatorParams({ ...o, source: src }));
        const compiled = compileLandmarkOperator(params, reader, { id: o.id });
        if (compiled) {
          architecture = architecturalBindings(params.materials, compiled.compiled.roles.filter((_, i) => compiled.compiled.nodes[i]!.op !== "sub"));
          architectureBakeMatchesSource = piece?.prefab === `landmarks/${o.id}-${compiled.compiled.digest}`;
        }
        else notes.push(`landmark ${o.id}: architectural source roles unavailable; review the editable source visually`);
      } catch (e) { notes.push(`landmark ${o.id}: architectural roles could not be measured: ${(e as Error).message}`); }
    }
    pieces.push({ id: o.id, kind: "landmark", at, materials: mats, architecture, architectureBakeMatchesSource });
    terrain[o.id] = terrainAround(at[0], at[1], radius + T.texel.radius);
    // a wall operator's openings are gates at a STATION along its line (a number), not landmark doorways [x, y, z]: not portals
    for (const op of o.openings ?? []) { if (!Array.isArray(op.at)) continue; const [x, , z] = op.at as V3; openings.push({ landmark: o.id, name: op.name, at: [at[0] + (x * Math.cos(yaw) + z * Math.sin(yaw)) * scale, at[1] + (-x * Math.sin(yaw) + z * Math.cos(yaw)) * scale], width: op.width * scale, depth: (op.depth ?? 3) * scale }); }
    // a spec file names its path from the project or from apps/playground (both are in use)
    const spec = o.spec ?? (o.source?.file ? tryJson(path.join(PROJ, o.source.file)) ?? tryJson(path.join(PG, o.source.file)) : null);
    if (!spec && o.op === "landmark") notes.push(`landmark ${o.id}: no spec found (${o.source?.file ?? "inline"}): form lint skipped`);
    if (spec) {
      try {
        forms[o.id] = formNodes(spec, scale);
        const sizeOf = (part: Record<string, unknown>) => {
          try {
            const ns = formNodes({ version: 1, roles: spec.roles ?? {}, parts: [{ ...part, at: [0, 0, 0], rot: [0, 0, 0] }] }, scale).filter((n) => n.op !== "sub");
            return ns.length ? [0, 1, 2].map((a) => Math.max(...ns.map((n) => n.max[a]!)) - Math.min(...ns.map((n) => n.min[a]!))) : [0];
          } catch { return [0]; }
        };
        units[o.id] = specUnits(spec.parts ?? [], sizeOf);
      } catch (e) { notes.push(`landmark ${o.id}: spec did not compile (${(e as Error).message})`); }
    }
    const near = nearPropInstances(propInstances, owned, at, radius + T.texel.radius, (id) => posOf(id).p); // its own fittings are not "the props around it"
    let w = 0, v = 0; const seen = new Set<string>();
    for (const [, e] of near) { const pid = e.components.prefab.prefabId; if (seen.size >= 60 && !seen.has(pid)) continue; seen.add(pid); const d = propTexels(pid); if (d && d.area > 0) { w += d.area; v += d.area * d.median; } }
    props[o.id] = w ? v / w : null;
  } else if (o.op === "paint" && Array.isArray(o.polygon)) {
    const s = surf.find((x) => x.name === o.surface);
    if (!s) { notes.push(`paint ${o.id}: surface ${o.surface} not in the recipe`); continue; }
    let a = 0; const P = o.polygon as [number, number][];
    for (let i = 0; i < P.length; i++) { const p = P[i]!, q = P[(i + 1) % P.length]!; a += p[0] * q[1] - q[0] * p[1]; }
    const c: [number, number] = [P.reduce((t, p) => t + p[0], 0) / P.length, P.reduce((t, p) => t + p[1], 0) / P.length];
    const r = Math.max(...P.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
    pieces.push({ id: o.id, kind: "paint", at: c, materials: [{ id: `surface:${s.name}`, area: Math.abs(a) / 2, texels: s.texels, projected: true, natural: true, lstar: s.lstar, colours: s.stats?.colours ?? null, px: s.stats ? [s.stats.width, s.stats.height] : null, course: null }] });
    terrain[o.id] = terrainAround(c[0], c[1], r + T.texel.radius);
  }
}

// ---- the POI's owned scene entities (job scene ops + world entities tagged poi:<id>, with their descendants): added
// meshes and structure-sized prefabs are `mesh` pieces (built work), smaller prefab instances `prop` pieces
const landmarkPrefabs = new Set([...builtPieces.values()].flatMap((b) => (b.piece ? [b.piece.prefab] : [])));
const S3 = (s: V3): M4 => trs([0, 0, 0], [0, 0, 0, 1], s);
const meshMaterials = (geo: PropGeometry, k: number): ArtMaterial[] => {
  const d = texelDensity(geo, { projected: proj }), uvRep = uvRepeatsByMaterial(geo.tris);
  const out = Object.entries(d.byMaterial ?? {}).filter(([id]) => id !== "(none)").map(([id, m]) => {
    const md = matJson(id) ?? {};
    // an owned mesh laid triplanar with a BUILT tile (coursed ashlar, timber) is built work on the town standard, not rock
    const natural = (m.projected && !BUILT_MATERIAL.test(id)) || md.shader === "terrain-splat" || md.shader === "rock-cap";
    const d = describeMaterial(id, m.area * k, m.median, m.projected, natural, geo.tris);
    // UV-laid textures (a prop's own atlas, a mesh's UVs) repeat as often as the UVs say: one instance's count
    if (!m.projected && uvRep[id] != null) d.uvRepeats = uvRep[id];
    return d;
  });
  // flat-colour (untextured) materials and mapped ones on UV-less triangles: no texel density, still judged
  out.push(...unmeasured(geo.tris, d.byMaterial ?? {}, k));
  return out;
};
const ownedForm: FormNode[] = [];
const prefabGroups = new Map<string, { kind: "mesh" | "prop"; pid?: string; at: [number, number][]; mats: Map<string, ArtMaterial>; setIn?: boolean }>();
let ownedGeometry = 0;
for (const id of owned) {
  if (isPortalVeil(id, allEnts)) continue; // the portal's dark mouth (portal-veil's house material), judged by the portal rule
  const e = allEnts[id], c = e?.components ?? {};
  const w = posOf(id), at: [number, number] = [w.p[0], w.p[2]];
  if (c.mesh?.source) {
    const mat = typeof c.mesh.material === "string" ? c.mesh.material : undefined, tex = materialTex(ASSETS, mat), src = c.mesh.source, tris: Tri[] = [];
    if (src.kind === "surface" && Array.isArray(src.positions) && Array.isArray(src.indices)) {
      const P: number[] = src.positions, U: number[] | null = Array.isArray(src.uvs) ? src.uvs : null, s = w.s;
      const v = (i: number): V3 => [P[i * 3]! * s[0], P[i * 3 + 1]! * s[1], P[i * 3 + 2]! * s[2]];
      const uv = (i: number): [number, number] => [U![i * 2]!, U![i * 2 + 1]!];
      for (let i = 0; i + 2 < src.indices.length; i += 3) { const [a, b, cc] = [src.indices[i], src.indices[i + 1], src.indices[i + 2]] as number[]; tris.push({ a: v(a!), b: v(b!), c: v(cc!), material: mat, tex, ...(U ? { uv: [uv(a!), uv(b!), uv(cc!)] } : {}) }); }
    } else if (src.kind === "asset") {
      const f = locate(ASSETS, "models", src.assetId);
      if (fs.existsSync(f)) gltfTris(f, S3(w.s), mat, tris, tex); else notes.push(`mesh ${id}: missing model ${src.assetId}`);
    } else if (src.kind === "primitive") boxTris(src.size ?? [1, 1, 1], S3(w.s), tris, { material: mat, tex, box: (src.shape ?? "box") === "box", uv: src.uv ?? c.mesh.uv });
    else notes.push(`mesh ${id}: source kind ${src.kind} not measured`);
    if (!tris.length) continue;
    ownedGeometry++;
    const mats = meshMaterials({ tris, min: [0, 0, 0], max: [0, 0, 0], effects: [], lights: 0, nested: [], warnings: [] }, 1);
    if (mat && !matJson(mat)) for (const m of mats) if (m.id === mat) m.missing = true;
    // a still WATER sheet (a `water` component: a layout `waters` sheet in a dark passage) is not matched to the ground
    // band (the lake it continues is not either); the near-black floor still judges it. L (w-temple10 2026-11-03)
    pieces.push({ id, kind: "mesh", at, materials: mats, ...(c.water ? { bandFree: true } : {}) });
    terrain[id] = terrainAround(at[0], at[1], T.texel.radius);
    // form lint where geometry is available: world bounds per owned mesh (primitive boxes are judged as raw boxes)
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    let area = 0;
    for (const t of tris) {
      for (const p of [t.a, t.b, t.c]) { const q = qrot(w.q, p); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, q[k]! + w.p[k]!); hi[k] = Math.max(hi[k]!, q[k]! + w.p[k]!); } }
      const u = [0, 1, 2].map((k) => t.b[k]! - t.a[k]!), vv = [0, 1, 2].map((k) => t.c[k]! - t.a[k]!);
      area += Math.hypot(u[1]! * vv[2]! - u[2]! * vv[1]!, u[2]! * vv[0]! - u[0]! * vv[2]!, u[0]! * vv[1]! - u[1]! * vv[0]!) / 2;
    }
    const box = src.kind === "primitive" && (src.shape ?? "box") === "box";
    ownedForm.push({ name: String(e.name ?? id), role: mat ?? "", natural: mats.length > 0 && mats.every((m) => m.natural), op: "add", shape: box ? "box" : "mesh", dims: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], min: lo, max: hi, bevel: Number(c.mesh.bevel ?? 0) || 0, area });
  } else if (typeof c.prefab?.prefabId === "string") {
    const pid: string = c.prefab.prefabId;
    if (landmarkPrefabs.has(pid)) continue;
    let geo: PropGeometry;
    try { geo = prefabGeometry(ASSETS, pid); } catch (err) { notes.push(`prefab ${pid} (${id}): ${(err as Error).message}`); continue; }
    if (!geo.tris.length) continue;
    ownedGeometry++;
    const k = Math.max(Math.abs(w.s[0]), Math.abs(w.s[1]), Math.abs(w.s[2])) || 1;
    const big = Math.max(...[0, 1, 2].map((a) => geo.max[a]! - geo.min[a]!)) * k >= T.measure.structureSize;
    const key = `${big ? "mesh" : "prop"}:${pid}`;
    const g = prefabGroups.get(key) ?? { kind: big ? "mesh" as const : "prop" as const, pid, at: [], mats: new Map<string, ArtMaterial>() };
    g.at.push(at);
    // SET INTO the ground (layout `bedded` tag, or the prefab's placeRule seat `set-in`): judged against the stone round it
    if ((e?.tags ?? []).includes("bedded") || (e?.tags ?? []).includes("set-in") || placeRuleFor(project, pid)?.seat === "set-in") g.setIn = true;
    if (!g.mats.size || g.at.length === 1) {
      // one instance measured, area scaled by k^2; UV texels thin out by 1/k (a projected material keeps its density)
      for (const m of meshMaterials(geo, k * k)) g.mats.set(m.id, m.projected ? m : { ...m, texels: m.texels / k });
    } else for (const m of g.mats.values()) { m.area += m.area / (g.at.length - 1); if (m.uvRepeats != null) m.uvRepeats += m.uvRepeats / (g.at.length - 1); }
    prefabGroups.set(key, g);
  }
}
for (const [key, g] of prefabGroups) {
  const at: [number, number] = [g.at.reduce((t, p) => t + p[0], 0) / g.at.length, g.at.reduce((t, p) => t + p[1], 0) / g.at.length];
  const r = Math.max(0, ...g.at.map((p) => Math.hypot(p[0] - at[0], p[1] - at[1])));
  pieces.push({ id: key, kind: g.kind, at, materials: [...g.mats.values()], ...(g.setIn ? { setIn: true } : {}), ...(groundBandFree(g.kind, g.pid, prefabDressing(g.pid)) ? { bandFree: true } : {}) });
  terrain[key] = terrainAround(at[0], at[1], r + T.texel.radius);
}
if (ownedForm.length) forms[`scene:${tier.id}`] = ownedForm;
// built neighbours for owned structures: the catalogued props near them (not their own instances)
for (const p of pieces) if (p.kind === "mesh") {
  let w = 0, v = 0;
  for (const [pid, e] of propInstances) { if (owned.has(pid)) continue; const q = posOf(pid).p; if (Math.hypot(q[0] - p.at[0], q[2] - p.at[1]) > T.texel.radius) continue; const d = propTexels(e.components.prefab.prefabId); if (d && d.area > 0) { w += d.area; v += d.area * d.median; } }
  props[p.id] = w ? v / w : null;
}

// ---- the job's OWN terrain (_art-check groundFaults): its height patches' tops and its passages' walls + ceilings, as the
// terrain draws them (splat surfaces at the sample's position + normal, the job's paint included), against the built work
// beside them, both as seen. Measured on the target world, with the job's features added when it is not installed yet.
const GROUND_KINDS = ["heightPatches", "passages", "operators", "groundPaints", "blobs"];
const jobFeatureOps = worldOps.filter((o) => o.edit === "add-feature" && GROUND_KINDS.includes(String(o.kind)));
const missingOps = jobFeatureOps.filter((o) => !((recipe.features as unknown as Record<string, { id: string }[] | undefined>)[o.kind] ?? []).some((f) => f.id === o.feature?.id));
const groundRecipe = missingOps.length ? applyRecipeEdits(recipe, missingOps as never).recipe : recipe;
const groundField = missingOps.length ? createWorldField(groundRecipe) : field;
// the same ground WITHOUT the job's own paint (its groundPaints): what the zone's paint shows there. A pad's surface is
// judged against the built work only for the weight the job's paint added (_art-check ArtMaterial.painted)
const jobPaintIds = new Set(jobFeatureOps.filter((o) => o.kind === "groundPaints").map((o) => String(o.feature?.id)));
const zonePaintField = jobPaintIds.size
  ? createWorldField({ ...groundRecipe, features: { ...groundRecipe.features, groundPaints: ((groundRecipe.features as unknown as { groundPaints?: { id: string }[] }).groundPaints ?? []).filter((g) => !jobPaintIds.has(g.id)) } } as WorldRecipe)
  : groundField;
const zoneSplat = new Float32Array(recipe.surfaces.length + 8);
const splatOut = new Float32Array(recipe.surfaces.length + 8);
type GSample = { x: number; y: number; z: number; ny: number; area: number };
const groundSets: { id: string; samples: GSample[]; zonePaint?: boolean }[] = [];
for (const o of jobFeatureOps) {
  const ft = o.feature ?? {};
  if (o.kind === "heightPatches" && Array.isArray(ft.weights) && ft.columns > 1 && ft.rows > 1) {
    const cs = ft.size[0] / (ft.columns - 1), rs = ft.size[1] / (ft.rows - 1), stride = Math.max(1, Math.round(Math.sqrt((ft.columns * ft.rows) / 1500)));
    const samples: GSample[] = [];
    // the ground WITHOUT this patch: a cell it leaves as it was (a masked cell over a stack top or the cliff) is not its ground
    const bare = createWorldField({ ...recipe, features: { ...recipe.features, heightPatches: ((recipe.features as unknown as { heightPatches?: { id: string }[] }).heightPatches ?? []).filter((h) => h.id !== ft.id) } } as WorldRecipe);
    for (let j = 0; j < ft.rows; j += stride) for (let i = 0; i < ft.columns; i += stride) {
      if (!(ft.weights[j * ft.columns + i] >= 0.5)) continue;
      const x = ft.origin[0] + i * cs, z = ft.origin[1] + j * rs, y = groundField.height(x, z);
      // only where the patch IS the ground (a raiseOnly patch under a taller cliff leaves that cliff's own stone)
      if (Array.isArray(ft.heights) && typeof ft.heights[j * ft.columns + i] === "number" && Math.abs(y - ft.heights[j * ft.columns + i]) > 0.5) continue;
      if (Math.abs(y - bare.height(x, z)) < 0.3) continue;
      // under the sea it is not seen at this scale
      const wy = groundField.waterY(x, z); if (wy != null && y < wy - 0.3) continue;
      samples.push({ x, y, z, ny: Math.max(0, 1 - groundField.slope(x, z)), area: cs * rs * stride * stride });
    }
    if (samples.length) groundSets.push({ id: `ground:${ft.id}`, samples, zonePaint: true });
  } else if (o.kind === "passages" && Array.isArray(ft.start)) {
    // a passage's two walls at half height and its ceiling, never a point in the air over an open cut (_art-check passageGroundSamples)
    let set = groundSets.find((g) => g.id === "ground:passages"); if (!set) { set = { id: "ground:passages", samples: [] }; groundSets.push(set); }
    set.samples.push(...passageGroundSamples(ft, (x, z) => groundField.height(x, z)));
  }
}
const surfSeen = surf.map((s) => { const ds = s.map ? detailOf(s.map) : null; return ds && Number.isFinite(s.texels) ? s.texels / ds : null; });
for (const g of groundSets) {
  const acc = new Map<number, number>(), painted = new Map<number, number>(); let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of g.samples) {
    groundField.splatAt(s.x, s.y, s.z, s.ny, splatOut, 0);
    if (g.zonePaint) zonePaintField.splatAt(s.x, s.y, s.z, s.ny, zoneSplat, 0);
    for (let k = 0; k < recipe.surfaces.length; k++) {
      if (splatOut[k]! > 0.02) acc.set(k, (acc.get(k) ?? 0) + splatOut[k]! * s.area);
      if (g.zonePaint) { const add = splatOut[k]! - zoneSplat[k]!; if (add > 0.02) painted.set(k, (painted.get(k) ?? 0) + add * s.area); }
    }
    x0 = Math.min(x0, s.x); z0 = Math.min(z0, s.z); x1 = Math.max(x1, s.x); z1 = Math.max(z1, s.z);
  }
  const at: [number, number] = [(x0 + x1) / 2, (z0 + z1) / 2];
  pieces.push({ id: g.id, kind: "ground", at, materials: [...acc].sort((a, b) => b[1] - a[1]).map(([k, a]) => {
    const s = surf[k]!;
    return { id: `surface:${s.name}`, area: a, texels: s.texels, projected: true, natural: true, lstar: null, colours: s.stats?.colours ?? null, px: s.stats ? [s.stats.width, s.stats.height] as [number, number] : null, map: s.map ?? null, course: null, seen: surfSeen[k], ...(g.zonePaint ? { painted: Math.round((painted.get(k) ?? 0) * 10) / 10 } : {}) };
  }) });
  terrain[g.id] = terrainAround(at[0], at[1], T.texel.radius);
  // the built work beside it: owned structures / landmark bakes standing inside its sample box (+ radius)
  let w = 0, v = 0;
  for (const p of pieces) {
    if (p.kind !== "mesh" && p.kind !== "landmark") continue;
    // L (careening-strand 2026-10-31): a ship, boat or shelter is not masonry: never the built reference a pad's texels match
    if (p.bandFree) continue;
    if (p.at[0] < x0 - T.texel.radius || p.at[0] > x1 + T.texel.radius || p.at[1] < z0 - T.texel.radius || p.at[1] > z1 + T.texel.radius) continue;
    for (const m of p.materials) if (!m.natural && m.seen != null && m.seen > 0 && m.area > 0) { w += m.area; v += m.area * m.seen; }
  }
  built[g.id] = w ? v / w : null;
}

// ---- portals, doors, dungeon, tier, culture
const portals: ArtPortal[] = [];
for (const [id, e] of Object.entries(allEnts)) {
  const sc = e?.components?.script;
  if (sc?.name !== "portal") continue;
  const p = posOf(id).p;
  portals.push({ id, at: [p[0], p[2]], scene: typeof sc.params?.scene === "string" && sc.params.scene ? sc.params.scene : null, veil: !!allEnts[`${id}-veil`] || sc.params?.mode !== "trigger" });
}
// L (Wristgate 2026-10-29): a grey-box hand-off wrote doors as { name, portal, at: [x,y,z], note } and art-check died on a
// raw Zod stack; a malformed door is a named usage stop with the schema's own wording, not a crash
const doors = (Array.isArray(hand.doors) ? hand.doors : []).map((d: unknown, i: number) => {
  const r = artDoorSchema.safeParse(d);
  if (r.success) return r.data;
  console.error(`STOP: handoff.json doors[${i}] is not an art-check door { name, sealed, why?, at?: [x, z] }: ${r.error.issues.map((x) => `${x.path.join(".") || "(entry)"} ${x.message}`).join("; ")}`);
  process.exit(2);
});
const zoneDir = zone ? path.join(HOME, "authoring", "zonegen", home.world, "zones", zone) : null;
const place = zoneDir ? ((tryJson(path.join(zoneDir, "brief.json"))?.places ?? []) as { id: string; dungeon?: { name?: string } | null; holder?: string }[]).reduce<{ id: string; dungeon?: { name?: string } | null; holder?: string } | undefined>((hit, p) => (p.id === tier.id ? p : hit ?? (p.id === jobParent(jobDir) ? p : undefined)), undefined) : undefined; // a parented door (brief parent) judges its parent place's dungeon door
const doorAt = (() => {
  const d = doors.find((x: { name: string }) => x.name === "dungeon") as { at?: [number, number] } | undefined;
  if (d?.at) return d.at;
  const o = openings[0] ?? null; if (o) return o.at;
  const lm = pieces.filter((p) => p.kind === "landmark");
  const named = lm.find((p) => /door|mouth|gate|entrance|portal/i.test(p.id));
  if (named) return named.at;
  return lm.length ? ([lm.reduce((t, p) => t + p.at[0], 0) / lm.length, lm.reduce((t, p) => t + p.at[1], 0) / lm.length] as [number, number]) : null;
})();
const groups = zoneDir ? ((tryJson(path.join(zoneDir, "bestiary.json"))?.groups ?? []) as { id: string; where?: string; faction?: string; members?: { creature: string }[] }[]) : [];
const holder = groups.find((g) => g.id === place?.holder || g.where === tier.id);
const culture: CultureScale = (flag("culture") as CultureScale | undefined) ?? (holder && /giant/i.test(`${holder.faction ?? ""} ${(holder.members ?? []).map((m) => m.creature).join(" ")}`) ? "giant" : "human");
const flat = Object.values(terrain).map((t) => t.lstar).filter((v): v is number => v != null);
const input: ArtInput = {
  tier: tier.tier, culture, groundL: flat.length ? flat.reduce((a, v) => a + v, 0) / flat.length : null, terrain, props, pieces, openings,
  accent: [...new Set(((recipe as unknown as { regions?: { palette?: { builtStone?: Record<string, string | string[]> } }[] }).regions ?? []).flatMap((r) => [r.palette?.builtStone?.accent ?? []].flat()))],
  dungeon: place?.dungeon && doorAt ? { name: place.dungeon.name ?? "dungeon", at: doorAt } : null, portals, doors, forms, units, built,
};
if (place?.dungeon && !doorAt) notes.push(`place has a dungeon but no door position (no handoff.json doors[{name:"dungeon",at}], landmark opening or landmark): the portal check was skipped`);
// the job's dated coordinator rulings (<job>/quality-exceptions.json, gate "art", match { rule, what? }): excepted, never counted
type ArtFault = ReturnType<typeof artFaults>[number];
const { kept: faults, excepted } = exceptFaults(artFaults(input, T), jobExceptions(jobDir, "art")) as { kept: ArtFault[]; excepted: (ArtFault & { exception: string; ruling: string })[] };
// FINDINGS (never faults): set-in pieces whose picture contrast is well over the stone they are set into (o-gates 2026-10-30)
for (const f of contrastFindings(input, T)) notes.push(`FINDING contrast: ${f}`);
const diagnostics = varietyDiagnostics(input, T);
const architecturalPieces = pieces.filter((p) => ["landmark", "mesh"].includes(p.kind) && p.materials.some((m) => !m.natural));
const architectureCoverage = {
  withSourceRoles: architecturalPieces.filter((p) => p.architecture !== undefined).map((p) => p.id),
  sourceRolesUnavailable: architecturalPieces.filter((p) => p.architecture === undefined).map((p) => p.id),
  staleBakes: architecturalPieces.filter((p) => p.architectureBakeMatchesSource === false).map((p) => p.id),
  unclassifiedRoles: architecturalPieces.flatMap((p) => (p.architecture ?? []).filter((b) => b.purpose === "other").map((b) => ({ piece: p.id, role: b.sourceRole }))),
};
if (architectureCoverage.sourceRolesUnavailable.length || architectureCoverage.unclassifiedRoles.length) notes.push("Some architectural source roles are unavailable or unclassified (architectureCoverage); their purpose/material relationships require source and visual review. Texture counts do not certify them.");
const counts: Record<string, number> = {};
for (const f of faults) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
const report = {
  materialPolicy: T.variety.mode, architectureCoverage, diagnostics,
  architecturalAssignments: Object.fromEntries(pieces.filter((p) => p.architecture !== undefined).map((p) => [p.id, p.architecture])),
  tool: "art-check", job: path.relative(PG, jobDir).replace(/\\/g, "/"), ok: faults.length === 0, measured: pieces.length, owned: owned.size, ownedWithGeometry: ownedGeometry, counts, faults, excepted,
  context: { tier: input.tier, culture, groundL: input.groundL && Math.round(input.groundL * 10) / 10, dungeon: input.dungeon, portalsInScene: portals.length, doors },
  pieces: pieces.map((p) => ({ id: p.id, kind: p.kind, terrain: terrain[p.id], props: props[p.id], ...(p.kind === "ground" ? { builtSeen: built[p.id] == null ? null : Math.round(built[p.id]! * 10) / 10 } : {}), materials: p.materials.map((m) => ({ ...m, area: Math.round(m.area), texels: Math.round(m.texels * 10) / 10, seen: m.seen == null ? null : Math.round(m.seen * 10) / 10, lstar: m.lstar == null ? null : Math.round(m.lstar * 10) / 10, course: m.course == null ? null : Math.round(m.course * 100) / 100 })) })),
  openings, notes, thresholds: T,
};
const out = flag("out") ?? path.join(jobDir, "reports", "art-check.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
if (!argv.includes("--quiet")) {
  console.log(`art-check ${report.job}: ${report.ok ? "ok" : `${faults.length} fault(s) ${JSON.stringify(counts)}`}${excepted.length ? ` (${excepted.length} excepted by ${path.basename(jobDir)}/quality-exceptions.json)` : ""} (tier ${input.tier ?? "?"}, culture ${culture}, ground L* ${report.context.groundL ?? "?"})`);
  for (const p of report.pieces) console.log(`  ${p.kind} ${p.id}: terrain ${p.terrain ? `${Math.round(p.terrain.texels)} tx/m (steep ${p.terrain.steep == null ? "-" : Math.round(p.terrain.steep)}, L* ${p.terrain.lstar == null ? "-" : Math.round(p.terrain.lstar)})` : "-"}${p.props != null ? `, props ${Math.round(p.props)} tx/m` : ""}${"builtSeen" in p ? `, built beside it ${p.builtSeen ?? "-"} tx/m seen` : ""} | ${p.materials.map((m) => `${m.id} ${m.area} m2 ${m.texels} tx/m${m.seen != null ? ` (seen ${m.seen})` : ""} L* ${m.lstar ?? "-"}${m.course != null ? ` course ${m.course} m` : ""}${m.stretch ? ` stretched ${Math.round(m.stretch.share * 100)}% (worst ${m.stretch.worst}:1)` : ""}`).join("; ")}`);
  for (const f of faults) console.log(`  FAULT ${f.rule} ${f.piece} ${f.what}: ${f.detail}`);
  for (const f of excepted) console.log(`  excepted (${f.exception}, ${f.ruling}) ${f.rule} ${f.piece} ${f.what}: ${f.detail}`);
  for (const d of diagnostics) console.log(`  diagnostic ${d.rule} ${d.piece} ${d.what}: ${d.detail}`);
  for (const n of notes) console.log(`  note: ${n}`);
  console.log(`  -> ${out}`);
}
process.exitCode = report.ok ? 0 : 1;
