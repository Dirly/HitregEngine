/**
 * A shot that must SHOW something (a spot's `shows: [<entity id>]`, e.g. the portal veil in the portal shot): the entity's
 * screen rect must lie mostly inside the frame and the entity must actually change the pixels there (the frame taken
 * with it hidden is compared with the frame taken with it shown, so a veil behind a wall, facing away from the camera
 * or culled reads 0). L (Wristgate 2026-10-29): the portal shot ended on the lit back wall of the recess four passes
 * running because the single-sided veil faced into the dungeon; nothing measured whether the veil was in the picture.
 */
export type ShowRect = { x0: number; y0: number; x1: number; y1: number; share: number };
export type ShowResult = { id: string; rect: ShowRect | null; changed: number; ok: boolean; why: string };

/** Minimum share of the entity's projected rect inside the frame, and of the in-frame rect's pixels it changes. */
export const SHOW_MIN_IN_FRAME = 0.5;
export const SHOW_MIN_CHANGED = 0.2;
/** Per-channel difference (0-255) that counts as a changed pixel (a dark veil on a dark recess still moves a few levels). */
export const SHOW_PIXEL_DELTA = 3;

/** Share of pixels that differ between two same-size RGBA(or RGB) buffers. */
export function changedShare(a: Uint8Array, b: Uint8Array, channels: number, delta = SHOW_PIXEL_DELTA): number {
  const n = Math.min(a.length, b.length) / channels;
  if (!n) return 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    if (Math.abs(a[o]! - b[o]!) > delta || Math.abs(a[o + 1]! - b[o + 1]!) > delta || Math.abs(a[o + 2]! - b[o + 2]!) > delta) c++;
  }
  return c / n;
}

/** The verdict for one entity in one frame. */
export function showVerdict(id: string, rect: ShowRect | null, changed: number): ShowResult {
  if (!rect) return { id, rect, changed: 0, ok: false, why: "not in the scene or behind the camera" };
  if (rect.share < SHOW_MIN_IN_FRAME) return { id, rect, changed, ok: false, why: `only ${(rect.share * 100).toFixed(0)}% of its rect in frame` };
  if (changed < SHOW_MIN_CHANGED) return { id, rect, changed, ok: false, why: `changes ${(changed * 100).toFixed(0)}% of its rect (hidden, facing away or culled)` };
  return { id, rect, changed, ok: true, why: `in frame ${(rect.share * 100).toFixed(0)}%, changes ${(changed * 100).toFixed(0)}% of its rect` };
}
