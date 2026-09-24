import * as THREE from "three/webgpu";
import {
  applyModelEmissive,
  applyModelMap,
  applyModelPartMask,
  modelPartIndex,
  partMaskFromNames,
  partSize,
  resolvePartAnchor,
  type MovingInstanceSystem,
  type PartAnchor,
} from "@hitreg/render";
import type { ModelLook } from "@hitreg/scripting";
import type { ItemEffect } from "@hitreg/core";

/**
 * The host half of `ctx.setModelLook` — the runtime look of an ubermesh model
 * (a held sword, a worn helm): its parts, its theme, its glow, and the
 * standing effects it carries. Shared by the editor host (main.ts) and the
 * published player (play.ts).
 *
 * A `mesh.moving` model takes parts/theme/glow as per-instance values in its
 * batch (one draw for every holder). Anything else falls back to editing its
 * own copy of the model. Effects are the same either way: each is a `vfx` asset
 * played by the host's AmbientVfx at a point ON the item, an anchor object
 * parented under the entity so it follows every swing, and batched by look
 * with every other effect in the scene.
 *
 * A script usually asks before the model exists (it loads async, and a scene
 * rebuild throws it away again), so the latest look per entity is kept,
 * re-applied from `modelLoaded`, and effects that could not be placed yet
 * are retried from `update`.
 */
export interface ModelLooks {
  set(entityId: string, look: ModelLook): void;
  /** Call from the build's onModelLoaded: re-applies a kept look to the fresh model. */
  modelLoaded(entityId: string, root: THREE.Object3D): void;
  /** Once per frame: place effects whose model has loaded, re-place after a rebuild. */
  update(): void;
}

/** What AmbientVfx needs (the `vfx` component's data) — structural, so no render import. */
interface EffectHost {
  register(
    id: string,
    group: THREE.Object3D,
    data: {
      effect: string;
      material?: string | undefined;
      playing: boolean;
      cullDistance: number;
      orient?: "yaw" | "full";
      shapeSize?: [number, number, number];
    },
  ): void;
  unregister(id: string): void;
}

interface CarriedEffects {
  effects: readonly ItemEffect[];
  /** The anchor objects placed, one per effect; empty until placed. */
  anchors: THREE.Object3D[];
}

