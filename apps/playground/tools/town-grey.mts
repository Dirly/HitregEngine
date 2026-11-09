/**
 * town-grey — no DEFAULT GREY stone in a palette town (Derek 2026-10-31 on Bell Strand: "I also noticed some rock /
 * stonework choices were still the grey"; 2026-10-02 on Ledgecroft: "You can legit make any texture don't default to
 * grey"). Memory art-style-consistency: a role the region has no texture for is GENERATED, never left grey.
 *
 *   npx tsx tools/town-grey.mts --project <p> --town <town> [--scene <id>] [--world <id>] [--json <out>]
 *
 * What it reads (every piece the town owns, tag `town:<town>`):
 * - PREFABS: each triangle's base-colour texels where its UVs actually land (the same sampling as the blank-uv check:
 *   material maps flipY, glTF pages not, town-atlas tiles rect + fract(uv)), area-weighted. A texel is GREY when it is
 *   opaque, mid-value (luma 55..215) and colourless (max - min channel < GREY_CHROMA). A prefab whose textured area is
 *   more than GREY_SHARE grey, over GREY_MIN_M2, FAILS (grey stone / plaster / untextured default). Glass, dark wood and
 *   iron read as dark or tinted and pass; red rubble and lime render are far from colourless.
 * - SURFACE meshes (foundation skirts, placement-solver boxes): their material's whole map, same rule.
 * - The world's TERRACE WALLS whose id names the town: a grey masonry style (masonry-common) FAILS; the town's stone
 *   comes from its buildings' kit style (worldgen-terrace-walls townWallStyle: masonry-strand for Redstrand).
 * Exits 1 on any fault. Fix by construction: a strand-props re-skin (`props variant`), the region palette denying the
 * grey original, or a generated tile; never by hiding the piece.
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECTS } from "./_closure.mjs";
import { gltfTris, locate, prefabGeometry, readJson, trs, type PixelPage, type PropGeometry, type Tri } from "./_prop-geometry.mts";
import { texPixels } from "./_prop-blank-uv.mts";
import { decodePng } from "./_png.mjs";

export const GREY_CHROMA = 16;
export const GREY_SHARE = 0.25;
export const GREY_MIN_M2 = 2;   // iron fittings (an anvil, barrel hoops) are small; grey STONE is not
/** Masonry styles that are the kit's generic grey (never for a town with a palette of its own). */
export const GREY_MASONRY = new Set(["masonry-common", "common"]);

/** Grey stone: colourless mid-value, or the COLD blue-grey of the kit's slate/granite (blue the strongest channel, weakly
 *  saturated) -- the tree ring's blue-grey courses read as "the grey" on the live square (k-town3). */
export function isGrey(r: number, g: number, b: number): boolean {
  const l = 0.299 * r + 0.587 * g + 0.114 * b, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (l < 40 || l > 215) return false;
  if (l >= 55 && mx - mn < GREY_CHROMA) return true;
  return b >= r && b >= g && mx > 0 && (mx - mn) / mx < 0.4;
}
const triArea = (t: { a: number[]; b: number[]; c: number[] }) => {
  const u = [t.b[0]! - t.a[0]!, t.b[1]! - t.a[1]!, t.b[2]! - t.a[2]!], v = [t.c[0]! - t.a[0]!, t.c[1]! - t.a[1]!, t.c[2]! - t.a[2]!];
  return Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
};

/** Grey share of a prefab's textured area, sampled where its UVs land. */
export function greyOfGeometry(geo: PropGeometry, pixels: (t: any) => PixelPage | null = texPixels): { area: number; grey: number; share: number } {
  let area = 0, grey = 0;
  for (const t of geo.tris) {
    if (!t.tex || !t.uv) continue;
    const A = triArea(t);
    if (!(A > 1e-9)) continue;
    const img = pixels(t.tex);
    if (!img) continue;
    const [rx, ry] = t.tex.repeat;
    let n = 0, g = 0;
    for (const [s, r] of [[1 / 3, 1 / 3], [1 / 6, 1 / 6], [2 / 3, 1 / 6], [1 / 6, 2 / 3]] as const) {
      let fu: number, fv: number;
      if (t.atlas) {
        const a = t.atlas.uv, [x0, y0, w, h] = t.atlas.rect;
        const au = a[0]![0] * (1 - s - r) + a[1]![0] * s + a[2]![0] * r, av = a[0]![1] * (1 - s - r) + a[1]![1] * s + a[2]![1] * r;
        fu = x0 + (au - Math.floor(au)) * w; fv = y0 + (av - Math.floor(av)) * h;
      } else {
        const u = (t.uv[0]![0] * (1 - s - r) + t.uv[1]![0] * s + t.uv[2]![0] * r) * rx, v = (t.uv[0]![1] * (1 - s - r) + t.uv[1]![1] * s + t.uv[2]![1] * r) * ry;
        fu = u - Math.floor(u); fv = v - Math.floor(v);
      }
      const x = Math.min(img.width - 1, Math.floor(fu * img.width)), y = Math.min(img.height - 1, Math.floor((t.tex.flipY ? 1 - fv : fv) * img.height));
      const i = (y * img.width + x) * 4, d = img.data;
      if (d[i + 3]! < 128) continue;
      n++; if (isGrey(d[i]!, d[i + 1]!, d[i + 2]!)) g++;
    }
    if (!n) continue;
    area += A; grey += (A * g) / n;
  }
  return { area, grey, share: area > 0 ? grey / area : 0 };
}

