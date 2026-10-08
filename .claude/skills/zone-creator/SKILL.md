---
name: zone-creator
description: Run a whole zone of a generated world as its coordinator - places designed before quests, a look before building, one owner per town/place/dungeon with a grey-box review by a fresh reviewer agent, packs and named creatures, then the quest loop and a whole-zone review. Use when asked to make, flesh out or finish a zone, or to plan the next zone of a world.
---

# zone-creator

The playbook is the tool-neutral doc **docs/zone-creation.md**. Read it now; it names the phases, who does each, the
budgets, the reviewer, the install queue and the ledger. The order itself is a command:

```
npx tsx tools/zonegen.mts status <world> --project <p> --zone <z> --next   # from apps/playground
```

Also read `docs/world-standards/process.md` (or the `world-standards` skill). Reviewers use
`docs/world-standards/review-rubric.md`. Load other standards only for the task in hand.

Before launching agents in a conversation with the owner, say what will start, how many agents and on which models,
and wait for the go. Keep the ledger (`zones/<z>/RUN.md`) current after every launch and install.
