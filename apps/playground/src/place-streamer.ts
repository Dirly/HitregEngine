/**
 * Places stream in by distance (docs/culling.md "Places stream"). Every POI, dressing group and town root of the
 * open scene used to be BUILT at load — meshes, materials, shader builds, lights, culling units — and only HIDDEN
 * when far; the build cost grew with every installed place. Now the base scene is built without them and each
 * place's subtree is built when the focus (player in play, orbit target in the editor) comes within its
 * `placeStream.distance` of its footprint, and freed past `distance + keepPadding`. `landmark` subtrees stay in the
 * base build, so far views keep the hero silhouettes (and any portal under them).
 *
 * What stays whole: the expanded scene doc (`lastExpanded`: queries, portal anchors, quests, the editor), the play
 * sim (built from the doc, statics streamed around bodies on its own) and every server. Only the client's render
 * build streams.
 *
 * The planning is pure and in core (`planPlaceStreaming`); this class owns residency, and the host (main.ts) owns
 * what a build is (buildScene + batch + culling + scripts) through `PlaceStreamerHost`.
 */
import { placeDoc, placeEdgeDistance, placeWanted, planPlaceStreaming, type PlaceSpec, type SceneDoc } from "@hitreg/core";

/** `?places=` debug switch: stream (default), all (build every place at load, as before), none (never build them). */
export type PlaceStreamMode = "stream" | "all" | "none";

export function placeStreamModeFromSearch(search: string): PlaceStreamMode {
  const value = new URLSearchParams(search).get("places");
  return value === "all" || value === "none" ? value : "stream";
}

/** A detached room owns its whole render container, including instanced batches beside its entity root. */
export function placeCullObjects<T>(doc: SceneDoc, objects: ReadonlyMap<string, T>, container: T): ReadonlyMap<string, T> {
  const roots = Object.entries(doc.entities).filter(([, entity]) => entity.parent === null);
  if (roots.length !== 1) return objects;
  const [id, entity] = roots[0]!;
  if ((entity.components["culling"] as { interior?: boolean } | undefined)?.interior !== true) return objects;
  const aliases = new Map(objects);
  aliases.set(id, container);
  return aliases;
}

/** Scene-anchored instance batches must share their single root's effective authored visibility. */
export function placeContainerVisible(doc: SceneDoc): boolean {
  const roots = Object.values(doc.entities).filter((entity) => entity.parent === null);
  return roots.length !== 1 || (roots[0]!.components["visibility"] as { visible?: boolean } | undefined)?.visible !== false;
}

/** Only a single detached interior owns the entire place container's visibility. */
export function placeInteriorRoot(doc: SceneDoc): string | null {
  const roots = Object.entries(doc.entities).filter(([, entity]) => entity.parent === null);
  if (roots.length !== 1) return null;
  const [id, entity] = roots[0]!;
  return (entity.components["culling"] as { interior?: boolean } | undefined)?.interior === true ? id : null;
}

export interface PlaceStreamerHost<B> {
  /** Build a place from its doc (ids unchanged) into the current scene; returns the host's handle. */
  build(placeId: string, doc: SceneDoc): B;
  /** Free a built place: out of the scene, out of every registry. */
  free(placeId: string, built: B): void;
  now?(): number;
}

export interface PlaceStreamStats {
  places: number;
  loaded: number;
  /** Streamed entities currently built. */
  entities: number;
  loads: number;
  unloads: number;
  /** ms of the last place build (sync). */
  lastBuildMs: number;
}

/** Wall-clock budget of place builds per frame while moving (always at least one). */
export const PLACE_BUILD_BUDGET_MS = 12;
/** The focus must move this far before residency is re-judged. */
const REJUDGE_STEP = 4;

export class PlaceStreamer<B> {
  private places: PlaceSpec[] = [];
  private byId = new Map<string, PlaceSpec>();
  private placeOfId = new Map<string, string>();
  private doc: SceneDoc | null = null;
  private base: SceneDoc | null = null;
  private readonly loaded = new Map<string, B>();
  private readonly pins = new Set<string>();
  private focus: [number, number] | null = null;
  private judgedAt: [number, number] | null = null;
  private attached = false;
  private counters = { loads: 0, unloads: 0, lastBuildMs: 0 };

