/**
 * Composing several worn items into ONE look on a shared model.
 *
 * An item's `appearance` names one model, its parts and one sheet: a vanguard
 * chest, a pair of ranger greaves. The human body is ONE mesh that the chest,
 * legs, gloves and boots slots all draw on, so what the renderer is handed per
 * model is the merge: every part any item shows, grouped by the sheet it
 * wears (the renderer resolves each group to a tile of the model's page per
 * part, in the shader — render `appearance.ts`). Pure data, no rendering.
 *
 * {@link dressCharacter} is the whole character: the creation build's body,
 * face, hair and colours plus every equipped item, one look per model.
 */

import {
  buildAppearance,
  bodyModelOf,
  bodyOptionOf,
  mountFor,
  type CharacterCreation,
  type LookRemap,
  type ModelPlacement,
} from "./creation.js";
import { partsHiddenBy, type PartRules } from "./part-rules.js";

/** One item's look (an item `appearance`, or an outfit option): a model, its parts, one sheet. */
export interface LookPiece {
  model: string;
  parts: readonly string[];
  /** Sheet id on the model's page; absent = the model's default tile. */
  texture?: string | null | undefined;
}

/** A merged look: every part shown, and which sheet each group of them wears. */
export interface ComposedLook {
  parts: string[];
  groups: Array<{ parts: string[]; texture: string | null }>;
}

export interface ComposeOptions {
  /**
   * Map every piece onto the wearer's body first (a woman wearing an item
   * written with the man's part names: creation `remap` on her body option).
   */
  remap?: LookRemap | null | undefined;
  /**
   * Sheets the model's page HAS (its `tiles` table). A remapped sheet (`-f`)
   * is used only when it is in here; without the set a sheet is never
   * remapped (an unknown tile would draw the default one).
   */
  sheets?: ReadonlySet<string> | null | undefined;
}

/** A part name as the remap puts it on its body: exact names first, then the longest matching prefix. */
export function remapPart(part: string, remap: LookRemap | null | undefined): string {
  if (!remap) return part;
  const exact = remap.parts[part];
  if (exact !== undefined) return exact;
  let best = "";
  for (const prefix of Object.keys(remap.prefixes)) if (part.startsWith(prefix) && prefix.length > best.length) best = prefix;
  return best ? remap.prefixes[best] + part.slice(best.length) : part;
}

/** A sheet as the remap puts it on its body (`-f` before the extension) when the page has it; else the sheet itself. */
export function remapSheet(
  sheet: string | null | undefined,
  remap: LookRemap | null | undefined,
  sheets: ReadonlySet<string> | null | undefined,
): string | null {
  if (!sheet) return null;
  if (!remap?.sheetSuffix || !sheets) return sheet;
  const dot = sheet.lastIndexOf(".");
  const mapped = dot > sheet.lastIndexOf("/") ? sheet.slice(0, dot) + remap.sheetSuffix + sheet.slice(dot) : sheet + remap.sheetSuffix;
  return sheets.has(mapped) ? mapped : sheet;
}

/**
 * Merge every piece drawn on `model` into one look, in order: a part named by
 * two pieces wears the LATER one's sheet (a cloak over a chest). Pieces on other
 * models are skipped; null when none is on this one (nothing to draw).
 * `opts.remap` maps each piece onto the wearer's body first (see {@link ComposeOptions}).
 */
export function composeModelLook(
  pieces: ReadonlyArray<LookPiece | null | undefined>,
  model: string,
  opts: ComposeOptions = {},
): ComposedLook | null {
  const sheetOf = new Map<string, string | null>();
  let any = false;
  for (const piece of pieces) {
    if (!piece || piece.model !== model) continue;
    any = true;
    const sheet = opts.remap ? remapSheet(piece.texture, opts.remap, opts.sheets) : (piece.texture ?? null);
    for (const raw of piece.parts) {
      const part = remapPart(raw, opts.remap);
      // re-insert so a later piece's part keeps its own position in the merge order
      sheetOf.delete(part);
      sheetOf.set(part, sheet);
    }
  }
  if (!any) return null;
  const groups = new Map<string | null, string[]>();
  for (const [part, sheet] of sheetOf) {
    let list = groups.get(sheet);
    if (!list) groups.set(sheet, (list = []));
    list.push(part);
  }
  return {
    parts: [...sheetOf.keys()],
    groups: [...groups].map(([texture, parts]) => ({ parts, texture })),
  };
}

// -- the whole character ------------------------------------------------------------

/** A sheet of a model that paints bare skin (opt-in): the whole sheet, or only some parts' islands. */
export interface SkinSheetRef {
  texture: string;
  parts?: string[];
}

/** What one model of a character draws. */
export interface ModelDress {
  model: string;
  /** Parts shown (less what other worn models hide); empty = nothing of this model shows. */
  parts: string[];
  /** Which sheet each group of parts wears. */
  groups: Array<{ parts: string[]; texture: string | null }>;
  /** Skin tone for the skin texels (tintWhole false), or the whole sheet's colour (tintWhole true: hair). */
  tint: string | null;
  /** The whole sheet takes `tint` (the hair ubermesh: every texel is hair). */
  tintWhole: boolean;
  /** Every sheet of this model any wearer may show that paints bare skin — the same list for every character. */
  skinSheets: SkinSheetRef[];
  /** Where it sits on the body; null for the body itself (or a model with no mount). */
  mount: ModelPlacement | null;
}

