# Armor sets: from one outfit's art to wearable items

How a player armor SET is made (body, helm and shoulder art that match) and
then broken into ITEMS, one per equipment slot, each naming the parts of a
shared model it shows. The unwrap/key/generator/import steps for each model are
in **docs/mob-atlas.md** and **docs/weapon-atlas.md**; how an item's look is
drawn is **docs/item-looks.md**; icons are **docs/item-icons.md**. This doc is
the order those go in for armor, and the slot rules.

For the current foundation-specific starting point, including fitted headwear,
native masks, shoulder/tasset choices and the latest repair examples, read
[`foundation/authoring/armor-sets/README.md`](../apps/playground/projects/foundation/authoring/armor-sets/README.md).
It also names the source producers and Play checks a fresh agent must preserve.

Worked example: the MMO project (voxel-demo) outfits vanguard, magus, ranger,
cleric.

## The three models every set paints

| model | what it is | sheet | built by |
| --- | --- | --- | --- |
| `mmo/human-body.glb` | the SKINNED body: male + female parts in one mesh (female stored at male size, the character drawn at 0.96) | 256px on Derek's own UV layout (key `tools/atlas/sets/human-body/key.png`, rasterized from the OBJ's UVs) | `tools/reskin.mjs` (docs/character-animation.md → reskin) |
| `mmo/human-helm.glb` | headgear ubermesh on the head socket | 132px | `unwrap-weapon --recipe human-helm` + `weapon-page` |
| `mmo/human-shoulder.glb` | one shoulder pad, mounted on the left collarbone plus a mirrored copy on the right | 112px | `unwrap-weapon --recipe human-shoulder` + `weapon-page` |

All three are at the body's density (109 texels/m, nearest-filtered). One model
= one packed PAGE of every set's sheet = one draw for every character wearing it.

Measure independent native UV layouts at their own tile size. A cloth cap or
native face plate sharing the helmet page does not use the ordinary helmet
key: including it in the key sheet's area average can fail otherwise valid art.

Judge density on the worn character at its actual encounter scale. A larger page
may retain coarse base paint while carrying finer selected ornaments; page size
alone does not describe the visible pixel scale. Keep shoulder bases consistent
with the outfit when increasing the detail of a small cutout.

The foundation helm now supports reusable native facial masks, a closed rear cap,
a separate crown fitted over a hood, and a soft peasant cap. Their source and
rebuild guide is `apps/playground/projects/foundation/authoring/helm-system/README.md`.
Native-layout masks and cloth caps select their own packed paint rather than an
ordinary helm-key sheet. Separate wear pieces can still share one mounted ubermesh
and use its per-part paint groups. The original crown retains its bare-head fit.

## Kits and instance sets

A brief is one of two kinds (`kind`):

- **instance** — a DUNGEON's loot, and the default for any dungeon. One theme (the SUBJECT), 1-2 MIXED body sheets
  whose regions each carry an armour weight (`bodies[].weights`: a plate chest, leather trousers, mail hands…), ONE
  helm and ONE shoulder sheet whose parts are painted in several weights (`helmPaint`, `shoulderPaint`: Helm2 plate,
  Helm1 mail, Helm3 leather, the hood cloth; the shoulder bases likewise), and NAMED pieces from a loot plan. One
  instance drops all four weights across its slots without four uniform kits (owner rulings 2026-10-08 and
  2026-10-29: "you are NOT making 5 full kits per dungeon"). The per-part weight split holds on every sheet (the
  Gnawspur test, 2026-10-08).
- **kit** — one uniform outfit of one weight, for a town, faction or vendor: one body sheet, one body item per slot
  per tier, normally 2-4 named helm pieces and 2-4 named shoulder pieces. A single helm may span multiple tiers when they share the same authored look.

### Loot plans (instance sets)

`armor loot-plan <dungeon> --set <instance-id> --project <p>` plans from the dungeon, not from a fixed shape: its size
class, difficulty, level band and SOURCES (trash packs of an area, named mobs, mini-bosses, the boss, each tied to its
creatures and area). Give it `--input <sources.json>` (the facts as a file; a FIXTURE while the dungeon is not built)
or `--bestiary <zone bestiary.json> --area <poi>` (groups standing there = trash, rares there = named, bosses whose
`dungeon` is this one). It writes the plan skeleton to the brief's `loot` file: per source its share of pieces,
slot / weight / rarity / sheet dealt so every slot drops in two weights, names and stories TODO. The author names each
piece after its source, EverQuest style (a bloodstained tunic off the crypt ghouls, a different-looking piece off the
warden), picks the helm / shoulder parts and the legs extras, and re-runs the command to lint it:

- all four weights across the dungeon; every slot in 2+ weights (the dungeon pipeline's `loot` gate asks the same);
- no two pieces with the same look (same sheet, slot, parts, legs extras and worn ornaments);
- each piece's weight is what its sheet paints there; ornaments rare+; rarity within the level band (top level 10:
  uncommon, the boss rare);
- every source names real creatures and an area, and drops its share (`lootRules.piecesPerSource`).

**Default: no set**, loose pieces that loosely match. A SET appears only when a rule fires and the plan names it
(`set.rule`): `dungeon-set` for a large or hard dungeon (pieces on its boss and named mobs, never trash), or
`zone-set` for 2-3 pieces in each of several dungeons of a zone. The thresholds are `lootRules` (loot.mts, every
field described). `armor run` on an instance generates its sheets and emits the planned items (`<set>-<piece>`, the
piece's own name, weight tag and rarity).

### Helm and shoulder pieces (kits)

Kits normally ship **2-4 helm pieces and 2-4 shoulder pieces** (`helms[]`, `shoulders[]`). One helm piece spanning multiple tiers is valid when those tiers intentionally share a look; it retains the normal item ID for each tier. Each piece is a full part pick (helm: base
+ extras such as a nose guard, the crown, a hood under a helm, a bandana; shoulder: base + rim + accent), its own item
name, its tiers and its ornaments (worn on ornate tiers only). The sheets already paint every part of both models, so
more pieces cost no art. Pick for the set's character (cloth: hoods, cowls, bandanas, light caps; leather: caps, hoods
over coifs; mail: coifs, nasal helms; plate: closed and great helms; cult or rare: crowns and ornaments), spread
bases across sets. Item ids: the first piece listing a tier keeps `<set>-helm-<rarity>`; a second piece at that tier
is `<set>-helm-<key>-<rarity>`. Lint:

- **distinct within the set**: the parts two pieces do not share cover at least 25% of their triangles (ornaments
  not counted). Helm1 vs Helm1 + flared neck guard is 18%: the same piece; adding the face plate makes 28%.
- every tier has a piece; pieces only name tiers of the set; the model rules hold with and without ornaments.
- **across all sets** (`armor picks`, and every `brief lint`): an identical pick (same parts and worn ornaments) in
  two sets fails; a base shared by several sets only warns. Practical civilian wardrobes may explicitly record why
  they reuse fitted caps or shawls (see the brief schema); their distinct painted cuts and materials then require
  visual review. Do not invent armour or ornaments just to differentiate ordinary clothing geometry.

## Making a set, in order

### One command

From `apps/playground`, one brief file per set (`projects/foundation/authoring/armor-sets/<id>.json`; its
schema is `armor brief schema`, every field described):

    node --import tsx tools/armor.mts brief new <id> --project foundation    # template; fill every TODO
    node --import tsx tools/armor.mts run <id> --project foundation          # lint -> gen -> import -> bake -> items -> review
    node --import tsx tools/armor.mts queue <id> <id> … --project foundation # several sets back to back
    node --import tsx tools/armor.mts status [<id>] --project foundation     # each stage ok / STALE / MISSING / FAILED

Every stage can also be run alone (`brief lint`, `gen [--dry-run] [--force]`, `import`, `bake`, `items`,
`items lint`, `review`). What each does is the manual order below, automated:

- **gen** writes ONE `image-request gen-set` manifest in this doc's order (body over the key; the woman's
  sheet with `key-female.png` first and his art second; helm and shoulders with `key-labelled.png` first and
  the body second plus the match-the-body paragraph and the clean-read rule). The SUBJECT is composed from the
  brief and carried word for word on all four prompts. Sheets that exist are skipped (`--force` redoes them all;
  `--redo helm` or `--redo body,…` redoes those sheets plus every sheet painted from them, which is what an import
  gate's "regenerate this sheet" line asks for),
  so a set runs as two Codex sessions: the body, then everything painted to it. A session attaches each
  reference once, so each prompt is told which attachment is its FIRST and SECOND. Token counts go to
  `authoring/armor-sets/ledger.md`.
- **import** imports all four sheets, composites her chest front (`<id>-f`), runs match-material (the brief's
  `match`, or the weight-class default: hood and soft pad from chest + arms; a plate set's from the trousers)
  and prints the gates: holes inside the body's real UV triangles (only robe/tasset hems and the back ornament
  may cut), opaque texels on cut-out free edges (a few stray touches are cleared; more fail: regenerate), and
  texels/m on each model. A failure keeps the stage and installs nothing.
- **bake** = `body-page` + `weapon-page` for helm and shoulder with every theme already on the page + icons.
- **items** = kit: one body item per slot per tier (`<id>-<slot>-<rarity>`) and one item per helm / shoulder piece per
  tier; instance: one item per loot-plan piece. Man's parts, `Ornate*`/`ChestHalo` only on ornate rare+ items, tagged
  with the set id and the item's weight; an item the brief no longer ships is removed; icon framing for gloves/boots
  goes into `item-icons.json`.
- **review** writes `authoring/armor-sets/review/<id>.png`: the dressed character in its bind pose (both sexes,
  front and back, plus a 3/4 close-up of head and pads), one row per helm piece and one per shoulder piece (an
  instance adds a row per body sheet), mounted with the creation asset's mounts, plus the icon strip. It is drawn
  in software, with no browser or dev server. Look at it; the creator (`/?creator`) is still the in-engine check.

`armor retire <id> …` takes whole sets out: their tiles off the three pages (re-baked square with every remaining
theme; `body-page --drop`), their items, icons, icon framing, sheets, brief, review and art; it prints the removed
item ids.

The steps below are the fallback when a stage needs doing by hand.

1. **Body first.** Write the SUBJECT (materials, colours, trim, the back
   ornament) and generate over `tools/atlas/sets/human-body/key.png` with `tools/atlas/sets/human-body/prompt.md`.
   Import with `sets/human-body/manifest.json` (`solidGround`). Check alpha at
   the body's REAL UVs: only hems, the robe gap and the back ornament may cut;
   a hole anywhere else is a hole through the character.
2. **The woman's chest.** `sets/human-body/prompt-female.md`: generate a copy
   of the man's sheet with the bust on the marks, keep ONLY its chest-front
   island, composite onto the man's atlas → `<theme>-f`. Every strap and belt on
   his chest carries over — the prompt says so; keep descriptions consistent
   rather than re-rolling.
3. **Helm and shoulders to match.** Generate each with its key-labelled FIRST
   and the finished BODY art SECOND plus a "match the body" paragraph: same
   metals, cloth, trim, rivets, wear. Crowns need not be gold: the material
   follows the outfit.
4. **Import, measure, bake.** Ornaments and plane squares must have zero
   opaque texels on their free edges (measure it). Then:
   - body: `reskin ... --theme mmo/human-body-<t>.png=<atlas> --theme mmo/human-body-<t>-f.png=<atlas-f>` for EVERY set on the page,
     or, to add or replace sets without re-running the weight transfer,
     `node tools/body-page.mjs --glb projects/foundation/assets/models/mmo/human-body.glb --theme <id>=<atlas> …`
     (reads the sheets already on the page back out of it; geometry, skin and clips are kept byte for byte).
     Copy each new atlas to `assets/textures/mmo/human-body-<t>[-f].png` too: item-icon reads the sheets from there.
   - helm/shoulders: `weapon-page --recipe human-helm|human-shoulder --project foundation --model mmo/<model>.glb --themes <every set>`
     For an isolated page, `--atlas-root <compiled-root>` reads `<compiled-root>/<recipe>/<theme>/atlas.png` and `--texture-dir <asset-directory>` assigns independent texture IDs. Both are optional; normal pages keep the existing atlas and texture routes. This supports a different ornament density without replacing old sheets or altering shared model pages.
5. **Look at it** on both sexes, front and back, in the creator (`/?creator`,
   the Outfit / Headgear / Shoulders preview rows).

### Matching materials across sheets

Each sheet is painted in its own generator session, so a material the body
and the helm share comes back as two different materials: the chain set's
coif mail measured 38% brighter than the hauberk's with twice the contrast
(OKLab L 0.43±0.18 against 0.34±0.09) and read silver-white beside it. "Match
the body" in the prompt does not fix that. After import and BEFORE the page
bake, move every helm/shoulder slot made entirely of a body material onto
the body's measured tone:

    node tools/atlas/match-material.mjs \
      --from tools/atlas/out/human-body/<t>/atlas.png --from-key tools/atlas/sets/human-body/key.png --from-regions "#ff0000,#a80000,#f800ff,#760079" \
      --to tools/atlas/out/human-helm/<t>/atlas.png --to-key tools/atlas/sets/human-helm/key.png --to-regions "#6a00c0,#400080"

(that pair is chest + arms → hood + hood back). The painting stays; its
lightness mean and spread and its hue move. Re-importing a sheet overwrites
the out/ atlas, so re-run this after every import. Ring/stud SIZE is a
separate problem: the helm sheet shrinks 1254 → 132 and the body 1254 → 256,
so the same painted ring lands at half the texels; state a repeat in art
pixels per sheet (mail 3 cm = 16 px on the body sheet, 31 px on the helm
sheet) when a pattern must line up.

A page only holds what it was baked with: adding a set means re-running the
bake with every theme, never adding a material.

**Pages are square.** A tile is stored as `[u, v, scale]` with ONE scale, so a
page with fewer rows than columns squeezes every tile vertically: the top of each
sheet still lands, and each island samples further off the lower it sits (12 helm
themes packed 4×3 broke hood tops, crowns and every ornament; the greataxe's 2×1
page had the same fault). Every packer goes through `tools/_page.mjs` and refuses a non-square page;
a non-square page in an installed model is this bug.

## Breaking a set into items

Six slots change how a character looks. Each item's `appearance` names ONE
model, its parts and the set's sheet (`texture`):

| slot | model | always | optional (per item) |
| --- | --- | --- | --- |
| `helm` | human-helm | one base piece (a helm, the hood, a headband, the face cover…) | nose guard, crown, hood over a helm, bandana; ornaments rare+ |
| `shoulders` | human-shoulder | one `ShoulderBase1-4` | one rim (`Rim1` or `PlanerRim`), one accent (`Accent1` or `PlanerAccent`); ornaments rare+ |
| `chest` | human-body | `ChestFront`, `ChestBack`, `ArmOutside`, `ArmInside` | `ChestHalo` (the ornate iron back piece) rare+ only |
| `gloves` | human-body | `HandFront`, `HandPalm` | — |
| `legs` | human-body | `LegsFront`, `LegsBack`, `Belt`, `Buckle` | `RobesFront`+`RobesBack`, `TassetFront`, `TassetBack` |
| `boots` | human-body | `Foot` | — |

- **Body part names differ by sex.** Male `HumanMale_ChestFront`,
  `Human_LegsFront`…; female `HumanFemale_*`; accessories `Belt` ↔ `F_Belt`,
  `RobesFront` ↔ `F_RobesFront`. An item names the MALE parts and its sheet;
  the look is mapped to the wearer's sex when drawn (female parts, and the
  `-f` sheet for the chest).
