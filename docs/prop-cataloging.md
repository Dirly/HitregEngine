# Prop intake and catalog gate

Every additional reusable prop must go through catalog intake **before live
installation**, regardless of agent or source. This includes purchased imports,
user-made models, generated props, extracted parts, retextures, damaged variants,
vegetation and effect-bearing prefab assemblies. Updating an existing prop also
updates its record and invalidates reviews of changed bytes. Do not rely on chat
history or a loose asset directory as the catalog.

## Required process

1. Search the project's registered catalogs before importing or rebuilding.
   Preserve original source files and identify the source pack/object or generation
   recipe, source hashes and any supplied usage restrictions. Give each reusable
   output a stable ID, meaningful category/role and parent/source relationship.
2. Break useful reusable parts out with their UVs and material roles intact.
   Record dimensions in metres **and the coordinate frame**, pivot/foot anchor,
   parts, UV sets, triangle/material counts, textures/atlas roles, alpha settings,
   sampling and intended world texel density. Record missing work explicitly.
3. Describe the intended placement asset: raw model for static geometry, or a
   prefab preserving collision, attachment points, effects, lights, audio and
   behavior. Record collision, LOD and instancing choices, including explicit
   none/not-applicable choices. Do not infer readiness from successful extraction.
4. Declare where it may go. Every catalogued prefab gets a `dressing`
   declaration (the component's schema in the spec is the field reference) or an
   exemption, in its collection's `dressing` sidecar; `props sync` compiles it onto
   the prefab root, so regenerating a kit and re-running sync restores it. Start
   from `props suggest <id>` (measured size, origin, shelf boards and table tops
   with their clear heights) and decide the rest by looking at the model
   (`props proof <id>`), never from its name. Judgment rules:
   - **One mount per prefab.** A paper lying on a desk and the same paper pinned
     to a wall are two prefabs, because the mesh pose differs.
   - **The mesh must agree with the declaration.** If the pose makes the right
     mount impossible (an upright "flat" sheet, a cabinet whose front faces +/-X,
     a pivot off the bounds), exempt it with a reason starting `BLOCKED:` that
     says what re-pose it needs; do not declare something the mesh contradicts.
   - **Parts are not props.** A loose drawer, a chain link or a lid is `part` (or
     `slot` when a catalogued host provides a matching slot); the furniture it
     belongs to declares the slot.
   - **Exempt** only what no dressing plan will ever place: scatter vegetation,
     terrain pieces, building shells, structural timber, deprecated variants.
     Whole collections of such outputs use the index's `dressingExempt` reason.
   - Furniture that must back onto a wall says so; flames carrying fire VFX are
     `fire`; graves and street furniture are `outdoor`; rugs are not solid.
   - **Whose is it, and at what size.** Every prop declares `scale` (any, tiny,
     small, human, large, giant: judged beside the figure in `props proof`; a
     rock, a bone or a plain fire is `any`) and `cultures` (the peoples who would
     make or use it: civic, rural, bandit, crypt, giant, ratkin, anansi ... or
     `any`). Both lists are data (`DRESSING_VOCABULARY` plus the project's
     `authoring/dressing/vocabulary.json`): a new people adds its entry there.
     A place that declares its scale/culture refuses anything else, so a hand
     lantern is never giant furniture. Mark `centrepiece: true` only on what
     belongs in a room's middle (a hall bonfire, an altar, a fountain).
     `props status` lists UNTAGGED props.
   Then `props status` must print no STALE/MISSING, and `props index` refreshes the
   menu that placing agents read (`props menu --room <role>`).
   **Texel density is measured at intake, not guessed.** `props measure` and
   `props status` read it from the prop's UVs and the texture it actually samples;
   the project's standard (`texelDensity` in `authoring/prop-catalogs.json`) is the
   town's, because pixels of two sizes side by side read as two art styles. A LOW
   prop is reskinned before it dresses a town, by the cheapest route that is honest
   (`props reskin-plan` proposes one): re-pack from the source art when the kit
   merely downscaled it; lay a town material role over its own colours when it is
   plain wood or stone, since that also matches the town's grain; generate new art
   only for painted or mixed surfaces, grouped onto as few pages as possible. A UV
   layout that stacks islands or shrinks them to a few texels cannot carry new art:
   re-unwrap first. Keep the kit one page and one material whatever the route.
5. For fire props, keep ember geometry/material separate from the ordinary atlas.
   Retain the engine ember material and linked fire VFX in the prefab. Catalog the
   effect IDs and attachment positions, along with lit/unlit variants. A purchased
   torch mesh alone is not a working torch. Verify chains and hanging parts have
   usable attachment/repetition instructions. Check other special behavior too.
6. Update the owning catalog/export manifest in the same change as the assets.
   Keep detailed measurements in linked manifests rather than copying conflicting
   facts between catalogs. Register any new collection in
   `authoring/prop-catalogs.json`; do not create an undiscoverable parallel catalog.
   Preserve draft/experimental/deprecated status and document known limitations.
7. Run the owning importer's schema/geometry checks and the coverage command below
   for **every new or changed reusable runtime output**. Internal meshes covered
   by a catalogued prefab can be checked through that prefab; independently
   reusable parts need their own records. Review rendered scale, texels, shading,
   collision, supported effects and LOD. For scatter/bulk use, compare performance
   against the previous assets at the same view and population.
8. Only install after those gates pass for the intended use. Save hashes, replay
   scripts, inverse scene ops and review evidence in the project. An explicitly
   requested in-world experiment must still be catalogued and labelled provisional;
   it must not silently become the approved default asset.

### Lit fixtures (flames and lights you tune in one place)

A lit variant is a WRAPPER, never an edit of the art prefab: `fixtures/<prop>-lit` nests
the kit's unlit prefab unchanged (a kit regeneration cannot lose the flame) and adds
`fixtures/looks/candle-flame` at each measured wick plus ONE light look, however many
flames. The look prefabs hold the knobs as prefab props, so one edit retunes every placed
copy: `looks/candle-flame` (flame size = which `env/fire-*-flame` effect, colour = its
material), `looks/candle-glow`, `chandelier-glow`, `lamp-glow`, `sconce-glow` (light
colour, intensity, range, budget priority; shadows always off), and `fixtures/hearth-fire`'s
own props for every hearth (fire size, ember bed, light, crackle). Flame effects in
fixtures carry no `light` module; the light is the look's `light` component. Each wrapper
gets its twin's `dressing` declaration plus `fire: true` in `authoring/fixtures/dressing.json`;
`authoring/fixtures/build.mjs` rebuilds wrappers and keeps existing looks. A building's own
hearth, sconce or lantern takes a mesh-less fixture placed by `dress fixtures` on the anchors
its `.markers.json` produced.

## Reuse first: wrap, variant, compose

A builder who needs a prop the menu lacks makes it from what exists, in this order, with `props.mts`
(`tools/_prop-make.mts`). Each command writes a new prefab in a NEW collection, a catalog row that records its
source, a draft declaration (kept if one exists; its measured size is refreshed) and registers the collection
(`shared: true`), then syncs. It never edits the source prefab, model, texture or a scene. Review the draft with
`props status --catalog authoring/<collection>/catalog.json` and `props proof <id>`, then `props index`.

1. **Search.** `props menu --search <word>` lists what the menu offers for a word (family synonyms included:
   barrel finds casks and kegs) and what exists but is not offered (blocked, exempt, site-fitted) with the wrapper
   to use instead.
2. **Wrap** a prop that must be placed bigger, turned, tilted or re-seated:
   `props wrap <source> --id <coll/name> [--scale s] [--yaw deg] [--pitch deg] [--roll deg] [--decl '<json>']`.
   The wrapper nests the source unchanged and moves it so the wrapper's origin is the bottom centre of its
   bounds (an off-centre pivot or sunk posts are fixed this way). The declaration is the source's own with size and
   sockets carried through the scale and yaw; for a BLOCKED source pass the fields with `--decl`. The raw prop is
   then exempted with a reason ending `use <wrapper id>`. Current wrappers: `camp-props/tent` and `tarp-shelter`
   x1.5 (owner ruling), `banner` x1.5 turned to +Z, `produce-rack` x1.25 turned to +Z, `fallen-cage` and `lean-to`
   re-seated, `posed-props/bookshelf-narrow` and `sideboard` turned to +Z with their boards/top, `ruin-props/boulder`
   re-seated, and the DC columns toppled, leaning and heaved (`ruin-props/column-toppled`, `column-leaning`,
   `pier-heaved`). Hand-scaled instances already in a scene are left as they are.
   A tilt is limited by the foot rule: the lowest point of the bounds is the ground, so the far edge of a tilted
   base lifts (keep a column within about 4 degrees, or compose it with something that buries the base).
3. **Variant**: the same model(s) with another material or new art, no new geometry:
   `props variant <source> --id <coll/name> --material <id> | --art <png> [--part <entity,...>] [--triplanar <m per tile>]`.
   `--part` re-skins only named mesh entities (the roof of a lean-to). `--art` installs the PNG under
   `textures/<coll>/` and derives the material from the replaced part's own (emissive lift and roughness kept, maps
   swapped, alpha cut-out when the PNG has alpha). Over a model whose UVs are an atlas layout, add
   `--triplanar <metres per tile>` so tiling art is projected in metres (128 px over 3.2 m = the 40 texels/m
   standard; `props status` measures a triplanar material as width / metres). Painted art on an atlas kit prop is
   a `props reskin`, not a variant. Examples: `variant-props/silk-pile` (`poi-props/bone-pile` with
   `--material silkroot/silk --triplanar 1.6`), `variant-props/hide-lean-to` (`carters-rest/lean-to --part roof
   --art textures/variant-props/hide-leather.png`, wrapped as `camp-props/hide-lean-to`).
