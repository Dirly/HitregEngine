/**
 * Which components can never move their entity — the host's implicit-static rule (`isAutoStatic` in main.ts): an
 * entity whose own and ancestors' components are all in STILL_COMPONENTS batches, freezes in play and is gated as
 * placed content, like `mesh.static`. Anything else counts as possibly moving.
 *
 * EVERY registered component must be classified here, still or moving (test/still-components.test.ts fails on a new
 * one). An unclassified component counted as moving silently: the authoring-only `placeRule` (2026-11-02) landed on
 * 119 world-kit prefab roots and made every town building, wall and kit prop unbatchable, unfrozen and outside the
 * ground gate (p-perf 2026-11-02).
 */
export const STILL_COMPONENTS: ReadonlySet<string> = new Set([
  "transform", "mesh", "collider", "dressing", "culling", "light", "audio", "decal",
  "visibility", "spawnArea", "portalAnchor", "prefab", "tags", "lod",
  // fog data only (landmark-fog): the batcher already merges a landmark apart so its unit can fog it
  "landmark",
  // effects read their entity's position and draw from their own batches;
  // they never move it (a lamp's flame must not make its post unbatchable)
  "vfx", "particles",
  // authoring-time metadata the placement solver / dressers read; nothing reads it at runtime
  "placeRule", "placement",
  // client streaming settings of a place root (place-stream.ts): read once at load, never moves anything
  "placeStream",
  // scene-level data, never on a moving thing
  "cullingProfile", "loadingScreen", "pathScatter",
]);

/**
 * Components that may move their entity (or whose host owns a per-frame transform), so a subtree holding one never
 * batches or freezes. `script` is moving unless the script declares `stillWith` for its params (main.ts).
 */
export const MOVING_COMPONENTS: ReadonlySet<string> = new Set([
  "script", "rigidbody", "joint", "animator", "clothSway", "billboard", "camera", "netObject",
  // world-scale singletons: never batched as placed content
  "sky", "postfx", "water", "voxelWorld", "grass",
]);
