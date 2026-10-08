import { z } from "zod";
import { hexColor } from "../components/core.js";
import { ATTRIBUTES, type Attribute } from "./items.js";

/**
 * Character creation — the choices a player makes once, before the first
 * login, as ONE data asset (`assets/creation/<id>.json`, type "creation").
 *
 * Three kinds of choice, all data so a game (or an agent) rewrites them
 * without code:
 * - an ARCHETYPE: a starting lean, not a class. It adds a few attribute
 *   points on top of the progression's base and names the direction the
 *   character can later branch; it locks nothing out.
 * - BIRTH TRAITS: innate abilities picked from a list (`traitPicks` of them).
 *   A trait names an ability id the game's combat layer resolves — the engine
 *   only carries the id.
 * - APPEARANCE: an ordered list of slots (sex, face, hair, beard…), each a
 *   list of options. An option may name a model and the bone it rides on;
 *   one without a model is still a valid choice, drawn when art arrives
 *   (appearance is late-bound, never a blocker).
 *
 * What the player picked is a BUILD (`characterBuildSchema`). The gateway
 * stores it on the character, the play ticket carries it signed, and the
 * character-sheet authority applies it to a fresh sheet — so the only place a
 * build becomes attribute points is the authority, re-validated here.
 */

const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "ids are lower-case letters, digits, _ or -, at most 32")
  .describe("Stable id — what a saved build stores. Renaming an id orphans every character that picked it.");

/** One entry of a starting kit — the same shape as the character-sheet script's `startingItems` param. */
export const startingItemSchema = z
  .object({
    itemId: z.string().min(1).describe("Item asset id (assets/items/<id>.json)."),
    qty: z.number().int().min(1).default(1),
    equip: z.boolean().default(false).describe("Wear it at once (the first slot that accepts it)."),
  })
  .describe("An item given to a fresh character.");
export type StartingItem = z.infer<typeof startingItemSchema>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const modelMountSchema = z
  .object({
    model: z.string().min(1).describe("Model asset id this placement is for (mmo/human-head.glb)."),
    socket: z.string().min(1).describe("Bone the model rides on (the head bone for a face, hair or helm)."),
    offset: vec3.default([0, 0, 0]).describe("Position of the model in the socket bone's OWN space (it inherits the bone's scale)."),
    rotationDeg: vec3.default([0, 0, 0]).describe("Rotation of the model in the socket bone's space, XYZ Euler degrees."),
    scale: z.number().positive().default(1).describe("Uniform scale of the model in the socket bone's space."),
    mirrorTo: z
      .object({ socket: z.string().min(1), offset: vec3, rotationDeg: vec3 })
      .optional()
      .describe(
        "A second copy of the model, MIRRORED across its own Z (left/right), on another bone: a shoulder pad modelled for " +
          "the left arm also sits on the right. Same parts, texture and scale; its own placement in that bone's space.",
      ),
    requires: z
      .record(z.string(), z.array(z.string()).min(1))
      .optional()
      .describe('Only for wearers whose appearance holds one of these options — { "sex": ["male"] } for a man\'s placement.'),
    hang: z
      .object({
        socket: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Bone the hanging ends ride instead, as it sat against `socket` at the bind pose. Omit it (recommended): a bone " +
              "that moves against the head in the idles (the chest breathing, hunching, arms folded) drags the ends with it.",
          ),
      })
      .optional()
      .describe(
        "Ends that hang — braids, long hair down the back — blended per vertex by the model's baked hang weight " +
          "(TEXCOORD_1.y: 0 = rides `socket`, 1 = hangs). With no `socket` here they hang PLUMB: as modelled on the body's " +
          "root, wherever the head is now, so a nod or a tilt bends the hair instead of swinging it. Still one instanced " +
          "draw; a model without weights rides `socket` whole.",
      ),
  })
  .describe(
    "Where a socketed model sits on the body — ONE place for every option and item drawing it: the creator's face, hair " +
      "and headgear rows and the in-game helm and shoulder items all read it. The first mount whose `requires` the " +
      "wearer satisfies wins, so a per-sex placement is two entries.",
  );
export type ModelMount = z.infer<typeof modelMountSchema>;

/** A resolved placement: a mount, or an option's own socket fields. */
export interface ModelPlacement {
  socket: string;
  offset: [number, number, number];
  rotationDeg: [number, number, number];
  scale: number;
  mirrorTo?: { socket: string; offset: [number, number, number]; rotationDeg: [number, number, number] } | undefined;
  /** The bone the model's hanging ends follow (modelMountSchema `hang`). */
  hang?: { socket?: string | undefined } | undefined;
}

