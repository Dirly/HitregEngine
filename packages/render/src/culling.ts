import * as THREE from "three/webgpu";
import { HorizonCuller, HorizonOccluderMap, OCCLUDED_LAYER, type HorizonOptions } from "./horizon.js";
import type { SceneDoc } from "@hitreg/core";
import type { InstancedPropPool } from "./prop-pool.js";
import type { StaticBatchHandle } from "./static-batch.js";

/**
 * Culling units: things that are shown or hidden WHOLE, by three tests that
 * frustum culling cannot make.
 *
 * - **Behind terrain** (`occlusion`): the horizon test in horizon.ts. The unit
 *   moves to OCCLUDED_LAYER, which the main camera does not see and shadow
 *   cameras do, so hiding it never takes its shadow off a visible slope.
 * - **Too small on screen** (`minScreenPx`): its bounds would stand fewer
 *   pixels tall than that. Gone from every pass.
 * - **An interior seen from outside** (`interior`): drawn only while the
 *   camera is within `reveal` metres of it. Gone from every pass.
 *
 * A unit is a list of object subtrees (a streamed cell's group, a POI's
 * entity root plus its slice of the cell's static batch) and optionally an
 * owner in the world prop pool, whose instances it hides with it. Units nest:
 * a POI unit's parent is its cell's unit, and a hidden cell hides its POIs.
 *
 * Hiding is by LAYER MASK on each renderable, never by `visible`: `visible`
 * already belongs to the `visibility` component, static batching and scripts,
 * and a second writer would un-hide what one of them hid.
 */

export interface CullUnitOptions {
  /** For diagnostics. */
  name: string;
  /** Subtrees whose renderables the unit hides. Nested units' renderables are theirs, not this one's. */
  objects: readonly THREE.Object3D[];
  /** Horizon test. Default true. */
  occlusion?: boolean;
  /** Hide below this many pixels tall. 0/absent = never by size. */
  minScreenPx?: number;
  /** Drawn only while the camera is within `reveal` metres of the bounds. */
  interior?: boolean;
  reveal?: number;
  /** Instances in the prop pool that belong to the unit: all of `owner`'s, or only those of `ids`. */
  pool?: { pool: InstancedPropPool; owner: object; ids: ReadonlySet<string> | null };
  /** Enclosing unit — hidden when it is. Register the parent first. */
  parent?: CullUnit;
}

const GONE = 2;
const OCCLUDED = 1;
const SHOWN = 0;

export class CullUnit {
  /** World bounds of the renderables (static; computed at registration). */
  readonly box = new THREE.Box3();
  /** `box` plus the unit's pool instances, refreshed when the pool changes. */
  readonly testBox = new THREE.Box3();
  readonly renderables: THREE.Object3D[] = [];
  /** Each renderable's layer mask before culling touched it. */
  readonly masks: number[] = [];
  readonly children = new Set<CullUnit>();
  /** Own verdicts, with hysteresis. */
  occluded = false;
  small = false;
  outside = false;
  /** What is applied now (SHOWN/OCCLUDED/GONE), after the parent's. */
  applied = SHOWN;
  poolHidden = false;
  poolVersion = -1;
  registered = true;

  constructor(readonly options: CullUnitOptions) {}
}

export interface CullingStats {
  units: number;
  occluded: number;
  small: number;
  interior: number;
  /** Renderables currently hidden, of those units manage. */
  hiddenRenderables: number;
  renderables: number;
  /** Horizon samples evaluated in the last update — the test's cost. */
  horizonSamples: number;
  ms: number;
}

/** Slope margin a unit must clear the horizon by to BECOME hidden (it stays hidden down to 0). */
const OCCLUDE_MARGIN = 0.004;
const SIZE_HYSTERESIS = 1.15;
/** Units re-walked for late-loaded meshes per frame (see `rescan`). */
const RESCANS_PER_FRAME = 2;
const REVEAL_HYSTERESIS = 2;

const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const eye = new THREE.Vector3();
const centre = new THREE.Vector3();
const sphere = new THREE.Sphere();
const poolBox = new THREE.Box3();

function isRenderable(node: THREE.Object3D): boolean {
  const n = node as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return !!(n.isMesh || n.isLine || n.isPoints || n.isSprite);
}

