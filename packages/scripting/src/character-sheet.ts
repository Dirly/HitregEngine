import {
  addItem,
  allocate,
  characterEventDecls,
  characterSheetSchema,
  CHARACTER_EVENTS,
  createSheet,
  derivedStats,
  equip,
  grantXp,
  moveItem,
  removeItem,
  splitStack,
  unequip,
  type Attribute,
  type CharacterSheet,
  type EquipmentSlot,
  type GridTarget,
  type SheetEnv,
  type SheetResult,
} from "@hitreg/core";
import { Script, type ScriptEventDecl } from "./script.js";
import {
  catalogOf,
  forgetLocalSheet,
  progressionOf,
  readSheet,
  sheetKey,
  sheetStoreOf,
  type SheetStoreLike,
} from "./character-store.js";

/**
 * The authority's half of a character: level, attributes, equipment and the
 * grid inventory, kept as ONE netState value (`character/<bodyId>`) that the
 * reducers in @hitreg/core mutate.
 *
 * Nothing here trusts a client. Every change arrives as a request event —
 * the inventory UI asks to move a stack, a loot pickup asks to give one —
 * and is applied on the session authority only, after checking that the
 * requesting peer OWNS the body (`owner/<bodyId>` in netState, written by the
 * dedicated server; a local emission has no sender and is trusted). Grants
 * (`character.xp`, `inventory.give`) are not replicated at all, so a peer
 * cannot award itself anything: only an authoritative script can emit them
 * where they will be heard.
 *
 * Attach it to the body, or to a child with `actor` naming the body — the
 * same composition as combat scripts, so one body can carry a controller, a
 * combat actor and a sheet. Derived stats (effective attributes, pools,
 * weight, encumbrance) are mirrored onto the body's `object.userData.character`
 * so movement and combat scripts can read "how heavy am I" without knowing
 * where the sheet lives.
 *
 * Persistence: the LOCAL player's sheet round-trips through ctx.playerData
 * (namespace "character", key "sheet") — a dev convenience per ARCHITECTURE
 * §3c; the dedicated server owns real saves later, on the same document.
 */
export class CharacterSheetScript extends Script {
  static override scriptName = "character-sheet";

  static override params = {
    actor: { default: "", description: "entity id of the body this sheet belongs to; empty = this entity" },
    progression: {
      default: "",
      description:
        "progression data-asset id (assets/progression/<id>.json) — levels, xp curve, points, stat formulas; empty = engine defaults (20 levels, 1 point a level)",
    },
    startingLevel: { default: 1, min: 1, max: 200, description: "a fresh sheet starts here, with the points that many levels imply" },
    startingItems: {
      default: [] as Array<{ itemId: string; qty?: number; equip?: boolean }>,
      description:
        '[{ "itemId": "<items/ id>", "qty": 1, "equip": false }] given to a fresh sheet in order (put the bag first, equipped, so the rest has room) — ignored when a saved sheet is restored',
    },
    persist: {
      default: true,
      description:
        'save the LOCAL player\'s sheet through ctx.playerData (namespace "character") and restore it on start; NPCs and remote players never persist here',
    },
    publishUserData: {
      default: true,
      description: "mirror derived stats onto the body's object.userData.character (and .encumbrance) so controllers/combat read them",
    },
  };

  static override events: ScriptEventDecl[] = [...characterEventDecls];

  private store!: SheetStoreLike;
  private env!: SheetEnv;
  private actorId = "";
  private cancelPersist: (() => void) | null = null;
  private usedLocalStore = false;

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    this.usedLocalStore = this.ctx.netState === undefined;
    this.actorId = this.param<string>("actor") || this.entityId;
    this.env = {
      catalog: catalogOf(this.ctx),
      progression: progressionOf(this.ctx, this.param<string>("progression")),
    };

