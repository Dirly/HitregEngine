# Scene Authoring (HitReg Engine)


Everything is JSON documents mutated through ops batches. Never hand-edit a
scene doc's internals; build an `Op[]` and run `applyOps(doc, ops, registry)` —
it is atomic (all-or-nothing), schema-validates every component, and returns
inverse ops for undo.

## Ops vocabulary

```
add-entity { id, entity }          remove-entity { id }        // cascades to subtree
reparent { id, parent }            rename { id, name }
set-tags { id, tags }              set-component { id, component, data }
remove-component { id, component }
```

An entity: `{ name, parent: id|null, tags: string[], components: { [type]: data } }`.
Components are validated against the `ComponentRegistry` — unknown types and
out-of-schema data reject the whole batch. Defaults are filled in for you, so
minimal data is idiomatic: `transform: {}` is a valid identity transform.

## Components

Components are schema-validated by the `ComponentRegistry`; defaults are filled
in, so minimal data is idiomatic (`transform: {}` = identity). **For exact
fields, types, defaults, and per-field notes, read the generated spec — it is
built from the same Zod schemas that validate, so it cannot drift:**

```
curl -s http://localhost:5173/__hitreg/spec   # live: the running app's full surface
```

or the committed `spec.json` at the repo root (engine surface; regenerate with
`pnpm spec`). Each field carries a `description` with the non-obvious bits. What
follows is the map and the judgment the schema can't encode.

**What exists** (fields → the spec):

- Render: `transform`, `visibility`, `mesh` (primitive / glTF `asset` / extruded `polygon` /
  editable `poly` mesh / `heightmap` terrain), `light`, `camera` (+ optional follow `rig`),
  `material` (a data asset referenced by GUID), `sky`, `postfx`, `particles`, `billboard`.
- Physics: `rigidbody`, `collider`, `joint`.
- Behavior / data: `script`, `animator`, `audio`, `prefab`, `netObject`.
- Streaming: `chunkStreamer`, `subscene`.

**Judgment the spec can't tell you:**

- **Zero-config multiplayer:** any entity with a `script` + `rigidbody` and no
  `netObject` replicates as `netObject: {}` automatically (host-simulated). Add
  the component only to opt out of a field or tune relevancy/send rate. In a
  session the host simulates these; other tabs suspend their local copy and
  render interpolated ghosts.
- **`collider` without `rigidbody` = static scenery.** `trimesh`/`convex`/
  `heightmap` colliders cook exact collision from the entity's own mesh (GLB
  models included) and ignore `size`.
