import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { attachSkeletonDebug, countAttachedSkeletonDebug, setSkeletonDebugAttached } from "../src/index.js";

/**
 * The skeleton overlay must leave the scene graph when it is off: three's
 * matrix walk ignores `visible`, and a joint per bone on eight animated rigs
 * was ~5 ms/frame of updateMatrixWorld at the mmo spawn with the overlay
 * hidden. Bones here are unnamed so no canvas label is built (no DOM in node).
 */
function rig(boneCount: number): { scene: THREE.Scene; root: THREE.Group; bones: THREE.Bone[] } {
  const scene = new THREE.Scene();
  const entity = new THREE.Group();
  const root = new THREE.Group();
  root.userData["modelRoot"] = true;
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < boneCount; i++) {
    const b = new THREE.Bone();
    b.position.y = 0.3;
    if (i > 0) bones[i - 1]!.add(b);
    bones.push(b);
  }
  const geometry = new THREE.BoxGeometry(0.2, 1, 0.2);
  const count = geometry.attributes["position"]!.count;
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(count * 4).fill(0).map((_, k) => (k % 4 === 0 ? 1 : 0)), 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.add(bones[0]!);
  mesh.bind(new THREE.Skeleton(bones));
  root.add(mesh);
  entity.add(root);
  scene.add(entity);
  return { scene, root, bones };
}

function walked(scene: THREE.Scene): number {
  let n = 0;
  scene.traverse(() => n++);
  return n;
}

describe("skeleton debug overlay", () => {
  it("decorates a rig with a joint per bone plus one helper, and takes them all out of the graph when detached", () => {
    const { scene, root, bones } = rig(5);
    const bare = walked(scene);
    attachSkeletonDebug(new Map([["e", root.parent!]]));
    expect(countAttachedSkeletonDebug(scene)).toBe(bones.length + 1);
    expect(walked(scene)).toBe(bare + bones.length + 1);

    setSkeletonDebugAttached(scene, false);
    expect(countAttachedSkeletonDebug(scene)).toBe(0);
    expect(walked(scene)).toBe(bare); // nothing left for updateMatrixWorld to visit
    for (const b of bones) expect(b.children.every((c) => !c.userData["skeletonDebug"])).toBe(true);

    setSkeletonDebugAttached(scene, true);
    expect(countAttachedSkeletonDebug(scene)).toBe(bones.length + 1);
    expect(bones[2]!.children.some((c) => c.userData["skeletonDebug"])).toBe(true); // back on its own bone
    setSkeletonDebugAttached(scene, true); // idempotent: no duplicates
    expect(countAttachedSkeletonDebug(scene)).toBe(bones.length + 1);
  });

  it("is idempotent per rig and only decorates rigs", () => {
    const { scene, root } = rig(3);
    const plain = new THREE.Group();
    plain.userData["modelRoot"] = true;
    plain.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    scene.add(plain);
    const objects = new Map([["e", root.parent!], ["p", plain]]);
    attachSkeletonDebug(objects);
    attachSkeletonDebug(objects);
    expect(countAttachedSkeletonDebug(scene)).toBe(4);
  });
});
