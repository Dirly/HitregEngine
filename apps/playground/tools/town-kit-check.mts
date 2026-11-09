/**
 * town-kit-check — the kit gates of MMO/WFC KIT-RULES 37 (+ 37.1), measured on EXPORTED models (GLB), never on a sheet.
 *
 *   npx tsx tools/town-kit-check.mts seams <model.glb> [more.glb ...] [--allow ExteriorNormal,ExteriorBottom,Stone]
 *   npx tsx tools/town-kit-check.mts smoke <model.glb> [more.glb ...] [--expect N | --markers <model>.markers.json]
 *   npx tsx tools/town-kit-check.mts overlap --layout <town>-layout.json --glb-dir <dir of <lot>.glb>
 *   npx tsx tools/town-kit-check.mts row-fit <a.glb>:<lot width m> <b.glb>:<lot width m> ... [--json out.json]
 *
 * row-fit (k-town2, R77): every ORDERED pair of the given row houses (a house beside itself included) stands at the row
 *   pitch -- lots side by side, street fronts on one line (the front door marker's wall line) -- and fails any triangle
 *   crossing the party line by more than 1 cm (into the neighbour or beside it) and any open gap over 5 cm on the line
 *   where both houses have body (tools/_row-fit.mts).
 *
 * A face is EXTERIOR when a horizontal ray along its normal from its centre hits nothing of the model (it looks out at
 * the street), so a notch wall, an open bay's back wall and a face behind entry steps all count, and a door reveal, a
 * hearth or an inside breast never do (the bounding-box test of 2026-10-28 skipped whole front walls behind steps).
 *
 * seams (row 4, Derek's Capture1.PNG; s2-fix faults 2-4), per model, exit 1 on any finding:
 *   wall tile   every exterior wall face shares the WALL role tile: the exterior vertical faces are grouped by the image
 *               their material samples; a wall-ish image (ExteriorNormal, ExteriorBottom, Stone, LargeStone, StuccoWall,
 *               WoodWall, StickWall, pasted, InternalWAll) outside the allowed wall roles is a finding with its face
 *               count; TWO wall tiles on one building (ExteriorNormal and Stone, say) are a finding.
 *   dressing    LargeStone is the dressing stone (KIT-RULES 37.1): allowed on an exterior face only on a material named
 *               `LargeStone-dressing` (export_building.py writes it for the pieces realize.tag_dressings tagged: grand
 *               door, surrounds, orders, chimney caps, battlements ...); untagged LargeStone (a plinth course, a quoined
 *               corner on an unquoined style) is a finding.
 *   proud       at grade (face centre y -0.1..1.3 m) no masonry / metal face stands more than 0.45 m proud of the wall
 *               plane behind it (ray back along its normal to the first wall-role face), outside the chimney column
 *               (1.3 m of a chimney-top marker) and the window boxes (1.0 m of a window marker): the roof-stack hearth's
 *               iron fireback hung 0.5 m outside every hearth gable (review fault 3).
 *   untextured  a face with no material, or a material with no base-colour texture, anywhere on the model.
 *   tile        a texture the model samples whose mean colour is a placeholder hue (cyan / blue / magenta with
 *               saturation > 0.35, green > 0.4): Derek's root RoofInterior.png is a saturated blue plank tile and showed
 *               through the hall's open grand door as "a blue hole" (review fault 2). Kit tiles are browns (hue 13-40),
 *               the pane tile a pale grey-green (hue 152, sat 0.15).
 * overlap (k-kit2, 2026-10-29), the PLACED town: every lot's built WALL footprint (the box of its wall-role faces, in
 *   its own frame, turned by the layout yaw and moved to its centre) is measured against the others and its own ground
 *   outline. Two wall footprints that intersect (> 0.05 m both ways) are a finding: one building's walls stand inside
 *   the other and its tile shows through as shards (the Thirstgate street: the render dry-cup's walls 5.5 m into the
 *   stone tithe-vault, pale wedges on a stone face). Walls more than 0.25 m outside the lot's ground outline are a
 *   finding too: the layout sized the lot from the REQUEST, and wings, outshuts, stable wings, apses and towers build
 *   past it. Roof eaves are not walls and may overhang.
 * smoke (row 5; s2-fix faults 1 and 4), per model:
 *   found       every chimney-top marker has a cap the engine's detector finds within 1.5 m (packages/render
 *               chimney-smoke.ts findChimneys: small, squarish, flat, high, nothing above, EVERY side dropping away) and
 *               the detector finds nothing else (the bank's keystone smoked, 2026-10-28). --expect N / --markers f
 *               override the marker file beside the model; with neither, >= 1 cap must be found.
 *   ridge       the cap is at or above the building's ridge (the highest roof face), within 0.05 m.
 *   wall        no exterior wall face within 2 m (XZ) of the cap rises above it: a stack against a taller wall is a
 *               stone pillar glued to it (house-m's outshut stack, review fault 1).
 *   flue        (k-town4, R79; Derek 2026-11-02 "all the chimneys are disconnected from the actual fireplace") every stack
 *               has a hearth marker below it within 1.2 m (plan) -- a chimney with no fireplace under it fails -- and
 *               masonry fills the column between them: from the storey over the hearth to 1 m under the cap, every 0.4 m
 *               the point on the stack's axis is INSIDE solid (four horizontal rays all hit within 1.2 m). The roof stack
 *               used to start at the roof course with nothing below it.
 *   upstairs    (k-kit2, R80; Derek 2026-11-03 "the fireplace is in the way, the walkway up top is very very tight") every
 *               upper floor a `stair-head` marker reaches, on a 0.1 m plan raster (tools/_upstairs.mts): the walk from the
 *               stair head to every room (a 1.6 m tile holding a 1.2 m disc of clear floor) never narrows below 1.2 m,
 *               and >= 60 % of the floor is clear (floor under it, nothing crossing 0.3 / 0.9 / 1.6 m over it: flue,
 *               rails, stair hole). The ridge-x strand-narrow-house (flue mid-way along a party gable, facing the stair
 *               hole) fails it at 1.02 m; the back-gable rebuild passes (walk never under 2 m).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { glbTriangles } from "./dress-sockets.mts";
import { findChimneys } from "../../../packages/render/src/chimney-smoke.ts";
import { rowFitAll, type RowHouse } from "./_row-fit.mts";
import { upstairsFloors, upstairsFindings } from "./_upstairs.mts";
// @ts-expect-error plain JS module
import { decodePng } from "./_png.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const opt = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };
const files = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]!.startsWith("--")));

/** Images the kit paints walls with (KIT-RULES 14 role tiles); anything else on a vertical face is a timber, a pane, metal. */
export const WALL_IMAGES = ["ExteriorNormal", "ExteriorBottom", "Stone", "LargeStone", "StuccoWall", "WoodWall", "StickWall", "pasted", "InternalWAll"];
/** One building shows ONE of these (its wall tile); ExteriorBottom is the ground band of the same tile (KIT-RULES 37). */
export const WALL_TILES = ["ExteriorNormal", "Stone", "StuccoWall", "WoodWall", "StickWall"];
export const DEFAULT_ALLOW = ["ExteriorNormal", "ExteriorBottom", "Stone"];
export const ROOF_IMAGES = ["Roofing", "Shingles", "ThatchRoof"];
/** Images a fixture standing proud of a wall at grade would carry (a hearth, a stack, a fireback); timbers and panes may stand proud. */
export const FIXTURE_IMAGES = ["Stone", "LargeStone", "Metal", "StoneSoot"];
/** Grade band: the ground storey's lower part, where a kit-default patch reads from the street. */
const GRADE_Y = [-0.1, 1.3] as const;

