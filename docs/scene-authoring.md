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
color? })` for runtime flashes/toggles; `ctx.vfx?.playSpell(spellOrId, { origin,
casterId?, targetId?, direction?, target? }, { manual? })` /
`ctx.vfx?.play(effectOrId, frame)` — composed effects and whole timed spells
(`spell` / `vfx` data assets or inline documents; entity ids and bone sockets
resolved for you, ground probed from physics; `manual` phases you fire with
`handle.trigger(phase, at?)`, projectiles driven with `handle.setPath`; absent
on a dedicated server — see `docs/vfx-architecture.md`); `ctx.getDataAsset(id)`
to read any data asset; `ctx.waterAt(x, y, z)` — the water standing over a
point (`{ surfaceY, depth, floorY, swim, current }`, `depth` negative in the
air above it, null where there is none), answering for authored pools and a
procedural world's sea/lakes/rivers alike (see **Swimming**);
`ctx.textureUrl(id)` to turn a texture asset id into
a URL for DOM UI (an inventory icon); `ctx.input.captureKeyboard(owner, on)`
so an open menu hides WASD/ability keys from every gameplay script (released
automatically when the script disposes); and `ctx.playerData` —
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

- **A directional light is aimed by its ROTATION, not its position.**
  `scene-builder` parents the light's target at `(0, -1, 0)` inside the
  entity's own group, so the beam direction is that offset turned by the
  entity rotation; the position only recentres the shadow frustum. A sun
  written with `transform.position: [-18, 16, 14]` and no `rotation`
  points **straight down** whatever the coordinates suggest — which lights
  the ground and the roof brilliantly and leaves every wall on ambient, so
  the scene reads as dusk at noon. Every working sun in the repo carries a
  quaternion; derive one from the direction the light should travel (see
  `projects/dwarf-house/authoring/build-scene.mts` for a six-line helper).
- **`shader: "terrain-splat"` needs per-vertex splat weights.** A primitive
  box or any mesh that carries none renders nearly black under it. Give
  non-DC geometry (ground planes, blockout boxes) its own `standard`
  material rather than reusing the DC palette.
- `remove-entity` deletes the whole subtree — reparent children first if not intended.
- Colors are strict `#rrggbb` strings; `rotation` is a quaternion, not Euler.
- A failing op anywhere rejects the entire batch — build large batches
  confidently, but validate prop names against the prefab's declared props.
- Runnable pipeline demo (ops → prefabs → undo): `pnpm -F @hitreg/core demo`
  (`packages/core/examples/build-a-street.ts`).
- Grime tints (`paintGrime`) are per-corner colors and cannot survive any op
  that changes a face's corner count (subdivide, weather, bevel, …). Order of
  passes is therefore fixed: shape → weather → paint. Grime is a final pass.

## Day/night cycle

Attach the `day-night` builtin script to any entity (the sky is the natural
home) and the scene's existing sky, sun and ambient become the DAY look; the
script derives dawn, dusk and night from its params and drives everything
through `ctx.setSky` — uniforms and light properties only, never a rebuild.
One directional light plays both bodies: it dims to zero at sunset, swings
under the horizon and comes back cool and faint as the moon, so shadows
switch owner for free. The moon itself is a disc on the gradient dome
(`sky.moon`, aimed by the script, or authored for a fixed moon). Two rules the
script obeys and any custom one must too: never toggle a light or add a
second directional light (the light SET must stay constant, or every lit
material recompiles), and never hand the sky a new environment texture per
frame — `refreshEnvironment` re-prefilters the generated IBL in place, a few
times a game day (`envRefreshHours`). Multiplayer: the authority owns the
clock and publishes it to netState (`world.hour`) every `syncSeconds`;
peers ease toward it.

Stars are part of the same dome (`sky.stars`: intensity, density, size) — a
hashed lattice on the view direction, no texture — faded at the horizon and
under the haze band; the `day-night` script raises them after sunset
(`stars`, `starDensity` params) and wheels them about the arc's axis.

