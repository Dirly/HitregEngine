---
name: site-standards
description: Building or reviewing an outdoor site (POI, camp, ruin, cave, estate, shore): size classes, one strong idea, story read from pictures, what a site may be made of, entrances, populated. Use with poi-creator and poi-review; the measured parts are site-finder (where), terrain-edits (ground, plants), site-dressing (props), zone-mood (air), portals (dungeon doors).
---

# site-standards

The design bar for outdoor places. Measured rules live in the task skills: `site-finder`, `terrain-edits`,
`site-dressing`, `prop-intake`, `zone-mood`, `portals`, `encounter-standards`. Reviewers use
`docs/world-standards/review-rubric.md`. Open values: `docs/world-standards/README.md` "Not encoded yet".

## Size and idea
- A site has a size class with a footprint in metres (first guess: small 40 m, medium 100 m, large 300 m+).
- A LARGE site is several sub-sites round one landmark, joined by walked routes, with water or caves as part of it.
  Small one-idea sites are fine.
- One strong idea per place, executed well; anything that only ticks a design line is cut (rubric Q3).
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
- No bare primitive stands in for an object (rubric Q1).
- Built surfaces use the town texel standard on every face (`props status` HIGH).
- Frames fit their opening: on the noised opening, aligned, overlapping into the rock; holes keep a spacing.
- Camps: catalogue tents at 1.5x, stands 1.25x; the tent door faces the fire.
- Small pieces that work (a broken house, a hut) are registered for reuse.
- A route a place depends on is its own plan row with an owner and a gate (cut + real-body walk).

## Entrances and life
- Each landmark has its OWN dungeon with ONE door, a walk-through portal deep in a real passage (`portals`).
  Some entrances are landmarks seen from far off; some are hidden.
- A dungeon entrance is a landmark: large set pieces, generated carving and decals; check every built thing from the
  sides, top and inside for see-through faces.
- A large site is not finished until it holds creatures and named creatures (`encounter-standards`).