- **Rules are in the models** (`rules` beside `parts`, core `partProblems`):
  one helm base; one shoulder base, one rim, one accent; a robe means no back
  tasset (a front tasset is fine); a robe's front and back go together; the
  buckle needs the belt. `hides` removes what a piece covers on other models:
  helms and the hood hide hair, face plates hide beards, the face cover hides
  the head.
- **Ornaments mark rarity.** `Ornate*` on helm and shoulders and `ChestHalo`
  on the chest appear only on `rare` or better items. A common vanguard chest
  is the plate and arms; the epic one adds the back ornament.
- **Tie items to a set by name and tag** (`vanguard-chest`, tag `vanguard`),
  so drops and loot tables can roll whole sets or mix them.

Example (`assets/items/vanguard-legs.json`):

```json
{
  "name": "Vanguard Greaves",
  "kind": "equipment",
  "slots": ["legs"],
  "rarity": "uncommon",
  "modifiers": { "armor": 3 },
  "appearance": {
    "model": "mmo/human-body.glb",
    "parts": ["Human_LegsFront", "Human_LegsBack", "Belt", "Buckle", "TassetFront", "TassetBack"],
    "texture": "mmo/human-body-vanguard.png"
  },
  "tags": ["armor", "vanguard"]
}
```

## Mixed sets on one body

The body is ONE mesh and every character wearing it shares ONE material, yet
each part can wear a different set's tile: a vanguard chest over ranger
legs is still one draw. How (render `appearance.ts`):

- A character carries 16 floats (64 bytes): part → TILE CODE, 8 bits a part,
  three parts per float (12 floats, 36 parts), plus the skin tone. The code
  indexes the model's tile table (its `tiles` extras, in order; 0 = the
  default tile), and the VERTEX stage picks the tile from the part index in
  uv1 — a triangle is one part, so the tile is constant across it.