Clouds (`sky.clouds`: coverage, scale, speed, softness, color, shadow) are a
drifting fractal-noise layer on the dome, composited over the sun, moon and
stars so they occlude them. Coverage stays authored; the `day-night` script
only lights them — white by day, warmed by `dawnColor` at the horizon, dark
against the stars at night. Two or three octaves of noise per sky pixel.

## Swimming and the underwater look

Two halves that never talk to each other, and one query underneath them.

**Where the water is.** A procedural world already knows: the recipe's sea,
lakes and rivers answer out of the field, so a voxel scene needs no authoring
at all. AUTHORED water — a dungeon pool, a flooded cellar, a canal — declares
itself by putting a `water` component beside the mesh that draws the surface,
which turns that sheet into a volume (the surface, down by `depth`). The
footprint is measured off the mesh, so the only number you normally set is how
deep the basin is; give the volume the bed's depth and no deeper, or the water
is also reported in the room below it. Both feed one `ctx.waterAt(x, y, z)`.

**Wading** comes first, and it is most of what a shoreline is. In water at all,
the gait slows in proportion to how deep it is — ankle-deep is barely slower
than dry land, chest-deep is a third of it — because a single multiplier
applied the instant a toe gets wet reads as a trigger rather than as water.
The POSE follows the same way: `wadeClip` / `wadeIdleClip` (the library's
crouched cycle, the closest a general library comes to pushing through water)
is MIXED into whatever the body would otherwise play, ramped across
`wadeBand` metres either side of `wadeDeepDepth`, so a character walking down
a beach takes the low stance on gradually instead of ducking at a line. The mix
rides on top of the ordinary clip choice, directional clips included — wading
sideways is still a strafe.

That mix is `ctx.setAnimationBlend(from, to, weight)`, which holds two base
clips at complementary weights with their strides phase-matched. It is the tool
for any pose that follows a CONTINUOUS quantity rather than a state; a
crossfade is a blend that always finishes, and this one stays. Weight 0 or 1
collapses to an ordinary play, so it is safe to call every tick, and it
declines under a masked action layer (that path builds the base's complement
from one clip).

**A swimmer goes where it LOOKS.** Hold forward with the camera tipped down and
the character swims down, body pitched along its own travel, capped by
`swimMaxPitch` (60°); tip it up and it climbs toward the surface. This is the
whole reason `ctx.viewDirection` exists — the horizontal `viewForward` cannot
tell "looking at the bottom of the lake" from "looking across it". Strafing
stays horizontal (you do not roll sideways to swim sideways), and the rise/dive
keys still work, steepening the pose as well as the path. Diving needs to be
discoverable: the first thing anyone does in deep water is point the camera at
the bottom and push forward, and a game that swims them along the surface
instead has told them, wrongly, that diving is impossible. It was reported
exactly that way.

**Swimming** is the `third-person-controller`'s (`swim`, on by default). Water
over the feet past `swimEnterDepth` — SHOULDER deep by default — and the body
stops walking and swims:
gravity and ground-following are out of the loop, buoyancy holds it at
`swimFloatDepth`, jump rises, `swimDownKey` dives (a comma-separated LIST —
Ctrl is spoken for on a lot of setups, so `KeyC` and `KeyX` come as defaults
too), and a `current` on the water carries it. Leaving asks a different
question from entering: you swim when the water over your FEET is deeper than
you can stand in, and you stop when the water HERE — measured to the bed — is
shallow enough to stand in, because a floating body's feet hang at its own
float line and asking them just reads that line back. In between it WADES, at
`wadeSpeedMult` of its gait; the gap between `swimEnterDepth` and
`swimExitDepth` is the hysteresis that stops a body at the waterline flipping
modes several times a second. The body publishes `userData.swimming`
(`"wading" | "swimming"`) and `userData.waterDepth` for anything else that
cares — a breath meter, a splash emitter, an AI that will not follow you in.

Actions in the water are always LAYERED — a cast pose is authored standing on
the ground, so a full-body one played on a swimmer is a character standing to
attention in the middle of a lake. The arms cast, the legs keep swimming.
Backing up plays the treading cycle rather than the stroke, upright: nobody
crawls backwards, and a forward stroke run in reverse reads as a character
being dragged by the ankles.

