---
name: site-standards
description: "Building or reviewing an outdoor site (POI, camp, ruin, cave, estate, shore): size classes, one strong idea, story read from pictures, what a site may be made of, entrances, populated. Use with poi-creator and poi-review; the measured parts are site-finder (where), terrain-edits (ground, plants), site-dressing (props), zone-mood (air), portals (dungeon doors)."
---

# site-standards

The design bar for outdoor places. Measured rules live in the task skills: `site-finder`, `terrain-edits`,
`site-dressing`, `prop-intake`, `zone-mood`, `portals`, `encounter-standards`. Reviewers use
`docs/world-standards/review-rubric.md`. Open values: `docs/world-standards/README.md` "Not encoded yet".

## Size and idea
- Read `docs/world-standards/adventure-design.md` before choosing a premise. Fantasy discoveries and playable
  payoffs lead; trades and everyday medieval life support them. A new grim name, generic danger or invisible lore
  cannot qualify an ordinary work yard as an adventure. This is checked under rubric P1 and P4 before repetition.
- A site has a size class with a footprint in metres (first guess: small 40 m, medium 100 m, large 300 m+).
- A LARGE site is several sub-sites round one landmark, joined by walked routes, with water or caves as part of it.
  Small one-idea sites are fine.
- One strong idea per place, executed well; anything that only ticks a design line is cut (rubric Q3).
- The world is dark high fantasy. Adventure POIs have a particular fantasy discovery or worthwhile adventure
  opportunity that reads from the frames (rubric P1/P4); danger alone is insufficient. Treasure caches, monster dens
  and ruins can be straightforward. Town services and travel pauses may stay ordinary supporting life.
- The story reads from the pictures alone: a reviewer answers "why is this here?" without the design text (a toll
  needs a barrier and people waiting at it).
- A set piece shows what the occupants DO there (forge, midden, pen, lookout). Never a backstory illustrated by an
  odd object (a stolen bell as a font, a pole of wheels as a trophy).
- Simple and readable beats clever lore.
- A landmark building reads as the biggest thing on its site, with visible tiers; ruins are sized like the
  buildings they were.
- The defining read needs contrast: dark-on-dark holes vanish at distance; what must be seen from below sits on faces
  the viewer sees, lit or framed pale.

## Mood
- A site may break its zone's palette: its mood (haunted, drowned, burnt, lived-in) sets ground tiles, vegetation,
  water colour and air through a nested region (`zone-mood`, `terrain-edits`). Tone, never brightness.

## Made of
- Catalogue first; never remake what it has. May be generated: ruins, docks, shacks, rocks, flat art and decals.
  Never: animals, plants (`prop-intake`).
- Land is terrain; buildings come from the kit; crafted structures from Blender -> DC; objects from the catalogue.
  Kit and custom builds MIX (owner ruling 2026-10-24): the WFC kit (styles, wear levels, a ruin style with collapsed
  roofs, wall stubs, fallen gables, rubble, char; baked and catalogued as `wfc-ruins/*`) is the first choice for houses,
  halls, chapels and their ruins; the wall operator (dykes, shells, curtains, keeps, towers) and Blender -> DC builds are
  equally valid where they read better. What matters is the read: a ruin must read as a ruin at a glance, whatever made it.
- No bare primitive stands in for an object (rubric Q1).
- Built surfaces use the town texel standard on every face (`props status` HIGH).
- Material variation follows construction: keep each continuous part coherent and distinguish wall faces from supports, columns, coping/runners, arches and paving where those parts exist. The art gate checks emitted source roles against the bake; texture counts and repeats are diagnostics by default. Never add arbitrary bands to satisfy them. Unavailable or unclassified roles require source and visual review.
- Frames fit their opening: on the noised opening, aligned, overlapping into the rock; holes keep a spacing.
- No smoke until the smoke effect works (Derek 2026-10-30): smoke is off by default engine-wide (`vfx.smoke`, `mesh.source.chimneySmoke` opt in); fires read by their FLAME with a modest glow, never a halo (place-build gate `wash`).
- Camps: catalogue tents at 1.5x, stands 1.25x; the tent door faces the fire.
- Small pieces that work (a broken house, a hut) are registered for reuse.
- A route a place depends on is its own plan row with an owner and a gate (cut + real-body walk).
- Monument approach: a butte, mesa or monument is climbed by a path carved AROUND it (a cut ledge with a kerb,
  spiralling or switching up the face), never a freestanding stair (poi-review gate 10, `tools/monument-approach.mts`).
- Flat art (door reliefs, plaques, panels) reads upright and unmirrored (gate 9, `tools/flat-art.mts`).

## Entrances and life
- A place whose adventure calls for a dungeon has its OWN instance with ONE door, a walk-through portal deep in a
  real passage (`portals`). Some entrances are landmarks; some are hidden. A landmark or large size alone does not
  require a dungeon; justify one through the adventure and zone pacing.
- A dungeon entrance is a landmark: large set pieces, generated carving and decals; check every built thing from the
  sides, top and inside for see-through faces.
- A large site is not finished until it holds creatures and named creatures (`encounter-standards`).
