import { describe, expect, it } from "vitest";
import {
  buildVolumeMesh,
  createVolume,
  csgNodeSchema,
  decodeHeightfieldValues,
  encodeHeightfieldValues,
  volumeDocSchema,
} from "../src/index.js";

/**
 * Heightfield CSG nodes: the one shape whose form is DATA.
 *
 * What fails silently here is the same family as everywhere else in this
 * module — a sign flipped (a room full of rock), a footprint off by half a
 * cell (a floor that ends before the wall), a slab hung on the wrong side of
 * its surface (a vault buried in the ceiling) — plus one of its own: a base64
 * payload that decodes to the wrong number of samples and shears the grid.
 * The schema refuses that last one; these pin the rest.
 */

/** Edges used by exactly one triangle — i.e. holes. Welds by position, since blocks are contoured independently. */
function survey(mesh: { positions: Float32Array; indices: Uint32Array; triangleCount: number; vertexCount: number }) {
  const Q = 10000;
  const ids = new Map<string, number>();
  const weld = new Int32Array(mesh.vertexCount);
  let next = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const qx = Math.round(mesh.positions[i * 3]! * Q);
    const qy = Math.round(mesh.positions[i * 3 + 1]! * Q);
    const qz = Math.round(mesh.positions[i * 3 + 2]! * Q);
    let f = -1;
    for (let dx = -1; dx <= 1 && f < 0; dx++)
      for (let dy = -1; dy <= 1 && f < 0; dy++)
        for (let dz = -1; dz <= 1 && f < 0; dz++) {
          const h = ids.get(`${qx + dx}_${qy + dy}_${qz + dz}`);
          if (h !== undefined) f = h;
        }
    if (f < 0) f = next++;
    ids.set(`${qx}_${qy}_${qz}`, f);
    weld[i] = f;
  }
  const use = new Map<string, number>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = weld[mesh.indices[t * 3]!]!;
    const b = weld[mesh.indices[t * 3 + 1]!]!;
    const c = weld[mesh.indices[t * 3 + 2]!]!;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      if (p === q) continue;
      const k = p < q ? `${p}_${q}` : `${q}_${p}`;
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  let nonManifold = 0;
  for (const n of use.values()) {
    if (n === 1) open++;
    else if (n > 2) nonManifold++;
  }
  return { open, nonManifold };
}

/** Sample a height function onto a width x depth grid over a footprint. */
function grid(width: number, depth: number, w: number, d: number, f: (x: number, z: number) => number): number[] {
  const out: number[] = [];
  for (let k = 0; k < depth; k++)
    for (let i = 0; i < width; i++) out.push(f(-w / 2 + (i * w) / (width - 1), -d / 2 + (k * d) / (depth - 1)));
  return out;
}

describe("heightfield schema", () => {
  it("accepts the array and the base64 form and rejects a wrong length", () => {
    const array = csgNodeSchema.parse({
      shape: "heightfield",
      size: [4, 1, 4],
      heightfield: { width: 2, depth: 2, values: [0, 0.5, 1, 1.5] },
    });
    expect(array.heightfield?.mode).toBe("floor");
    const packed = csgNodeSchema.parse({
      shape: "heightfield",
      size: [4, 1, 4],
      heightfield: { width: 2, depth: 2, mode: "ceiling", values: encodeHeightfieldValues([0, 0.5, 1, 1.5]) },
    });
    expect(typeof packed.heightfield?.values).toBe("string");

    const bad = (heightfield: unknown) => csgNodeSchema.safeParse({ shape: "heightfield", heightfield }).success;
    expect(bad({ width: 2, depth: 2, values: [0, 1, 2] }), "short array").toBe(false);
    expect(bad({ width: 2, depth: 2, values: [0, 1, 2, 3, 4] }), "long array").toBe(false);
    expect(bad({ width: 3, depth: 2, values: encodeHeightfieldValues([0, 1, 2, 3]) }), "short base64").toBe(false);
    expect(bad({ width: 2, depth: 2, values: "not base64 at all !!" }), "not base64").toBe(false);
    expect(bad({ width: 1, depth: 2, values: [0, 1] }), "degenerate width").toBe(false);
    expect(bad({ width: 4096, depth: 2, values: [] }), "over the cap").toBe(false);
    // a heightfield node with no heights would contribute nothing, silently
    expect(csgNodeSchema.safeParse({ shape: "heightfield" }).success).toBe(false);
  });

  it("round-trips heights through base64 float32 exactly", () => {
    const values = Float32Array.from({ length: 257 }, (_, i) => Math.sin(i * 0.37) * 12.5);
    const back = decodeHeightfieldValues(encodeHeightfieldValues(values));
    expect(Array.from(back)).toEqual(Array.from(values));
    expect(() => decodeHeightfieldValues("%%%%")).toThrow();
  });
});