A model with no swim clip still reads correctly: the stroke falls back to the
run cycle with the body tipped `swimPitch` degrees onto its face, which is what
a crawl looks like, and treading falls back to idle. The tip applies **only**
to that stand-in — a real swim clip is authored prone already, and pitching it
too would swim the character nose-first into the bed. Name real clips in
`swimClip` / `swimIdleClip`: the dedicated server cannot ask a model what clips
it has, so an unnamed swim clip is one that remote players never see.

**The float line belongs to the clips, not to the character.** An animation
library authors its swim cycles with the waterline at the model's root — the
one this engine ships measures the crawl's chest at 0.00 and its head at 0.12
above the root, the tread's hip at −0.31 — so `swimFloatDepth` defaults to a
hand's depth (0.1) and both poses read correctly at it. A model with no swim
clips is swimming on a cycle posed standing on the ground, and wants about
1.15 (chest deep) instead, alongside `swimPitch`.

Two things that are worth knowing because they were each a bug you can feel:
the pose (stroke vs tread) is decided from the player's **intent**, never from
the body's measured `vy` — pose picks the float line, the line drives `vy`, and
closing that loop bobs the swimmer at the waterline with its clips flickering.
And `swimVy` returns a velocity to **command**, not to ease toward: the solver
adds a tick of gravity before the controller ever reads `vy` back, so easing
from that reading leaves the body floating a standing 24 cm below its own line,
asking politely for a rise it never gets.

Multiplayer is the usual split: the client predicts its own swim and sends the
velocity its aim worked out (the vertical part rides in the input's `vy`, as a
SPEED), and the authority — dedicated server or P2P host — clamps it like any
other claimed number and runs the same rules from `@hitreg/scripting`'s
`swimStateFor` / `swimVy` / `swimAim` on the body everyone else sees. The
server pitches that body too, because a player diving away from you looks
nothing like one swimming away from you. Nothing to configure;
it is wrong only if the authority cannot answer `waterAt` — which is why the
server builds the same index the client does.

**A wake is the water moving, not a trail drawn on it.** The `swim-wake`
script only declares that a body is disturbing the surface — where, how wide,
how hard. The renderer keeps a world-space HEIGHT FIELD around the camera and
runs the 2D wave equation on it every frame; the water material displaces its
vertices by that field and bends its shading normal along the field's slope, so
the wake catches the sky, shadows its own troughs and rides the water's own
transparency. Tune it on the material — `wakeHeight` (metres of relief, 0.14) and `wakeFoam`
(froth on the crests, 0.1: keep it small, whitening the whole disturbed patch
is what makes a wake read as a decal) — and on the script: `radius` (0.7 m of
surface a swimmer pushes), `strength`, `minSpeed`, `idleStrength`. How far the
wake spreads is the FIELD's own doing, not a knob on either: ripples travel at
about 1.8 m/s and are damped to nothing in under a second, which is what keeps
a swimmer's wake around 15 m² of surface and roughly 6 m long instead of
sweeping the whole lake (`new WaterWake({ size, damping })` in the host).

Only a body AT the surface marks it. The depth is measured from the body's TOP
and faded over `headDepth` (0.45 m), so a swimmer marks the water, a diver a
metre down leaves nothing, and surfacing builds the wake back rather than
switching it on. On a `displace: false` sheet (every lake and river the world
generator writes) the geometry cannot move and only the normals respond — at
these amplitudes that looks the same. Three earlier versions of this gave the
wake a shape of its own (particles, a trail ribbon, foam painted into a mask)
and every one read as an object floating on the lake; nothing looks like water
except the water's own shading.

**The underwater look** is `postfx.underwater`, and it is about the CAMERA,
not the swimmer: everything fades toward the water's colour with distance (the
sky included, which is the detail fake underwater looks miss), plus a flat
tint, desaturation, a refraction sway and a closing-in vignette, all scaled by
how deep the eye is and eased over `fade` so riding the waterline does not
strobe. Per-body overrides live on the `water` component (`color`, `density`)
— a green swamp pool and a blue tarn look nothing alike from inside.

