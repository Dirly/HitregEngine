import { z } from "zod";

/**
 * Sprite sheets: one texture, many named frames (ARCHITECTURE: assets are
 * schema-validated JSON, legible to AI). A sheet is a data asset in
 * assets/spritesheets/*.json referencing a texture asset. Frames come from:
 *  - `grid` auto-splice: cols x rows cells become frames `f0..fN`
 *    (row-major), sized frameWidth/Height with optional margin/spacing;
 *  - `frames` entries: either `{ index }` naming a grid cell, or an explicit
 *    pixel rect `{ x, y, w, h }` (works with or without a grid).
 *
 * Consumers (billboard sprite kind, future 2D uses) reference `sheet` +
 * `frame` by name. Missing frames are a DIAGNOSED condition, not a crash:
 * resolveSpriteFrame returns null and the renderer shows a placeholder and
 * reports it, so re-spliced/renamed sheets surface immediately.
 */

const gridSchema = z.object({
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  /** Pixels around the whole sheet before the first cell. */
  margin: z.number().int().min(0).default(0),
  /** Pixels between adjacent cells. */
  spacing: z.number().int().min(0).default(0),
});

export const spritesheetSchema = z.object({
  /** Texture asset id (assets/textures/...). */
  texture: z.string().min(1),
  grid: gridSchema.optional(),
  /** Named frames: grid-cell aliases ({ index }) or explicit pixel rects. */
  frames: z
    .record(
      z.string(),
      z.union([
        z.object({ index: z.number().int().min(0) }),
        z.object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        }),
      ]),
    )
    .default({}),
});

export type SpritesheetDoc = z.infer<typeof spritesheetSchema>;

export interface SpriteFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixel rect of grid cell `index` (row-major), or null when out of range. */
export function gridFrameRect(
  grid: z.infer<typeof gridSchema>,
  index: number,
): SpriteFrame | null {
  if (index < 0 || index >= grid.cols * grid.rows) return null;
  const col = index % grid.cols;
  const row = Math.floor(index / grid.cols);
  return {
    x: grid.margin + col * (grid.frameWidth + grid.spacing),
    y: grid.margin + row * (grid.frameHeight + grid.spacing),
    w: grid.frameWidth,
    h: grid.frameHeight,
  };
}

/** Every frame the sheet defines: auto-spliced `f<i>` cells + named entries. */
export function resolveSpriteFrames(sheet: SpritesheetDoc): Record<string, SpriteFrame> {
  const out: Record<string, SpriteFrame> = {};
  if (sheet.grid) {
    const count = sheet.grid.cols * sheet.grid.rows;
    for (let i = 0; i < count; i++) out[`f${i}`] = gridFrameRect(sheet.grid, i)!;
  }
  for (const [name, def] of Object.entries(sheet.frames)) {
    if ("index" in def) {
      const rect = sheet.grid ? gridFrameRect(sheet.grid, def.index) : null;
      if (rect) out[name] = rect;
      // index without grid / out of range: unresolvable — leave missing so
      // consumers diagnose it (resolveSpriteFrame returns null)
    } else {
      out[name] = def;
    }
  }
  return out;
}

/** One frame by name, or null (missing = renderer placeholder + diagnostic). */
export function resolveSpriteFrame(sheet: SpritesheetDoc, frame: string): SpriteFrame | null {
  return resolveSpriteFrames(sheet)[frame] ?? null;
}

/**
 * UV window for a frame given the texture's pixel size (known render-side
 * once the image loads). Y-flipped for three.js texture space: offset is the
 * frame's BOTTOM-left in [0,1], repeat spans the frame.
 */
export function frameToUv(
  frame: SpriteFrame,
  sheetWidth: number,
  sheetHeight: number,
): { offsetX: number; offsetY: number; repeatX: number; repeatY: number } {
  return {
    offsetX: frame.x / sheetWidth,
    offsetY: 1 - (frame.y + frame.h) / sheetHeight,
    repeatX: frame.w / sheetWidth,
    repeatY: frame.h / sheetHeight,
  };
}

/** Close-name suggestion for missing-frame diagnostics ("did you mean ...?"). */
export function nearestFrameName(sheet: SpritesheetDoc, missing: string): string | null {
  const names = Object.keys(resolveSpriteFrames(sheet));
  let best: string | null = null;
  let bestScore = Infinity;
  for (const name of names) {
    const score = editDistance(missing.toLowerCase(), name.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return bestScore <= Math.max(2, Math.floor(missing.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}
