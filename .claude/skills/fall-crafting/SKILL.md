---
name: fall-crafting
description: Turn one procedurally solved waterfall in a voxel world into a crafted place — a multi-tier cascade with plunge bowls, a stepped wandering gorge, baked DC cliff formations, supported scree and welded water — using only data and existing commands, gated by a numeric site audit and a 7-view screenshot sheet. Use when asked to craft, dress, fix or "make awesome" a waterfall / fall site, or when a fall looks like a straight slot with floating rocks.
---

# Fall crafting

The full reference is the tool-neutral doc **docs/world-editing/fall-crafting.md**.
Read it now, then follow it. This skill is the order of operations and what
not to skip.

## The rules

1. **Data only.** A crafting pass edits the site doc in the world recipe and
   runs the bake. It never changes engine code. If audit check a, d or f
   fails for an engine reason, stop and report it.
2. **Back up the world file first** (`projects/voxel-demo/assets/worlds/mmo.json`,
   copied to your scratchpad).
3. **No hand blobs, no hand rocks.** The template runs with `--rocks 0`, and
   no `features.blobs` go into the site.
4. **Re-bake formations after every site change.** They measure the gorge.
5. **Run until the completion gate passes** (the audit plus the doc's gate
   checklist, answered from your own sheet). No human reviews each fall; you
   are the reviewer. Be honest: a gate item you can't pass is a blocker, not
   a pass.
6. **Use a fresh dev server on your own port** for every look round. Never use
   5173 or 5199.
7. **The safety net is 8 look rounds, or 2 rounds with no gate change.** When
   it trips, record the fall as blocked, with the reasons.
8. **Always append the result line** to
   `projects/voxel-demo/authoring/falls-log.jsonl`, and report your token use.

## Order

list/snapshot → template (tiers by drop) → `walls` + `formations` blocks →
`course` (almost always) → `rock-formations.mts … --scene mmo` →
`_site-audit.mts <river> <site>` → `_fall-site-shots.mjs` → gate →
repeat until done or blocked → log.

Commands and the knob list are in the doc.
