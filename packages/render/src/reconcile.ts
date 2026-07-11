import * as THREE from "three/webgpu";
import type { EntityDoc, SceneDoc } from "@hitreg/core";
import {
  applyEntityTransform,
  rebuildEntityVisuals,
  type BuildOptions,
  type BuiltScene,
} from "./scene-builder.js";

/**
 * Incremental scene reconciliation: fold a batch's changed entities into an
 * already-built scene instead of rebuilding the whole Three.js graph. The
 * caller (playground) decides WHICH ids changed — this module decides whether
 * each change is safe to apply in place and does the minimal work:
 *
 * - name/tags only        -> rename the group
 * - transform only        -> set the group's local TRS
 * - other component data  -> strip + repopulate that entity's visuals
 *
 * Anything with scene-level side effects (sky background/fog, cameras and
 * active-camera election, postfx, chunkStreamer, subscene) refuses — the
 * caller falls back to a full rebuild. Structural changes (add/remove/
 * reparent) are the caller's problem and must never reach this function.
 */

export interface ReconcileHooks {
  /** Fired before an entity's visuals are rebuilt in place — unregister it
   * from animation/particle/billboard systems so repopulation re-registers
   * cleanly instead of stacking entries. */
  onEntityReset?(entityId: string): void;
  /** Fired after an entity needed more than a transform/name patch. Lets the
   * app veto in-place repair for entities it decorates externally (physics
   * debug, skeleton overlays) by returning false BEFORE anything mutates. */
  allowVisualRebuild?(entityId: string, before: EntityDoc, after: EntityDoc): boolean;
  /** Components with no render representation (scripts, physics, audio, net):
   * data changes to these don't touch the entity's visuals at all. The app
   * decides the set — e.g. colliders are data-only until physics debug is on. */
  dataOnlyComponents?: ReadonlySet<string>;
}

/** Components whose visuals live outside the entity's own group. */
const SCENE_LEVEL = ["sky", "camera", "postfx", "chunkStreamer", "subscene"] as const;

type Action = "none" | "meta" | "transform" | "visuals";

function componentAction(
  before: EntityDoc,
  after: EntityDoc,
  dataOnly: ReadonlySet<string> | undefined,
): Action {
  let action: Action = before.name === after.name ? "none" : "meta";
  const names = new Set([
    ...Object.keys(before.components),
    ...Object.keys(after.components),
  ]);
  for (const name of names) {
    if (dataOnly?.has(name)) continue;
    const a = before.components[name];
    const b = after.components[name];
    if (a === b || JSON.stringify(a) === JSON.stringify(b)) continue;
    if (name === "transform") {
      if (action === "none" || action === "meta") action = "transform";
    } else {
      return "visuals";
    }
  }
  return action;
}

/**
 * Apply changed entities to a built scene in place. All-or-nothing: returns
 * false — before touching anything — when any change can't be applied
 * incrementally, and the caller must full-rebuild. `prev`/`next` are the
 * EXPANDED docs the scene was/should-be built from.
 */
export function reconcileScene(
  built: BuiltScene,
  prev: SceneDoc,
  next: SceneDoc,
  changedIds: Iterable<string>,
  options: BuildOptions,
  hooks: ReconcileHooks = {},
): boolean {
  // plan pass: verify every change is expressible in place before mutating
  const plan: Array<{ id: string; action: Action; after: EntityDoc }> = [];
  for (const id of changedIds) {
    const before = prev.entities[id];
    const after = next.entities[id];
    // missing on either side = structural (caller should have bailed already)
    if (!before || !after) return false;
    if (before.parent !== after.parent) return false;
    const group = built.objects.get(id);
    if (!group) return false;
    for (const name of SCENE_LEVEL) {
      if (name in before.components || name in after.components) return false;
    }
    const action = componentAction(before, after, hooks.dataOnlyComponents);
    if (action === "visuals" && hooks.allowVisualRebuild?.(id, before, after) === false) {
      return false;
    }
    plan.push({ id, action, after });
  }

  // mutate pass
  const materialCache = new Map<string, THREE.Material>();
  for (const { id, action, after } of plan) {
    const group = built.objects.get(id)!;
    group.name = after.name;
    if (action === "transform") {
      applyEntityTransform(group, after);
    } else if (action === "visuals") {
      hooks.onEntityReset?.(id);
      rebuildEntityVisuals(built, id, after, options, materialCache);
    }
  }
  return true;
}
