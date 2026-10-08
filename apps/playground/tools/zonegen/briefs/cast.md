# Brief: cast the world {world}

Decide, for the WHOLE map at once, what is wrong in each zone and who causes it, so neighbours differ.

**Read**
- `{adjacency}`: zones, towns, neighbours, walkable borders.
- `{bestiary}`: the catalogue; factions (story or local) and wildlife come only from here.
- `{recipe}` `regions` and the map: what the ground offers.
- `castSchema` in `{schemas}` (its `.describe()` text).

**Write** `{cast}`: one row per wilderness zone.

**Judgment**
- A story faction holds a few touching zones; minorities bleed over borders.
- Premises are specific to the ground, never a template with the name swapped.
- Levels rise along walkable borders.
- One overarching story faction per zone, but the zone is an ecosystem: give it two or more `others` (local bandits, cultists, a nest), each with a flavour of its own here, different from the same crew next door.
- Mark the starter zone(s).
- Fit creature levels to the zone; `needs-rig`/`needs-body` bodies cannot spawn yet: use them only if nothing else will do.
- If no catalogued faction fits a region, you may add a faction to `{bestiary}` with `"draft": true`, built ONLY from creatures already in the catalogue (name the theme each wears). Drafts wait for the owner's approval.

**Gate** `{zonegen} cast {flags}` must print `cast: ok` and fix its warnings.

**Do not touch** the recipe, any zone folder, any scene, or existing catalogue entries. You may ADD to the catalogue, always marked as a draft for the owner: factions (`"draft": true`), and creature VARIANTS: a weaker or stronger relative on an EXISTING body with its own texture theme and level band (say DRAFT in its `notes`; a new theme is `needs-art`). A missing BODY is a gap to report, never to invent, and an existing creature's level band is never widened to pass a lint.
