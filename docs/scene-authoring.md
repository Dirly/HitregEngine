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

## Core components

- `transform` — `{ position: [x,y,z], rotation: quat [x,y,z,w], scale: [x,y,z] }`, all optional.
- `mesh` — `{ source: { kind: "primitive", shape: box|sphere|plane|cylinder|capsule|cone|torus, size: [x,y,z] } | { kind: "asset", assetId }, castShadow, receiveShadow, static }`.
- `light` — `{ kind: directional|point|spot|ambient, color: "#rrggbb", intensity, range, angle, castShadow }`.
- `camera` — `{ fov, near, far, active, rig?: { mode: "follow", targetTag, distance, height, damping } }` (follow rig tracks the first entity with targetTag in play mode).
- `prefab` — makes the entity a prefab instance (below).
- `rigidbody` — `{ kind: dynamic|kinematic|static, lockRotations, ccd, ... }`; `collider` — `{ shape: box|sphere|capsule|cylinder|heightmap|trimesh|convex, size, offset, friction, restitution, isTrigger }` (collider without rigidbody = static; `trimesh`/`convex` cook exact collision from the entity's mesh — GLB models included — and ignore `size`). `joint` — `{ kind: fixed|hinge|slider|ball, target, anchorA, anchorB, axis, limits?, motor? }`.
- `script` — `{ name, params }`: attach registered behaviors (spinner, oscillator, player-controller, collectible, anim-cycler + project scripts in src/scripts/). Script context: setAnimation(clip, fade), playSound(id?), setActiveCamera(id), viewForward(), sim velocity APIs, and `ctx.playerData` — experience-scoped persistence (`get/set/increment/transaction/keys(namespace, ...)`, async, quota+rate-limited, atomic revisions; survives across sessions — e.g. `ctx.playerData?.increment("stats", "sessions")`). See `session-counter` for the minimal example.
- `animator` — `{ play?: clipName, fade, speed }` for glTF asset meshes; clips crossfade Unity-style.
- `audio` — `{ src: soundAssetId, volume, loop, autoplay, positional, refDistance }` (files in assets/audio/).
- `sky` — scene environment, one entity per scene (first wins): `{ top, bottom, texture?, cubemap?: { px, nx, py, ny, pz, nz }, light, fog?: { color, near, far } }`. Default is a gradient dome between `top`/`bottom`; `texture` (an equirectangular panorama texture asset id) replaces it; `cubemap` (six face texture asset ids) wins over both. `light` drives a hemisphere fill tinted by `top`/`bottom` (0 disables); `fog` is optional linear fog.
- `postfx` — scene post-processing, one entity per scene: `{ bloom: { enabled, strength, radius, threshold } }`. Bloom makes emissive materials actually glow; materials also support `shader: standard|unlit|toon|wireframe` (`unlit` = flat/PS1-style, ignores lights).
- `particles` — data-driven emitter: `{ emitting, rate, max, lifetime: [min,max], shape: point|sphere|box|cone, shapeSize, direction, speed: [min,max], gravity, drag, sizeStart/End, colorStart/End, opacityStart/End, blending: normal|additive, space: local|world, texture? }`. All fields defaulted — `particles: {}` is a valid starter.
- `billboard` — camera-facing world-space UI above an entity (HP bar, name label, icon): `{ kind: bar|text|sprite, offset, size: [w,h], fill: 0..1, color, background, backgroundOpacity, text, texture?, sheet?, frame?, visible }`. All fields defaulted — `billboard: {}` is a full green bar at [0, 1.4, 0]; scripts drive it at runtime via `ctx.setBillboard({ fill?, text?, visible? })`. Sprite kind takes a whole `texture` OR a `sheet` + `frame`.
- Spritesheets — data assets in `assets/spritesheets/*.json`: `{ texture: <texture asset id>, grid?: { cols, rows, frameWidth, frameHeight, margin, spacing }, frames?: { name: { index } | { x, y, w, h } } }`. The grid auto-splices into frames `f0..fN` (row-major); named entries alias grid cells or define explicit rects. Referencing a missing frame never crashes: the renderer shows a magenta placeholder, warns with a did-you-mean suggestion, and reports it in the context bridge `diagnostics` — editing the sheet JSON re-resolves all consumers live.
- `chunkStreamer` — opts the scene into streamed chunk worlds: `{ source, cellSize, radius, keepPadding }`. Chunk files live in `assets/chunks/<source>/<cx>_<cz>.chunk.json` (`{ version: 1, entities: {...} }`, positions local to the cell origin; cell world pos = `[cx*cellSize, 0, cz*cellSize]`). Chunks load/unload around the player (play) or camera (edit), render + collide, but never enter the scene doc — they hot-swap when their file changes. Keep chunk content static (no scripts/dynamic bodies) for now.
- `subscene` — micro-scenes as additive modules: `{ scene, mode: always|proximity, radius, keepPadding }` on a positioned entity loads a whole scene FILE (`assets/scenes/<scene>.scene.json`) at that transform — the Skyrim pattern: each village/dungeon is its own small scene, the world composes them as one-liners. Same scene can be placed many times (ids are namespaced per placing entity). The subscene file stays a normal scene: open it in the picker and press play to test it in isolation; its `sky`/`postfx` (and nested `subscene`s) are stripped when composed. Loaded content renders + collides + runs scripts, hot-swaps when its file changes, and never enters the world doc. Prefer small scenes — they're the AI-context unit ("add a blacksmith to Riverwood" edits a 300-line file, not the world). Demo: `demo-chunks` places `village-a` twice.
- `netObject` — declares the entity network-replicated (Unity NetworkObject analog): `{ authority: host|owner, sync: { transform, animation }, relevancy: always|proximity, radius, sendEvery }`. `netObject: {}` = host-simulated, everything synced, relevant to all peers, every snapshot. Interest management: `relevancy: "proximity"` transmits only to peers within `radius` (need-to-know, with leave hysteresis); `sendEvery: 4` sends every 4th snapshot (staggered) — tune both down for ambient/distant things. IMPLICIT DEFAULT: any entity with a script + rigidbody (and no `netObject`) replicates as `netObject: {}` automatically, so moving NPCs are multiplayer-correct with zero config. In multiplayer sessions the host simulates these; other tabs suspend their local copy and render interpolated ghosts. `authority: "owner"` is reserved (ownership assignment lands later).
- Bone attachment: parent an entity under a rigged model entity and give it `script: { name: "bone-socket", params: { bone, offset, rotationDeg } }`. The editor's "bones" toolbar toggle draws skeletons with bone names; the inspector's `bone` param is a dropdown of the rig's real bones.
- Scenes: multiple `assets/scenes/<name>.scene.json` files; the editor toolbar picks between them. Only the scene being edited live-syncs; creating a new scene file adds it to the picker.

Get the full machine-readable spec: `registry.jsonSchemas()`.

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
sees new values. Schemas for AI: `assets.dataTypeJsonSchemas()`.

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
`events.jsonSchemas()` is the AI-facing spec; the context bridge posts
`recentEvents` (last delivered `{ tick, name, payload }`) while playing. Minimal
example: `apps/playground/src/scripts/event-demo.ts`.

## Pitfalls

- `remove-entity` deletes the whole subtree — reparent children first if not intended.
- Colors are strict `#rrggbb` strings; `rotation` is a quaternion, not Euler.
- A failing op anywhere rejects the entire batch — build large batches
  confidently, but validate prop names against the prefab's declared props.
- Working example: `apps/playground/src/street-scene.ts`; runnable pipeline
  demo: `pnpm -F @hitreg/core demo`.