/**
 * How a body option maps an item's part names and sheets onto that body. Items
 * name ONE body's parts (the man's: `HumanMale_ChestFront`, `Belt`) and that
 * body's sheet; a woman wearing the same item shows `HumanFemale_ChestFront`,
 * `F_Belt` and the sheet's `-f` copy. Core `composeModelLook` applies it.
 */
export const lookRemapSchema = z
  .object({
    parts: z
      .record(z.string().min(1), z.string().min(1))
      .default({})
      .describe('Exact part name → this body\'s part ("Belt" → "F_Belt"). Tried before `prefixes`.'),
    prefixes: z
      .record(z.string().min(1), z.string())
      .default({})
      .describe('Part-name prefix → replacement ("HumanMale_" → "HumanFemale_"); the longest matching prefix wins.'),
    sheetSuffix: z
      .string()
      .optional()
      .describe(
        'Inserted before the extension of an item\'s sheet ("-f": mmo/human-body-vanguard.png → mmo/human-body-vanguard-f.png) ' +
          "when the model's page HAS that sheet; otherwise the item's own sheet is kept.",
      ),
  })
  .describe("Maps looks written for one body onto this one (the female body wearing an item written for the male).");
export type LookRemap = z.infer<typeof lookRemapSchema>;

const attributeBonus = z
  .partialRecord(z.enum(ATTRIBUTES), z.number().int().min(-5).max(5))
  .prefault({})
  .describe("Points added to the progression's base attributes. Keep them small: an archetype is a lean, not a class.");

export const archetypeSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(32),
    blurb: z.string().max(240).default("").describe("One or two sentences on the creation screen."),
    icon: z.string().optional().describe("Texture asset id for the archetype's emblem (optional)."),
    attributes: attributeBonus,
    branches: z
      .array(z.string().min(1).max(32))
      .max(8)
      .default([])
      .describe("Names of the paths this archetype can grow into later (shown as a hint; not enforced yet)."),
    startingItems: z
      .array(startingItemSchema)
      .max(32)
      .default([])
      .describe(
        "Items a FRESH character of this archetype is given — a starting armour set, equipped — BEFORE the character-sheet " +
          "script's own startingItems, which never take a worn kit piece off. A restored sheet never gets them again.",
      ),
    startingCoins: z
      .number()
      .int()
      .min(0)
      .max(100000000)
      .optional()
      .describe("Copper a FRESH character of this archetype starts with (100 = 1 silver). Absent = the character-sheet script's startingCoins."),
  })
  .describe("A starting lean — Brawn, Cunning, Wise. Adds a few attribute points; locks nothing out.");
export type Archetype = z.infer<typeof archetypeSchema>;

export const birthTraitSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(32),
    blurb: z.string().max(240).default(""),
    ability: z
      .string()
      .min(1)
      .describe("Ability id the character is born with. The game's combat layer resolves it; the engine only carries it."),
    icon: z.string().optional().describe("Texture asset id for the trait's icon (optional)."),
    archetypes: z
      .array(z.string().min(1))
      .optional()
      .describe("Archetype ids that offer this trait (a Brawn trait, a Wise trait). Absent = every archetype."),
  })
  .describe("An innate ability picked at creation.");
export type BirthTrait = z.infer<typeof birthTraitSchema>;

