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

- Render: `transform`, `mesh` (primitive / glTF `asset` / extruded `polygon` /
  `heightmap` terrain), `light`, `camera` (+ optional follow `rig`), `material`
  (a data asset referenced by GUID), `sky`, `postfx`, `particles`, `billboard`.
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
- **`sky` and `postfx` are one-per-scene** (first wins). Bloom (postfx) is what
  makes emissive materials actually glow; `material.shader: "unlit"` is
  flat/PS1-style and ignores lights.
- **`subscene` is the AI-context unit:** a whole scene FILE placed at a
  transform (the Skyrim pattern) — "add a blacksmith to Riverwood" edits a
  300-line village file, not the world. A placed scene has its sky/postfx/nested
  subscenes stripped; it stays a normal scene you can open in the picker and
  play standalone. The same scene places many times (ids namespaced per
  placement). Demo: `demo-chunks` places `village-a` twice.
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

### Script context (a runtime API, not a schema)

`script: { name, params }` attaches a registered behavior — GET /__hitreg/spec
`scripts` lists every behavior and its params. Inside a script, `ctx` offers
what the schema can't describe: `setAnimation(clip, fade, { loop })` —
`loop: false` plays once then emits the local `animation.completed`
`{ entityId, clip }` (attack/emote → idle chaining); `playSound(id?)`,
`setActiveCamera(id)`, `viewForward()`, sim velocity APIs; `ctx.after(s, cb)` /
`ctx.every(s, cb)` — deterministic sim-stepped timers (replay/multiplayer-safe,
NOT setTimeout; return a cancel fn, auto-cancelled on dispose/suspend);
`ctx.setBillboard({ fill?, text?, visible? })`; and `ctx.playerData` —
experience-scoped persistence (`get/set/increment/transaction/keys(namespace,
…)`, async, quota+rate-limited, atomic; survives sessions, e.g.
`ctx.playerData?.increment("stats", "sessions")`). Minimal example:
`session-counter`.

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
`ctx.playerData`. Reference: cube-rpg's `enemyHp/*`, `defeated/*`, `taken/*`
(shared pickups + migration-proof combat in ~30 lines).
The `events` block of GET /__hitreg/spec is the AI-facing payload spec; the
context bridge posts `recentEvents` (last delivered `{ tick, name, payload }`)
while playing. Minimal example: `apps/playground/src/scripts/event-demo.ts`.

## Pitfalls

- `remove-entity` deletes the whole subtree — reparent children first if not intended.
- Colors are strict `#rrggbb` strings; `rotation` is a quaternion, not Euler.
- A failing op anywhere rejects the entire batch — build large batches
  confidently, but validate prop names against the prefab's declared props.
- Working example: `apps/playground/src/street-scene.ts`; runnable pipeline
  demo: `pnpm -F @hitreg/core demo`.
