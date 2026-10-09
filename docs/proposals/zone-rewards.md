# PROPOSAL — Zone rewards: gear sets, named drops, rewards that differ in kind

Status: proposal, nothing built. Goal: every zone is planned to be rewarding the same way it is planned to be
interesting: as linted data beside the quest graph, generated from a seed, with art requested early and never
blocking a drop. No number here depends on combat.

## 1. Inventory: what a reward can be made of today

| Piece | Exists | Where |
|---|---|---|
| Item asset | name, kind, slots (13 kinds, 14 doll slots), stack, weight, value (copper), rarity (common..legendary), durability, flat `modifiers` on 5 attributes + 5 derived stats, `requires`, `twoHanded`, `stance`, `appearance` {model, parts, texture, glow, effects}, `icon`, `tint`, tags | `packages/core/src/character/items.ts` (`itemSchema`) |
| Inventory | a stack is `{itemId, qty, durability}` pointing at a shared item asset: **no per-instance rolled stats** | `character/sheet.ts` |
| Giving items | `inventory.give` (authority-internal: "loot, a vendor, a reward"), `inventory.dropped` | `character/events.ts`, `docs/character-progression.md` |
| Slow swaps, weight | `inventoryDurations.equip/unequip/transfer`, `capacity` | `character/progression.ts` |
| Looks | one ubermesh + one packed theme page per model; parts and themes are names; ornaments rare+ | `docs/item-looks.md`, `docs/armor-sets.md`, `docs/weapon-atlas.md`, `character/part-rules.ts` |
| Icons | rendered from the model, or a cell of a 16-object category sprite sheet | `docs/item-icons.md` |
| Quest rewards | `rewardXp`, `rewardCoins`, `rewardItems` | `packages/core/src/game-ui.ts` (`questSchema`); planned as `rewards {xp, coins, items}` in `tools/zonegen/schemas.mts`, written by `zonegen bind` (`commands/bind.mts:291`) |
| Shops | stock list, markup, buyRate, restock; live stock in netState `shop/<id>` | `packages/core/src/npc/index.ts` (`shopSchema`); `assets/shops/brinehold`, `tidewell` |
| Kill hook | `combat.killed {victimId, killerId, xp}`, emitted by a project script | `projects/foundation/scripts/combat-actor.ts:587` |
| Abilities | spells as element x archetype (13 kinds) x phases; creation traits name an ability id | `packages/core/src/vfx/spell.ts`, `assets/spells/`, `character/creation.ts` |

Content today: 114 items in `foundation/assets/items/` (104 equipment; 82 common, 22 uncommon, 9 rare, 1 legendary).
The planned zone `proving/zones/zone-5` has 19 quests that all reward xp + coins and **no items**; its 9 planned
items are keys and evidence; its 7 rares and its boss `hob-yarrow` drop nothing.

Missing entirely: loot tables; any drop on death (the spawner `packages/server/src/spawn-areas.ts` and mob templates
carry no loot); chests; any seed or generator for items; an item level; set bonuses ("set" today means an armour ART
set); abilities on items; standing with a group; gear soulbinding; per-instance item data. **Name collision:**
"soul bind" in the engine is the RESPAWN point (`soulBindSchema`, netState `bind/<bodyId>`, `bindSoul` dialogue).
Gear binding needs another word in data; this proposal uses **`keep`** (a kept item cannot be looted).

## 2. What makes a zone rewarding, as lint rules

Each is checkable on the plan alone. Thresholds are knobs on the brief, like `variety` today.

1. **Signature set.** Every zone defines one set of 4-6 pieces whose theme is new art on existing models, drawn
   from the cast row's `palette` and the story faction's `motifs`. Error if missing, or if an adjacent zone's set
   uses the same theme.
2. **Every rare and boss names a drop.** Each `bestiary.rares[]` and `bosses[]` id is the source of a named
   descriptor at rare or better (a boss: epic or better). Error otherwise.
3. **Kinds vary across quests.** Kinds: `gear`, `material`, `consumable`, `standing`, `keep` (a keep grant),
   `cosmetic`, `unlock` (a recipe, a service, a route, a vendor shelf), `lore`. At least 4 distinct kinds per
   zone; no kind on more than 40% of quests; xp and coins never count as a kind.
4. **Caps on the powerful kinds.** At most 1 `keep` grant per zone, only on a main-arc or dungeon quest, never in
   a starter zone; at most 2 epic+ quest rewards; legendary never from a quest, only from a boss or a discovery.
