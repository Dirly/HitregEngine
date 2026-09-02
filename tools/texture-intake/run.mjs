/**
 * Texture intake tool: the on-ramp from image-generator output to a
 * game-ready, tileable texture family plus a theme data-asset slot.
 *
 * Pipeline: decode PNG -> (optional) offset-wrap seamless pass ->
 * (optional) luma-derived normal map -> write textures/<name>.png family ->
 * (optional) create/update themes/<theme>.json slot -> 3x3 tiled preview.
 *
 * Self-contained: pure node (zlib via local png.mjs), no npm deps,
 * deterministic. Same host contract as tools/atlas:
 *   run({ runDir, writeAsset }, inputs) -> ToolResult
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./png.mjs";

const NAME_RE = /^[a-z0-9][a-z0-9/_-]*$/;
const THEME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Mirrors THEME_SLOTS / REQUIRED_THEME_SLOTS in packages/core/src/theme.ts
 * (water is the only optional slot). Kept inline: tools are self-contained. */
const REQUIRED_THEME_SLOTS = [
  "floor", "wall", "ceiling", "trim", "accent", "rock", "wood", "metal", "step",
];

const smooth = (t) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------
// Seam measurement + seamless pass
// ---------------------------------------------------------------------------

/**
 * Mean absolute RGB difference across the two wrap seams a tiling texture
 * has: left column vs right column (horizontal wrap) and top row vs bottom
 * row (vertical wrap). Near-zero (comparable to a neighbour-pixel step)
 * means the texture tiles without a visible line.
 */
export function measureSeams({ width: w, height: h, data }) {
  let hSum = 0;
  for (let y = 0; y < h; y++) {
    const a = y * w * 4;
    const b = (y * w + w - 1) * 4;
    hSum +=
      Math.abs(data[a] - data[b]) +
      Math.abs(data[a + 1] - data[b + 1]) +
      Math.abs(data[a + 2] - data[b + 2]);
  }
  let vSum = 0;
  for (let x = 0; x < w; x++) {
    const a = x * 4;
    const b = ((h - 1) * w + x) * 4;
    vSum +=
      Math.abs(data[a] - data[b]) +
      Math.abs(data[a + 1] - data[b + 1]) +
      Math.abs(data[a + 2] - data[b + 2]);
  }
  const horizontal = h > 0 ? hSum / (h * 3) : 0;
  const vertical = w > 0 ? vSum / (w * 3) : 0;
  return {
    horizontal: Math.round(horizontal * 100) / 100,
    vertical: Math.round(vertical * 100) / 100,
  };
}

/**
 * Offset-wrap + cross-blend seamless pass.
 *
 * Let O be the original and S the copy shifted by (w/2, h/2) with wrap:
 * S(x, y) = O((x + w/2) mod w, (y + h/2) mod h). S is perfectly continuous
 * across the tile boundary by construction (its edge pixels were adjacent
 * interior pixels of O), but carries O's old seams as a cross through its
 * centre. So: use S in a feathered band (~12% of the smaller dimension)
 * around the borders and O everywhere else. The band never reaches the
 * centre cross, the blend mask depends only on distance-to-nearest-edge
 * (symmetric, so both sides of the wrap agree), and at the border itself the
 * result is pure S — hence exact wrap continuity, with any O-vs-S ghosting
 * confined to the feather band.
 */