describe("heightfield density", () => {
  const flat = (mode: "floor" | "ceiling") =>
    createVolume(
      volumeDocSchema.parse({
        voxelSize: 0.25,
        nodes: [
          { shape: "heightfield", size: [4, 1, 4], heightfield: { width: 2, depth: 2, mode, values: [0.3, 0.3, 0.3, 0.3] } },
        ],
      }),
    );

  it("hangs a floor slab BELOW its surface", () => {
    const v = flat("floor");
    expect(v.density(0, 0, 0), "inside the slab").toBeLessThan(0);
    expect(v.density(0, 0.2, 0), "just under the surface").toBeLessThan(0);
    expect(v.density(0, 0.5, 0), "above the surface").toBeGreaterThan(0);
    expect(v.density(0, -0.9, 0), "below the thickness").toBeGreaterThan(0);
    expect(v.density(3, 0, 0), "outside the footprint").toBeGreaterThan(0);
  });

  it("hangs a ceiling slab ABOVE its surface", () => {
    const v = flat("ceiling");
    expect(v.density(0, 0.8, 0), "inside the slab").toBeLessThan(0);
    expect(v.density(0, 0.35, 0), "just above the surface").toBeLessThan(0);
    expect(v.density(0, 0, 0), "below the surface, i.e. the room").toBeGreaterThan(0);
    expect(v.density(0, 1.5, 0), "above the thickness").toBeGreaterThan(0);
    expect(v.density(0, 0.8, 3), "outside the footprint").toBeGreaterThan(0);
  });

  it("interpolates bilinearly between samples", () => {
    // h rises from 0 at -z to 1 at +z; the middle of the patch is half way up
    const v = createVolume(
      volumeDocSchema.parse({
        voxelSize: 0.25,
        nodes: [{ shape: "heightfield", size: [4, 1, 4], heightfield: { width: 2, depth: 2, values: [0, 0, 1, 1] } }],
      }),
    );
    expect(v.density(0, 0.45, 0)).toBeLessThan(0);
    expect(v.density(0, 0.55, 0)).toBeGreaterThan(0);
    expect(v.density(0, 0.2, -1.9)).toBeGreaterThan(0);
    expect(v.density(0, 0.2, 1.9)).toBeLessThan(0);
  });

  it("reads the same field from the array and the base64 form", () => {
    const values = grid(17, 17, 6, 6, (x, z) => Math.sin(x * 0.8) * 0.6 + Math.cos(z * 0.5) * 0.4);
    const node = (v: number[] | string) => ({
      shape: "heightfield",
      size: [6, 1.5, 6],
      heightfield: { width: 17, depth: 17, values: v },
    });
    const a = createVolume(volumeDocSchema.parse({ voxelSize: 0.25, nodes: [node(values)] }));
    const b = createVolume(volumeDocSchema.parse({ voxelSize: 0.25, nodes: [node(encodeHeightfieldValues(values))] }));
    for (let i = 0; i < 200; i++) {
      const x = (i % 13) * 0.53 - 3.4;
      const y = ((i * 7) % 11) * 0.31 - 1.6;
      const z = ((i * 5) % 17) * 0.41 - 3.4;
      expect(b.density(x, y, z)).toBe(a.density(x, y, z));
    }
  });
});