export function imageOf(mat: string): string { const img = mat.split("|")[1] ?? ""; return img.replace(/\.png.*$/i, "").replace(/\.\d+$/, ""); }
/** The material part of a soup material string names a tagged dressing (`LargeStone-dressing`, `.001` suffixes allowed). */
export function isDressing(mat: string): boolean { return /-dressing(\.\d+)?$/.test(mat.split("|")[0] ?? ""); }

type Soup = ReturnType<typeof glbTriangles>;
export type Face = { i: number; cx: number; cy: number; cz: number; nx: number; nz: number; ytop: number; img: string; mat: string; dressing: boolean; exterior: boolean };

/** Every vertical face: centre, outward horizontal normal, image, dressing flag; `exterior` by a ray along the normal. */
export function verticalFaces(soup: Soup): Face[] {
  const p = soup.pos, n = p.length / 9, out: Face[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const ax = p[o + 3]! - p[o]!, ay = p[o + 4]! - p[o + 1]!, az = p[o + 5]! - p[o + 2]!;
    const bx = p[o + 6]! - p[o]!, by = p[o + 7]! - p[o + 1]!, bz = p[o + 8]! - p[o + 2]!;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.abs(ny / len) > 0.3) continue;            // vertical faces only
    const hl = Math.hypot(nx, nz) || 1;
    const mat = soup.mats?.[soup.mat?.[i] ?? 0xffff] ?? "|";
    out.push({ i, cx: (p[o]! + p[o + 3]! + p[o + 6]!) / 3, cy: (p[o + 1]! + p[o + 4]! + p[o + 7]!) / 3, cz: (p[o + 2]! + p[o + 5]! + p[o + 8]!) / 3,
      nx: nx / hl, nz: nz / hl, ytop: Math.max(p[o + 1]!, p[o + 4]!, p[o + 7]!), img: imageOf(mat), mat, dressing: isDressing(mat), exterior: false });
  }
  // exterior: the ray along the normal escapes AND the face stands within 1.7 m of the wall-tile footprint box (a
  // ground wall under a jetty is 1.6 m in; an interior face that looks out through the open grand door is not)
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const f of out) if (WALL_TILES.includes(f.img)) { x0 = Math.min(x0, f.cx); x1 = Math.max(x1, f.cx); z0 = Math.min(z0, f.cz); z1 = Math.max(z1, f.cz); }
  for (const f of out) {
    const edge = Math.min(f.cx - x0, x1 - f.cx, f.cz - z0, z1 - f.cz);
    f.exterior = edge <= 1.7 && rayHit(soup, f.cx + f.nx * 0.02, f.cy, f.cz + f.nz * 0.02, f.nx, 0, f.nz, 80) === null;
  }
  return out;
}

