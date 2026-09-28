import * as THREE from "three/webgpu";
import { Fn, float, materialReference, mix, texture, uniform, uniformArray, uv, vec2, vec3, vec4, vertexStage } from "three/tsl";
import { asNodeMaterial, cloneMaterial } from "./node-material.js";

/**
 * Per-character APPEARANCE on a shared model: which tile of the packed page
 * each PART wears, and a skin tone — with no material, mesh or texture of the
 * character's own.
 *
 * ## Per-part tiles
 *
 * A body wearing a vanguard chest, ranger legs and magus gloves is ONE mesh
 * whose parts sample different tiles of one page. The part index already rides
 * in every vertex (uv1.x, see ubermesh.ts), so a character carries a small
 * table: part → TILE CODE, 8 bits a part, three parts per float (exact: a
 * float32 holds every integer below 2^24). Twelve floats cover 36 parts; the
 * body has 32. The code indexes the model's TILE TABLE — every sheet on the
 * page, in the order of the model's `tiles` extras, as a uniform array shared
 * by every character wearing the model. Code 0 is the model's default tile
 * (the texture transform the glTF ships with; for an instanced batch, the
 * instance's `instanceUber` tile), so a look with one texture, or none, draws
 * exactly as before.
 *
 * The tile is decided per VERTEX and handed on as a varying: a triangle
 * belongs to one part, so it is constant across it (the same reason the glow's
 * part test lives in the vertex stage — read per fragment, the part index
 * tracked the texture).
 *
 * ## Skin tint
 *
 * Every sheet paints skin in one palette (the SKIN-TINT CONTRACT,
 * docs/image-generation.md), but so does plenty of gear: brown leather,
 * bronze, linen and gold sit near skin's hue. So skin is OPT-IN per sheet
 * ({@link SkinSheet}): a face, the unequipped body, or — limited to the hand
 * islands — a gloved set whose fingers show. {@link classifySkin} finds the
 * skin texels inside those regions once per page, into a small R8 MASK
 * texture beside the page (the page itself, its mips and its alpha cut-outs
 * are untouched). The shader maps each masked texel onto the chosen tone by
 * its brightness against the page's mean skin colour, so the painted shading
 * (shadows under the jaw, the knuckles) survives, and the head's page and the
 * body's page — painted a shade apart — land on the same tone.
 *
 * ## Cost
 *
 * Per character: 16 floats (4 vec4: 12 of part codes, a tint), 64 bytes.
 * Non-instanced (the skinned player, the creator): they are per-OBJECT
 * uniforms (`onObjectUpdate`, the mechanism three's own model matrices use),
 * read from `mesh.userData[APPEARANCE_DATA]`, so every character wearing a
 * model shares ONE material — one pipeline, no per-character material. The
 * uniforms land in the object uniform buffer every render object already has.
 * Instanced (crowds, held/worn batches): one interleaved per-instance buffer
 * of the same 16 floats (one vertex buffer; WebGPU guarantees 8 and a moving
 * batch already binds 7 — see {@link applyInstanceAppearance}).
 * Per model: one appearance material (replacing the model's own for those
 * meshes) and, when skin is tinted, one R8 mask the size of its page (1.2 MB
 * for the 1088 px body page, 0.12 MB for the head's) — one more sample, the
 * same draw.
 */

// ---------------------------------------------------------------------------
// the per-character table
// ---------------------------------------------------------------------------

/** Floats per character: 12 of part→tile codes, then the tint (linear r, g, b, on). */
export const APPEARANCE_FLOATS = 16;
/** Parts the table can address (12 floats × 3 codes). */
export const APPEARANCE_MAX_PARTS = 36;
/** Tiles a model's table can address: codes are 8 bits and 0 is the default. */
export const APPEARANCE_MAX_TILES = 255;
/** Where a mesh keeps its appearance floats (read by the shared material every draw). */
export const APPEARANCE_DATA = "appearanceData";

/** One group of a look: these parts wear this sheet. Absent/null texture = the model's default tile. */
export interface AppearanceGroup {
  parts: readonly string[];
  texture?: string | null;
}

/** A whole look on one model: groups (later groups win a part named twice) and a skin tone. */
export interface AppearanceLook {
  groups: readonly AppearanceGroup[];
  /** Skin tone as CSS hex; null/absent = the painted skin. */
  skinTint?: string | null;
}

export interface EncodedAppearance {
  data: Float32Array;
  /** Part indices some group shows (hidden parts are the caller's to drop). */
  shown: number[];
  missingParts: string[];
  missingTextures: string[];
}

/**
 * `{ sheetId: code }` for a model's `tiles` extras: 1, 2, 3… in the table's
 * own key order (code 0 is the default tile). The shader's tile table is
 * built from the same order ({@link tileTableOf}), so both sides agree.
 */
export function tileCodes(tiles: Record<string, readonly number[]> | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!tiles) return out;
  for (const id of Object.keys(tiles)) {
    if (out.size >= APPEARANCE_MAX_TILES) break;
    out.set(id, out.size + 1);
  }
  return out;
}

/** Write part `part`'s tile code into the table (JS twin of the shader's decode). */
export function setPartTile(data: Float32Array, part: number, code: number): void {
  const f = Math.floor(part / 3);
  const shift = 256 ** (part % 3);
  const current = data[f]!;
  const old = Math.floor(current / shift) % 256;
  data[f] = current + (code - old) * shift;
}

/** The tile code of `part` — exactly what the vertex stage computes. */
export function partTileCode(data: ArrayLike<number>, part: number): number {
  const f = Math.floor(part / 3);
  if (f < 0 || f >= 12) return 0;
  const shifted = Math.floor(data[f]! / 256 ** (part % 3));
  return shifted - Math.floor(shifted / 256) * 256;
}

const _tint = new THREE.Color();