**Measure the water before tuning the thresholds.** This engine's own world
generates rivers 1.7-3.3 m deep and an ocean 45 m deep past the shelf, so a
chest-high swim threshold has a character swimming down the middle of an
ordinary river with the bed at its knees and nowhere to dive to — which is
exactly how it was first reported ("why can we not dive down?"). Shoulder
depth keeps rivers wadeable and leaves swimming for water that is actually
deep. The depth a body reads is measured at its FEET, and the offset from its
origin comes off its own collider (`size[1] / 2`), not from the ground probe's
measured resting distance: that is recorded the first tick a body looks
settled, and a body spawned in mid-air looks settled.

It defaults ON and costs nothing in a scene with no water: the pass is only
built where water exists, and then driven by a uniform. That is deliberate —
building it at the moment somebody dives would rebuild the post chain, which
recreates the scene pass and recompiles every material behind it
(`docs/performance-lessons.md`). The trade is that a scene which has water
carries one cheap full-frame pass whether or not anyone is in it; `enabled:
false` opts out.

## Developer console

`/time midnight`, `/weather storm`, `/wind 90`. Type "/" for the console's own
input line, or type the command in the chat box where a game has one — both
surfaces run the same table.

**Commands are declared by the script that owns the state**, never registered
in a host: a script type carries `static commands: ScriptCommandDecl[]` and
implements `onCommand(name, args)`, returning the line to print and THROWING to
reject an argument. `/help` is generated from those declarations, so a command
cannot ship undocumented or documented-but-absent, and a project's own script
adds `/gold` without touching the engine. Only the commands of scripts that are
RUNNING are offered, which is why `/help` differs between scenes — and why it
says "start play mode" in an empty one. What the builtins declare is in the
spec with everything else; `/help` is the live answer.

A command marked `authority: true` changes state the host owns (the clock, the
weather). The console runs it locally anyway and says the host will correct
this tab on the next sync — a tester who is not told that concludes the command
is broken. It does not reach across the wire: remote GM commands need a
permission model, and a debug tool that ships stripped is the wrong place to
grow one.

**Stripping it for release.** `@hitreg/scripting/console` is imported nowhere in
the engine; the host pulls it in behind a build-time constant
(`import.meta.env.HITREG_CONSOLE`, see `apps/playground/src/dev-console.ts`).
In a bundle built without it the branch folds to `false` and rollup never
follows the import, so the module, the parser, the overlay and their chunk are
simply absent — a published game has no console rather than a disabled one.
`tools/publish.mjs` strips it by default; `project.json`'s `devConsole`
("dev" | "always" | "never") is the game's declared default and
`--console` / `--no-console` override it for one build. The scripts' own
`onCommand` bodies still compile into the scripts (they are methods on classes
that ship regardless), but nothing can reach them: there is no console, and the
published runtime's `window.__hitreg` probe exposes no script runtime.

## Weather

The `weather` builtin script (attach it to any entity; the demo uses the
world) rolls a biome-agnostic state — how much precipitation, how stormy,
which way the wind is going — on the authority (dedicated server or P2P
host), publishes it to netState (`world.weather`), and lets every client
decide what that looks like where its player stands: `ctx.biomeAt` returns
the recipe's biome blend under a point, and the script weights three looks by
it — rain in the `rainBiomes`, blowing sand in the `sandBiomes`, snow in the
`snowBiomes` or above `snowAbove`. Zone edges fade because the biome weights
already do.

**What the land is decides what the sky does, and "the land" is an AREA.**
The blend is averaged over `biomeRadius` (24 m by default) rather than read
under the player's feet, and a look must hold `biomeMajority` of that area
before it appears at all. Both exist because of the same report: a footpath, a
rock shelf or a sandy clearing inside a forest used to flip the whole sky to a
sandstorm. Two separate faults — a point sample, and a normalisation that
divided by the RECOGNISED weight only, so somewhere 85% forest and 15% of an
unlisted biome with a sliver of badlands came out as *all* badlands. Real
borders still cross smoothly, because at a real border the shares really do
cross. When something still looks out of place, `/weather` prints the blend it
decided from — that line is the difference between "the weather is broken" and
"this clearing is 40% crag".

