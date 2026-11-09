---
name: building-styles
description: Defining a town building style or a building type, adding kit parts, or working on windows: styles as premade part lists, shape rules, wear levels, types reused across styles, windows as props with day and night looks. Use with town-planner and building-constructor.
---

# building-styles

Towns are built from a kit by a solver; two lists drive it and change independently: STYLES (who built it, where)
and TYPES (what a building is for). Kit rules: `MMO/WFC/KIT-RULES.md`; making a style: `MMO/WFC/STYLE-MAKING.md`.

## Make a style (no code edits per style)
```
# copy a file in MMO/WFC/styles/, change settings, then
py MMO/WFC/wfc/style_make.py styles/<name>.json
```
One file: roof family + pitch + overhang + thickness + ridge + finials, wall material, stilts, opening shapes, trim,
storey range, `wear` 0-3 (as geometry), texture theme, prop set, ground, `hearth` (wall fireplace, or `central` fire pit
with a ridge louvre), `windows`. The command regenerates the parts the settings change, re-skins them from the theme's
role tiles (drawn with image-request when missing), verifies, registers the style (a request's `"style"` then builds
from that kit only), solves the fixed type list and draws one eye-height contact sheet
(`MMO/WFC/Generated/styles/<name>/<name>_sheet.png`). READ the sheet. A new SHAPE the settings cannot reach needs new
part generators: work before a run, never during one.

## Gates
- `style_make.py` part verification and the per-building review (building-constructor): a failure is a missing rule
  or piece, never a hand fix.
- Panes (R59): `check_panes.py` (0 faces behind any pane of any wall piece) and per building `panes_behind` = 0.
- Window density (R58): solver-preferred window every second line of each open wall run (`window_density`); none on a
  corner, beside a stair, on a chimney face, next to another window, or on a side a neighbour covers (request `blind`).
- Stairs: straight run on a clear 4 x 1 cell footprint (rule 28); every stair type must pass a real-body walk.
- Row houses (R77, KIT-RULES 42): request `party: ["-x", "+x"]`, never `shell`; 3 x 5 cells is the smallest plan
  that keeps a stair at 2-3 storeys; gate `town-kit-check row-fit a.glb:<lot m> ...` on every ordered pair (self too).
- Small houses (KIT-RULES 44): no 2 x 2 house has a hearth (all corners); 2 x 5 is the smallest 2-storey plan; 2 x 3 / 3 x 2 / 3 x 3 are one storey. Build them SOLO (`world-kit/authoring/strand-town/small.sh try|install`); a corner's row lot width is its catalogue `plan.rowPitchMetres` (bounds width), and since R80 (KIT-RULES 45) the 2-storey narrow types take `ridge: "y"` and their hearth on the back gable (no `fire` pin).
- Flat row houses: `party` with `roof: "flat"` (R77 flat, KIT-RULES 42 round 3); run `town-kit-check row-fit` on every flat/pitched pair.
- Roofs end in their roof tile (k-town3, Derek 2026-10-31: "roofs end with the white rim"): party parapets carry a roof-tile coping above the tiles (make_roof2 `_coped`); gate `npx tsx tools/town-grey.mts roof-rim <glb...>` on every export (pale render on faces open to the sky above 2.5 m fails). An end wall over an open bay closes to the tiles (R78 `infill`, open_front sheds and the smithy).
- A landmark leads by mass and detail, not height: broad crenellated tower top, projecting portal, rose, plinth, one dressed-stone style (KIT-RULES 42 round 5). Houses stay 3.2 m a storey; 3-storey shells are catalogued `frequency: rare`.

## Types (`MMO/WFC/styles/_types.json`, KIT-RULES 33)
Defined once, reused in every style, recognisable from the street by massing: house-s (box), house-m (gable outshut),
house-l (L-plan cross wing, wide steps), tavern (widest front, jetty, tall stack, stable range), bank (stone base, small
barred windows, windowless strongroom, grand door), chapel (lancets, buttresses, apse + bell tower/spire or bellcote),
smithy (one storey, open forge bay, tallest stack), shop (counters across the ground front), hall (one open room, grand
door, the style's hearth), tower/gatehouse. Kit limits: four-storey blocks and towers over seven storeys do not solve.

## Judgment
- A style is shape as well as texture (stilts, pitch, storeys, overhangs): two towns in different stone on the same
  shapes read as one town.
- Part sets are partitioned into styles; type and style stay separate (a church is a type; gothic or timber is the style).
- Wear is a level any style can take: kept, weathered, run-down, ruined (only ruins/abandoned get 3).
- Windows are props in every style but `default`: an empty opening filled by a window prop from one shared outline
  table; large church/hall windows are their own pieces; dormer windows stay baked. The pane is opaque and glows at
  night (one material swap) on its STREET face only: from inside a room the pane is dark at night; every window of a
  lived-in house is lit, no random dark panes (owner 2026-10-27, `window-lights.ts`). A house with no interior lights
  or at wear 3 (abandoned) shows dark windows as a whole — OPEN, the per-building flag is not wired yet
  (docs/world-standards/README.md). Each model's markers file carries one `window` marker per window.
- Styles must be cheap to make, many of them: change data, not code.
- Not encoded yet / OPEN: see `docs/world-standards/README.md` "Not encoded yet".