/**
 * Resolve a look against a model's part table and tile codes into the 16
 * floats a character carries. Unknown names are reported, never thrown: a look
 * written against an older cut of the model still shows what exists.
 */
export function encodeAppearance(
  partIndex: Record<string, number> | null | undefined,
  codes: Map<string, number>,
  look: AppearanceLook,
  out = new Float32Array(APPEARANCE_FLOATS),
): EncodedAppearance {
  out.fill(0);
  const shown = new Set<number>();
  const missingParts: string[] = [];
  const missingTextures: string[] = [];
  for (const group of look.groups) {
    let code = 0;
    if (group.texture) {
      const found = codes.get(group.texture);
      if (found === undefined) missingTextures.push(group.texture);
      else code = found;
    }
    for (const name of group.parts) {
      const part = partIndex?.[name];
      if (part === undefined || part >= APPEARANCE_MAX_PARTS) {
        missingParts.push(name);
        continue;
      }
      setPartTile(out, part, code);
      shown.add(part);
    }
  }
  if (look.skinTint) {
    // THREE.Color parses sRGB hex into linear; the shader tints in OKLab (see appearanceColorNode)
    _tint.set(look.skinTint);
    const [L, a, b] = linearToOklab(_tint.r, _tint.g, _tint.b);
    out[12] = L;
    out[13] = a;
    out[14] = b;
    out[15] = 1;
  }
  return { data: out, shown: [...shown].sort((a, b) => a - b), missingParts, missingTextures };
}

// ---------------------------------------------------------------------------
// the skin mask
// ---------------------------------------------------------------------------

/**
 * The skin palette, as HSV boxes (hue in degrees, saturation and value 0–1),
 * measured on the MMO's head and body sheets (2026-09-25; numbers in
 * docs/image-generation.md → skin-tint contract). Used only on sheets that
 * OPT IN as skin (faces, the unequipped body). Two boxes, hysteresis style:
 * STRONG texels seed skin, WEAK ones join only when 4-connected to a seed, so
 * a face's shadows join through their lit neighbours while its eyes, brows and
 * the linen beside a bare arm (hue 30°+, saturation under 0.35) stay out.
 * Seeds in components smaller than `minSeed` texels are dropped.
 */
export const SKIN_CLASSIFIER = {
  strong: { hue: [16, 26], sat: [0.46, 0.64], val: [0.45, 0.9] },
  weak: { hue: [14, 28.5], sat: [0.4, 0.68], val: [0.26, 0.95] },
  minSeed: 16,
} as const;

/**
 * The classifier for an ARMOR sheet that paints a little bare skin (the
 * ranger's bare hands, the magus's fingertips), used only inside the islands
 * of the parts the sheet names: the strong box alone, no growth into the weak
 * one — leather wraps sit right beside those fingers.
 */
export const SKIN_CLASSIFIER_TIGHT = {
  strong: { hue: [16, 26], sat: [0.46, 0.64], val: [0.45, 0.9] },
  weak: { hue: [16, 26], sat: [0.46, 0.64], val: [0.45, 0.9] },
  minSeed: 4,
} as const;

type Box = { hue: readonly number[]; sat: readonly number[]; val: readonly number[] };

/**
 * A sheet that paints bare skin — OPT-IN: a page's texels are only ever
 * classified inside the tiles of sheets named like this, so armour that sits
 * near skin's hue (leather, bronze, linen, gold) is never tinted.
 * `parts` limits it further to those parts' UV islands on the sheet (the
 * hands of a set whose gloves leave the fingers bare), classified with
 * {@link SKIN_CLASSIFIER_TIGHT}; absent = the whole sheet with
 * {@link SKIN_CLASSIFIER} (a face, the unequipped body). `face` marks a
 * head sheet: its MOUTH is found and kept as painted ({@link protectMouth}).
 */
export interface SkinSheet {
  texture: string;
  parts?: readonly string[];
  face?: boolean;
}

function inBox(box: Box, h: number, s: number, v: number): boolean {
  return h >= box.hue[0]! && h <= box.hue[1]! && s >= box.sat[0]! && s <= box.sat[1]! && v >= box.val[0]! && v <= box.val[1]!;
}

/**
 * Which texels of an RGBA8 page are painted skin (1) — see {@link SKIN_CLASSIFIER}.
 * Transparent texels (alpha < 128) never are. Pure: runs headless.
 */
export function classifySkin(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  classifier: { strong: Box; weak: Box; minSeed: number } = SKIN_CLASSIFIER,
  /** Texels that may be skin at all (1); absent = every texel. */
  allowed?: Uint8Array,
): Uint8Array {
  const n = width * height;
  const strong = new Uint8Array(n);
  const weak = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3]! < 128 || (allowed && !allowed[i])) continue;
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max > 0 ? d / max : 0;
    const v = max / 255;
    if (inBox(classifier.strong, h, s, v)) strong[i] = 1;
    if (inBox(classifier.weak, h, s, v)) weak[i] = 1;
  }
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const component: number[] = [];
  const neighbours = (j: number, visit: (m: number) => void): void => {
    const x = j % width;
    if (x > 0) visit(j - 1);
    if (x < width - 1) visit(j + 1);
    if (j >= width) visit(j - width);
    if (j + width < n) visit(j + width);
  };
  // seeds: strong components big enough to be skin, not a leather glint
  for (let i = 0; i < n; i++) {
    if (!strong[i] || seen[i]) continue;
    component.length = 0;
    component.push(i);
    seen[i] = 1;
    for (let k = 0; k < component.length; k++) {
      neighbours(component[k]!, (m) => {
        if (strong[m] && !seen[m]) {
          seen[m] = 1;
          component.push(m);
        }
      });
    }
    if (component.length < classifier.minSeed) continue;
    for (const j of component) {
      out[j] = 1;
      stack.push(j);
    }
  }
  // grow through weak texels touching skin
  while (stack.length > 0) {
    neighbours(stack.pop()!, (m) => {
      if (weak[m] && !out[m]) {
        out[m] = 1;
        stack.push(m);
      }
    });
  }
  return out;
}

