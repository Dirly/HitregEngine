# Brief: the quest graph of {zone} ({world})

You write the adventure's LOGIC and everything it needs to exist: quests, the places they happen, dungeons, quest items. Not prose: directions and dialogue are written after placement.

**Read**
- `{brief}`: premise, threat, history, budget (every count is checked against it).
- `{zoneBestiary}`: the only creatures, rares and bosses a quest may target.
- The zone's town plans (`zonegen brief-for town` lists them): the only npcs a quest may name.
- `{links}`: cross-town relationships worth a link quest.
- The zone's POIs in `{recipe}`, to know what kinds of site exist (`siteKinds`).
- `questGraphSchema` in `{schemas}`; sources, actions, conditions and consequences are the engine's registered quest blocks (`questBlocks` in the engine spec). A block it does not list does not exist.

**Write** `{quests}`.

**Judgment**
- Quests come LAST and attach to the brief's signature `places`: each place is a location with the same id and size,
  and its sub-sites and dungeon entrance are locations with `place` set to it. Quests use what a place is (its set
  piece, its named people and creatures, its dungeon); they never shrink a place to what one quest needs.
- World conditions are only what the engine registers. Weather: {weather}. Clock: {clock}. Nothing else exists (no fog, no mist): do not plan it.
- Do not make every hostile place a camp of the main faction: most belong to the zone's other groups (`hostile` names a bestiary group), each with its own small story.
- Many quests share a location and an arc spans several quests: do not mint a place per quest.
- Order is data: a key is granted before its door (`grants`, `needs`, `after`, `requires`).
- Give some quests a branch (two objectives in either order) rather than all straight lines.
- Each dungeon has an antagonist boss, a visible surface effect, and lists the rooms its quests need.
- Nothing unique: the world is shared. Every collected item names a `source` or an earlier `grants`.
- A ghost, a notice stone or a readable slab is a declared `entity`, not a resident; lore leads name a readable entity.
- An action's details go in `params` (endure seconds, perform action, deliver item), conditions in `if`.
- Only a town NPC advertises a quest. A quest that starts at an object, a presence or a place is found through LEADS: a rumour a resident lets slip, lore someone can read, something seen at a place. Off-the-beaten-path quests should be found this way.
- A lead is rumour and lore, not a marker: it names the place (`{place:id}` or its name) and gives circumstances in words — when, what was seen, who went there and did not come back. Never a direction or distance (`{dir:}`, `{far:}`, north/south/east/west), never coordinates, never an `area`: the compass belongs only to the objectives of a quest already started.
- A lead is found somewhere else than the start it hints at, and never starts the quest itself. One to three per quest.
- Say what each location must physically contain in `needs`, one requirement per entry.

**Gate** `{zonegen} quests {flags}` must print `quests ({zone}): ok`.

**Do not touch** the bestiary, town plans, the brief, the recipe, any asset or scene.