/** First triangle a ray hits (Moller-Trumbore), or null: { t, i }. Brute force over the soup (a building: ~10k faces). */
export function rayHit(soup: Soup, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, skip = -1): { t: number; i: number } | null {
  const p = soup.pos, n = p.length / 9; let bt = Infinity, bi = -1;
  for (let i = 0; i < n; i++) {
    if (i === skip) continue;
    const o = i * 9; const e1x = p[o + 3]! - p[o]!, e1y = p[o + 4]! - p[o + 1]!, e1z = p[o + 5]! - p[o + 2]!, e2x = p[o + 6]! - p[o]!, e2y = p[o + 7]! - p[o + 1]!, e2z = p[o + 8]! - p[o + 2]!;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x; const det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det; const tx = ox - p[o]!, ty = oy - p[o + 1]!, tz = oz - p[o + 2]!; const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x; const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv; if (t > 1e-5 && t < maxT && t < bt) { bt = t; bi = i; }
  }
  return bi < 0 ? null : { t: bt, i: bi };
}

export type Marker = { kind: string; position: number[] };
export function readMarkersFull(file: string): { kind: string; position: number[]; yaw?: number; exterior?: boolean }[] {
  try { return (JSON.parse(fs.readFileSync(file, "utf8")) as { markers?: any[] }).markers ?? []; } catch { return []; }
}
export function readMarkers(file: string): Marker[] {
  const mk = file.replace(/\.glb$/i, ".markers.json");
  return fs.existsSync(mk) ? ((JSON.parse(fs.readFileSync(mk, "utf8")) as { markers?: Marker[] }).markers ?? []) : [];
}

/**
 * Per wall image: how many EXTERIOR vertical faces of the model use it (dressing LargeStone under "LargeStone(dressing)").
 * Faces within 1.3 m (XZ) of a chimney-top marker are the stack (stone on a timber house by design) and are skipped.
 */
