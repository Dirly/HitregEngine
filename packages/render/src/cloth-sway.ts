import * as THREE from "three/webgpu";
import { add, float, mul, positionLocal, uniform, attribute } from "three/tsl";
import { asNodeMaterial } from "./node-material.js";

/**
 * TSL nodes are structurally typed by their component count, and `uniform()`
 * / `attribute()` hand back an unparameterised node — so the arithmetic
 * helpers reject them until they are told what they are. `foliage-wind.ts`
 * carries the same cast for the same reason.
 */
type N = ReturnType<typeof float>;

/** Vertex attribute holding how freely each vertex hangs, 0 (pinned) to 1 (hem). */
const CLOTH_ATTR = "clothWeight";

export interface ClothSwayOptions {
  /** Peak lag at the hem, in metres. */
  strength: number;
  /** How fast the cloth catches up with the body. Higher is stiffer. */
  stiffness: number;
  /** Fraction of critical damping. Below 1 overshoots and settles — that is the swing. */
  damping: number;
  /** Idle shimmer amplitude in metres, for a character standing still. */
  flutter: number;
  flutterSpeed: number;
  /** A panel must hang at least this fraction of body height to count. */
  panelMinLength: number;
  /** ...and be thinner than this fraction, which is what separates a panel from a limb. */
  panelMaxThickness: number;
  /** ...and hang from between these two heights, which is where a belt is. */
  panelAttachMin: number;
  panelAttachMax: number;
}

export const DEFAULT_CLOTH_SWAY: ClothSwayOptions = {
  strength: 0.22,
  stiffness: 9,
  damping: 0.55,
  flutter: 0.012,
  flutterSpeed: 1.6,
  panelMinLength: 0.15,
  panelMaxThickness: 0.08,
  panelAttachMin: 0.3,
  panelAttachMax: 0.72,
};

interface Entry {
  root: THREE.Object3D;
  options: ClothSwayOptions;
  sway: THREE.Vector3;
  velocity: THREE.Vector3;
  previous: THREE.Vector3;
  /**
   * One uniform per mesh, because the offset has to be expressed in the space
   * `positionLocal` actually lives in — the MESH's geometry space, not the
   * model root's. Those differ by more than pedantry: an FBX-sourced character
   * carries a Z-up correction between them, so a vertical offset written in
   * root space arrives in the shader pointing forwards.
   */
  targets: Array<{ mesh: THREE.Mesh; value: THREE.Vector3 }>;
  hasPrevious: boolean;
  clock: number;
}

/**
 * Free-hanging cloth — tabards, tassets, cloaks — as a vertex-shader lag.
 *
 * WHY NOT BONES. A spring-bone chain is the high-fidelity answer, and it costs
 * per character: chains to integrate, bones to skin, an authoring step to place
 * them. This buys most of the look for effectively nothing per character — one
 * spring integrated on the CPU, one uniform uploaded, and the displacement
 * itself rides along in a vertex shader that was already running. A crowd costs
 * the same as one character. The trade is that cloth cannot collide with the
 * legs: it flows, it does not drape.
 *
 * WHICH VERTICES. Not a height test — the legs are below the belt too, and
 * swaying those is instantly worse than doing nothing. Not the skin weights
 * either: an auto-rigger routinely binds a skirt to the THIGH bones, so by that
 * measure a tabard and a trouser leg are indistinguishable.
 *
 * What does separate them is shape. A hanging panel is a connected island of
 * geometry that is thin, that hangs a long way, and that attaches around the
 * waist. A limb is none of those. So the selection is done on connected
 * components, which needs no naming convention, no material split, and nothing
 * authored into the model.
 */
export class ClothSwaySystem {
  private readonly entries = new Map<string, Entry>();

