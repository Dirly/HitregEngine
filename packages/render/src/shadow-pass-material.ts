import * as THREE from "three/webgpu";

/**
 * Stop three's shared shadow-pass material from invalidating every shadow
 * caster's render object on every frame.
 *
 * In a shadow pass the renderer draws every caster with ONE override
 * material per light (`getShadowMaterial`), and before each draw copies the
 * caster's own `alphaTest` onto it so leaf cards cut holes in their shadows
 * (`Renderer._renderObjectDirect`). `Material`'s `alphaTest` setter bumps
 * `version` whenever the value crosses zero — and the render-object cache
 * compares `renderObject.version` against THAT material's version. A caster
 * list that mixes alpha-tested foliage with opaque rocks, trunks and
 * characters therefore flips the shared material's version several times
 * per pass, and every shadow render object that sees a new version recomputes
 * its full cache key (`customProgramCacheKey` + a walk over every material
 * property) before concluding nothing changed. Measured on the voxel demo:
 * `getMaterialCacheKey` + `customProgramCacheKey` were 11% of main-thread
 * self time at rest, and hiding a single opaque skinned caster that happened
 * to sit between two alpha-tested groups in the sorted list saved 6 ms a
 * frame — a symptom that pointed nowhere near the cause.
 *
 * The bump is redundant for shadow-pass materials: each shadow render
 * object's cache key already encodes its own caster's alphaTest class
 * (on/off), so an object's compiled variant never changes underneath it. So
 * on those materials only, store the value without touching `version`. The
 * one thing this loses is a LIVE change to a caster material's alphaTest
 * across zero (an editor edit) re-keying its shadow variant, which
 * {@link bumpShadowPassMaterials} restores on demand — `applyMaterialCommon`
 * calls it when an existing material's cutout class flips.
 *
 * Installed once, process-wide, by the EngineRenderer constructor.
 */
let patched = false;
const shadowPassMaterials = new Set<THREE.Material>();

export function patchShadowPassAlphaTest(): void {
  if (patched) return;
  patched = true;
  const proto = THREE.Material.prototype as unknown as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(proto, "alphaTest");
  if (!desc?.get || !desc.set) return; // a three whose Material has no accessor here — nothing to fix
  const set = desc.set as (this: unknown, value: number) => void;
  Object.defineProperty(proto, "alphaTest", {
    configurable: true,
    enumerable: desc.enumerable ?? false,
    get: desc.get,
    set(this: THREE.Material & { isShadowPassMaterial?: boolean; _alphaTest: number }, value: number) {
      if (this.isShadowPassMaterial === true) {
        shadowPassMaterials.add(this);
        this._alphaTest = value;
        return;
      }
      set.call(this, value);
    },
  });
}

/**
 * Force every shadow render object to re-check its cache key on the next
 * frame — call after changing a live material's `alphaTest` across zero (or
 * its `alphaMap`), so its shadow silhouette picks up the new variant. Cheap
 * enough for an editor edit; never call it per frame (see
 * {@link patchShadowPassAlphaTest} for what that costs).
 */
export function bumpShadowPassMaterials(): void {
  // `needsUpdate` is the one setter that still bumps `version` on these
  for (const material of shadowPassMaterials) material.needsUpdate = true;
}
