import type * as THREE from "three/webgpu";
import { FaceShots } from "@hitreg/render";
import type { ModelLooks } from "./model-looks.js";

/**
 * The host half of `ctx.faceShot` (unit-frame face pictures), shared by the
 * editor host (main.ts) and the published player (play.ts).
 *
 * An entity's LOOK KEY is what shows on its head: every skinned body model
 * under it (its mesh asset, material and runtime look — skin, tint, parts)
 * plus every character piece seated on it (head, hair, helm, pads: model and
 * look). Held weapons and boots are not in it, so swapping them never
 * re-shoots a face; a helm going on does, once. Keys are re-read at most
 * twice a second per entity; between a new key and its picture the entity
 * keeps the last picture it had.
 */
export interface FaceShotHost {
  faceShot(entityId: string): string | null;
  dispose(): void;
}

export function createFaceShotHost(opts: {
  renderer: THREE.WebGPURenderer;
  objectOf(entityId: string): THREE.Object3D | undefined;
  /** An entity's authored mesh source + material (the expanded scene doc), for the key. */
  meshOf(entityId: string): { assetId?: string; material?: string } | undefined;
  modelLooks: ModelLooks;
  clipsOf(entityId: string): THREE.AnimationClip[];
}): FaceShotHost {
  const shots = new FaceShots(opts.renderer);
  const known = new Map<string, { key: string; at: number; last: string | null }>();

  const lookKeyOf = (object: THREE.Object3D): { key: string; clipsFrom: string } => {
    const parts: string[] = [];
    let clipsFrom = "";
    object.traverse((n) => {
      const ud = n.userData as Record<string, unknown>;
      const piece = ud["characterPiece"] as { entityId: string; model: string } | undefined;
      if (piece) {
        parts.push(`piece:${piece.model}|${opts.modelLooks.lookKey(piece.entityId)}`);
        return;
      }
      if (ud["modelRoot"] !== true || typeof ud["entityId"] !== "string") return;
      // a body is skinned; a held weapon is not, and never changes a face
      let skinned = false;
      n.traverse((m) => {
        if ((m as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
      });
      if (!skinned) return;
      const id = ud["entityId"] as string;
      const mesh = opts.meshOf(id);
      parts.push(`body:${mesh?.assetId ?? "?"}|${mesh?.material ?? ""}|${opts.modelLooks.lookKey(id)}`);
      if (!clipsFrom && opts.clipsOf(id).length) clipsFrom = id;
    });
    return { key: parts.sort().join(";"), clipsFrom };
  };

  return {
    faceShot(entityId) {
      const object = opts.objectOf(entityId);
      if (!object) return known.get(entityId)?.last ?? null;
      const now = performance.now();
      let entry = known.get(entityId);
      if (!entry || now - entry.at > 500) {
        const { key } = lookKeyOf(object);
        entry = { key, at: now, last: entry?.last ?? null };
        known.set(entityId, entry);
      }
      if (!entry.key) return entry.last;
      const url = shots.get(entry.key, () => {
        const { clipsFrom } = lookKeyOf(object);
        const clips = opts.clipsOf(clipsFrom || entityId);
        return {
          object,
          ...(clips.length ? { clips } : {}),
          dress: (source, clone, landed) => opts.modelLooks.dressPortrait(source, clone, landed),
        };
      });
      if (url) entry.last = url;
      return entry.last;
    },
    dispose() {
      shots.dispose();
      known.clear();
    },
  };
}
