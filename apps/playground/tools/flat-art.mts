/**
 * FLAT-ART — is every ornate slab (door relief, plaque, panel, banner board) upright in the world?
 *
 *   node tools/flat-art.mts check <project> [--scene <id|file>] [--no-prefabs] [--json] [--out f.json]
 *   node tools/flat-art.mts check <project> ... --fix [--inverse f.json]    (flips the flipped GLBs' UVs; inverse kept)
 *   node tools/flat-art.mts undo <project> --inverse f.json                  (restores the GLBs the fix rewrote)
 *
 * THE CONVENTION (the cause of the upside-down First King's Door, 2026-10-13): a material ASSET's `map` loads through
 * THREE.TextureLoader with flipY = true, so a GLB face carrying it samples image row = (1 - v) * H — v counts rows
 * from the BOTTOM. A GLB's own embedded texture is glTF (flipY = false, row = v * H). A builder that writes glTF
 * image-space UVs (v down) onto a slab and then gives it an engine material shows the art upside down. So a flat-art
 * slab with an engine material must store v = 1 - row (rows from the top, 0..1) in the GLB. From Blender (bpy),
 * whose exporter writes v_gltf = 1 - v_blender, that is v_blender = row (see {@link blenderSlabV}).
 *
 * The check needs no renderer: for every vertical face of a UV-mapped GLB that wears an engine material with a map,
 * it measures how the sampled image ROW changes going UP the face in the world (it must fall: the image's top row at
 * the top) and how the COLUMN changes going to the viewer's right (it must rise: not mirrored). Area-weighted per
 * entity; an entity is `flipped` / `mirrored` when most of its art area is. Exit 1 on any flipped or mirrored slab.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearGltfCache, gltfTris, mul, trs, locate, readJson, materialTex, type M4, type Tri, type V3 } from "./_prop-geometry.mts";
import { PROJECTS } from "./_closure.mjs";

/** Image row (0 = top, 1 = bottom) -> the GLB `v` an engine-material (flipY) slab must store. */
export const slabV = (row: number): number => 1 - row;
/** Image row -> the bpy UV `v` a Blender builder writes (the glTF exporter flips v on export). */
export const blenderSlabV = (row: number): number => row;

export interface FlatArtRow {
  where: string; // "scene:<id>" or "prefab:<id>"
  entity: string;
  model: string;
  material: string;
  texture: string;
  /** Art area (m^2) measured on vertical faces. */
  area: number;
  /** Share of that area whose image rows run UP the face (upside down). */
  flippedShare: number;
  /** Share of that area whose image columns run to the viewer's LEFT (mirrored). */
  mirroredShare: number;
  status: "upright" | "flipped" | "mirrored" | "mixed" | "not-slab" | "tiled";
  /** Share of the UV'd vertical area mapped axis-aligned (a slab ~1; an unwrapped model's atlas much lower). */
  slabShare: number;
  /** Share of the front UV area mapped more than once (a repeated texture, not a picture). */
  overlap: number;
  /** Share of the image the art face shows. */
  cover: number;
  file: string;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Orientation of world-space UV'd triangles. Only vertical faces count, and only the ART facing (the azimuth bin, 8
 * bins, with the most distinct picture area: a slab's front, not its plain back and edges) is judged: d(row)/d(up) must be
 * negative (image top at the top) and d(col)/d(right) positive (not mirrored). `slabShare` = share of all
 * vertical UV area mapped axis-aligned (up -> rows only, right -> columns only): a flat-art slab is ~1, an
 * unwrapped model's atlas islands (rotated every way) are far lower. `flipY` = the texture loader's convention.
 */
/** Share of covered cells of a 128 x 128 UV grid covered by more than one of the triangles. */
export function uvOverlap(tris: [number, number][][], N = 128): number { return uvCover(tris, N).overlap; }
/** Covered share of the image (0..1 square) and the share of covered cells hit more than once, on an N x N grid. */
export function uvCover(tris: [number, number][][], N = 128): { cover: number; overlap: number } {
  const hits = new Uint16Array(N * N);
  for (const [a, b, c] of tris) {
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) * N)), x1 = Math.min(N - 1, Math.floor(Math.max(a[0], b[0], c[0]) * N));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) * N)), y1 = Math.min(N - 1, Math.floor(Math.max(a[1], b[1], c[1]) * N));
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(d) < 1e-12) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) / N, py = (y + 0.5) / N;
      const w1 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / d, w2 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / d;
      if (w1 >= -1e-6 && w2 >= -1e-6 && w1 + w2 <= 1 + 1e-6) hits[y * N + x]++;
    }
  }
  let cov = 0, multi = 0;
  for (const h of hits) { if (h) cov++; if (h > 1) multi++; }
  return { cover: cov / (N * N), overlap: cov ? multi / cov : 0 };
}