export interface DressResult {
  /** The body model (what the character's skinned mesh draws). */
  body: string;
  /** Uniform scale of the whole character (the female body is the male rig at 0.96). */
  scale: number;
  /** Every model the character shows or could show (every mounted model too), keyed by model id. */
  models: Map<string, ModelDress>;
}

export interface DressInput {
  creation: CharacterCreation;
  /** The build's appearance choices; null/absent = the defaults. Preview rows are ignored. */
  appearance?: Record<string, string> | null | undefined;
  /** Equipped items' appearances, in slot order (later wins a shared part). */
  items: ReadonlyArray<LookPiece | null | undefined>;
  /** A model's part rules (its `rules` extras), for `hides`; unknown = hides nothing. */
  rules?: (model: string) => PartRules | null | undefined;
  /** The sheets on a model's page (its `tiles`), for the remap's `-f` sheets; unknown = never remap a sheet. */
  sheets?: (model: string) => ReadonlySet<string> | null | undefined;
}

/**
 * Dress a character: its body's UNEQUIPPED look (the body option's own parts
 * and sheet) under every equipped item on the body, mapped onto the wearer's
 * body (`remap`); its face, hair and beard from the build; every item on a
 * socketed model (helm, shoulders) with that model's mount for this wearer;
 * skin tone and hair colour; and each worn model's `hides` taken off the
 * others (a helm hides the hair, a face cover the head).
 *
 * The creator's PREVIEW rows never reach this: in game, equipment dresses a
 * character. Pure — every tab computes the same result from the replicated
 * sheet.
 */
export function dressCharacter(input: DressInput): DressResult {
  const { creation } = input;
  const appearance = buildAppearance(creation, { appearance: input.appearance ?? {} });
  const body = bodyModelOf(creation, { appearance });
  const bodyOption = bodyOptionOf(creation, { appearance });
  const pieces: LookPiece[] = [];
  // the unequipped layer first: every item on the body draws over it
  if (bodyOption?.parts?.length) pieces.push({ model: body, parts: bodyOption.parts, texture: bodyOption.texture ?? null });
  const tints = new Map<string, string | null>();
  const whole = new Set<string>();
  let tone: string | null = null;
  for (const slot of creation.appearance) {
    if (slot.preview || slot.body) continue;
    const option = slot.options.find((o) => o.id === appearance[slot.id]);
    for (const model of slot.tintModels ?? []) {
      whole.add(model);
      tints.set(model, option?.color ?? null);
    }
    if (slot.material === "Skin" && option?.color) tone = option.color;
    if (option?.model) pieces.push({ model: option.model, parts: option.parts ?? [], texture: option.texture ?? null });
  }
  for (const item of input.items) if (item) pieces.push(item);

  // skin sheets: every sheet any option opts in as skin, per model — one list per model for every wearer
  const skin = new Map<string, SkinSheetRef[]>();
  for (const slot of creation.appearance) {
    for (const option of slot.options) {
      if (!option.skin || !option.model || !option.texture) continue;
      let list = skin.get(option.model);
      if (!list) skin.set(option.model, (list = []));
      const parts = option.skin === true ? undefined : option.skin;
      const same = list.find((s) => s.texture === option.texture);
      if (!same) list.push(parts ? { texture: option.texture, parts: [...parts] } : { texture: option.texture });
      else if (same.parts) {
        if (!parts) delete same.parts;
        else same.parts = [...new Set([...same.parts, ...parts])];
      }
    }
  }

  const models = new Map<string, ComposedLook>();
  const modelIds = new Set<string>([body, ...pieces.map((p) => p.model), ...creation.mounts.map((m) => m.model)]);
  for (const model of modelIds) {
    const composed =
      model === body
        ? composeModelLook(pieces, model, { remap: bodyOption?.remap, sheets: input.sheets?.(model) })
        : composeModelLook(pieces, model);
    models.set(model, composed ?? { parts: [], groups: [] });
  }
  // what each model's shown parts cover on the others
  const covered = new Map<string, Set<string>>();
  for (const [model, look] of models) {
    const rules = input.rules?.(model);
    if (!rules || look.parts.length === 0) continue;
    covered.set(model, partsHiddenBy(rules, look.parts));
  }
  const out = new Map<string, ModelDress>();
  for (const [model, look] of models) {
    const hidden = new Set<string>();
    for (const [other, set] of covered) if (other !== model) for (const p of set) hidden.add(p);
    const keep = (p: string): boolean => !hidden.has(p);
    const isWhole = whole.has(model);
    out.set(model, {
      model,
      parts: look.parts.filter(keep),
      groups: look.groups.map((g) => ({ parts: g.parts.filter(keep), texture: g.texture })).filter((g) => g.parts.length > 0),
      tint: isWhole ? (tints.get(model) ?? null) : skin.has(model) ? tone : null,
      tintWhole: isWhole,
      skinSheets: skin.get(model) ?? [],
      mount: model === body ? null : mountFor(creation, model, appearance),
    });
  }
  return { body, scale: bodyOption?.scale ?? 1, models: out };
}
