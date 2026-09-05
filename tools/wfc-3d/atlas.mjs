/**
 * Incremental texture atlas for kit modules.
 *
 * Every texture a module embeds (and every flat material colour, as a small
 * solid island) is deduplicated by CONTENT hash and packed onto square pages.
 * The layout is persisted beside the PNGs so a re-import never moves an
 * island that already exists — a new texture lands in free space and only a
 * full page starts another. Deterministic: same inputs, same layout.
 *
 * Islands carry a wrap bleed: `pad` pixels around each one copied from the
 * opposite edge, so a texture that tiles from cell to cell (a plank floor)
 * still samples its own continuation in the mip chain instead of a
 * neighbouring island. Islands never tile INSIDE the atlas — a module face
 * that relies on UV wrap cannot be atlased, and `remapUv` reports it.
 */
import crypto from "node:crypto";
import { decodePng, encodePng } from "./png.mjs";

export const DEFAULT_PAGE = 2048;
export const DEFAULT_PAD = 4;
/** Occupancy granularity in pixels; islands are placed on this grid. */
const CELL = 4;

export function hashRgba(width, height, rgba) {
  const h = crypto.createHash("sha1");
  h.update(`${width}x${height}:`);
  h.update(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  return h.digest("hex").slice(0, 16);
}

/** A 4x4 solid island for an untextured material colour (linear RGBA 0..1 → sRGB8). */
export function solidImage(rgba01) {
  const width = 4;
  const height = 4;
  const rgba = new Uint8Array(width * height * 4);
  const toByte = (linear) => {
    const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  const px = [toByte(rgba01[0]), toByte(rgba01[1]), toByte(rgba01[2]), Math.round(Math.max(0, Math.min(1, rgba01[3] ?? 1)) * 255)];
  for (let i = 0; i < rgba.length; i += 4) rgba.set(px, i);
  return { width, height, rgba };
}

export class Atlas {
  /**
   * @param {{ pageSize?: number, pad?: number, layout?: any }} options `layout` is a
   * previously saved `toLayout()` document; islands in it keep their places.
   */
  constructor({ pageSize = DEFAULT_PAGE, pad = DEFAULT_PAD, layout = null } = {}) {
    this.pageSize = layout?.pageSize ?? pageSize;
    this.pad = layout?.pad ?? pad;
    /** @type {{ islands: Map<string, {x:number,y:number,w:number,h:number}>, occupancy: Uint8Array }[]} */
    this.pages = [];
    /** @type {Map<string, {page:number,x:number,y:number,w:number,h:number}>} */
    this.islands = new Map();
    /** @type {Map<string, {width:number,height:number,rgba:Uint8Array}>} pixels for islands added this run */
    this.pixels = new Map();
    /** hashes referenced by the previous layout but whose pixels we have not seen this run */
    this.stale = new Set();
    if (layout) {
      for (const [hash, island] of Object.entries(layout.islands ?? {})) {
        while (this.pages.length <= island.page) this.pages.push(this.newPage());
        this.place(island.page, hash, island.x, island.y, island.w, island.h);
        this.stale.add(hash);
      }
    }
  }

  newPage() {
    const n = this.pageSize / CELL;
    return { islands: new Map(), occupancy: new Uint8Array(n * n) };
  }

  place(page, hash, x, y, w, h) {
    const p = this.pages[page];
    const n = this.pageSize / CELL;
    const outer = this.pad;
    const x0 = Math.floor((x - outer) / CELL);
    const y0 = Math.floor((y - outer) / CELL);
    const x1 = Math.ceil((x + w + outer) / CELL);
    const y1 = Math.ceil((y + h + outer) / CELL);
    for (let cy = y0; cy < y1; cy++) for (let cx = x0; cx < x1; cx++) p.occupancy[cy * n + cx] = 1;
    const island = { page, x, y, w, h };
    p.islands.set(hash, island);
    this.islands.set(hash, island);
  }

  /**
   * Register an image; returns its island. Identical pixels share one island.
   * @param {{width:number,height:number,rgba:Uint8Array}} image
   */
  add(image) {
    const hash = hashRgba(image.width, image.height, image.rgba);
    this.stale.delete(hash);
    if (!this.pixels.has(hash)) this.pixels.set(hash, image);
    const existing = this.islands.get(hash);
    if (existing) return { hash, ...existing };
    const w = image.width;
    const h = image.height;
    const footprint = Math.ceil((w + 2 * this.pad) / CELL);
    const footprintH = Math.ceil((h + 2 * this.pad) / CELL);
    const n = this.pageSize / CELL;
    if (footprint > n || footprintH > n) {
      throw new Error(`texture ${w}x${h} does not fit a ${this.pageSize}px atlas page (with ${this.pad}px bleed)`);
    }
    for (let page = 0; ; page++) {
      if (page === this.pages.length) this.pages.push(this.newPage());
      const spot = this.findSpot(this.pages[page], footprint, footprintH);
      if (spot) {
        const x = spot[0] * CELL + this.pad;
        const y = spot[1] * CELL + this.pad;
        this.place(page, hash, x, y, w, h);
        return { hash, page, x, y, w, h };
      }
    }
  }

  /** First-fit scan, row-major, over the occupancy grid. */
  findSpot(page, fw, fh) {
    const n = this.pageSize / CELL;
    const occ = page.occupancy;
    for (let y = 0; y + fh <= n; y++) {
      for (let x = 0; x + fw <= n; x++) {
        let free = true;
        scan: for (let dy = 0; dy < fh; dy++) {
          const row = (y + dy) * n;
          for (let dx = 0; dx < fw; dx++) {
            if (occ[row + x + dx]) {
              free = false;
              break scan;
            }
          }
        }
        if (free) return [x, y];
      }
    }
    return null;
  }

  /**
   * Map a module UV onto its island. `u`/`v` in [0, 1] (glTF: v down, same as
   * image rows, so no flip). Values outside the island by more than `eps`
   * mean the face relied on wrap; the caller reports it and we clamp.
   */
  remapUv(island, u, v) {
    const W = this.pageSize;
    return [(island.x + u * island.w) / W, (island.y + v * island.h) / W];
  }

  /** Render one page to RGBA8 with wrap bleed around every island. */
  renderPage(page) {
    const S = this.pageSize;
    const out = new Uint8Array(S * S * 4);
    const pad = this.pad;
    for (const [hash, island] of this.pages[page].islands) {
      const image = this.pixels.get(hash);
      if (!image) continue; // stale island: pixels not seen this run, left transparent
      const { w, h, x, y } = island;
      for (let py = -pad; py < h + pad; py++) {
        const sy = ((py % h) + h) % h;
        const ty = y + py;
        if (ty < 0 || ty >= S) continue;
        for (let px = -pad; px < w + pad; px++) {
          const sx = ((px % w) + w) % w;
          const tx = x + px;
          if (tx < 0 || tx >= S) continue;
          const s = (sy * w + sx) * 4;
          const t = (ty * S + tx) * 4;
          out[t] = image.rgba[s];
          out[t + 1] = image.rgba[s + 1];
          out[t + 2] = image.rgba[s + 2];
          out[t + 3] = image.rgba[s + 3];
        }
      }
    }
    return out;
  }

  /** PNG bytes per page, index-aligned with `pages`. */
  encodePages() {
    return this.pages.map((_, page) => encodePng(this.pageSize, this.pageSize, this.renderPage(page)));
  }

  /** Serializable layout: pass back as `layout` next run to keep islands fixed. */
  toLayout() {
    const islands = {};
    for (const [hash, island] of [...this.islands].sort(([a], [b]) => (a < b ? -1 : 1))) islands[hash] = island;
    return { version: 1, pageSize: this.pageSize, pad: this.pad, pages: this.pages.length, islands };
  }
}

/** Decode a PNG into the `{width,height,rgba}` shape `Atlas.add` wants. */
export function decodeImage(bytes, mimeType) {
  if (mimeType && mimeType !== "image/png") {
    throw new Error(`only PNG textures can be atlased (got ${mimeType}); re-export the module with PNG textures`);
  }
  const png = decodePng(bytes);
  return { width: png.width, height: png.height, rgba: png.data };
}