    if (this.store.isAuthority()) {
      // A promoted host inherits the replica — never reseed over a live sheet.
      if (!readSheet(this.store, this.actorId)) this.write(this.fresh(), false);
      void this.restore();
    }
    this.publish();
    this.store.onChange((key) => {
      if (key === sheetKey(this.actorId)) this.publish();
    });

    const on = <T>(name: string, fn: (payload: T, meta?: { from?: string }) => void): void => {
      this.ctx.events?.on(name, (payload, meta) => fn(payload as T, meta));
    };
    on<{ actorId: string; attribute: Attribute }>(CHARACTER_EVENTS.allocate, (p, meta) =>
      this.handle("allocate", p, meta, (s) => allocate(s, p.attribute, this.env)),
    );
    on<{ actorId: string; amount: number }>(CHARACTER_EVENTS.xp, (p, meta) => {
      if (meta?.from !== undefined) return; // grants are authority-internal
      const r = this.handle("xp", p, meta, (s) => grantXp(s, p.amount, this.env));
      if (r?.ok && r.levelsGained > 0) {
        this.ctx.events?.emit(CHARACTER_EVENTS.leveled, {
          actorId: this.actorId,
          level: r.sheet.level,
          unspent: r.sheet.unspent,
        });
      }
    });
    on<{ actorId: string; itemId: string; qty: number }>(CHARACTER_EVENTS.give, (p, meta) => {
      if (meta?.from !== undefined) return;
      const r = this.handle("give", p, meta, (s) => addItem(s, p.itemId, p.qty ?? 1, this.env));
      if (r?.ok && r.placed < (p.qty ?? 1)) this.refuse("give", `only ${r.placed} of ${p.qty} ${p.itemId} fit`);
    });
    on<{ actorId: string; uid: string; to: GridTarget }>(CHARACTER_EVENTS.move, (p, meta) =>
      this.handle("move", p, meta, (s) => moveItem(s, p.uid, p.to, this.env)),
    );
    on<{ actorId: string; uid: string; slot?: EquipmentSlot }>(CHARACTER_EVENTS.equip, (p, meta) =>
      this.handle("equip", p, meta, (s) => equip(s, p.uid, p.slot, this.env)),
    );
    on<{ actorId: string; slot: EquipmentSlot; to?: GridTarget }>(CHARACTER_EVENTS.unequip, (p, meta) =>
      this.handle("unequip", p, meta, (s) => unequip(s, p.slot, p.to, this.env)),
    );
    on<{ actorId: string; uid: string; qty?: number }>(CHARACTER_EVENTS.drop, (p, meta) => {
      const r = this.handle("drop", p, meta, (s) => removeItem(s, p.uid, p.qty, this.env));
      if (r?.ok) {
        const body = this.ctx.getObject(this.actorId) ?? this.object;
        const at = body.position;
        this.ctx.events?.emit(CHARACTER_EVENTS.dropped, {
          actorId: this.actorId,
          itemId: r.removed.itemId,
          qty: r.removed.qty,
          at: [at.x, at.y, at.z],
        });
      }
    });
    on<{ actorId: string; uid: string; qty: number; to: GridTarget }>(CHARACTER_EVENTS.split, (p, meta) =>
      this.handle("split", p, meta, (s) => splitStack(s, p.uid, p.qty, p.to, this.env)),
    );
  }

  /** A brand-new sheet from the params: level, then the starting items. */
  private fresh(): CharacterSheet {
    let sheet = createSheet(this.env.progression, this.param<number>("startingLevel"));
    for (const entry of this.param<Array<{ itemId?: string; qty?: number; equip?: boolean }>>("startingItems") ?? []) {
      if (!entry?.itemId) continue;
      const r = addItem(sheet, entry.itemId, entry.qty ?? 1, this.env);
      if (!r.ok) {
        console.warn(`[character-sheet] ${this.actorId}: starting item skipped — ${r.error}`);
        continue;
      }
      sheet = r.sheet;
      if (entry.equip) {
        const worn = equip(sheet, r.uids[r.uids.length - 1]!, undefined, this.env);
        if (worn.ok) sheet = worn.sheet;
        else console.warn(`[character-sheet] ${this.actorId}: could not equip starting ${entry.itemId} — ${worn.error}`);
      }
    }
    return sheet;
  }

  /**
   * A request over the wire (`meta.from` set) may only act on a body its
   * sender OWNS; a local emission has no sender and is trusted (single-player,
   * or an authoritative script asking on the host).
   */
  private mayAct(meta?: { from?: string }): boolean {
    if (meta?.from === undefined) return true;
    return this.store.get(`owner/${this.actorId}`) === meta.from;
  }

  private handle<T>(
    request: string,
    payload: { actorId: string },
    meta: { from?: string } | undefined,
    reduce: (sheet: CharacterSheet) => SheetResult<T>,
  ): ({ ok: true; sheet: CharacterSheet } & T) | null {
    if (payload.actorId !== this.actorId) return null;
    if (!this.store.isAuthority()) return null;
    if (!this.mayAct(meta)) {
      this.refuse(request, "that is not your character");
      return null;
    }
    const sheet = readSheet(this.store, this.actorId);
    if (!sheet) return null;
    const r = reduce(sheet);
    if (!r.ok) {
      this.refuse(request, r.error);
      return null;
    }
    this.write(r.sheet, true);
    return r;
  }

  private refuse(request: string, error: string): void {
    this.ctx.events?.emit(CHARACTER_EVENTS.refused, { actorId: this.actorId, request, error });
  }

  private write(sheet: CharacterSheet, persist: boolean): void {
    if (!this.store.set(sheetKey(this.actorId), sheet)) return;
    this.publish();
    if (persist) this.schedulePersist();
  }

  /** Derived stats onto the body for other scripts (a controller's weight, a HUD's pools). */
  private publish(): void {
    if (!this.param<boolean>("publishUserData")) return;
    const sheet = readSheet(this.store, this.actorId);
    const body = this.ctx.getObject(this.actorId) ?? this.object;
    if (!sheet) {
      delete body.userData["character"];
      delete body.userData["encumbrance"];
      return;
    }
    const derived = derivedStats(sheet, this.env);
    body.userData["character"] = derived;
    body.userData["encumbrance"] = derived.encumbrance;
  }

  // -- persistence (local player only; a dev convenience until servers own saves) --

  private persists(): boolean {
    return (
      this.param<boolean>("persist") &&
      this.ctx.playerData !== undefined &&
      this.ctx.localPlayer?.() === this.actorId
    );
  }

  private schedulePersist(): void {
    if (!this.persists()) return;
    this.cancelPersist?.();
    // coalesce a burst of drags into one write — the service is rate-limited
    this.cancelPersist = this.ctx.after(0.5, () => {
      this.cancelPersist = null;
      const sheet = readSheet(this.store, this.actorId);
      if (!sheet) return;
      this.ctx.playerData
        ?.set("character", "sheet", sheet)
        .catch((error: unknown) => console.warn("[character-sheet] save failed:", error));
    });
  }

  private async restore(): Promise<void> {
    if (!this.persists()) return;
    try {
      const saved = await this.ctx.playerData!.get("character", "sheet");
      if (saved === undefined) return;
      const parsed = characterSheetSchema.safeParse(saved);
      if (!parsed.success) {
        console.warn("[character-sheet] saved sheet is invalid — starting fresh");
        return;
      }
      if (!this.store.isAuthority()) return; // role changed while we waited
      this.write(parsed.data, false);
    } catch (error) {
      console.warn("[character-sheet] restore failed:", error);
    }
  }

  override onDispose(): void {
    this.cancelPersist?.();
    this.cancelPersist = null;
    if (this.usedLocalStore) forgetLocalSheet(this.actorId);
  }
}