4. **Compose**: `props compose <recipe.json>` builds one prefab from existing props (`prefab`), existing models
   with a material (`model`), engine primitives with a material (`primitive`: eggs are ellipsoid spheres) and flat
   alpha cards (`card`: a PNG or a material id; upright facing +Z at pitch 0, flat at pitch -90; `at` is the card's
   bottom centre). Each part has `at` (its foot), `yaw`/`pitch`/`roll` and `scale`; the whole is re-seated on its
   foot and declared with the recipe's `declare` fields plus the measured size. Recipes live in
   `authoring/composite-props/recipes/`: `silk-egg-clutch`, `silk-nest` (the Silkroot Grove technique, below) and
   `poachers-tanning-rack` (the fowlers' rack frame model alone + a generated stretched-hide card + a pegged hide +
   the supplied basket).
5. Only then new geometry, and only of the kinds `docs/zone-pipeline.md` allows a builder to generate.

**The Silkroot Grove technique** (mmo scene, `authoring/towns/brinehold-hollow/dress.mjs`, `v2-dress.mjs`): the
supplied bone pile's geometry with its atlas UVs replaced by a planar projection in metres and the silk material
(`silkroot/silk-pile.glb`); egg sacs as stretched `SphereGeometry(0.5, 12, 10)` meshes in the same silk; webs as
alpha cut-out planes with `silkroot/web` (256 x 64 px at 0.03125 m per texel). The catalogue does the same without
copying a model: the variant's triplanar material replaces the UV rewrite, the eggs are `sphere` primitives with
world UVs, the webs are cards.

