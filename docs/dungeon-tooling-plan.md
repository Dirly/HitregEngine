# Dungeon tooling — development plan

**Status:** Wave 1 in progress. **Read first:** this plan is judgment and
sequencing; exact APIs live in the Zod schemas (`spec.json`) once each piece
lands, per AGENTS.md → "Extending the engine".

## Thesis (what three generated dungeons taught us)

Agents produced *clean* small dungeons when construction was butt-jointed,
grid-snapped, and every placement went through the placement solver + linter
(the `agent-dungeon` runs: zero visible z-fighting). The overlap-everything
construction style produced *scale* but leaked visual defects the seal
verifier cannot see (z-fights between coincident faces, floating decor placed
against tile assumptions, water sheets with unsupported edges). Conclusion:

- **Structure must be machine-exact** — one compiler owns every coordinate,
  every shared wall plane is emitted exactly once, joints butt.
- **Organic character is layered on top by passes that cannot break the
  seal** — surface weathering (boundary-pinned vertex displacement), grime
  tints, ruin operators that swap sealed pieces for sealed ruined assemblies,
  and vignette-based prop dressing.
- **Every prop placement raycasts real geometry** (`snapPlacementOps`) —
  never assumptions about what a tile "should" contain.
- **Verification needs eyes**: lint + seal checks + screenshots (the luma
  meter and per-finding camera shots), because "sealed" and "looks right"
  are different properties.
- **Natural + man-made mixing** (the EQ/WoW look) is a first-class goal:
  worked-stone vocabulary and cave vocabulary with authored transition
  assemblies, not one style throughout.

## Surface: the editor tools section

Each capability ships in two layers:

1. **Core functions** in `@hitreg/core` — pure, headless, deterministic
   (seeded), producing ops batches. Schemas carry the documentation.
2. **Installed tools** under `tools/<name>/` (a `tool.json` manifest +
   `run(context, inputs)` entry) so they appear in the editor's tools
   section and in `/__hitreg/spec` — these are project-facing knobs, per
   Derek's direction, following the `hitreg.armor-atlas` pattern.

## Texture/theme flow (Derek + image generation)

Derek supplies base texture families (stone, brick, wood, metal, rock, …).
Per dungeon location, a stylized image-generation pass remixes them into a
variant set dropped under `assets/textures/<theme>/`. A **theme data asset**
maps role slots (floor/wall/ceiling/trim/accent/rock/wood/metal/water) to
those textures with metres-per-tile UV scales; the compiler and dressing
passes consume slots, never raw material ids — so one plan re-skins per
location.

Two texture layers, different jobs:

- **Tiling base** (the theme slots above) — broad surface identity. Perfect
  repetition is the tell; it never carries local detail.
- **Decals** — projected "stickers" (cracks, moss patches, drips, scorch,
  carved runes, posters/banners of grime) placed at specific world points to
  break the tiling and tell local stories. Intent lives in the doc (a
  schema-validated `decal` component: texture, size, rotation, projection
  direction); the renderer projects it onto whatever geometry is behind it
  (three's DecalGeometry — clipped, fitted, z-offset) at build time, so the
  JSON stays truth and nothing hand-authors fitted geometry. Placement rides
  the existing solver (a decal is a wall/floor/ceiling snap with a normal),
  which means the scatter pass can scatter decals with the same wall-bias
  and seeded determinism as props, and grime rules can EMIT decal
  placements (soot decal above every torch) instead of only tints.

**Texture intake tool** (`tools/texture-intake/`): the on-ramp for
generated art — takes raw image-gen PNGs, optionally makes them seamlessly
tileable (offset-and-blend), derives a light normal map from luma for the
stylized look, writes the texture family under `assets/textures/<theme>/`,
and updates/creates the theme data asset (via `themeFromTextureFolder`).
Same pattern as `hitreg.armor-atlas`.

## Waves

### Wave 1 — foundations (parallel subagents, disjoint files)

| Workstream | Files (packages/core/src/) | Delivers |
|---|---|---|
| Structure compiler | `structure/plan.ts`, `structure/compile.ts` | plan.json schema (rooms rect/polygon/round, elevations, doors, stairs, corridors) → ops; butt-jointed, single-owner walls, SEAM de-fight; **gate: `lintPlacement` = 0 on output** |
| Weathering + grime | `poly-mesh/weather.ts`, `poly-mesh/tint.ts` | boundary-pinned face displacement ("quarried, not printed"); grime painters (soot/moss/stain/wear) as face tints |
| Scatter + water | `scatter.ts`, `water.ts` | Poisson scatter through the placement solver, wall-bias, vignette support; contained water volumes + `lintWater` ("levitating water" is an ERROR) |
| Themes | `theme.ts` | theme data-asset schema + material-set generation from a texture folder + `uvScaleFor(slot)` |

Integration (main session): index exports, `pnpm spec`, component/asset-type
registration, cross-wiring compiler↔theme↔scatter, first end-to-end room.

### Wave 2 — the gate and the tools surface

- `dungeon verify`: placement lint (upgraded: rotated-pair OBB coincidence,
  cross-material coincidence = ERROR / same-material = WARN) + voxel seal
  flood + water containment + **screenshot contact sheet** (every finding's
  world point photographed via the headless browser; luma-checked poses per
  room). Agents iterate against pictures.
- `tools/dungeon-compile/`, `tools/dungeon-scatter/`, `tools/dungeon-verify/`,
  `tools/theme-apply/`, `tools/texture-intake/` manifests — the editor-facing
  knobs.
- **Decal system**: `decal` component schema in core (texture id, size,
  rotation, max projection depth) + render-side projection via
  DecalGeometry in `@hitreg/render`'s buildScene/reconcile path; decal
  entries in scatter tables; grime rules gain a decal-emitting mode.

### Wave 3 — organic character

- Ruin operators (collapse-wall→rubble+cavity, crack-floor, fell-column) as
  sealed-assembly swaps; physics-settle bake (headless Rapier drop → rest
  pose ops) for tumbled debris.
- Cave vocabulary (displaced poly tunnels/chambers) + authored transition
  assemblies (worked stone breached into cave) invocable from plans.
- Vignette library conventions (Derek's props composed into small authored
  scenes with placement metadata; scatter places vignettes, not just props).

### Wave 4 — generation at scale

- Plan generators (WFC or graph grammar) that emit *plans*, not geometry —
  one geometry pipeline for everything.
- Bake-off: regenerate an EQ-scale dungeon on the new stack; diff against
  the three run-1/2/3 dungeons on lint findings, verifier errors, luma, and
  eyeballs.

## Non-negotiables for every piece

- Ops batches only; schemas + `.describe()` carry the facts; `pnpm spec`
  after registration (main session runs it — not parallel agents).
- Deterministic: seeded RNG everywhere, never `Math.random`.
- Headless: zero DOM in core; tests in `packages/core/test/`.
- The placement solver is the only way anything touches a surface.
