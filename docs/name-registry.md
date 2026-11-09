# Character and deity names

Before choosing a character, named creature or deity name, look up its identity
and reserve the name in the game's database. A title or different creature type
does not make a reused personal name safe. One identity can have several aliases;
two unrelated characters must not be merged to silence a collision.

Redstrand and its dungeons share
`apps/playground/projects/redstrand/authoring/names.json`. The inventory distinguishes
authored characters from proposed residents and retired designs. Read its coverage
statement: established content does not imply installed overworld population,
live quests or completed encounter balance. Other games can own their own
`authoring/names.json`; its `projects` declare the shared narrative namespace.
Dungeon lookup finds the owning world database without a runtime dependency.

From `apps/playground`:

```powershell
pnpm exec tsx tools/names.mts lookup --project redstrand --name "Veyra"
pnpm exec tsx tools/names.mts check --project redstrand --name "A proposed name"
pnpm exec tsx tools/names.mts list --project redstrand --kind deity
pnpm exec tsx tools/names.mts check --project redstrand
pnpm exec tsx tools/names.mts schema
```

`lookup` reports current, previous and related name matches, plus role, location,
stable actor keys and provenance. `check --name` tests availability against current
claims, including aliases and retired identities. Case, accents, punctuation and
spacing do not distinguish names. Previous names remain searchable history, not
claims: the sun champion's former Veyra label does not make her the chapel deity.
Global `check` validates unique identities/claims, source paths and exact JSON
label pointers, and exits nonzero for unresolved legacy conflicts. A candidate
check still reports those conflicts, but its exit status concerns validation and
that candidate's availability.

Reserve a new identity before several agents begin authoring it:

```powershell
pnpm exec tsx tools/names.mts reserve --project redstrand --id npc-example --name "Example" --kind npc --location "Bell Strand" --summary "Proposed resident; role pending" --actor-id example
```

The reservation takes a file lock, rereads the database and checks the claim
before an atomic write. Simultaneous reservations cannot both acquire the same
name. Flesh out the existing record with its real sources and label pointers
as content is authored; preserve its identity ID. `schema` is the field reference.
An actor binding is ownership: merely finding a name already in the registry
does not authorize using it for a different character. The town NPC installer
enforces registered actor/name ownership when its project has a database.
It also rejects installing a retired identity until its record is explicitly reactivated.

Renames update current display labels and replay sources with normal guarded
scene ops. Keep stable gameplay keys, gate references and saved identifiers
unless a separate migration is intended. Record those technical keys under
identifiers, the displaced name under previousNames, and the new current name
under name/displayName. Historical reports and inverse ops retain their original
labels. Never add an unrelated character's name as a current alias.

Legacy conflicts are explicit records naming the exact affected identities and
the unresolved question. They keep inventory usable while still making global
`check` fail. The collision remains unavailable to new identities; an additional
claimant or a stale conflict declaration is a validation error. Resolve the actual
identity or rename first, then remove the obsolete conflict record. Do not invent
relationships to make the database pass.

This is authoring data, not the player-account naming or moderation database.
It does not rewrite game content when edited. Label pointers detect drift;
prose outside recorded sources and future custom generators still require the
lookup/reservation workflow. Tools should call `validateNameClaim` before
installing newly named actors. The schema and shared implementation live in
`apps/playground/tools/_names.mts`; CLI: `apps/playground/tools/names.mts`.
