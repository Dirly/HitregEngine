/**
 * prop-retexture — give purchased-pack props a PROPER unwrap and new painted surfaces at the town texel standard,
 * as NEW catalogued props (the old rows get `supersededBy`). Derek 2026-10-30 (Reeve's house): "re-texture the
 * chairs, tables etc. to get more details (so use a proper unwrapping and stuff)". The pack's own UVs stack and
 * stretch a 128 px picture over a whole piece; no repaint of that layout reads as grain or joinery.
 *
 *   npx tsx tools/prop-retexture.mts --project world-kit --recipe authoring/house-furniture/recipe.json [--only a,b] [--dry]
 *
 * Per prop, from its prefab's triangles in the root frame (nested wraps and their pose included):
 *   1. unwrap: triangles are grouped into charts by dominant axis + edge adjacency (box projection), each chart laid
 *      out at exactly `texelsPerMetre` (no stacking, no mirroring onto shared texels), shelf-packed with a gutter
 *      onto ONE page shared by the whole collection (one material, one texture: every repeat still batches);
 *   2. paint: every texel is classified from the pack's own colour at that point (wood / grey / other, as
 *      `props reskin-plan` does) and drawn from the recipe's painted material tiles (Codex PSX tiles: wood boards with
 *      grain and pegs, forged iron, linen, wool pile, burlap) projected in metres, the grain run along each part's
 *      long side, each part keeping the pack's tone; cloth and rugs keep their own colours and pattern with the
 *      tile's weave over them; a one-texel dark rim on every chart edge carries the joinery/bevel;
 *   3. emit: <collection>/<name>.glb, the page + material, a prefab (root dressing copied from the source's, the
 *      source's collider kind), catalogue rows with provenance, the dressing sidecar, registration in
 *      authoring/prop-catalogs.json, and `supersededBy` on every source row (any catalogue that lists it).
 * Re-running overwrites every output in place (no backups: git is the history).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { prefabGeometry, prefabFile, readJson, locate, type Tri, type V3 } from "./_prop-geometry.mts";
import { decodePng, encodePng } from "./_png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const PROJECT = path.resolve(HERE, "..", "projects", opt("project") ?? "world-kit");
const ASSETS = path.join(PROJECT, "assets");
const recipeFile = path.resolve(PROJECT, opt("recipe") ?? "authoring/house-furniture/recipe.json");
const dry = argv.includes("--dry");
const only = opt("only")?.split(",");

interface PropSpec { from: string; name: string; /** grey texels: iron (default) or stone */ grey?: string; /** other (coloured) texels: linen (default), wool, keep */ other?: string; /** one tile for the whole prop, tinted by its colours */ all?: string; /** every texel counts as this class (a rug or quilt whose reds the wood test would take) */ force?: "wood" | "grey" | "other"; /** uniform scale to the real size of its kind (a pack bed 2.85 m long): mesh, declared size and sockets */ scale?: number; note?: string }
interface Recipe { collection: string; texelsPerMetre: number; tileMetres: number; gutter?: number; tiles: Record<string, string>; props: PropSpec[]; about?: string }
const recipe: Recipe = readJson(recipeFile);
const T = recipe.texelsPerMetre, COLL = recipe.collection, GUT = recipe.gutter ?? 2;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(typeof b === "string" ? fs.readFileSync(b) : b).digest("hex");
const write = (f: string, x: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof x === "string" || Buffer.isBuffer(x) ? (x as any) : JSON.stringify(x, null, 2) + "\n"); };

