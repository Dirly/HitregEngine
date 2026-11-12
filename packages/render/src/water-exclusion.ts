import * as THREE from "three/webgpu";
import { Fn, Loop, If, Break, bool, float, int, ivec2, dot, texture, uniform } from "three/tsl";
import type { WaterExclusion } from "@hitreg/core";

// One row per convex dry interior: min + plane count, max, then planes.
// Texture loads (no implicit derivatives) also work in divergent hull branches
// on WebGPU. The cheap world bounds test keeps open ocean out of the plane loop.
const WIDTH = 136;
function page(height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array(WIDTH * height * 4), WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
let atlas = page(1);
const map = texture(atlas);
const count = uniform(0, "int");

/** Host scene state, shared by every streamed water material; updates need no shader rebuild. */
export function setWaterExclusions(volumes: readonly WaterExclusion[]): void {
  if (volumes.some(v => v.planes.length > WIDTH - 2)) throw new Error("Water exclusion exceeds shader plane budget");
  const height = Math.max(1, volumes.length);
  if (atlas.image.height !== height) {
    const previous = atlas;
    atlas = page(height);
    map.value = atlas;
    previous.dispose();
  }
  const data = atlas.image.data as Float32Array;
  data.fill(0);
  volumes.forEach((v, i) => {
    const row = i * WIDTH * 4;
    data.set([...v.min, v.planes.length, ...v.max, 0], row);
    v.planes.forEach((p, k) => data.set(p, row + (k + 2) * 4));
  });
  atlas.needsUpdate = true;
  count.value = volumes.length;
}

// TSL component inference is lost across variable-length loop/texture nodes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** 0 inside a dry interior, 1 everywhere else, including beneath and above it. */
export function waterExclusionMask(position: N): N {
  return Fn(() => {
    const keep: N = float(1).toVar();
    // Separate Loop calls default to the same GLSL/WGSL name (`i`). Explicit
    // names keep the plane loop from shadowing the hull texture-row index.
    const hullLoop = { start: int(0), end: count, type: "int" as const, name: "waterHull" };
    // Three supports named loop inputs; its current declarations only expose i.
    Loop(hullLoop, ({ waterHull: hull }: N) => {
      const lo: N = map.load(ivec2(0, hull));
      const hi: N = map.load(ivec2(1, hull));
      If(position.greaterThanEqual(lo.xyz).all().and(position.lessThanEqual(hi.xyz).all()), () => {
        const inside: N = bool(true).toVar();
        const planeLoop = { start: int(0), end: int(lo.w), type: "int" as const, name: "waterPlane" };
        Loop(planeLoop, ({ waterPlane: plane }: N) => {
          const p: N = map.load(ivec2(plane.add(2), hull));
          If(dot(p.xyz, position).greaterThan(p.w), () => { inside.assign(false); Break(); });
        });
        If(inside, () => { keep.assign(0); Break(); });
      });
    });
    return keep;
  })();
}