export class CullingSystem {
  readonly occluders: HorizonOccluderMap;
  private readonly horizon: HorizonCuller;
  private readonly units = new Set<CullUnit>();
  /** Which unit owns a renderable (the innermost). */
  private readonly owner = new Map<THREE.Object3D, CullUnit>();
  enabled = true;
  /**
   * Past this distance an occluded unit's pool instances are dropped too. The
   * pool draws every pass from one buffer, so dropping an instance takes its
   * shadow as well — only safe beyond the shadow cascades.
   */
  shadowDistance = 120;
  private last: CullingStats = {
    units: 0,
    occluded: 0,
    small: 0,
    interior: 0,
    hiddenRenderables: 0,
    renderables: 0,
    horizonSamples: 0,
    ms: 0,
  };

  constructor(options: HorizonOptions & { square?: number } = {}) {
    this.occluders = new HorizonOccluderMap(options.square ?? 16);
    this.horizon = new HorizonCuller(this.occluders, options);
  }

  register(options: CullUnitOptions): CullUnit {
    const unit = new CullUnit(options);
    this.claim(unit, true);
    if (options.parent) options.parent.children.add(unit);
    this.units.add(unit);
    return unit;
  }

  /**
   * Take ownership of the renderables under a unit's objects. At
   * registration a nested unit takes what it covers from its parent (with
   * the mask they had before the parent touched them); a rescan adopts only
   * what nobody owns yet, skipping nested units' subtrees.
   */
  private claim(unit: CullUnit, steal: boolean): void {
    const skip = new Set<THREE.Object3D>();
    if (!steal) for (const child of unit.children) for (const object of child.options.objects) skip.add(object);
    let grew = false;
    for (const root of unit.options.objects) {
      root.updateWorldMatrix(true, true);
      const visit = (node: THREE.Object3D): void => {
        if (skip.has(node)) return;
        if (isRenderable(node)) {
          const previous = this.owner.get(node);
          if (previous !== unit && (steal || !previous)) {
            if (previous) {
              const at = previous.renderables.indexOf(node);
              if (at >= 0) {
                node.layers.mask = previous.masks[at]!;
                previous.renderables.splice(at, 1);
                previous.masks.splice(at, 1);
              }
            }
            this.owner.set(node, unit);
            unit.renderables.push(node);
            unit.masks.push(node.layers.mask);
            unit.box.expandByObject(node, false);
            grew = true;
            // hidden already? the newcomer follows the unit's state now
            if (unit.applied !== SHOWN) node.layers.mask = this.maskFor(unit.applied, node.layers.mask);
          }
        }
        for (const child of node.children) visit(child);
      };
      visit(root);
    }
    if (grew) unit.poolVersion = -2; // re-derive testBox from the grown box
  }

  private maskFor(state: number, original: number): number {
    return state === SHOWN ? original : state === OCCLUDED ? (original & ~1) | (1 << OCCLUDED_LAYER) : 0;
  }

  /** Hand everything back (layers restored, pool instances revealed); nested units go with it. */
  unregister(unit: CullUnit): void {
    if (!unit.registered) return;
    for (const child of unit.children) this.unregister(child);
    unit.registered = false;
    this.units.delete(unit);
    unit.options.parent?.children.delete(unit);
    for (let i = 0; i < unit.renderables.length; i++) {
      const node = unit.renderables[i]!;
      node.layers.mask = unit.masks[i]!;
      if (this.owner.get(node) === unit) this.owner.delete(node);
    }
    this.setPoolHidden(unit, false);
  }

  stats(): CullingStats {
    return this.last;
  }

  /**
   * Judge every unit against `camera`. `viewportHeight` is the height of the
   * image actually rendered, in pixels (after pixelation), for `minScreenPx`.
   */
  update(camera: THREE.Camera, viewportHeight: number): void {
    const started = performance.now();
    if (!this.enabled) {
      for (const unit of this.units) this.apply(unit, SHOWN, false);
      this.last = { ...this.last, occluded: 0, small: 0, interior: 0, hiddenRenderables: 0, ms: 0 };
      return;
    }
    camera.updateMatrixWorld();
    camera.getWorldPosition(eye);
    this.horizon.setEye(eye.x, eye.y, eye.z);
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView, camera.coordinateSystem);
    const perspective = camera as THREE.PerspectiveCamera;
    const tanHalf = perspective.isPerspectiveCamera ? Math.tan((perspective.fov * Math.PI) / 360) / perspective.zoom : 0;