export function createModelLooks(opts: {
  objectOf: (entityId: string) => THREE.Object3D | undefined;
  textureUrl: (assetId: string) => string | undefined;
  /** A `mesh.moving` instance takes its look as per-instance attributes instead (one draw for all). */
  moving?: MovingInstanceSystem;
  /** Plays item effects; absent = effects are ignored (headless). */
  effects?: () => EffectHost | null | undefined;
}): ModelLooks {
  const looks = new Map<string, ModelLook>();
  const carried = new Map<string, CarriedEffects>();
  const textures = new Map<string, Promise<THREE.Texture | null>>();
  const loader = new THREE.TextureLoader();
  const warned = new Set<string>();

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message);
  };

  const texture = (assetId: string): Promise<THREE.Texture | null> => {
    let pending = textures.get(assetId);
    if (!pending) {
      const url = opts.textureUrl(assetId);
      pending = url
        ? loader.loadAsync(url).then(
            (tex) => {
              // a theme sheet is wrapped with the model's glTF UVs (V from the
              // top), so it loads the glTF way, not three's flipped default
              tex.flipY = false;
              tex.colorSpace = THREE.SRGBColorSpace;
              tex.needsUpdate = true;
              return tex;
            },
            (error) => {
              console.warn(`[model-look] texture "${assetId}" failed to load`, error);
              return null;
            },
          )
        : Promise.resolve(null);
      if (!url) warnOnce(`tex:${assetId}`, `[model-look] no texture asset "${assetId}"`);
      textures.set(assetId, pending);
    }
    return pending;
  };

  const rootOf = (entityId: string): THREE.Object3D | undefined =>
    opts.objectOf(entityId)?.children.find((child) => child.userData["modelRoot"] === true);

  // -- the plain (non-batched) model --------------------------------------------

  const apply = (entityId: string, root: THREE.Object3D, look: ModelLook): void => {
    let mask = look.partMask;
    if (look.parts) {
      const index = modelPartIndex(root);
      if (!index) {
        warnOnce(`idx:${entityId}`, `[model-look] ${entityId}: the model has no part table — re-export it with unwrap-weapon`);
      } else {
        const resolved = partMaskFromNames(index, look.parts);
        if (resolved.missing.length > 0) {
          warnOnce(`miss:${entityId}:${resolved.missing.join()}`, `[model-look] ${entityId}: no part(s) ${resolved.missing.join(", ")} in the model`);
        }
        mask = resolved.mask;
      }
    }
    if (mask !== undefined) {
      root.userData["lookMask"] = mask;
      if (applyModelPartMask(root, mask) === 0) {
        warnOnce(`uber:${entityId}`, `[model-look] ${entityId}: the model carries no part index (uv1) — not an ubermesh`);
      }
    }
    if (look.glow !== undefined) applyModelEmissive(root, look.glow);

    if (look.texture === undefined) return;
    // the model's own sheet, kept the first time a theme replaces it
    if (!root.userData["lookBaseMap"]) {
      let base: THREE.Texture | null = null;
      root.traverse((node) => {
        const material = (node as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!base && material && !Array.isArray(material) && material.map) base = material.map;
      });
      root.userData["lookBaseMap"] = base ?? "none";
    }
    if (look.texture === null) {
      const base = root.userData["lookBaseMap"];
      if (base instanceof THREE.Texture) applyModelMap(root, base);
      return;
    }
    const wanted = look.texture;
    void texture(wanted).then((tex) => {
      // a newer look, or a rebuild, got there first
      if (!tex || looks.get(entityId)?.texture !== wanted || rootOf(entityId) !== root) return;
      applyModelMap(root, tex);
    });
  };

  // -- effects: vfx plays anchored ON the item ----------------------------------

  const scratch = new THREE.Vector3();
  const scale = new THREE.Vector3();

  /** A point on the item in the entity group's local space, or null while the model is not loaded. */
  const anchorLocal = (entityId: string, group: THREE.Object3D, anchor: PartAnchor): THREE.Vector3 | null => {
    if (opts.moving?.has(entityId)) return opts.moving.anchorOf(entityId, anchor);
    const root = rootOf(entityId);
    if (!root) return null;
    let mesh: THREE.Mesh | undefined;
    root.traverse((node) => {
      if (!mesh && (node as THREE.Mesh).isMesh) mesh = node as THREE.Mesh;
    });
    if (!mesh) return null;
    const mask = typeof root.userData["lookMask"] === "number" ? (root.userData["lookMask"] as number) : 0xffffff;
    const point = resolvePartAnchor(mesh.geometry, modelPartIndex(root), anchor, mask, scratch);
    if (!point) return null;
    group.updateWorldMatrix(true, true);
    return group.worldToLocal(point.applyMatrix4(mesh.matrixWorld)).clone();
  };

  /** A part's box size in METRES (world scale applied), for `fit`; null while not loaded. */
  const sizeMetres = (entityId: string, group: THREE.Object3D, part: string | undefined): THREE.Vector3 | null => {
    group.updateWorldMatrix(true, false);
    group.getWorldScale(scale);
    if (opts.moving?.has(entityId)) return opts.moving.sizeOf(entityId, part)?.multiply(scale) ?? null;
    const root = rootOf(entityId);
    let mesh: THREE.Mesh | undefined;
    root?.traverse((node) => {
      if (!mesh && (node as THREE.Mesh).isMesh) mesh = node as THREE.Mesh;
    });
    if (!root || !mesh) return null;
    const mask = typeof root.userData["lookMask"] === "number" ? (root.userData["lookMask"] as number) : 0xffffff;
    mesh.updateWorldMatrix(true, false);
    return partSize(mesh.geometry, modelPartIndex(root), part, mask)?.multiply(new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld)) ?? null;
  };

  const dropEffects = (entityId: string): void => {
    const current = carried.get(entityId);
    if (!current) return;
    const host = opts.effects?.();
    current.anchors.forEach((anchor, i) => {
      host?.unregister(`${entityId}#fx${i}`);
      anchor.removeFromParent();
    });
    current.anchors = [];
  };

  /** Place every effect of an entity, or none (retried next frame if the model is not ready). */
  const placeEffects = (entityId: string): void => {
    const current = carried.get(entityId);
    const host = opts.effects?.();
    const group = opts.objectOf(entityId);
    if (!current || !host || !group || current.effects.length === 0) return;
    const points: THREE.Vector3[] = [];
    const sizes: Array<[number, number, number] | undefined> = [];
    for (const effect of current.effects) {
      if (effect.fit !== false) {
        const size = sizeMetres(entityId, group, effect.anchor.part);
        if (!size) return;
        const k = effect.fit === true ? [1, 1, 1] : effect.fit;
        // emitter volumes are HALF-extents
        sizes.push([(size.x / 2) * k[0]!, (size.y / 2) * k[1]!, (size.z / 2) * k[2]!]);
      } else {
        sizes.push(undefined);
      }
      const point = anchorLocal(entityId, group, effect.anchor);
      if (!point) {
        if (opts.moving?.has(entityId) || rootOf(entityId)) {
          // loaded, and still nothing: the anchor names a part the model lacks
          warnOnce(`anchor:${entityId}:${effect.anchor.part}`, `[model-look] ${entityId}: effect "${effect.vfx}" anchor part "${effect.anchor.part}" is not on the model`);
        }
        return;
      }
      points.push(point);
    }
    // the offset is METRES along the item's axes; the group may be scaled
    group.getWorldScale(scale);
    current.effects.forEach((effect, i) => {
      const anchor = new THREE.Object3D();
      anchor.name = `item-fx:${effect.vfx}`;
      anchor.position
        .copy(points[i]!)
        .add(scratch.set(effect.anchor.offset[0] / scale.x, effect.anchor.offset[1] / scale.y, effect.anchor.offset[2] / scale.z));
      group.add(anchor);
      current.anchors.push(anchor);
      host.register(`${entityId}#fx${i}`, anchor, {
        effect: effect.vfx,
        material: effect.material,
        playing: true,
        cullDistance: effect.cullDistance,
        orient: effect.orient === "item" ? "full" : "yaw",
        ...(sizes[i] ? { shapeSize: sizes[i] } : {}),
      });
    });
  };

  const setEffects = (entityId: string, effects: readonly ItemEffect[]): void => {
    dropEffects(entityId);
    if (effects.length === 0) {
      carried.delete(entityId);
      return;
    }
    carried.set(entityId, { effects, anchors: [] });
    placeEffects(entityId);
  };

  return {
    set(entityId, look) {
      if (look.effects !== undefined) {
        const current = carried.get(entityId);
        // a re-sent identical look (a rebuild restarting the script) keeps its plays
        if (!current || JSON.stringify(current.effects) !== JSON.stringify(look.effects)) setEffects(entityId, look.effects);
      }
      if (opts.moving?.setLook(entityId, look)) {
        // re-anchor on a new part set: a part-less anchor spans what is shown
        if (look.parts || look.partMask !== undefined) {
          const current = carried.get(entityId);
          if (current && current.anchors.length > 0) {
            dropEffects(entityId);
            placeEffects(entityId);
          }
        }
        return;
      }
      looks.set(entityId, look);
      const root = rootOf(entityId);
      if (root) apply(entityId, root, look);
    },
    modelLoaded(entityId, root) {
      const look = looks.get(entityId);
      if (look) apply(entityId, root, look);
      if (carried.has(entityId)) {
        dropEffects(entityId);
        placeEffects(entityId);
      }
    },
    update() {
      for (const [entityId, current] of carried) {
        const group = opts.objectOf(entityId);
        // a rebuild replaced the entity's group: the anchors went with the old one
        if (current.anchors.length > 0 && current.anchors[0]!.parent !== group) dropEffects(entityId);
        if (current.anchors.length === 0) placeEffects(entityId);
      }
    },
  };
}