export function artOrientation(tris: Tri[], flipY: boolean): { area: number; flippedShare: number; mirroredShare: number; slabShare: number; frontArea: number; tiled: boolean; overlap: number; cover: number } {
  const UP: V3 = [0, 1, 0];
  const bins = Array.from({ length: 8 }, () => ({ area: 0, flipped: 0, mirrored: 0, lo: [Infinity, Infinity], hi: [-Infinity, -Infinity], uvs: [] as [number, number][][] }));
  let area = 0, aligned = 0;
  for (const t of tris) {
    if (!t.uv) continue;
    const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a), nn = cross(e1, e2), l = Math.hypot(...nn);
    if (l < 1e-9) continue;
    const n: V3 = [nn[0] / l, nn[1] / l, nn[2] / l];
    if (Math.abs(n[1]) > 0.5) continue; // only faces you look at from the side
    const [u0, v0] = t.uv[0], [u1, v1] = t.uv[1], [u2, v2] = t.uv[2];
    const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
    if (Math.abs(du1 * dv2 - du2 * dv1) < 1e-12) continue; // degenerate UVs
    // derivative of (u, v) along an in-plane direction w = a e1 + b e2 is a du1 + b du2
    const along = (w: V3): [number, number] => {
      const g11 = dot(e1, e1), g12 = dot(e1, e2), g22 = dot(e2, e2), r1 = dot(e1, w), r2 = dot(e2, w), det = g11 * g22 - g12 * g12;
      const a = (r1 * g22 - r2 * g12) / det, b = (r2 * g11 - r1 * g12) / det;
      return [a * du1 + b * du2, a * dv1 + b * dv2];
    };
    const upP: V3 = sub(UP, [n[0] * n[1], n[1] * n[1], n[2] * n[1]]);
    const right = cross(UP, n); // the viewer faces -n; their right is up x n
    const [duUp, dvUp] = along(upP);
    const [duRight, dvRight] = along(right);
    const rowUp = flipY ? -dvUp : dvUp; // row = (1 - v) H when flipY, v H otherwise
    const a = l / 2;
    area += a;
    if (Math.abs(duUp) < 0.15 * Math.abs(dvUp) && Math.abs(dvRight) < 0.15 * Math.abs(duRight)) aligned += a;
    const bin = bins[((Math.round(Math.atan2(n[0], n[2]) / (Math.PI / 4)) % 8) + 8) % 8];
    bin.area += a;
    if (rowUp > 0) bin.flipped += a;
    if (duRight < 0) bin.mirrored += a;
    bin.uvs.push(t.uv);
    for (const [u, v] of t.uv) { bin.lo[0] = Math.min(bin.lo[0], u); bin.lo[1] = Math.min(bin.lo[1], v); bin.hi[0] = Math.max(bin.hi[0], u); bin.hi[1] = Math.max(bin.hi[1], v); }
  }
  // the art face: the facing with the most DISTINCT picture area (a slab's back and edges map one plain patch again and again)
  const scored = bins.map((b) => ({ b, ...(b.area ? uvCover(b.uvs) : { cover: 0, overlap: 1 }) }));
  const { b: front, overlap, cover } = scored.reduce((best, x) => (x.b.area * (1 - x.overlap) > best.b.area * (1 - best.overlap) ? x : best), scored[0]);
  // a page of art is one picture inside 0..1; UVs running past one tile are a tiling surface (stone, planks)
  // ... a picture shows most of itself (an atlas or palette face samples small patches: not a picture) ...
  // ... and a picture is laid out once: front faces mapping the SAME image area again (planks, courses, blocks) are a
  // texture, not art. Share of the covered UV cells (128 x 128) that more than one front triangle covers.
  const tiled = front.hi[0] - front.lo[0] > 1.05 || front.hi[1] - front.lo[1] > 1.05 || overlap > 0.25 || cover < 0.025;
  return { area, frontArea: front.area, tiled, overlap, cover, slabShare: area ? aligned / area : 0,
    flippedShare: front.area ? front.flipped / front.area : 0, mirroredShare: front.area ? front.mirrored / front.area : 0 };
}

