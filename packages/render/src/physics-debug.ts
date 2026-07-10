import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";

/**
 * X-ray physics visualization: collider wireframes, joint anchors, and
 * hinge/slider axes. Visuals are parented to each entity's object so they
 * follow gizmo drags in edit mode AND simulated bodies in play mode.
 *
 * Colors: dynamic orange, static green, kinematic blue, triggers yellow,
 * joints purple.
 */

interface ColliderData {
  shape: "box" | "sphere" | "capsule" | "cylinder";
  size: [number, number, number];
  offset: [number, number, number];
  isTrigger: boolean;
}

interface JointData {
  kind: "fixed" | "hinge" | "slider" | "ball";
  target: string;
  anchorA: [number, number, number];
  anchorB: [number, number, number];
  axis: [number, number, number];
}

const COLORS = {
  dynamic: 0xf0883e,
  static: 0x2ea043,
  kinematic: 0x58a6ff,
  trigger: 0xe3b341,
  joint: 0xd2a8ff,
} as const;

function xray<T extends THREE.Material>(material: T): T {
  material.depthTest = false;
  material.transparent = true;
  material.opacity = 0.85;
  return material;
}

function colliderGeometry(collider: ColliderData): THREE.BufferGeometry {
  const [x, y, z] = collider.size;
  switch (collider.shape) {
    case "sphere":
      return new THREE.SphereGeometry(x / 2, 12, 8);
    case "capsule":
      return new THREE.CapsuleGeometry(x / 2, Math.max(0, y - x), 4, 8);
    case "cylinder":
      return new THREE.CylinderGeometry(x / 2, x / 2, y, 12);
    case "box":
    default:
      return new THREE.BoxGeometry(x, y, z);
  }
}

/**
 * Attach debug visuals for every collider/joint in an EXPANDED doc as
 * children of the corresponding entity objects. Call during scene rebuild;
 * visuals die with the scene they belong to.
 */
export function attachPhysicsDebug(
  doc: SceneDoc,
  objects: Map<string, THREE.Object3D>,
): void {
  for (const [id, entity] of Object.entries(doc.entities)) {
    const object = objects.get(id);
    if (!object) continue;

    const collider = entity.components["collider"] as ColliderData | undefined;
    const rigidbody = entity.components["rigidbody"] as { kind?: string } | undefined;
    const joint = entity.components["joint"] as JointData | undefined;

    if (collider) {
      const color = collider.isTrigger
        ? COLORS.trigger
        : rigidbody?.kind === "dynamic" || (rigidbody && rigidbody.kind === undefined)
          ? COLORS.dynamic
          : rigidbody?.kind === "kinematic"
            ? COLORS.kinematic
            : COLORS.static;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(colliderGeometry(collider), 20),
        xray(new THREE.LineBasicMaterial({ color })),
      );
      edges.position.fromArray(collider.offset);
      edges.renderOrder = 999;
      edges.userData["physicsDebug"] = true;
      object.add(edges);
    }

    if (joint) {
      // anchor on this body
      const anchor = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 8, 6),
        xray(new THREE.MeshBasicMaterial({ color: COLORS.joint })),
      );
      anchor.position.fromArray(joint.anchorA);
      anchor.renderOrder = 1000;
      anchor.userData["physicsDebug"] = true;
      object.add(anchor);

      // axis arrow for hinge/slider
      if (joint.kind === "hinge" || joint.kind === "slider") {
        const dir = new THREE.Vector3().fromArray(joint.axis).normalize();
        const arrow = new THREE.ArrowHelper(
          dir,
          new THREE.Vector3().fromArray(joint.anchorA),
          0.9,
          COLORS.joint,
          0.18,
          0.1,
        );
        arrow.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.material) xray(mesh.material as THREE.Material);
          node.renderOrder = 1000;
        });
        arrow.userData["physicsDebug"] = true;
        object.add(arrow);
      }

      // anchor marker on the target body
      const targetObject = objects.get(joint.target);
      if (targetObject) {
        const anchorB = anchor.clone();
        anchorB.position.fromArray(joint.anchorB);
        targetObject.add(anchorB);
      }
    }
  }
}