    const stats: CullingStats = {
      units: this.units.size,
      occluded: 0,
      small: 0,
      interior: 0,
      hiddenRenderables: 0,
      renderables: 0,
      horizonSamples: 0,
      ms: 0,
    };
    // Models load asynchronously: a cell or POI can gain meshes after it
    // registered (the first use of a glTF). Adopt them a couple of units a
    // frame — until then they are simply never hidden, which is safe.
    this.rescan();
    // parents before children: a parent is always registered first, and a
    // Set iterates in insertion order
    for (const unit of this.units) {
      const o = unit.options;
      if (o.pool && o.pool.pool.ownerVersion(o.pool.owner) !== unit.poolVersion) {
        unit.poolVersion = o.pool.pool.ownerVersion(o.pool.owner);
        unit.testBox.copy(unit.box);
        if (o.pool.pool.boundsOf(o.pool.owner, o.pool.ids, poolBox)) unit.testBox.union(poolBox);
      } else if (unit.poolVersion < 0) {
        unit.poolVersion = 0;
        unit.testBox.copy(unit.box);
      }
      const box = unit.testBox;
      if (box.isEmpty()) continue;
      box.getBoundingSphere(sphere);

      if (o.interior) {
        const d = box.distanceToPoint(eye);
        const reveal = o.reveal ?? 12;
        unit.outside = unit.outside ? d > reveal : d > reveal + REVEAL_HYSTERESIS;
      }
      if (o.minScreenPx && o.minScreenPx > 0 && tanHalf > 0) {
        const d = Math.max(1e-3, sphere.center.distanceTo(eye) - sphere.radius);
        const px = (sphere.radius * viewportHeight) / (d * tanHalf);
        unit.small = unit.small ? px < o.minScreenPx * SIZE_HYSTERESIS : px < o.minScreenPx;
      }
      // the horizon only for what could be on screen: off-screen, frustum
      // culling already skips it, and its old verdict is re-judged the frame
      // it comes back into view, before anything draws it
      if (o.occlusion !== false && !unit.small && !unit.outside && frustum.intersectsBox(box)) {
        unit.occluded = this.horizon.isBoxOccluded(box, unit.occluded ? 0 : OCCLUDE_MARGIN);
      }

      const parent = o.parent?.applied ?? SHOWN;
      const own = unit.small || unit.outside ? GONE : unit.occluded ? OCCLUDED : SHOWN;
      const state = Math.max(parent, own);
      let poolHide = state === GONE;
      if (state === OCCLUDED) {
        centre.copy(eye).clamp(box.min, box.max);
        poolHide = centre.distanceTo(eye) > this.shadowDistance;
      }
      this.apply(unit, state, poolHide);

      if (unit.small) stats.small++;
      else if (unit.outside) stats.interior++;
      else if (unit.occluded) stats.occluded++;
      stats.renderables += unit.renderables.length;
      if (state !== SHOWN) stats.hiddenRenderables += unit.renderables.length;
    }
    stats.horizonSamples = this.horizon.samples;
    stats.ms = performance.now() - started;
    this.last = stats;
  }

  private rescanQueue: CullUnit[] = [];

  private rescan(): void {
    for (let n = 0; n < RESCANS_PER_FRAME; n++) {
      if (this.rescanQueue.length === 0) {
        if (this.units.size === 0) return;
        this.rescanQueue = [...this.units];
      }
      const unit = this.rescanQueue.pop()!;
      if (unit.registered) this.claim(unit, false);
    }
  }

  private apply(unit: CullUnit, state: number, poolHide: boolean): void {
    if (unit.applied !== state) {
      unit.applied = state;
      for (let i = 0; i < unit.renderables.length; i++) unit.renderables[i]!.layers.mask = this.maskFor(state, unit.masks[i]!);
    }
    this.setPoolHidden(unit, poolHide);
  }

  private setPoolHidden(unit: CullUnit, hidden: boolean): void {
    const pool = unit.options.pool;
    if (!pool || unit.poolHidden === hidden) return;
    unit.poolHidden = hidden;
    pool.pool.setHidden(pool.owner, pool.ids, hidden);
  }

  /** Drop every unit and forget the terrain (a scene teardown). */
  clear(): void {
    for (const unit of [...this.units]) if (!unit.options.parent) this.unregister(unit);
    this.units.clear();
    this.owner.clear();
    this.occluders.clear();
  }
}

// -- units from a scene document ---------------------------------------------

