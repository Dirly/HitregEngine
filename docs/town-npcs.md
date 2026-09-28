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
| `shop/<shopId>` | the shop's shelf: limited stock left, goods players sold here | no (world state; restocks) |
| `character/<body>` | the sheet — now with `coins` (copper) | yes (as before) |

The server commits `quests/`, `npc/` and `vault/` beside the sheet in the
`character` player-data record (core `PERSISTED_PLAYER_NAMESPACES`) and writes
them back into netState before the body's scripts start. In local play the
`player-records` builtin does the same through `ctx.playerData`.

Money is one integer in copper (100 copper = 1 silver, 100 silver = 1 gold;
core `formatCoins`). An item's `value` is its base price; a shop sells at
`value × markup` and buys at `value × buyRate`.

## The builtins

- **`npc`** (on the NPC root, tagged `interactable`): `name`, `title`,
  `dialogue`, optional `shop`, `vault`, `radius`. Decides every request, ends a
  conversation when the player walks off, restocks its shelf, and (presentation)
  turns its `<id>-visual` toward the local player while they talk.
- **`npc-ui`** (once per scene, client only): the "E Talk to …" prompt, the
  conversation, and the shop / vault windows. 1–9 pick a line, Escape leaves.
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
  memory flags, `met`, level, carried items, coins, and `all` / `any` / `not`.
  Actions: `acceptQuest`, `turnInQuest`, `openShop`, `openVault`, `setFlag`,
  `clearFlag`, `give`, `take`, `pay`, `reward`.
- **Quest** (`assets/quests/<id>.json`): objectives `visit` / `kill` /
  `collect` / `talk`; `giver`, `turnIn` (set = READY until handed in),
  `requires` (a chain), `consume`, `rewardXp` / `rewardCoins` / `rewardItems`,
  optional `area` (the compass's search region; errands in town have none and
  the HUD points at the NPC instead).
- **Shop** (`assets/shops/<id>.json`): `stock` (what it OWNS — unlimited, or a
  limited `qty` that comes back one per `restockSeconds`), `markup`, `buyRate`,
  `buys` (item kinds/tags it deals in), `resale` (how many player-sold goods it
  keeps on the shelf).

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
   an inn), then quest givers who embody the story's conflicts, then guards and
   a few townsfolk. 10–15 is a town; every one is a skinned body (one draw
   each) — keep crowds for batched ambient work, not here. Give each a
   `place` (`at` [x, z], `face` [x, z]) on flat, reachable ground: check the
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