// ---------------------------------------------------------------- pixels ----
interface Img { width: number; height: number; data: Uint8Array }
const imgCache = new Map<string, Img | null>();
function pixelsOf(t: Tri["tex"]): Img | null {
  if (!t) return null;
  const k = t.file ?? t.key;
  if (!imgCache.has(k)) {
    let img: Img | null = null;
    try { const b = t.file ? fs.readFileSync(t.file) : t.bytes; if (b && b[0] === 0x89) img = decodePng(b); } catch { img = null; }
    imgCache.set(k, img);
  }
  return imgCache.get(k)!;
}
const tiles: Record<string, { img: Img; mean: number }> = {};
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
for (const [role, rel] of Object.entries(recipe.tiles)) {
  const img = decodePng(fs.readFileSync(locate(ASSETS, "textures", rel)));
  let s = 0; for (let i = 0; i < img.data.length; i += 4) s += lum(img.data[i], img.data[i + 1], img.data[i + 2]);
  tiles[role] = { img, mean: s / (img.width * img.height) };
}
function tileAt(role: string, s: number, t: number): [number, number, number] {
  const { img } = tiles[role], px = img.width / recipe.tileMetres;
  const x = ((Math.floor(s * px) % img.width) + img.width) % img.width, y = ((Math.floor(t * px) % img.height) + img.height) % img.height;
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
/** wood / grey / other, as props reskin-plan's materialMix reads a texel. */
function classOf(r: number, g: number, b: number): "wood" | "grey" | "other" {
  const R = r / 255, G = g / 255, B = b / 255, mx = Math.max(R, G, B), mn = Math.min(R, G, B), sat = mx ? (mx - mn) / mx : 0;
  let hue = 0;
  if (mx !== mn) hue = mx === R ? 60 * (((G - B) / (mx - mn)) % 6) : mx === G ? 60 * ((B - R) / (mx - mn) + 2) : 60 * ((R - G) / (mx - mn) + 4);
  if (hue < 0) hue += 360;
  if (sat < 0.22 || mx < 0.1) return "grey";
  // reds under 16 degrees are cloth (quilts, rugs), not wood; reskin-plan's 8 lets brick-red quilts read as wood
  if (hue >= 16 && hue <= 50 && sat >= 0.3 && mx <= 0.9) return "wood";
  return "other";
}

// ---------------------------------------------------------------- charts ----
interface Chart { prop: number; tris: Tri[]; axis: number; sign: number; s0: number; s1: number; t0: number; t1: number; w: number; h: number; x: number; y: number; swap: boolean; seed: number }
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function project(p: V3, axis: number, sign: number): [number, number] {
  if (axis === 0) return [sign > 0 ? -p[2] : p[2], p[1]];
  if (axis === 1) return [p[0], sign > 0 ? -p[2] : p[2]];
  return [sign > 0 ? p[0] : -p[0], p[1]];
}
function chartsOf(tris: Tri[], prop: number): Chart[] {
  const key = (p: V3) => p.map((v) => Math.round(v * 1e4)).join(",");
  const faces = tris.map((t) => {
    const n = cross(sub(t.b, t.a), sub(t.c, t.a)), ax = [0, 1, 2].reduce((m, i) => (Math.abs(n[i]) > Math.abs(n[m]) ? i : m), 0);
    return { t, axis: ax, sign: Math.sign(n[ax]) || 1, area: Math.hypot(...n) / 2 };
  }).filter((f) => f.area > 1e-9);
  const parent = faces.map((_, i) => i), find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edges = new Map<string, number>();
  faces.forEach((f, i) => {
    const v = [f.t.a, f.t.b, f.t.c].map(key);
    for (let k = 0; k < 3; k++) {
      const e = [v[k], v[(k + 1) % 3]].sort().join("|") + `#${f.axis}${f.sign}`;
      const j = edges.get(e);
      if (j === undefined) edges.set(e, i); else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, number[]>();
  faces.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const out: Chart[] = [];
  for (const idx of groups.values()) {
    const f0 = faces[idx[0]], ct = idx.map((i) => faces[i].t);
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const t of ct) for (const p of [t.a, t.b, t.c]) { const [s, u] = project(p, f0.axis, f0.sign); s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, u); t1 = Math.max(t1, u); }
    out.push({ prop, tris: ct, axis: f0.axis, sign: f0.sign, s0, s1, t0, t1, w: Math.max(1, Math.ceil((s1 - s0) * T)), h: Math.max(1, Math.ceil((t1 - t0) * T)), x: 0, y: 0, swap: t1 - t0 > (s1 - s0) * 1.15, seed: out.length * 7919 + prop * 104729 });
  }
  return out;
}
/** Shelf-pack charts (+ gutter) onto the smallest square page (multiple of 64) they fit. */
function pack(charts: Chart[]): number {
  const sorted = [...charts].sort((a, b) => b.h - a.h || b.w - a.w);
  const area = sorted.reduce((t, c) => t + (c.w + 2 * GUT) * (c.h + 2 * GUT), 0);
  for (let P = Math.max(64, Math.ceil(Math.sqrt(area) / 64) * 64); ; P += 64) {
    let x = 0, y = 0, row = 0, ok = true;
    for (const c of sorted) {
      const w = c.w + 2 * GUT, h = c.h + 2 * GUT;
      if (w > P) { ok = false; break; }
      if (x + w > P) { y += row; x = 0; row = 0; }
      if (y + h > P) { ok = false; break; }
      c.x = x + GUT; c.y = y + GUT; x += w; row = Math.max(row, h);
    }
    if (ok) return P;
  }
}

// ----------------------------------------------------------------- paint ----
/** Tiles that only add their weave over the pack's own colours (cloth); the rest replace the colour with painted material. */
const WEAVE = new Set(["linen", "wool", "burlap", "keep"]);
/** How much of the weave tile's light/dark goes over the pack colour (a rug's pattern must still read through its pile). */
const WEAVE_STRENGTH: Record<string, number> = { linen: 0.55, wool: 0.3, burlap: 0.75 };
interface Px { s: number; t: number; rgb: [number, number, number] | null; cls: "wood" | "grey" | "other" }
function paint(charts: Chart[], specs: PropSpec[], P: number): Uint8Array {
  const page = new Uint8Array(P * P * 4), owner = new Int32Array(P * P).fill(-1);
  charts.forEach((c, ci) => {
    const spec = specs[c.prop];
    const px = new Map<number, Px>();
    for (const t of c.tris) {
      const img = pixelsOf(t.tex);
      const q = [t.a, t.b, t.c].map((p) => { const [s, u] = project(p, c.axis, c.sign); return [c.x + (s - c.s0) * T, c.y + (c.t1 - u) * T]; });
      const d = (q[1][1] - q[2][1]) * (q[0][0] - q[2][0]) + (q[2][0] - q[1][0]) * (q[0][1] - q[2][1]);
      if (Math.abs(d) < 1e-12) continue;
      const x0 = Math.max(c.x, Math.floor(Math.min(q[0][0], q[1][0], q[2][0]))), x1 = Math.min(c.x + c.w - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
      const y0 = Math.max(c.y, Math.floor(Math.min(q[0][1], q[1][1], q[2][1]))), y1 = Math.min(c.y + c.h - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const X = x + 0.5, Y = y + 0.5;
        const l0 = ((q[1][1] - q[2][1]) * (X - q[2][0]) + (q[2][0] - q[1][0]) * (Y - q[2][1])) / d;
        const l1 = ((q[2][1] - q[0][1]) * (X - q[2][0]) + (q[0][0] - q[2][0]) * (Y - q[2][1])) / d, l2 = 1 - l0 - l1;
        if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
        const s = c.s0 + (X - c.x) / T, u = c.t1 - (Y - c.y) / T;
        let rgb: [number, number, number] | null = null;
        if (img && t.uv) {
          const U = t.uv[0][0] * l0 + t.uv[1][0] * l1 + t.uv[2][0] * l2, V = t.uv[0][1] * l0 + t.uv[1][1] * l1 + t.uv[2][1] * l2;
          const fu = U - Math.floor(U), fv = V - Math.floor(V);
          const ix = Math.min(img.width - 1, Math.floor(fu * img.width)), iy = Math.min(img.height - 1, Math.floor((t.tex!.flipY ? 1 - fv : fv) * img.height));
          const i = (iy * img.width + ix) * 4; rgb = [img.data[i], img.data[i + 1], img.data[i + 2]];
        }
        px.set(y * P + x, { s, t: u, rgb, cls: spec.force ?? (rgb ? classOf(...rgb) : "wood") });
      }
    }
    // the pack's tone per class across this part
    const sum: Record<string, [number, number, number, number]> = {};
    for (const p of px.values()) if (p.rgb) { const a = (sum[p.cls] ??= [0, 0, 0, 0]); a[0] += p.rgb[0]; a[1] += p.rgb[1]; a[2] += p.rgb[2]; a[3]++; }
    const mean = (k: string): [number, number, number] | null => (sum[k]?.[3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : null);
    const allMean = (() => { let r = 0, g = 0, b = 0, n = 0; for (const k in sum) { r += sum[k][0]; g += sum[k][1]; b += sum[k][2]; n += sum[k][3]; } return n ? [r / n, g / n, b / n] as [number, number, number] : null; })();
    const off = [(c.seed % 97) / 97 * recipe.tileMetres, (c.seed % 61) / 61 * recipe.tileMetres];
    for (const [i, p] of px) {
      const [ss, tt] = c.swap ? [p.t, p.s] : [p.s, p.t];
      const S = ss + off[0], U = tt + off[1];
      let out: [number, number, number];
      if (spec.all) {
        const tc = tileAt(spec.all, S, U), k = lum(...tc) / tiles[spec.all].mean, m = allMean ?? [128, 110, 90];
        out = [m[0] * k, m[1] * k, m[2] * k];
      } else if (WEAVE.has(p.cls === "other" ? spec.other ?? "linen" : p.cls === "grey" ? spec.grey ?? "iron" : "wood")) {
        const role = p.cls === "other" ? spec.other ?? "linen" : spec.grey!, base = p.rgb ?? [128, 110, 90];
        const w = WEAVE_STRENGTH[role] ?? 0.5, k = role === "keep" ? 1 : 1 - w + w * (lum(...tileAt(role, S, U)) / tiles[role].mean);
        out = [base[0] * k, base[1] * k, base[2] * k];
      } else {
        const role = p.cls === "grey" ? spec.grey ?? "iron" : "wood", m = mean(p.cls) ?? mean("wood"), tc = tileAt(role, S, U);
        const k = m ? Math.min(1.35, Math.max(0.7, lum(...m) / tiles[role].mean)) : 1;
        out = [tc[0] * k, tc[1] * k, tc[2] * k];
      }
      // joinery / bevel: a dark rim on the part's edge
      const x = i % P, y = (i - x) / P;
      if (!px.has(i - 1) || !px.has(i + 1) || !px.has(i - P) || !px.has(i + P)) out = [out[0] * 0.62, out[1] * 0.62, out[2] * 0.62];
      page.set([Math.round(Math.min(255, out[0])), Math.round(Math.min(255, out[1])), Math.round(Math.min(255, out[2])), 255], i * 4);
      owner[i] = ci;
    }
  });
  // gutter: spread each part's edge texels outward (nearest filtering never samples another part)
  for (let pass = 0; pass < GUT; pass++) {
    const add: [number, number][] = [];
    for (let i = 0; i < P * P; i++) {
      if (owner[i] >= 0) continue;
      const x = i % P;
      for (const j of [x > 0 ? i - 1 : -1, x < P - 1 ? i + 1 : -1, i - P, i + P]) if (j >= 0 && j < P * P && owner[j] >= 0) { add.push([i, j]); break; }
    }
    for (const [i, j] of add) { page.copyWithin(i * 4, j * 4, j * 4 + 4); owner[i] = owner[j]; }
  }
  return page;
}

// ------------------------------------------------------------------ glb ----
function glb(charts: Chart[], P: number, name: string): Buffer {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  for (const c of charts) for (const t of c.tris) {
    const n = cross(sub(t.b, t.a), sub(t.c, t.a)), l = Math.hypot(...n) || 1;
    for (const p of [t.a, t.b, t.c]) {
      const [s, u] = project(p, c.axis, c.sign);
      pos.push(...p); nor.push(n[0] / l, n[1] / l, n[2] / l);
      // the material's map loads flipped (TextureLoader): row = (1 - v) * P
      uv.push((c.x + (s - c.s0) * T) / P, 1 - (c.y + (c.t1 - u) * T) / P);
    }
  }
  const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
  const bufs = [f32(pos), f32(nor), f32(uv)];
  const bin = Buffer.concat(bufs), n = pos.length / 3;
  const mn = [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k))), mx = [0, 1, 2].map((k) => Math.max(...pos.filter((_, i) => i % 3 === k)));
  let off = 0;
  const views = bufs.map((b) => { const v = { buffer: 0, byteOffset: off, byteLength: b.length }; off += b.length; return v; });
  const json = {
    asset: { version: "2.0", generator: "hitreg tools/prop-retexture.mts" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0, mode: 4 }] }],
    materials: [{ name: `${COLL}/atlas`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: "VEC3", min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: n, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: n, type: "VEC2" },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const binP = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + binP.length, 8);
  const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(binP.length, 0x004e4942), binP]);
}

