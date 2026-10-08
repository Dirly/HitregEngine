import { composeModelLook, handKey, readHand, twoHanderOf, type EquipmentSlot, type LookPiece } from "@hitreg/core";
import { Script, type ModelLook } from "./script.js";
import { catalogOf, readSheet, sheetKey, sheetStoreOf, type SheetStoreLike } from "./character-store.js";

/**
 * Shows what a character has EQUIPPED on a model: the sword in the hand, the
 * helm on the head.
 *
 * Put the item's model on an entity once — an ubermesh, every variant of every
 * part (a sword's four blades, four guards, three collars, three pommels) —
 * socketed where it belongs (`bone-socket`), and put this script on a CHILD of
 * that entity. Whenever the slot changes it reads the equipped item's
 * `appearance` (a list of part names plus a theme sheet) and hands it to
 * `ctx.setModelLook`, which trims the model to those parts and swaps the
 * sheet, and carries its glow and standing effects (embers anchored at a
 * blade's tip). An empty slot, or an item with no `appearance`, hides every
 * part and drops every effect.
 *
 * One slot, several models: a hand that can hold a longsword OR a greataxe
 * carries one socketed entity per ubermesh, each with its own look on the same
 * slot. A look shows only on the entity whose mesh IS the item's
 * `appearance.model`; every other one hides, or the axe's part names would be
 * looked up on the sword.
 *
 * Watches the replicated character sheet (`character/<actor>` in netState),
 * so every tab draws every character's gear from the same fact, and equipping
 * needs no event of its own. Presentation only: on a dedicated server there is
 * no `setModelLook` and this does nothing.
 *
 * Several slots, ONE model: `slot: "chest,legs,gloves,boots"` on the body.
 * Every item in those slots drawn on the target's model is merged (core
 * `composeModelLook`, later slots win a shared part) into one look whose
 * `groups` give each item's parts its own sheet — a vanguard chest over
 * ranger legs is still one mesh, one material, one draw.
 *
 * The hand follows the WEAPON SET in hand (netState `hand/<actor>`, core
 * `readHand`): while set 1 is held a `primary` look shows the `secondary`
 * item and an `offhand` look shows nothing. `inHand: false` opts out (a
 * sheath that always shows the primary).
 */
export class EquipmentLook extends Script {
  static override scriptName = "equipment-look";
  static override presentation = true;
  /** Nothing to place or swap on a dedicated server (no skeleton, no meshes, nobody looking): it never runs there. */
  static clientOnly = true;
  static override params = {
    actor: {
      default: "",
      description: "entity id of the body whose character sheet to read (the one `character-sheet` names as its actor)",
    },
    slot: {
      default: "primary",
      description:
        "equipment slot id to show (primary, secondary, helm, chest …); several, comma-separated (chest,legs,gloves,boots), merge every item on the target's model into one per-part look",
    },
    target: {
      default: "",
      description: "entity whose model shows the item; empty = this entity's PARENT (the socketed model)",
    },
    inHand: {
      default: true,
      description: "a primary/offhand look follows the weapon set in hand: set 1 shows the secondary item in the primary hand and an empty off hand",
    },
    item: {
      default: "",
      description: "a FIXED item id to show instead of reading a sheet — a townsperson's sword; non-empty = `actor` and `slot` are ignored",
    },
  };

  private store!: SheetStoreLike;
  private target = "";
  /** The model asset the target draws; "" when it is not an asset mesh, and then any item's model is accepted. */
  private targetModel = "";
  /** The last look sent, serialised. */
  private shown = "";
  private unsubscribe: (() => void) | null = null;

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    this.target = this.param<string>("target") || this.ctx.getEntity(this.entityId)?.parent || "";
    if (!this.target) {
      console.warn(`[equipment-look] ${this.entityId}: no target — set \`target\` or parent this under the model`);
      return;
    }
    const mesh = this.ctx.getEntity(this.target)?.components.mesh as
      | { source?: { kind?: string; assetId?: string } }
      | undefined;
    this.targetModel = mesh?.source?.kind === "asset" ? (mesh.source.assetId ?? "") : "";
    const actor = this.param<string>("actor");
    this.refresh();
    this.unsubscribe = this.store.onChange((key) => {
      if (key === sheetKey(actor) || key === handKey(actor)) this.refresh();
    });
  }

  override onDispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private refresh(): void {
    const fixed = this.param<string>("item");
    if (fixed) return this.show(fixed);
    const sheet = readSheet(this.store, this.param<string>("actor"));
    const slots = this.param<string>("slot").split(",").map((s) => s.trim()).filter(Boolean) as EquipmentSlot[];
    if (slots.length > 1) {
      this.showComposed(slots.map((slot) => {
        const uid = sheet?.equipment[slot];
        return uid ? sheet?.items[uid]?.itemId ?? null : null;
      }));
      return;
    }
    let slot = slots[0] ?? ("primary" as EquipmentSlot);
    // the secondary set is held alone, in the main hand
    const second = this.param<boolean>("inHand") && readHand(this.store, this.param<string>("actor")).set === 1;
    if (second && slot === "primary") slot = "secondary";
    // an off-hand item stays worn under a two-hander, but is not drawn
    const blocked = slot === "offhand" && sheet && (second || twoHanderOf(sheet, { catalog: catalogOf(this.ctx) }));
    const uid = blocked ? undefined : sheet?.equipment[slot];
    this.show(uid ? sheet?.items[uid]?.itemId ?? null : null);
  }

  /** Several slots on one model: one look, a sheet group per item. */
  private showComposed(itemIds: Array<string | null>): void {
    const catalog = catalogOf(this.ctx);
    const pieces: LookPiece[] = [];
    for (const id of itemIds) {
      const appearance = id ? catalog(id)?.appearance : undefined;
      if (appearance) pieces.push({ model: appearance.model, parts: appearance.parts, texture: appearance.texture ?? null });
    }
    const model = this.targetModel || pieces[0]?.model || "";
    const composed = composeModelLook(pieces, model);
    const look: ModelLook = composed
      ? { parts: composed.parts, groups: composed.groups, glow: null, effects: [] }
      : { partMask: 0, groups: null, glow: null, effects: [] };
    const key = JSON.stringify(look);
    if (key === this.shown) return;
    this.shown = key;
    this.ctx.setModelLook?.(this.target, look);
  }

  private show(itemId: string | null): void {
    const found = itemId ? catalogOf(this.ctx)(itemId)?.appearance : undefined;
    // another model's item: this entity hides, the one drawing that model shows it
    const appearance = found && this.targetModel && found.model !== this.targetModel ? undefined : found;
    const look: ModelLook = appearance
      ? {
          parts: appearance.parts,
          texture: appearance.texture ?? null,
          glow: appearance.glow ?? null,
          effects: appearance.effects ?? [],
        }
      : { partMask: 0, glow: null, effects: [] };
    // the sheet changes on every pickup and potion; the look only on a swap
    const key = JSON.stringify(look);
    if (key === this.shown) return;
    this.shown = key;
    if (itemId && !found) console.info(`[equipment-look] "${itemId}" has no appearance — nothing to show`);
    this.ctx.setModelLook?.(this.target, look);
  }
}
