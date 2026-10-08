# PROPOSAL — Quest mechanics as registered building blocks

Status: proposal, nothing built. Goal: quests that are not all "go there, kill that", assembled by agents from a
small set of reusable, schema-registered mechanics, with sameness caught by the zone lint rather than hoped away.

## 1. Inventory — what a quest could react to today

| World fact | Exists today | Where |
|---|---|---|
| Clock | `world.hour` in netState, authority-owned, `/time` | `packages/scripting/src/builtin.ts` (`DayNight`, `NET_HOUR_KEY`) |
| Weather | `world.weather` {precipitation, storm, wind, windAngle}, ONE per layer; rain/sand/snow is chosen by the client's biome | `builtin.ts` (`Weather`, `NET_WEATHER_KEY`) |
| Death and killer | `combat.killed {victimId, killerId, xp}` — emitted by a PROJECT script, no cause | `projects/voxel-demo/scripts/combat-actor.ts` |
| Buffs/status | Only a VFX look vocabulary (`STATUS_EFFECTS`); no authority status state on the sheet | `packages/core/src/vfx/spell.ts` |
| Item use | `consumable` item kind exists; no "use" event | `packages/core/src/character/items.ts` |
| Interactable objects | The `npc` builtin runs on any entity tagged `interactable` (nothing requires a body); its dialogue is the only server-checked interaction | `packages/scripting/src/npc.ts` |
| Readable text | Only as dialogue nodes | `packages/core/src/npc/index.ts` |
| Per-character memory | `setFlag`/`clearFlag`; conditions on quest status, flag, level, item, coins, bind | `npc/index.ts` (`dialogueConditionSchema`, `dialogueActionSchema`) |
| Trigger volumes | `collider.isTrigger` fires `trigger.enter/exit` | `packages/core/src/components/physics.ts` |
| Spawn control | `spawnArea` woken by proximity only; no event-driven spawn | `packages/server/src/spawn-areas.ts`, `components/core.ts` |
| Doors/locks | `door` opens by proximity; no lock, no key | `builtin.ts` (`Door`) |
| Portals/instances | `transfer.request {kind:"instance", scene, party}` exists; no portal component | `packages/server/src/cluster/protocol.ts`, `docs/hosting.md` |

Missing entirely: authority status effects, death cause, an item-use event, a generic interaction event, per-player
entity visibility, locks, shared world flags, event-driven spawns, a portal entity.

## 2. The model

Four slots, each a registry of named blocks: **source** (how the quest reaches the player), **condition** (a test
that gates a step or a source), **action** (what the player does — today's objective), **consequence** (what the
world does in answer). A block is `{ name, schema (Zod), description, scope }`, registered in a `QuestBlockRegistry`
in `packages/core` (no DOM, no ctx) and emitted by `buildEngineSpec` as `questBlocks`, so `/__hitreg/spec` lists
them. Evaluators (which need ctx and netState) live beside `quest-log` in `@hitreg/scripting`, keyed by the same
names. A project may register its own blocks the way scripts declare `static events`.

Quest shape after the change (additive):

```jsonc
{ "source": { "kind": "npc", "ref": "warden-ilse" },          // absent → derived from giver/autoStart
  "objectives": [
    { "id": "a", "kind": "visit", "area": { "...": "..." } },   // per-objective area, falls back to quest.area
    { "id": "b", "kind": "deliver", "target": "salt-cairn", "item": "river-glass",
      "after": ["a"], "when": { "clock": { "from": 20, "to": 23 } },
      "then": [{ "do": "reveal", "entity": "cairn-light" }] } ] }
```

Back-compat: `kind` becomes a discriminated union over the registry; `visit | kill | collect | talk` keep their
current fields and meaning, so every asset in `assets/quests/` parses unchanged. `giver`/`turnIn`/`autoStart` remain
and map to sources `npc` / `auto`. Empty `after` = today's unordered progress. Conditions reuse and extend
`dialogueConditionSchema`, so one condition language serves dialogue and quests. Consequences reuse
`dialogueActionSchema` where they overlap (`setFlag`, `give`, `take`, `acceptQuest`).

## 3. First batch, ranked by story value per build cost