export const appearanceOptionSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(32),
    model: z
      .string()
      .optional()
      .describe("Model asset id drawn for this choice. Absent = nothing to draw yet (placeholder art pending)."),
    socket: z
      .string()
      .optional()
      .describe(
        "Bone the model rides on (a face or hair piece → the head bone), with offset/rotationDeg/scale/mirrorTo beside it. " +
          "Usually absent: the creation's `mounts` entry for the model places it, one place for every option and item. " +
          "Absent with no mount = the option dresses the body model itself (an outfit).",
      ),
    offset: z
      .tuple([z.number(), z.number(), z.number()])
      .optional()
      .describe("Position of the model in the socket bone's space (the `bone-socket` offset)."),
    rotationDeg: z
      .tuple([z.number(), z.number(), z.number()])
      .optional()
      .describe("Rotation of the model in the socket bone's space, XYZ Euler degrees (the `bone-socket` rotationDeg)."),
    scale: z
      .number()
      .positive()
      .optional()
      .describe(
        "Uniform scale of the model in the socket bone's space. On a BODY-slot option (sex), the scale of the whole " +
          "character: the female body is the male skeleton at 0.96, so her head and shoulders come down with it.",
      ),
    mirrorTo: z
      .object({
        socket: z.string().min(1),
        offset: z.tuple([z.number(), z.number(), z.number()]),
        rotationDeg: z.tuple([z.number(), z.number(), z.number()]),
      })
      .optional()
      .describe(
        "A second copy of the model, MIRRORED across its own Z (left/right), on another bone: a shoulder pad modelled " +
          "for the left arm also sits on the right. Same parts, texture and scale; its own placement in that bone's space.",
      ),
    texture: z
      .string()
      .optional()
      .describe(
        "Sheet id of the look on the model's packed page (its `tiles` table, as an item's appearance.texture): a face is one tile of the head's page. " +
          "On a BODY-slot option (sex), with `parts`: the body's UNEQUIPPED look — what every empty equipment slot shows.",
      ),
    parts: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Ubermesh parts of the model this choice shows (a hair style, a beard). Options in different slots that name the SAME model share one piece: their parts are shown together and the texture comes from whichever names one.",
      ),
    hideBones: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Body triangles weighted to these bones (and every bone under them) are hidden while this piece is worn — a head module replacing the body's own head or hood.",
      ),
    skin: z
      .union([z.boolean(), z.literal("face"), z.array(z.string().min(1)).min(1)])
      .optional()
      .describe(
        "This option's sheet paints BARE SKIN, so the skin tone recolours it (opt-in: a sheet never opted in is never " +
          "tinted, whatever its colours — leather and linen sit on skin's hue). true = anywhere on the sheet (the " +
          "unequipped body); \"face\" = the whole sheet of a HEAD, with its mouth found and kept as painted (lips never take " +
          "the tone); a list of part names = only on those parts' islands (the bare fingers of a gloved set).",
      ),
    remap: lookRemapSchema
      .optional()
      .describe(
        "BODY-slot options only: how items written for another body (their part names and sheets) map onto this one — " +
          "the female body wearing an item that names the man's parts.",
      ),
    color: hexColor
      .optional()
      .describe("A colour choice (skin tone, lip colour): drawn as a swatch, and tints the slot's `material` on the body."),
    requires: z
      .record(z.string(), z.array(z.string()).min(1))
      .optional()
      .describe('Only offered while other slots hold one of these options — { "sex": ["male"] }.'),
  })
  .describe("One choice inside an appearance slot.");
export type AppearanceOption = z.infer<typeof appearanceOptionSchema>;

export const appearanceSlotSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(32),
    body: z
      .boolean()
      .default(false)
      .describe("This slot swaps the whole body model (sex). Its option's `model` replaces the base model rather than riding a bone."),
    material: z
      .string()
      .optional()
      .describe(
        'Material NAME on the body that a colour option tints. "Skin" is special: the colour recolours the ' +
          "SKIN TEXELS of every sheet an option opts in with `skin` (the skin-tint contract: every sheet paints " +
          "skin in one palette, docs/image-generation.md), keeping the painted shading. A body without that material " +
          "shows no tint — the choice is still kept.",
      ),
    preview: z
      .boolean()
      .default(false)
      .describe(
        "A DEV PREVIEW row (outfits, armour, headgear — for looking at art on the creator's model): shown on the " +
          "creation screen, never saved into a build and never drawn in game, where equipment dresses the character.",
      ),
    tintModels: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "A colour slot that recolours the WHOLE sheet of these models (hair colour → the hair ubermesh, whose every " +
          "texel is hair: styles, beards and moustache alike, so one choice colours them all). The painted strand " +
          "shading is kept. No `material` needed.",
      ),
    options: z.array(appearanceOptionSchema).min(1),
  })
  .describe("A row on the creation screen: sex, face, hair, beard…");
export type AppearanceSlot = z.infer<typeof appearanceSlotSchema>;

const frameSchema = z
  .object({
    texture: z.string().min(1).describe("Texture asset id of the 9-slice image."),
    slice: z.number().int().min(1).max(256).describe("Pixels cut from each edge of the image for the corners/edges (CSS border-image-slice)."),
    border: z.number().min(1).max(128).describe("Drawn width of those edges on screen, px (CSS border-image-width)."),
    repeat: z.enum(["stretch", "repeat", "round"]).default("stretch").describe("How the edges fill: repeat/round for a riveted rail that must not smear."),
  })
  .describe("A 9-slice frame drawn with CSS border-image.");
