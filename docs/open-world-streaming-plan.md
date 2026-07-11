# Open-World Streaming and HLOD Plan

**Status:** Proposed implementation plan  
**Scope:** Browser-first, low-poly/PS1-style large worlds  
**Primary workflow:** Files under `assets/`; no MCP dependency  
**Related decisions:** `ARCHITECTURE.md`, `VISION.md`, `docs/scene-authoring.md`

## 1. Outcome

HitReg should support large worlds where creators and AI author readable scenes,
chunks, prefabs, terrain, and materials while the engine automatically derives
runtime streaming representations.

The player must be able to see distant terrain and important destinations
without keeping the full world rendered, simulated, or networked. Generated
LODs, HLODs, impostors, collision, and navigation are caches, never authoring
truth.

The target experience is:

1. Build a world normally in the editor or by editing JSON files.
2. Partition spatial content into chunk files.
3. Edit chunks and prefab instances through one hierarchy.
4. See changes live while development bakes update in the background.
5. Publish with all required derived artifacts pre-generated.

## 2. Non-negotiable principles

- Files remain the primary AI interface. MCP may wrap capabilities later but
  cannot be required for authoring or baking.
- Scenes, chunks, prefabs, terrain, and data assets remain schema-validated.
- Human actions and AI edits converge on the same source documents.
- Generated assets live under a derived cache and are always regenerable.
- Simulation, rendering, networking, and authoring partitions are independent.
- Prefab instances stay collapsed in source files.
- Distant representations never contain authoritative gameplay state.
- Development generation must be asynchronous and must not stall the editor.
- Published games should ship pre-baked output when possible.

## 3. Source document ownership

### Experience manifest

Add `assets/experience.json` as the entry point for a game with multiple scenes.

```json
{
  "version": 1,
  "name": "Fantasy RPG",
  "startScene": "main-menu",
  "scenes": {
    "main-menu": { "file": "scenes/main-menu.scene.json" },
    "overworld": { "file": "scenes/overworld.scene.json" },
    "dungeon-caves": { "file": "scenes/dungeon-caves.scene.json" }
  }
}
```

The manifest is also the root used by publish-time dependency validation.

### Scenes

Scenes own non-spatial/global configuration and distinct runtime spaces:

- cameras, environment, post-processing, audio state;
- game/session managers and spawn definitions;
- scene transitions;
- the `chunkStreamer` for large exterior spaces;
- small spaces that do not require partitioning.

Interiors and dungeons may be separate scenes. Scene transitions reference a
scene ID and spawn ID, never an entity ID in another file.

### Chunks

Chunks own spatial source entities under:

```text
assets/chunks/<world>/<cx>_<cz>.chunk.json
```

Chunk transforms are local to the cell origin. Chunk files may contain prefab
instances. Cross-chunk parenting is forbidden. Stable GUID references across
chunks are allowed only through components designed for deferred resolution.

### Prefabs

Prefabs own repeated semantic structures. A chunk stores the placement and
instance overrides, not expanded prefab entities. Editing a prefab definition
must update instances in the active scene and all loaded chunks while retaining
valid overrides.

### Terrain

Editable terrain source lives under `assets/terrain/`. Heightfields and future
material-weight maps are source data. Coarse terrain tiles are derived data.

## 4. Runtime representation rings

Replace the current loaded/unloaded model with representation states:

```text
unloaded
  -> far proxy
  -> HLOD
  -> full render
  -> full simulation
```

The state transitions reverse as the focus moves away. Hysteresis prevents
rapid swapping near boundaries.

Proposed component shape:

```json
{
  "chunkStreamer": {
    "source": "overworld",
    "cellSize": 160,
    "rings": {
      "simulation": 2,
      "fullRender": 3,
      "hlod": 10,
      "farTerrain": 32
    },
    "keepPadding": 1
  }
}
```

Quality profiles may scale these distances without editing scene source.

### Near: full simulation

- Full render objects and collision.
- Active scripts, NPCs, animation, audio, and particles.
- Included in replication interest where applicable.

### Full render, no simulation

- Full visual representation.
- Gameplay scripts and dynamic physics are inactive.
- Static collision is optional based on distance and gameplay need.

### Mid: HLOD

- Static entities grouped into a small number of meshes.
- No scripts, dynamic physics, entity picking, or authoritative state.
- Important animated/dynamic objects use separate policies.

### Far: terrain and landmark proxies

- Coarse hierarchical terrain tiles.
- Explicit landmark proxies, silhouettes, billboards, or impostors.
- Atmosphere and fog hide the final cutoff.

## 5. Authoring chunks in the editor