| # | Block (slot) | Meaning | Touches | Exists / to build | Size | quest-play proof |
|---|---|---|---|---|---|---|
| 1 | `clock` (condition) | Step or source counts only within an hour window | `world.hour` | Exists; add evaluator | S | Set `world.hour` outside, then inside the window; assert no progress, then progress |
| 2 | `interact` (action) | Use a specific entity (lever, chest, slab) | `interactable` tag, npc-ui | Builtin request event + server range/owner check (copy npc's) | S | Send the request as a peer; assert progress; out-of-range refused |
| 3 | `object` (source) | Quest offered by an entity, not a person | `npc` builtin on a prop, dialogue | Works today with `face:false`; formalize and lint | S | Already playable: find `acceptQuest` in the object's dialogue |
| 4 | `read` (action) | Reading a text entity counts | text asset, npc-ui | `readable` text shown by npc-ui; emits a read event | S | Open it; assert progress and that its text resolved |
| 5 | `deliver` (action) | Leave an item at an entity | sheet, `take` | `take` exists; bind it to an entity and range | S | Grant the item, deliver, assert taken and progressed |
| 6 | `weather` (condition) | Counts only within precipitation/storm thresholds, optionally the biome under the player | `world.weather`, recipe biome | Weather exists; server-side biome lookup | S | Write `world.weather`; teleport into and out of the biome |
| 7 | `endure` (action) | Stay in an area N seconds while a condition holds | quest-log tick | New evaluator only | S | Stand; break the condition midway; assert reset |
| 8 | `flag` / `reveal` (consequence) | Set a per-character flag; show an entity to this player only | `npc/<body>`, client visibility | Flags exist; per-player visibility new | M | Assert flag; assert reveal reaches that peer only (second loopback client) |
| 9 | `presence` (source) | An entity exists only while a condition holds (hour, weather, flag) | scene entities | New builtin that toggles an entity by condition | M | Step the clock; assert it appears, offers, vanishes |
| 10 | `spawn` (consequence) | Summon a template at a point for this player/party | SpawnAreaManager | Event-driven spawn new | M | Trigger; assert spawned ids, owner tag, despawn after timeout |
| 11 | `die` (action) | Die with a filter: killer, cause, while a condition holds | `combat.killed` | Needs a `cause` field in a shared combat event contract | M | Authority `combat.damage` with a cause; assert progress only on a matching cause |
| 12 | `passage` (consequence) | Open a way for this player: per-player door state, or a transfer to an instance | `door`, `transfer.request` | Lock/key on `door`; instance hop exists | L | Assert the transfer request / door state for that peer only |
| 13 | `status` (condition) | A status is active on the player | sheet | Authority status state does not exist | L | Apply a status; assert the condition holds, then expires |

Foundation under all of them (S each): per-objective `area`, `after` enforced by `advanceQuest`, the `when`/`then`
fields, and `quest-play` dispatching through the registry so an unproven block fails loudly instead of passing.

## 4. Uniqueness as a gate

`zonegen quests` already holds each planned quest's giver type, objectives, `when`, `after`, `needs`/`grants`, and
reads the engine's kinds from `questSchema`; with the registry it reads block names instead.

- **Signature** per quest: `source | ordered action kinds | sorted condition kinds | sorted consequence kinds`,
  targets stripped. Example: `object|visit>endure|clock|reveal`.
- **Repeat cap**: one signature at most 2× per zone (error) and 3× across the zone plus its neighbours (warning);
  neighbours from the recipe `regions` the world already has. A near-duplicate (Jaccard of block multisets ≥ 0.8)
  counts as a repeat.
- **Floors** per zone: at least 40% of quests with no `kill`; at least 2 non-`npc` sources; at least 2 quests gated
  by a world-state condition (clock, weather, presence); at least 6 distinct action kinds.
- **Ceiling**: at most 30% of quests whose signature is `npc|kill` or `npc|collect`.
- **Honesty**: a planned block the registry does not list is an error. Today `when` and `giver.object` pass the
  lint but the runtime ignores them.

Thresholds live in the zone brief schema with defaults, so a zone argues for an exception in data.

## 5. Shared-world safety

Rule: quest progress is always per-character (the journal). World consequences are per-player, or shared,
non-exclusive and self-restoring. Nothing a player does may consume or lock a world thing another player needs.

| Block | State | Two players at once | Respawn / reset |
|---|---|---|---|
| clock, weather | World, read-only | Both see the same window | n/a |
| interact, read | Per-character progress; entity unchanged | Both progress; the entity never toggles shared | n/a |
| object, presence | Entity shared, offer per-character | Both can accept; a presence never leaves mid-conversation | Presence follows its condition |
| deliver | Item leaves the player; the slot never fills | Both deliver | The shown item is per-player (`reveal`) |
| endure, die, status | Per-player | Independent | Normal death/respawn; `die` never changes bind or sanctuary |
| flag, reveal | Per-character | Each sees only their own | Saved with the character |
| spawn | Owned by summoner or party; others may help | One pack per summon, capped per area; kill credit to all who damaged it | Despawn on leash, timeout, or owner leaving |
| passage | Per-player door state, or a party instance | Only holders pass; nobody else's collision changes (or it is a transfer, never a shared physical door) | Instance exits when empty |

## 6. Open questions for the owner

1. Ordered steps: enforce `after` in the engine for every quest, or only for quests that opt in?
2. Per-player visibility (`reveal`, `passage`): build client-side entity masking, or always express it as an instance hop?
3. Status effects: authority status state in the core character sheet, or combat stays project-side with only an event contract?
4. Death cause: make `combat.killed` with `cause` an engine event contract, or let each project declare it?
5. Weather: keep one state per layer, or move to per-zone weather so "only in this weather" works locally?
6. Shared world flags (a zone-wide change): allow them now, or wait for server persistence?
7. Uniqueness thresholds: hard errors from the first zone, or warnings at first?
8. Project-registered blocks: allowed now, or engine-only until the first batch settles?