export type CreationFrame = z.infer<typeof frameSchema>;

export const creationSkinSchema = z
  .object({
    panel: frameSchema.optional().describe("Window frame around the choice panels."),
    button: frameSchema.optional(),
    buttonActive: frameSchema.optional().describe("The primary button (Create) and a pressed button."),
    card: frameSchema.optional().describe("Frame around an archetype/trait row and its icon (an inventory slot)."),
    cardActive: frameSchema.optional().describe("The same frame when chosen (a lit slot)."),
    backdrop: z.string().optional().describe("Texture tiled behind the panels (darkened)."),
    scene: z
      .string()
      .optional()
      .describe(
        "A painted picture filling the whole screen behind the character (the creation and character-select screens): the " +
          "model and its 3D clearing stand in front of it. Absent = the tiled backdrop.",
      ),
    divider: z.string().optional().describe("Ornament drawn under section headings and the title."),
    crest: z.string().optional().describe("Emblem above the title."),
    close: z.string().optional().describe("Image for the Back/close control in a panel corner."),
    arrow: z.string().optional().describe("Stepper arrow pointing RIGHT; the left arrow is this mirrored."),
    font: z.string().optional().describe("CSS font-family for everything on the screen."),
    colors: z
      .object({
        text: z.string(),
        muted: z.string(),
        heading: z.string(),
        accent: z.string(),
        surface: z.string(),
      })
      .partial()
      .optional()
      .describe("CSS colours: body text, secondary text, headings, the chosen/focus accent, input wells."),
  })
  .describe("Optional look for the creation screen — the game's own UI pieces. Absent = the engine's plain dark look.");
export type CreationSkin = z.infer<typeof creationSkinSchema>;

export const characterCreationSchema = z
  .object({
    ui: creationSkinSchema.optional(),
    model: z
      .string()
      .default("")
      .describe("Model asset id of the base body shown in the preview (and worn when no body slot overrides it)."),
    archetypes: z.array(archetypeSchema).min(1),
    traits: z.array(birthTraitSchema).default([]),
    traitPicks: z.number().int().min(0).max(4).default(1).describe("How many birth traits a character takes."),
    appearance: z.array(appearanceSlotSchema).default([]),
    mounts: z
      .array(modelMountSchema)
      .default([])
      .describe("Where each socketed model (head, hair, helm, shoulder pad) sits on the body — see the mount schema."),
  })
  .superRefine((c, ctx) => {
    const dupes = (label: string, ids: string[]): void => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) ctx.addIssue({ code: "custom", message: `duplicate ${label} id "${id}"` });
        seen.add(id);
      }
    };
    dupes("archetype", c.archetypes.map((a) => a.id));
    dupes("trait", c.traits.map((t) => t.id));
    dupes("appearance slot", c.appearance.map((s) => s.id));
    for (const slot of c.appearance) dupes(`${slot.id} option`, slot.options.map((o) => o.id));
    const archetypeIds = new Set(c.archetypes.map((a) => a.id));
    for (const t of c.traits) {
      for (const a of t.archetypes ?? []) {
        if (!archetypeIds.has(a)) ctx.addIssue({ code: "custom", message: `trait "${t.id}" names unknown archetype "${a}"` });
      }
    }
    for (const a of c.archetypes) {
      const offered = c.traits.filter((t) => !t.archetypes || t.archetypes.includes(a.id)).length;
      if (c.traitPicks > offered) {
        ctx.addIssue({ code: "custom", message: `traitPicks ${c.traitPicks} but archetype "${a.id}" is offered only ${offered} traits` });
      }
    }
  })
  .describe(
    "Character creation rules (assets/creation/<id>.json): archetypes, birth traits and appearance slots. One per game; the gateway and the character-sheet script name it by id.",
  );
export type CharacterCreation = z.infer<typeof characterCreationSchema>;
export type CharacterCreationInput = z.input<typeof characterCreationSchema>;

export const characterBuildSchema = z
  .object({
    archetype: z.string().min(1).max(32),
    traits: z.array(z.string().min(1).max(32)).max(4).default([]),
    appearance: z.record(z.string().max(32), z.string().max(32)).default({}).describe("Appearance slot id → option id."),
  })
  .describe("What a player chose at character creation. Stored on the character, applied once to a fresh sheet.");