// ------------------------------------------------------------------ main ----
const specs = recipe.props.filter((p) => !only || only.includes(p.name));
const geos = specs.map((s) => {
  const g = prefabGeometry(ASSETS, s.from);
  const k = s.scale ?? 1;
  if (k !== 1) for (const t of g.tris) for (const p of [t.a, t.b, t.c]) { p[0] *= k; p[1] *= k; p[2] *= k; }
  if (!g.tris.length) throw Error(`${s.from}: no triangles (${g.warnings.join("; ")})`);
  if (g.effects.length || g.lights) console.warn(`${s.from}: carries effects/lights (${g.effects.join(",")}); only its mesh is retextured`);
  return g;
});
const charts = geos.flatMap((g, i) => chartsOf(g.tris, i));
const P = pack(charts);
console.log(`${specs.length} props, ${charts.length} charts, page ${P}x${P} at ${T} texels/m (gutter ${GUT})`);
if (dry) process.exit(0);
const page = paint(charts, specs, P);
const pageRel = `${COLL}/atlas.png`, pageFile = path.join(ASSETS, "textures", pageRel);
write(pageFile, encodePng(P, P, page));
const matFile = path.join(ASSETS, "materials", `${COLL}/atlas.json`);
write(matFile, { shader: "standard", color: "#ffffff", map: pageRel, filter: "nearest", roughness: 1, side: "double", metalness: 0 });

