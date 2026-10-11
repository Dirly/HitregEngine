# Building styles and types (index)

Styles as one file + one command (`style_make.py`), types reused across styles, wear levels, part sets per style,
stairs and windows (R58 density, R59 opaque panes, day/night look, `window` markers): skill **`building-styles`**
(`.claude/skills/building-styles/SKILL.md`). How-to: `MMO/WFC/STYLE-MAKING.md`; rules: `MMO/WFC/KIT-RULES.md`.

## Windows
Windows are props in every style but `default`; the pane is opaque and glows at night (the engine swaps the one
material); each built model's markers file carries one `window` marker per window. Details: the skill.
At load the engine also splits the `WindowGlass` panes into windows and gives each one a character (lit or dark,
its dusk hour, warm or pale, a slow flicker) and a light card — a soft shaft into the street plus a halo on the wall —
all on one shared material that batches to one draw (`packages/render/src/window-lights.ts`). Nothing to author:
keep panes on `WindowGlass`, vertical, with UVs inside ±4.
Open values: `README.md` "Not encoded yet".
