# World standards

The rules a generated zone is built and judged against now live as TASK SKILLS, one per micro-domain, each tied to
its tool (`.claude/skills/<name>/SKILL.md`; non-Claude agents read the same files). A skill gives the commands, the
gates with what a failure means and its fix, and the few judgment rules no check can hold. The topic files here are
short indexes into them. A rule is real once it is DATA a tool reads and a CHECK a tool enforces; new lessons go into
a skill or a check, never into prose here. Raw evidence (with place names): `docs/zone-creation-lessons.md`.

| Topic file | Skills | Tools |
|---|---|---|
| `process.md` | `world-standards`, `zone-creator` | `zonegen status`, `brief-for` |
| `sites.md` | `site-standards`, `site-finder`, `terrain-edits`, `site-dressing`, `zone-mood` | `zonegen sites`, `worldgen lips/seated/vegetation/scatter-float`, `voxel-blades`, `site-sockets`, `zone-mood.mjs` |
| `dungeons.md` | `dungeon-standards`, `dungeon-build`, `dungeon-lighting`, `portals` | `tools/dungeon-pipeline`, `tools/dungeon-room-kit`, `tools/mesh-dc`, `portal-*` |
| `encounters.md` | `encounter-standards` | `zonegen populate`, `site-packs.json` |
| `interiors.md` | `interior-standards` | `dress` |
| `props.md` | `prop-intake` | `props` |
| `towns.md` | `town-planner`, `building-constructor`, `town-npcs` | `town-settle`, `town-lights`, `town-walk` |
| `building-styles.md` | `building-styles` | `style_make.py` |
| `review-rubric.md` | (the reviewer's checklist, kept whole) | `zonegen map --dev` |

## Not encoded yet

The one list of rules that no tool checks and values nobody has agreed (OPEN). When one gets a check, move it into
its skill's Gates and delete it here.

**Process**
- Read-shot gate in the grey-box stage (defining read from the stated viewpoint, readable hour, clear weather).
- Loop cap of two returns; install queue refusing work whose final review has not passed.
- Briefs that name the job's existing systems automatically; handoff after ~400k context; "story not yet visible" in handoffs.
- Shared site-shot / site-walk tools (no per-job harness copies); proof sections failing loudly on unmatched ids.
- Every reported count from a tool; a shot tool that states the camera, ray-checks the target and refuses sky/solid frames.
- A shared review-exposure (flat fill) switch for grey-box pictures.
- Budget table: no medium row in `docs/zone-creation.md` (small is 200k there, 150k in the skill).
- OPEN: the run as one script rather than a coordinator following the doc.

**Sites**
- Reach check for a premise's landmarks from the road graph; slope survey at the creature's footprint scale.
- Viewpoint sight-line against natural ground before the freeze; contrast of the defining read from that viewpoint.
- Reserve lint: named features inside the reservation, water features find water, a dungeon door has rock behind it.
- Pre-freeze measures (conduit source level vs crossings, grade-capped trail length).
- Site finder flags: hostile place on a town-to-town road, islands in lakes, access devices for unreachable strong sites.
- Route a place depends on as its own plan row; trail generator laying few wide hairpins (only maxCut/maxFill exist);
  trails out of walled towns starting at a gate; clearing strips for long trails.
- "Why is this here?" from pictures alone as a check; ruins sized like their buildings.
- Dark/pale ground tile present in the palette when the read needs it.
- Town plot/street/door-path clearings written from the town's lots.
- DC rock formations as a world-wide rule; frames fitting noised openings; route tunnel >= 2.2 m; pool rims and dais
  tiers <= 0.3 m; roadside set pieces given room.
- OPEN: site size-class numbers; the mood list and what each sets; foliage relation between neighbouring zones
  (mountains); entrance mix (landmark vs hidden) per zone.

**Dungeons**
- Plan check for repeated outlines across halls and against neighbour dungeons; one dominant space; no overlapping
  interiors; coarser voxel and ramps for giant scale; real-body walk ordered right after the first bake.
- Accidental pattern breaks; set pieces crafted from the start; set piece contrast with its holder.
- Frames fitting the noised opening; material theme as a ratio; test-wall tile trial; floor tiles >= ~50 luma.
- A window the player cannot see through not drawn as open.
- Owner-made mechanism requests logged with the spot left; patrols as routes between named points; tool-reported counts.
- `portal-cover --fit` MOVING the trigger/veil to the narrowest section (today it only resizes in place).
- Socket tool: wall fixtures in noised passages (no straight spans).
- OPEN: full size-class table; repeat cap per room recipe and per fixture; stacked fight floors (fix in combat or keep
  as a rule).

**Encounters**
- OPEN: counts per outdoor site class; pack recipes per faction; where a patrol is required. A pack is still N of one
  template at a point.

**Interiors and props**
- Door axis on props with a door (facing rule); anchor checks (nothing on a built anchor); centrepiece chosen before
  tiers; the check-and-retry loop in the shared dress tool.
- Per-kind real-size ranges + a placement check; silhouette check for scaled-up props; refusing LOW/needs-art props
  (today only flagged); `props menu` flagging primitive-built props.
- Prop requests instead of composites; owner-made mechanisms; small lights and wall-free furniture for every scale/culture.
- OPEN: furnishing target by floor area; the set per room role; the largest empty floor allowed.

**Towns and buildings**
- Buildable area vs planned envelopes (zonegen town lint); lots respecting wall/gate lines; no side-by-side streets at
  different heights; dungeon by every capital/starter town.
- Residents fitted to space; skinned-resident performance budget (capital band in lint and doc disagree).
- Wear by occupancy; abandoned-house story (the kit has no cellar storey); full-footprint settle (town-settle uses the
  lot outline); floor >= ~0.6 m over the highest foundation ground as a gate; kit stairs bridged from real ground.
- Lanterns facing the middle of what they light (direction-free lanterns, owner-made, pending).
- OPEN: lights on trails out of town, on bridge parapets, hanging-lantern glow at distance; first partition of part
  sets into styles and where it is stored; shared settings schema for part generators; stair types, footprints and
  which types use each; the window light-shaft effect.