- **An instance's `transform` REPLACES the prefab root's — so author the root as
  an empty anchor at the foot.** Expansion applies instance-declared components
  over the root's *per component*, so any offset authored on the root entity is
  discarded the moment the prefab is placed. A prefab whose root carries a mesh
  sitting at, say, y = 0.25 therefore renders 0.25 m lower than it looks in
  isolation, and a root mesh can never have its foot at its own origin anyway (a
  box's origin is its centre). The failure is invisible while you author the
  prefab and systematic once it ships: one mis-authored root becomes every
  instance of that prop sunk into the floor by the same amount. In one dungeon
  set this was **617 placement errors across three levels — half to two-thirds
  of all props buried** — from about fifteen prefabs.
  The rule that avoids it: **the root is an empty anchor with no mesh and no
  collider, positioned at the piece's contact point (its foot), and all geometry
  hangs off it as children with explicit local offsets.** Then placing the
  instance at a floor height is correct by construction. For a wall-mounted or
  hanging piece the anchor is its mount point instead; say which in the prefab's
  docs, because a placer cannot tell from the JSON.
- **Resized primitives squash their texture — unless you ask for world UVs.** A
  primitive maps one texture tile across each face whatever that face measures,
  so a 2 m wall box and a 40 m wall box of the same material do not match, and
  level geometry built by resizing boxes reads as smeared.
  `mesh.source.uv = { mode: "world", scale: [2, 2] }` generates the UVs in
  METRES instead (there, one tile every 2 m), so the texture holds its real size
  as the box is resized and neighbouring pieces line up. It is baked into the
  mesh's own UVs, so it costs nothing per fragment, and it is OBJECT-space, so
  it survives instancing and moving the entity. The material's `repeat` still
  multiplies on top — set that to `[1, 1]` on materials meant for world-UV
  meshes. Prefer it to `material.triplanar` for flat, axis-aligned, resized
  geometry (walls, floors, slabs); triplanar remains the right tool for
  sculpted rock with no sane unwrap, and being world-SPACE its texture swims if
  the mesh moves. `wedge` ships no UVs at all in the default `stretch` mode, so
  world mode is currently the only way to texture one.
- **`sky` and `postfx` are one-per-scene** (first wins). Bloom (postfx) is what
  makes emissive materials actually glow; `material.shader: "unlit"` is
  flat/PS1-style and ignores lights.
  `postfx.pixelate` (`{ enabled, height: 240, filter: "nearest" }`) renders the
  whole frame at that many lines and lets the canvas scale it up — the
  fake-PSX resolution look, and a large speed-up since every pass runs at
  the small size. Pair it with `unlit` materials for the full effect.
- **`subscene` is the AI-context unit:** a whole scene FILE placed at a
  transform (the Skyrim pattern) — "add a blacksmith to Riverwood" edits a
  300-line village file, not the world. A placed scene has its sky/postfx/nested
  subscenes stripped; it stays a normal scene you can open in the picker and
  play standalone. The same scene places many times (ids namespaced per
  placement).
- **Chunks** stream runtime-only content around the player (play) or camera
  (edit): they render + collide, hot-swap on file change, and NEVER enter the
  scene doc (so autosave/undo/diff stay clean). Files:
  `assets/chunks/<source>/<cx>_<cz>.chunk.json`, positions local to the cell
  (world origin `[cx*cellSize, 0, cz*cellSize]`). Distant rings render as merged
  HLOD proxies; keep the `simulation` ring ≥ your play area.
- **Spritesheets** (data assets, `assets/spritesheets/*.json`): a `grid`
  auto-splices frames `f0..fN`; `frames` alias cells or define rects. A missing
  frame never crashes — magenta placeholder + a did-you-mean warning in the
  context bridge `diagnostics`, re-resolved live on edit.
- **Bone attachment:** parent an entity under a rigged model and add
  `script: { name: "bone-socket", params: { bone, offset, rotationDeg } }`. The
  editor's "bones" toggle draws the skeleton; the inspector `bone` param is a
  dropdown of the rig's real bones.
- **Scenes:** multiple `assets/scenes/<name>.scene.json`; the toolbar picks.
  Only the edited scene live-syncs; a new file joins the picker.

### Editable meshes (`mesh.source.kind: "poly"`)

The ProBuilder-class format: `vertices` (shared positions) + `faces` (n-gons,
vertex indices counter-clockwise seen from outside) with per-face `mat`
(material slot into `materials`), `smooth` (0 = hard, same nonzero group =
smoothed together), `uv` (auto-unwrap settings, or `mode: "manual"` +
`coords`), and `color`. `generator` records the parametric shape while the
mesh is untouched. Fields → the spec; judgment:

- **Never hand-triangulate.** Faces are n-gons; the renderer ear-clips them.
  Keep n-gons planar; quads are what the loop/ring/insert-loop tools walk.
- **Edit through the ops, not by index surgery.** `@hitreg/core` exports the
  whole toolset as pure functions — `extrudeFaces`, `extrudeEdges`,
  `insetFaces`, `bevelEdges`, `subdivideFaces`, `connectEdges`,
  `insertEdgeLoop`, `deleteFaces`, `collapseVertices`, `weldVertices`,
  `mergeFaces`, `bridgeEdges`, `fillHoles`, `flipFaces`, `conformNormals`,
  `centerPivot`, `mirror`, `setFaceMaterial`, `setSmoothingGroup`,
  `planarProjectFaces`, `transformUvs`, … — each returns `{ mesh, selection }`;
  write `mesh` back with one `set-component`. Selection helpers
  (`edgeLoop`, `edgeRing`, `growFaces`, `coplanarFaces`, `boundaryLoops`)
  answer "which elements" questions. Shapes: `buildShape("stairs", { steps: 8 })`
  (see `SHAPES` for every generator and its params); `polyFromPrimitive` /
  `polyFromFootprint` convert the older sources.
- **Resolve "this face" from the context bridge.** While a human is in mesh
  edit mode, `focus.mode` is `mesh-edit:<vertex|edge|face>` and
  `focus.meshEdit` carries the entity id plus the selected element indices —
  those index the entity's `mesh.source.vertices` / `faces` directly.
- **Colliders:** pair a poly mesh with `collider.shape: "convex"` (convex
  shapes) or `"trimesh"` (concave, static scenery); a `"box"` collider is
  auto-fitted to the bounds by the editor on every edit.
- **Anything can become editable.** `polyFromGeometry(positions, indices)`
  turns triangle soup (a glTF part, a path mesh, CSG output) into welded
  n-gons with inferred smoothing groups — the editor's "make editable mesh"
  and the boolean tools (union / subtract / intersect, `@hitreg/editor`'s
  `booleanMeshes`) both end there, so a boolean result stays fully editable.
- **Colors:** `face.color` tints a whole face; `face.colors` (one per corner)
  is painted vertex color and wins where present. Both need a material that
  shows vertex colors (the renderer enables it automatically on tinted meshes).
- Cost model: a compile is cheap at the sizes a designer hand-edits
  (hundreds–low thousands of faces); this is level geometry, not a sculpt
  format — keep organic detail in glTF assets.

### Script context (a runtime API, not a schema)

`script: { name, params }` attaches a registered behavior — GET /__hitreg/spec
`scripts` lists every behavior and its params. Inside a script, `ctx` offers
what the schema can't describe: `setAnimation(clip, fade, { loop })` —
`loop: false` plays once then emits the local `animation.completed`
`{ entityId, clip }` (attack/emote → idle chaining); `playSound(id?)`,
`setActiveCamera(id)`, `viewForward()`, sim velocity APIs; `ctx.after(s, cb)` /
`ctx.every(s, cb)` — deterministic sim-stepped timers (replay/multiplayer-safe,
NOT setTimeout; return a cancel fn, auto-cancelled on dispose/suspend);
`ctx.setBillboard({ fill?, text?, visible? })`;
`ctx.setParticles(entityId, { emitting?, visible?, restart?, burst? })` for
sleeping and one-shot effects; `ctx.setLight(entityId, { enabled?, intensity?,
color? })` for runtime flashes/toggles; and `ctx.playerData` —
experience-scoped persistence (`get/set/increment/transaction/keys(namespace,
…)`, async, quota+rate-limited, atomic; survives sessions, e.g.
`ctx.playerData?.increment("stats", "sessions")`); and `ctx.chat` (when the
app mounts `@hitreg/comms`) — `send(channel, text)`, `announce(text)` (authority
→ everyone), `system(text)` (local), `on(cb)` / `history()` over exactly the
lines this tab was allowed to see; team/party membership is plain netState
(`comms.team/<peerId>`, `comms.party/<peerId>`) — see `docs/comms.md`.

## Prefabs (React-style)

Definition = entity subtree + declared props bound by path into it:

```ts
assets.addPrefab("prefab-streetlight", {
  version: 1, name: "Streetlight", root: "pole",
  entities: { pole: {...}, lamp: { parent: "pole", ... } },
  props: { lightColor: { default: "#ffcc88", bindings: ["lamp/components/light/color"] } },
});
```

Instance = one entity with a `prefab` component:

```ts
components: {
  transform: { position: [5, 0, 0] },        // instance components replace root's, per component
  prefab: {
    prefabId: "prefab-streetlight",
    props: { lightColor: "#ff2200" },         // unknown prop names are errors
    overrides: [{ path: "lamp/components/light/intensity", value: 3 }],
  },
}
```

### Props are knobs, not just values

A prop declaration carries the metadata an editor needs to render a real
control and an agent needs to know what it may safely turn — `kind`, `label`,
`group`, `min`/`max`/`step`, `unit`, `options`, `assetKind`, `advanced`,
`description`. Field meanings live in the spec (`propSpecSchema`); the judgment
call is *when to bother*:

- **Whatever generates a prefab declares its knobs.** A rifle that ships with
  `{ default, bindings }` and nothing else is a black box: the human who asked
  for it gets a raw JSON blob, and the next agent has to reverse-engineer which
  number is the recoil. Declaring `min`/`max`/`unit`/`group` is what makes
  one-shot output tweakable afterward.
- **Everything else is inferred.** Omit `kind` and it comes from the default
  (`"#ffcc88"` → color, `[0,1,0]` → vec3, presence of `options` → enum). The
  bare `{ default, bindings }` shape still validates — declare metadata where
  it earns its keep, not everywhere.
- **Bad ranges are rejected at authoring time**, not silently ignored: a
  default outside `min`/`max`, an enum default that isn't one of `options`, an
  inverted range, or a binding whose first segment names no local entity all
  throw from `validatePrefab`.
- **One declaration, both audiences.** `describePrefab(doc)` resolves a
  definition into `{ parts, props, groups }` — the breakdown the instance
  inspector draws *and* what `/__hitreg/spec` publishes under `prefabs`. Read
  the spec to learn a prefab's tunable surface; never re-derive it from prose.

Rules:
- Scene docs keep instances **collapsed**; `expandScene(doc, assets, registry)`
  resolves them (children namespaced `instanceId:localId`). Never store an
  expanded scene as source.
- Definition edits (`assets.updatePrefab`) propagate to all instances on next
  expand; overrides survive.
- Prefabs nest; cycles are rejected. Prefab roots may not themselves be
  instances (variants unsupported so far).

## Data assets (ScriptableObjects)

```ts
assets.defineDataType("weapon-stats", zodSchema);
assets.addDataAsset({ id: "pistol", type: "weapon-stats", name: "Pistol", data: { damage: 10 } });
```

Reference by GUID from components/scripts. `updateDataAsset` = every referent
sees new values. Schemas for AI: the `dataAssets` block of GET /__hitreg/spec
(or `assets.dataTypeJsonSchemas()` in code).

**On disk, a data-asset FILE is the bare `data` payload — not the wrapper.**
The call above is the *code* API; the loader (`apps/playground/src/
asset-loader.ts`) reads `materials/<id>.json` and registers the file's entire
contents as `data`, taking `id` from the **file path**. So a material file's
top level is `{ "shader": "standard", "map": "…", … }`. Writing the code shape
into the file instead — `{ version, id, type, name, data: {…} }` — does **not**
fail loudly: the component schemas are non-strict, so Zod strips every unknown
key and the asset resolves to ALL DEFAULTS. A fully-authored PBR material then
renders as untextured grey with `roughness` 0.85, with no error anywhere. If a
material looks flat and untextured but nothing warns, check this first.

## Events (typed, deterministic)

Scripts talk through `ctx.events` — `emit(name, payload)`, `on(name, cb)` (returns
unsubscribe; auto-unsubscribed when the script disposes), `once(name, cb)`.
Determinism: `emit` never dispatches synchronously — events queue and are drained
in FIFO order at one fixed point per tick (inside fixedUpdate, after scripts run);
handler emissions cascade same-tick, capped at 8 passes. Built-in engine events:
`entity.spawned` / `entity.destroyed` `{ entityId }` (runtime additions/removals
only — play start is not spawning), `collision` `{ a, b }`, and `trigger.enter` /
`trigger.exit` `{ trigger, other }` for `isTrigger` colliders (all local-only),
plus `player.joined` `{ peerId, name }` / `player.left` `{ peerId }` — emitted on
the session authority and REPLICATED to every peer. Custom events: register a Zod
schema on the `EventRegistry` (`events.register("wave-cleared", schema)`, names
`/^[a-z][a-z0-9-.]*$/`) — registered payloads are validated on emit (invalid =
dropped with a warning); unregistered names warn once but still deliver.
Multiplayer directions (`replicate` option): `true` / `"to-peers"` = emitted on
the host, delivered into every peer's bus reliable-ordered (announcements —
"round.started", "chest.opened"; the ClientRpc-analog). `"to-authority"` = a
peer's emit is NOT delivered locally; it ships to the host as a request, passes
the same schema gate there, and the authoritative handler receives
`(payload, meta)` with `meta.from` = the requesting peer (requests — "npc.hit",
"interaction.requested"; the ServerRpc-analog). On the host and in single-player,
to-authority events simply deliver locally — game code is identical either way.
Peers can never inject broadcast/local events upward; results flow back via
snapshots or to-peers events.
Session state — `ctx.netState` (the NetworkVariables analog): facts every tab
must agree on (enemy HP, "chest opened", "crystal taken", round score) live in
a replicated key-value store, keys `"namespace/rest"`. Reads work everywhere;
writes apply only on the session authority (`ctx.netState.isAuthority()`) —
peers request changes through a to-authority event and the authoritative
handler writes. `onChange(cb)` fires on every change, local or replicated
(auto-unsubscribed on dispose). Deltas ride the reliable channel, joiners get
a full sync, and a promoted host INHERITS the replica — state survives host
migration. It all dies with the room: commit durable results into
`ctx.playerData`. Pattern: a manager script keeps shared facts (enemy HP,
"chest opened", per-player score) under namespaced keys; peers request changes
via to-authority events and the authority writes the result — shared pickups +
migration-proof combat in ~30 lines.
The `events` block of GET /__hitreg/spec is the AI-facing payload spec; the
context bridge posts `recentEvents` (last delivered `{ tick, name, payload }`)
while playing.

