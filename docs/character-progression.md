# Character progression & grid inventory

Levels, five attributes, a paper doll of equipment slots, and an
Arc-Raiders-style grid inventory — as one replicated document plus two
builtin scripts. This doc is the judgment half: the model, the invariants,
and the traps. Field lists live in the spec (`spec.json` → `dataAssets.item`,
`dataAssets.progression`, `netState.character`, `events.character.*` /
`events.inventory.*`, `scripts.character-sheet` / `scripts.character-ui`).

## The model in one paragraph

A **character sheet** (`packages/core/src/character/sheet.ts`) is one JSON
value: `level`, total `xp`, `unspent` points, `attributes` (strength,
dexterity, constitution, intelligence, wisdom), `equipment` (slot → stack uid)
and `items` (uid → `{ itemId, qty, container?, x?, y? }`). A stack with no
`container` is worn; one with `container: "pockets" | "bag"` sits at cell
`(x, y)` of that grid. **Every stack is exactly one cell** — there are no
item footprints, by decision. **Items** are data assets
(`assets/items/<id>.json`): slot kinds they fit, max stack, weight, flat
modifiers applied while worn, requirements, and for bags the grid they grant.
Slots have IDS (`helm … trinket, trinket2, primary, secondary, offhand, bag`)
and KINDS (`slotKind("trinket2") === "trinket"`); an item names kinds, so a
charm fits either trinket slot. **Progression** (`assets/progression/<id>.json`) is the
rule set: level cap, points per level, base attributes, the xp curve, the
pockets grid, and one linear formula per derived stat
(`base + Σ coefficient × attribute`; worn modifiers add after).

Every mutation is a pure reducer in core (`grantXp`, `allocate`, `addItem`,
`moveItem`, `equip`, `unequip`, `removeItem`, `splitStack`) that returns a
new sheet or a plain-English refusal — never a throw. `derivedStats` turns a
sheet into what a HUD or a controller reads: effective attributes, pools,
armor, weight, capacity, encumbrance, and the grids currently present.

**Durability.** An item may declare a maximum `durability`; a stack carries
its current points in `durability` (absent = full). `wearEquipped` (the
authority-internal `character.wear` event, emitted on death) takes 10% of
each worn item's maximum; a stack at 0 is broken and `derivedStats` skips its
modifiers. Repair is an NPC service — see docs/town-npcs.md.

**Instance data travels with the item.** Everything on a stack besides
`itemId`, `qty`, `container`, `x`, `y` is that instance's data (today
`durability` and rolled `twists`; the engine never reads twists). It is
opaque to the engine (`character/instance.ts`: `instanceOf`, `sameInstance`,
`canMerge`) and goes wherever the item goes, through one path: `removeItem`
hands back the loose stack WITH its data (`looseStackSchema`, the stack schema
minus the cell), and `placeStack` lands a loose stack with its data. The vault,
a shop's buy-back shelf (`shop/<id>.resale`), the ground (`ground/<dropId>`)
and a character-to-character `transferStack` all hold loose stacks, so a new
per-instance field on `itemStackSchema` travels everywhere with no other
change. Only identical instances merge (bags, vault, shelf); splitting copies
the data to both halves; a quest hand-in takes plain copies first. A transfer
may name fields the game marks resettable (`reset`); nothing else is dropped.

- **Loot bags** (`character/loot.ts`, `lootbag/<bagId>`): ONE
  container for everything lying in the world for someone — a creature's drops
  (`inventory.bag`, authority-internal, emitted where the kill is decided), a
  dropped stack (`inventory.drop` makes a new `dropped` bag at the dropper's
  feet), and what a killed character leaves their killer (a BODY bag, below).
  **Bags are take-only**: nothing is ever added to a bag once made — the paid
  vault is the one safe long-term storage, a bag is a claim window. An EARNED
  bag lasts `bagSeconds` (character-sheet, 3 days; `bagCap` 40 per owner,
  oldest removed first); a DROPPED bag lasts `dropSeconds` (600) and an owner
  may have `dropCap` (5) at once — past it a drop is refused. **Saved with the
  owner**: on a server with a save authority the layer packs the owner's live
  bags into the per-character record `lootbags/<bodyId>` on every commit
  (`packSavedBags`: lifetimes turned into wall-clock `expires`) and unpacks the
  bags of the scene a character spawns in (`unpackSavedBags`) — so a bag
  survives a logout and a restart, runs in REAL time, and is live only while
  its owner is online in its scene. With no save authority (local play, a P2P
  host, an open `serve`) bags live in netState while the world runs and are
  lost on a restart. `lootClock` is the wall clock (tests replace it). **Only the
  owner sees it**: the namespace is owner-only (`define(…, { audience:
  "owner" })`), so a dedicated server sends it to the owner's peer alone (a
  P2P host still replicates it to everyone; the `loot-ui` builtin draws only
  your own). `inventory.loot { bagId, index? | uid? }` (to-authority, owner
  and `pickupRadius` checked; anyone else is told "it is gone") takes one stack
  or everything that fits; what does not fit STAYS in the bag (part of a stack
  takes what fits; "no room for the rest"); `coins: true` / take-all bring its
  copper. `roomFor` tells a window what fits.
