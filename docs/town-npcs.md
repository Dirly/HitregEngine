# Town NPCs: story, residents, dialogue, shops, the vault

How a town gets its people: a story that says why the place exists and who
lives there, a roster of residents placed on the real ground, what each of them
says, sells or keeps, and the quests they hand out. Everything is data; one tool
lints it and writes the scene. The engine side is generic (any game with the
modular human and the character sheet); the worked example is the MMO project's
starting capital, Brinehold (`projects/voxel-demo/authoring/towns/brinehold.json`,
readable version `projects/voxel-demo/docs/towns/brinehold.md`).

Related: `docs/armor-sets.md` (outfits: a town's look is armor-set work),
`docs/character-progression.md` (the sheet, items), `docs/voxel-worlds.md`
§"Stories: what one zone is FOR" (the zone story a town sits inside).

## Rule: directions come from the world, never from the writer

Quest and NPC text never carries a literal compass word (north, south-west,
"the eastern cove"). It names a PLACE and the direction is computed from the
world the text runs in: `{dir:cove}` → "north-west", `{Dir:cove}` →
"North-west", `{far:cove}` → "a short walk", `{place:cove}` → its name. Every
server generates its own world, so a written direction is a guess that goes
stale — and Brinehold first shipped with every north/south flipped (north is
**-Z**: the HUD compass, core `bearing`). The town's people know their world:
the tool generates `assets/places/towns/<town>.json` from it — residents (so
"the Captain on the {dir:captain-maera} wall" is measured from the plaza), the
gates, the doc's `places` (a POI, a camp entity, a town or a point), towns
within 3 km and every continent's capital — and `docs/towns/<town>.md` prints
it as a Geography table to write from. Quests of the town set
`"places": "towns/<town>"`; the `npc` builtin fills dialogue on the server and
the HUD fills quest text (core `fillPlaces`). The lint refuses any literal
compass word in quests, dialogue and the story, and any unknown place id.

## The backend: what the server owns

Nothing a client says is trusted. A player ASKS; the `npc` builtin on the NPC,
running on the session authority (the dedicated server, or a solo tab), checks
the sender owns the body, stands within `radius`, that the choice is one the
current node offers and that its condition holds NOW, then runs the choice's
actions all-or-nothing. What it decides lives in replicated netState:

| key | what | saved |
| --- | --- | --- |
| `dialogue/<body>` | the open conversation: node, the line as resolved, the choices this character may pick, an open shop/vault window, a refusal notice | no (transient) |
| `npc/<body>` | NPC memory: who the character has met (`met`) and what it was told or did (`flags`) | yes, with the character |
| `quests/<body>` | the quest journal (active / ready / complete) | yes, with the character |
| `vault/<body>` | the bank vault: positional slots (`items[i]`, null = empty — a stack keeps its slot) + coin, the same vault at every banker | yes, with the character |
| `bind/<body>` | the HEARTH bind: `{ at: [x, y, z], name }`, where the character respawns (set at an innkeeper) | yes, with the character |
| `shop/<shopId>` | the shop's shelf: limited stock left, goods players sold here | no (world state; restocks) |
| `character/<body>` | the sheet — now with `coins` (copper) | yes (as before) |

The server commits `quests/`, `npc/`, `vault/` and `bind/` beside the sheet in the
`character` player-data record (core `PERSISTED_PLAYER_NAMESPACES`) and writes
them back into netState before the body's scripts start. In local play the
`player-records` builtin does the same through `ctx.playerData`.

Money is one integer in copper (100 copper = 1 silver, 100 silver = 1 gold;
core `formatCoins`). An item's `value` is its base price; a shop sells at
`value × markup` and buys at `value × buyRate`.

## The builtins

- **`npc`** (on the NPC root, tagged `interactable`): `name`, `title`,
  `dialogue`, optional `shop`, `vault`, `radius`, `bindPoint` / `bindName` (the hearth: an innkeeper). Decides every request, ends a
  conversation when the player walks off, restocks its shelf, and (presentation)
  turns its `<id>-visual` toward the local player while they talk.
- **`npc-ui`** (once per scene, client only): the "E Talk to …" prompt, the
  conversation, and the shop / vault / repair windows. 1–9 pick a line, Escape leaves.
  The vault is a bank window in the WoW/EQ shape: a slot grid (`vaultColumns`,
  `cellSize`) with the character's bags docked beside it — npc-ui links itself to
  `character-ui` as a *stash* (`hitreg:inventory-stash`, see
  docs/character-progression.md). Drag either way (onto a slot or a bag cell:
  empty takes it, same item tops up, a different whole stack swaps), right-click
  or double-click sends a stack across (shift = one), drag inside the vault
  rearranges it. Requests: `vault.deposit {uid, qty?, slot?}`,
  `vault.withdraw {index, qty?, to?}`, `vault.move {from, to}`, `vault.coins`.
  `cssClass` hands styling to the game (`mmo-screen` in the MMO).
- **`quest-log`** (on the player): advances the journal from kills (`killEvent`),
  carried items, standing in an area, and conversations (`npc.talked`).
  `autoStart` seeds a fresh journal (a "go and see the Warden" quest).
- **`player-records`** (on the player): local-play saves of the above.
- **`nameplates`** (once per scene, client only): name tags over players (the
  server's `name/<body>`) and NPCs (name + <title>), DOM through the host's
  `ctx.worldToScreen` (no draw calls), titles dropped past `titleDistance`.
  Over NPCs: **!** a quest this character can take (within 3 levels), **?** one
  waiting to be handed in — read from the NPC's dialogue and the journal.
- **`equipment-look`** with `item`: a fixed held item (an NPC's sword) instead of
  a sheet slot. The `npc` param `holstered` sheathes held items (their socket's
  second pose, on the hip or back).
- **`character-look`** with `appearance` + `wear` params: a sheet-less character
  (a townsperson) dressed from a fixed build and a list of item ids.

## Data

All schema-validated; the exact fields are in the schemas' `.describe()` text
(`spec.json` / `GET /__hitreg/spec`), not repeated here.

- **Dialogue** (`assets/dialogues/<id>.json`): `start` is a list of
  `{ if, node }` — the first that holds opens the conversation, so put hand-ins
  and first meetings before the plain greeting. Each node has `text` (a list =
  small talk, one line per visit; `{name}` and `{npc}` are filled in) and
  `choices` (`text`, `if`, `do`, `goto`, `"end"` closes). Conditions test quest
  status (`none` / `available` / `active` / `ready` / `complete` / `taken`),
  memory flags, `met`, level, carried items, coins, `bound`, and `all` / `any` / `not`.
  Actions: `acceptQuest`, `turnInQuest`, `openShop`, `openVault`, `openRepair`,
  `bindSoul`, `setFlag`, `clearFlag`, `give`, `take`, `pay`, `reward`.
- **Quest** (`assets/quests/<id>.json`): assembled from registered blocks —
  a source, objectives whose `kind` is an action block, `when` conditions and
  `then` consequences. The block list is the spec's `questBlocks` (only what
  the runtime implements is there); `giver`, `turnIn` (set = READY until
  handed in), `requires`, rewards and `area` (the compass's search region;
  errands in town have none and the HUD points at the NPC instead) are as before.
- **Shop** (`assets/shops/<id>.json`): `stock` (what it OWNS — unlimited, or a
  limited `qty` that comes back one per `restockSeconds`), `markup`, `buyRate`,
  `buys` (item kinds/tags it deals in), `resale` (how many player-sold goods it
  keeps on the shelf). The buy-back shelf (`shop/<id>.resale`, shared by every
  player, not saved) keeps each sold instance whole — wear and twists — and
  only identical instances share an entry; `shop.buy { resale: <index> }` buys
  that exact one. Past `resale` entries the oldest is destroyed.

## Quest mechanics: judgment the schema cannot carry

- **Who offers it.** A person (`npc` source) is the default because a person
  explains. Use an `object` source when the world itself should start the
  story — a notice board, a carved stone, a satchel by a corpse: the same
  `npc` builtin with `face: false` (plus `readable: true` when it is text to
  read). Use an `auto` source (`autoOffer` on the player's quest-log) for what
  happens TO the player — standing somewhere, the night falling, a flag a
  previous step set. Use a `presence` source (the `npc` param `presence`, or
  the `presence` builtin on a thing) for someone who is only there sometimes
  — at dusk, in the rain. A zone where every quest comes from a person reads like a
  job board; the zone lint warns about it.
- **A started quest is always in the journal; only the START is unadvertised.**
  An NPC giver gets a marker. An object, a presence or a place gets none, and
  nothing points the compass or the map at it: players find those through
  leads — a rumour a resident lets slip, lore on something they can read, a
  sight at a place. A lead names the place and gives circumstances in words
  (when, what was seen, who went and did not come back); it never gives a
  direction or a distance, never starts the quest, and is found somewhere else
  than the start. The compass belongs to the objectives of quests already
  started.
- **Shared world.** Progress is always per character. A block may read the
  world (clock, weather) but nothing a player does may consume, lock or
  toggle a world thing another player needs: a lever pulled, a cairn given
  tokens or a stone danced at stays exactly as it was for everyone else. If a
  quest seems to need a shared change, it needs a per-player one instead.
- **Steps in another town** name their own `places` (and `area`), so their
  directions are given from that town, not the giver's.
- **Clock and weather gates** are read on the authority; a gated step should
  say so in its label, or the player retries in daylight and decides the quest
  is broken. Weather falls as the biome's kind, so "in the snow" is a
  precipitation band plus the snow biomes.

## Services every town has: a hearth, a soul binder and a repairer

**The hearth (respawn).** The innkeeper keeps it (ruling 2026-10-07: you wake at the tavern). The action id is still
`bindSoul` — kept for every existing dialogue and save; it binds the RESPAWN, not gear. The innkeeper's dialogue offers `{ "do": "bindSoul" }`: the
character's respawn point becomes this NPC's `bindPoint` param ([x, y, z]
world; empty = the NPC's own position), named `bindName` (empty = the NPC's
name), written to `bind/<body>` and saved with the character. The condition
`{ "bound": true }` holds when that bind sits at THIS binder's point (1 m), so
the innkeeper can greet the already-bound differently. A player who dies respawns
at the bind (scattered a metre or two), else at the nearest sanctuary — the MMO
project's `combat-actor` `respawn()`, on the authority. In a town doc, a
resident's `bindPoint` / `bindName` fields pass straight to those params.

```json
"start": [{ "if": { "bound": true }, "node": "kept" }, { "node": "hello" }],
"nodes": {
  "hello": { "text": "Fall out there and you wake by my fire.", "choices": [{ "text": "Keep a place by your hearth for me.", "do": [{ "do": "bindSoul" }], "goto": "kept" }] },
  "kept":  { "text": "Your name's on the slate by the hearth." }
}
```

**The soul binder (soulbound slots).** Its dialogue offers
`{ "do": "openSoulbind", "slots": 3, "price": 5000 }` (`exclude` defaults to the bag and the belt): a window
listing every worn slot; the player chooses up to `slots` and presses Attune (`soul.attune { slots }`, decided by the
`npc` builtin). Each chosen slot is attuned to the item worn there NOW (sheet `soulslots`); that item cannot be
looted from the character while it stays worn there. Re-attuning the same slots is free (that is how a new item
is protected); changing which slots are chosen costs `price` copper (the first choice is free). Details:
docs/character-progression.md (soulbound slots, corpses, entrusted items).

```json
"soul-offer": { "text": "Choose up to three things you wear…", "choices": [{ "text": "Bind what I wear.", "do": [{ "do": "openSoulbind", "slots": 3, "price": 5000 }] }] }
```

**Entrusted quest items** (item `entrusted`, optional `entrustedQuest`) cannot be sold, put in the vault, dropped,
traded or looted, and stay with the character through a death; handing in `entrustedQuest` takes them back.

**Durability and repair.** Weapons, shields and armour declare a maximum
`durability`; each owned instance keeps its current points on its stack
(absent = full, so old saves load whole). Each death costs every WORN item 10%
of its maximum, rounded up, at least 1 (core `wearEquipped`, fired by the
authority-internal `character.wear` event the death handler emits). At 0 the
item is **Broken**: still worn and drawn, but its modifiers stop counting;
the bags show it with a "Broken" line and a red rim. A repairer's dialogue
offers `{ "do": "openRepair", "rate": 0.25 }` (rate optional, default 0.25):
the window lists every damaged worn and carried item at
`ceil(value × missing / max × rate)` copper (at least 1 for any damage) plus
Repair all. Requests `repair.item {uid}` and `repair.all` are decided by the
`npc` builtin on the authority; Repair all is all-or-nothing (refused unless
the purse covers the whole bill). Wear survives the vault.

```json
{ "text": "Mend my gear.", "do": [{ "do": "openRepair" }] }
```

The MMO project rates its items with `projects/foundation/tools/item-durability.mjs`
(weapons/shields 60–100, armour 40–80, by rarity; heavy armour +10).

## Making a town, in order

1. **Read the place.** Where it is (world, town id, terraces, gates, the sea),
   its climate (`field.biome(x, z)`: temperature, moisture), and the zone story
   around it (`worldgen story`, spawn areas nearby). The town's troubles come
   from its zone: Brinehold is downstream of a ratkin plague.
2. **Write the story** in `authoring/towns/<name>.json`: what the town is, why
   it is HERE (a reason a new arrival lands in it), what is going wrong now,
   who holds power, and the relationships — kin, rivals, debts, secrets. Each
   relationship should be usable: a line of dialogue, a flag, a quest. List the
   hooks that will become quests.
3. **Cast the residents.** Services first (banker, general goods, arms, clothes,
   an inn (its keeper keeps the hearth: `bindSoul`), a soul binder (`openSoulbind`), someone who repairs — a smith or the arms dealer), then quest givers who embody the story's conflicts, then guards and
   a few townsfolk. 10–15 is a town; every one is a skinned body (one draw
   each) — keep crowds for batched ambient work, not here. Give each a
   `place` (`at` [x, z], `face` [x, z], and `inside`: the building's scene id
   when they stand indoors, so the tool parents them under its `culling.interior`
   unit and they are hidden from outside; every resident also gets
   `culling.minScreenPx: 6`) on flat, reachable ground: check the
   height grid, never on a ramp, never with their back to a wall's edge
   (players must be able to stand in front). Pick `anim` from the rig's idles
   (`Idle`, `Idle_FoldArms`, `Idle_LookAround`, `Idle_Tired`, `Idle_Lean`,
   `Idle_Lantern`, work clips).
4. **Arm the ones who carry arms.** `hold: { primary, offhand, holstered }` per
   resident; the tool copies the socket (bone, fitted offsets, sheathed pose)
   from the doc's `weaponRig` prefab — the one that socketed that model for the
   player — so NPC grips are the player's fitted grips, never new numbers.
   Guards on duty hold (`SwordShield_Idle`, `TwoHanded_Idle`); off duty,
   `holstered`.
5. **Dress them for the place.** Climate and class decide the outfit; a new
   look is an armor set (`docs/armor-sets.md`), and every outfit is items —
   sellable at the clothier. `wear` lists the items; `fallback` lists existing
   items the tool uses while art is missing. Appearance choices come from the
   creation asset's options (sex, skin, face, hair, hair colour, beard).
6. **Write the dialogue**, one file per resident: a first meeting (`met:
   false`), repeatable small talk (a text list), their services, story
   branches gated by quest status and flags, and hand-ins before greetings.
   Let residents talk about each other — that is where the relationships show.
   Chain flags between NPCs (one says something, another reacts to it).
7. **Quests and shops.** An arrival quest `autoStart`ed on the player that
   sends them to the town's leader; a tour quest with `talk` objectives that
   introduces the services; then work that points out into the zone.
   Kill/collect targets must exist: a spawn-area template that can DIE
   (a combat child) and drop what `collect` asks for (`loot`).
8. **Generate and lint:**
   `npx tsx tools/town-npcs.mts --project <p> --town <name> [--lineup <scene> --with hud,character-ui]`
   It refuses to write while anything is missing or inconsistent (a dialogue
   handing in a quest that is not its `turnIn`, a shop the resident does not
   own, an unknown item, an appearance option that does not exist) and
   validates every component it writes. `--check` lints only. `--lineup` also
   writes a review scene: everyone in an arc on a lit floor, talkable.
9. **Look and play.** Open the lineup: every outfit on the right body (both
   sexes), faces and hair right, nobody in the base layer by accident. Then play
   the town: arrival → leader → tour → hand-in → buy → bank, and one conversation
   per resident.

## Traps (found building Brinehold)

- **Rigidbody `static`, not `fixed`.** One bad component value fails the whole
  scene load; the tool validates against the component registry for this reason.
- **Shared ubermesh geometry.** Many skinned bodies of one model share a
  geometry; the part mask must give each MESH its own index
  (`applyModelPartMask`, ownership on the mesh). Before the fix the last NPC
  dressed chose every body's parts and the rest drew the base layer.
- **Placement off a wall's edge.** An NPC facing out over a terrace edge puts
  the talking spot in mid-air; face them into the plaza.
- **Fresh characters need coins** (`character-sheet` `startingCoins`), or every
  shop row is greyed out.
- **Placeholder mobs cannot die** without a `combat-actor` child — a kill quest
  against them never completes.