### Virtual world hierarchy

Loaded chunks should appear as editable source documents:

```text
World: overworld
├── Chunk -1,0
│   ├── Highlands Terrain
│   └── Watchtower
├── Chunk 0,0
│   ├── Town Square
│   └── Fountain
└── Chunk 0,1
    └── Northern Forest
```

The hierarchy is a view over several documents. An edit routes to the owning
scene, prefab, or chunk file. Moving an entity across a cell boundary is an
atomic multi-document operation: remove from the old chunk, add to the new
chunk, and convert its transform to the destination cell's local space.

### Partition Scene command

Add an editor command that previews and partitions spatial scene entities:

1. Choose a target world name and cell size.
2. Classify entities as global or spatial.
3. Assign spatial entities by world-space origin.
4. Warn about large bounds crossing several cells.
5. Convert transforms to chunk-local coordinates.
6. Validate every output document.
7. Atomically write complete chunk files.
8. Add/configure the scene's `chunkStreamer`.

Default global classifications include cameras, sky/environment, postfx,
session managers, spawn configuration, and the chunk streamer. Large landmarks
may remain global or be explicitly assigned a home chunk.

## 6. Prefab editing and propagation

The editor must expose two distinct workflows:

- **Edit definition:** opens the prefab source; changes propagate everywhere.
- **Edit instance:** creates an override for one placement.

Required actions:

- select/open prefab definition;
- show overridden fields;
- apply override to definition;
- revert override;
- unpack instance;
- find loaded/source instances.

### Current gap

The main scene rebuilds on prefab/material asset changes, but loaded chunk groups
are retained by `ChunkManager.configure()`. Loaded chunk instances therefore
need explicit invalidation and rebuilding.

Implement dependency tracking per loaded chunk:

```text
chunk -> prefab IDs -> model IDs -> material IDs -> texture IDs
```

When an asset changes, rebuild only affected resident chunks. A simpler first
version may rebuild all loaded chunks, provided it is asynchronous and correct.

## 7. Automatic LOD and HLOD generation

### Model LODs

At import or background development time:

- inspect triangle count, material count, bounds, animation, and skinning;
- generate one to three simplification levels when beneficial;
- preserve UVs, normals, material boundaries, and skinning where supported;
- allow manual LOD replacement for hero assets;
- skip simplification when batching provides more value than fewer triangles.

For low-poly content, reducing draw calls is usually more important than
reducing triangle counts.

### Static chunk HLODs

For each chunk or HLOD supercell:

1. Expand prefab instances into a temporary build document.
2. Include only eligible static render entities.
3. Group by compatible material/shader state.
4. Transform geometry into supercell-local space.
5. Instance repeated geometry where appropriate.
6. Merge mixed static geometry where useful.
7. Optionally simplify the merged result.
8. Generate bounds and dependency metadata.
9. Store the result in the derived cache.

Authoring cells and HLOD supercells may have different sizes. For example,
sixteen 160m authoring cells may produce one 640m HLOD supercell.

### Terrain LOD pyramid

Generate coarse tiles by downsampling editable heightfields and material-weight
maps. Use stitched indices or skirts to prevent cracks where neighboring tiles
use different LODs. Terrain source edits invalidate the affected leaf plus its
ancestor tiles.

### Landmarks

Allow explicit intent on prefabs/entities:

```json
{
  "distantVisibility": {
    "enabled": true,
    "maxDistance": 3000,
    "proxy": "models/landmarks/castle-distant.glb"
  }
}
```

An automatic proxy may be generated when no manual proxy exists.

## 8. Derived cache and invalidation

Suggested development cache layout:

```text
.hitreg/cache/<experience>/
├── model-lod/
├── chunk-hlod/
├── terrain-lod/
├── impostors/
├── collision/
└── navmesh/
```

Each artifact key is a content hash of all relevant inputs:

```text
generator version
+ bake settings
+ source chunk
+ referenced prefab definitions
+ referenced models/materials/textures
= cache key
```

Generated outputs must never be committed as authoring truth. Publishing may
package derived artifacts into the distributable build.

## 9. Development versus published behavior

### Development

- Source changes apply immediately.
- Missing artifacts fall back to full entities or a coarse placeholder.
- Generation runs asynchronously, preferably in workers.
- Completed artifacts hot-swap into the live world.
- IndexedDB may cache generated browser artifacts, but project cache files are
  preferable where the dev bridge can create them.

### Published game

- Required artifacts are generated during publish.
- The browser downloads only representations needed for current distance rings.
- Runtime generation remains a fallback for procedural worlds or cache misses.