  /**
   * Give one entity's model cloth motion. Returns how many meshes were wired —
   * 0 means nothing in the model looked like a hanging panel, which is the
   * honest answer for a character with no cloth.
   */
  register(
    entityId: string,
    root: THREE.Object3D,
    options: ClothSwayOptions,
    report?: IslandReport[],
  ): number {
    this.unregister(entityId);
    const box = bindPoseBounds(root);
    const height = Math.max(1e-3, box.max.y - box.min.y);

    const targets: Entry["targets"] = [];
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!markClothVertices(mesh, box.min.y, height, options, report)) return;
      const uniformNode = uniform(new THREE.Vector3());
      applySwayNode(mesh, uniformNode);
      targets.push({ mesh, value: (uniformNode as unknown as { value: THREE.Vector3 }).value });
    });
    const wired = targets.length;
    if (wired === 0) return 0;

    this.entries.set(entityId, {
      root,
      options,
      sway: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      previous: new THREE.Vector3(),
      targets,
      hasPrevious: false,
      clock: 0,
    });
    return wired;
  }

  /**
   * Advance every cloth spring. Velocity is read off the model's own world
   * transform rather than taken from a script, so this works identically for
   * the local player, a networked ghost and an NPC — none of which share a
   * movement path.
   */
  update(dt: number): void {
    if (dt <= 0) return;
    const world = new THREE.Vector3();
    const target = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    for (const entry of this.entries.values()) {
      entry.root.getWorldPosition(world);
      if (!entry.hasPrevious) {
        entry.previous.copy(world);
        entry.hasPrevious = true;
        continue;
      }
      // Cloth trails the body, so the target offset points AGAINST travel and
      // grows with speed — then saturates, because a cloak does not stream out
      // twice as far when you run twice as fast.
      target.subVectors(world, entry.previous).divideScalar(dt);
      entry.previous.copy(world);
      target.y = 0;
      const speed = target.length();
      const reach = speed > 0 ? Math.min(1, speed / 6) / Math.max(speed, 1e-4) : 0;
      target.multiplyScalar(-reach * entry.options.strength);

      // critically-ish damped spring: the overshoot IS the swing, and the
      // damping is what makes it settle instead of wobbling forever
      const k = entry.options.stiffness;
      entry.velocity.addScaledVector(target.sub(entry.sway), k * dt);
      entry.velocity.multiplyScalar(Math.max(0, 1 - entry.options.damping * k * dt));
      entry.sway.addScaledVector(entry.velocity, dt);

      // A slow idle shimmer, added HERE in world space rather than in the
      // shader. Doing it in the shader means naming axes, and the axis names
      // depend on the model's authored orientation — a "horizontal" wobble
      // written as vec3(s, 0, s) is vertical on a Z-up mesh, which stretches
      // the cloth instead of moving it.
      entry.clock += dt;
      const f = entry.options.flutterSpeed;
      world.set(
        Math.sin(entry.clock * f) * entry.options.flutter,
        0,
        Math.cos(entry.clock * f * 0.73) * entry.options.flutter,
      );
      world.add(entry.sway);

      // Convert into each mesh's own geometry space — the frame positionLocal
      // is in — so the panels trail correctly whichever way the model is
      // authored and whichever way the character faces.
      for (const target of entry.targets) {
        target.mesh.getWorldQuaternion(quat).invert();
        target.value.copy(world).applyQuaternion(quat);
      }
    }
  }

  /** The current lag offset, in the first cloth mesh's space. Diagnostics and tests. */
  swayOf(entityId: string): THREE.Vector3 | null {
    return this.entries.get(entityId)?.targets[0]?.value ?? null;
  }

  unregister(entityId: string): void {
    this.entries.delete(entityId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Write the per-vertex hang weight, and report whether this mesh has any cloth
 * at all. Exported for tests — the selection is the part of this worth pinning
 * down, because it is geometry heuristics rather than anything declared.
 */
export interface IslandReport {
  verts: number;
  hang: number;
  thickness: number;
  attach: number;
  accepted: boolean;
}

export function markClothVertices(
  mesh: THREE.Mesh,
  baseY: number,
  height: number,
  options: ClothSwayOptions,
  report?: IslandReport[],
): boolean {
  const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position) return false;

  const islands = connectedIslands(mesh.geometry);
  const weights = new Float32Array(position.count);
  let any = false;

  const local = new THREE.Vector3();
  for (const island of islands) {
    const bounds = new THREE.Box3();
    for (const index of island) {
      local.fromBufferAttribute(position, index);
      mesh.localToWorld(local);
      bounds.expandByPoint(local);
    }
    const size = bounds.getSize(new THREE.Vector3());
    const hang = (bounds.max.y - bounds.min.y) / height;
    const thickness = Math.min(size.x, size.z) / height;
    const attach = (bounds.max.y - baseY) / height;
    const accepted =
      hang >= options.panelMinLength &&
      thickness <= options.panelMaxThickness &&
      attach >= options.panelAttachMin &&
      attach <= options.panelAttachMax;
    report?.push({
      verts: island.length,
      hang: +hang.toFixed(3),
      thickness: +thickness.toFixed(3),
      attach: +attach.toFixed(3),
      accepted,
    });
    if (!accepted) continue;
    // Ramp from pinned at the island's own top to free at its hem — per island,
    // not per model, so panels of different lengths each hang correctly.
    const span = Math.max(1e-4, bounds.max.y - bounds.min.y);
    for (const index of island) {
      local.fromBufferAttribute(position, index);
      mesh.localToWorld(local);
      const t = Math.min(1, Math.max(0, (bounds.max.y - local.y) / span));
      weights[index] = t * t; // squared: the top barely moves, the hem carries it
    }
    any = true;
  }
  if (!any) return false;
  mesh.geometry.setAttribute(CLOTH_ATTR, new THREE.BufferAttribute(weights, 1));
  return true;
}

/**
 * World bounds of the model as AUTHORED, built from each mesh's own geometry
 * bounds rather than from the object tree.
 *
 * `Box3.setFromObject` is the obvious call and it is wrong here: on a skinned
 * mesh it goes through the skinning-aware bounds, which on a real character rig
 * came back both mis-scaled and offset by tens of metres — enough to put every
 * island's measured attach height at -101. Everything downstream is a fraction
 * of these numbers, so they have to come from the vertices.
 */
function bindPoseBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const scratch = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox;
    if (!local) return;
    box.union(scratch.copy(local).applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

/** Vertex indices grouped into connected components, welded by position. */
function connectedIslands(geometry: THREE.BufferGeometry): number[][] {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const count = position.count;

  // weld first: an exported mesh is routinely un-indexed, where every triangle
  // owns its own copies and nothing is "connected" to anything
  const byKey = new Map<string, number>();
  const representative = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(position.getX(i) * 1e4)},${Math.round(position.getY(i) * 1e4)},${Math.round(position.getZ(i) * 1e4)}`;
    let rep = byKey.get(key);
    if (rep === undefined) {
      rep = i;
      byKey.set(key, rep);
    }
    representative[i] = rep;
  }

  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(representative[a]!);
    const rb = find(representative[b]!);
    if (ra !== rb) parent[ra] = rb;
  };

  const triangles = index ? index.count / 3 : count / 3;
  for (let t = 0; t < triangles; t++) {
    const a = index ? index.getX(t * 3) : t * 3;
    const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    union(a, b);
    union(b, c);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(representative[i]!);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()];
}

/**
 * Install the displacement.
 *
 * The material is CLONED rather than edited in place: glTF materials are shared
 * across every entity using a model, so editing one would make every character
 * on screen sway with whichever of them moved last.
 */
function applySwayNode(mesh: THREE.Mesh, swayUniform: ReturnType<typeof uniform>): void {
  const weight = attribute(CLOTH_ATTR, "float") as unknown as N;
  // Everything directional is decided on the CPU, so the shader stays one
  // multiply and has no axis convention to get wrong.
  const offset = mul(swayUniform as unknown as N, weight);

  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const cloned = list.map((source) => {
    const node = asNodeMaterial(source as THREE.Material).clone() as THREE.NodeMaterial;
    node.positionNode = add(positionLocal, offset);
    return node;
  });
  mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!;
}
