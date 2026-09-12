import * as THREE from "three/webgpu";

/**
 * Skeleton X-ray for skinned models: a SkeletonHelper per rig plus a small
 * joint marker and a name label on every bone, so users can SEE the rig and
 * pick bone names (bone-socket etc.) instead of guessing.
 *
 * Everything is tagged userData["skeletonDebug"]. Idempotent: rigs already
 * decorated are skipped, so it is safe to call from every onModelLoaded
 * (models arrive async, one callback per model).
 *
 * Hiding is NOT `visible = false`: three's per-frame matrix walk ignores
 * visibility, and a joint + label per bone is ~165 objects per rig hanging
 * off animated bones — eight characters at a spawn cost ~5 ms/frame of
 * updateMatrixWorld while the overlay was off (docs/performance-lessons.md).
 * So the host attaches lazily (only while the overlay is on) and
 * `setSkeletonDebugAttached(scene, false)` takes the helpers OUT of the
 * graph, remembering their parents so they can go back.
 */

const JOINT_COLOR = 0x79c0ff;
const ATTACHED_FLAG = "skeletonDebugAttached";
/** Per decorated rig root: every helper node and the parent it hangs from. */
const NODES_KEY = "skeletonDebugNodes";
type HelperNode = { parent: THREE.Object3D; node: THREE.Object3D };

// shared across all rigs — a tiny octahedron scaled per joint
const jointGeometry = new THREE.OctahedronGeometry(1);
const jointMaterial = new THREE.MeshBasicMaterial({
  color: JOINT_COLOR,
  depthTest: false,
  transparent: true,
  opacity: 0.9,
});

/** Ordered, deduped bone names across every SkinnedMesh under `root`. */
export function collectBones(root: THREE.Object3D): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  root.traverse((node) => {
    if (!(node as THREE.SkinnedMesh).isSkinnedMesh) return;
    for (const bone of (node as THREE.SkinnedMesh).skeleton.bones) {
      if (bone.name && !seen.has(bone.name)) {
        seen.add(bone.name);
        names.push(bone.name);
      }
    }
  });
  return names;
}

/** Every distinct Bone object across the SkinnedMeshes under `root`. */
function uniqueBones(root: THREE.Object3D): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  const seen = new Set<THREE.Bone>();
  root.traverse((node) => {
    if (!(node as THREE.SkinnedMesh).isSkinnedMesh) return;
    for (const bone of (node as THREE.SkinnedMesh).skeleton.bones) {
      if (!seen.has(bone)) {
        seen.add(bone);
        bones.push(bone);
      }
    }
  });
  return bones;
}

/** Canvas-texture name tag — lives inside the Three scene (no CSS2DRenderer). */
function makeLabel(text: string, height: number): THREE.Sprite {
  const pad = 6;
  const fontPx = 28;
  const font = `${fontPx}px ui-monospace, monospace`;
  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d")!;
  ctx.font = font;
  canvas.width = Math.max(2, Math.ceil(ctx.measureText(text).width) + pad * 2);
  canvas.height = fontPx + pad * 2;
  ctx = canvas.getContext("2d")!; // resizing resets 2d state
  ctx.font = font;
  ctx.fillStyle = "rgba(13, 17, 23, 0.72)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#e6edf3";
  ctx.textBaseline = "middle";
  ctx.fillText(text, pad, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  );
  // anchor at the joint, text growing to the right of it
  sprite.center.set(-0.12, 0.5);
  sprite.scale.set(height * (canvas.width / canvas.height), height, 1);
  return sprite;
}

/**
 * Attach skeleton visuals to every loaded model root (userData["modelRoot"])
 * that contains a SkinnedMesh. Joint markers and labels are parented to the
 * bones themselves so they track animation; the SkeletonHelper mirrors the
 * rig's WORLD matrix, so it lives at the scene root (under the entity group
 * it would transform twice). Line drawing uses LineBasicMaterial with
 * depthTest off — same recipe as the physics overlay, renders on both the
 * WebGPU and WebGL backends.
 */
export function attachSkeletonDebug(objects: Map<string, THREE.Object3D>): void {
  // collect first — decorating while traversing would mutate child lists
  const roots: THREE.Object3D[] = [];
  for (const object of objects.values()) {
    object.traverse((node) => {
      if (node.userData["modelRoot"]) roots.push(node);
    });
  }

  for (const root of roots) {
    if (root.userData[ATTACHED_FLAG]) continue;
    const bones = uniqueBones(root);
    if (bones.length === 0) continue;
    root.userData[ATTACHED_FLAG] = true;
    const nodes: HelperNode[] = [];
    root.userData[NODES_KEY] = nodes;

    let sceneRoot: THREE.Object3D = root;
    while (sceneRoot.parent) sceneRoot = sceneRoot.parent;

    const helper = new THREE.SkeletonHelper(root);
    (helper.material as THREE.LineBasicMaterial).depthTest = false;
    helper.renderOrder = 1000;
    helper.frustumCulled = false; // its geometry re-poses every frame
    helper.userData["skeletonDebug"] = true;
    sceneRoot.add(helper);
    nodes.push({ parent: sceneRoot, node: helper });

    // size everything relative to the rig so props and giants both read;
    // dense rigs (40+ bones) get smaller tags to stay legible
    root.updateWorldMatrix(true, true);
    const measured = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).length();
    const rigSize = Number.isFinite(measured) && measured > 0 ? measured : 2;
    const jointRadius = rigSize * 0.006;
    const labelHeight = rigSize * (bones.length > 40 ? 0.014 : 0.02);

    const worldScale = new THREE.Vector3();
    for (const bone of bones) {
      // counter the bone's world scale (mixamo rigs bake cm→m on the armature)
      bone.getWorldScale(worldScale);
      const s =
        (Math.abs(worldScale.x) + Math.abs(worldScale.y) + Math.abs(worldScale.z)) / 3 || 1;

      const joint = new THREE.Mesh(jointGeometry, jointMaterial);
      joint.scale.setScalar(jointRadius / s);
      joint.renderOrder = 1001;
      joint.userData["skeletonDebug"] = true;
      bone.add(joint);
      nodes.push({ parent: bone, node: joint });

      if (bone.name) {
        const label = makeLabel(bone.name, labelHeight / s);
        label.renderOrder = 1002;
        label.userData["skeletonDebug"] = true;
        bone.add(label);
        nodes.push({ parent: bone, node: label });
      }
    }
  }
}

/**
 * Put every rig's helpers back into the graph (`attached: true`) or take
 * them out (`false`). Detached helpers keep their parents in userData, so
 * this is a cheap toggle — nothing is rebuilt. Rigs decorated later (a model
 * that finished loading while the overlay was off) are simply not decorated
 * until the host calls `attachSkeletonDebug` again.
 */
export function setSkeletonDebugAttached(scene: THREE.Object3D, attached: boolean): void {
  const rigs: HelperNode[][] = [];
  scene.traverse((node) => {
    const nodes = node.userData[NODES_KEY] as HelperNode[] | undefined;
    if (node.userData[ATTACHED_FLAG] && nodes) rigs.push(nodes);
  });
  for (const nodes of rigs) {
    for (const { parent, node } of nodes) {
      if (attached) {
        if (node.parent !== parent) parent.add(node);
        node.visible = true;
      } else if (node.parent) {
        node.parent.remove(node);
      }
    }
  }
}

/** How many helper nodes are in the graph right now — for tests and probes. */
export function countAttachedSkeletonDebug(scene: THREE.Object3D): number {
  let n = 0;
  scene.traverse((node) => {
    if (node.userData["skeletonDebug"]) n++;
  });
  return n;
}