**Ruins from the DC stamp kit.** `ruin-props/` holds the carved-stone library's pieces (`projects/dc-carved-library`,
`tools/dc-carving`): octagonal and recessed columns, base, capital, coping, round and segmental arches, plain and
panel walls and the broad pier, copied unchanged by `authoring/ruin-props/import-carved.mjs` and given
`ruin-props/carved-stone`, the library's splat palette sampling the TOWN stone and masonry role tiles at 3.2 m.
Taller or broader pieces come from the registered Carved Stone Library tool (`hitreg.dc-carving`: width, height,
depth in metres) and are added to the import script; leaning, toppled and heaved ones are wrappers, groups are
composites. A broken (cut) column needs a DC composition with a subtractive cutter in the library tool; none is
catalogued yet.

## The duplicate guard

`props status` lists every SITE-made prefab (a catalog without `shared: true`) whose name falls in a family the
shared catalogue already offers (barrel, crate, tent, cart, torch, bones, sack, basket, chest, cage, banner,
campfire, table, bench, stool, chair, bed, lantern, shelter, brazier, gravestone, column, statue) as
`DUPLICATE of <existing ids>`, unless it nests a shared prop (then it reuses). For existing site prefabs this is a
finding; for NEW ones it is a gate: a site builder runs `props dupes <new prefab id...>` before cataloguing and
exit 1 means use the existing prop (or wrap / variant / compose it). `props status` also reports, as MISSING, any
prefab under `assets/prefabs/` that is in no catalog and no `exemptFolders` entry of `prop-catalogs.json` (folders
that hold no props: building cells and shells, characters, mobs, scatter vegetation), so nothing is invisible to
builders by accident. Existing prefabs that lived in such invisible folders are catalogued where they are by
`authoring/prop-intake/` (market stall, plinths, statue on plinth, boulder).