export function wallFaceCounts(faces: Face[], chimneys: { x: number; z: number }[] = []): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of faces) {
    if (!f.exterior || !WALL_IMAGES.includes(f.img)) continue;
    if (chimneys.some((c) => Math.hypot(c.x - f.cx, c.z - f.cz) < 1.3)) continue;
    const k = f.img === "LargeStone" && f.dressing ? "LargeStone(dressing)" : f.img;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** The seam findings of one model's exterior wall faces. Pure. */
export function seamFindings(counts: Map<string, number>, allow = DEFAULT_ALLOW): string[] {
  const f: string[] = [];
  for (const [img, n] of counts) {
    if (img === "LargeStone(dressing)" || img === "InternalWAll" || allow.includes(img)) continue;
    f.push(img === "LargeStone" ? `${n} exterior faces on LargeStone that are not a tagged dressing (KIT-RULES 37.1: a plinth course, a quoined corner on an unquoined style)`
      : `${n} exterior faces on ${img} (allowed wall roles: ${allow.join(", ")})`);
  }
  const tiles = WALL_TILES.filter((t) => (counts.get(t) ?? 0) > 0);
  if (tiles.length > 1) f.push(`two wall tiles on one building: ${tiles.map((t) => `${t} ${counts.get(t)}`).join(", ")}`);
  return f;
}

/** Masonry / metal faces at grade standing > 0.45 m proud of the wall plane behind them (outside chimney and window boxes). */
export function proudFindings(soup: Soup, faces: Face[], markers: Marker[]): string[] {
  const chimneys = markers.filter((m) => m.kind === "chimney-top"), windows = markers.filter((m) => m.kind === "window");
  // the building's own wall tile at grade is its plinth / ground band, never a fixture (a stone kit's outer sheet starts
  // above the plinth course, so the plinth's nearest parallel face is the inner sheet 0.6 m back)
  const own = new Set(WALL_TILES.filter((t) => faces.some((f) => f.exterior && f.img === t)));
  const byImg = new Map<string, { n: number; worst: number; at: string }>();
  for (const f of faces) {
    if (!f.exterior || f.cy < GRADE_Y[0] || f.cy > GRADE_Y[1] || !FIXTURE_IMAGES.includes(f.img) || f.dressing || own.has(f.img)) continue;
    if (chimneys.some((m) => Math.hypot(m.position[0]! - f.cx, m.position[2]! - f.cz) < 1.3)) continue;
    if (windows.some((m) => Math.hypot(m.position[0]! - f.cx, m.position[2]! - f.cz) < 1.0)) continue;
    // the wall plane behind: the first allowed-role face the backward ray meets
    let t = 0, ox = f.cx - f.nx * 0.02, oz = f.cz - f.nz * 0.02, hit: { t: number; i: number } | null;
    let behind = Infinity;
    for (let k = 0; k < 6; k++) {
      hit = rayHit(soup, ox, f.cy, oz, -f.nx, 0, -f.nz, 6 - t);
      if (!hit) break;
      t += hit.t; const img = imageOf(soup.mats?.[soup.mat?.[hit.i] ?? 0xffff] ?? "|");
      // the wall plane: a wall-role face roughly parallel to the fixture face (a run-end's ray slides along the wall)
      if (DEFAULT_ALLOW.includes(img) || WALL_TILES.includes(img)) {
        const q = hit.i * 9, hp = soup.pos; const ax = hp[q + 3]! - hp[q]!, ay = hp[q + 4]! - hp[q + 1]!, az = hp[q + 5]! - hp[q + 2]!, bx = hp[q + 6]! - hp[q]!, by = hp[q + 7]! - hp[q + 1]!, bz = hp[q + 8]! - hp[q + 2]!;
        const hx = ay * bz - az * by, hz = ax * by - ay * bx, hl = Math.hypot(hx, hz) || 1;
        if (Math.abs((hx * f.nx + hz * f.nz) / hl) > 0.8) { behind = t; break; }
      }
      ox -= f.nx * (hit.t + 0.01); oz -= f.nz * (hit.t + 0.01); t += 0.01;
    }
    if (!Number.isFinite(behind) || behind <= 0.45) continue;   // no wall behind it at all: a side face looking along the wall (a plinth run end), not measurable
    const e = byImg.get(f.img) ?? { n: 0, worst: 0, at: "" };
    e.n++; if (behind > e.worst) { e.worst = behind; e.at = `(${f.cx.toFixed(1)}, ${f.cy.toFixed(1)}, ${f.cz.toFixed(1)})`; }
    byImg.set(f.img, e);
  }
  return [...byImg].map(([img, e]) => `${e.n} ${img} faces at grade stand up to ${e.worst.toFixed(2)} m proud of the wall plane, e.g. at ${e.at}: a fixture outside the wall line`);
}

// ---------------------------------------------------------------- textures (GLB-embedded PNGs)
function readGlb(file: string): { json: any; bin: Buffer } {
  const b = fs.readFileSync(file);
  let o = 12, json: any = null, bin: Buffer | null = null;
  while (o + 8 <= b.length) {
    const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4), data = b.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8")); else if (type === 0x004e4942) bin = data;
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error(`GLB without JSON/BIN chunk: ${file}`);
  return { json, bin };
}

export type TileStat = { name: string; hue: number; sat: number; val: number };
/** A placeholder colour: cyan / blue / magenta (hue 170-330) with saturation > 0.35, or green (80-170) > 0.4. */
export function isPlaceholderTile(t: TileStat): boolean {
  if (t.val < 0.08) return false;
  return (t.hue >= 170 && t.hue <= 330 && t.sat > 0.35) || (t.hue >= 80 && t.hue < 170 && t.sat > 0.4);
}
export function tileStat(name: string, rgba: Uint8Array): TileStat {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) { if (rgba[i + 3]! < 8) continue; r += rgba[i]!; g += rgba[i + 1]!; b += rgba[i + 2]!; n++; }
  if (!n) return { name, hue: 0, sat: 0, val: 0 };
  r /= n; g /= n; b /= n;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
  let h = 0;
  if (mx !== mn) { if (mx === r) h = ((g - b) / (mx - mn)) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4; h = (h * 60 + 360) % 360; }
  return { name, hue: h, sat, val: mx / 255 };
}
/** Untextured faces and placeholder-coloured textures of a model. */
export function textureFindings(file: string, soup: Soup): string[] {
  const f: string[] = [];
  const g = readGlb(file);
  const mats: any[] = g.json.materials ?? [];
  // faces with no material, or a material without a base-colour texture
  const bad = new Map<string, number>();
  const n = soup.pos.length / 9;
  for (let i = 0; i < n; i++) {
    const mi = soup.mat?.[i] ?? 0xffff;
    const m = mats[mi];
    const tex = m?.pbrMetallicRoughness?.baseColorTexture?.index;
    if (mi === 0xffff || !m) bad.set("(no material)", (bad.get("(no material)") ?? 0) + 1);
    else if (tex == null) bad.set(m.name ?? `material ${mi}`, (bad.get(m.name ?? `material ${mi}`) ?? 0) + 1);
  }
  for (const [k, v] of bad) f.push(`${v} faces on ${k === "(no material)" ? "no material at all" : `untextured material ${k}`} (the fallback grey)`);
  // the images used by materials of faces in the soup
  const used = new Set<number>();
  for (let i = 0; i < n; i++) { const m = mats[soup.mat?.[i] ?? 0xffff]; const ti = m?.pbrMetallicRoughness?.baseColorTexture?.index; const src = ti != null ? g.json.textures?.[ti]?.source : undefined; if (src != null) used.add(src); }
  for (const src of used) {
    const im = g.json.images?.[src]; if (!im) continue;
    const name = String(im.name ?? im.uri ?? `image ${src}`);
    try {
      let bytes: Buffer | null = null;
      if (im.bufferView != null) { const v = g.json.bufferViews[im.bufferView]; bytes = g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); }
      else if (im.uri && !/^data:/.test(im.uri)) { const p = path.join(path.dirname(file), decodeURIComponent(im.uri)); if (fs.existsSync(p)) bytes = fs.readFileSync(p); }
      if (!bytes || !/png/i.test(im.mimeType ?? name)) continue;
      const dec = decodePng(bytes) as { width: number; height: number; data: Uint8Array };
      const st = tileStat(name, dec.data);
      if (isPlaceholderTile(st)) f.push(`texture ${name} is a placeholder colour (hue ${st.hue.toFixed(0)}, saturation ${st.sat.toFixed(2)}): not a kit tile`);
    } catch (e) { f.push(`texture ${name}: unreadable (${(e as Error).message})`); }
  }
  return f;
}