export type CharacterBuild = z.infer<typeof characterBuildSchema>;

export type BuildResult = { ok: true; build: CharacterBuild } | { ok: false; error: string };

/** Whether an option is offered given the choices made in the OTHER slots. */
export function optionAvailable(option: AppearanceOption, appearance: Record<string, string>): boolean {
  if (!option.requires) return true;
  return Object.entries(option.requires).every(([slot, allowed]) => allowed.includes(appearance[slot] ?? ""));
}

/** The options of a slot a player may pick right now. */
export function availableOptions(slot: AppearanceSlot, appearance: Record<string, string>): AppearanceOption[] {
  return slot.options.filter((o) => optionAvailable(o, appearance));
}

/**
 * Settle every appearance slot in order: keep a choice that is still offered,
 * else fall back to the slot's first offered option. Slots are resolved in the
 * file's order, so a slot may only depend on slots ABOVE it (sex before beard).
 */
export function settleAppearance(
  creation: CharacterCreation,
  picked: Record<string, string>,
  opts: { preview?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of creation.appearance) {
    // preview rows are the creator's own; a build never carries them (`preview: false`)
    if (slot.preview && opts.preview === false) continue;
    const offered = availableOptions(slot, out);
    const keep = offered.find((o) => o.id === picked[slot.id]);
    const choice = keep ?? offered[0];
    if (choice) out[slot.id] = choice.id;
  }
  return out;
}

/** The first archetype, the first `traitPicks` traits, the first option of every slot. */
/** The birth traits an archetype offers, in file order. */
export function traitsFor(creation: CharacterCreation, archetypeId: string): BirthTrait[] {
  return creation.traits.filter((t) => !t.archetypes || t.archetypes.includes(archetypeId));
}

/** Keep the picks this archetype still offers, then top up with its first offered traits. */
export function settleTraits(creation: CharacterCreation, archetypeId: string, picked: readonly string[]): string[] {
  const offered = traitsFor(creation, archetypeId).map((t) => t.id);
  const keep = picked.filter((id) => offered.includes(id)).slice(0, creation.traitPicks);
  for (const id of offered) {
    if (keep.length >= creation.traitPicks) break;
    if (!keep.includes(id)) keep.push(id);
  }
  return keep;
}

export function defaultBuild(creation: CharacterCreation): CharacterBuild {
  const archetype = creation.archetypes[0]!.id;
  return {
    archetype,
    traits: settleTraits(creation, archetype, []),
    appearance: settleAppearance(creation, {}),
  };
}

/**
 * Check a build against the rules. Never throws: a build arrives from a
 * client, and "that trait does not exist" is an answer. Appearance is
 * normalised (unknown slots dropped, missing ones filled) — only a choice the
 * player actually made that is not allowed is an error.
 */
