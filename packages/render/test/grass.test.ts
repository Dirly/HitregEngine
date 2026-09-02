import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { crossQuadGeometry, GrassSystem, applyFoliageNormals, foliageNormals } from "../src/index.js";

/**
 * The billboard geometry behind a textured ground-cover layer.
 *
 * The shape matters more than it looks: the quads have to stand ON the origin
 * (the instance matrix puts that point on the ground, so any vertex below y=0
 * buries the tuft) and their v coordinate has to run 0 at the base to 1 at the
 * top, because the wind sway reads the same fraction to keep the base pinned
 * while the tip moves.
 */
describe("cross-quad foliage geometry", () => {
  it("builds one quad per layer, evenly rotated about Y", () => {
    for (const quads of [1, 2, 3]) {
      const geometry = crossQuadGeometry(0.7, 0.9, quads);
      expect(geometry.getAttribute("position").count, `${quads} quads`).toBe(quads * 4);
      expect(geometry.getIndex()!.count, `${quads} quads`).toBe(quads * 6);
      geometry.dispose();
    }
  });

  it("stands on the origin and reaches exactly its height", () => {
    const geometry = crossQuadGeometry(0.7, 0.9, 2);
    const position = geometry.getAttribute("position");
    let minY = Infinity;
    let maxY = -Infinity;
    let maxRadius = 0;
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      maxRadius = Math.max(maxRadius, Math.hypot(position.getX(i), position.getZ(i)));
    }
    // a vertex below zero buries the tuft, one above the base floats it
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(0.9, 6);
    // width is the full span, so the half-extent from the axis is half of it
    expect(maxRadius).toBeCloseTo(0.35, 6);
    geometry.dispose();
  });

  it("runs v from 0 at the base to 1 at the top, which the sway reads", () => {
    const geometry = crossQuadGeometry(0.7, 0.9, 2);
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    expect(uv.count).toBe(position.count);
    for (let i = 0; i < position.count; i++) {
      const grounded = position.getY(i) < 1e-6;
      expect(uv.getY(i), `vertex ${i}`).toBeCloseTo(grounded ? 0 : 1, 6);
      expect(uv.getX(i) === 0 || uv.getX(i) === 1, `vertex ${i} u`).toBe(true);
    }
    geometry.dispose();
  });

  it("faces different directions per quad, so a tuft does not vanish edge-on", () => {
    const single = crossQuadGeometry(1, 1, 1);
    const cross = crossQuadGeometry(1, 1, 2);
    // the second quad's base edge must not be parallel to the first's
    const dir = (g: typeof single, quad: number): [number, number] => {
      const p = g.getAttribute("position");
      const a = quad * 4;
      return [p.getX(a + 1) - p.getX(a), p.getZ(a + 1) - p.getZ(a)];
    };
    const [ax, az] = dir(cross, 0);
    const [bx, bz] = dir(cross, 1);
    const cosine = Math.abs((ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz)));
    expect(cosine).toBeLessThan(0.2); // ~perpendicular for two quads
    single.dispose();
    cross.dispose();
  });
});

/**
 * Placement stability. This is the bug that made cover "change locations while
 * rotating the camera": the patch recenters as the camera moves, and if a
 * tuft's position is an offset from the current centre, every recenter
 * teleports every tuft. Anchoring the jittered grid to the WORLD means a
 * recenter only changes which cells are in range.
 */
describe("world-anchored foliage placement", () => {
  const data = {
    bladeColor: "#ffffff",
    tipColor: "#ffffff",
    bladeWidth: 0.7,
    bladeHeight: 0.9,
    crossQuads: 2,
    alphaTest: 0.35,
    surfaces: [] as string[],
    minSurface: 0.5,
    slopeMax: 1,
    density: 1,
    radius: 24,
    windStrength: 0.05,
    windSpeed: 1,
    heightFadeStart: 100,
    heightFadeEnd: 200,
  };

  /** Every instance's world position and yaw, for a camera at (x, z). */
  function placements(x: number, z: number): Map<string, string> {
    const group = new THREE.Object3D();
    const system = new GrassSystem();
    system.register("cover", group, data);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(x, 40, z);
    camera.updateMatrixWorld(true);
    system.update(camera, () => 0, () => 0);
    const mesh = group.children[0] as THREE.InstancedMesh;
    const out = new Map<string, string>();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      out.set(`${p.x.toFixed(4)},${p.z.toFixed(4)}`, `${q.y.toFixed(4)}|${s.x.toFixed(4)}`);
    }
    system.clear();
    return out;
  }

  it("keeps a tuft at the same world point after the patch recenters", () => {
    const before = placements(0, 0);
    // far enough to force a recenter (cell = radius * RECENTER_FRACTION), and
    // in a direction that keeps most of the disc overlapping
    const after = placements(20, 0);
    expect(before.size).toBeGreaterThan(200);
    let shared = 0;
    for (const [position, properties] of before) {
      const moved = after.get(position);
      if (moved === undefined) continue;
      shared += 1;
      // and its yaw and size came along with it, not just its footprint
      expect(moved, `tuft at ${position}`).toBe(properties);
    }
    // the two discs overlap heavily, so most tufts must have survived IN PLACE
    expect(shared).toBeGreaterThan(before.size * 0.4);
  });

  it("is identical for the same camera cell, whatever route it arrived by", () => {
    const a = placements(3, 3);
    const b = placements(-3, -3); // same snapped centre
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  });
});

