// Minimal zero-dep PNG codec (vendored from tools/texture-intake/png.mjs so
// playground tooling stays self-contained when tool plugins are not installed). Decodes 8-bit gray/rgb/palette/gray-a/rgba
// (non-interlaced) to RGBA8; encodes RGBA8. Node's zlib does the heavy lifting.
import zlib from "node:zlib";

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** @returns {{width:number,height:number,data:Uint8Array}} data is RGBA8 */
export function decodePng(buf) {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error("not a PNG");
  let pos = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") trns = Buffer.from(body);
    else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported bit depth ${ihdr.bitDepth}`);
  if (ihdr.interlace !== 0) throw new Error("interlaced PNG unsupported");
  const ch = CHANNELS[ihdr.colorType];
  if (!ch) throw new Error(`unsupported color type ${ihdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const stride = w * ch;
  const px = new Uint8Array(h * stride);

  // undo per-scanline filters (PNG spec 9.2)
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const rawv = raw[rp + x];
      const a = x >= ch ? px[row + x - ch] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = x >= ch && y > 0 ? px[prev + x - ch] : 0;
      let v;
      switch (filter) {
        case 0: v = rawv; break;
        case 1: v = rawv + a; break;
        case 2: v = rawv + b; break;
        case 3: v = rawv + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rawv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      px[row + x] = v & 0xff;
    }
    rp += stride;
  }

  // expand to RGBA8
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * ch, d = i * 4;
    switch (ihdr.colorType) {
      case 0: out[d] = out[d + 1] = out[d + 2] = px[s]; out[d + 3] = 255; break;
      case 2: out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = 255; break;
      case 3: {
        const p = px[s] * 3;
        out[d] = palette[p]; out[d + 1] = palette[p + 1]; out[d + 2] = palette[p + 2];
        out[d + 3] = trns && px[s] < trns.length ? trns[px[s]] : 255;
        break;
      }
      case 4: out[d] = out[d + 1] = out[d + 2] = px[s]; out[d + 3] = px[s + 1]; break;
      case 6: out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3]; break;
    }
  }
  return { width: w, height: h, data: out };
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from(SIG),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