## Placement (settle props, don't eyeball them)

Authoring-time solvers, not runtime scripts: a solve bakes its result into the
ordinary `transform` component, so the JSON stays the truth and nothing runs
per frame. Field reference: the `placement` component schema in the spec —
this section is only the judgment around it.

- Give a prop a `placement` component and a solve settles it onto the surface
  it declares (ground / ceiling / wall), embedded `sink` metres so uneven
  floors leave no hairline float, with seeded rotation/scale jitter so a
  scattered batch doesn't read as copy-paste. Same doc + ids + seed always
  reproduces the same result.
- Three ways to run a solve:
  - **Editor placement assist** (toolbar toggle, on by default): moving,
    duplicating, or dropping an opted-in entity settles it automatically.
    Entities without the component never move on their own.
  - **CLI, headless**: `pnpm -F playground place snap <scene.json>` settles
    every opted-in entity and writes the file (live-syncs into a running
    dev session like any other scene edit). `--ids a,b` snaps exactly those
    entities whether or not they opted in; `--seed n` varies the jitter;
    `--dry-run` reports without writing.
  - **API**: `snapPlacementOps` / `lintPlacement` from `@hitreg/core` for
    tools and generators.
- `pnpm -F playground place lint <scene.json>` reports floating (detached) props
  and z-fight risks (same-facing coincident
  coplanar faces — the flicker), each with the world point to look at; pass
  `--overlap <tol>` to also report interpenetrating statics (opt-in, because
  graybox construction interpenetrates on purpose). Exit
  code 1 when findings exist, so generators can gate on it: place, lint,
  fix, re-run to clean.
