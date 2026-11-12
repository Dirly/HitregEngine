---
name: creative-director
description: Critical creative-director review of a dungeon, POI, town or prop set against the owner-approved references (The Tombs of the Weeping Sun, Moon Deep) — a fresh, unanchored reviewer looks at the pictures only, scores a fixed rubric, names every element that does no job or breaks the story, and gives a ship / not-ship verdict. Use before telling the owner anything is done, after every major build round, and whenever the owner says quality is below the references.
---

# Creative director review

The gates prove a place is walkable and hole-free. They do not prove it is GOOD. Derek judges by the pictures against
the best dungeons we have shipped. This review does the same, before he has to.

## Who runs it
Always a **fresh Opus agent** that did not build the thing (Agent tool, `model: opus`). Give it the picture paths and
the one-paragraph premise; never your conclusions, the gate results or the builder's report. An anchored reviewer
confirms what it is handed.

## Inputs (pictures, not prose)
- **References, owner-approved:** `apps/playground/projects/weeping-sun-tombs/reports/rooms.png`, its
  `reports/compare/all.png` and `reports/views/*-interior.png`; `apps/playground/projects/moon-deep/reports/rooms.png`,
  `reports/compare/all.png`, `reports/views/*.png`. Read `weeping-sun-tombs/authoring/style-guide.md`.
- **Subject:** its rooms sheet, compare sheets (concept | build, same camera), set-piece frames, and for outdoor
  places the built-vs-concept sheet and the far/approach/shelf frames. At least one frame per room or area.
- **Premise:** one paragraph: who made this place, what happened here, what the player discovers.

## Compare against the gold, pair by pair
The gold standard is Weeping Sun Tombs and Moon Deep. Before scoring, pair every subject frame with the closest gold
frame by role (arrival with arrival, hall with hall, boss arena with boss arena, set piece with set piece) and say, per
pair, which is better and why in one line. A subject that is not as good as its gold pair fails that pair. The rubric
scores are relative to the gold: 5 = as good as the gold, 3 = clearly worse, 1 = not in the same league.

## Rubric (score each 1-5 against the gold, with the frame pair that proves it)
1. **One story, consistent** — does every space agree with who built it and what happened (outside matches inside,
   dug spaces look dug, built spaces built, transitions explain themselves: a breach, a door, a collapse)?
2. **Every element does a job** — supports carry something, chutes/ladders/scaffolds attach at both ends, nothing
   floats, no prop placed only to fill space. List each offender with its frame.
3. **Designed kit, one material language** — props and architecture look made by the same hands; no off-style or
   generic catalogue pieces (ornate where it should be crude, human-scale where it should be giant).
4. **Composition and focal points** — each room has a readable centre-piece and a reason to look; sightlines; the
   room's painting achieved, not just referenced.
5. **Scale and mass** — big spaces feel big and are FILLED by structure (architecture, not scattered small props);
   nothing reads as a toy.
6. **Surface and silhouette** — no boxy/square primitives where organic form is meant, no stretched or blocky
   textures, no flat monotone; value and colour separation between rock, floor, timber, stone, metal.
7. **Light reads** — focal pieces lit, pools and shadow, not lights on black and not flat wash (judge only once
   lighting is in).
8. **Clutter discipline** — sparse purposeful groups (the Weeping Sun lesson), not density for its own sake.

## Output
- A table: criterion, score (subject vs reference), the frame path that proves it.
- **Every defect** as one line: frame, what's wrong, why it breaks the bar, the fix in one sentence. Ranked worst first.
- **Verdict:** SHIP only if no criterion scores below 4 and nothing on the defect list is a story or function break.
  Otherwise NOT SHIP, with the three changes that would lift it most.
- The reviewer must be harsh: if the subject is worse than the references in a way the owner would notice in the
  first ten seconds, say so first.

## Rules for the coordinator
- Nothing is reported to the owner as done while the latest review says NOT SHIP; report the verdict honestly instead.
- Fix the defect list, re-shoot, run a NEW fresh reviewer (not the same one) on the new pictures.
- Keep the review in the subject's reports folder (`reports/creative-review.md`, overwritten each round).
