/**
 * Shared icon steps for item-icon.mjs (rendered gear) and loot-sheet.mjs
 * (generated loot sheets): every inventory icon, whichever route made it, ends
 * up the same size, cropped the same way, with the same hard edge.
 *
 * Images here are { width, height, data: Uint8Array RGBA }, except the
 * supersampled working buffers, which are { width, height, rgba: Float32Array }.
 */
import fs from "node:fs";
import { encodePng } from "./_png.mjs";

/** Supersampling factor: work at SS x the icon size, box-filter down. */
export const SS = 8;

/** Box-filter by `f`, colour averaged over covered samples only, alpha thresholded at half coverage, cropped. */
export function downsample(img, f = SS) {
  const w = Math.floor(img.width / f), h = Math.floor(img.height / f);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let j = 0; j < f; j++)
        for (let i = 0; i < f; i++) {
          const o = ((y * f + j) * img.width + x * f + i) * 4;
          if (img.rgba[o + 3] < 128) continue;
          r += img.rgba[o]; g += img.rgba[o + 1]; b += img.rgba[o + 2]; n++;
        }
      const o = (y * w + x) * 4;
      if (n * 2 < f * f) continue;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  return crop({ width: w, height: h, data: out });
}

/** Trim to the opaque pixels plus a 1 px margin (the outline's room). */
export function crop(img) {
  let x0 = img.width, x1 = -1, y0 = img.height, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] > 0) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
  if (x1 < 0) throw new Error("empty icon");
  const w = x1 - x0 + 3, h = y1 - y0 + 3;
  const data = new Uint8Array(w * h * 4);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const s = (y * img.width + x) * 4, d = ((y - y0 + 1) * w + (x - x0 + 1)) * 4;
      for (let c = 0; c < 4; c++) data[d + c] = img.data[s + c];
    }
  return { width: w, height: h, data };
}

/** A 1 px near-black ring around the silhouette, so dark gear still reads on a dark slot. */
export function outline(img) {
  const { width: w, height: h, data } = img;
  const out = Uint8Array.from(data);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3]) continue;
      let near = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h && data[(Y * w + X) * 4 + 3]) near = true;
      }
      if (near) { out[o] = 12; out[o + 1] = 10; out[o + 2] = 9; out[o + 3] = 255; }
    }
  return { width: w, height: h, data: out };
}

/**
 * Which pixels are GROUND: flooded in from the border through near-white
 * (min channel > `lum`) or transparent pixels. Painted white inside an object
 * is enclosed and survives; a white highlight touching the edge does not.
 */
export function groundMask(img, lum = 235) {
  const { width: w, height: h, data } = img;
  const ground = new Uint8Array(w * h);
  const isGround = (i) => data[i * 4 + 3] < 128 || Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) > lum;
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (ground[i] || !isGround(i)) continue;
    ground[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return ground;
}

/**
 * The pixels of `img` where `keep(i)` is true → an icon whose longest side is
 * `size`: nearest-resampled to size*SS, then the shared downsample.
 */
export function iconFromPixels(img, keep, size) {
  const { width: w, height: h, data } = img;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (!keep(i)) continue;
    const x = i % w, y = (i / w) | 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new Error("nothing in the picture but ground");
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const k = ((size - 2) * SS) / Math.max(bw, bh);
  const W = Math.ceil(bw * k) + 2 * SS, H = Math.ceil(bh * k) + 2 * SS;
  const big = new Float32Array(W * H * 4);
  for (let y = SS; y < H - SS; y++)
    for (let x = SS; x < W - SS; x++) {
      const sx = Math.min(w - 1, x0 + Math.floor((x - SS) / k)), sy = Math.min(h - 1, y0 + Math.floor((y - SS) / k));
      const s = sy * w + sx;
      if (!keep(s)) continue;
      const d = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) big[d + c] = data[s * 4 + c];
      big[d + 3] = 255;
    }
  return downsample({ width: W, height: H, rgba: big });
}

// ---------------------------------------------------------------- colour

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
  }
  return [((hh * 60) + 360) % 360, max ? d / max : 0, max];
}
function hsvToRgb(hh, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * A recoloured copy: the red potion becomes blue, the ruby a sapphire.
 *
 * Only COLOURED pixels move — saturation above `minSat` and, when `band` is
 * given, a hue inside [from, to] (degrees, wrapping). Glass highlights, corks,
 * iron settings and grey rock keep their colour, which is what makes a tint
 * read as the same object in another colour instead of a filter over it.
 *
 *   hue     degrees to rotate the selected hues by, or `to` to set them
 *   sat     multiply saturation (0 = grey: the "dull"/"cursed" variant)
 *   val     multiply brightness
 */
export function recolor(img, { hue = 0, setHue, sat = 1, val = 1, minSat = 0.25, band } = {}) {
  const out = Uint8Array.from(img.data);
  const inBand = (hh) => !band || (band[0] <= band[1] ? hh >= band[0] && hh <= band[1] : hh >= band[0] || hh <= band[1]);
  for (let o = 0; o < out.length; o += 4) {
    if (!out[o + 3]) continue;
    const [hh, s, v] = rgbToHsv(out[o], out[o + 1], out[o + 2]);
    if (s < minSat || !inBand(hh)) continue;
    const nh = setHue !== undefined ? setHue : (hh + hue + 360) % 360;
    const [r, g, b] = hsvToRgb(nh, Math.min(1, s * sat), Math.min(1, v * val));
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
  }
  return { width: img.width, height: img.height, data: out };
}

// ---------------------------------------------------------------- looking at them

/** A zoomed grid of icons on a slot-dark ground, `cols` across. */
export function writeContactSheet(file, icons, { zoom = 6, cols = 12 } = {}) {
  const GAP = 8;
  const cw = Math.max(...icons.map((i) => i.width)) * zoom, ch = Math.max(...icons.map((i) => i.height)) * zoom;
  const n = Math.min(cols, icons.length), rows = Math.ceil(icons.length / cols);
  const W = n * (cw + GAP) + GAP, H = rows * (ch + GAP) + GAP;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = 28; img[i + 1] = 26; img[i + 2] = 30; img[i + 3] = 255; }
  icons.forEach((icon, k) => {
    const ox = GAP + (k % cols) * (cw + GAP) + ((cw - icon.width * zoom) >> 1);
    const oy = GAP + Math.floor(k / cols) * (ch + GAP) + ((ch - icon.height * zoom) >> 1);
    for (let y = 0; y < icon.height * zoom; y++)
      for (let x = 0; x < icon.width * zoom; x++) {
        const s = (((y / zoom) | 0) * icon.width + ((x / zoom) | 0)) * 4;
        if (!icon.data[s + 3]) continue;
        const d = ((oy + y) * W + ox + x) * 4;
        for (let c = 0; c < 3; c++) img[d + c] = icon.data[s + c];
      }
  });
  fs.writeFileSync(file, encodePng(W, H, img));
}

