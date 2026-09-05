/**
 * The narrowest DOM three needs to load an FBX and write a GLB in Node.
 *
 * Import this BEFORE three (ESM runs side-effect imports in order, so
 * `import "./node-dom-shim.mjs"` on the line above `import * as THREE` is
 * enough). Two jobs:
 *
 * 1. `ImageLoader` builds an `<img>` and waits for a load event. We hand it a
 *    stand-in that reads the file off disk and reports the PNG/JPEG's real
 *    dimensions — never decoding a pixel, because nothing here needs pixels.
 * 2. `GLTFExporter` draws each texture into a `<canvas>` and asks for the
 *    encoded bytes. Our canvas records which image was drawn and hands back
 *    that file's ORIGINAL bytes, so the texture lands in the GLB byte-for-byte
 *    — no re-encode, no quality loss, and no image codec in this repo.
 *
 * The pass-through is only correct because the exporter is asked for the same
 * format the file already is, and because the caller sets `texture.flipY =
 * false` (see retarget.mjs, which flips the mesh UVs instead — the equivalent
 * transform, done on 3k vertices rather than a 1024² image).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Roots searched when a texture URL doesn't resolve directly. */
const searchRoots = [];

export function addTextureSearchRoot(dir) {
  if (dir && !searchRoots.includes(dir)) searchRoots.push(dir);
}

function urlToPath(url) {
  let p = String(url);
  if (p.startsWith("file://")) {
    try {
      return fileURLToPath(p);
    } catch {
      p = p.slice("file://".length);
    }
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    /* already decoded */
  }
  return p;
}

/** Depth-limited hunt for a basename — FBX texture paths are often stale absolute ones. */
function findByBasename(root, base, depth = 3) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === base.toLowerCase()) return path.join(root, e.name);
  }
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findByBasename(path.join(root, e.name), base, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function resolveTexture(url) {
  const direct = urlToPath(url);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const base = path.basename(direct);
  for (const root of searchRoots) {
    const hit = findByBasename(root, base);
    if (hit) return hit;
  }
  return null;
}

/** width/height straight out of the container header. No decode. */
function imageSize(bytes) {
  // PNG: 8-byte signature, then a 4-byte length + "IHDR" + width/height as BE u32
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mime: "image/png" };
  }
  // JPEG: walk the segment chain to the SOFn frame header
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      // SOF0..SOF15, skipping the non-frame markers DHT/JPG/DAC in that range
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7), mime: "image/jpeg" };
      }
      i += 2 + len;
    }
  }
  return { width: 1, height: 1, mime: "image/png" };
}

class ShimImage {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.bytes = null;
    this.mime = "image/png";
    this.resolvedPath = null;
    this._listeners = { load: [], error: [] };
  }
  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this._listeners[type];
    if (l) this._listeners[type] = l.filter((f) => f !== fn);
  }
  _fire(type) {
    // `this` must be the element: three's ImageLoader forwards it as the loaded image
    for (const fn of [...(this._listeners[type] ?? [])]) fn.call(this, { type, target: this });
  }
  set src(url) {
    this._src = url;
    const file = resolveTexture(url);
    if (!file) {
      console.warn(`[dom-shim] texture not found: ${url}`);
      this._fire("error");
      return;
    }
    this.resolvedPath = file;
    this.bytes = fs.readFileSync(file);
    const size = imageSize(this.bytes);
    this.width = size.width;
    this.height = size.height;
    this.mime = size.mime;
    // ImageLoader attaches its listeners before assigning src, so firing here
    // is not a race — it is the whole point.
    this._fire("load");
  }
  get src() {
    return this._src;
  }
}

class ShimCanvas {
  constructor() {
    this.width = 1;
    this.height = 1;
    this._drawn = null;
  }
  getContext() {
    const canvas = this;
    return {
      canvas,
      translate() {},
      scale() {},
      drawImage(image) {
        canvas._drawn = image;
      },
      putImageData() {
        throw new Error("[dom-shim] DataTexture export needs a real canvas; none is available in Node.");
      },
    };
  }
  toBlob(callback, mimeType) {
    const image = this._drawn;
    if (!image?.bytes) {
      callback(null);
      return;
    }
    if (mimeType && image.mime && mimeType !== image.mime) {
      // Pass-through only works when the requested format is the stored one.
      console.warn(
        `[dom-shim] asked for ${mimeType} but the source is ${image.mime}; writing the original bytes.`,
      );
    }
    callback(new Blob([image.bytes], { type: image.mime }));
  }
  toDataURL() {
    const image = this._drawn;
    if (!image?.bytes) return "data:,";
    return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
  }
}

/** GLTFExporter reads its encoded textures back out of a Blob through one of these. */
class ShimFileReader {
  constructor() {
    this.result = null;
    this.onloadend = null;
  }
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.({ target: this });
    });
  }
}

globalThis.FileReader ??= ShimFileReader;
globalThis.HTMLImageElement ??= ShimImage;
globalThis.HTMLCanvasElement ??= ShimCanvas;
globalThis.self ??= globalThis;
globalThis.document ??= {
  createElementNS(_ns, name) {
    return this.createElement(name);
  },
  createElement(name) {
    if (name === "canvas") return new ShimCanvas();
    return new ShimImage();
  },
};

export { ShimImage, ShimCanvas, ShimFileReader };
