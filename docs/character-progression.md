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
- Requests (`inventory.move/equip/unequip/drop/split`, `character.allocate`)
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
with `inventory.give`; listen for `inventory.dropped` to spawn a world item
where something was thrown away.

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