const srgbToLinear = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};

/**
 * Linear sRGB → OKLab (Björn Ottosson). The skin tint works in OKLab because its
 * L is perceptual: a painted highlight or shadow is a step in L that reads the
 * same on porcelain and on ebony, where a ratio of linear light is not.
 */
export function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(Math.max(0, 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b));
  const m = Math.cbrt(Math.max(0, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b));
  const s = Math.cbrt(Math.max(0, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b));
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → linear sRGB (unclamped). */
export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * The tone a skin texel becomes, in OKLab — JS twin of the shader (for tests
 * and tools). `texelL` is the texel's OKLab L, `pageL` the page's mean skin L,
 * `tone` the chosen colour in OKLab. The texel's step from the page mean is
 * carried onto the tone: highlights scaled into the headroom the tone has left
 * (so porcelain never clips and ebony gets real highlights), shadows scaled
 * part-way with the tone's own lightness (so a dark tone's shadows stay
 * readable, not black). Hue and chroma come from the tone; chroma eases off
 * in deep shadow and grows up to 1.3× in highlights, so a lit cheekbone stays
 * warm instead of washing out grey.
 */
export function tonedSkin(
  texelL: number,
  pageL: number,
  tone: readonly [number, number, number],
  /** A whole-sheet tint (hair): the page's lightness spread, for the {@link TONE_FIT} rule instead of skin's. */
  fit?: { up: number; down: number } | null,
): [number, number, number] {
  const [Lt, at, bt] = tone;
  const d = texelL - pageL;
  const k = fit
    ? d > 0
      ? Math.min(1, (TONE_FIT.ceiling - Lt) / Math.max(1e-3, fit.up))
      : Math.min(1, (Lt - TONE_FIT.floor) / Math.max(1e-3, fit.down))
    : d > 0
      ? (1 - Lt) / Math.max(1e-3, 1 - pageL)
      : 1 + (Lt / Math.max(1e-3, pageL) - 1) * SHADOW_FOLLOW;
  const L = Math.min(1, Math.max(0, Lt + d * k));
  const c = Math.min(1.3, Math.max(0.55, L / Math.max(1e-3, Lt)));
  return [L, at * c, bt * c];
}

/** How far a shadow's depth follows the tone's own lightness (0 = the painted depth, 1 = proportional). */
const SHADOW_FOLLOW = 0.5;

/**
 * The whole-sheet rule (hair): the painted strand contrast is carried 1:1 onto
 * the colour, and only compressed where the colour lacks the headroom — the
 * page's 97th-percentile highlight must stay under `ceiling`, its 3rd-percentile
 * shadow over `floor`. So blond and grey keep their strands (a light colour
 * has room below it) and black keeps its sheen (room above).
 */
export const TONE_FIT = { ceiling: 0.95, floor: 0.05 } as const;

/** Mean OKLab L of every opaque texel and its spread (97th / 3rd percentile step) — a whole-sheet tint's reference. */
export function sheetLightness(rgba: ArrayLike<number>): { lightness: number; up: number; down: number } | null {
  const Ls: number[] = [];
  for (let i = 0; i * 4 < rgba.length; i++) {
    if (rgba[i * 4 + 3]! < 128) continue;
    Ls.push(linearToOklab(srgbToLinear(rgba[i * 4]!), srgbToLinear(rgba[i * 4 + 1]!), srgbToLinear(rgba[i * 4 + 2]!))[0]);
  }
  if (Ls.length === 0) return null;
  const lightness = Ls.reduce((a, b) => a + b, 0) / Ls.length;
  const d = Ls.map((l) => l - lightness).sort((a, b) => a - b);
  return {
    lightness,
    up: Math.max(1e-3, d[Math.floor((d.length - 1) * 0.97)]!),
    down: Math.max(1e-3, -d[Math.floor((d.length - 1) * 0.03)]!),
  };
}

/** Mean OKLab L of a page's skin texels — the lightness the tint measures each texel's shading from. */
export function skinLightness(rgba: ArrayLike<number>, mask: Uint8Array): number | null {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== SKIN_TONED) continue;
    sum += linearToOklab(srgbToLinear(rgba[i * 4]!), srgbToLinear(rgba[i * 4 + 1]!), srgbToLinear(rgba[i * 4 + 2]!))[0];
    count++;
  }
  return count > 0 ? sum / count : null;
}

/** Mean skin colour of a page in LINEAR rgb — what the tint maps onto the chosen tone. Null = no skin. */
export function skinReference(rgba: ArrayLike<number>, mask: Uint8Array): [number, number, number] | null {
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== SKIN_TONED) continue;
    r += srgbToLinear(rgba[i * 4]!);
    g += srgbToLinear(rgba[i * 4 + 1]!);
    b += srgbToLinear(rgba[i * 4 + 2]!);
    count++;
  }
  return count > 0 ? [r / count, g / count, b / count] : null;
}

interface SkinPage {
  /** R8: 255 skin, 192 half toned (a soft edge), 96 a dark feature line, 0 kept as painted; nearest, no mips. */
  mask: THREE.Texture;
  reference: [number, number, number];
  /** Mean OKLab L of the skin texels. */
  lightness: number;
  /** A whole-sheet tint's lightness spread ({@link TONE_FIT}); absent = the skin rule. */
  fit?: { up: number; down: number };
  texels: number;
}