/** Below this axis-aligned share a UV'd mesh is an unwrapped model (a mob, a hull), not a flat-art slab: not judged. */
export const SLAB_MIN = 0.85;

/** Not flat art: an unwrapped model, or a tiling surface whose UVs run past one tile (orientation is not a picture's). */
const SKIP = ["not-slab", "tiled"];

function statusOf(f: number, m: number, slab: number, tiled: boolean): FlatArtRow["status"] {
  if (slab < SLAB_MIN) return "not-slab";
  if (tiled) return "tiled";
  if (f > 0.5) return "flipped";
  if (m > 0.5) return "mirrored";
  if (f > 0.1 || m > 0.1) return "mixed";
  return "upright";
}

/** Engine material with a base-colour map, not world-projected: the faces read the mesh UVs as the art. */
function artMaterial(assets: string, material: unknown): { tex: ReturnType<typeof materialTex>; md: any } | null {
  if (typeof material !== "string") return null;
  const mf = locate(assets, "materials", `${material}.json`);
  if (!fs.existsSync(mf)) return null;
  const md = readJson(mf);
  if (md.triplanar || typeof md.map !== "string") return null;
  const tex = materialTex(assets, material);
  return tex ? { tex, md } : null;
}

const skinCache = new Map<string, boolean>();
/** A GLB with a skin (a rigged creature or character). */
function skinned(file: string): boolean {
  let k = skinCache.get(file);
  if (k === undefined) { try { k = (readGlb(file).json.skins ?? []).length > 0; } catch { k = false; } skinCache.set(file, k); }
  return k;
}

function docRows(assets: string, doc: { entities: Record<string, any> }, where: string, rootFrame: boolean): FlatArtRow[] {
  const ents = doc.entities ?? {};
  const world = new Map<string, M4>();
  const worldOf = (eid: string): M4 => {
    const hit = world.get(eid);
    if (hit) return hit;
    const e = ents[eid], t = e?.components?.transform ?? {};
    // prefab roots: an instance replaces the root's own transform (rotation about Y keeps "up")
    const local = rootFrame && e?.parent == null ? trs() : trs(t.position, t.rotation, t.scale);
    const m = e?.parent != null && ents[e.parent] ? mul(worldOf(e.parent), local) : local;
    world.set(eid, m);
    return m;
  };
  const out: FlatArtRow[] = [];
  for (const [eid, e] of Object.entries(ents)) {
    const mesh = e.components?.mesh;
    if (mesh?.source?.kind !== "asset") continue;
    const art = artMaterial(assets, mesh.material);
    if (!art) continue;
    const file = locate(assets, "models", mesh.source.assetId);
    if (!fs.existsSync(file)) continue;
    if (skinned(file)) continue; // a rigged creature: its skin is an unwrap, never a slab
    const tris: Tri[] = [];
    gltfTris(file, worldOf(eid), mesh.material, tris, art.tex);
    if (!tris.some((t) => t.uv)) continue; // no UVs: the material is not flat art on this mesh
    const o = artOrientation(tris, art.tex!.flipY !== false);
    if (o.area < 1e-4) continue;
    out.push({ where, entity: eid, model: mesh.source.assetId, material: mesh.material, texture: art.md.map, area: +o.area.toFixed(3),
      flippedShare: +o.flippedShare.toFixed(3), mirroredShare: +o.mirroredShare.toFixed(3), slabShare: +o.slabShare.toFixed(3), overlap: +o.overlap.toFixed(3), cover: +o.cover.toFixed(3), status: statusOf(o.flippedShare, o.mirroredShare, o.slabShare, o.tiled), file });
  }
  return out;
}

