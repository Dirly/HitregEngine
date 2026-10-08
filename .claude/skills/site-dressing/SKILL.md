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

## Commands (from apps/playground)
```
# owner: handoff.json siteDressing { areas[{id, role camp|yard|cave-mouth|path|shore|ruin, centre, radius, floorY?, room?}],
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
- `LIGHTS:` line -> every fixture from the plan's one bucket (`tools/light-buckets.json`, `"lights": "camp"`).
- Site props invisible until you stand in them -> they were culled as an interior: re-apply with the current dress
  (site maps cull as clutter, minScreenPx 6).

## Judgment
- Inside caves the field height is the roof: dress from a `cave-mouth` area outside the lip, or a DC socket map inside.
- Pack clearings (8 m discs) eat a yard: size areas past them.
- A large composite on a narrow path area exceeds its cover ceiling: give it a wider area or place it as a structure.
- Tents and tarp shelters at 1.5x, stands at 1.25x; a tent's door faces the fire.
- Plants are never props (foliage system, `terrain-edits`).
- Purchased-pack props flagged LOW/needs-art are not used until re-skinned.