/** Where a page's skin may be: each opted-in sheet's tile, or its parts' islands on it. */
export interface SkinRegions {
  /** Whole tiles (faces, the unequipped body), classified with {@link SKIN_CLASSIFIER}. */
  full: Uint8Array;
  /** Face tiles on the page (texel rects), for {@link protectMouth}. */
  faces: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  /** Part islands on armour sheets, classified with {@link SKIN_CLASSIFIER_TIGHT}. */
  parts: Uint8Array;
  missingTextures: string[];
}

/**
 * Rasterise the opted-in sheets onto a page of `width`×`height`: a sheet's
 * whole tile, or only the UV islands of the parts it names (read from the
 * model's geometry: `uv` in sheet space, the part index in `uv1`), grown by
 * one texel so an island's edge texels count. Pure: runs headless.
 */
export function skinRegions(
  width: number,
  height: number,
  tiles: Record<string, readonly number[]> | null | undefined,
  partIndex: Record<string, number> | null | undefined,
  sheets: readonly SkinSheet[],
  geometry?: THREE.BufferGeometry | null,
): SkinRegions {
  const full = new Uint8Array(width * height);
  const faces: SkinRegions["faces"] = [];
  const parts = new Uint8Array(width * height);
  const missingTextures: string[] = [];
  const uvAttr = geometry?.getAttribute("uv");
  const partAttr = geometry?.getAttribute("uv1");
  const index = geometry?.getIndex();
  const triangles = index ? index.count / 3 : (uvAttr?.count ?? 0) / 3;
  const vertex = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);
  for (const sheet of sheets) {
    const tile = tiles?.[sheet.texture];
    if (!tile) {
      missingTextures.push(sheet.texture);
      continue;
    }
    const u = tile[0] ?? 0;
    const v = tile[1] ?? 0;
    const s = tile[2] ?? 1;
    if (!sheet.parts) {
      const x0 = Math.max(0, Math.floor(u * width));
      const x1 = Math.min(width, Math.ceil((u + s) * width));
      const y0 = Math.max(0, Math.floor(v * height));
      const y1 = Math.min(height, Math.ceil((v + s) * height));
      for (let y = y0; y < y1; y++) full.fill(1, y * width + x0, y * width + x1);
      if (sheet.face) faces.push({ x0, y0, x1, y1 });
      continue;
    }
    if (!uvAttr || !partAttr) continue;
    const wanted = new Set(sheet.parts.map((p) => partIndex?.[p]).filter((i): i is number => i !== undefined));
    const island = new Uint8Array(width * height);
    for (let t = 0; t < triangles; t++) {
      if (!wanted.has(Math.round(partAttr.getX(vertex(t, 0))))) continue;
      const px: number[] = [];
      const py: number[] = [];
      for (let k = 0; k < 3; k++) {
        const i = vertex(t, k);
        px.push((uvAttr.getX(i) * s + u) * width);
        py.push((uvAttr.getY(i) * s + v) * height);
      }
      rasterTriangle(island, width, height, px, py);
    }
    // one texel of growth: nearest sampling reads the island's rim too
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!island[y * width + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx;
            const Y = y + dy;
            if (X >= 0 && Y >= 0 && X < width && Y < height) parts[Y * width + X] = 1;
          }
        }
      }
    }
  }
  return { full, parts, faces, missingTextures };
}

/** Mark every texel whose centre lies in the triangle (either winding). */
function rasterTriangle(out: Uint8Array, width: number, height: number, px: number[], py: number[]): void {
  const [ax, bx, cx] = px as [number, number, number];
  const [ay, by, cy] = py as [number, number, number];
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const qx = x + 0.5;
      const qy = y + 0.5;
      const w0 = ((bx - qx) * (cy - qy) - (by - qy) * (cx - qx)) / area;
      const w1 = ((cx - qx) * (ay - qy) - (cy - qy) * (ax - qx)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) out[y * width + x] = 1;
    }
  }
}

/**
 * Features carved out of the skin: a texel that stands out from the skin
 * around it (within {@link SKIN_FEATURES}.radius) keeps its painted colour at
 * every tone. On a 72 px face the eyes, brows, lash lines, nostrils and mouth
 * are painted in skin's own hue, only darker, so colour alone cannot find
 * them: a texel more than `darker` below its neighbourhood's OKLab L is a
 * feature line. Eye whites and irises drift in hue/saturation (a warm dull
 * white at 28°/0.48, a grey iris at 0.40), lips toward red (13°): a texel more
 * than `hue`/`sat` off its neighbourhood is a feature too — unless it is a
 * LIGHTER texel still on skin's hue (a highlight on the nose or a cheek,
 * which must follow the tone). The texels touching a feature go too when they
 * stand out by half as much: the soft rim of an eye or a lip.
 *
 * Two kinds, as mask values: {@link SKIN_KEEP} (0: eye whites, irises, lips —
 * the painted colour, always) and {@link SKIN_LINE} (2: the dark lines — the
 * painted colour or the toned one, whichever is DARKER, so a lash line stays a
 * line on porcelain and never turns into a pale speck on ebony).
 */
export const SKIN_FEATURES = { darker: 0.1, hue: 5.5, sat: 0.085, radius: 2, rim: 0.5 } as const;

/** Mask values: skin (toned), a dark feature line (the darker of painted/toned), kept as painted, half toned (a soft edge). */
export const SKIN_TONED = 1;
export const SKIN_SOFT = 3;
export const SKIN_LINE = 2;
export const SKIN_KEEP = 0;

function hsvOf(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max > 0 ? d / max : 0, max / 255];
}

/**
 * Mark facial features in a skin mask, in place (see {@link SKIN_FEATURES}):
 * dark lines become {@link SKIN_LINE}, colour features {@link SKIN_KEEP}.
 * Returns how many texels it changed.
 */