/** A THREE object of the soup (one mesh), for the engine's own chimney detector. */
export function soupObject(soup: Soup): THREE.Object3D {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(soup.pos, 3));
  const root = new THREE.Object3D();
  root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  return root;
}

/** The building's ridge: the highest roof-image face vertex (null without a roof). */
export function ridgeHeight(soup: Soup): number | null {
  const p = soup.pos, n = p.length / 9; let top = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!ROOF_IMAGES.includes(imageOf(soup.mats?.[soup.mat?.[i] ?? 0xffff] ?? "|"))) continue;
    const o = i * 9; top = Math.max(top, p[o + 1]!, p[o + 4]!, p[o + 7]!);
  }
  return top === -Infinity ? null : top;
}

/** smoke findings per chimney-top marker: found by the detector, cap over the ridge, no taller exterior wall beside it. */
export function smokeFindings(tops: THREE.Vector3[], chimneys: Marker[], ridge: number | null, faces: Face[]): string[] {
  const f: string[] = [];
  const matched = new Set<number>();
  chimneys.forEach((m, k) => {
    const [mx, my, mz] = [m.position[0]!, m.position[1]!, m.position[2]!];
    const near = tops.map((t, i) => ({ i, d: Math.hypot(t.x - mx, t.z - mz) })).filter((q) => q.d < 1.5).sort((a, b) => a.d - b.d)[0];
    if (!near) f.push(`stack ${k + 1} at (${mx.toFixed(1)}, ${my.toFixed(1)}, ${mz.toFixed(1)}): the detector sees no cap there, no smoke`);
    else matched.add(near.i);
    if (ridge !== null && my < ridge - 0.05) f.push(`stack ${k + 1}: cap at ${my.toFixed(2)} m is below the building's ridge (${ridge.toFixed(2)} m)`);
    const taller = faces.filter((x) => x.exterior && WALL_IMAGES.includes(x.img) && Math.hypot(x.cx - mx, x.cz - mz) < 2 && x.ytop > my + 0.1);
    if (taller.length) f.push(`stack ${k + 1}: ${taller.length} exterior wall faces within 2 m rise above its cap (to ${Math.max(...taller.map((x) => x.ytop)).toFixed(2)} m): a stack against a taller wall`);
  });
  tops.forEach((t, i) => { if (!matched.has(i)) f.push(`a cap the detector finds at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)}) is no chimney: it would smoke`); });
  return f;
}