- `embed: [min, max]` buries a seeded random fraction of the entity’s own
  height past the surface — scatter rocks read as half-sunk in the ground
  instead of perched on it (pair with `rotJitter: "full"`). Additive with
  `sink`; ground/ceiling only.
- Author wall props with their back at local **-Z**; wall snap replaces the
  rotation (local +Z faces into the room) and keeps the authored height.
- Support geometry headless is primitives, poly meshes, extruded polygons,
  and heightmap terrain. `asset` (GLB) and `path` meshes contribute none —
  snapping onto a model needs the running app or a primitive proxy.

## Lighting interiors that read

The most common authoring failure in enclosed spaces is lighting that looks
sensible in the JSON and renders nearly black. The numbers that actually
work are in the `light` schema's field docs (spec: components.light) — the
short version: interior ambient 1.2–1.8, point lights 6–15 with range sized
to the room, and the sun contributes nothing under a ceiling. Calibrate to
the screen, not to taste: an interior shot of a lit room should average
mean luma 70–100 out of 255. When a whole scene trends dark, raise
`postfx.tonemap.exposure` once instead of touching every light.

## Pitfalls

- `remove-entity` deletes the whole subtree — reparent children first if not intended.
- Colors are strict `#rrggbb` strings; `rotation` is a quaternion, not Euler.
- A failing op anywhere rejects the entire batch — build large batches
  confidently, but validate prop names against the prefab's declared props.
- Runnable pipeline demo (ops → prefabs → undo): `pnpm -F @hitreg/core demo`
  (`packages/core/examples/build-a-street.ts`).
- Grime tints (`paintGrime`) are per-corner colors and cannot survive any op
  that changes a face's corner count (subdivide, weather, bevel, …). Order of
  passes is therefore fixed: shape → weather → paint. Grime is a final pass.