  constructor(private readonly host: PlaceStreamerHost<B>, public mode: PlaceStreamMode = "stream") {}

  /**
   * Plan a fresh expanded doc. Frees every built place (their objects belong to the scene being replaced) and
   * returns the doc the host builds as its base scene. Call `attach()` once that base is built.
   */
  plan(expanded: SceneDoc): SceneDoc {
    this.detachAll();
    this.attached = false;
    if (this.mode === "all") {
      this.setPlan(expanded, expanded, [], new Map());
      return expanded;
    }
    const plan = planPlaceStreaming(expanded);
    this.setPlan(plan.render, plan.base, plan.places, plan.placeOf);
    return plan.base;
  }

  /**
   * Re-plan after an in-place edit (reconcile) without rebuilding: built places keep their objects; specs (footprint,
   * membership) follow the new doc. Returns false when membership changed (the caller must rebuild).
   */
  replan(expanded: SceneDoc): boolean {
    if (this.mode === "all") {
      this.doc = this.base = expanded;
      return true;
    }
    const plan = planPlaceStreaming(expanded);
    if (plan.placeOf.size !== this.placeOfId.size) return false;
    for (const [id, place] of plan.placeOf) if (this.placeOfId.get(id) !== place) return false;
    this.setPlan(plan.render, plan.base, plan.places, plan.placeOf);
    this.judgedAt = null;
    return true;
  }

  /** The base scene is built: build what the last known focus wants, all at once (the load is a stall already). */
  attach(): void {
    this.attached = true;
    this.judgedAt = null;
    this.judge(Infinity);
  }

  /** Per frame with the streaming focus. Builds nearest-first within PLACE_BUILD_BUDGET_MS. */
  update(fx: number, fz: number): void {
    this.focus = [fx, fz];
    if (!this.attached || this.places.length === 0) return;
    if (this.judgedAt && Math.hypot(fx - this.judgedAt[0], fz - this.judgedAt[1]) < REJUDGE_STEP) return;
    this.judge(PLACE_BUILD_BUDGET_MS);
  }

  /** Keep a place built regardless of distance (the editor's selection); null clears every pin. */
  pin(placeId: string | null): void {
    if (placeId === null) {
      if (this.pins.size === 0) return;
      this.pins.clear();
    } else {
      if (!this.byId.has(placeId) || this.pins.has(placeId)) return;
      this.pins.add(placeId);
    }
    this.judgedAt = null;
    if (this.attached) this.judge(Infinity);
  }

  /** The place an entity streams with, or undefined (base content, resident landmarks, unknown ids). */
  placeOf(entityId: string): string | undefined {
    return this.placeOfId.get(entityId);
  }

  isLoaded(placeId: string): boolean {
    return this.loaded.has(placeId);
  }

  /** The base doc of the current plan (what the host's base scene is built from). */
  baseDoc(): SceneDoc | null {
    return this.base;
  }

  /** Full render hierarchy, with independently streamed nested roots detached at their world transforms. */
  renderDoc(): SceneDoc | null {
    return this.doc;
  }

  /** Loaded places and resident roots moved by a parent edit need reconciling after detachment. */
  movedRoots(before: SceneDoc): string[] {
    if (!this.doc) return [];
    const changed: string[] = [];
    const roots = new Set(this.loaded.keys());
    for (const [id, entity] of Object.entries(this.base?.entities ?? {})) if (entity.parent === null) roots.add(id);
    for (const id of roots) {
      if (["transform", "visibility"].some((component) =>
        JSON.stringify(before.entities[id]?.components[component]) !== JSON.stringify(this.doc!.entities[id]?.components[component]))) changed.push(id);
    }
    return changed;
  }