/** flue findings (R79): a hearth under every chimney-top marker, and a solid column from the storey above the hearth to the cap. */
export function flueFindings(soup: Soup, markers: Marker[], storey = 3.2): string[] {
  const f: string[] = [];
  const hearths = markers.filter((m) => m.kind === "hearth");
  markers.filter((m) => m.kind === "chimney-top").forEach((m, k) => {
    const [mx, my, mz] = [m.position[0]!, m.position[1]!, m.position[2]!];
    const h = hearths.map((q) => ({ q, d: Math.hypot(q.position[0]! - mx, q.position[2]! - mz) })).filter((x) => x.d <= 1.2 && x.q.position[1]! < my).sort((a, b) => a.d - b.d)[0];
    if (!h) { f.push(`stack ${k + 1} at (${mx.toFixed(1)}, ${my.toFixed(1)}, ${mz.toFixed(1)}): no fireplace (hearth marker) under it within 1.2 m`); return; }
    const floor = Math.round((h.q.position[1]! - 0.2) / storey) * storey;          // the hearth's storey floor
    const gaps: number[] = [];
    for (let y = floor + storey + 0.3; y <= my - 1.0; y += 0.4) {
      const inside = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => rayHit(soup, mx, y, mz, dx!, 0, dz!, 1.2) !== null);
      if (!inside) gaps.push(y);
    }
    if (gaps.length) f.push(`stack ${k + 1}: the column between the hearth and the cap is open at ${gaps.length} height(s) (${gaps[0]!.toFixed(1)}..${gaps[gaps.length - 1]!.toFixed(1)} m): the stack is disconnected from its fireplace`);
  });
  return f;
}

