---
name: interior-standards
description: Furnishing a building or a dungeon room: dressing plans by name, furnishing that scales with floor area, the set a room role implies, arrangements, facing rules, never-inside rules, walls first and centre clear, lights from one bucket, `dress check` / `dress review` / `dress walk`. Use before writing or reviewing a dressing plan. Outdoor areas: site-dressing; missing props: prop-intake.
---

# interior-standards

Mechanics: `docs/zone-pipeline.md` "Props: declared once, placed by name"; tool manual: header of
`apps/playground/tools/dress.mts`. Brief: `zonegen brief-for dress-building` (one fresh Sonnet per building).

## Commands (from apps/playground)
```
npx tsx tools/dress.mts manifest --project <p> --map <id>            # the space before anything is placed
npx tsx tools/props.mts menu --map <id> --room <room> --plan <plan>     # only what fits that room, scale and culture
npx tsx tools/dress.mts fixtures --project <p> --map <id> --plan <plan> # lit fixtures on the model's anchors
npx tsx tools/dress.mts check --project <p> --plan <plan> [--scene <s> --at x,y,z] [--quiet]
npx tsx tools/dress.mts review --project <p> --plan <plan> | --all
npx tsx tools/dress.mts apply --project <p> --plan <plan> --scene <s> --at x,y,z --yaw <deg>
npx tsx tools/dress.mts walk --project <p> --plan <plan> --scene <s>   # real body: door -> every room and stair
```

## Gates: failure -> fix
- `wrong-scale` / `wrong-culture`: the plan's `space` (kind, scale, cultures) refuses the prop -> another from the
  filtered menu, or a prop request.
- `centre-clutter` (dungeon room centre farther than max(1.5 m, half the inradius) from the edge holds more than one
  centrepiece/set piece; two over 300 m2) -> back props onto walls.
- `path-margin` (solid props 0.4 m off walk lines), lane / stair / doorway buffers -> move off the lane.
- `overlaps-geometry` / `decal-overlap` -> check with `--scene --at`; decals first, props keep off them.
- `LIGHTS:` -> fixtures from the plan's one bucket (`tools/light-buckets.json`), with a cap per room.
- Cover ceiling (30% of free floor, 50% storage) or loose-container budget exceeded -> fewer, better things.
- `dress walk` fails -> a prop blocks a door, stair foot or room: move it.
- Refused points: the check-and-retry loop (refused -> auto open -> drop), never hand-nudging.
- `auto-tight` -> no spot in the room clears the hearth/door buffers: accept it, split the set into single items, or a smaller piece.
- Pews/benches facing an altar: `prefer: "row", near: "<altar item>"` (rows form behind each other). Fireside seats: `near: "hearth"`.
- Open-plan kit house (few big map rooms): declare `zones[]` in the plan (hall bay, ledger strip, store...); `zone-wall` fails a zone with under 2 wall items, `zone-sparse` warns one under max(3, area/8) items; `open: true` only for a circulation zone kept clear on purpose. Daylight: `fixtures/window-daylight` on the `window` anchors.
- Mixed rooms: roles `cottage` (hall+bedroom+kitchen), `guardroom` (hall+bedroom), `living` (hall), or `also`. A town building's
  menu is human civic/rural by default (`--culture <c>` / `--all` for others); an exterior map lists its pitches.
- Rugs, papers, pictures are held off their floor/board/wall by `apply` (`mountOffset`); never hand-lift them.

## Judgment
- Furnishing scales with the floor: large rooms must not come out bare (a chapel with three benches).
- A role implies a set: pews in rows facing the altar by nave length, tavern tables by floor area, bed + chest + light.
- Arrangements are placed as one thing (a pew row, a dining set, a bed nook).
- Facing: chairs face their table, pews the altar, a tent door the fire.
- Never inside a hearth, doorway, stair run or walk lane, nor on a built anchor (a barrel inside a well ring).
- No big bare floor unless the room is meant open; choose the centrepiece spot before adding raised tiers (a tier reads as a stair).
- Re-apply a town's interiors after any town re-install (install drops them).

## Owner rulings 2026-10-20 (enforced by `dress check`)
- Chapel: altar first, `{ kind: "auto", room, near: "apse" | "back-wall" }` (faces the nave); pews `prefer: "row", near: <altar>` in 2+ rows. Warnings `chapel-altar`, `chapel-pews`.
- A lectern/podium (`neverInDoorLine`) never stands in a door line (doorway/entry width carried 3 m in): violation `door-line`; auto spots skip them.
- Nothing solid stands within 2 m in front of a doorway, entry or hallway mouth, on either side of the door, dungeon rooms included (owner walks 2026-10-21 and 2026-10-27: "remove anything a few grid tiles from a door"): violation `opening-clear` (`OPENING_CLEAR`); auto spots skip it.
- Every building with a door holds at least one light INSIDE its footprint (a hearth, candle, lantern or chandelier fixture from the plan's bucket): `town-lights check` fails `interior <id>: no light inside` and the zonegen `lights` row with it (owner walk 2026-10-27: houses read black at night).
- Books lie flat on tables, desks and chests, upright only on shelves (sidecar `pose: { surface: "flat", shelf: "upright" }`): violation `book-upright`.
- A standing candelabra within 1.2 m of a table is violation `candelabra-table` unless placed on a wall, `prefer` wall/corner or near the altar; a table takes the LOW candelabra `on` it.
- Props tagged `sign` (hanging trade signs, sign posts) never stand inside a room: violation `sign-indoors`; on a town exterior they go on `door-sign-<lot>` anchors (`town-exterior door-signs`). Wall boards (notice/tally boards) are not signs and may dress a room (owner ruling 2026-10-21).
- A chapel, hall or tavern room with ridge >= 4.5 m (and >= 20 m²) hangs a chandelier: `near: "ceiling-centre"` (auto chandeliers default there); warning `no-chandelier`, also in `dress review`.
- Pews: the plan gives the count; `prefer: "row", near: <altar>` lays rows 1.1-1.3 m apart from the altar step back down the nave, a 1.2 m aisle on the walk line, short of the door line; rows under 50% of the nave are violation `chapel-pews` (it says how many to plan).
- A tall room over 1.6x as long as wide hangs a chandelier LINE under the ridge, one per 8 m (each `near: "ceiling-centre"` item takes the next spot, the first centred); `no-chandelier` counts the line.
- Under a tall roof an auto chandelier comes down its chain to hang ~4 m over the floor (never lit from 10 m up).
- Flame budget: one flame per 12 m² of the level's floor, at least 6 (`flame-budget`).
- A wall light on a wall over 4 m may hang 1.6-2.4 m (a hall's windows sit high).
- An altar carries a top surface: candles go `{ "kind": "on", "item": "<altar>" }`.