- **Body bags and the loot lock.** A body bag names a killed character
  (`body`) and what of theirs the owner may take, fixed at the death by the
  game: `carried` uids (any, as many as fit; `inventory.loot { uid }` or
  `{ all: true }`), `coins` (their copper; `{ coins: true }`) and a choice of
  `takes` from `offer` (worn gear). Every stack moves through the same
  hand-over as a transfer, data intact; what does not fit stays with the
  victim; `{ done: true }` leaves the rest. While it lasts the victim is
  **loot-locked** (`lootlock/<bodyId>`): their sheet refuses move, split,
  equip, unequip, drop and giving away, a pending inventory action is
  cancelled, and the `npc` builtin refuses them every service (shop, vault,
  repair, quests); belt use and weapon swaps still work. A server keeps a
  disconnected looted body (and so its sheet) until the lock ends, refuses to
  transfer it, and main sends a returning player back to that held body.
- **Corpses** (`inventory.corpse`, authority-internal, emitted where death is
  decided; a loot bag with `corpse: <the dead body>`). What the character
  carried in its grids — every stack but the ENTRUSTED — and all its copper
  leave the sheet into the corpse at the body (core `corpseContents`); worn
  gear stays on the character. With a killer's claim (`killer`,
  `claimSeconds`) the killer OWNS the corpse until `claimUntil`: they alone
  see it and take its contents, the money, and `takes` of `offer` (the dead
  character's worn gear, still on their sheet; the game decides the list); the
  dead character is loot-locked meanwhile. `{ done: true }`, the claim's time,
  or the killer leaving the server passes it to the dead character
  (`releaseCorpse`; empty = gone), who alone sees it until `seconds` (the
  whole lifetime from the death). A corpse is SAVED with its dead character
  like an earned bag — even while a claim holds it (`bagKeeper`) — and is
  never evicted by `bagCap`. `loot-ui` titles it "your corpse", and shows a
  claimed one to the killer in the body window's three parts.
- **Plundered** (sheet `plunderedUntil`, wall clock): a body bag or a claimed
  corpse with `plunder: <seconds>` plunders its victim when a worn item is
  taken; no looter may take another worn item from them until then (the take
  is refused; `isPlundered` lets a game leave the offer empty).
- **Soulbound SLOTS** (sheet `soulslots`: slot → stack uid, chosen at a soul
  binder — dialogue `openSoulbind`, request `soul.attune`, reducer
  `attuneSoulSlots`). An item is protected only while WORN in its slot and is
  the attuned instance (`soulProtected`): `transferStack` refuses it whatever
  the caller allows, a corpse's offer drops it. An item swapped into the slot
  in the field is NOT protected until it is attuned again; carried items never
  are. Re-attuning the same slots is free; changing WHICH slots costs the
  binder's `price` (a first choice is free); `slots` caps the count;
  `exclude` (default the bag and the belt) cannot be chosen. `character-ui`
  marks an enchanted slot with a rune — ◆ while it holds its attuned item, ◇
  struck through while it holds another — and the tooltip says which, in
  words (`soulStatus`). Console override: `/soulbind <slot|uid|itemId> [off]`
  (authority-internal `inventory.soulbind { slot, bound }`, no cap, no price).
  The old per-instance `soulbound` flag is GONE (a saved stack carrying it
  parses without it).
- **Entrusted items** (item `entrusted`, optional `entrustedQuest`): specific
  quest items in the character's keeping. `transferStack`, `vaultDeposit`,
  `shopSell` and the sheet's drop refuse them; `corpseContents` leaves them on
  the character; a dialogue `turnInQuest` of their `entrustedQuest` takes every
  carried one back (`takeEntrusted`). The schema refuses `entrusted` on an
  equippable item. Not built: there is no quest ABANDON in the engine yet, so
  an entrusted item without a hand-in leaves only through `consume` / `take`.
- **Broken gear**: at 0 durability an item stays worn and drawn but adds no
  modifiers (`wornItems` skips it, so `derivedStats` — and every combat read of
  the published stats — ignores it); it is never destroyed; the tooltip says
  "Broken … no stats until repaired". Repair cost is `value × missing/max ×
  rate`: item `value` already climbs with tier and rarity (MMO items: common
  25–420 c, uncommon 150–2750, rare 1500–9000, legendary 40000).
- **Party loot** (`inventory.bag { share: true }`): the owner's party
  (`comms.party/<peer>`) members within `partyRange` (60 m) share the kill —
  items at or above `rollRarity` (uncommon) go to a need/greed/pass roll
  (`lootroll/<rollId>`, `loot.roll` to answer, `rollSeconds` 45, no answer =
  pass; any need beats every greed, then a server 1–100, ties re-roll; all
  pass = the killer's; `loot.rolled` announces it), the rest round-robin, the
  copper splits evenly; each member's share and each win is a new bag of
  their own at the corpse. Not in a party, or alone in range: unchanged.
- The `loot-ui` builtin is the client: the ground prop (a clone of a hidden
  `template` entity; `dropTemplate` / `dropIcon` for your own dropped items),
  a "[F] Loot" prompt, the take window with the inventory's tooltips
  (`fillItemTip`) — a body window in three parts (money, their bags, worn: choose
  one) — and the roll prompts (icon, full tooltip, Need / Greed / Pass, a
  timer) with one chat line per settled roll.
- **The shared ground.** `ground/<dropId>` (`groundItemSchema`) is an item
  ANYONE may pick up (`inventory.pickup { dropId }`, within `pickupRadius`;
  what does not fit stays). Nothing in the engine writes one any more (a drop
  goes into a loot bag); it stays as the primitive for a game that wants
  public ground loot.
- **Character to character.** `inventory.transfer { actorId, toActorId, uid }`
  is authority-internal (a peer cannot send it): both bodies present, within
  `range`, room for all of it, both sheets or neither; `allowWorn` lets a loot
  take worn gear. It announces `inventory.transferred`. There is no trade
  window yet; this is the primitive one calls once both sides agreed.

## Gear is the bar: skills, timed equips, weapon sets, the belt

**Items carry skills** (`skills`, ids opaque to the engine): `primary` (left
click while it is the weapon in hand), `secondary` (right click: an ability or
a game-reserved guard verb such as `@block`), `bar` (hotbar skills — a
one-hander, an off-hand item and a trinket contribute ONE, a two-hander TWO;
`skillAllowance` / `auditItemSkills` report a file that declares more), `use`
(what a consumable does from the belt) and `guard` (`kind`, `parryWindow`,
`blockPower`, `wardAlly`, `school`, `reward` — tuning the game resolves). A
game builds its bar from these; the engine only stores and replicates them.

**Equips take time and stop in combat.** `equipSeconds` on an item beats the
progression's `inventoryDurations` (replacing a worn item takes the longer of
the two; `actionSeconds` computes it). The `character-sheet` param
`combatLock` names a netState namespace whose `<ns>/<bodyId>` holds a sim time
(ms) the body is fighting until — the MMO uses `transferLock`. While it is in
the future, anything that puts gear on or takes it off (`changesWornGear`:
equip, unequip, moving or dropping a worn stack) is refused, and a change
under way is cancelled with the item left where it was. Rearranging the bags
is never locked.

**Two weapon sets.** Set 0 is `primary` + `offhand`, set 1 is `secondary`
alone (two-handed weapons list `secondary` among their slots to be swappable).
Which is in hand is netState `hand/<bodyId>` (`handStateSchema`: `set`, and
`swapTo`/`swapFrom`/`swapUntil` while a swap is pending, for a progress bar).
A `character.swap` request (the `weapon-stance` `swapKey` sends it) lands after
the sheet's `swapSeconds` and IS allowed in combat; swapping to an empty
secondary is refused. `weapon-stance` and `equipment-look` (`inHand`, default
on) show the set in hand: a `primary` look draws the secondary item, an
`offhand` look draws nothing. `itemsInHand(sheet, set, env)` is the one rule
(a two-hander leaves the off hand empty).

**The belt** is `consumable`, `consumable2`, `consumable3` (`BELT_SLOTS`; a
whole stack sits in each). `inventory.use { slot }` removes one (`useItem`),
starts the shared cooldown (`useCooldown`, sheet `beltReadyAt` in sim ms,
never saved) and announces `inventory.used { itemId, skill }`; the GAME applies
the effect — on the authority, from a local emission only. Use works in combat.
`character-ui` shows a listed slot's numbered siblings (`expandKinds`), so a
scene listing `trinket` and `consumable` gets both trinkets and the whole belt.

## Who owns what at runtime

- `character-sheet` (builtin, attach to the body or a child with `actor`)
  owns the sheet **on the session authority**: it seeds a fresh one from its
  params (or inherits the replica on a promoted host), writes it to netState
  `character/<bodyId>`, and answers request events by running a reducer.
- `character-ui` (builtin, `clientOnly`) is a **view**: it renders the
  replica and turns every drag, double-click and "+" into a request event.
  It never writes the sheet, so the same script is correct on a peer, a P2P
  host, and a client of the dedicated server.
- **Stashes** (a bank vault now; a guild bank or mailbox later) dock beside the
  bags. The stash script dispatches `hitreg:inventory-stash` on `window` with
  `{ owner, label, quickMove(uid, qty?) }` (and `{ owner, closed: true }` when
  it closes). While linked, `character-ui` shows a bags-only window beside it
  (no scrim, no keyboard capture, no filters), right-click / double-click call
  `quickMove` (shift = one), and a drag onto any element marked
  `data-drop="external"` fires a bubbling `hr-item-drop` DOM event there with
  `{ uid, actorId, fromSlot }`. The bag grids carry `data-container/cols/rows`
  so a stash can drop into a specific cell. `npc-ui`'s vault is the reference.
- Requests (`inventory.move/equip/unequip/drop/split/use`, `character.allocate`, `character.swap`)
  are `to-authority`; a request arriving over the wire must come from the
  peer that owns the body (`owner/<bodyId>` in netState, written by the
  server). Grants (`character.xp`, `inventory.give`) are **not replicated at
  all** — only an authoritative script can emit them where they are heard, so
  a client cannot award itself anything. Refusals come back as
  `character.refused` and the UI toasts them.
- Derived stats are mirrored onto the body's `object.userData.character`
  (and `userData.encumbrance`) on every change, on every role. A movement or
  combat script reads weight from there without knowing where the sheet
  lives; the UI reads the grids from there so it never needs the
  progression id.

Persistence today is the local player only, through `ctx.playerData`
(namespace `character`, key `sheet`), restored on start — the §3c dev
convenience. The dedicated server does not save yet; when it does, it saves
this same document.

## Invariants that break silently

- **Zod 4 `.default({})` does not fill inner defaults — use `.prefault({})`.**
  Every nested object in the progression and sheet schemas does; a new one
  that uses `.default({})` parses to an empty object and every formula
  evaluates to 0 with no error anywhere.
- **`registerBuiltinScripts(registry, events, assets)` — pass the event
  registry.** Builtins declare their contracts with `static events`; without
  the registry a `to-authority` request has no declared direction, stays on
  the peer, and looks exactly like "the inventory does nothing in
  multiplayer". Every host (playground, published build, server) passes it.
- **A bag must be empty to be swapped, removed or dropped**, and a displaced
  bag never goes into the bag that replaced it. The alternative — silently
  spilling or deleting contents — is worse than the refusal.
- **One stack, one cell.** A `size` field in an item file is ignored (the
  schema strips it). Landing a stack on another either merges (same item,
  stackable) or swaps — every swap fits, so there is no "does not fit" case.
- **Worn items still weigh.** Encumbrance is over everything owned; a
  controller that wants only carried weight subtracts `equipment`.
- The UI captures the keyboard while open (`ctx.input.captureKeyboard`), so
  WASD and ability keys stop; it also exits pointer lock. A menu that forgets
  to release is released by the runtime when its script disposes.
- Editing an item file while the game runs updates every copy immediately
  (ScriptableObject semantics, live-synced); editing its `size` can leave an
  existing stack overlapping another — the next move will refuse with a
  clear message. Restart play to reseed.

## The portrait

The middle of the paper doll is a live model of the character:
`ctx.renderPortrait(bodyId, canvas)` (host hook; `PortraitView` in
`@hitreg/render`). The body's runtime object is cloned with SkeletonUtils
into a private scene with its own lights, camera and WebGPU renderer on a
transparent canvas, running its OWN AnimationMixer on one clip — the idle
(`portraitClip`, default "Idle", falling back to any `*idle*` clip) — so the
portrait stands calmly whatever the character is doing in the world. The host
passes the model's clips (`AnimationSystem.clipsOf(bodyId)`); with none, the
clone mirrors the live bones instead. Geometry, materials and textures are
shared; dispose tears down only the renderer, the mixer and the clone. The
UI mounts it when the screen opens and disposes it on close (no cost while
closed). Sprites, lights, particle pools and billboards under the body are
hidden in the clone and excluded from the camera fit. `portraitSpin` turns it
into a turntable; the retargeted rigs face +Z, so the camera sits at +Z
(`forward: -1` for a model authored the other way).

## Skinning the UI

Panels, cells and slots are CSS 9-slices (`border-image`). Drop a PNG frame
into `assets/textures/` and point `panelSkin` / `slotSkin` at it, with
`panelSlice` / `slotSlice` as the inset in source pixels and `panelBorder` /
`slotBorder` as the drawn width. Without a skin a generated SVG frame stands
in. Everything else is plain CSS under `.hr-char` (one `<style>` block in
`packages/scripting/src/character-ui.ts`), written to be overridden by a
game's own stylesheet. Item icons are texture ids on the item (`icon`); an
item without one shows its initials in its rarity colour.

## Wiring a scene

```json
"player-sheet": { "parent": "player", "components": { "transform": {}, "script": {
  "name": "character-sheet",
  "params": { "actor": "player", "progression": "default",
              "startingItems": [ { "itemId": "satchel", "equip": true }, { "itemId": "health-potion", "qty": 3 } ] } } } },
"character-ui": { "parent": null, "components": { "transform": {}, "script": { "name": "character-ui" } } }
```

Put the bag first and `equip` it so the rest of the starting items have a
grid to land in; the pockets alone are small by design. A kill/quest script
grants with `ctx.events.emit("character.xp", { actorId, amount })`, a pickup
with `inventory.give`; a thrown-away stack lies in netState `ground/<dropId>`
(announced by `inventory.dropped`) until someone sends `inventory.pickup`.

## Character creation

One more data asset, `assets/creation/<id>.json` (type `creation`,
`characterCreationSchema`): **archetypes** (a small attribute lean plus the
paths it can grow into — a lean, not a class), **birth traits** (each names
an ability id; `traitPicks` of them), and **appearance slots** (ordered;
each option may name a `model` and the `socket` bone it rides on, and may
`require` choices in slots above it). What a player picks is a **build**
(`characterBuildSchema`: archetype, traits, appearance).

The path a build takes, and the one rule that keeps it honest — only the
sheet authority turns a build into points:

1. The gateway panel asks main `GET /creation` (else the game's local asset)
   and, when there are rules, "New character…" opens the creation screen
   (`apps/playground/src/character-creation.ts`, preview in
   `creation-preview.ts`). `?creator[=<id>]` opens it alone, no gateway.
2. `POST /characters { name, build }` — main validates against its rules
   (`--creation <id>`, default the only `creation` asset) and stores the build
   on the character. With rules loaded, a character without a build is refused.
3. `/play` signs the build into the ticket; the layer writes
   `build/<bodyId>` before the body spawns.
4. `character-sheet` with a `creation` param re-validates it and, on a FRESH
   sheet only, applies it (`applyBuild`: archetype lean + `sheet.build`). A
   saved sheet already carries its build, so a later ticket changes nothing.

**Traits per archetype:** a trait's `archetypes` list says which archetypes
offer it (absent = all); `traitsFor` / `settleTraits` keep a build's picks
legal when the archetype changes, and `validateBuild` refuses a trait from
another archetype.

**The game's look:** the asset's optional `ui` block names the game's own UI
pieces — 9-slice `panel`/`button`/`buttonActive`/`card`/`cardActive`
frames, `backdrop`, `divider`, `crest`, `close`, stepper `arrow`
(points right; mirrored for left), `font`, `colors`. The creation screen AND
the gateway's sign-in/character card wear it; archetype and trait `icon`s sit
in the card frame at 64 px. Without `ui` both draw the engine's plain look.
Generated UI art is drawn at 2× and halved nearest-neighbour so its pixels
match the rest of the kit. Choices are 9-slice buttons (frame EDGES only — a
stretched `fill` centre warps the art) with the icon centred and the chosen
one's details underneath. Both screens are laid out for 1080p and scaled up by
CSS zoom on bigger monitors (`watchUiScale`), never down; short screens get
compact rules instead.

**Preview rows** (`preview: true` on a slot) are the creator's art-viewing rows;
`validateBuild` drops them, so a saved build never carries them and the game
never draws them. **Archetype kits** (`archetypes[].startingItems`) are worn
first on a fresh sheet, before the script's own `startingItems`, which never
displace a worn kit piece. **Mounts** (`mounts`) place every socketed model
(head, hair, helm, pads) once, per sex where they differ; the in-game
`character-look` builtin and the creator both read them (docs/armor-sets.md).

Every peer reads appearance and traits from `sheet.build`. Options without a
model are valid choices that draw nothing yet — appearance is late-bound.
