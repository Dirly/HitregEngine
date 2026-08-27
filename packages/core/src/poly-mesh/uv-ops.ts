import { faceUvSchema, type FaceUv, type PolyMesh, type Vec2, type Vec3 } from "./types.js";
import { buildTopology } from "./topology.js";
import { computeFaceUvs, planarProject } from "./compile.js";
import { cloneMesh } from "./ops.js";
import { normalize, polygonAreaVector } from "./vec.js";

/**
 * UV editing — the ProBuilder UV editor's operations as pure functions.
 *
 * Two regimes, per face:
 * - AUTO: the face carries unwrap settings (tiling/offset/rotation/flip/
 *   anchor/fill/group) and its coordinates are derived at compile time.
 *   `setAutoUv` tweaks those knobs; this is what most level work uses.
 * - MANUAL: explicit per-corner coordinates, produced the first time a face
 *   is projected or hand-transformed here. `transformUvs` moves/rotates/
 *   scales them in UV space; `resetUvs` returns the face to auto.
 */

/** Merge a settings patch into the given faces' auto-unwrap settings (they stay/become auto). */
export function setAutoUv(mesh: PolyMesh, faces: number[], patch: Partial<Omit<FaceUv, "coords" | "mode">>): PolyMesh {
  const out = cloneMesh(mesh);
  for (const fi of faces) {
    const face = out.faces[fi];
    if (!face) continue;
    const current = faceUvSchema.parse(face.uv ?? {});
    const { coords: _c, ...rest } = current;
    face.uv = { ...rest, ...patch, mode: "auto" };
  }
  return out;
}

/** Back to auto-unwrap with default settings. */
export function resetUvs(mesh: PolyMesh, faces: number[]): PolyMesh {
  const out = cloneMesh(mesh);
  for (const fi of faces) {
    const face = out.faces[fi];
    if (face) delete face.uv;
  }
  return out;
}

/** Freeze the faces' CURRENT (computed) coordinates as manual UVs. The first step of any hand edit. */
export function freezeUvs(mesh: PolyMesh, faces: number[]): PolyMesh {
  const out = cloneMesh(mesh);
  const uvs = computeFaceUvs(mesh, buildTopology(mesh));
  for (const fi of faces) {
    const face = out.faces[fi];
    if (!face) continue;
    face.uv = { ...faceUvSchema.parse(face.uv ?? {}), mode: "manual", coords: uvs[fi]!.map((c) => [c[0], c[1]] as Vec2) };
  }
  return out;
}

/** Planar-project faces together onto one plane (their average normal, or `normal`) as manual UVs — a shared seamless map across the selection. */
export function planarProjectFaces(mesh: PolyMesh, faces: number[], normal?: Vec3, tiling = 1): PolyMesh {
  const out = cloneMesh(mesh);
  const projected = planarProject(mesh, faces, normal);
  faces.forEach((fi, i) => {
    const face = out.faces[fi];
    if (!face) return;
    face.uv = {
      ...faceUvSchema.parse(face.uv ?? {}),
      mode: "manual",
      coords: projected[i]!.map((c) => [c[0] * tiling, c[1] * tiling] as Vec2),
    };
  });
  return out;
}

/** Box-project: each face projects along its dominant world axis (X/Y/Z) as manual UVs. */
export function boxProjectFaces(mesh: PolyMesh, faces: number[], tiling = 1): PolyMesh {
  const out = cloneMesh(mesh);
  for (const fi of faces) {
    const face = out.faces[fi];
    if (!face) continue;
    const n = normalize(polygonAreaVector(face.v.map((i) => mesh.vertices[i]!)));
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    const axis: Vec3 = ax >= ay && ax >= az ? [Math.sign(n[0]) || 1, 0, 0] : ay >= az ? [0, Math.sign(n[1]) || 1, 0] : [0, 0, Math.sign(n[2]) || 1];
    const projected = planarProject(mesh, [fi], axis)[0]!;
    face.uv = { ...faceUvSchema.parse(face.uv ?? {}), mode: "manual", coords: projected.map((c) => [c[0] * tiling, c[1] * tiling] as Vec2) };
  }
  return out;
}

