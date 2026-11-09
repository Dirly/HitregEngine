import * as THREE from "three/webgpu";
import { readWorldPosition } from "./static-transforms.js";
import { hierarchyVisible } from "./cull-visibility.js";
import { worldDaylight } from "./daylight.js";
import { DEFAULT_LIGHT_GLOW, LightGlows, MAX_HALO_GLOW } from "./light-glow.js";

/** Lamp glow in the fog under full open daylight, as a share of its night strength. */
const DAY_FOG_GLOW = 0.15;
/** A light lights the haze with at most this intensity (a bonfire's light): a beacon's 90 is for the ground, not the air. */
export const FOG_LAMP_MAX_INTENSITY = 40;
import { LightPools } from "./light-pools.js";
import { FOG_LAMP_COUNT, fogLamps } from "./atmosphere.js";

/** Diagnostic switch (ambience setLightLayerEnabled "shading"): false = the budgeted slots shade nothing. */
export const lightShading = { enabled: true };
/** Share of the budget line's squared distance at which a light starts to fade (0.5 = ~70 % of its distance). */
const BUDGET_FADE_FROM = 0.5;

interface Entry {
  light: THREE.PointLight;
  importance: number;
  distanceSq: number;
}

/**
 * A light near the edge of a nearest-N list fades as it nears the first one left out, so the list changing hands is a
 * slow fade and not a lamp snapping on as you walk up (the fog glow is the nearest 4: the big glow popped at that line).
 * `rank` is a light's sort key, `line` the key of the first light past the list, or null when every light fits.
 */
export function budgetEdgeFade(rank: number, line: number | null): number {
  if (line === null || !(line > 0)) return 1;
  return 1 - THREE.MathUtils.smoothstep(rank / line, BUDGET_FADE_FROM, 1);
}

function belongsToScene(object: THREE.Object3D, scene: THREE.Scene): boolean {
  let current: THREE.Object3D | null = object;
  while (current?.parent) current = current.parent;
  return current === scene;
}

