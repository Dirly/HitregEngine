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

## Judgment
- Furnishing scales with the floor: large rooms must not come out bare (a chapel with three benches).
- A role implies a set: pews in rows facing the altar by nave length, tavern tables by floor area, bed + chest + light.
- Arrangements are placed as one thing (a pew row, a dining set, a bed nook).
- Facing: chairs face their table, pews the altar, a tent door the fire.
- Never inside a hearth, doorway, stair run or walk lane, nor on a built anchor (a barrel inside a well ring).
- No big bare floor unless the room is meant open; choose the centrepiece spot before adding raised tiers (a tier reads as a stair).
- Re-apply a town's interiors after any town re-install (install drops them).