export interface UvTransform {
  translate?: Vec2;
  /** Degrees, counter-clockwise, about `pivot`. */
  rotate?: number;
  scale?: Vec2;
  /** UV-space pivot for rotate/scale; default = the selection's bounding-box center. */
  pivot?: Vec2;
}

/** Move/rotate/scale the faces' UVs (freezing them to manual first). */
export function transformUvs(mesh: PolyMesh, faces: number[], t: UvTransform): PolyMesh {
  const frozen = freezeUvs(mesh, faces);
  const out = cloneMesh(frozen);
  const pivot = t.pivot ?? uvBounds(out, faces).center;
  const r = ((t.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = t.scale?.[0] ?? 1;
  const sy = t.scale?.[1] ?? 1;
  const tx = t.translate?.[0] ?? 0;
  const ty = t.translate?.[1] ?? 0;
  for (const fi of faces) {
    const face = out.faces[fi];
    if (!face?.uv?.coords) continue;
    face.uv.coords = face.uv.coords.map(([u, v]) => {
      let x = (u - pivot[0]) * sx;
      let y = (v - pivot[1]) * sy;
      if (r !== 0) {
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        x = rx;
        y = ry;
      }
      return [x + pivot[0] + tx, y + pivot[1] + ty] as Vec2;
    });
  }
  return out;
}

/** Scale the selection's UVs into the 0..1 square (keeping aspect unless `stretch`). */
export function fitUvs(mesh: PolyMesh, faces: number[], stretch = false): PolyMesh {
  const frozen = freezeUvs(mesh, faces);
  const { min, max } = uvBounds(frozen, faces);
  const w = Math.max(1e-9, max[0] - min[0]);
  const h = Math.max(1e-9, max[1] - min[1]);
  const sx = stretch ? 1 / w : 1 / Math.max(w, h);
  const sy = stretch ? 1 / h : sx;
  return transformUvs(frozen, faces, { pivot: min, scale: [sx, sy], translate: [-min[0], -min[1]] });
}

export function flipUvs(mesh: PolyMesh, faces: number[], axis: "u" | "v"): PolyMesh {
  const frozen = freezeUvs(mesh, faces);
  const { center } = uvBounds(frozen, faces);
  return transformUvs(frozen, faces, { pivot: center, scale: axis === "u" ? [-1, 1] : [1, -1] });
}

/** Set the texture group of faces (auto faces sharing a nonzero group project together). 0 clears. */
export function setUvGroup(mesh: PolyMesh, faces: number[], group: number): PolyMesh {
  return setAutoUv(mesh, faces, { group });
}

/** Copy the first face's auto settings (or manual coords when shapes match) onto the others. */
export function copyUvs(mesh: PolyMesh, from: number, to: number[]): PolyMesh {
  const source = mesh.faces[from];
  if (!source) return mesh;
  const out = cloneMesh(mesh);
  for (const fi of to) {
    const face = out.faces[fi];
    if (!face || fi === from) continue;
    if (!source.uv) {
      delete face.uv;
      continue;
    }
    if (source.uv.mode === "manual" && source.uv.coords && source.uv.coords.length !== face.v.length) {
      const { coords: _c, ...rest } = source.uv;
      face.uv = { ...rest, mode: "auto" };
    } else {
      face.uv = { ...source.uv, ...(source.uv.coords ? { coords: source.uv.coords.map((c) => [c[0], c[1]] as Vec2) } : {}) };
    }
  }
  return out;
}

/** Bounding box of the faces' current UVs (manual coords or computed auto). */
export function uvBounds(mesh: PolyMesh, faces: number[]): { min: Vec2; max: Vec2; center: Vec2 } {
  const uvs = computeFaceUvs(mesh, buildTopology(mesh));
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  for (const fi of faces) {
    for (const c of uvs[fi] ?? []) {
      min[0] = Math.min(min[0], c[0]);
      min[1] = Math.min(min[1], c[1]);
      max[0] = Math.max(max[0], c[0]);
      max[1] = Math.max(max[1], c[1]);
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0], max: [0, 0], center: [0, 0] };
  return { min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] };
}

/** Current per-corner UVs of the faces (what the UV editor draws). */
export function currentUvs(mesh: PolyMesh, faces: number[]): Vec2[][] {
  const uvs = computeFaceUvs(mesh, buildTopology(mesh));
  return faces.map((fi) => uvs[fi] ?? []);
}
