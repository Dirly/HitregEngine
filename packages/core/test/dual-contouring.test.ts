import { describe, expect, it } from "vitest";
import { dualContour, marchingCubes, type SampledBlock } from "../src/index.js";

/**
 * Dual contouring, held to the three claims that would justify swapping to it.
 *
 * The interesting one is the SEAM. Marching cubes is seamless structurally —
 * a vertex belongs to a lattice edge, so two chunks derive it identically from
 * a one-sample pad and cannot disagree. Dual contouring has to earn the same
 * property: a face spans four cells, so a chunk reaches one cell into its
 * neighbour, and both chunks must (a) solve that cell to the same point and
 * (b) agree on which of them emits the face. Neither is automatic, and a
 * failure of either is a crack or a z-fighting double surface at every chunk
 * boundary in the world — the exact class of bug that is invisible in a unit
 * test of a single block.
 */

/** Sample one block of an analytic field, with `pad` samples of margin per side. */
function sample(
  f: (x: number, y: number, z: number) => number,
  cells: number,
  originCell: [number, number, number],
  pad: number,
  step = 1,
): SampledBlock {
  const n = cells + 2 * pad + 1;
  const origin: [number, number, number] = [
    originCell[0] * cells * step - pad * step,
    originCell[1] * cells * step - pad * step,
    originCell[2] * cells * step - pad * step,
  ];
  const values = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        values[i + j * n + k * n * n] = f(origin[0] + i * step, origin[1] + j * step, origin[2] + k * step);
      }
    }
  }
  return { values, nx: n, ny: n, nz: n, origin, step };
}

const sphere =
  (radius: number, cx = 0, cy = 0, cz = 0) =>
  (x: number, y: number, z: number): number =>
    Math.hypot(x - cx, y - cy, z - cz) - radius;

/**
 * Two half-spaces meeting at a hard crease running along y, deliberately NOT
 * axis-aligned: an axis-aligned wedge puts its planes ON the lattice, where
 * both meshers are exact and the comparison measures nothing.
 */
// Deliberately off the lattice: a crease that runs along lattice points is
// exactly representable and every mesher scores a perfect zero on it.
const CREASE_X = 8.37;
const CREASE_Z = 8.61;
const NA: readonly [number, number] = [0.8, 0.6];
const NB: readonly [number, number] = [-0.6, 0.8];
const planeA = (x: number, z: number): number => NA[0] * (x - CREASE_X) + NA[1] * (z - CREASE_Z);
const planeB = (x: number, z: number): number => NB[0] * (x - CREASE_X) + NB[1] * (z - CREASE_Z);
/** Solid where BOTH half-spaces are, so the crease is convex and max() is the exact distance outside it. */
const wedge = (x: number, _y: number, z: number): number => Math.max(planeA(x, z), planeB(x, z));
/** How far a vertex sits off the true wedge surface. */
const wedgeError = (m: { positions: Float32Array; vertexCount: number }): number => {
  let max = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    const x = m.positions[i * 3]!;
    const z = m.positions[i * 3 + 2]!;
    max = Math.max(max, Math.abs(Math.max(planeA(x, z), planeB(x, z))));
  }
  return max;
};