function ancestorsVisible(object: THREE.Object3D): boolean {
  // Authored light.visible is deliberately false: only its ancestors gate the pool candidate.
  return hierarchyVisible(object.parent);
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
/** `light.when`: night lights scale by darkness, day lights by daylight. */
function timeOfDayScale(light: THREE.Light): number {
  const when = light.userData["lightWhen"];
  const flicker = light.userData["lightFlicker"];
  const scale = flicker ? flickerScale(light, flicker) : 1;
  if (when === "night") return (1 - worldDaylight.value) * scale;
  if (when === "day") return worldDaylight.value * scale;
  return scale;
}

/** `light.flicker`: (rate Hz, depth) for two incommensurate sines per kind. */
const FLICKER: Record<string, [number, number, number, number]> = {
  candle: [1.7, 0.06, 4.3, 0.04],
  torch: [3.1, 0.12, 7.9, 0.08],
  brazier: [0.9, 0.16, 2.3, 0.07],
};

/** A flame's unsteadiness right now: two sines per light, phased by its id so no two lamps beat together. */
function flickerScale(light: THREE.Light, kind: string): number {
  const f = FLICKER[kind];
  if (!f) return 1;
  const t = performance.now() / 1000;
  const phase = light.id * 1.618;
  return 1 + Math.sin(t * f[0] * Math.PI * 2 + phase) * f[1] + Math.sin(t * f[2] * Math.PI * 2 + phase * 2.3) * f[3];
}

/** `light.glow` (userData `lightGlow`); unset = the default halo, 0 = none. */
function glowOf(light: THREE.Light): number {
  const glow = light.userData["lightGlow"];
  return typeof glow === "number" ? glow : DEFAULT_LIGHT_GLOW;
}

/** `light.glowReach` (userData `lightGlowReach`): metres the halo stays visible; unset = the default fade. */
function glowReachOf(light: THREE.Light): number | undefined {
  const reach = light.userData["lightGlowReach"];
  return typeof reach === "number" ? reach : undefined;
}

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
  /** Halos for every live point light, budgeted or not (`light.glow`). */
  private readonly glows = new LightGlows();
  /** Screen-space pools for the lights the budget left out. */
  private readonly pools = new LightPools();

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
    this.glows.begin();
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
        const onness = timeOfDayScale(light);
        readWorldPosition(light, _lightPosition);
        this.glows.add(light, _lightPosition, _lightPosition.distanceTo(this.cameraPosition), glowOf(light), onness, glowReachOf(light), worldDaylight.sunlit);
        continue;
      }
      // Authored lights are data from here on: hidden once, never toggled
      // again, so they contribute nothing to the renderer's light cache key.
      light.visible = false;
      // a night lantern by day (or a day light at night) takes no slot at all
      const onness = timeOfDayScale(light);
      if (onness < 0.01) continue;
      const distanceSq = readWorldPosition(light, _lightPosition).distanceToSquared(this.cameraPosition);
      this.glows.add(light, _lightPosition, Math.sqrt(distanceSq), glowOf(light), onness, glowReachOf(light), worldDaylight.sunlit);
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
    const rankOf = (entry: Entry) => entry.distanceSq / entry.importance;
    const slotLine = allowed < live.length ? rankOf(live[allowed]!) : null;
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
      readWorldPosition(source, slot.position);
      slot.color.copy(source.color);
      slot.intensity = lightShading.enabled ? source.intensity * timeOfDayScale(source) * budgetEdgeFade(rankOf(live[i]!), slotLine) : 0;
      slot.distance = source.distance;
      slot.decay = source.decay;
    }
    this.active = allowed;
    this.glows.end(scene, camera);

    // the lights past the budget: a screen-space pool each, nearest first
    this.pools.begin();
    for (let i = 0; i < live.length; i++) {
      const entry = live[i]!;
      // a light fading out of its slot hands over to its pool by the same share
      const handover = i < allowed ? 1 - budgetEdgeFade(rankOf(entry), slotLine) : 1;
      if (handover <= 0) continue;
      readWorldPosition(entry.light, _lightPosition);
      if (!this.pools.add(entry.light, _lightPosition, Math.sqrt(entry.distanceSq), timeOfDayScale(entry.light) * handover)) break;
    }
    this.pools.end(scene);

    // the nearest few glow in the fog
    const fogLine = FOG_LAMP_COUNT < live.length ? rankOf(live[FOG_LAMP_COUNT]!) : null;
    for (let i = 0; i < FOG_LAMP_COUNT; i++) {
      const entry = i < live.length ? live[i]! : null;
      const color = fogLamps.color[i]!.value;
      if (!entry) {
        color.setRGB(0, 0, 0);
        continue;
      }
      readWorldPosition(entry.light, _lightPosition);
      fogLamps.position[i]!.value.set(_lightPosition.x, _lightPosition.y, _lightPosition.z, Math.max(0.1, entry.light.distance || 10));
      // capped like the halo and mostly gone in open daylight (Red Dial 2026-10-30: 19 beacons at intensity 90 x glow 4
      // lit the noon haze over a quarter of a street frame)
      const air = DAY_FOG_GLOW + (1 - DAY_FOG_GLOW) * (1 - worldDaylight.sunlit);
      // and the intensity it lights the air with is capped at a bonfire's (FOG_LAMP_MAX_INTENSITY): a 90-unit beacon light lit
      // 6 % of a dusk frame of haze at 20-40 m (Red Dial tower-compounds) where its halo added nothing
      color.copy(entry.light.color).multiplyScalar(Math.min(entry.light.intensity, FOG_LAMP_MAX_INTENSITY) * timeOfDayScale(entry.light) * Math.min(glowOf(entry.light), MAX_HALO_GLOW) * air * budgetEdgeFade(rankOf(entry), fogLine));
    }
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
    this.glows.dispose();
    this.pools.dispose();
    for (const color of fogLamps.color) color.value.setRGB(0, 0, 0);
    this.lights.clear();
    this.active = 0;
  }

  stats(): { registered: number; active: number; budget: number; glows: number; pools: number } {
    return { registered: this.lights.size, active: this.active, budget: this.maxPointLights, glows: this.glows.stats(), pools: this.pools.stats() };
  }
}

const _lightPosition = new THREE.Vector3();
