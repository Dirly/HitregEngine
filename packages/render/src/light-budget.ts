import * as THREE from "three/webgpu";

interface Entry {
  light: THREE.PointLight;
  importance: number;
  distanceSq: number;
}

function belongsToScene(object: THREE.Object3D, scene: THREE.Scene): boolean {
  let current: THREE.Object3D | null = object;
  while (current?.parent) current = current.parent;
  return current === scene;
}

function ancestorsVisible(object: THREE.Object3D): boolean {
  let current = object.parent;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Camera-relative cap for forward-rendered point lights. Three evaluates the
 * active light set in every affected material; dozens of decorative lights can
 * dominate fragment cost even when none casts a shadow.
 *
 * ## Why this hands the renderer a fixed set of SLOT lights
 *
 * The obvious implementation — sort by distance, show the nearest N, hide the
 * rest — is a performance trap severe enough to make an editor unusable, and it
 * is worth writing down because the symptom points nowhere near the cause.
 *
 * `LightsNode.customCacheKey()` in three's WebGPU backend hashes **`light.id`
 * per light**. The cache key therefore changes whenever the SET of visible
 * lights changes, even if the count is identical — and a changed key means
 * every node material affected by lights is rebuilt and its pipeline
 * recompiled, inside `renderer.render()`. Toggling `visible` as the camera
 * moves means a dungeon with more point lights than budget crosses that line on
 * almost every frame of camera movement, so the renderer recompiles
 * continuously.
 *
 * Measured on a 2000-entity dungeon with 98 point lights against a budget of 8:
 * rotating the camera in place ran at **18 ms/frame**, while MOVING it — same
 * scene, same frustum churn, only the position differing — collapsed to
 * **2296 ms/frame**. Setting the budget to 0 (a set that can never change)
 * restored 28 ms/frame. The engine's own profiler billed it all to `render`
 * with a matching pile of off-loop time, which is what shader compilation looks
 * like from the outside.
 *
 * So the authored lights are never toggled. They are hidden once and act purely
 * as DATA; a fixed pool of `maxPointLights` slot lights, created once and always
 * visible, is re-aimed at whichever authored lights currently win. The set of
 * light objects the renderer sees is then constant for the lifetime of the pool,
 * the cache key never moves, and the per-frame update writes uniforms only.
 * Unused slots stay in the set with zero intensity — costing one dead light's
 * arithmetic rather than a recompile.
 *
 * Shadow-casting point lights are deliberately EXCLUDED from the pool and left
 * alone: a shadow map belongs to a specific light, so a proxy would have to
 * re-render it anyway, and re-aiming one every frame invalidates the map it just
 * drew. They stay visible and keep their own identity, which is safe because a
 * shadow-casting point light costs six cube faces and is budgeted at authoring
 * time (single digits per scene), not culled at runtime.
 */
export class LightBudgetSystem {
  private readonly lights = new Set<THREE.PointLight>();
  private readonly cameraPosition = new THREE.Vector3();
  /** Stable proxy lights the renderer actually sees. Identity never changes. */
  private readonly slots: THREE.PointLight[] = [];
  /** Reused per-frame scratch: entry objects are overwritten, never re-created. */
  private readonly scratch: Entry[] = [];
  private readonly pruned: THREE.PointLight[] = [];
  private readonly live: Entry[] = [];
  private slotHost: THREE.Scene | null = null;
  private active = 0;

  constructor(private maxPointLights = 8) {}

  setMaxPointLights(max: number): void {
    const next = Math.max(0, Math.floor(max));
    if (next === this.maxPointLights) return;
    this.maxPointLights = next;
    // Resizing the pool is itself a cache-key change, so it is a deliberate
    // one-off (a quality setting), never a per-frame operation.
    this.disposeSlots();
  }

  register(light: THREE.Light, importance = 1): void {
    if (!(light instanceof THREE.PointLight)) return;
    light.userData["lightImportance"] = importance;
    light.userData["runtimeEnabled"] ??= true;
    this.lights.add(light);
  }

  update(scene: THREE.Scene, camera: THREE.Camera): void {
    camera.getWorldPosition(this.cameraPosition);
    // Reused across frames. This runs every frame against every registered
    // light, so allocating a fresh array plus one entry object per light is
    // ~15k objects/second on a dungeon with a hundred practicals — enough GC
    // churn to show up as periodic off-loop stalls while the camera moves,
    // which is the same symptom as the recompile bug and easy to mistake for
    // it. `pruned` exists because deleting from `this.lights` while iterating
    // it is what the old `[...this.lights]` copy was really guarding against.
    const candidates = this.scratch;
    let count = 0;
    this.pruned.length = 0;
    for (const light of this.lights) {
      if (!belongsToScene(light, scene)) {
        light.visible = false;
        this.pruned.push(light);
        continue;
      }
      const enabled = light.userData["runtimeEnabled"] !== false;
      if (!enabled || !ancestorsVisible(light)) {
        light.visible = false;
        continue;
      }
      // A shadow caster keeps its own identity and stays lit; see the class
      // comment. It is not a pool candidate and does not spend pool budget.
      if (light.castShadow) {
        light.visible = true;
        continue;
      }
      // Authored lights are data from here on: hidden once, never toggled
      // again, so they contribute nothing to the renderer's light cache key.
      light.visible = false;
      const distanceSq = light.getWorldPosition(_lightPosition).distanceToSquared(this.cameraPosition);
      const entry = (candidates[count] ??= { light, importance: 1, distanceSq: 0 });
      entry.light = light;
      entry.importance = Math.max(0.001, Number(light.userData["lightImportance"]) || 1);
      entry.distanceSq = distanceSq;
      count++;
    }
    for (const light of this.pruned) this.lights.delete(light);

    // Sort only this frame's live entries. `slice()` would hand the sort a
    // clean array but allocate one per frame, which is the very thing being
    // removed here — so a second reused array is truncated to `count` instead.
    const live = this.live;
    live.length = count;
    for (let i = 0; i < count; i++) live[i] = candidates[i]!;
    live.sort((a, b) => a.distanceSq / a.importance - b.distanceSq / b.importance);
    this.ensureSlots(scene);
    const allowed = Math.min(this.maxPointLights, live.length);
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      const source = i < allowed ? live[i]!.light : null;
      if (!source) {
        // Kept in the set (identity is the whole point) but contributing
        // nothing: no intensity, and a range that reaches no fragment.
        slot.intensity = 0;
        slot.distance = 1e-4;
        continue;
      }
      source.getWorldPosition(slot.position);
      slot.color.copy(source.color);
      slot.intensity = source.intensity;
      slot.distance = source.distance;
      slot.decay = source.decay;
    }
    this.active = allowed;
  }

  /**
   * Create the pool, once, parented directly to the rendered scene. Re-created
   * only if the scene object itself changes (a full rebuild), which is already
   * a recompile boundary.
   */
  private ensureSlots(scene: THREE.Scene): void {
    if (this.slotHost === scene && this.slots.length === this.maxPointLights) return;
    this.disposeSlots();
    for (let i = 0; i < this.maxPointLights; i++) {
      const slot = new THREE.PointLight(0xffffff, 0, 1e-4);
      slot.name = `__lightBudgetSlot${i}`;
      slot.castShadow = false;
      // never let a slot inherit a parent's transform or visibility
      slot.matrixAutoUpdate = true;
      scene.add(slot);
      this.slots.push(slot);
    }
    this.slotHost = scene;
  }

  private disposeSlots(): void {
    for (const slot of this.slots) slot.removeFromParent();
    this.slots.length = 0;
    this.slotHost = null;
  }

  /** Release the pool (scene teardown). Authored lights are left as they are. */
  dispose(): void {
    this.disposeSlots();
    this.lights.clear();
    this.active = 0;
  }

  stats(): { registered: number; active: number; budget: number } {
    return { registered: this.lights.size, active: this.active, budget: this.maxPointLights };
  }
}

const _lightPosition = new THREE.Vector3();