function listJson(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJson(f));
    else if (e.name.endsWith(".json")) out.push(f);
  }
  return out;
}

/** Every flat-art slab of a project: its scenes (or one) and, unless `prefabs` is false, its own prefabs. */
export function checkProject(project: string, opts: { scene?: string; prefabs?: boolean } = {}): FlatArtRow[] {
  const root = path.join(PROJECTS, project), assets = path.join(root, "assets");
  const scenes = opts.scene
    ? [fs.existsSync(opts.scene) ? opts.scene : path.join(assets, "scenes", `${opts.scene}.scene.json`)]
    : listJson(path.join(assets, "scenes")).filter((f) => f.endsWith(".scene.json"));
  const rows: FlatArtRow[] = [];
  for (const f of scenes) rows.push(...docRows(assets, readJson(f), `scene:${path.basename(f, ".scene.json")}`, false));
  if (opts.prefabs !== false)
    for (const f of listJson(path.join(assets, "prefabs"))) {
      const doc = readJson(f);
      if (doc?.entities) rows.push(...docRows(assets, doc, `prefab:${path.relative(path.join(assets, "prefabs"), f).replace(/\\/g, "/").replace(/\.json$/, "")}`, true));
    }
  return rows;
}

// ------------------------------------------------------------------ fix: flip a GLB's TEXCOORD_0 v in place ----
interface Glb { json: any; bin: Buffer }
function readGlb(file: string): Glb {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  let o = 12, json: any = null, bin: Buffer | null = null;
  while (o + 8 <= b.length) {
    const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4), body = b.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString("utf8"));
    else if (type === 0x004e4942) bin = Buffer.from(body);
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error(`${file}: GLB without JSON or BIN chunk`);
  return { json, bin };
}
function writeGlb(file: string, g: Glb): void {
  const pad = (buf: Buffer, fill: number) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, fill)]);
  const js = pad(Buffer.from(JSON.stringify(g.json), "utf8"), 0x20), bn = pad(g.bin, 0);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bn.length, 8);
  jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(bn.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([head, jh, js, bh, bn]));
}
/** v -> 1 - v on every primitive's TEXCOORD_0 (float accessors only). Returns the number of UVs flipped. */
export function flipGlbV(file: string): number {
  const g = readGlb(file), done = new Set<number>();
  let n = 0;
  for (const mesh of g.json.meshes ?? [])
    for (const p of mesh.primitives ?? []) {
      const ai = p.attributes?.TEXCOORD_0;
      if (ai == null || done.has(ai)) continue;
      done.add(ai);
      const a = g.json.accessors[ai];
      if (a.componentType !== 5126 || a.type !== "VEC2" || a.bufferView == null) throw new Error(`${file}: TEXCOORD_0 accessor ${ai} is not float VEC2`);
      const v = g.json.bufferViews[a.bufferView];
      if ((v.buffer ?? 0) !== 0) throw new Error(`${file}: UVs outside the GLB's BIN chunk`);
      const stride = v.byteStride ?? 8, base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
      for (let k = 0; k < a.count; k++) { const o = base + k * stride + 4; g.bin.writeFloatLE(1 - g.bin.readFloatLE(o), o); n++; }
      if (Array.isArray(a.min) && Array.isArray(a.max)) { const lo = a.min[1], hi = a.max[1]; a.min[1] = 1 - hi; a.max[1] = 1 - lo; }
    }
  writeGlb(file, g);
  return n;
}