- Non-instanced (the skinned player, the creator): the floats sit on the mesh
  (`userData.appearanceData`) and reach the shader as per-object uniforms, the
  way three's own model matrices do — no material per character.
  `applyModelAppearance(root, { groups, skinTint }, { skin })`.
- Instanced (crowds, moving batches): one interleaved per-instance buffer of
  the same floats (`InstancedProps.enableAppearance`; the batch's eighth
  vertex buffer). `MovingInstanceSystem.setLook(id, { groups })`.
- Composing items: core `composeModelLook(pieces, model)` merges every worn
  item on one model into groups (later items win a shared part). The
  `equipment-look` builtin does it when `slot` lists several slots
  (`"chest,legs,gloves,boots"`) and sends `{ parts, groups }` through
  `ctx.setModelLook`.
- The creator: the sex option's base layer first, then each option naming the
  body with no socket (and no mount) is one group, in slot order — the Outfit
  row, then the Chest and Legs (preview) rows overriding their parts.
- The female chest's `-f` tile is just another code; a woman's look names
  female parts and the `-f` sheet for the chest group.
- **Skin**: a sheet that shows bare skin opts in (`skin` on the option; a part
  list for fingers on a gloved set), and the skin tone recolours only those
  texels. Contract and numbers: docs/image-generation.md → Skin.

## Icons

Every armor item gets an icon RENDERED from its own model, parts and sheet,
like weapons: `node tools/item-icon.mjs --project foundation --model mmo/human-body.glb`
(and the helm and shoulder models). Framing is per model and per item in
`projects/<p>/authoring/item-icons.json`: a chest seen from the front, boots
from the side, gloves palm-out. Re-run after every bake: `weapon-page` does it
for the helm and shoulders automatically; `reskin` does not yet.

## In game (built 2026-09-25)

- **The player draws the modular human.** The player prefab's model is
  `human-body.glb`; head, hair, helm and both pads are `mesh.moving` entities
  under it (one draw per model for every player on screen). Each runs the
  `character-look` builtin, which reads the replicated sheet (`character/<body>`:
  `build` + `equipment`) and draws core `dressCharacter`: the body option's
  unequipped layer under every worn body item, face/hair/beard from the build,
  skin tone and hair colour, each model's `hides` taken off the others. Every
  tab computes the same look, so other players show theirs (presentation
  scripts keep running on bodies a tab does not simulate).
- **The base layer** is the sex option's own `texture` + `parts`
  (`human-body-base` / `-base-f`: his sleeveless linen tank and shorts, her
  bandeau and shorts, no belt, bare skin in the skin palette, `skin: true`).
  It shows in every empty slot, and under a chest item's bare arms.
- **Placements live in ONE place:** the creation asset's `mounts` (per sex
  where they differ). Creator options and items carry no socket numbers.
- **Sex mapping:** the female body option's `remap` (parts by name and prefix,
  the sheet's `-f` copy when the page has it), applied by `composeModelLook`.
  Items name the man's parts. The mapping also applies to mounted gear; each
  accessory uses its own page to decide whether the suffixed sheet exists.
- **Preview rows** (`preview: true` slots: outfit, chest, legs, headgear,
  shoulders) never enter a saved build and are never drawn in game.
- **Starting sets:** `archetypes[].startingItems` in the creation asset, worn
  first on a fresh sheet (brawn: vanguard, cunning: ranger, wise: magus; chest,
  legs, gloves, boots; common; no ornaments).
- **Icons** of skinned body items render from the bind pose; framing is in
  `authoring/item-icons.json` (front for chest and legs, side for boots and gloves).
- **The shoulders cell** is on the MMO paper doll.

## Not built yet

- **Worn pieces cannot glow.** A moving batch with per-part tiles has no room
  left for the glow attributes (16 vertex-input locations); a glowing helm needs
  a different packing.
- **Cleric starting set.** One kit per archetype; the cleric outfit has no
  items yet (Wise gets magus).
- **Editor play without the gateway** has no build: the player shows the
  default appearance and gets no archetype kit.
- **Page budget.** A 4096 page holds ~225 body sheets (256px), ~900 helm
  (132px), ~1,200 shoulder (112px). A full female copy per set halves the body
  page; store only the female CHEST-FRONT regions as small extra tiles
  instead. A full page means a second page: +1 draw only while both are on
  screen.