## Agent-independent coverage command

Run from the engine root; no editor or agent-specific service is required:

```powershell
node tools/poi-review/catalog-check.mjs --project apps/playground/projects/voxel-demo --asset assets/prefabs/poi-props/brazier.json --out apps/playground/projects/voxel-demo/authoring/poi-props/reports/catalog-check.json
```

Repeat `--asset` for every changed output. Missing membership, stale recorded hashes,
missing prefab model/material/VFX/nested-prefab files, a declared fire effect
removed from its prefab, or a catalogued prefab with neither a dressing declaration
(compiled onto its root) nor an exemption cause a nonzero exit. Do not omit failed assets from the
list to obtain a pass. Authoring/install scripts must run this gate before their
live scene/scatter write, and stop on failure.

This is a mandatory authoring gate, not a runtime import lock. The command checks
the supplied files, not every file in the project. It does not certify metadata
completeness, embedded model textures, screenshots, physics or performance; those
remain the intake/review responsibilities above. Existing legacy records are not
retroactively declared complete by a coverage pass.

The index has `version: 1` and a `catalogs` list. Each collection declares its
project-relative `path`, its top-level array in `entries`, and `pathFields` naming
runtime file paths on its rows. Existing prefab catalogs may use `prefabIds: true`
to resolve row IDs beneath `assets/prefabs/` with a `.json` suffix. A row's `sha256`
is checked against its runtime file when provided. Prefab rows may declare `effects`
as effect IDs; the existing `fire` shorthand resolves to `env/fire-<type>`. A collection
holding prefabs names its placement sidecar in `dressing` (a project-relative path to
`{ version, props: { <prefab id>: declaration | { exempt } } }`) or gives one
`dressingExempt` reason for all its outputs.

## Prop intake commands

From `apps/playground`: `npx tsx tools/props.mts <cmd> --project <name>`.
`measure` and `suggest` read the geometry; `status [--next]` checks every catalogued
prefab (declared or exempt, schema, size and origin against the measured bounds,
sockets inside the mesh and resting on it, slot hosts, known-failure heuristics, prefab
in sync) and exits 1 on anything not ok; `sync` writes sidecars onto prefab roots
(through ops) and refreshes catalog hashes it invalidated; `index` writes
`authoring/dressing/prop-index.json`; `menu` is the only view a placing agent reads. It prints FULL ids (folder
included), each prop's rooms and, for a wrapper, variant or composite, its source; `menu --setting outdoor
[--room camp|ruin|yard|quay|street|plaza]` is an outdoor site's list and `menu --search <word>` answers "do we
already have one". `wrap`, `variant`, `compose` and `dupes` are described above.

## Current MMO discovery

The project's `authoring/prop-catalogs.json` joins the existing collections without
replacing them: supplied props in `authoring/poi-props`, purchased source/output
catalogs in `authoring/purchased-assets`, and the current undergrowth variant
manifest. Keep this index with the project so another agent can discover the same
assets and fire-enabled prefabs. Detailed original-prop fire setup is documented
in `authoring/poi-props/README.md`.
