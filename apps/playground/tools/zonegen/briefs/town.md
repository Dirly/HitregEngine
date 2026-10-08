# Brief: town plans for {zone} ({world})

You plan who lives where and works where in each of the zone's towns, before any lot is laid.

**Towns**
  {townPlans}

**Read**
- `{brief}`: each town's tier, role and wealth, and the zone's story.
- `docs/town-npcs.md` and the town-planner skill: the services every town needs, how a household and a building relate.
- An existing plan for the format, e.g. `projects/{project}/authoring/towns/brinehold-plan.json`; `tools/town-layout.mts` reads it. Do not redefine it.
- The town's survey (`authoring/towns/survey/<name>.json`) when it exists: whether it is coastal, its shelves.

**Write** each `<name>-plan.json` listed above, one per town; nothing else.

**Judgment**
- Every resident has a home and a workplace that are buildings or structures in the plan; families share homes.
- Services follow the town's role; a hamlet still banks, binds souls, feeds, repairs and guards, with fewer hands doing several jobs.
- The roster's wealth sits where the brief says the town sits; a few richer or poorer people make it a place.
- A coastal town has a dock structure.
- Leave hooks for quests in relationships; one naming someone in another town says `crossTown: true`.

**Gate** `{zonegen} town {flags}` must print `town ({zone}): ok`.

**Do not touch** the town docs' story and dialogue, layouts, scenes, the recipe, the brief.
