---
name: site-dressing
description: Dress an outdoor site (camp, yard, cave mouth, shore, ruin, path) with loose props placed BY NAME — owner declares areas in handoff.json, site-sockets measures them, one fresh Sonnet per area writes a dressing plan from `props menu` filtered by scale and culture, then `dress check` / `dress review` / `dress apply`. Use when a POI's structures are installed and its props are due, when the `site-dress <poi>` row is not ok, or when outdoor props are wrong-sized, wrong-culture, floating or culled.
---

# site-dressing

Source: `docs/zone-pipeline.md` "Props: declared once, placed by name" and "Site dressing tool". Tool manuals: headers
of `apps/playground/tools/site-sockets.mts` and `tools/dress.mts`. Rooms and dungeon rooms: `interior-standards`.

## Who
- Opus place owner: terrain, structures, anchors (hearths, tent doors, cave mouths) and the `siteDressing` declaration.
  It never writes a prop transform in a build script.
- One fresh Sonnet per AREA places every loose prop (`zonegen brief-for dress-site --poi <id> --area <area>`).
- The coordinator applies. Gate: row `site-dress <poi>` in `zonegen status`.
- Owner overrides are fixed; read `dress overrides <project>` before dressing an area (`<plan>.owner.json`: never move, re-add or replace those props; `dress manifest` lists them).

## Commands (from apps/playground)
A place where people LIVE (village, camp, steading) is laid out by `settle` first, not by hand-declared discs:
`npx tsx tools/settle.mts plan --project <p> --poi <id> --culture crockin|frogkin|ogre|giant --households N [--clusters N] --centre x,z --radius r [--size <tier>] [--anchor approach=x,z]`
writes the areas (one per household / gathering spot / work yard), the dressing plans, clearings and creature spots;
`settle apply` + `settle check` (households complete, doors facing, reach, cover cleared, tier). Dressers then refine its plans.
```
# owner: handoff.json siteDressing { areas[{id, role camp|yard|cave-mouth|path|shore|ruin, centre, radius, surface? ground|cave|built, floorY?, room?}],
#        anchors[...], keepClear[...] }   default: a 14 m camp per hearth
npx tsx tools/site-sockets.mts --project <p> --job <poi job dir> [--scene <s>] [--area <id>]   # read-only; one map per area
npx tsx tools/props.mts menu --map <map> --room <area> --scale <class> --culture <c> --setting outdoor
npx tsx tools/dress.mts check  --project <p> --plan <plan> [--scene <s> --at 0,0,0] [--quiet]
npx tsx tools/dress.mts review --project <p> --plan <plan>
npx tsx tools/dress.mts apply  --project <p> --plan <plan> --scene <s> --at 0,0,0 --yaw 0    # world coords; inverse saved
```
Named pitches: `hearth-seat`, `spit-side`, `firewood-side`, `door-left/right`, `cave-inside`, `cave-flank`,
`path-side`, `edge`, `water-edge`.

## Gates: failure -> fix
- `CHECK ... -> FAILED`: read each violation code.
  - `wrong-scale` / `wrong-culture` / `scale-undeclared` -> pick from the filtered menu; if nothing fits, that is a
    prop request (`prop-intake`), never a prop of another people or size.
  - `wrong setting` -> the prop is declared indoor/outdoor only: a `props wrap --decl '{"setting":"both"}'` wrapper,
    made BEFORE dressers are briefed.
  - `path-margin` / lanes `x` -> routes (+0.6 m), doorways, portal passages, quest spots and pack clearings stay clear.
  - `overlaps-geometry` / `decal-overlap` -> run check with `--scene --at` so placed statues/decals are read; decals go
    on first, props keep off them.
  - refused points -> retry loop (refused -> auto open -> drop), never hand-nudge.
- `site-spread` / `site-clutter` / `site-sparse` / `site-dense` -> the area is a patch of stuff, not a layout: give it vignettes
  (below); density is per 100 m² of placeable ground by role (core `SITE_DENSITY`, cap `SITE_DENSITY_CAP`).
- `facing-sense` -> a vignette member was pinned facing the wrong way (seats face the fire, racks square to their edge): use its auto place.
- `opening-clear` -> nothing solid within 1.2 m in front of a door, cave mouth, doorway or hallway mouth (indoors too).
- `arrangement` -> the vignette's anchor is not on the map (re-run site-sockets) or it found no open ground 3 m off the lanes.
- `cover-not-cleared` -> a dwelling / fire / bedding stands on kept ground cover ("grass should be cleared below a hut"):
  `dress apply` writes its cover-cleared footprint disc; never set `clearing: false` on a site with a tent or fire.
- `LIGHTS:` line -> every fixture from the plan's one bucket (`tools/light-buckets.json`, `"lights": "camp"`).
- `seat: N with NO support` (dress apply) or `worldgen float` FAIL -> the plan put a prop where nothing holds it (an edge, a
  cut, over water): move it in the plan. `apply` re-seats the rest on the real ground itself; never hand-set a y.
- Site props invisible until you stand in them -> they were culled as an interior: re-apply with the current dress
  (site maps cull as clutter, minScreenPx 6).

## Judgment
- LAYOUT, not room rules (owner walk 2026-10-21): an outdoor area is laid out in VIGNETTES, plan `arrangements[]` { id, kind
  camp|work-line|yard|shrine|midden|lookout|graveyard, room, anchor?, facing? }, each item `{ "kind": "auto", "room", "arrangement", "part"? }`.
  Anchor to what the site has (`structure:<id>`, `structure:<id> front`, `kind:hearth`, `kind:water-edge`, `approach-end`: site-sockets
  lists them); unanchored vignettes spread along the area 6-12 m apart, 2 m off the lanes. Natural fill (boulders) stays `prefer: open` (spread).
- Inside caves the field height is the roof: dress from a `cave-mouth` area outside the lip, or a DC socket map inside.
- Decks, quays, weir crests, stilt walkways, plinths, platforms: declare the area `surface: "built"` with `floorY` (or an
  `[x,y,z]` centre at the deck's height, found on its own) so the deck's top is measured, not the water under it; its
  open edges are drops (refused, no wall to hang on), so a hung prop needs a rail, post or wall there.
- Pack clearings (8 m discs) eat a yard: size areas past them.
- Graves (tag grave/headstone/cross/tomb) are placed `{ "kind": "auto", "prefer": "row" }`, no `near`: the resolver lays the yard in rows inside its wall; `graveyard-rows` / `graveyard-sparse` say when they clump or are too few.
- A large composite on a narrow path area exceeds its cover ceiling: give it a wider area or place it as a structure.
- Tents and tarp shelters at 1.5x, stands at 1.25x; a tent's door faces the fire.
- Plants are never props (foliage system, `terrain-edits`).
- Purchased-pack props flagged LOW/needs-art are not used until re-skinned.
