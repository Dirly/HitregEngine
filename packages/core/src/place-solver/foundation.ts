/**
 * FOUNDATION SKIRT — the "box down into the ground textured like the brick" (Derek 2026-10-30: "Ruins on uneven ground
 * need a foundational layer ... so it looks grounded without perfectly even terrain").
 *
 * A piece that declares `placeRule.foundation` and stands where the ground falls more than its footing covers gets a
 * skirt: its footprint box (inset, so no face shares the piece's planes) from just under its base down to the lowest
 * ground sample + `depth`. The skirt is ONE generated `surface` mesh in the piece's own masonry material with planar
 * UVs at the material's tile size (the town texel standard), `static` so every skirt of a material merges into one draw
 * with the static batcher, and a trimesh collider (nothing walks into the ground under a ruin). No terrain is edited.
 */
import { localToWorld, type Obb, type V2 } from "./obb.js";


export interface FoundationSpec {
  /** The piece it belongs to. */
  of: string;
  /** Plan box (inset). */
  box: Obb;
  /** World heights. */
  top: number;
  bottom: number;
  material: string;
  /** Metres per texture tile on its faces. */
  tile: number;
  /** Close the top (default true). A piece with a floor covers its skirt itself: no cap, nothing to flicker with the
   *  ground the box crosses or with the floor slab. */
  cap?: boolean;
}

/** Box mesh (4 walls + top; the bottom is underground) in the entity's own frame: origin at the box centre, at `bottom`. */
export function foundationSurface(spec: FoundationSpec): { positions: number[]; indices: number[]; uvs: number[] } {
  const hx = spec.box.half[0], hz = spec.box.half[1], h = Math.max(0.01, spec.top - spec.bottom), t = spec.tile;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const quad = (p: [number, number, number][], uv: [number, number][]) => {
    const b = positions.length / 3;
    for (const q of p) positions.push(...q);
    for (const u of uv) uvs.push(u[0], u[1]);
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  // walls, counter-clockwise seen from OUTSIDE: corners in order round the box (-x-z, +x-z, +x+z, -x+z)
  const c: V2[] = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  let run = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i]!, b = c[(i + 1) % 4]!, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // (a bottom, a top, b top, b bottom) is counter-clockwise seen from outside (its normal points away from the centre)
    quad(
      [[a[0], 0, a[1]], [a[0], r(h), a[1]], [b[0], r(h), b[1]], [b[0], 0, b[1]]],
      [[r(run / t), 0], [r(run / t), r(h / t)], [r((run + L) / t), r(h / t)], [r((run + L) / t), 0]],
    );
    run += L;
  }
  // top cap, facing +y
  if (spec.cap !== false) quad([[-hx, r(h), hz], [hx, r(h), hz], [hx, r(h), -hz], [-hx, r(h), -hz]], [[r(-hx / t), r(hz / t)], [r(hx / t), r(hz / t)], [r(hx / t), r(-hz / t)], [r(-hx / t), r(-hz / t)]]);
  return { positions: positions.map(r), indices, uvs };
}

/** The scene entity for one skirt: a static surface mesh in the piece's material + a trimesh collider, tagged. */
export function foundationEntity(spec: FoundationSpec, o: { parent?: string | null; origin?: [number, number, number]; tags?: string[] } = {}): {
  name: string; parent: string | null; tags: string[]; components: Record<string, unknown>;
} {
  const og = o.origin ?? [0, 0, 0], s = Math.sin(spec.box.yaw / 2), cw = Math.cos(spec.box.yaw / 2);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    name: `foundation of ${spec.of}`,
    parent: o.parent ?? null,
    tags: ["foundation", `foundation-of:${spec.of}`, ...(o.tags ?? [])],
    components: {
      transform: { position: [r3(spec.box.c[0] - og[0]), r3(spec.bottom - og[1]), r3(spec.box.c[1] - og[2])], rotation: [0, Math.round(s * 1e5) / 1e5, 0, Math.round(cw * 1e5) / 1e5] },
      mesh: { source: { kind: "surface", ...foundationSurface(spec) }, material: spec.material, static: true },
      collider: { shape: "trimesh" },
    },
  };
}

/** The skirt's world corners at its top (for reports and pictures). */
export const foundationOutline = (spec: FoundationSpec): V2[] =>
  ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([i, j]) => localToWorld(spec.box.c, spec.box.yaw, [i * spec.box.half[0], j * spec.box.half[1]]));