## 10. Multiplayer and persistence boundaries

- Chunk representation state is client-rendering state, not authoritative game
  state.
- The authority controls which simulation regions are active.
- Network interest management may use a different partition/radius from render
  streaming.
- Persistent world edits target creator/world source data through authorized
  services; ordinary session state does not rewrite chunk files.
- P2P hosts remain authoritative only for session state, per `ARCHITECTURE.md`.

## 11. Proposed implementation phases

### Phase A: Correct source editing

- Add virtual chunk hierarchy and source ownership metadata.
- Route chunk edits back to chunk files.
- Support cross-cell moves as atomic multi-file edits.
- Add loaded-chunk prefab/material invalidation.
- Add tests for IDs, transforms, validation, and hot replacement.

**Exit:** A creator can build and edit a multi-chunk world without manually
opening JSON files, while direct file edits still live-sync.

### Phase B: Multiple runtime scenes

- Add `experience.json` schema and loader.
- Add `SceneManager` with replace transitions.
- Add scene portal and spawn components.
- Guarantee teardown of chunks, scripts, physics, audio, particles, and network
  interest on transition.
- Add publish dependency validation across all scenes.

**Exit:** A game can move reliably among menu, overworld, interiors, and
dungeons while sharing prefabs and player data.

### Phase C: Representation state machine

- Replace binary chunk residency with simulation/full/HLOD/far states.
- Add hysteresis and quality-scaled distance rings.
- Keep current full chunk renderer as the near representation.
- Add diagnostics showing each cell's current state.

**Exit:** Distant cells no longer require full entity trees or disappear
immediately outside the simulation radius.

### Phase D: Terrain far field

- Generate terrain LOD pyramids from file-backed heightfields.
- Stream tiles by quadtree level.
- Add skirts/stitching and consistent material-weight downsampling.
- Track terrain bake dependencies.

**Exit:** Terrain and mountains remain visible to the horizon without loading
full-detail terrain everywhere.

### Phase E: Static HLOD generation

- Build worker-safe geometry extraction and grouping.
- Add instancing/merge decisions and optional simplification.
- Generate HLOD supercells and landmark proxies.
- Cache by content hash and hot-swap results.

**Exit:** Towns, forests, and landmarks remain visible at distance with bounded
draw calls and memory.

### Phase F: Publish pipeline and profiling

- Pre-bake all reachable artifacts from `experience.json`.
- Package an artifact manifest with hashes and byte sizes.
- Add streaming budgets per quality profile.
- Add editor overlays for residency, draw calls, triangles, memory, and bake
  invalidations.

**Exit:** Published low-poly open worlds load quickly and run predictably on the
target browser/device profiles.

## 12. Initial file touchpoints

Likely starting points in the current repository:

```text
packages/core/src/chunks.ts
packages/core/src/prefab.ts
packages/core/src/assets.ts
packages/core/src/terrain.ts
packages/editor/src/viewport.ts
packages/editor/src/overlay/App.tsx
apps/playground/src/chunk-manager.ts
apps/playground/src/main.ts
apps/playground/vite.config.ts
```

New packages/modules should be introduced only when ownership is clear. The
eventual bake pipeline belongs under `packages/assets`; runtime streaming logic
should migrate out of the playground once its interfaces stabilize.

## 13. Required tests

- Chunk-local/world transform round trips.
- Cross-cell move preserves world transform and stable entity ID.
- Invalid multi-file edits write nothing.
- Prefab definition edits update scene and loaded-chunk instances.
- Overrides survive definition changes.
- HLOD dependency hashes change for every relevant input.
- Representation transitions do not duplicate render or physics objects.
- Hysteresis prevents boundary thrashing.
- Terrain LOD edges do not crack across different levels.
- Scene replacement releases all owned runtime resources.
- Headless simulation never imports DOM or renderer code.

## 14. Claude handoff prompt

Use this prompt with the document:

> Read `CLAUDE.md`, `ARCHITECTURE.md`, `docs/scene-authoring.md`, and
> `docs/open-world-streaming-plan.md`. Implement Phase A only. Preserve all
> existing user changes and do not edit content under `apps/playground/assets/`.
> Keep files as the primary authoring interface; do not introduce an MCP
> dependency. Start by auditing the current chunk hot-swap and prefab rebuild
> paths, then add tests before changing behavior. Verify with `pnpm test` and
> `pnpm typecheck`. Report any architecture conflict before expanding scope.

Phase A is intentionally first: correct multi-document ownership and prefab
propagation are prerequisites for trustworthy HLOD baking and scene-scale
world authoring.