  /** Fixed batches live beside entity roots; edits to their source or ancestors must regenerate them. */
  requiresRebuildForInstanceEdits(before: SceneDoc, changedIds: Iterable<string>): boolean {
    if (!this.doc) return false;
    const changed = new Set([...changedIds, ...this.movedRoots(before)]);
    for (const doc of [before, this.doc]) {
      for (const [id, entity] of Object.entries(doc.entities)) {
        const mesh = entity.components["mesh"] as { renderMode?: string; moving?: boolean } | undefined;
        if (mesh?.renderMode !== "instanced" || mesh.moving) continue;
        const place = this.placeOfId.get(id);
        if (place && !this.loaded.has(place)) continue;
        for (let at: string | null | undefined = id; at; at = doc.entities[at]?.parent) {
          if (changed.has(at)) return true;
        }
      }
    }
    return false;
  }

  /** A place's current doc (its streamed entities), or undefined for an unknown place. */
  docOf(placeId: string): SceneDoc | undefined {
    const spec = this.byId.get(placeId);
    return spec && this.doc ? placeDoc(this.doc, spec) : undefined;
  }

  /** The built handle of a loaded place. */
  builtOf(placeId: string): B | undefined {
    return this.loaded.get(placeId);
  }

  forEachLoaded(fn: (placeId: string, built: B) => void): void {
    for (const [id, built] of this.loaded) fn(id, built);
  }

  get stats(): PlaceStreamStats {
    let entities = 0;
    for (const id of this.loaded.keys()) entities += this.byId.get(id)?.ids.length ?? 0;
    return { places: this.places.length, loaded: this.loaded.size, entities, ...this.counters };
  }

  /** Every place spec (tests, probes). */
  specs(): readonly PlaceSpec[] {
    return this.places;
  }

  /** Free every built place (scene teardown). */
  detachAll(): void {
    for (const [id, built] of [...this.loaded]) this.free(id, built);
  }

  private setPlan(doc: SceneDoc, base: SceneDoc, places: PlaceSpec[], placeOf: Map<string, string>): void {
    this.doc = doc;
    this.base = base;
    this.places = places;
    this.byId = new Map(places.map((p) => [p.id, p]));
    this.placeOfId = placeOf;
    for (const id of [...this.pins]) if (!this.byId.has(id)) this.pins.delete(id);
  }

  private wants(spec: PlaceSpec, loaded: boolean): boolean {
    if (this.mode === "none") return false;
    if (this.pins.has(spec.id)) return true;
    if (!this.focus) return loaded; // no focus yet: leave residency as it is
    return placeWanted(spec, loaded, this.focus[0], this.focus[1]);
  }

  private judge(budgetMs: number): void {
    if (this.focus) this.judgedAt = [this.focus[0], this.focus[1]];
    const toLoad: PlaceSpec[] = [];
    for (const spec of this.places) {
      const isLoaded = this.loaded.has(spec.id);
      const wanted = this.wants(spec, isLoaded);
      if (wanted && !isLoaded) toLoad.push(spec);
      else if (!wanted && isLoaded) this.free(spec.id, this.loaded.get(spec.id)!);
    }
    if (toLoad.length === 0) return;
    const f = this.focus;
    if (f) toLoad.sort((a, b) => placeEdgeDistance(a, f[0], f[1]) - placeEdgeDistance(b, f[0], f[1]));
    const now = this.host.now ?? (() => performance.now());
    const start = now();
    for (let i = 0; i < toLoad.length; i++) {
      if (i > 0 && now() - start > budgetMs) {
        this.judgedAt = null; // more to build: judge again next frame
        break;
      }
      this.load(toLoad[i]!);
    }
  }

  private load(spec: PlaceSpec): void {
    if (!this.doc) return;
    const now = this.host.now ?? (() => performance.now());
    const t0 = now();
    try {
      this.loaded.set(spec.id, this.host.build(spec.id, placeDoc(this.doc, spec)));
      this.counters.loads++;
    } catch (error) {
      console.warn(`[places] ${spec.id} failed to build:`, error);
    }
    this.counters.lastBuildMs = now() - t0;
  }

  private free(placeId: string, built: B): void {
    this.loaded.delete(placeId);
    this.counters.unloads++;
    try {
      this.host.free(placeId, built);
    } catch (error) {
      console.warn(`[places] ${placeId} failed to free:`, error);
    }
  }
}
