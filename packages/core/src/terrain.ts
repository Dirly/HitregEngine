/**
 * Deterministic heightmap terrain, shared by render and physics: both sample
 * the same function / triangulate the same grid, so what you see is exactly
 * what you collide with. Pure math — no Three.js, no Rapier, runs headless.
 */

export interface HeightmapParams {
  /** World extent [width, depth], centered on the entity origin. */
  size: [number, number];
  /** Peak height (± around 0). */
  amplitude: number;
  /** Noise feature scale — higher = smaller, busier hills. */
  frequency: number;
  /** Seed for the noise lattice; same seed = same terrain, everywhere. */
  seed: number;
  /** Grid subdivisions per side. */
  resolution: number;
  /** Radius of a flat disc at the center (a playfield); 0 = no flattening. */
  flatRadius: number;
  /** Distance over which the flat disc blends up to full height. */
  flatFalloff: number;
}

/** Deterministic lattice hash → [0, 1). Same bits in browser and Node (V8). */
function hash2(ix: number, iz: number, seed: number): number {
  const s = Math.sin(ix * 127.1 + iz * 311.7 + seed * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise over the integer lattice → [0, 1). */
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Terrain height at local (x, z) — entity-local, origin at the center. */
export function sampleHeightmap(p: HeightmapParams, x: number, z: number): number {
  const nx = x * p.frequency;
  const nz = z * p.frequency;
  // two octaves: broad hills + finer detail
  const n =
    valueNoise(nx, nz, p.seed) * 0.72 + valueNoise(nx * 2.7 + 13.7, nz * 2.7 + 7.3, p.seed + 5) * 0.28;
  let h = (n * 2 - 1) * p.amplitude;
  if (p.flatRadius > 0) {
    const r = Math.hypot(x, z);
    const t = Math.min(1, Math.max(0, (r - p.flatRadius) / p.flatFalloff));
    h *= smooth(t);
  }
  return h;
}

export interface HeightmapMesh {
  /** xyz triplets, entity-local (origin-centered, +Y up). */
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Triangulated grid for the params — the single geometry truth. Render wraps
 * it in a BufferGeometry; physics cooks it into a static trimesh collider.
 */
export function heightmapMesh(p: HeightmapParams): HeightmapMesh {
  const res = Math.max(2, Math.floor(p.resolution));
  const [w, d] = p.size;
  const verts = (res + 1) * (res + 1);
  const positions = new Float32Array(verts * 3);
  let v = 0;
  for (let iz = 0; iz <= res; iz++) {
    const z = (iz / res - 0.5) * d;
    for (let ix = 0; ix <= res; ix++) {
      const x = (ix / res - 0.5) * w;
      positions[v++] = x;
      positions[v++] = sampleHeightmap(p, x, z);
      positions[v++] = z;
    }
  }
  const indices = new Uint32Array(res * res * 6);
  let i = 0;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const a = iz * (res + 1) + ix;
      const b = a + 1;
      const c = a + (res + 1);
      const e = c + 1;
      // counter-clockwise from above (+Y normals)
      indices[i++] = a;
      indices[i++] = c;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = c;
      indices[i++] = e;
    }
  }
  return { positions, indices };
}