**Some country is dusty with no weather at all.** `dustBiomes` (desert,
badlands, crag) drifts the bank at `ambientDust` on a clear day: bare,
plantless ground always has something for the wind to pick up. It is only ever
the bank, never the lens overlay — that one is a storm you are caught in, not
the look of a dry country. Beaches are deliberately NOT in the list: sand
underfoot is not dust in the air, and a hazy beach looks wrong.

**Weather ARRIVES rather than switching on.** A roll picks a FRONT, not a
downpour, and the authority walks that front's envelope over the window:
a drizzle that spits for a while (`drizzle` sets how hard), a short break
into a pour, a plateau that breathes, then a taper. What it publishes is
where the front has got to, so a joiner mid-storm needs no history. The
moment matters more than the curve — weather that ramps smoothly from
nothing to everything has nothing in it anyone notices.

It drives player-parented emitters tagged `weather-rain`, `weather-sand`,
`weather-snow` and `weather-dust` — their RATE *and their AIM*, via
`ctx.setParticles` — and the sky hook's weather layer (`gloom`, `tint`,
`wind`, `cloudDark`, `flash`, cloud coverage, fog density), which sits on top
of whatever `day-night` wrote, so the two scripts stay independent.
`force: clear | drizzle | light | storm` pins the weather for authoring (a
pinned front still arrives and builds, it just never leaves). It adds no
lights and never replaces the environment texture; a full storm measured
0.6–1.0 ms of particle time and ~130 fps in the MMO scene.

Six things make the difference between "there are particles" and weather:

- **Wind aims the emitters, and rain streaks are oriented by their own
  velocity** (`orient: "velocity"`, see below). The script hands each emitter
  a direction and a speed every tick, so the whole fall leans together and
  the lean is the wind's, not the camera's.
- **Visibility is the weather.** `fogBoost` (rain/snow) and `sandFog` are
  multipliers on the scene's authored fog density, and `sandFog` is far the
  larger: rain thins the distance, a sandstorm ENDS it at a few dozen metres.
  Weather you can see a kilometre through is weather you stop noticing after
  ten seconds — the distance closing in does more work than any particle, and
  costs nothing.
- **Splashes belong where the drop landed.** The rain emitter's
  `ground.splash` fires them: `"weather-splash-ring,weather-splash*3"` — a
  ring spreading on the ground plus three drops thrown back up, at the contact
  point, on `splashChance` of landings. Never drive a splash emitter's *rate*
  instead: every splash then spawns at the emitter's own origin, which is a
  puff of particles at the player's feet and nothing where the rain is.
- **The sky answers the weather**, and it takes three separate things:
  `gloom` dims the lights, `cloudDark` darkens the deck itself, and the dome's
  own gradient darkens with it (`SceneLighting`, from `cloudDark`) — the sky is
  most of what you SEE when you look up, and with only the first two a full
  overcast was a bright grey card over a dim world. Coverage closes to ~0.85,
  not 1: at near-total the deck stops having shapes in it and reads as flat
  fog-coloured card, which is weaker than the overcast it replaced. A sandstorm
  drives all of this too, less and for a different reason — there is no cloud up
  there, but the sun is not getting through either.
- **A sandstorm is on the LENS, not in the world** (`postfx.sandstorm`, driven
  through `ctx.setPostFx`). A world-space bank of quads can only ever be a
  cloud you look at — at the density a storm needs, the quads either swallow
  the camera or hang off in the middle distance — so the grit that sells it is
  a screen-space pass: streaked, rotating, gusting noise aimed by the weather's
  own wind, which rushes outward from the centre of the view as you turn to
  face into it. The bank still runs underneath (it is what the *distance*
  looks like); the pass is what puts you inside it. It is built only for scenes
  that can have weather, exactly like the underwater pass.
- **The wind moves the whole scene, not just the trees.** `weather.wind`
  scales one shared uniform that both the leaf/branch materials and the GRASS
  read (`foliageWindScale`). A gale thrashing the canopy while the grass at
  your feet sways politely is the kind of half-applied effect that makes a
  scene read as fake.
