/**
 * The ONE grid every texture page is packed on (weapon-page, body-page,
 * atlas-pack, atlas-view).
 *
 * RULE: a page is SQUARE. A tile is stored as `[u, v, scale]` with ONE scale
 * for both axes, so a page with fewer rows than columns squeezes every tile
 * vertically: the top of each sheet still lands and each island samples
 * further off the lower it sits. 12 helm themes packed 4x3 broke hood tops,
 * crowns and every ornament; a 2-theme greataxe packed 2x1 was wrong from its
 * first bake. Unused cells in the last rows cost texture memory only.
 */

/** Square grid for `count` sheets of `size` px with `pad` px gutters. */
export function squareGrid(count, size, pad) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const stride = size + pad * 2;
  const W = cols * stride;
  return { cols, rows: cols, stride, W, H: W };
}

/** Refuse to write a page that is not square (see the rule above). */
export function assertSquarePage(W, H, what) {
  if (W !== H) {
    throw new Error(
      `${what}: page is ${W}x${H} — pages must be SQUARE (a tile is [u, v, scale] with one scale; a non-square page misplaces every island vertically)`,
    );
  }
}