export function carveSkinFeatures(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  mask: Uint8Array,
  features: { darker: number; hue: number; sat: number; radius: number; rim: number } = SKIN_FEATURES,
): number {
  const n = width * height;
  const L = new Float32Array(n);
  const H = new Float32Array(n);
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!;
    L[i] = linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))[0];
    const [h, sat] = hsvOf(r, g, b);
    H[i] = h;
    S[i] = sat;
  }
  const R = features.radius;
  /** 0 = skin, 1 = a dark line, 2 = a colour feature. */
  const standsOut = (i: number, scale: number): 0 | 1 | 2 => {
    const x = i % width;
    const y = (i - x) / width;
    let sl = 0, sh = 0, ss = 0, c = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= width || Y >= height) continue;
        const j = Y * width + X;
        if (!mask[j]) continue;
        sl += L[j]!;
        sh += H[j]!;
        ss += S[j]!;
        c++;
      }
    }
    const dl = sl / c - L[i]!;
    const off = Math.abs(H[i]! - sh / c) > features.hue * scale || Math.abs(S[i]! - ss / c) > features.sat * scale;
    // a lighter texel still on skin's hue is a highlight, not a feature
    const { hue } = SKIN_CLASSIFIER.strong;
    const { sat } = SKIN_CLASSIFIER.weak;
    const highlight = dl < 0 && H[i]! >= hue[0] && H[i]! <= hue[1] && S[i]! >= sat[0] && S[i]! <= sat[1];
    if (off && !highlight) return 2;
    return dl > features.darker * scale ? 1 : 0;
  };
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (mask[i]) kind[i] = standsOut(i, 1);
  const rim: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i] || kind[i]) continue;
    const x = i % width;
    const near = (x > 0 && kind[i - 1]) || (x < width - 1 && kind[i + 1]) || (i >= width && kind[i - width]) || (i + width < n && kind[i + width]);
    if (!near) continue;
    const k = standsOut(i, features.rim);
    if (k) rim.push([i, k]);
  }
  let changed = 0;
  const mark = (i: number, k: number): void => {
    mask[i] = k === 2 ? SKIN_KEEP : SKIN_LINE;
    changed++;
  };
  for (let i = 0; i < n; i++) if (kind[i]) mark(i, kind[i]!);
  for (const [i, k] of rim) mark(i, k);
  return changed;
}

/**
 * Keep a face's MOUTH exactly as painted, with a soft edge. The head sheets are
 * painted on one layout (the key's marks), the face near the tile's centre
 * column, so the mouth is the LOWEST row of carved features (lines or kept
 * texels) at least 4 wide within 10 texels of that column, 45–85% down the tile:
 * the nostrils sit above it, chin marks are narrower. Every texel of the carved features
 * touching that row (8-connected, at most 4 rows up — lips are no taller) and
 * everything between them, row by row, becomes {@link SKIN_KEEP}: the lips
 * keep their painted colour. No growth beyond them (a grown box read as a pale
 * muzzle on dark tones); the ring of texels touching them becomes
 * {@link SKIN_SOFT} (half toned), so painted lips meet a dark tone through a
 * step, not a hard ring. Returns the protected box, or null when no mouth row
 * was found.
 */
export function protectMouth(
  mask: Uint8Array,
  width: number,
  face: { x0: number; y0: number; x1: number; y1: number },
): { x0: number; y0: number; x1: number; y1: number } | null {
  const size = face.y1 - face.y0;
  const cx = (face.x0 + face.x1) / 2;
  const band = 10;
  const xa = Math.max(face.x0, Math.floor(cx - band));
  const xb = Math.min(face.x1 - 1, Math.ceil(cx + band) - 1);
  const ya = face.y0 + Math.floor(size * 0.45);
  const yb = face.y0 + Math.ceil(size * 0.85);
  const carved = (x: number, y: number): boolean => {
    const v = mask[y * width + x];
    return v === SKIN_LINE || v === SKIN_KEEP;
  };
  const inFace = (x: number, y: number): boolean => x >= face.x0 && x < face.x1 && y >= face.y0 && y < face.y1;
  // the LOWEST row of carved features at least 4 wide: the lips (the nostrils sit above, chin marks are narrower)
  let bestY = -1;
  for (let y = yb; y >= ya && bestY < 0; y--) {
    let w = 0;
    for (let x = xa; x <= xb; x++) if (carved(x, y)) w++;
    if (w >= 4) bestY = y;
  }
  if (bestY < 0) return null;
  // the lips: carved texels connected to that row, at most 4 rows tall, near its middle
  let sx = 0, sn = 0;
  for (let x = xa; x <= xb; x++) if (carved(x, bestY)) (sx += x), sn++;
  const mid = sx / sn;
  const seen = new Set<number>();
  const stack: number[] = [];
  for (let x = xa; x <= xb; x++) if (carved(x, bestY) && Math.abs(x - mid) <= 5) stack.push(bestY * width + x);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const x = i % width;
    const y = (i - x) / width;
    bx0 = Math.min(bx0, x);
    bx1 = Math.max(bx1, x);
    by0 = Math.min(by0, y);
    by1 = Math.max(by1, y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (Math.abs(X - mid) > 5 || Y < bestY - 3 || Y > bestY || !carved(X, Y)) continue;
        stack.push(Y * width + X);
      }
    }
  }
  // the lips are the carved texels and everything between them, row by row
  const lips = new Set<number>();
  for (let y = by0; y <= by1; y++) {
    let lo = Infinity, hi = -Infinity;
    for (let x = bx0; x <= bx1; x++) {
      if (!seen.has(y * width + x)) continue;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    // a row with no carved texel of its own (between two lip lines) spans the whole mouth
    if (lo > hi) {
      lo = bx0;
      hi = bx1;
    }
    for (let x = lo; x <= hi; x++) lips.add(y * width + x);
  }
  for (const i of lips) mask[i] = SKIN_KEEP;
  for (const i of lips) {
    const x = i % width;
    for (const j of [i - 1, i + 1, i - width, i + width]) {
      const X = j % width;
      if (Math.abs(X - x) > 1 || !inFace(X, (j - X) / width) || lips.has(j)) continue;
      if (mask[j] === SKIN_TONED) mask[j] = SKIN_SOFT;
    }
  }
  return { x0: bx0, y0: by0, x1: bx1, y1: by1 };
}

