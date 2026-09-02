import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import { detachFlagged } from "./physics-debug.js";

/**
 * Light direction visualization: an arrow for directional/spot lights (their
 * actual enforced shine direction — local -Y, per scene-builder.ts's
 * `dir.target.position.set(0, -1, 0)` — rotated by whatever the entity's own
 * transform is), plus a cone wireframe for spot lights showing range/angle.
 * Point/ambient lights have no "direction" to show. Visuals are parented to
 * each entity's object so they follow gizmo drags exactly like physics debug.
 */

interface LightData {
  kind: "directional" | "point" | "spot" | "ambient";
  color: string;
  range: number;
  angle: number;
}

const ARROW_LENGTH = 4;
const ARROW_COLOR = 0xffe066;
// the actual enforced shine direction (scene-builder.ts: target fixed at
// local [0,-1,0]) — every directional/spot light points this way in its own
// local space, however the entity itself is rotated.
const LOCAL_DOWN = new THREE.Vector3(0, -1, 0);

function xray<T extends THREE.Material>(material: T): T {
  material.depthTest = false;
  material.transparent = true;
  material.opacity = 0.85;
  return material;
}

/** Remove + dispose every visual attachLightDebug added under `root` (in-place toggle off). */
export function detachLightDebug(root: THREE.Object3D): void {
  detachFlagged(root, "lightDebug");
}

/**
 * Attach direction-gizmo visuals for every directional/spot light in an
 * EXPANDED doc, as children of the corresponding entity objects. Call during
 * scene rebuild; visuals die with the scene they belong to.
 */
export function attachLightDebug(doc: SceneDoc, objects: Map<string, THREE.Object3D>): void {
  for (const [id, entity] of Object.entries(doc.entities)) {
    const light = entity.components["light"] as LightData | undefined;
    if (!light || (light.kind !== "directional" && light.kind !== "spot")) continue;
    const object = objects.get(id);
    if (!object) continue;

    const arrow = new THREE.ArrowHelper(LOCAL_DOWN, new THREE.Vector3(0, 0, 0), ARROW_LENGTH, ARROW_COLOR, 0.8, 0.4);
    arrow.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.material) xray(mesh.material as THREE.Material);
      node.renderOrder = 999;
    });
    arrow.userData["lightDebug"] = true;
    object.add(arrow);

    if (light.kind === "spot") {
      const range = Math.max(light.range, 0.5);
      const radius = range * Math.tan(light.angle);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(radius, range, 16, 1, true),
        xray(new THREE.MeshBasicMaterial({ color: ARROW_COLOR, wireframe: true })),
      );
      // ConeGeometry points +Y from its center by default; rotate to point
      // -Y (the enforced shine direction) and shift so its apex sits at the
      // light's own local origin instead of the cone's center.
      cone.rotation.x = Math.PI;
      cone.position.y = -range / 2;
      cone.renderOrder = 999;
      cone.userData["lightDebug"] = true;
      object.add(cone);
    }
  }
}