// ------------------------------------------------------------------ CLI ----
function cli(argv: string[]): number {
  const [cmd, project] = argv;
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (!cmd || !project || !["check", "undo"].includes(cmd)) {
    console.error("usage: flat-art.mts check <project> [--scene id] [--no-prefabs] [--json] [--out f] [--fix [--inverse f]] | undo <project> --inverse f");
    return 2;
  }
  const root = path.join(PROJECTS, project);
  if (cmd === "undo") {
    const inv = readJson(opt("--inverse")!);
    for (const r of inv.restored ?? []) { fs.copyFileSync(r.backup, r.file); console.log(`restored ${r.file}`); }
    return 0;
  }
  const rows = checkProject(project, { scene: opt("--scene"), prefabs: !argv.includes("--no-prefabs") });
  if (argv.includes("--fix")) {
    const own = path.resolve(root, "assets", "models");
    const files = [...new Set(rows.filter((r) => r.status === "flipped").map((r) => r.file))];
    const restored: { file: string; backup: string }[] = [];
    const sweep = path.join(root, "authoring", "sweeps", "flat-art");
    for (const f of files) {
      if (!path.resolve(f).startsWith(own)) { console.log(`skip ${f}: not this project's own model (fix it in its owner)`); continue; }
      // an entity of this GLB upright elsewhere means the GLB is right and that entity is turned over: never flip then
      if (rows.some((r) => r.file === f && r.status === "upright")) { console.log(`skip ${f}: also upright on another entity`); continue; }
      fs.mkdirSync(sweep, { recursive: true });
      const backup = path.join(sweep, path.relative(own, f).replace(/[\\/]/g, "__") + ".orig.glb");
      if (!fs.existsSync(backup)) fs.copyFileSync(f, backup);
      const n = flipGlbV(f);
      restored.push({ file: f, backup });
      console.log(`flipped v on ${n} UVs: ${path.relative(PROJECTS, f)}`);
    }
    if (restored.length) {
      const invFile = opt("--inverse") ?? path.join(sweep, `inverse-${Date.now()}.json`);
      fs.writeFileSync(invFile, JSON.stringify({ tool: "flat-art", project, restored }, null, 1) + "\n");
      console.log(`inverse: ${invFile}`);
    }
    clearGltfCache();
    skinCache.clear();
    const after = checkProject(project, { scene: opt("--scene"), prefabs: !argv.includes("--no-prefabs") });
    return report(after, argv, opt("--out"));
  }
  return report(rows, argv, opt("--out"));
  function report(rs: FlatArtRow[], a: string[], out?: string): number {
    const b = rs.filter((r) => r.status === "flipped" || r.status === "mirrored");
    const rep = { tool: "flat-art", project, ok: b.length === 0, passed: b.length === 0, slabs: rs.filter((r) => !SKIP.includes(r.status)).length, faults: b.length,
      failures: b.map((r) => ({ check: r.status, what: `${r.where} ${r.entity}: ${r.model} with ${r.material} (${r.texture}) is ${r.status} (${Math.round(100 * (r.status === "flipped" ? r.flippedShare : r.mirroredShare))}% of ${r.area} m2)` })),
      rows: rs.map(({ file, ...r }) => r) };
    if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1) + "\n"); }
    if (a.includes("--json")) console.log(JSON.stringify(rep, null, 1));
    else {
      console.log(`flat-art ${project}: ${rs.filter((r) => !SKIP.includes(r.status)).length} slab(s), ${rs.filter((r) => SKIP.includes(r.status)).length} unwrapped/tiling model(s) not judged (--all lists them), ${b.length} fault(s)`);
      for (const r of rs) if (!SKIP.includes(r.status) || a.includes("--all")) console.log(`  ${r.status.padEnd(8)} ${r.where} ${r.entity}  ${r.model}  ${r.material}  rows-up ${Math.round(100 * r.flippedShare)}%  mirrored ${Math.round(100 * r.mirroredShare)}%  slab ${Math.round(100 * r.slabShare)}%  overlap ${Math.round(100 * r.overlap)}%  cover ${Math.round(100 * r.cover)}%`);
    }
    return b.length ? 1 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = cli(process.argv.slice(2));