/** A built wall footprint in its own frame: x0, x1, z0, z1 (metres) of the wall-role faces above 1.2 m. null when it has none. */
export function wallBox(faces: Face[]): [number, number, number, number] | null {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  // above the grade band only: entry steps and plinth blocks (low ExteriorBottom faces) may stand out on the street
  for (const f of faces) if (WALL_IMAGES.includes(f.img) && f.cy > 1.2) { x0 = Math.min(x0, f.cx); x1 = Math.max(x1, f.cx); z0 = Math.min(z0, f.cz); z1 = Math.max(z1, f.cz); }
  return x0 <= x1 ? [x0, x1, z0, z1] : null;
}
/** A local box turned by yaw degrees about +Y (three.js: x' = x cos + z sin, z' = -x sin + z cos) and moved to centre [x, z]. */
export function placeBox(b: [number, number, number, number], yaw: number, center: [number, number]): [number, number, number, number] {
  const t = (yaw * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const xs: number[] = [], zs: number[] = [];
  for (const x of [b[0], b[1]]) for (const z of [b[2], b[3]]) { xs.push(c * x + s * z + center[0]); zs.push(-s * x + c * z + center[1]); }
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
}
export type PlacedLot = { id: string; walls: [number, number, number, number]; ground?: [number, number][] };
/** The overlap gate's findings (empty = pass). Pure. */
export function overlapFindings(lots: PlacedLot[], tol = 0.05, outside = 0.25): string[] {
  const f: string[] = [];
  for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
    const a = lots[i]!.walls, b = lots[j]!.walls;
    const ox = Math.min(a[1], b[1]) - Math.max(a[0], b[0]), oz = Math.min(a[3], b[3]) - Math.max(a[2], b[2]);
    if (ox > tol && oz > tol) f.push(`${lots[i]!.id} and ${lots[j]!.id}: built walls intersect by ${ox.toFixed(1)} x ${oz.toFixed(1)} m (one building's walls stand inside the other)`);
  }
  for (const l of lots) {
    if (!l.ground?.length) continue;
    const gx0 = Math.min(...l.ground.map((p) => p[0])), gx1 = Math.max(...l.ground.map((p) => p[0])), gz0 = Math.min(...l.ground.map((p) => p[1])), gz1 = Math.max(...l.ground.map((p) => p[1]));
    const d = Math.max(gx0 - l.walls[0], l.walls[1] - gx1, gz0 - l.walls[2], l.walls[3] - gz1);
    if (d > outside) f.push(`${l.id}: built walls stand ${d.toFixed(1)} m outside its ground outline (the lot was sized from the request; wings/outshuts/towers build past it)`);
  }
  return f;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (cmd === "overlap") {
    const layoutFile = opt("layout", ""), dir = opt("glb-dir", "");
    if (!layoutFile || !dir) { console.error("usage: town-kit-check overlap --layout <town>-layout.json --glb-dir <dir>"); process.exit(2); }
    const layout = JSON.parse(fs.readFileSync(layoutFile, "utf8")) as { buildings: { id: string; yaw?: number; center: [number, number]; ground?: [number, number][] }[] };
    const lots: PlacedLot[] = [];
    for (const b of layout.buildings) {
      const glb = path.join(dir, `${b.id}.glb`);
      if (!fs.existsSync(glb)) { console.log(`  ! ${b.id}: no ${glb}`); continue; }
      const box = wallBox(verticalFaces(glbTriangles(glb)));
      if (!box) continue;
      const walls = placeBox(box, b.yaw ?? 0, b.center);
      lots.push({ id: b.id, walls, ground: b.ground });
      console.log(`${b.id}: walls x ${walls[0].toFixed(1)}..${walls[1].toFixed(1)} z ${walls[2].toFixed(1)}..${walls[3].toFixed(1)}`);
    }
    const f = overlapFindings(lots);
    for (const x of f) console.log(`  ! ${x}`);
    console.log(f.length ? `OVERLAP FAILED (${f.length})` : "OVERLAP OK");
    process.exit(f.length ? 1 : 0);
  }
  if (cmd === "row-fit") {
    const houses: RowHouse[] = [];
    for (const a of files) {
      const m = /^(.*\.glb):([\d.]+)$/i.exec(a);
      if (!m) { console.error(`row-fit: give each model as <file.glb>:<lot width in m> (got ${a})`); process.exit(2); }
      const file = m[1]!, soup = glbTriangles(file);
      const mk = readMarkersFull(file.replace(/\.glb$/i, ".markers.json"));
      const door = mk.find((k) => k.kind === "door" && k.exterior !== false && Math.abs(((k.yaw ?? 0) + 360) % 360) < 1);
      let front = door ? door.position[2]! : NaN;
      if (!Number.isFinite(front)) { console.error(`row-fit: ${path.basename(file)} has no front (yaw 0) exterior door marker`); process.exit(2); }
      houses.push({ id: path.basename(file, ".glb"), tris: soup.pos, lot: Number(m[2]), front });
    }
    const res = rowFitAll(houses);
    let bad = 0;
    for (const r of res) { console.log(`${r.pair}: ${r.findings.length ? "FAIL" : "ok"}`); for (const x of r.findings) console.log(`  ! ${x}`); bad += r.findings.length ? 1 : 0; }
    // k-town9: also the lot width each house was proven at (party lines at +-lot/2 off the model origin), so the town
    // check judges neighbours at that pitch (a corner type's lot is its built width, wider than its walls)
    const jf = opt("json", ""); if (jf) fs.writeFileSync(jf, JSON.stringify({ lots: Object.fromEntries(houses.map((h) => [h.id, h.lot])), pairs: res, ok: bad === 0 }, null, 2) + "\n");
    console.log(bad ? `ROW-FIT FAILED (${bad} of ${res.length} pairs)` : `ROW-FIT OK (${res.length} pairs)`);
    process.exit(bad ? 1 : 0);
  }
  if (!["seams", "smoke"].includes(cmd) || !files.length) { console.error("usage: town-kit-check seams|smoke <model.glb> [...] [--allow a,b] [--expect N | --markers f]"); process.exit(2); }
  let bad = 0;
  for (const file of files) {
    const soup = glbTriangles(file);
    const name = path.basename(file);
    const faces = verticalFaces(soup);
    if (cmd === "seams") {
      const allow = opt("allow", DEFAULT_ALLOW.join(",")).split(",");
      const markers = readMarkers(file);
      const chimneys = markers.filter((m) => m.kind === "chimney-top").map((m) => ({ x: m.position[0]!, z: m.position[2]! }));
      const counts = wallFaceCounts(faces, chimneys);
      const f = [...seamFindings(counts, allow), ...proudFindings(soup, faces, markers), ...textureFindings(file, soup)];
      console.log(`${name}: exterior wall faces ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
      for (const x of f) console.log(`  ! ${x}`);
      bad += f.length;
    } else {
      const tops = findChimneys(soupObject(soup));
      const mkFile = opt("markers", fs.existsSync(file.replace(/\.glb$/i, ".markers.json")) ? file.replace(/\.glb$/i, ".markers.json") : "");
      const expectOpt = opt("expect", "");
      const markers: Marker[] = mkFile ? ((JSON.parse(fs.readFileSync(mkFile, "utf8")) as { markers?: Marker[] }).markers ?? []) : [];
      const chimneys = markers.filter((m) => m.kind === "chimney-top");
      const ridge = ridgeHeight(soup);
      let f: string[];
      if (expectOpt) { const expect = Number(expectOpt); f = tops.length === expect ? [] : [`${tops.length} cap(s) found of ${expect} expected`]; }
      else if (mkFile) f = [...smokeFindings(tops, chimneys, ridge, faces), ...flueFindings(soup, markers)];
      else f = tops.length >= 1 ? [] : ["no chimney found"];
      // R80 upstairs (k-kit2): every upper floor a stair reaches keeps a walk >= 1.2 m and >= 60 % clear
      const ups = mkFile ? upstairsFloors(soup, markers as any) : [];
      if (ups.length) console.log(`${name}: upstairs ${ups.map((u) => `storey ${u.level} walk ${u.walk.toFixed(2)} m, clear ${(u.share * 100).toFixed(0)} % (${u.clear.toFixed(1)} of ${u.gross.toFixed(1)} m2)`).join("; ")}`);
      f.push(...upstairsFindings(ups));
      console.log(`${name}: ${tops.length} chimney top(s) found${mkFile ? ` of ${chimneys.length} placed` : ""}${ridge !== null ? `, ridge ${ridge.toFixed(2)} m` : ""}: ${tops.map((t) => `(${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})`).join(" ")}`);
      for (const x of f) console.log(`  ! ${x}`);
      bad += f.length;
    }
  }
  console.log(bad ? `${cmd.toUpperCase()} FAILED (${bad})` : `${cmd.toUpperCase()} OK`);
  process.exit(bad ? 1 : 0);
}
