/**
 * town-kit-check — the kit gates of MMO/WFC KIT-RULES 37, measured on EXPORTED models (GLB), never on a sheet.
 *
 *   npx tsx tools/town-kit-check.mts seams <model.glb> [more.glb ...] [--allow ExteriorNormal,ExteriorBottom,Stone]
 *   npx tsx tools/town-kit-check.mts smoke <model.glb> [more.glb ...] [--expect N | --markers <model>.markers.json]
 *
 * seams (row 4, Derek's Capture1.PNG): every exterior wall face of a building shares the WALL role tile. The outward
 *   vertical faces are grouped by the image their material samples; the wall-ish images (ExteriorNormal, ExteriorBottom,
 *   Stone, LargeStone, StuccoWall, WoodWall, StickWall, pasted, InternalWAll) other than the allowed wall roles are a
 *   finding, with the face count: a LargeStone quoin column, a stucco stand-in gable, a second ground tile all show up
 *   here. Timbers, metal, glass and roofs are not walls and are ignored. Exit 1 on any finding.
 * smoke (row 5): every chimney stack the kit placed is found by the engine's own detector
 *   (packages/render/src/chimney-smoke.ts findChimneys: a small squarish flat cap, high, nothing above, a side dropping
 *   away) and so smokes. --expect N is the number of stacks (the build's chimney-top markers), --markers reads them from
 *   the model's markers file; without either the count is printed and >= 1 is required.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { glbTriangles } from "./dress-sockets.mts";
import { findChimneys } from "../../../packages/render/src/chimney-smoke.ts";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const opt = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback; };
const files = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]!.startsWith("--")));

/** Images the kit paints walls with (KIT-RULES 14 role tiles); anything else on a vertical face is a timber, a pane, metal. */
export const WALL_IMAGES = ["ExteriorNormal", "ExteriorBottom", "Stone", "LargeStone", "StuccoWall", "WoodWall", "StickWall", "pasted", "InternalWAll"];
export const DEFAULT_ALLOW = ["ExteriorNormal", "ExteriorBottom", "Stone"];

export function imageOf(mat: string): string { const img = mat.split("|")[1] ?? ""; return img.replace(/\.png.*$/i, "").replace(/\.\d+$/, ""); }

/**
 * Per wall image: how many EXTERIOR vertical faces of the model use it. Pure.
 * Exterior = on the outer wall planes: within 0.25 m of the bounding box of the faces painted with the allowed wall
 * roles (an L-plan's notch walls are allowed-role faces themselves). Faces within 1.3 m (XZ) of a chimney-top marker are
 * the stack (stone on a timber house by design) and are skipped; so are faces deeper inside (hearth, inside breast).
 */
export function wallFaceCounts(soup: ReturnType<typeof glbTriangles>, allow = DEFAULT_ALLOW, chimneys: { x: number; z: number }[] = []): Map<string, number> {
  const counts = new Map<string, number>();
  const p = soup.pos, n = p.length / 9;
  const vertical: number[] = [], image: string[] = [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * 9;
    const ax = p[o + 3]! - p[o]!, ay = p[o + 4]! - p[o + 1]!, az = p[o + 5]! - p[o + 2]!;
    const bx = p[o + 6]! - p[o]!, by = p[o + 7]! - p[o + 1]!, bz = p[o + 8]! - p[o + 2]!;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.abs(ny / len) > 0.3) continue;            // vertical faces only
    const img = imageOf(soup.mats?.[soup.mat?.[i] ?? 0xffff] ?? "|");
    if (!WALL_IMAGES.includes(img)) continue;
    vertical.push(i); image.push(img);
    if (allow.includes(img)) for (let v = 0; v < 3; v++) { const x = p[o + v * 3]!, z = p[o + v * 3 + 2]!; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  }
  for (let k = 0; k < vertical.length; k++) {
    const o = vertical[k]! * 9, cx = (p[o]! + p[o + 3]! + p[o + 6]!) / 3, cz = (p[o + 2]! + p[o + 5]! + p[o + 8]!) / 3;
    if (chimneys.some((c) => Math.hypot(c.x - cx, c.z - cz) < 1.3)) continue;
    const edge = Math.min(cx - x0, x1 - cx, cz - z0, z1 - cz);
    if (edge > 0.25) continue;                                          // interior fixture (hearth, inside breast)
    counts.set(image[k]!, (counts.get(image[k]!) ?? 0) + 1);
  }
  return counts;
}

/** The seam findings of one model: wall-ish images on vertical faces outside the allowed wall roles. Pure. */
export function seamFindings(counts: Map<string, number>, allow = DEFAULT_ALLOW): string[] {
  const f: string[] = [];
  for (const [img, n] of counts) if (!allow.includes(img) && img !== "InternalWAll") f.push(`${n} vertical faces on ${img} (allowed wall roles: ${allow.join(", ")})`);
  return f;
}

/** A THREE object of the soup (one mesh), for the engine's own chimney detector. */
export function soupObject(soup: ReturnType<typeof glbTriangles>): THREE.Object3D {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(soup.pos, 3));
  const root = new THREE.Object3D();
  root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  return root;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!["seams", "smoke"].includes(cmd) || !files.length) { console.error("usage: town-kit-check seams|smoke <model.glb> [...] [--allow a,b] [--expect N | --markers f]"); process.exit(2); }
  let bad = 0;
  for (const file of files) {
    const soup = glbTriangles(file);
    const name = path.basename(file);
    if (cmd === "seams") {
      const allow = opt("allow", DEFAULT_ALLOW.join(",")).split(",");
      const mkFile = file.replace(/\.glb$/i, ".markers.json");
      const chimneys = fs.existsSync(mkFile) ? ((JSON.parse(fs.readFileSync(mkFile, "utf8")) as { markers?: { kind: string; position: number[] }[] }).markers ?? []).filter((m) => m.kind === "chimney-top").map((m) => ({ x: m.position[0]!, z: m.position[2]! })) : [];
      const counts = wallFaceCounts(soup, allow, chimneys);
      const f = seamFindings(counts, allow);
      console.log(`${name}: wall faces ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
      for (const x of f) console.log(`  ! ${x}`);
      bad += f.length;
    } else {
      const tops = findChimneys(soupObject(soup));
      const markers = opt("markers", fs.existsSync(file.replace(/\.glb$/i, ".markers.json")) ? file.replace(/\.glb$/i, ".markers.json") : "");
      let expect = opt("expect", "") ? Number(opt("expect", "")) : -1;
      if (expect < 0 && markers) {
        const mk = JSON.parse(fs.readFileSync(markers, "utf8")) as { markers?: { kind: string }[] };
        expect = (mk.markers ?? []).filter((m) => m.kind === "chimney-top").length;
      }
      const ok = expect >= 0 ? tops.length === expect : tops.length >= 1;
      console.log(`${name}: ${tops.length} chimney top(s) found${expect >= 0 ? ` of ${expect} placed` : ""}: ${tops.map((t) => `(${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})`).join(" ")}`);
      if (!ok) { console.log(`  ! ${expect >= 0 ? `${expect - tops.length} stack(s) the detector does not see: no smoke there` : "no chimney found"}`); bad++; }
    }
  }
  console.log(bad ? `${cmd.toUpperCase()} FAILED (${bad})` : `${cmd.toUpperCase()} OK`);
  process.exit(bad ? 1 : 0);
}