/**
 * Classify a page's skin inside its opted-in regions: whole tiles loosely with
 * features carved out (faces), part islands tightly.
 */
export function classifyPageSkin(rgba: ArrayLike<number>, width: number, height: number, regions: SkinRegions): Uint8Array {
  const loose = classifySkin(rgba, width, height, SKIN_CLASSIFIER, regions.full);
  carveSkinFeatures(rgba, width, height, loose);
  for (const face of regions.faces) protectMouth(loose, width, face);
  const tight = classifySkin(rgba, width, height, SKIN_CLASSIFIER_TIGHT, regions.parts);
  for (let i = 0; i < loose.length; i++) if (tight[i]) loose[i] = SKIN_TONED;
  return loose;
}

/** What a page's skin is judged by: which sheets opted in, and the model they lie on. */
export interface SkinContext {
  sheets: readonly SkinSheet[];
  /**
   * The WHOLE sheet takes the tint — every opaque texel (hair: the hair, beard and
   * moustache ubermesh is nothing but hair). No classification, no features;
   * `sheets` is ignored.
   */
  whole?: boolean;
  /** Geometry with the part index (uv1), for sheets limited to parts. */
  geometry?: THREE.BufferGeometry | null;
  partIndex?: Record<string, number> | null;
}

const skinPages = new WeakMap<THREE.Texture, Map<string, SkinPage | null>>();

/** Pixels of a loaded texture's image, or null (headless, not decoded, cross-origin). */
function readPixels(map: THREE.Texture): { data: Uint8ClampedArray; width: number; height: number } | null {
  const image = map.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image || !image.width || !image.height) return null;
  try {
    const canvas: OffscreenCanvas | HTMLCanvasElement | null =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(image.width, image.height)
        : typeof document !== "undefined"
          ? Object.assign(document.createElement("canvas"), { width: image.width, height: image.height })
          : null;
    if (!canvas) return null;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    return { data: ctx.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
  } catch (error) {
    console.warn("[appearance] cannot read the page's pixels; skin tint disabled", error);
    return null;
  }
}

/**
 * The page's skin MASK (a small R8 texture beside the page — the page itself
 * is untouched, so its mips and alpha cut-outs stay exactly as baked) and its
 * mean skin colour, once per (page, opted-in sheets). Null when nothing opted
 * in is skin, or the page cannot be read.
 */
export function skinPageOf(
  map: THREE.Texture,
  context: SkinContext,
  tiles: Record<string, readonly number[]> | null | undefined,
): SkinPage | null {
  const key = context.whole ? "whole" : JSON.stringify(context.sheets);
  let byKey = skinPages.get(map);
  if (byKey?.has(key)) return byKey.get(key)!;
  let page: SkinPage | null = null;
  const pixels = context.whole || context.sheets.length > 0 ? readPixels(map) : null;
  if (pixels && context.whole) {
    const stats = sheetLightness(pixels.data);
    if (stats) {
      // every texel toned: the alpha cut-out already hides the rest, so a 1×1 white mask does
      const texture = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
      texture.name = `${map.name || "page"}#whole`;
      texture.needsUpdate = true;
      page = { mask: texture, reference: [0, 0, 0], lightness: stats.lightness, fit: { up: stats.up, down: stats.down }, texels: pixels.width * pixels.height };
    }
  } else if (pixels) {
    const regions = skinRegions(pixels.width, pixels.height, tiles, context.partIndex, context.sheets, context.geometry);
    for (const t of regions.missingTextures) console.warn(`[appearance] skin sheet "${t}" is not on the page`);
    const mask = classifyPageSkin(pixels.data, pixels.width, pixels.height, regions);
    const reference = skinReference(pixels.data, mask);
    if (reference) {
      let texels = 0;
      const r8 = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] === SKIN_TONED) r8[i] = 255;
        else if (mask[i] === SKIN_SOFT) r8[i] = 192;
        else if (mask[i] === SKIN_LINE) r8[i] = 96;
        else continue;
        texels++;
      }
      const texture = new THREE.DataTexture(r8, pixels.width, pixels.height, THREE.RedFormat, THREE.UnsignedByteType);
      texture.name = `${map.name || "page"}#skin`;
      texture.flipY = false; // the glTF convention, as the page beside it
      texture.wrapS = map.wrapS;
      texture.wrapT = map.wrapT;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      page = { mask: texture, reference, lightness: skinLightness(pixels.data, mask) ?? 0.5, texels };
    }
  }
  if (!byKey) skinPages.set(map, (byKey = new Map()));
  byKey.set(key, page);
  return page;
}

// ---------------------------------------------------------------------------
// the shader
// ---------------------------------------------------------------------------