- **Everything falling is dimmed to the hour** (`setParticles({ colorScale })`
  from `ctx.daylight()`). Particles are UNLIT — the batch draws with a basic
  material — so a raindrop is exactly as white at midnight as at noon, and a
  night storm came out as bright white scratches over a black world. The floor
  is not 0: rain picks up the moon and the sky, so black rain is as wrong as
  white rain.
- **Lightning is `weather.flash`**: a flicker (stroke, gap, return strokes)
  washing sky, fog, fill and ambient for 0.6 s. No light is added or removed
  and no material is touched, so a strike cannot stall the frame. The
  authority publishes a strike counter the moment it fires rather than waiting
  for the next sync, and `thunder` names a sound played after the travel
  delay. A sandstorm's `weather-dust` bank — slow, huge, half-transparent
  `orient: "upright"` quads rolling along the ground — is what turns blown
  grains into a visibility problem; its instance count is a fill-rate budget,
  not a look decision.

Particles can now meet the terrain: `particles.ground` samples the streamed
ground height once per particle at birth (voxel and heightmap worlds), and a
particle that falls to it either dies (`mode: kill`) — optionally bursting
particles from the emitters listed in `splash` at the exact contact point,
which is how raindrops splash on slopes — or settles (`mode: settle`):
stops where it landed, keeps its look for `hold` seconds, then fades over
`fade`. Settled particles count toward `max`, so a settling snowfall wants a
few thousand. In a play session the host answers from the PHYSICS world (a
downward ray from the birth point), so roofs, walls and the player count too
— a tree's trunk collider lands snow in its canopy; outside play, the
terrain height alone. Water is not tested.

That birth sample is only the FIRST guess, and in wind it is the wrong one: a
drop falling for half a second in a gale lands seven metres downwind, over
ground that is not the height measured under its birthplace — so it splashed
in mid-air over rising ground and under the surface over falling ground. The
first contact therefore only TRIGGERS a second sample, taken two metres early
at the particle's actual position, and the drop lands on that. Two queries per
particle at worst, and none at all when there is no sideways motion to drift
with.

`particles.orient` decides what each quad points at, and it is the field that
separates rain from scratches on the lens:

- `camera` (default) — the usual billboard. With `stretch` it rolls to lie
  along the velocity *as projected on screen*, which is right for a spark and
  wrong for weather: the streaks swing about as you turn your head and never
  foreshorten.
- `velocity` — the quad's long axis is the particle's WORLD velocity, spun
  about that axis to face you. Rain then falls the way the wind blows it and
  shortens honestly when you look along it.
- `ground` — laid flat in the XZ plane, facing up: splash rings, ripples,
  scorch marks. **Never pair it with `softFade`** — the quad lies centimetres
  above the surface behind it, so the fade measures that gap and erases the
  effect, which looks exactly like it failing to spawn.
- `upright` — turns about Y only, so a tall quad stays vertical when you look
  up through it: dust banks, haze.

Three procedural sprites go with them: `ring` (a hollow annulus — a splash is
a ring, and a filled blob on the ground is the puff-of-smoke look whatever its
colour), `streak` (a vertical tapered line for rain and thrown droplets) and
`noise` (a torn, four-octave puff for anything big and slow — dust banks, smoke
fronts). The noise one is the exception to the PSX rule: it is 128px and
smoothly filtered, because it is stretched across a five-metre quad where a
32px nearest-filtered sprite is a visible chequerboard. Give it `spin` — its
structure is only visible because it turns.

**Tuning a screen-space effect: do it offline first.** A browser round trip
through a streamed world is minutes; the same noise field rendered to a PNG by
a throwaway Node script is seconds, and questions like "is this sand or is it
camouflage" are answerable from a still. That is how the sandstorm's defaults
were chosen — and how `steps: 3` was caught turning grains into flat
torn-paper patches, which is why its default here is 0 even though the house
style is PSX. Let `postfx.pixelate` supply the retro look instead: chunky
pixels of a smooth field still read as sand, smooth pixels of a banded one do
not.