const catFile = path.join(PROJECT, "authoring", COLL, "catalog.json"), sideFile = path.join(PROJECT, "authoring", COLL, "dressing.json");
const cat = fs.existsSync(catFile) ? readJson(catFile) : { version: 1, props: [], assets: [] };
const side = fs.existsSync(sideFile) ? readJson(sideFile) : { version: 1, collection: `authoring/${COLL}/catalog.json#props`, about: "Dressing declarations (compiled onto prefab roots by `props sync`).", props: {} };
const registry = readJson(path.join(PROJECT, "authoring/prop-catalogs.json"));
const supersede: [string, string][] = [];
specs.forEach((s, i) => {
  const id = `${COLL}/${s.name}`, mine = charts.filter((c) => c.prop === i);
  const modelRel = `${COLL}/${s.name}.glb`, modelFile = path.join(ASSETS, "models", modelRel), bytes = glb(mine, P, s.name);
  write(modelFile, bytes);
  const src = readJson(prefabFile(ASSETS, s.from)), root = src.entities[src.root];
  const scaleDecl = (d: any) => { const k = s.scale ?? 1; if (k === 1 || !d) return d; d.size = d.size?.map((v: number) => +(v * k).toFixed(3)); for (const p of d.provides ?? []) { p.position = p.position.map((v: number) => +(v * k).toFixed(3)); if (p.size) p.size = p.size.map((v: number) => +(v * k).toFixed(3)); if (p.clearHeight) p.clearHeight = +(p.clearHeight * k).toFixed(3); } return d; };
  const decl = scaleDecl(structuredClone(root.components?.dressing ?? {}));
  const collider = Object.values<any>(src.entities).map((e) => e.components?.collider).find(Boolean);
  const prefab = {
    version: 1, name: s.name, root: "root",
    entities: {
      root: { name: s.name, parent: null, tags: [COLL, "prop-retexture"], components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, dressing: decl } },
      art: { name: `${s.name} mesh`, parent: "root", tags: [], components: {
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh: { source: { kind: "asset", assetId: modelRel }, material: `${COLL}/atlas`, castShadow: true, receiveShadow: true, renderMode: "auto", lod: true, moving: false, static: false },
        ...(collider ? { collider: { ...collider, shape: collider.shape === "box" ? "box" : "trimesh" } } : {}),
      } },
    },
  };
  const pf = path.join(ASSETS, "prefabs", `${id}.json`);
  write(pf, prefab);
  let area = 0, texels = 0;
  for (const c of mine) for (const t of c.tris) area += Math.hypot(...cross(sub(t.b, t.a), sub(t.c, t.a))) / 2;
  for (const c of mine) texels += c.w * c.h;
  const row = {
    id, status: "provisional", role: "retexture", retextureOf: s.from, supersedes: s.from,
    model: `assets/models/${modelRel}`, material: `${COLL}/atlas`, texture: `assets/textures/${pageRel}`, sampling: "nearest",
    size: decl.size, category: decl.category,
    source: { prefab: s.from, prefabSha256: sha(prefabFile(ASSETS, s.from)), recipe: path.relative(PROJECT, recipeFile).replaceAll("\\", "/"), tool: "apps/playground/tools/prop-retexture.mts" },
    unwrap: { method: "box-projection charts by dominant axis + edge adjacency, packed without overlap or mirroring onto one collection page", charts: mine.length, texelsPerMetre: T, surfaceArea: +area.toFixed(3) },
    paint: { tiles: Object.fromEntries(Object.entries(recipe.tiles).map(([k, v]) => [k, `assets/textures/${v}`])), roles: { wood: "wood", grey: s.grey ?? "iron", other: s.all ?? s.other ?? "linen" }, rim: "one dark texel on every part edge (joinery/bevel)", ...(s.note ? { note: s.note } : {}) }, ...(s.scale ? { scaledFromSource: s.scale } : {}),
    triangles: mine.reduce((t, c) => t + c.tris.length, 0), materials: 1, modelSha256: sha(bytes), sha256: sha(pf),
    behavior: "Static furniture; the source's collider kind.", effects: [], madeBy: "tools/prop-retexture.mts", date: "2026-10-30",
  };
  cat.props = cat.props.filter((r: any) => r.id !== id).concat(row);
  cat.assets = (cat.assets ?? []).filter((a: any) => a.id !== modelRel).concat({ id: modelRel, path: `assets/models/${modelRel}`, sha256: sha(bytes), source: "tools/prop-retexture.mts" });
  const srcDecl = (() => { for (const c of registry.catalogs) if (c.dressing && fs.existsSync(path.join(PROJECT, c.dressing))) { const v = readJson(path.join(PROJECT, c.dressing)).props?.[s.from]; if (v && !v.exempt) return v; } return null; })();
  side.props[id] = srcDecl ? scaleDecl(structuredClone(srcDecl)) : decl;
  supersede.push([s.from, id]);
});
cat.version = 1;
cat.about = recipe.about ?? `Purchased-pack props re-unwrapped and repainted at ${T} texels/m by tools/prop-retexture.mts (recipe authoring/${COLL}/recipe.json); one page, one material.`;
cat.assets = cat.assets.filter((a: any) => a.id !== pageRel).concat({ id: pageRel, path: `assets/textures/${pageRel}`, sha256: sha(pageFile), source: "tools/prop-retexture.mts", size: [P, P] });
write(catFile, cat);
write(sideFile, side);
for (const row of [
  { path: `authoring/${COLL}/catalog.json`, entries: "props", prefabIds: true, dressing: `authoring/${COLL}/dressing.json`, shared: true },
  { path: `authoring/${COLL}/catalog.json`, entries: "assets", pathFields: ["path"], shared: true },
]) if (!registry.catalogs.some((x: any) => x.path === row.path && x.entries === row.entries)) registry.catalogs.push(row);
write(path.join(PROJECT, "authoring/prop-catalogs.json"), registry);
// every catalogue row of a source points at its successor (the menu offers only the new one; old plans keep checking)
for (const c of registry.catalogs) {
  if (!c.prefabIds || c.path.includes(`/${COLL}/`)) continue;
  const f = path.join(PROJECT, c.path);
  if (!fs.existsSync(f)) continue;
  const doc = readJson(f); let hit = false;
  for (const r of doc[c.entries] ?? []) { const s = supersede.find(([from]) => from === r.id); if (s && r.supersededBy !== s[1]) { r.supersededBy = s[1]; hit = true; } }
  if (hit) write(f, doc);
}
console.log(`wrote ${specs.length} props -> ${COLL}/ (page ${pageRel} ${P}px); superseded: ${supersede.map(([a, b]) => `${a} -> ${b}`).join(", ")}`);
