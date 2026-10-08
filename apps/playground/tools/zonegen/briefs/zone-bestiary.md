# Brief: what lives in {zone} ({world})

You select this zone's creatures from the catalogue, with the neighbours' selections in hand.

**Read**
- `{brief}`: premise, threat, level, towns.
- `{cast}`: this zone's main faction, minor spill (and from where), wildlife.
- `{bestiary}`: the catalogue. Select; never invent a creature.
- The neighbours' `bestiary.json` beside this zone's folder (`{zoneDir}/../<neighbour>/bestiary.json`) where they exist.
- `zoneBestiarySchema` in `{schemas}`.

**Write** `{zoneBestiary}`.

**Judgment**
- The main line-up must make a real fight: melee, something at range or casting, and an elite or a rare.
- Rares and bosses are NEW themes on existing bodies (art only, no human); give each a place and a reason in the story.
- Do not field the same non-wildlife creatures as a neighbour; a shared faction member is fine only as the cast's minor spill.
- Wildlife follows the habitats the ground actually has here.
- Write the zone's occupant `groups`: one overarching story, but most places belong to someone else. Each group (a bandit crew, a cult, a wolf pack with a twist) has its own small reason to be here; mix human-kit and beast groups.

**Gate** `{zonegen} bestiary {flags}` must print `bestiary ({zone}): ok`. `art-request` warnings are expected: they become the asset manifest.

**Do not touch** the catalogue (report a missing creature instead), the cast, quests, other zones.