/** `[u, v, scale]` per code: index 0 = `fallback`, then the model's tiles in {@link tileCodes} order. */
export function tileTableOf(
  tiles: Record<string, readonly number[]> | null | undefined,
  fallback: readonly [number, number, number],
): THREE.Vector4[] {
  const table = [new THREE.Vector4(fallback[0], fallback[1], fallback[2], 0)];
  for (const [id, code] of tileCodes(tiles)) {
    const t = tiles![id]!;
    table[code] = new THREE.Vector4(t[0] ?? 0, t[1] ?? 0, t[2] ?? 1, 0);
  }
  return table;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * The per-vertex tile `(u, v, scale)` from the part index and the character's
 * three code vec4s; code 0 → `fallback`. Returned as a varying.
 */
export function appearanceTileNode(codes: readonly [N, N, N], table: THREE.Vector4[], fallback: N): N {
  const tableNode = uniformArray(table, "vec4") as N;
  const tileAt = (Fn as N)((_: unknown, builder: { hasGeometryAttribute(name: string): boolean }) => {
    if (!builder.hasGeometryAttribute("uv1")) return vec3(fallback);
    const part = vec2(uv(1)).x.round();
    const slot = part.div(3).floor();
    const within = part.sub(slot.mul(3));
    const comps = [codes[0].x, codes[0].y, codes[0].z, codes[0].w, codes[1].x, codes[1].y, codes[1].z, codes[1].w, codes[2].x, codes[2].y, codes[2].z, codes[2].w];
    let packed: N = comps[0];
    for (let i = 1; i < comps.length; i++) packed = slot.equal(i).select(comps[i], packed);
    // exact powers of two, never pow(): exp2/log2 approximations floor wrong
    const shift = within.equal(0).select(float(1), within.equal(1).select(float(256), float(65536)));
    const shifted = packed.div(shift).floor();
    const code = shifted.sub(shifted.div(256).floor().mul(256));
    const entry = tableNode.element(code.clamp(0, table.length - 1).toInt());
    return code.lessThan(0.5).select(vec3(fallback), entry.xyz);
  })();
  return vertexStage(tileAt);
}

/**
 * The base colour: the page sampled at the part's tile, times the material
 * colour, with skin texels (the page's skin `mask`, sampled at the same UV)
 * recoloured to `tint` — the chosen tone in OKLab (L, a, b) + on flag — by
 * {@link tonedSkin}'s rule: the texel's step in perceptual lightness from the
 * page's mean skin, carried onto the tone.
 *
 * (The first version multiplied the tone by the texel's LINEAR-light ratio to
 * the mean and lifted highlights additively toward white. Linear ratios are
 * the painted ratios to the power 2.2, so a dark tone's shadows collapsed to
 * black, and the white lift washed its highlights grey — which the cool rim
 * and sky light then pushed violet.)
 */
export function appearanceColorNode(
  map: THREE.Texture,
  tile: N,
  tint: N,
  skin: { mask: THREE.Texture; lightness: number; fit?: { up: number; down: number } } | null,
  color?: THREE.Color | null,
): N {
  const sheet = uv().mul(tile.z).add(tile.xy);
  const texel = texture(map, sheet) as N;
  // The model material's OWN colour, bound as a uniform. A materialReference
  // resolves against whatever material is drawing — in a shadow pass that is
  // the ShadowMaterial, which has no colour, and the pass throws every frame.
  const base = (color ? uniform(color) : materialReference("color", "color")) as N;
  if (!skin) return vec4(texel.rgb.mul(base), texel.a);
  const kind = (texture(skin.mask, sheet) as N).r;
  const rgb0 = texel.rgb.max(0);
  // the texel's OKLab L
  const cbrt = (x: N): N => x.max(1e-9).pow(1 / 3);
  const l = cbrt(rgb0.dot(vec3(0.4122214708, 0.5363325363, 0.0514459929)));
  const m = cbrt(rgb0.dot(vec3(0.2119034982, 0.6806995451, 0.1073969566)));
  const s = cbrt(rgb0.dot(vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  const texelL = l.mul(0.2104542553).add(m.mul(0.793617785)).sub(s.mul(0.0040720468));
  // tonedSkin, on the GPU
  const pageL = float(skin.lightness);
  const Lt = tint.x.max(1e-3);
  const d = texelL.sub(pageL);
  const up = skin.fit
    ? float(TONE_FIT.ceiling).sub(Lt).div(skin.fit.up).min(1)
    : float(1).sub(Lt).div(Math.max(1e-3, 1 - skin.lightness));
  const down = skin.fit
    ? Lt.sub(TONE_FIT.floor).div(skin.fit.down).min(1)
    : float(1).add(Lt.div(Math.max(1e-3, skin.lightness)).sub(1).mul(SHADOW_FOLLOW));
  const L = Lt.add(d.mul(d.greaterThan(0).select(up, down))).clamp(0, 1);
  const c = L.div(Lt).clamp(0.55, 1.3);
  const A = tint.y.mul(c);
  const B = tint.z.mul(c);
  // OKLab → linear (x·x·x, not pow: pow of a negative is NaN in WGSL)
  const cube = (x: N): N => x.mul(x).mul(x);
  const l3 = cube(L.add(A.mul(0.3963377774)).add(B.mul(0.2158037573)));
  const m3 = cube(L.sub(A.mul(0.1055613458)).sub(B.mul(0.0638541728)));
  const s3 = cube(L.sub(A.mul(0.0894841775)).sub(B.mul(1.291485548)));
  const toned = vec3(
    l3.mul(4.0767416621).sub(m3.mul(3.3077115913)).add(s3.mul(0.2309699292)),
    l3.mul(-1.2684380046).add(m3.mul(2.6097574011)).sub(s3.mul(0.3413193965)),
    l3.mul(-0.0041960863).sub(m3.mul(0.7034186147)).add(s3.mul(1.707614701)),
  ).clamp(0, 1);
  // a feature line takes whichever is darker; skin always takes the tone
  const lum = vec3(0.2126, 0.7152, 0.0722);
  const lineTakes = toned.dot(lum).lessThan(texel.rgb.dot(lum)).select(float(1), float(0));
  const weight = kind
    .greaterThan(0.87)
    .select(float(1), kind.greaterThan(0.56).select(float(0.5), kind.greaterThan(0.2).select(lineTakes, float(0))))
    .mul(tint.w);
  // functional mix(a, b, t): the CHAINED `.mix(b, t)` is mix(b, t, this) in TSL
  const rgb = mix(texel.rgb, toned, weight);
  return vec4(rgb.mul(base), texel.a);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// non-instanced models: one shared material, per-object uniforms
// ---------------------------------------------------------------------------

const appearanceMaterials = new WeakMap<THREE.Material, Map<string, THREE.NodeMaterial>>();
const APPEARANCE_FLAG = "isAppearanceMaterial";
const warnedPages = new WeakSet<THREE.Material>();
const ZERO = new Float32Array(APPEARANCE_FLOATS);

/** One of the four vec4s of a mesh's appearance, refreshed per draw from `userData`. */
function objectSlot(k: number): THREE.UniformNode<"vec4", THREE.Vector4> {
  const node = uniform(new THREE.Vector4());
  return node.onObjectUpdate(({ object }) => {
    const data = (object?.userData[APPEARANCE_DATA] as Float32Array | undefined) ?? ZERO;
    return node.value.fromArray(data, k * 4);
  });
}

/** The map's own glTF transform as a tile: what code 0 draws. */
function defaultTile(map: THREE.Texture): [number, number, number] {
  return [map.offset.x, map.offset.y, map.repeat.x];
}

/**
 * The material every character wearing this model shares: `source` (the
 * model's own) with the per-part tile and skin tint in its colour node.
 * Cached per source material and per opted-in skin sheets; no `skin` (or no
 * sheet) skips the mask entirely.
 */
export function appearanceMaterial(
  source: THREE.Material,
  tiles: Record<string, readonly number[]> | null | undefined,
  opts: { skin?: SkinContext | null } = {},
): THREE.Material {
  if (source.userData[APPEARANCE_FLAG] === true) return source;
  const sheets = opts.skin?.sheets ?? [];
  const whole = opts.skin?.whole === true;
  const key = whole ? "whole" : sheets.length ? JSON.stringify(sheets) : "plain";
  let byKey = appearanceMaterials.get(source);
  const cached = byKey?.get(key);
  if (cached) return cached;
  const map = (source as THREE.MeshStandardMaterial).map;
  if (!map) return source;
  // RULE: a page is square — a tile is [u, v, scale] with ONE scale (tools/_page.mjs)
  const img = map.image as { width?: number; height?: number } | undefined;
  if (tiles && img?.width && img.height && img.width !== img.height && !warnedPages.has(source)) {
    warnedPages.add(source);
    console.warn(`[appearance] a ${img.width}x${img.height} page: pages must be SQUARE (tiles carry one scale), every island will sample off — re-bake it with weapon-page/body-page`);
  }
  const material = asNodeMaterial(cloneMaterial(source));
  const page = whole || sheets.length ? skinPageOf(map, opts.skin!, tiles) : null;
  const codes = [objectSlot(0), objectSlot(1), objectSlot(2)] as const;
  const tint = objectSlot(3);
  const fallback = defaultTile(map);
  const tile = appearanceTileNode(codes, tileTableOf(tiles, fallback), vec3(...fallback));
  // the page is sampled at explicit tile UVs, never through the map's own transform
  material.colorNode = appearanceColorNode(map, tile, tint, page, (material as unknown as { color?: THREE.Color }).color ?? null);
  material.name = `${source.name}#appearance`;
  material.userData[APPEARANCE_FLAG] = true;
  material.needsUpdate = true;
  if (!byKey) appearanceMaterials.set(source, (byKey = new Map()));
  byKey.set(key, material);
  return material;
}

/** `tiles` extras of the first node under `root` that carries them. */
export function modelTileTable(root: THREE.Object3D): Record<string, [number, number, number]> | null {
  let found: Record<string, [number, number, number]> | null = null;
  root.traverse((node) => {
    if (!found && node.userData["tiles"] && typeof node.userData["tiles"] === "object") {
      found = node.userData["tiles"] as Record<string, [number, number, number]>;
    }
  });
  return found;
}

function modelParts(root: THREE.Object3D): Record<string, number> | null {
  let found: Record<string, number> | null = null;
  root.traverse((node) => {
    if (!found && node.userData["parts"] && typeof node.userData["parts"] === "object") found = node.userData["parts"] as Record<string, number>;
  });
  return found;
}

/**
 * Dress a (non-instanced) model with a look: every mesh carrying a part index
 * switches to the model's shared appearance material and carries the look's
 * floats. Parts not named by any group are NOT hidden here — hiding is the
 * index rebuild's job (applyModelPartMask, or the creator's own filter); use
 * the returned `shown` for it. A look with no groups keeps every part on the
 * default tile.
 *
 * `skin` lists the sheets of this model that paint bare skin (opt-in, see
 * {@link SkinSheet}); pass the SAME list for every character wearing the
 * model (every sheet any of them may wear), or each list is its own material.
 * `geometry` is the whole model's geometry when the mesh's own is a trimmed
 * copy (part islands are read from it).
 */
export function applyModelAppearance(
  root: THREE.Object3D,
  look: AppearanceLook,
  opts: {
    skin?: readonly SkinSheet[] | null;
    geometry?: THREE.BufferGeometry | null;
    /** The whole sheet takes `skinTint` (hair) instead of opted-in skin texels. */
    tintWhole?: boolean;
  } = {},
): EncodedAppearance & { meshes: number } {
  const tiles = modelTileTable(root);
  const partIndex = modelParts(root);
  const encoded = encodeAppearance(partIndex, tileCodes(tiles), look);
  let meshes = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material || Array.isArray(mesh.material)) return;
    const skin = opts.tintWhole
      ? { sheets: [], whole: true }
      : opts.skin?.length
        ? { sheets: opts.skin, partIndex, geometry: opts.geometry ?? mesh.geometry }
        : null;
    mesh.material = appearanceMaterial(mesh.material, tiles, { skin });
    mesh.userData[APPEARANCE_DATA] = encoded.data.slice();
    meshes++;
  });
  return { ...encoded, meshes };
}