export function validateBuild(creation: CharacterCreation, raw: unknown): BuildResult {
  const parsed = characterBuildSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `build: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  const build = parsed.data;
  if (!creation.archetypes.some((a) => a.id === build.archetype)) return { ok: false, error: `unknown archetype "${build.archetype}"` };
  if (new Set(build.traits).size !== build.traits.length) return { ok: false, error: "the same birth trait twice" };
  for (const t of build.traits) {
    const trait = creation.traits.find((d) => d.id === t);
    if (!trait) return { ok: false, error: `unknown birth trait "${t}"` };
    if (trait.archetypes && !trait.archetypes.includes(build.archetype)) {
      return { ok: false, error: `${trait.name} is not a birth trait of that archetype` };
    }
  }
  if (build.traits.length !== creation.traitPicks) {
    return { ok: false, error: `pick ${creation.traitPicks} birth trait${creation.traitPicks === 1 ? "" : "s"}` };
  }
  const chosen: Record<string, string> = {};
  for (const slot of creation.appearance) {
    // a creator preview row is dropped, never refused: it was never the player's to save
    if (slot.preview) continue;
    const id = build.appearance[slot.id];
    if (id === undefined) continue;
    const option = slot.options.find((o) => o.id === id);
    if (!option) return { ok: false, error: `unknown ${slot.label.toLowerCase()} "${id}"` };
    if (!optionAvailable(option, chosen)) return { ok: false, error: `${option.label} is not available with those choices` };
    chosen[slot.id] = id;
  }
  return { ok: true, build: { ...build, appearance: settleAppearance(creation, chosen, { preview: false }) } };
}

/**
 * A build's REAL appearance: its choices settled against the rules with every
 * preview row left out — what a character is drawn from in game. Tolerates an
 * older build that saved preview rows, or none at all (the defaults).
 */
export function buildAppearance(creation: CharacterCreation, build: Pick<CharacterBuild, "appearance"> | null | undefined): Record<string, string> {
  return settleAppearance(creation, build?.appearance ?? {}, { preview: false });
}

/** Whether a wearer's appearance satisfies a `requires` table (a mount's, an option's). */
function satisfies(requires: Record<string, string[]> | undefined, appearance: Record<string, string>): boolean {
  return !requires || Object.entries(requires).every(([slot, allowed]) => allowed.includes(appearance[slot] ?? ""));
}

/** Where `model` sits on this wearer: the first of the creation's mounts for it whose `requires` holds, or null. */
export function mountFor(creation: CharacterCreation, model: string, appearance: Record<string, string>): ModelPlacement | null {
  const mount = creation.mounts.find((m) => m.model === model && satisfies(m.requires, appearance));
  if (!mount) return null;
  return { socket: mount.socket, offset: mount.offset, rotationDeg: mount.rotationDeg, scale: mount.scale, mirrorTo: mount.mirrorTo, hang: mount.hang };
}

/** An option's placement: its own socket fields when it has them, else the model's mount; null = it dresses the body. */
export function placementOf(creation: CharacterCreation, option: AppearanceOption, appearance: Record<string, string>): ModelPlacement | null {
  if (option.socket) {
    return {
      socket: option.socket,
      offset: option.offset ?? [0, 0, 0],
      rotationDeg: option.rotationDeg ?? [0, 0, 0],
      scale: option.scale ?? 1,
      mirrorTo: option.mirrorTo,
    };
  }
  return option.model ? mountFor(creation, option.model, appearance) : null;
}

/** The option the build picks in the body slot (sex), or null. */
export function bodyOptionOf(creation: CharacterCreation, build: Pick<CharacterBuild, "appearance">): AppearanceOption | null {
  const slot = creation.appearance.find((s) => s.body);
  return slot?.options.find((o) => o.id === build.appearance[slot.id]) ?? null;
}

/** Items an archetype starts with (empty for an unknown one). */
export function archetypeStartingItems(creation: CharacterCreation, archetypeId: string): StartingItem[] {
  return creation.archetypes.find((a) => a.id === archetypeId)?.startingItems ?? [];
}

/** Copper an archetype starts with, or undefined when it names none. */
export function archetypeStartingCoins(creation: CharacterCreation, archetypeId: string): number | undefined {
  return creation.archetypes.find((a) => a.id === archetypeId)?.startingCoins;
}

/** Attribute points an archetype adds (zeros for the rest). */
export function archetypeBonus(creation: CharacterCreation, archetypeId: string): Record<Attribute, number> {
  const bonus = creation.archetypes.find((a) => a.id === archetypeId)?.attributes ?? {};
  return Object.fromEntries(ATTRIBUTES.map((a) => [a, bonus[a] ?? 0])) as Record<Attribute, number>;
}

/** Ability ids a build is born with, in pick order. */
export function birthAbilities(creation: CharacterCreation, build: Pick<CharacterBuild, "traits">): string[] {
  return build.traits.flatMap((id) => {
    const trait = creation.traits.find((t) => t.id === id);
    return trait ? [trait.ability] : [];
  });
}

/** The body model a build wears: the body slot's option model, else the rules' base model ("" = none). */
export function bodyModelOf(creation: CharacterCreation, build: Pick<CharacterBuild, "appearance">): string {
  for (const slot of creation.appearance) {
    if (!slot.body) continue;
    const model = slot.options.find((o) => o.id === build.appearance[slot.id])?.model;
    if (model) return model;
  }
  return creation.model;
}

/** What each appearance slot draws for a build: slot id → the option (with its model/socket, if any). */
export function appearanceOf(creation: CharacterCreation, build: Pick<CharacterBuild, "appearance">): Array<{ slot: AppearanceSlot; option: AppearanceOption }> {
  const out: Array<{ slot: AppearanceSlot; option: AppearanceOption }> = [];
  for (const slot of creation.appearance) {
    const option = slot.options.find((o) => o.id === build.appearance[slot.id]);
    if (option) out.push({ slot, option });
  }
  return out;
}
