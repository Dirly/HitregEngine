import type { EquipmentSlot, Item } from "@hitreg/core";
import { z } from "zod";
import { Script, type ScriptCommandDecl, type ScriptEventDecl } from "./script.js";
import { catalogOf, readSheet, sheetKey, sheetStoreOf, type SheetStoreLike } from "./character-store.js";

/**
 * The animation stance of what a character is HOLDING: reads the main-hand and
 * off-hand items' `stance` lists off the replicated character sheet and writes
 * the combined list to the body's `userData.stance`, which the
 * `third-person-controller` uses to dress every clip it plays
 * (`GreatSword_Run`, `SwordShield_Attack1`, `Staff_Death`).
 *
 * Combination is the one rule: an off-hand stance is a SUFFIX on each
 * main-hand stance, tried before the main hand alone. A Sword with a Shield is
 * ["SwordShield", "Sword"]; a greataxe (["Axe2H", "TwoHanded"]) with nothing
 * in the off hand is just that; a shield alone is ["Shield"]. So a bake only
 * needs the clips that actually DIFFER — a greataxe borrows every two-handed
 * clip it has no axe version of, and a sword-and-board fighter every sword
 * clip it has no shield version of.
 *
 * Every tab runs it off the same sheet, so every tab dresses every character
 * the same way with no event of its own. Presentation only.
 *
 * HOLSTERING. `holsterKey` sheathes and draws. The state is replicated
 * (`holster/<actor>` in netState, written by the authority on a
 * `stance.holster` request from the body's owner) and shows as
 * `userData.holstered` on the body, which the weapon slots' `bone-socket`
 * reads as its `altWhen`: a holstered weapon takes its SECOND pose, on the
 * back. Fighting draws — anything that marks the body `combatUntil` (a swing,
 * a block, a hit) asks to unholster. A `Sheathe`/`Draw` clip plays on the
 * arms (dressed per stance: SwordShield_Draw, TwoHanded_Draw), and the
 * weapons change slot `swapDelay` seconds in — when the hand reaches the back,
 * not the moment the key goes down.
 */
export class WeaponStance extends Script {
  static override scriptName = "weapon-stance";
  static override params = {
    actor: {
      default: "",
      description: "entity id of the body whose character sheet to read (the one `character-sheet` names as its actor)",
    },
    body: {
      default: "",
      description: "entity carrying the third-person-controller; empty = this entity's PARENT",
    },
    mainSlot: { default: "primary", description: "equipment slot of the main hand" },
    offSlot: { default: "offhand", description: "equipment slot of the off hand" },
    holsterKey: {
      default: "",
      description: "key that holsters / draws (e.g. KeyG). Empty = no holstering. Set it on the LOCAL player only.",
    },
    swapDelay: {
      default: 0.3,
      min: 0,
      max: 2,
      description: "seconds into the draw/sheathe clip at which the weapons move between hand and back",
    },
    console: {
      default: false,
      description: "answer /stance (preview any stance without the item). Set it on the LOCAL player only.",
    },
  };
  static override events: ScriptEventDecl[] = [
    {
      name: "stance.holster",
      schema: z.object({
        actorId: z.string().min(1).describe("the body whose weapons to holster or draw"),
        holstered: z.boolean(),
      }),
      options: { replicate: "to-authority" },
    },
  ];
  static override commands: ScriptCommandDecl[] = [
    {
      name: "stance",
      args: "[Stance[,Fallback…] | off]",
      description: "Hold any weapon stance without the item (GreatSword, Axe2H,TwoHanded, Staff…). Bare /stance reports; 'off' returns to the equipped one.",
    },
  ];