/** Grey share of a whole texture file (a surface mesh's material map). */
export function greyOfImage(file: string): number {
  const img = decodePng(fs.readFileSync(file)) as { width: number; height: number; data: Uint8Array };
  let n = 0, g = 0;
  for (let i = 0; i < img.data.length; i += 4) { if (img.data[i + 3]! < 128) continue; n++; if (isGrey(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!)) g++; }
  return n ? g / n : 0;
}

export interface GreyRow { id: string; piece: string; area: number; share: number; fault?: string }
export function townGrey(project: string, town: string, sceneId?: string, worldId?: string): { rows: GreyRow[]; faults: GreyRow[] } {
  const assets = path.join(PROJECTS, project, "assets");
  const scene = readJson(path.join(assets, "scenes", `${sceneId ?? project}.scene.json`));
  const tag = `town:${town}`;
  const rows: GreyRow[] = [];
  const geoCache = new Map<string, { area: number; grey: number; share: number }>();
  for (const [id, e] of Object.entries<any>(scene.entities)) {
    if (!(e.tags ?? []).includes(tag)) continue;
    const pid = e.components?.prefab?.prefabId as string | undefined;
    if (pid) {
      let r = geoCache.get(pid);
      if (!r) { r = greyOfGeometry(prefabGeometry(assets, pid)); geoCache.set(pid, r); }
      const row: GreyRow = { id, piece: pid, area: +r.area.toFixed(2), share: +r.share.toFixed(3) };
      if (r.share > GREY_SHARE && r.grey > GREY_MIN_M2) row.fault = `${Math.round(r.share * 100)}% of its textured area (${r.grey.toFixed(1)} m2) is default GREY`;
      rows.push(row);
    } else if (e.components?.mesh?.material) {
      const mat = String(e.components.mesh.material);
      const mf = locate(assets, "materials", `${mat}.json`);
      const map = fs.existsSync(mf) ? readJson(mf).map : undefined;
      const tf = map ? locate(assets, "textures", map) : null;
      const share = tf && fs.existsSync(tf) && tf.endsWith(".png") ? greyOfImage(tf) : 1;
      const row: GreyRow = { id, piece: `material ${mat}`, area: 0, share: +share.toFixed(3) };
      if (!map) row.fault = `surface material ${mat} has no texture map (untextured default)`;
      else if (share > GREY_SHARE) row.fault = `surface material ${mat}: ${Math.round(share * 100)}% of its map is default GREY`;
      rows.push(row);
    }
  }
  // terrace walls of the town (world recipe)
  const wf = path.join(assets, "worlds", `${worldId ?? project}.json`);
  if (fs.existsSync(wf)) {
    const w = readJson(wf);
    for (const t of w.features?.terraceWalls ?? w.terraceWalls ?? []) {
      if (!String(t.id ?? "").includes(town)) continue;
      const style = String(t.style ?? t.masonry ?? "masonry-common");
      const row: GreyRow = { id: String(t.id), piece: `terrace wall (${style})`, area: 0, share: GREY_MASONRY.has(style) ? 1 : 0 };
      if (GREY_MASONRY.has(style)) row.fault = `terrace wall masonry '${style}' is the kit's generic grey: re-cut with \`worldgen terrace --from-plan\` (townWallStyle picks the town's masonry)`;
      rows.push(row);
    }
  }
  return { rows, faults: rows.filter((r) => r.fault) };
}


/**
 * ROOF RIM (k-town3, Derek 2026-10-31: "I don't like how the roofs end with the white rim"): a kit building's roof must
 * end in its roof or trim tile. Fails a model whose UP-facing faces above the ground storey (y > RIM_MIN_Y) sample a
 * PALE tile (mean luma > RIM_LUMA: the lime render) over more than RIM_MAX_M2 -- the party parapets' render copings
 * were 3-8 m2 a row house. Run on every exported strand-town GLB:  town-grey.mts roof-rim <glb...>
 */