function positionKey(p: Float32Array, i: number): string {
  return `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
}

it('keeps shared-edge winding coherent across noisy sharp joins', () => {
  const field = (x:number,y:number,z:number) => Math.max(
    Math.hypot(x-12.1,y-12.2,z-12.3)-8 + .7*Math.sin(x*1.7)*Math.sin(y*1.9)*Math.cos(z*1.3),
    -Math.max(Math.abs(x-13.3)-2.4,Math.abs(y-12.4)-5.2,Math.abs(z-12.6)-8.1),
  );
  const mesh=dualContour(sample(field,24,[0,0,0],2),{pad:2});
  const edges=new Map<string,{count:number,sum:number}>();
  for(let i=0;i<mesh.indices.length;i+=3)for(let j=0;j<3;j++){
    const a=mesh.indices[i+j]!,b=mesh.indices[i+(j+1)%3]!;
    const key=a<b?`${a},${b}`:`${b},${a}`,edge=edges.get(key)??{count:0,sum:0};
    edge.count++;edge.sum+=a<b?1:-1;edges.set(key,edge);
  }
  expect(mesh.triangleCount).toBeGreaterThan(100);
  expect([...edges.values()].filter(e=>e.count===2&&e.sum!==0)).toHaveLength(0);
});

describe("dual contouring on an analytic sphere", () => {
  const radius = 7.5;
  const block = sample(sphere(radius), 24, [0, 0, 0], 2);
  const mesh = dualContour(block, { pad: 2 });

  it("produces a surface", () => {
    expect(mesh.triangleCount).toBeGreaterThan(200);
  });

  it("puts every vertex on the isosurface", () => {
    for (let i = 0; i < mesh.vertexCount; i++) {
      const r = Math.hypot(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
      expect(Math.abs(r - radius)).toBeLessThan(0.5);
    }
  });

  it("winds every triangle outward", () => {
    for (let t = 0; t < mesh.triangleCount; t++) {
      const a = mesh.indices[t * 3]!;
      const b = mesh.indices[t * 3 + 1]!;
      const c = mesh.indices[t * 3 + 2]!;
      const ax = mesh.positions[a * 3]!;
      const ay = mesh.positions[a * 3 + 1]!;
      const az = mesh.positions[a * 3 + 2]!;
      const e1 = [mesh.positions[b * 3]! - ax, mesh.positions[b * 3 + 1]! - ay, mesh.positions[b * 3 + 2]! - az];
      const e2 = [mesh.positions[c * 3]! - ax, mesh.positions[c * 3 + 1]! - ay, mesh.positions[c * 3 + 2]! - az];
      const f = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      // a sphere's outward direction IS its radial direction
      const dot = f[0]! * ax + f[1]! * ay + f[2]! * az;
      expect(dot).toBeGreaterThanOrEqual(0);
    }
  });

  it("costs about what marching cubes costs — the dual is not a vertex saving", () => {
    // Worth pinning because it is the claim people expect DC to deliver and it
    // is FALSE for a uniform grid: MC welds one vertex per intersected edge, a
    // dual mesh has one face per intersected edge, and Euler makes those two
    // counts nearly equal. Vertex reduction comes from ADAPTIVE dual
    // contouring (collapsing octree cells by QEF residual), which this is not.
    const mc = marchingCubes(sample(sphere(radius), 24, [0, 0, 0], 1));
    expect(mesh.vertexCount).toBeGreaterThan(mc.vertexCount * 0.8);
    expect(mesh.vertexCount).toBeLessThan(mc.vertexCount * 1.5);
  });

  it("gives normalised normals", () => {
    for (let i = 0; i < mesh.vertexCount; i++) {
      expect(Math.hypot(mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!)).toBeCloseTo(1, 4);
    }
  });
});

describe("dual contouring across a chunk seam", () => {
  const cells = 12;
  // A sphere straddling the shared face, so both blocks actually see surface
  // there — a fixture whose surface misses the boundary proves nothing.
  const f = sphere(5, cells, cells / 2, cells / 2);
  // Two blocks side by side in x, each owning  cells, meshed with no
  // knowledge of each other — exactly how the streamer builds neighbours.
  const a = dualContour(sample(f, cells, [0, 0, 0], 2), { pad: 2 });
  const b = dualContour(sample(f, cells, [1, 0, 0], 2), { pad: 2 });

  it("both blocks reach the shared face", () => {
    expect(a.triangleCount).toBeGreaterThan(50);
    expect(b.triangleCount).toBeGreaterThan(50);
  });

  it("solves a shared cell to the SAME point from either side", () => {
    // Chunk A reaches into cell x =  (chunk B's first) for its boundary
    // faces; B owns that cell. If the two disagree, the seam cracks.
    const bSet = new Set<string>();
    for (let i = 0; i < b.vertexCount; i++) bSet.add(positionKey(b.positions, i));
    let shared = 0;
    for (let i = 0; i < a.vertexCount; i++) {
      if (a.positions[i * 3]! < cells) continue; // A's own territory; B never solves it
      shared++;
      expect(bSet.has(positionKey(a.positions, i)), ).toBe(true);
    }
    expect(shared, "the two blocks should overlap by a ring of cells").toBeGreaterThan(0);
  });

  it("emits each face exactly once across the two chunks", () => {
    const faces = new Set<string>();
    const dupes: string[] = [];
    for (const mesh of [a, b]) {
      for (let t = 0; t < mesh.triangleCount; t++) {
        const key = [0, 1, 2]
          .map((o) => positionKey(mesh.positions, mesh.indices[t * 3 + o]!))
          .sort()
          .join("|");
        if (faces.has(key)) dupes.push(key);
        faces.add(key);
      }
    }
    expect(dupes).toEqual([]);
  });
});

describe("dual contouring keeps a sharp feature marching cubes rounds off", () => {
  const cells = 16;

  it("lands vertices on the crease instead of chamfering across it", () => {
    const dc = dualContour(sample(wedge, cells, [0, 0, 0], 2), { pad: 2 });
    const mc = marchingCubes(sample(wedge, cells, [0, 0, 0], 1));
    // MC can only put a vertex on a lattice edge, so it cuts the corner off by
    // up to half a voxel; DC solves for where the two planes meet and lands there.
    expect(wedgeError(dc)).toBeLessThan(wedgeError(mc) * 0.5);
  });

  it("degrades to surface nets at sharpness 0 — the smooth dual", () => {
    const sharp = dualContour(sample(wedge, cells, [0, 0, 0], 2), { pad: 2, sharpness: 1 });
    const smooth = dualContour(sample(wedge, cells, [0, 0, 0], 2), { pad: 2, sharpness: 0 });
    expect(wedgeError(smooth)).toBeGreaterThan(wedgeError(sharp));
    // same topology either way — only the vertex placement moves
    expect(smooth.vertexCount).toBe(sharp.vertexCount);
    expect(smooth.triangleCount).toBe(sharp.triangleCount);
  });
});

describe("dual contouring edge cases", () => {
  it('keeps an oblique masonry slab planar with exact Hermite constraints',()=>{
    const angle=.63,c=Math.cos(angle),s=Math.sin(angle);
    const field=(x:number,y:number,z:number)=>Math.max(Math.abs(c*(x-2.1)+s*(z-2.2))-1.7,Math.abs(y-1.4)-.45,Math.abs(-s*(x-2.1)+c*(z-2.2))-.8);
    const hermite={value:field,gradient:(x:number,y:number,z:number,out:Float64Array)=>{
      const e=1e-5;out.set([(field(x+e,y,z)-field(x-e,y,z))/(2*e),(field(x,y+e,z)-field(x,y-e,z))/(2*e),(field(x,y,z+e)-field(x,y,z-e))/(2*e)]);
    }};
    const mesh=dualContour(sample(field,20,[0,0,0],2,.25),{pad:2,hermite});
    let residual=0;
    for(let i=0;i<mesh.vertexCount;i++)residual=Math.max(residual,Math.abs(field(mesh.positions[i*3]!,mesh.positions[i*3+1]!,mesh.positions[i*3+2]!)));
    expect(mesh.triangleCount).toBeGreaterThan(100);
    expect(residual).toBeLessThan(.003);
  });
  it("returns nothing for an entirely solid or entirely empty block", () => {
    expect(dualContour(sample(() => -1, 8, [0, 0, 0], 2), { pad: 2 }).triangleCount).toBe(0);
    expect(dualContour(sample(() => 1, 8, [0, 0, 0], 2), { pad: 2 }).triangleCount).toBe(0);
  });

  it("keeps every vertex inside its own cell, so faces cannot fold through each other", () => {
    // a field with a near-degenerate QEF everywhere (a plane) is the case that
    // sends an unclamped minimiser off to infinity along the plane
    const mesh = dualContour(sample((_x, y) => y - 0.3, 10, [0, 0, 0], 2), { pad: 2 });
    expect(mesh.triangleCount).toBeGreaterThan(0);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const y = mesh.positions[i * 3 + 1]!;
      // the surface sits in the cell spanning y = 0..1; clamped, nothing escapes it
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});