  private store!: SheetStoreLike;
  private bodyId = "";
  private forced: string[] | null = null;
  private equipped: string[] = [];
  private unsubscribe: (() => void) | null = null;
  private unsubscribeHolster: (() => void) | null = null;
  /** What the body shows right now (lags the replicated state by swapDelay). */
  private shownHolstered = false;
  private keyWasDown = false;
  private cancelSwap: (() => void) | null = null;
  /** combatUntil when the weapons went away: only a NEWER fight draws them. */
  private holsteredDuring = 0;

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    this.bodyId = this.param<string>("body") || this.ctx.getEntity(this.entityId)?.parent || "";
    const actor = this.param<string>("actor");
    this.refresh();
    this.unsubscribe = this.store.onChange((key) => {
      if (key === sheetKey(actor)) this.refresh();
    });
    // holstering: the authority takes requests from the body's owner; every
    // tab follows the replicated flag
    this.ctx.events?.on("stance.holster", (payload, meta) => {
      const p = payload as { actorId: string; holstered: boolean };
      if (p.actorId !== actor || !this.store.isAuthority()) return;
      if (meta?.from !== undefined && this.store.get(`owner/${actor}`) !== meta.from) return;
      this.store.set(`holster/${actor}`, p.holstered);
    });
    this.shownHolstered = this.store.get(`holster/${actor}`) === true;
    this.applyHolster(this.shownHolstered);
    this.unsubscribeHolster = this.store.onChange((key, value) => {
      if (key === `holster/${actor}`) this.holsterChanged(value === true);
    });
  }

  override onFixedUpdate(): void {
    const actor = this.param<string>("actor");
    const key = this.param<string>("holsterKey");
    if (key) {
      const down = this.ctx.input.isDown(key);
      if (down && !this.keyWasDown) this.request(!this.holstered());
      this.keyWasDown = down;
    }
    // fighting draws: a swing, a block or a hit marks the body in combat
    const body = this.bodyId ? this.ctx.getObject(this.bodyId) : undefined;
    const until = body?.userData["combatUntil"];
    // (a fight still lingering when G was pressed must not undo it at once)
    if (actor && this.holstered() && typeof until === "number" && until > this.holsteredDuring && until > this.ctx.now() / 1000) {
      this.request(false);
    }
  }

  private holstered(): boolean {
    return this.store.get(`holster/${this.param<string>("actor")}`) === true;
  }

  private request(holstered: boolean): void {
    const actorId = this.param<string>("actor");
    if (!actorId) return;
    if (this.ctx.events) this.ctx.events.emit("stance.holster", { actorId, holstered });
    else this.store.set(`holster/${actorId}`, holstered);
  }

  /** The replicated flag moved: play the clip now, move the weapons when the hand gets there. */
  private holsterChanged(holstered: boolean): void {
    if (holstered === this.shownHolstered && !this.cancelSwap) return;
    const body = this.bodyId ? this.ctx.getObject(this.bodyId) : undefined;
    if (holstered) {
      const until = body?.userData["combatUntil"];
      this.holsteredDuring = typeof until === "number" ? until : 0;
    }
    if (body) {
      const now = this.ctx.now() / 1000;
      const busy = typeof body.userData["actionClip"] === "string" && ((body.userData["actionUntil"] as number) ?? 0) > now;
      if (!busy || !holstered) {
        body.userData["actionClip"] = holstered ? "Sheathe" : "Draw";
        body.userData["actionUntil"] = now + 0.8;
        body.userData["actionHold"] = false;
        body.userData["actionUpperBody"] = true; // you walk while you draw
      }
    }
    this.cancelSwap?.();
    const delay = this.param<number>("swapDelay");
    const swap = (): void => {
      this.cancelSwap = null;
      this.applyHolster(holstered);
    };
    if (delay > 0) this.cancelSwap = this.ctx.after(delay, swap);
    else swap();
  }

  private applyHolster(holstered: boolean): void {
    this.shownHolstered = holstered;
    const body = this.bodyId ? this.ctx.getObject(this.bodyId) : undefined;
    if (!body) return;
    if (holstered) body.userData["holstered"] = true;
    else delete body.userData["holstered"];
  }

  override onDispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeHolster?.();
    this.unsubscribeHolster = null;
    this.cancelSwap?.();
    this.cancelSwap = null;
  }

  override onCommand(name: string, args: string[]): string | null {
    if (name !== "stance" || !this.param<boolean>("console")) return null;
    const arg = args.join(" ").trim();
    if (!arg) return `stance: ${this.shown().join(", ") || "(none)"}${this.forced ? " (forced)" : ""}`;
    if (arg === "off" || arg === "auto") {
      this.forced = null;
    } else {
      this.forced = arg.split(/[\s,]+/).filter(Boolean);
    }
    this.apply();
    return `stance: ${this.shown().join(", ") || "(none)"}${this.forced ? " (forced)" : ""}`;
  }

  /** The stance list for a main-hand and off-hand item, per the rule above. */
  static combine(main: Item | undefined, off: Item | undefined): string[] {
    const m = main?.stance ?? [];
    const o = off?.stance ?? [];
    if (!o.length) return [...m];
    if (!m.length) return [...o];
    return [...o.flatMap((suffix) => m.map((s) => `${s}${suffix}`)), ...m];
  }

  private refresh(): void {
    const sheet = readSheet(this.store, this.param<string>("actor"));
    const catalog = catalogOf(this.ctx);
    const itemIn = (slot: string): Item | undefined => {
      const uid = sheet?.equipment[slot as EquipmentSlot];
      const itemId = uid ? sheet?.items[uid]?.itemId : undefined;
      return itemId ? catalog(itemId) : undefined;
    };
    const main = itemIn(this.param<string>("mainSlot"));
    // a two-hander leaves no hand for the (still worn, inactive) off-hand item
    this.equipped = WeaponStance.combine(main, main?.twoHanded ? undefined : itemIn(this.param<string>("offSlot")));
    this.apply();
  }

  private shown(): string[] {
    return this.forced ?? this.equipped;
  }

  private apply(): void {
    const body = this.bodyId ? this.ctx.getObject(this.bodyId) : undefined;
    if (!body) return;
    const stance = this.shown();
    if (stance.length) body.userData["stance"] = stance;
    else delete body.userData["stance"];
  }
}
