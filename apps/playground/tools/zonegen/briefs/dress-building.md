# Brief: furnish {building} in {town}

You furnish ONE building, every room, for the people who use it. You choose WHAT goes in each room; the resolver chooses WHERE. Never write coordinates, wall t values or yaws. Run everything from `apps/playground`. Be economical with tokens.

**Steps**
1. Who lives or works there: print only this building's entry in `projects/{project}/authoring/towns/{town}-layout.json` (`residents`) and those residents' `role` / `about` in `projects/{project}/authoring/towns/{town}.json` with a node one-liner. Never read the whole files.
2. The space: `npx tsx tools/dress.mts manifest --project {project} --map {map}`. Read only the `rooms` lines (ceiling, placeable floor, item and cover limits) and the anchors (hearth, stair). Give every room a role in `plan.rooms` (several uses go in `also`).
3. Per room, the menu of what FITS it: `npx tsx tools/props.mts menu --project {project} --map {map} --room <room id> --role <role> [--wealth <tier>]`. Each line says the use (seat, table, bed, storage, shelf, light, work, decor), whether it needs a wall, and for a set its members and where they fall. Anything not listed does not fit that room. Never open catalogs or prefabs.
4. Write `projects/{project}/authoring/dressing/plans/{plan}.json` (format: the `dressing-plan` type in the engine spec). Each item names a set or a prop and an auto place:
   `{ "id": "fireside", "set": "hearth-seating", "place": { "kind": "auto", "room": "G-1", "near": "hearth" }, "note": "..." }`
   `prefer`: `wall` (back to a wall, the default for wall pieces), `corner`, `open` (the default for free-standing pieces), `near` (with `near`: an earlier item id, `hearth`, `door`, `stair`). Optional `wall` limits it to one wall. A set item may add `"mirror": true` to swap the set's left and right; leave it out and the resolver mirrors it when that fits better. Small things go `on` an item: `{ "kind": "on", "item": "<item id>" }`.
   Order matters: items resolve top to bottom and earlier ones win. Put sets first, the biggest and most important first, then single pieces.
5. Check: `npx tsx tools/dress.mts check --project {project} --plan {plan} --quiet`. It prints the spot chosen for every auto item, then the findings, then the verdict line `CHECK <plan>: N placements, V violations, W warnings -> ok|FAILED`.
6. Adjust only what it names. An item that does not fit says how much room was left and what refused it: choose a smaller piece, another room, another `prefer`, or move it earlier. Fix every warning about your plan.

**Judgment**
- A believable, lived-in place for THESE people: where each sleeps, eats, works and stores things. Fewer, better things: a room is mostly open floor; the check enforces the item minimum, the cover ceiling and the loose-container budget.
- Use sets (a table with its seats, a bed with its chest) rather than scattering singles. Storage goes on shelves or in chests; sacks, crates and barrels on the floor are a small budget.
- Fixtures come from the building: hearth, sconce and lantern flames are placed by `dress fixtures`. For more light use lit furniture (candle, lamp, candelabra, chandelier).
- Give each item a short `note`: whose it is or why it is there.
- If the tools cannot express what you need, or a prop you expected is missing, do not work around it: list it in your report.

**Do not touch** scenes, the world, prefabs, catalogs, tools. Do not run `dress apply`: the coordinator installs.

**Report** (under 200 words): the check's verdict, item count per room, check rounds, and friction or missing props.