describe("heightfield meshing", () => {
  it("meshes a stepped floor closed, with the step still a step", () => {
    const step = 0.4;
    const doc = volumeDocSchema.parse({
      voxelSize: 0.25,
      palette: ["a"],
      nodes: [
        {
          id: "ground",
          shape: "heightfield",
          size: [8, 1, 8],
          heightfield: { width: 33, depth: 33, values: grid(33, 33, 8, 8, (x) => (x < 0 ? 0 : step)) },
        },
      ],
    });
    const mesh = buildVolumeMesh(createVolume(doc));
    expect(mesh.triangleCount).toBeGreaterThan(100);
    expect([...mesh.positions].every(Number.isFinite)).toBe(true);
    const { open, nonManifold } = survey(mesh);
    expect(open, "holes").toBe(0);
    expect(nonManifold, "edges shared by more than two faces").toBe(0);

    // The two treads and the riser between them. A dual contour solves a
    // riser this steep from an APPROXIMATE field, so it overshoots the corner
    // by a fraction of a voxel — hence a tolerance rather than an equality.
    expect(Math.abs(mesh.max[1] - step)).toBeLessThan(0.1);
    expect(Math.abs(mesh.min[1] + 1)).toBeLessThan(0.1);
    const ys: number[] = [];
    for (let i = 0; i < mesh.vertexCount; i++) if (mesh.normals[i * 3 + 1]! > 0.8) ys.push(mesh.positions[i * 3 + 1]!);
    expect(ys.some((y) => Math.abs(y - step) < 0.03), "upper tread at the step height").toBe(true);
    expect(ys.some((y) => Math.abs(y) < 0.03), "lower tread at zero").toBe(true);
    expect(ys.every((y) => y < step + 0.1), "nothing above the step").toBe(true);
  });

  it("vaults a box room with a cosine ceiling, springing from the eaves", () => {
    const eaves = -0.15;
    const crown = 1.2;
    const profile = (x: number): number =>
      Math.abs(x) >= 3.5 ? eaves : eaves + (crown - eaves) * Math.cos((Math.PI * x) / 7);
    const doc = volumeDocSchema.parse({
      voxelSize: 0.25,
      palette: ["a"],
      nodes: [
        { id: "plinth", op: "add", shape: "box", position: [0, -2, 0], size: [10, 4, 10] },
        { id: "room", op: "sub", shape: "box", position: [0, -1.5, 0], size: [8, 4, 8] },
        {
          id: "vault",
          op: "add",
          shape: "heightfield",
          position: [0, 0, 0],
          size: [10, 0.6, 10],
          heightfield: { width: 41, depth: 41, mode: "ceiling", values: grid(41, 41, 10, 10, (x) => profile(x)) },
        },
      ],
    });
    const mesh = buildVolumeMesh(createVolume(doc));
    expect(mesh.triangleCount).toBeGreaterThan(500);
    expect(survey(mesh).open, "holes").toBe(0);

    // the ceiling over the room: downward-facing, above the room floor
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = mesh.positions[i * 3]!;
      const y = mesh.positions[i * 3 + 1]!;
      const z = mesh.positions[i * 3 + 2]!;
      if (mesh.normals[i * 3 + 1]! > -0.7) continue;
      if (Math.abs(x) > 3.8 || Math.abs(z) > 3.8 || y < -1) continue;
      if (y < lowest) lowest = y;
      if (y > highest) highest = y;
    }
    expect(lowest, "the vault springs from the eaves").toBeCloseTo(eaves, 1);
    expect(highest, "and crowns in the middle").toBeCloseTo(crown, 1);
  });

  it("carves a box with a heightfield sub", () => {
    const doc = volumeDocSchema.parse({
      voxelSize: 0.25,
      palette: ["rock", "dug"],
      surface: { floor: 0, wall: 0, ceiling: 0 },
      nodes: [
        { id: "rock", op: "add", shape: "box", position: [0, 0, 0], size: [8, 4, 8] },
        {
          id: "dig",
          op: "sub",
          shape: "heightfield",
          position: [0, 0, 0],
          size: [6, 2, 6],
          surface: { floor: 1, wall: 1, ceiling: 1 },
          heightfield: {
            width: 13,
            depth: 13,
            values: grid(13, 13, 6, 6, (x, z) => 0.5 + 0.2 * Math.sin(x) * Math.cos(z)),
          },
        },
      ],
    });
    const v = createVolume(doc);
    expect(v.density(0, 0, 0), "in the excavation").toBeGreaterThan(0);
    expect(v.density(0, 1.2, 0), "rock left above it").toBeLessThan(0);
    expect(v.density(3.5, 0, 0), "rock outside the footprint").toBeLessThan(0);
    expect(v.density(0, -1.8, 0), "rock under the excavated floor").toBeLessThan(0);
    const out = new Float32Array(5);
    v.surfaceAt(0, -1.5, 0, 1, out, 0);
    expect(out[1], "the dug floor wears the sub node palette").toBeGreaterThan(0.9);
    const mesh = buildVolumeMesh(v);
    expect(mesh.triangleCount).toBeGreaterThan(500);
    expect(survey(mesh).open, "holes").toBe(0);
  });

it("keeps round, blend and noise working on a sampled surface", () => {
    const slab = (extra: Record<string, unknown>) =>
      createVolume(
        volumeDocSchema.parse({
          voxelSize: 0.25,
          nodes: [
            // a sphere, not a box: a node reaches only inside its padded AABB,
            // and an unpadded box IS its AABB, so nothing outside it ever blends
            { id: "pillar", op: "add", shape: "sphere", position: [0, 0, 0], radius: 1 },
            {
              id: "ground",
              op: "add",
              shape: "heightfield",
              position: [0, -1, 0],
              size: [8, 1, 8],
              heightfield: { width: 9, depth: 9, values: grid(9, 9, 8, 8, () => 0) },
              ...extra,
            },
          ],
        }),
      );
    const hard = slab({});
    // a blend fills the crease where the pillar meets the ground
    expect(slab({ blend: 1 }).density(0.9, -0.7, 0)).toBeLessThan(hard.density(0.9, -0.7, 0));
    // round inflates the slab, so a point just above the surface goes solid
    expect(hard.density(0, -0.85, 3)).toBeGreaterThan(0);
    expect(slab({ round: 0.3 }).density(0, -0.85, 3)).toBeLessThan(0);
    // noise perturbs it, deterministically
    const noisy = slab({ noise: { amount: 0.5, scale: 2, seed: 7 } });
    let difference = 0;
    for (let i = 0; i < 20; i++) difference += Math.abs(noisy.density(i * 0.3 - 3, -1, 1.1) - hard.density(i * 0.3 - 3, -1, 1.1));
    expect(difference).toBeGreaterThan(0.1);
    expect(noisy.density(0.7, -1, 1.1)).toBe(slab({ noise: { amount: 0.5, scale: 2, seed: 7 } }).density(0.7, -1, 1.1));
  });

  it("marks its field approximate, the way noise does", () => {
    const doc = (shape: string, extra: Record<string, unknown> = {}) =>
      volumeDocSchema.parse({ voxelSize: 0.5, nodes: [{ shape, size: [4, 1, 4], ...extra }] });
    expect(createVolume(doc("box")).approximate).toBe(false);
    expect(createVolume(doc("box", { noise: { amount: 0.5, scale: 2 } })).approximate).toBe(true);
    expect(
      createVolume(doc("heightfield", { heightfield: { width: 2, depth: 2, values: [0, 0, 0, 0] } })).approximate,
    ).toBe(true);
  });
});