export function makeSeamless({ width: w, height: h, data }) {
  const sx = w >> 1;
  const sy = h >> 1;
  const band = Math.max(4, Math.round(Math.min(w, h) * 0.12));
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    const edgeY = Math.min(y, h - 1 - y);
    const oy = (y + sy) % h;
    for (let x = 0; x < w; x++) {
      const d = Math.min(Math.min(x, w - 1 - x), edgeY);
      const di = (y * w + x) * 4;
      if (d >= band) {
        out[di] = data[di];
        out[di + 1] = data[di + 1];
        out[di + 2] = data[di + 2];
        out[di + 3] = data[di + 3];
        continue;
      }
      const m = smooth(1 - d / band); // 1 at the border, 0 past the band
      const si = (oy * w + ((x + sx) % w)) * 4;
      for (let c = 0; c < 4; c++) {
        out[di + c] = Math.round(data[di + c] * (1 - m) + data[si + c] * m);
      }
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// Normal map from luminance
// ---------------------------------------------------------------------------

/**
 * Tangent-space normal map (OpenGL +Y convention — what three.js and the
 * theme schema expect) from Rec.709 luminance via 3x3 Sobel gradients with
 * wrap addressing, so the normal map tiles exactly like its colour map.
 * strength 1 keeps the stylized look light: a full 0->255 hard edge maps to
 * a 45-degree tilt, typical painterly gradients far less.
 */
export function normalFromLuma({ width: w, height: h, data }, strength = 1) {
  const luma = new Float32Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * 4;
    luma[i] = 0.2126 * data[s] + 0.7152 * data[s + 1] + 0.0722 * data[s + 2];
  }
  const out = new Uint8Array(w * h * 4);
  const scale = strength / 1020; // 1020 = max Sobel response (4 * 255)
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const y0 = y * w;
    const yp = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const gx =
        luma[ym + xp] + 2 * luma[y0 + xp] + luma[yp + xp] -
        (luma[ym + xm] + 2 * luma[y0 + xm] + luma[yp + xm]);
      const gy =
        luma[yp + xm] + 2 * luma[yp + x] + luma[yp + xp] -
        (luma[ym + xm] + 2 * luma[ym + x] + luma[ym + xp]);
      // height h(x, y-down): n = (-dh/dx, -dh/dv, 1); v points up in GL
      // texture space while image y points down, so green = +gy (down-minus-up).
      const nx = -gx * scale;
      const ny = gy * scale;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const di = (y0 + x) * 4;
      out[di] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      out[di + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      out[di + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out[di + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// Tiled preview
// ---------------------------------------------------------------------------

/**
 * Render the texture tiled `tiles` x `tiles` and box-resample the result to
 * `size` px square. Wrap sampling means no giant intermediate buffer and the
 * preview shows exactly what the renderer's repeat wrapping will show.
 */
export function tiledPreview({ width: w, height: h, data }, size = 384, tiles = 3) {
  const out = new Uint8Array(size * size * 4);
  const spanX = (w * tiles) / size;
  const spanY = (h * tiles) / size;
  const acc = [0, 0, 0, 0];
  for (let dy = 0; dy < size; dy++) {
    const v0 = dy * spanY;
    const v1 = v0 + spanY;
    for (let dx = 0; dx < size; dx++) {
      const u0 = dx * spanX;
      const u1 = u0 + spanX;
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      let weight = 0;
      for (let iy = Math.floor(v0); iy < v1; iy++) {
        const wy = Math.min(v1, iy + 1) - Math.max(v0, iy);
        const row = (((iy % h) + h) % h) * w;
        for (let ix = Math.floor(u0); ix < u1; ix++) {
          const wx = Math.min(u1, ix + 1) - Math.max(u0, ix);
          const s = (row + (((ix % w) + w) % w)) * 4;
          const wgt = wx * wy;
          acc[0] += data[s] * wgt;
          acc[1] += data[s + 1] * wgt;
          acc[2] += data[s + 2] * wgt;
          acc[3] += data[s + 3] * wgt;
          weight += wgt;
        }
      }
      const di = (dy * size + dx) * 4;
      for (let c = 0; c < 4; c++) out[di + c] = Math.round(acc[c] / weight);
    }
  }
  return { width: size, height: size, data: out };
}

// ---------------------------------------------------------------------------
// Theme doc read/update
// ---------------------------------------------------------------------------

/**
 * Candidate theme-file locations, mirroring the host's resolveAssetPath
 * order (an existing projects/<name>/assets copy wins over the flat assets
 * tree — writeAsset resolves the same way, so read where the write lands).
 * runDir is <playgroundRoot>/.hitreg/tool-runs/<run>, which is how a
 * self-contained tool finds the assets roots without host help.
 */
function themeCandidates(runDir, themeId) {
  const root = path.resolve(runDir, "..", "..", "..");
  const rel = path.join("themes", `${themeId}.json`);
  const candidates = [];
  const projectsRoot = path.join(root, "projects");
  try {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(projectsRoot, entry.name, "assets", rel));
      }
    }
  } catch {
    // no projects dir — flat assets tree only
  }
  candidates.push(path.join(root, "assets", rel));
  return candidates;
}

function readExistingTheme(runDir, themeId, warnings, log) {
  for (const candidate of themeCandidates(runDir, themeId)) {
    let text;
    try {
      text = fs.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        log.push(`updating existing theme ${candidate}`);
        return parsed;
      }
      warnings.push(`existing theme file is not an object — starting fresh: ${candidate}`);
      return null;
    } catch {
      warnings.push(`existing theme file is not valid JSON — starting fresh: ${candidate}`);
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * @param {{ runDir: string, writeAsset(file: string, data: Buffer): string }} context
 * @param {Record<string, any>} inputs
 */
export async function run(context, inputs) {
  const log = [];
  const warnings = [];

  const requested = String(inputs.name).replace(/\\/g, "/").replace(/\.png$/i, "");
  if (!NAME_RE.test(requested) || requested.includes("..")) {
    throw new Error("output name must be a safe path below assets/textures");
  }

  const src = decodePng(Buffer.from(inputs.image.data, "base64"));
  log.push(`decoded ${inputs.image.name}: ${src.width}x${src.height}`);
  if (src.width !== src.height) {
    warnings.push(
      `image is not square (${src.width}x${src.height}) — it still tiles, but the theme uvScale assumes square world coverage`,
    );
  }

  const seamBefore = measureSeams(src);
  const wantSeamless = inputs.makeSeamless !== false;
  const img = wantSeamless ? makeSeamless(src) : src;
  const seamAfter = wantSeamless ? measureSeams(img) : seamBefore;
  log.push(
    `wrap seams (mean |RGB| delta) before: h=${seamBefore.horizontal} v=${seamBefore.vertical}` +
      (wantSeamless ? ` -> after: h=${seamAfter.horizontal} v=${seamAfter.vertical}` : " (seamless pass skipped)"),
  );

  const texId = `${requested}.png`;
  const texFile = `textures/${texId}`;
  context.writeAsset(texFile, encodePng(img.width, img.height, img.data));
  log.push(`wrote ${texFile}`);
  const assets = [{ kind: "texture", id: texId, file: texFile }];

  let normalId = null;
  let normalImg = null;
  if (inputs.normalFromLuma !== false) {
    const strength = typeof inputs.normalStrength === "number" ? inputs.normalStrength : 1;
    normalImg = normalFromLuma(img, strength);
    normalId = `${requested}-normal.png`;
    const normalFile = `textures/${normalId}`;
    context.writeAsset(normalFile, encodePng(normalImg.width, normalImg.height, normalImg.data));
    log.push(`wrote ${normalFile} (strength ${strength})`);
    assets.push({ kind: "texture", id: normalId, file: normalFile });
  }

  const slot = typeof inputs.slot === "string" ? inputs.slot : "none";
  const metresPerTile = typeof inputs.metresPerTile === "number" ? inputs.metresPerTile : 2;
  let themeId = null;
  if (typeof inputs.theme === "string" && inputs.theme !== "") {
    if (slot === "none") {
      warnings.push('theme id given but slot is "none" — no theme file written');
    } else if (!THEME_RE.test(inputs.theme)) {
      throw new Error("theme id must match ^[a-z0-9][a-z0-9_-]*$");
    } else {
      themeId = inputs.theme;
      const theme = readExistingTheme(context.runDir, themeId, warnings, log) ?? {
        name: themeId,
        slots: {},
      };
      if (!theme.slots || typeof theme.slots !== "object" || Array.isArray(theme.slots)) {
        theme.slots = {};
      }
      const prev = theme.slots[slot];
      if (prev && typeof prev === "object" && prev.map && prev.map !== texId) {
        warnings.push(`theme slot overwritten: ${themeId}.slots.${slot} map ${prev.map} -> ${texId}`);
      }
      // Preserve hand-tuned slot extras (color/roughness/metalness); replace
      // the texture family this run owns (map, uvScale, normalMap).
      const slotDoc = { ...(prev && typeof prev === "object" ? prev : {}) };
      slotDoc.map = texId;
      slotDoc.uvScale = [metresPerTile, metresPerTile];
      if (normalId) {
        slotDoc.normalMap = normalId;
      } else if (slotDoc.normalMap) {
        warnings.push(
          `dropped stale normalMap ${slotDoc.normalMap} from ${themeId}.slots.${slot} (it belonged to the previous map)`,
        );
        delete slotDoc.normalMap;
      }
      theme.slots[slot] = slotDoc;

      const themeFile = `themes/${themeId}.json`;
      context.writeAsset(themeFile, Buffer.from(JSON.stringify(theme, null, 2) + "\n", "utf8"));
      log.push(`wrote ${themeFile} (slot ${slot}, uvScale [${metresPerTile}, ${metresPerTile}])`);
      assets.push({ kind: "theme", id: themeId, file: themeFile });

      const missing = REQUIRED_THEME_SLOTS.filter((s) => !theme.slots[s]);
      if (missing.length > 0) {
        warnings.push(`theme "${themeId}" still missing required slots: ${missing.join(", ")}`);
      }
    }
  }

  const previews = [];
  if (inputs.previewTiling !== false) {
    const tiled = tiledPreview(img, 384, 3);
    previews.push({
      label: "tiled 3x3",
      mediaType: "image/png",
      data: encodePng(tiled.width, tiled.height, tiled.data).toString("base64"),
    });
    if (normalImg) {
      previews.push({
        label: "normal map",
        mediaType: "image/png",
        data: encodePng(normalImg.width, normalImg.height, normalImg.data).toString("base64"),
      });
    }
  }

  return {
    assets,
    previews,
    warnings,
    report: {
      size: { width: img.width, height: img.height },
      seamless: wantSeamless,
      seam: { before: seamBefore, after: seamAfter },
      slot,
      theme: themeId,
      normalMap: normalId,
      metresPerTile,
    },
    log: log.join("\n"),
  };
}
