# HitReg Engine — Architecture Decision Record

**Status:** Locked 2026-07-09. These are founding decisions; changing one later is surgery, so changes require a written amendment here.

An AI-native game engine on Three.js: every scene, asset, and setting is JSON data
that both humans (via Unity-style editor tools) and AI (via an ops protocol / MCP
server) manipulate through the same channel. Multiplayer-first, performance-first.

**Scope: 3D only.** No 2D mode, ever — it doubles every subsystem's surface area
and isn't the thesis. See VISION.md for the product thesis and phased roadmap
this engine serves.

---

## 1. Core decisions (locked)

| Area | Decision | Rejected alternatives |
|---|---|---|
| Rendering | Three.js `WebGPURenderer` + TSL node materials, auto WebGL2 fallback | WebGL2-only (TSL migration debt) |
| Core structure | Vanilla TypeScript engine core, zero framework deps | react-three-fiber (React-locked, can't run headless) |
| Editor UI | React overlay, dev-only mount, toggled with `~` | Tweakpane (too weak for hierarchy/asset browser) |
| Physics | Rapier (`@dimforge/rapier3d-compat`), deterministic config | cannon-es (slow, stale), Jolt (younger JS bindings) |
| Particles | three.quarks (GPU-instanced, native JSON serialization) — *amended 2026-07: custom instanced system (CPU sim + InstancedMesh + node materials) until three.quarks supports WebGPURenderer (it is WebGL ShaderMaterial-based; WebGPU is roadmap-only). The `particles` JSON schema is engine-owned either way, so swapping the backend later is non-breaking.* | custom GPGPU (later optimization, not v1) |
| Editor camera | `camera-controls` (yomotsu) | OrbitControls (no damping/dolly-to-cursor/fit) |
| Scripting | TS component classes + JSON-exposed params | JSON behavior graphs, eval'd script strings |
| Multiplayer | **Day one.** Server-authoritative, client prediction, lag compensation | single-player-first retrofit |
| Models | glTF only, KTX2 textures, meshopt compression | multi-format import chaos |
| Animation | AnimationMixer + JSON animator state machine component | — |
| Audio | Three positional audio as a component | howler (redundant) |

## 2. The data model — everything is a document

**JSON is the authoring format and source of truth. It is not the runtime format.**

- A **scene** is a JSON document: entities with stable GUIDs, each a bag of
  components (`transform`, `mesh`, `material`, `light`, `rigidbody`, `camera`,
  `particles`, `animator`, `audio`, `script`, `netIdentity`, ...).
- **Assets** (materials, prefabs, models, textures, quality profiles) live in
  separate JSON manifests, referenced by GUID. Prefabs support per-instance
  overrides, Unity-style.
- Every component type ships a **JSON Schema** (authored as Zod, schema exported).
  The schema is triple-duty:
  1. validates every mutation before it touches the scene (AI output included),
  2. auto-generates the inspector panel — no hand-written inspector UIs,
  3. is handed to the AI as the machine-readable spec of what it can build.
- At load, the JSON **compiles into ECS-style runtime storage** (typed arrays /
  component tables). Hot-loop code never touches JSON; the document layer and the
  sim layer are bridged by the ops protocol.

### The ops protocol

All mutations — editor gizmo drags, inspector edits, AI tool calls, undo/redo —
are expressed as small operations, never whole-file rewrites:

```
add-entity | remove-entity | reparent | set-component | remove-component
| set-asset | patch (RFC-6902 style path edits)
```

This buys us: undo/redo, diffing, live hot-reload of a running scene, multi-writer
safety (user drags a gizmo while AI edits materials), and an audit trail.

### Prefabs — React-style composition

A prefab is a component *definition*: an entity subtree plus declared **props**
(named, defaulted, bound via paths to fields inside the tree). An instance is
one entity carrying a `prefab` component — `{ prefabId, props, overrides }` —
the JSX usage site. Prefabs nest (composition); editing a definition propagates
to all instances minus their overrides (reconciliation at edit time).

- **Overrides** are path patches on the instance (Unity-style), surviving
  definition edits.
- **Collapsed document rule:** scene docs store instances *unexpanded* — forty
  streetlights are forty one-liners, not forty subtrees. Expansion happens at
  compile time into ECS storage, never in the source doc. This is both a
  token-budget and AI-legibility guarantee.
- Variants (a prefab extending a prefab with preset overrides) come later on
  the same machinery.

### Data assets — ScriptableObjects, but JSON

Standalone schema-defined JSON documents with GUIDs (`WeaponStats`,
`EnemyWaveTable`, `LootTable`), referenced from components, scripts, and prefab
props. Registered exactly like components (Zod schema → validation +
auto-inspector + JSON Schema for the AI). Shared-reference semantics: everything
pointing at the same GUID sees edits immediately.

### AI integration — the AI's primary sense is data, not pixels

**Founding principle:** a traditional engine is opaque to AI — it must squint at
screenshots. This engine's running state *is* structured text. The AI reads the
world; screenshots are the fallback sense (aesthetic judgment), never the primary
one. Every subsystem must keep its state legible as data.

Three consequences:

1. **Semantic queries, not document dumps.** The engine answers questions:
   spatial queries ("entities within 5m of the player", "what's under this
   screen point"), component queries, hierarchy summaries, and diff streams
   ("what changed in the last N seconds"). The world is a queryable database.
2. **Selection-as-context and view-as-context.** When the user selects an
   entity and talks to the AI, the tool call carries the entity's GUID, full
   component JSON, prefab lineage, and spatial surroundings. When nothing is
   selected, the *view* is the context: camera pose plus frustum-visible
   entities ranked by screen coverage and proximity to view center. "Move this
   cliff" resolves because a large mesh named `Cliff_02` dominates the center
   of the viewport. The editor's select tool and the AI's attention are the
   same mechanism.
3. **Standard interaction vocabulary.** The engine ships a curated library of
   behavior components — `pickable`, `trigger-zone`, `door`, `damageable`,
   `collectible`, `spawner`, `platform-mover`, ... — so most requests ("player
   can pick this up") resolve to a schema-validated *data op* (attach component,
   tune params): instant, undoable, can't break the build. New TS scripts are
   the escape hatch for what the vocabulary lacks; good escape hatches graduate
   into the vocabulary.

**The primary AI channel is files, not a protocol** (amended 2026-07-09, per
Derek): scenes/prefabs/materials are JSON files under `assets/`; a
Claude-Code-style agent edits them with its native tools and the dev server
**live-syncs changes into the running scene in place** (fs.watch → websocket →
schema-validated `store.replace`/asset update — bad edits rejected, no page
reload). This is the cheapest possible AI context: files.

What files can't carry is **runtime context** — that's the dev server's
context bridge: `GET /__hitreg/context` returns `{ scene, playMode, selection
(id + full entity JSON), camera pose, inView entities ranked by distance }`,
posted continuously by the running app. AI uses it to resolve "this / the
cliff I'm looking at" before editing files.

An **MCP server** remains a thin later veneer over the same bridge for AI
clients that aren't file-native (in-editor chat panel, claude.ai, phones):
`query_scene`, `apply_ops`, `get_view_context`, `screenshot`, `play_pause`.
Same data, different transport — never a separate capability surface.

### Latency — the AI loop must never feel slower than typing

Motivating scar tissue: driving Unity via MCP grinds to a halt — every script
edit is a 10–30s domain reload, every action a chatty RPC, every capability a
discovery round trip. Hard budgets, enforced from day one:

- **Data op batch: < 50 ms** applied to the live scene. No compile step exists
  in the data path.
- **Script hot-reload: < 1 s** (Vite HMR; scripts are modules, no bundler-wide
  rebuild).
- **One request ≈ one round trip.** Ops batch; "build a courtyard" is a single
  `apply_ops` call. Schemas are handed to the AI up front — no discovery phase.
- **Queries return summaries, not dumps.** Compact, ranked, token-budgeted
  responses; the AI drills down only where needed.

Any feature that would put a stall in this loop (sync asset imports, blocking
validation passes, editor-side recompiles) must be redesigned or made async.

## 2b. Creator tooling (JSON-driven, browser-based, AI-drivable)

Beyond the core editor panels, the roadmap includes — each as a document type
in the same schema/ops system, each with a visual editor view:

- **Behavior state machines** — NPC patterns (patrol → chase → attack) as a
  JSON graph with a node-graph editor view; the animator state machine reuses
  the same graph infrastructure.
- **Dialogue trees** — nodes, choices, conditions as JSON; drives a standard
  `dialogue` interaction component.
- **Localization** — string-table assets keyed by locale; all user-facing
  strings in scene/UI docs are key references.
- **Asset viewer** — inspect a model/material/animation in isolation
  (turntable, skeleton overlay for rigged models, animation scrubber).
- **Lighting & grading** — lights are already components; color grading and
  tonemapping live in the JSON post-processing stack asset.

These are Phase 2+ builds, but their shared substrate (graph documents, string
tables, the asset viewer shell) is designed into `core`'s document model now.

## 3. Multiplayer architecture (day one)

- **Server-authoritative simulation.** The engine core runs headless in Node —
  no renderer, same sim code. This is why the core has zero DOM/React deps.
- **Fixed-timestep sim** (default 60 Hz) fully decoupled from render; render
  interpolates between sim states.
- **Input as commands**: clients send timestamped input commands, never state.
- **Client-side prediction + server reconciliation** for the local player.
- **Snapshot interpolation** for remote entities; snapshots are binary
  delta-encoded against the ECS tables (this is why runtime state is typed
  arrays, not JSON).
- **Lag compensation for hit registration**: server keeps a ring buffer of
  historical hitbox states and rewinds to the shooter's perceived time on
  hit validation.
- **Deterministic Rapier config** so client prediction replays match the server.
- **Transport**: WebTransport (unreliable datagrams) where available,
  WebSocket fallback. `netIdentity` component marks replicated entities and
  their sync policy (owner, interpolated, static).

### 3a. Layered so P2P is replaceable (amended 2026-07-10, per Derek)

The decisions above stand; what this amendment adds is that **where the
authority runs is a deployment choice, not an engine assumption**. Three
independent layers:

```
game simulation (fixed-step, headless-capable)
  ↓ input commands up / snapshots down
replication protocol (rooms, membership, seq/dedup, interest mgmt)
  ↓ two channels: reliable-ordered | unreliable-sequenced
transport (swappable adapters behind one interface)
  ├── loopback            single-player + tests (zero network)
  ├── WebRTC DataChannel  P2P rooms — the initial multiplayer mode
  ├── WebSocket           universal fallback
  └── WebTransport        dedicated authoritative servers
```

- The simulation never knows which transport carries its packets; the
  replication layer addresses "the authority" and "peers", never sockets.
- **P2P host mode** (prototypes, private worlds, low stakes): one player's tab
  runs the *same authoritative sim* a dedicated server would. Clients send
  input commands (intentions), never outcomes. The platform backend does
  matchmaking + signaling (in dev, the vite bridge is the signaling relay);
  TURN relays NAT-blocked peers. Rooms emit transferable snapshots (host
  migration; later, promotion to server hosting with zero game changes).
- **Trust boundary (hard rule):** a P2P host is authoritative over SESSION
  state only. Nothing valuable or persistent — platform currency, cosmetics,
  marketplace items, ranks, entitlements, cross-game inventory — is ever
  awarded on a peer's authority; those mutations go through the platform
  persistence service (server-side authority, §3c) or not at all.
- **Own room protocol, not Colyseus:** schema-based sync layers would sit
  exactly where our binary-delta-against-ECS-tables snapshots live and
  duplicate them. We borrow the shape (rooms, matchmaking-as-a-service),
  not the dependency.
- **Interpolation + prediction are baseline, not optional (2026-07-10, per
  Derek):** remote motion renders through snapshot interpolation buffers
  (~2 ticks behind, capped extrapolation — `TransformInterpolator` /
  `InterpolationClock` in @hitreg/net); the local player is client-side
  predicted (the local controller runs ahead) and reconciled against the
  authority's snapshot with dead-band / soft-nudge / hard-snap thresholds.
  Movement commands carry intent (desired velocity + jump) that the host
  clamps and applies to a per-peer physics proxy — never claimed transforms.
  Host-simulated entities (script+rigidbody NPCs) are suspended on peers and
  ghosted from snapshots.
- **Replication is declarative, per-entity (2026-07-10, per Derek):** the
  `netObject` component (schema-validated like everything else) is the
  engine's NetworkObject — authority, what-to-sync, relevancy, cadence.
  Interest management is a first-class policy: `relevancy: "proximity"`
  entities transmit on a need-to-know basis (per-peer snapshot views with
  enter/leave hysteresis — `computeView` in @hitreg/net), and `sendEvery`
  trades freshness for bandwidth per entity (phase-staggered). Entities
  with script+rigidbody replicate by implicit default so zero-config scenes
  are multiplayer-correct; the component tunes or opts out.
- **Dev relay fallback (2026-07-10):** environments that block WebRTC UDP
  (privacy extensions/shields) get a Transport over the dev signaling relay
  itself; the host listens on RTC + relay simultaneously (`mergeTransports`).
  Dev-only — production peers use WebRTC or a real edge.

### 3c. Persistence taxonomy (added 2026-07-10, per Derek)

Four data categories with four different owners — formalized now so game code
and platform code never blur:

1. **Platform/meta** — account, avatar prefab, friends/blocks, entitlements,
   platform currency, moderation status, cross-game achievements. Platform-
   owned; **no individual game gets direct write access**.
2. **Experience player data** — namespaced by `(playerId, experienceId,
   namespace)` with `schemaVersion` + `revision` (optimistic concurrency) +
   `updatedAt`: saves, inventory, quest state, per-game settings.
3. **Creator/project data** — projects, scenes, assets, prefabs, scripts,
   published versions, collaborators, permissions, AI change history,
   rollback snapshots.
4. **Session data** — transforms, projectiles, match score, physics state:
   dies with the room unless the game **explicitly commits** selected results
   into category 2.

**Games never see a database.** They get a constrained persistence service —
`playerData.get / set / increment / transaction / keys` — that enforces
experience ownership, player identity, size quotas, rate limits, schema
validation, atomic revisions, server authority, and audit logging. This is
the API the AI codes against ("save the player's collected pets between
sessions") without ever creating tables, auth middleware, or migrations.
The engine ships the service interface + a dev backend (vite bridge, files
under `.hitreg/`) now; the platform backend implements the same contract in
Phase 3. Browser storage (IndexedDB) is cache/drafts/offline only — never
authoritative for published player data.

## 3b. Physics data model (designed now, implemented with the Rapier package)

- `rigidbody` — `{ kind: dynamic|kinematic|static, mass, linearDamping, angularDamping, ccd }`
- `collider` — `{ shape: box|sphere|capsule|cylinder|convex|trimesh, size, offset, friction, restitution, isTrigger }`
  (convex/trimesh reference baked collision data from the asset pipeline)
- `joint` — `{ kind: fixed|hinge|slider|ball, target: entityId, anchorA, anchorB, axis, limits?: {min,max}, motor?: {targetVelocity, maxForce} }`

Hinged doors, seesaws, vehicles, ragdolls — all pure data, so the AI, the
inspector, and (later) viewport joint gizmos author the exact same thing.

## 4. Editor — the overlay, not a separate app

**Tool parity is law: one control surface.** Every engine capability is exposed
as data (components + ops) first. The AI's `apply_ops`, the inspector's fields,
and the viewport's gizmos are different frontends emitting into the same ops
channel — anything the AI can do, the user can do in the editor, and vice
versa, structurally (not by discipline). A feature that can't be expressed as
ops on data isn't done. UI affordances are views over ops, never private
channels.

Next.js-devtools-style: press `~` in the running dev game and the editor mounts
*over* the live scene. Pause, free-fly (`camera-controls`), and edit:

- **Hierarchy panel** — entity tree, drag-reparent.
- **Inspector** — auto-generated from component schemas.
- **Asset browser** — manifests, drag into scene.
- **Viewport gizmos** — Three `TransformControls` (move/rotate/scale) with
  grid/angle snapping; click-to-select with raycast + selection outline.
- **Ops console** — the AI/undo history stream, inspectable.

Every editor action emits ops → writes back to the JSON on disk (dev server does
the file I/O). The overlay is tree-shaken out of production builds.

- **Editor settings** (snap on/off, translate/rotate/scale snap steps, grid
  visibility + size) are editor-local state, not scene data.
- **Play mode** (`edit | playing | paused`): the document is authoring truth
  and is never mutated by simulation. Sim mutates runtime state only; **stop
  rebuilds from the document**, restoring the authored scene. Edits during
  play apply to the doc and re-sync the runtime.
- **Assets folder convention**: project content lives in `assets/`
  (`prefabs/*.json`, `materials/*.json`, `models/*.glb|gltf`, later `scenes/`,
  `data/`). The playground globs these at dev time; the asset pipeline CLI
  formalizes import/baking later. Dropping a GLB into `assets/models/` makes
  it appear in the editor's Assets panel, instantiable as a `mesh` component
  with `source: { kind: "asset", assetId }`.
- **Editor-created assets persist to disk** via the dev server's
  `/__hitreg/write-asset` endpoint (path-sandboxed to `assets/`): new
  materials, prefabs-from-selection, and asset edits become real files.
  Assets are selectable in the Assets panel and edit in the same Inspector
  (materials: PBR params with live scene updates; prefabs: definition edits
  propagate to instances). Script assets arrive with the scripting runtime;
  rendered thumbnails with the asset viewer.
- **Graybox kit** (ProBuilder-lite): one-click floor/wall/platform/pillar/ramp
  (wedge primitive)/stairs — plain entities, so they rescale, snap, and prefab
  like anything else. Real mesh editing (face extrude, vertex tweaks, CSG
  booleans via three-bvh-csg) is roadmap.
- **Material shaders v1**: `shader: standard | unlit | toon | wireframe` on the
  material asset — a built-in set as pure data. Custom shaders remain the TSL
  node-graph-as-JSON bet (§1); this enum is the forward-compatible stopgap.
- **Color editing**: every hex field renders a picker with a persistent saved
  swatch palette (editor-local, localStorage).
- **Tweening (planned, with the scripting package)**: a small engine-owned
  tween system stepped from `fixedUpdate` (never rAF-driven — netcode) plus a
  serializable `tween` component (target path, from/to, duration, easing,
  loop). Data-driven so AI and inspector author it like everything else; no
  external tween lib (GSAP et al. are DOM-centric and not fixed-step friendly).

## 5. Scripting model

Gameplay logic is TypeScript classes with lifecycle hooks:

```ts
class Turret extends ScriptComponent {
  @param({ min: 0, max: 50 }) range = 20;   // JSON-exposed, inspector-editable
  @param() fireRate = 2;
  onStart() {}
  onFixedUpdate(dt: number) {}               // sim-side, runs on server too
  onUpdate(dt: number) {}                    // render-side only
  onCollision(other: Entity) {}
}
```

- All tuning values are `@param` — serialized in the entity JSON, editable in the
  inspector, tunable by AI without touching code.
- AI writes/edits the TS for behavior, JSON for data. Scripts are modules
  referenced by GUID in the script registry.
- `onFixedUpdate` is the only place gameplay state may change (netcode requirement).

## 6. Performance primitives (built-in, not bolted on)

- **Pooling is an engine primitive.** Prefabs declare `pool: { size, prewarm }`;
  spawn/despawn recycles. Internal pools for particles, audio sources, temp
  math objects. No allocation in the hot loop — enforced by lint rule.
- **Instancing declared in data**: `renderMode: "instanced"` on a prefab
  collapses instances into one `InstancedMesh`; `BatchedMesh` for
  mixed-geometry static batching.
- **LOD generated, not authored**: meshoptimizer simplification at asset-import
  time builds LOD chains automatically; distances/bias tunable in JSON.
- **Quality profiles as JSON assets**: shadow res, LOD bias, particle caps,
  render scale — switchable at runtime, AI-tunable ("make this run on a laptop").
- **Asset pipeline CLI**: glTF in → meshopt + KTX2 + LOD chain + manifest entry out.

### Baking (build-time optimization)

Bakes are **derived cache artifacts, never source** — always regenerable from
the JSON docs, invalidated by content hash, safe to delete.

- **Import-time** (per asset): LOD chain generation, meshopt/KTX2 compression,
  collision cooking (convex hulls / trimesh precomputed for Rapier).
- **Publish-time** (per scene): static geometry merge/batch for entities marked
  `static: true`, navmesh baking (recast-navigation — WASM, runs in browser
  and Node), texture atlasing.
- **Later**: lightmap baking (no mature Three.js baker exists; v1 ships
  real-time shadows + AO and treats baked GI as a Phase 2+ upgrade).

### On ECS/DOTS in the browser

The typed-array component tables above ARE the DOTS bet, browser-sized:
struct-of-arrays TypedArray storage gives DOTS-style cache-friendly iteration.
No Burst/job system exists on the web; the substitutes are WebGPU compute
(particles, skinning, mass animation) and WASM for hot kernels (Rapier already
is one). SharedArrayBuffer + workers is available for specific systems later
(requires cross-origin isolation headers) but is not a foundation dependency.

## 7. Package layout (pnpm monorepo)

```
packages/
  core/      ECS, scene document, ops protocol, schemas, fixed-timestep loop, math
  render/    Three.js WebGPU adapter: mesh/light/camera/particle systems
  physics/   Rapier integration (shared by client + headless server)
  net/       transport, snapshots, prediction, lag compensation
  scripting/ ScriptComponent runtime, @param decorator, script registry
  editor/    React overlay (dev-only)
  mcp/       MCP server exposing the running engine to AI
  assets/    import pipeline CLI (gltf-transform, meshoptimizer, KTX2)
  server/    headless Node game server runtime
apps/
  playground/  dev sandbox game used to exercise everything
```

Tooling: Vite (dev/playground), tsup (package builds), Vitest, TypeScript strict.

## 8. Build order

1. `core` — scene document, schemas, ops protocol, ECS storage, fixed-timestep loop
2. `render` — load a JSON scene, draw it (WebGPU, fallback verified)
3. `editor` — overlay with hierarchy/inspector/gizmos emitting ops
4. `mcp` — AI can query + mutate the live scene (the product's point — early!)
5. `physics` — Rapier, deterministic config, collision events to scripts
6. `scripting` — lifecycle, @param, playground game loop
7. `net` — headless server, prediction, snapshots, lag-compensated hit reg
8. `assets` + perf pass — pipeline CLI, pooling enforcement, LOD, instancing