// ---------------------------------------------------------------- backdrop

/** Deterministic 32-bit hash of a string: the same item always gets the same backdrop. */
export function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function lattice(seed, x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Smooth value noise, 0..1. */
function valueNoise(seed, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = lattice(seed, xi, yi), b = lattice(seed, xi + 1, yi), c = lattice(seed, xi, yi + 1), d = lattice(seed, xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(seed, x, y) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 3; o++) { v += amp * valueNoise(seed + o * 101, x * f, y * f); amp *= 0.5; f *= 2; }
  return v / 0.875;
}

export const hexRgb = (hex) => { const n = parseInt(hex.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** Muted backdrop tints for items whose rarity colour says nothing (common = grey). */
export const BACKDROP_PALETTE = ["#c8792e", "#2e9aa0", "#b23a48", "#7a5cc0", "#6c9a3a", "#c0a040", "#3a6cc0"];

/**
 * The tint that makes this object POP: the palette colour whose hue is furthest
 * from the object's own (saturation-weighted mean hue). A grey object — steel,
 * stone — has no hue to avoid, so the seed picks.
 */
export function contrastTint(icon, seed, palette = BACKDROP_PALETTE) {
  let sx = 0, sy = 0, w = 0;
  for (let o = 0; o < icon.data.length; o += 4) {
    if (!icon.data[o + 3]) continue;
    const [hh, s, v] = rgbToHsv(icon.data[o], icon.data[o + 1], icon.data[o + 2]);
    const k = s * v;
    sx += Math.cos((hh * Math.PI) / 180) * k; sy += Math.sin((hh * Math.PI) / 180) * k; w += k;
  }
  const strength = Math.hypot(sx, sy) / Math.max(1e-6, w);
  if (w < 1e-6 || strength * (w / (icon.width * icon.height)) < 0.05) return palette[seed % palette.length];
  const mean = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
  let best = palette[0], bestD = -1;
  palette.forEach((hex, i) => {
    const [r, g, b] = hexRgb(hex);
    const d = Math.abs((((rgbToHsv(r, g, b)[0] - mean) % 360) + 540) % 360 - 180);
    const score = d + ((seed >> i) & 7); // a nudge so near-ties vary per item
    if (score > bestD) { bestD = score; best = hex; }
  });
  return best;
}

/**
 * Put an icon on an opaque backdrop so it pops in the cell: a dark ground in
 * `tint`, mottled by fractal value noise, a soft glow of the tint behind the
 * object, a vignette toward the edges, the object outlined 1 px dark. Grown by
 * `pad` px each side. Posterised to a few steps so it reads as painted pixels,
 * not a smooth gradient. `seed` makes it repeatable per item.
 */
export function backdrop(icon, { seed = 1, tint = "#6a5a8a", pad = 2 } = {}) {
  const src = outline(icon);
  const w = src.width + pad * 2, h = src.height + pad * 2;
  const data = new Uint8Array(w * h * 4);
  const [tr, tg, tb] = hexRgb(tint);
  const cx = (w - 1) / 2, cy = (h - 1) / 2, rmax = Math.hypot(cx, cy);
  const ox = (seed % 997) * 0.37, oy = ((seed >> 10) % 997) * 0.37;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - cx, y - cy) / rmax;
      const n = fbm(seed, x / 7 + ox, y / 7 + oy);
      const glow = Math.max(0, 1 - r * 1.4) ** 1.6;
      let v = 0.14 + 0.2 * n + 0.42 * glow - 0.12 * r * r;
      v = Math.round(Math.max(0.04, v) * 7) / 7; // posterise: a handful of painted steps
      const o = (y * w + x) * 4;
      data[o] = Math.min(255, 8 + tr * v);
      data[o + 1] = Math.min(255, 7 + tg * v);
      data[o + 2] = Math.min(255, 9 + tb * v);
      data[o + 3] = 255;
    }
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      if (!src.data[s + 3]) continue;
      const d = ((y + pad) * w + x + pad) * 4;
      for (let c = 0; c < 4; c++) data[d + c] = src.data[s + c];
    }
  return { width: w, height: h, data };
}
