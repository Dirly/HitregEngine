# Brief: dress the {area} area of {poi} ({role})

You dress ONE outdoor area of a place, for the creatures or people who live there. You choose WHAT goes there; the resolver chooses WHERE. Never write coordinates, wall t values or yaws. Run everything from `apps/playground`. Be economical with tokens.

**Steps**
1. The place in one line: print only `idea` from the `handoff.json` in the highest-numbered `v<N>/` folder (only directories named v + digits; else the folder's own) of the place's job folder (`projects/{project}/authoring/zonegen/{world}/zones/{zone}/pois/{poi}/` ) with a node one-liner. Never read the whole file.
2. The space: `npx tsx tools/dress.mts manifest --project {project} --map {siteMap} | grep -v "^ *-?[0-9]* {0,2}[ .ox#HE]*$"`. Read the room line (placeable floor, item and cover limits) and the anchors list; skip the ASCII picture. The map is measured from the installed scene: 'x' are walking routes, doorways, portal passages, quest spots and creature-pack clearings (nothing solid there), 'H' the fire clearance, '#' something built or too steep, walls are the sides of tents/buildings and straight cliff or bank edges. Anchor kinds: `hearth`, `hearth-seat`, `spit-side`, `firewood-side`, `door`, `door-left`/`door-right`, `cave-mouth`, `cave-inside`, `cave-flank`, `path-side`, `edge` (clearing edge, facing in), `water-edge`.
3. The menu of what FITS: `npx tsx tools/props.mts menu --project {project} --map {siteMap} --room {area} --role {role}`. Anything not listed does not fit or does not belong. Never open catalogs or prefabs.
4. Write `projects/{project}/authoring/dressing/plans/{plan}.json` (format: the `dressing-plan` type in the engine spec) with `"id": "{plan}"`, `"map": "{siteMap}"` and `"rooms": { "{area}": { "role": "{role}" } }`. Each item is `{ "id", "prop" (or "set"), "place", "note" }`:
   - by intent: `{ "kind": "auto", "room": "{area}", "prefer": "near", "near": "hearth" }`; `prefer`: `wall` (back to a tent side or cliff edge), `corner`, `open`, `near` (an earlier item id or an anchor kind: `hearth`, `door`, `cave-mouth`, `water-edge`...).
   - on a named pitch: `{ "kind": "anchor", "anchor": "{area}/hearth-seat-2" }` (one prop per anchor; the pitch already faces the right way).
   Order matters: earlier items win. Biggest and most important first, then single pieces.
5. Check: `npx tsx tools/dress.mts check --project {project} --plan {plan} --quiet`. Last line: `CHECK <plan>: N placements, V violations, W warnings -> ok|FAILED`.
6. Adjust only what it names (smaller piece, another `prefer`, another anchor, earlier in the list). Fix every warning about your plan.

**Judgment**
- One idea, told by objects where they would really be: seats round the fire, firewood on the fire's far side, gear by the tent doors, work things (racks, frames, chopping blocks) at the working floor's edge, nothing in the way of a route. Fewer, bigger, better things; the area is mostly open ground for the creatures.
- Use what the place already uses (its own catalogue family) before generic camp props. No animals or plants (the foliage system owns plants).
- Give each item a short `note`: whose it is or why it is there.
- If the tools cannot express what you need, or a prop is missing, do not work around it: list it in your report.

**Do not touch** scenes, the world, prefabs, catalogs, socket maps, tools, the job folder. Do not run `dress apply`: the coordinator installs (`dress apply --project {project} --plan {plan} --scene <scene> --at 0,0,0 --yaw 0`, the map is in world coordinates).

**Report** (under 200 words): the check's verdict, item count, check rounds, and friction or missing props.