5. **Every group gives something only it gives.** Each `bestiary.groups[]` id is the source of at least one
   descriptor no other source in the zone repeats (its trophy, its standing, its shelf). Error below 100%.
6. **Neighbours never duplicate.** No descriptor concept, set theme or named drop repeats in an adjacent zone,
   measured by the same Jaccard signature the quest lint uses (here over tags + slot + kind + base). Error.
7. **Discovery pays.** Every `discovery: true` location and discovery quest gives at least one non-coin reward.
8. **In band.** A descriptor's `level` lies in the cast row's level band; ornate parts only rare+ (an existing
   rule, now enforced on descriptors).
9. **Nothing unique in the shared world.** As for quest items: any reward exists per player, never as one copy.

## 3. The planning format: `zones/<z>/rewards.json`

Beside `quests.json`, validated by a `rewardsSchema` in `tools/zonegen/schemas.mts`:

```jsonc
{ "zone": "zone-5", "seed": "zone-5/rewards/1",
  "set": { "id": "fen-reeve", "theme": "fen-reeve", "motifs": ["peat", "reed", "brass"],
           "pieces": ["helm", "shoulders", "chest", "gloves", "legs", "boots"] },
  "descriptors": [
    { "id": "yarrow-tithe-hook", "kind": "gear", "slot": "primary", "rarity": "epic", "level": 9,
      "base": "longsword", "seedSalt": "yarrow", "keepable": true, "tags": ["boss-drop"],
      "describe": "a reeve's tithe hook gone black in the peat",
      "ability": { "delivery": "melee", "timing": "", "payload": "", "modifiers": [] } } ],
  "sources": [
    { "from": { "type": "boss", "ref": "hob-yarrow" }, "gives": ["yarrow-tithe-hook"], "chance": "guaranteed" },
    { "from": { "type": "rare", "ref": "reed-mother" }, "gives": ["reed-mother-veil"], "chance": "named" },
    { "from": { "type": "quest", "ref": "whose-acres" }, "gives": [{ "kind": "keep", "count": 1 }] },
    { "from": { "type": "group", "ref": "reedmere-fowlers" },
      "gives": [{ "kind": "standing", "ref": "reedmere-fowlers" }, "fowler-decoy-cloak"] },
    { "from": { "type": "location", "ref": "sunk-chapel" }, "gives": ["chapel-reliquary-mat"], "chance": "cache" },
    { "from": { "type": "zone" }, "gives": ["@set", "@materials"], "chance": "ambient" } ] }
```

A descriptor is NOT an item: a seed, rarity, slot, base model family and a promptable description. Ability parts may
stay blank until combat settles, and `chance` is a CLASS (guaranteed / named / cache / ambient), not a number, for the
same reason. The quest graph's `rewards.items` names descriptor ids; `bind` resolves them to generated assets.

**Joining the asset manifest.** `zonegen manifest` adds rows of new kinds: `item-theme` (the set's sheet per model:
the `armor-sets` route for body/helm/shoulders, `weapon-page` for a held base; by gpt) and `item-icon` (procedural,
rendered once the theme exists; a sprite-sheet cell for materials and consumables). Status is `request` at freeze,
so art starts when the plan does. Until a theme lands, the generated item wears an existing theme of its base with
`placeholder: true`, and its icon falls back to initials (the item schema already allows that). The id, stats and
drop never wait for art.

## 4. The generator

`zonegen items` (build stage, deterministic, no agent) writes one item asset per descriptor,
`assets/items/<zone>/<id>.json`:

- **Stats.** `hash(world seed, zone seed, descriptor id, seedSalt)` seeds a PRNG. A hand-authored budget,
  `itemBudget[slot][rarity]` in the progression asset, gives points per level; the PRNG spreads them over the
  modifier keys allowed for that slot and base (hand-authored archetype weights). Same seed, same item, forever:
  the world never resets, so the generator is versioned and a new version never rewrites shipped items.
- **Ability.** Composed from hand-authored part lists (delivery = the spell kinds; timing; payload; modifiers),
  filtered by what the base and slot allow. Never a scaled copy of an existing spell. Rare+ gear only.
- **Look.** Base model from the descriptor; parts picked by the PRNG from the model's part table under the existing
  part rules (ornaments rare+); theme = the set or zone theme, else a material theme (iron, rust). Always an existing
  model plus a tile of its packed page, so every holder stays one draw.
- **Name and text.** A short agent pass after generation (like quest prose after `bind`), linted.

**Stays hand-authored:** the budget table, archetype weights, ability parts and their legal combinations, base model
families, set-bonus effects (if any), the reward-kind vocabulary.