/** Settings of one `culling` root, defaults applied. */
export interface CullRootSettings {
  occlusion: boolean;
  minScreenPx: number;
  interior: boolean;
  reveal: number;
}

export interface CullRoot {
  id: string;
  settings: CullRootSettings;
  /** Every entity in the root's subtree that no nested root claims. */
  members: Set<string>;
  /** The nearest enclosing root, or null. */
  parent: string | null;
}

const POI_DEFAULTS: CullRootSettings = { occlusion: true, minScreenPx: 0, interior: false, reveal: 12 };

/** A scene's `cullingProfile` (the first one found; one per scene): interior scenes' own distances. */
export interface CullingProfile {
  interiorReveal?: number;
  maxMinScreenPx?: number;
  occlusion?: boolean;
}

/** The document's `cullingProfile`, or null. */
export function cullingProfileOf(doc: SceneDoc): CullingProfile | null {
  for (const entity of Object.values(doc.entities)) {
    const profile = entity.components["cullingProfile"] as CullingProfile | undefined;
    if (profile) return profile;
  }
  return null;
}

/** One root's settings under the scene's profile: reveal raised to its floor, size culling capped, occlusion off. */
export function applyCullingProfile(settings: CullRootSettings, profile: CullingProfile | null): CullRootSettings {
  if (!profile) return settings;
  const out = { ...settings };
  if (out.interior && profile.interiorReveal !== undefined) out.reveal = Math.max(out.reveal, profile.interiorReveal);
  if (profile.maxMinScreenPx !== undefined) out.minScreenPx = Math.min(out.minScreenPx, profile.maxMinScreenPx);
  if (profile.occlusion === false) out.occlusion = false;
  return out;
}

/**
 * The culling roots of a document, parents before children: every entity
 * with a `culling` component, and every entity tagged `poi` (a generated
 * POI's root, whose prefab may not declare one). A `cullingProfile` in the
 * document adjusts every root's settings (interior scenes: docs/culling.md).
 */
export function cullRootsOf(doc: SceneDoc): CullRoot[] {
  const profile = cullingProfileOf(doc);
  const children = new Map<string | null, string[]>();
  for (const [id, entity] of Object.entries(doc.entities)) {
    const list = children.get(entity.parent);
    if (list) list.push(id);
    else children.set(entity.parent, [id]);
  }
  const roots: CullRoot[] = [];
  const visit = (id: string, enclosing: CullRoot | null): void => {
    const entity = doc.entities[id]!;
    const data = entity.components["culling"] as Partial<CullRootSettings> | undefined;
    let here = enclosing;
    if (data || entity.tags?.includes("poi")) {
      here = {
        id,
        settings: applyCullingProfile({ ...POI_DEFAULTS, ...(data ?? {}) }, profile),
        members: new Set(),
        parent: enclosing?.id ?? null,
      };
      roots.push(here);
    }
    here?.members.add(id);
    for (const child of children.get(id) ?? []) visit(child, here);
  };
  for (const id of children.get(null) ?? []) visit(id, null);
  return roots;
}

/** entity id -> the id of the innermost root it belongs to. */
export function cullRootIndex(roots: readonly CullRoot[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) for (const id of root.members) index.set(id, root.id);
  return index;
}

/**
 * Register a unit per root. `objects` is the build's entity -> Object3D map;
 * `batch` the static batch built with `groupOf` = the root index, so each
 * root's merged meshes are hidden with it.
 */
export function registerCullRoots(
  system: CullingSystem,
  roots: readonly CullRoot[],
  objects: ReadonlyMap<string, THREE.Object3D>,
  batch: StaticBatchHandle | null,
  context: { parent?: CullUnit; pool?: { pool: InstancedPropPool; owner: object } } = {},
): CullUnit[] {
  const units = new Map<string, CullUnit>();
  for (const root of roots) {
    const object = objects.get(root.id);
    if (!object) continue;
    const merged = batch?.groups.get(root.id);
    const parent = root.parent !== null ? units.get(root.parent) : context.parent;
    const unit = system.register({
      name: root.id,
      objects: merged ? [object, merged] : [object],
      occlusion: root.settings.occlusion,
      minScreenPx: root.settings.minScreenPx,
      interior: root.settings.interior,
      reveal: root.settings.reveal,
      ...(context.pool ? { pool: { ...context.pool, ids: root.members } } : {}),
      ...(parent ? { parent } : {}),
    });
    units.set(root.id, unit);
  }
  return [...units.values()];
}
