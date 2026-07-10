import type { SceneDoc } from "./scene.js";
import type { EntityId } from "./ids.js";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function vecApplyQuat(v: Vec3, q: Quat): Vec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  // v' = v + qw*t + qvec x t, where t = 2 * (qvec x v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

export interface WorldTransform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

const IDENTITY: WorldTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

interface TransformComponent {
  position?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
}

/**
 * Resolve world-space transforms for every entity in a (typically expanded)
 * scene doc. Physics, netcode, and spatial queries all consume world space;
 * documents store local space.
 */
export function worldTransforms(doc: SceneDoc): Map<EntityId, WorldTransform> {
  const out = new Map<EntityId, WorldTransform>();

  const resolve = (id: EntityId): WorldTransform => {
    const cached = out.get(id);
    if (cached) return cached;
    const entity = doc.entities[id]!;
    const t = (entity.components["transform"] ?? {}) as TransformComponent;
    const local: WorldTransform = {
      position: t.position ?? [0, 0, 0],
      rotation: t.rotation ?? [0, 0, 0, 1],
      scale: t.scale ?? [1, 1, 1],
    };
    const parent =
      entity.parent !== null && entity.parent in doc.entities
        ? resolve(entity.parent)
        : IDENTITY;

    const scaledLocalPos: Vec3 = [
      local.position[0] * parent.scale[0],
      local.position[1] * parent.scale[1],
      local.position[2] * parent.scale[2],
    ];
    const rotated = vecApplyQuat(scaledLocalPos, parent.rotation);
    const world: WorldTransform = {
      position: [
        parent.position[0] + rotated[0],
        parent.position[1] + rotated[1],
        parent.position[2] + rotated[2],
      ],
      rotation: quatMultiply(parent.rotation, local.rotation),
      scale: [
        parent.scale[0] * local.scale[0],
        parent.scale[1] * local.scale[1],
        parent.scale[2] * local.scale[2],
      ],
    };
    out.set(id, world);
    return world;
  };

  for (const id of Object.keys(doc.entities)) resolve(id);
  return out;
}