/** Does a ray straight up (+y) from o cross triangle q (barycentric test in the xz plane, above o)? */
function upHit(o: number[], q: Tri): boolean {
  const [a, b, c] = [q.a, q.b, q.c];
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(d) < 1e-12) return false;
  const l1 = ((b[2] - c[2]) * (o[0]! - c[0]) + (c[0] - b[0]) * (o[2]! - c[2])) / d, l2 = ((c[2] - a[2]) * (o[0]! - c[0]) + (a[0] - c[0]) * (o[2]! - c[2])) / d, l3 = 1 - l1 - l2;
  if (l1 < 0 || l2 < 0 || l3 < 0) return false;
  return l1 * a[1] + l2 * b[1] + l3 * c[1] > o[1]!;
}
export const RIM_MIN_Y = 2.5, RIM_LUMA = 170, RIM_MAX_M2 = 0.5;
export function roofRim(file: string): { pale: number; worst: [number, number, number] | null } {
  const tris: Tri[] = []; gltfTris(file, trs(), undefined, tris);
  let pale = 0, worst: [number, number, number] | null = null, wa = 0;
  for (const t of tris) {
    if (!t.tex || !t.uv) continue;
    const e1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], e2 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!], L = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (!(L > 1e-9) || n[1]! / L < 0.3 || Math.min(t.a[1], t.b[1], t.c[1]) < RIM_MIN_Y) continue;
    const img = texPixels(t.tex); if (!img) continue;
    let fu: number, fv: number;
    if (t.atlas) { const a = t.atlas.uv, [x0, y0, w, h] = t.atlas.rect; const au = (a[0]![0] + a[1]![0] + a[2]![0]) / 3, av = (a[0]![1] + a[1]![1] + a[2]![1]) / 3; fu = x0 + (au - Math.floor(au)) * w; fv = y0 + (av - Math.floor(av)) * h; }
    else { const u = (t.uv[0]![0] + t.uv[1]![0] + t.uv[2]![0]) / 3, v = (t.uv[0]![1] + t.uv[1]![1] + t.uv[2]![1]) / 3; fu = u - Math.floor(u); fv = v - Math.floor(v); }
    // the tile's MEAN around the sample (5x5 texels): a pale tile, not one pale texel of a dark one
    const cx = Math.floor(fu * img.width), cy = Math.floor((t.tex.flipY ? 1 - fv : fv) * img.height); let sum = 0, k = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const x = Math.min(img.width - 1, Math.max(0, cx + dx)), y = Math.min(img.height - 1, Math.max(0, cy + dy)), i = (y * img.width + x) * 4; sum += 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!; k++; }
    if (sum / k <= RIM_LUMA) continue;
    // open to the SKY only (an attic floor or a ceiling's top is inside, under the roof): a ray straight up hits nothing
    const o = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3 + 0.01, (t.a[2] + t.b[2] + t.c[2]) / 3];
    if (tris.some((q) => q !== t && upHit(o, q))) continue;
    pale += L / 2; if (L / 2 > wa) { wa = L / 2; worst = [+(t.a[0]).toFixed(2), +(t.a[1]).toFixed(2), +(t.a[2]).toFixed(2)]; }
  }
  return { pale, worst };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("tools/town-grey.mts");
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv[0] === "roof-rim") {
    let bad = 0;
    for (const f of argv.slice(1)) { const r = roofRim(f); const ok = r.pale <= RIM_MAX_M2; if (!ok) bad++; console.log(`  ${ok ? "ok" : "x "} ${path.basename(f)}: ${r.pale.toFixed(2)} m2 of pale up-facing faces above ${RIM_MIN_Y} m${r.worst ? ` (largest at ${r.worst.join(", ")})` : ""}`); }
    console.log(`ROOF RIM: ${argv.length - 1 - bad}/${argv.length - 1} ok -> ${bad ? "FAILED" : "ok"}`); process.exit(bad ? 1 : 0);
  }
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const project = opt("project"), town = opt("town");
  if (!project || !town) { console.error("usage: town-grey --project <p> --town <town> [--scene <id>] [--world <id>] [--json <out>]"); process.exit(2); }
  const { rows, faults } = townGrey(project, town, opt("scene"), opt("world"));
  const seen = new Set<string>();
  for (const r of faults) { const k = r.piece; if (seen.has(k)) continue; seen.add(k); console.log(`  x ${r.piece}: ${r.fault} (e.g. ${r.id}; ${faults.filter((f) => f.piece === k).length} placed)`); }
  if (opt("json")) fs.writeFileSync(opt("json")!, JSON.stringify({ ok: !faults.length, rows, faults }, null, 1) + "\n");
  console.log(`TOWN GREY ${town}: ${rows.length} pieces read, ${faults.length} grey -> ${faults.length ? "FAILED" : "ok"}`);
  process.exit(faults.length ? 1 : 0);
}