/**
 * Leaf-card normals. An exporter gives each canopy quad its own flat face
 * normal — pointing every which way, several straight down — so lighting is
 * per-card and binary: one plate blown out, the next black. Measured on the
 * demo maple: 106 distinct normals over 278 vertices, `(0,-1,0)` among them.
 * The VERTICAL cards are the worst case, because a horizontal normal gets
 * almost nothing from a high sun.
 */
describe("foliage normals", () => {
  /** Two quads: one lying flat, one standing vertical, both above the origin. */
  function canopy(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      -1, 2, -1, 1, 2, -1, 1, 2, 1, -1, 2, 1,        // flat card, normal +Y
      -1, 1, 0, 1, 1, 0, 1, 3, 0, -1, 3, 0,          // vertical card, normal +Z
    ]), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]), 3));
    return g;
  }

  it("turns flat card normals into an outward sphere", () => {
    const g = canopy();
    expect(foliageNormals(g, { blend: 1 })).toBe(true);
    const n = g.getAttribute("normal");
    // every normal stays unit length — a zero-length one renders black
    for (let i = 0; i < n.count; i++) {
      expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)), `vertex ${i}`).toBeCloseTo(1, 5);
    }
    // and they now DIVERGE across a card instead of all being identical, which
    // is what gives a canopy gradation instead of flat plates
    const first = [n.getX(0), n.getY(0), n.getZ(0)];
    const second = [n.getX(1), n.getY(1), n.getZ(1)];
    expect(first).not.toEqual(second);
  });

  it("tilts the vertical cards upward, which is the case that went black", () => {
    const g = canopy();
    foliageNormals(g, { blend: 1 });
    const n = g.getAttribute("normal");
    // vertices 4..7 are the vertical card; its authored normal was (0,0,1),
    // dead horizontal, so a high sun gave it nothing
    let upward = 0;
    for (let i = 4; i < 8; i++) if (n.getY(i) > 0.15) upward += 1;
    expect(upward, "vertical card still has no upward component anywhere").toBeGreaterThan(0);
  });

  it("is idempotent, because one glTF geometry is shared by every instance", () => {
    const g = canopy();
    expect(foliageNormals(g, { blend: 1 })).toBe(true);
    const before = Array.from((g.getAttribute("normal") as THREE.BufferAttribute).array);
    expect(foliageNormals(g, { blend: 1 })).toBe(false);
    expect(Array.from((g.getAttribute("normal") as THREE.BufferAttribute).array)).toEqual(before);
  });

  it("leaves the authored normals alone at blend 0", () => {
    const g = canopy();
    const before = Array.from((g.getAttribute("normal") as THREE.BufferAttribute).array);
    foliageNormals(g, { blend: 0 });
    const after = Array.from((g.getAttribute("normal") as THREE.BufferAttribute).array);
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 5));
  });

  it("only touches alpha-cutout meshes — a trunk must not light like a balloon", () => {
    const leaves = new THREE.Mesh(canopy(), new THREE.MeshStandardMaterial({ alphaTest: 0.5 }));
    const trunk = new THREE.Mesh(canopy(), new THREE.MeshStandardMaterial());
    const root = new THREE.Object3D();
    root.add(leaves, trunk);
    expect(applyFoliageNormals(root, { blend: 1 })).toBe(1);
    const t = trunk.geometry.getAttribute("normal");
    expect([t.getX(4), t.getY(4), t.getZ(4)]).toEqual([0, 0, 1]);
  });
});