**Combat must settle first:** what a stat point is worth (budget values), which modifiers exist beyond the ten flat
ones (crit, haste, block...), ability-part numbers, the cost of weight, durability loss, set bonuses. Until then the
generator runs on a budget marked `provisional`, and items carry the generator version so they can be re-rolled once.

**Runtime drops, on the server.** On `combat.killed`, a `loot` builtin on the authority rolls for each ELIGIBLE player
(those on the mob's threat list): `guaranteed` and `named` sources for each player separately; `ambient` tables with a
per-player seed `hash(world, spawn id, kill tick, player id)`. Each player sees a personal loot window on the corpse
(`inventory.give` on pickup). No one can take another's roll, so one player's loot never strands another. Caches are
per player, with a per-player cooldown in netState.

Engine changes this implies: `itemSchema` gains `level`, `ability` (a parts object), `keepable`, `set`, `source`
{zone, descriptor, seed, generator version} and `placeholder`. Stacks stay `{itemId, qty}`: named and set items are
assets. Random ambient gear is either a pre-generated variant pool per zone (recommended: assets batch and icons
render once) or true per-instance rolls on the stack (a larger sheet change).

## 5. Keeping (gear soulbinding), as hooks

| Hook | Lives in | Meaning |
|---|---|---|
| `keepable: false` | item data | the top tier can never be kept; the generator sets it by rarity |
| `keep` reward kind; dialogue action `grantKeep` | rewards plan, quest, `npc` builtin | offer one item you hold; refused when not `keepable` |
| `kept: true` | stack on the character sheet | the stack cannot be looted |
| `maxKept` (e.g. 3) | progression asset | the server refuses the next kept item over the limit |
| `death-loot` rule | server builtin | "1 item from gear", chosen among non-kept equipped stacks, within the loot window |
| aggressor flag | netState `aggressor/<bodyId>` with expiry (~1 h) | while set, `kept` is ignored and the whole inventory is lootable |

## 6. Pipeline order: rows for `zonegen status`

| Row | Stage | Who | Gate |
|---|---|---|---|
| `rewards` (new) | planning, after `quests`, before `reserve` | opus (`brief-for rewards`) | `zonegen rewards`: rules 1-9, reads the neighbours' plans |
| `manifest` | existing | procedural | gains `item-theme` and `item-icon` rows |
| `freeze` | existing | procedural | digest includes `rewards.json` |
| `items` (new) | build, after `freeze` | procedural | every descriptor has an asset; re-running reproduces the same hashes |
| `art` | existing | gpt | theme rows done; placeholder items listed, not failed |
| `bind` | existing | procedural | quest `rewardItems` resolve to generated assets |
| `loot` (new) | build, after mob templates | procedural | every rare and boss template names its source rows |
| `play` | existing | procedural | quest-play proves each reward lands in bags, and a simulated kill of each rare and boss yields its named drop |

## 7. Build steps

Before combat is settled:

1. `rewardsSchema`, the `zonegen rewards` lint (rules 1-9) and its status row. **M**
2. Plan zone-5's rewards as the proving case. **S**
3. Manifest rows for set themes and icons. **S**
4. `itemSchema` additions: `level`, `source`, `keepable`, `set`, `placeholder`. **S**
5. `zonegen items` on a provisional budget; looks and icons through the existing tools. **M**
6. `bind` resolving descriptors; the quest-play reward check. **S**
7. Server `loot` builtin: per-player rolls, personal corpse window, caches. **M**
8. Keep hooks: `kept`, `maxKept`, `grantKeep`, the aggressor flag (data and refusals only). **M**

After combat settles:

9. The real budget table and modifier vocabulary; re-roll provisional items once. **M**
10. Ability parts on items and their generator rules. **L**
11. The death-loot rule and aggressor full loot. **M**
12. Set bonuses, if wanted. **M**
13. Standing with groups as a system (shelves, unlocks). **L**

## Owner decisions

- Gear binding is called: **keep** / soulbind (and rename the respawn bind) / another word?
- The kept limit counts: equipped kept items / every kept item owned?
- Cannot be kept: legendary only / epic and legendary / a per-item flag?
- Random ambient gear: a pre-generated variant pool per zone / true per-instance rolls?
- Set bonuses: yes, pieces worn together add something / no, a set is a look only?
- Standing with groups: build now as a counter with thresholds / wait for a reputation design?
- Boss loot: every eligible player rolls / one roll per party, then need/greed?
- Keep grants: at most 1 per zone / scaled by zone level / endgame zones only?
