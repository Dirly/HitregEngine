import {
  actionSeconds,
  addItem,
  allocate,
  applyBuild,
  archetypeStartingItems,
  archetypeStartingCoins,
  characterEventDecls,
  characterSheetSchema,
  CHARACTER_EVENTS,
  createSheet,
  changesWornGear,
  derivedStats,
  equip,
  EQUIPMENT_SLOTS,
  itemFitsSlot,
  firstFit,
  gridOf,
  grantXp,
  handKey,
  moveItem,
  readHand,
  removeItem,
  splitStack,
  unequip,
  useItem,
  validateBuild,
  wearEquipped,
  type Attribute,
  type CharacterCreation,
  type CharacterSheet,
  type EquipmentSlot,
  type GridTarget,
  type InventoryCommand,
  type SheetEnv,
  type SheetResult,
  GROUND_NETSTATE,
  groundItemSchema,
  LOOT_NETSTATE,
  lootBag,
  lootBagSchema,
  pickUp,
  takeFromBag,
  takeBagCoins,
  transferStack,
  bodyBagSpent,
  isDowned,
  isLootLocked,
  LOOT_BAG_CAP,
  LOOT_LOCK_NETSTATE,
  LOOT_ROLL_NETSTATE,
  LOOT_SAVE_NETSTATE,
  lootClock,
  lootRollSchema,
  RARITIES,
  resolveRoll,
  rollAnswered,
  savedBagsSchema,
  type LooseStack,
  type LootBag,
  type LootRoll,
  type RollChoice,
  type StackTransferOptions,
  corpseClaimed,
  corpseContents,
  isEntrusted,
  isPlundered,
  releaseCorpse,
  soulProtected,
} from "@hitreg/core";
import { Script, type ScriptCommandDecl, type ScriptEventDecl } from "./script.js";
import {
  catalogOf,
  forgetLocalSheet,
  progressionOf,
  readSheet,
  sheetKey,
  sheetStoreOf,
  type SheetStoreLike,
} from "./character-store.js";

/** An `inventory.transfer` request (core CHARACTER_EVENTS.transfer). */
interface TransferRequest {
  actorId: string;
  toActorId: string;
  uid: string;
  qty?: number;
  to?: GridTarget;
  range?: number;
  allowWorn?: boolean;
}

/** A `inventory.bag` request (core CHARACTER_EVENTS.bag). */
interface BagRequest {
  actorId: string;
  at: [number, number, number];
  items?: Array<{ itemId: string; qty?: number; twists?: string[] }>;
  body?: string;
  offer?: string[];
  takes?: number;
  carried?: string[];
  coins?: number;
  share?: boolean;
  seconds?: number;
  from?: string;
}

/** An `inventory.corpse` request (core CHARACTER_EVENTS.corpse). */
interface CorpseRequest {
  actorId: string;
  at: [number, number, number];
  seconds?: number;
  killer?: string;
  claimSeconds?: number;
  offer?: string[];
  takes?: number;
  plunder?: number;
  from?: string;
}

/** An `inventory.loot` request. */
interface LootRequest {
  actorId: string;
  bagId: string;
  index?: number;
  uid?: string;
  all?: boolean;
  coins?: boolean;
  done?: boolean;
}

/** Bag ids are unique per process: owner, sim time and this counter. */
let dropSeq = 0;
/** Sim time each store's ground and bags were last swept for expired ones. */
const lastSweep = new WeakMap<SheetStoreLike, number>();
/** Per store, per party: whose turn it is for the next round-robin item. */
const roundRobin = new WeakMap<SheetStoreLike, Map<string, number>>();
/** Requests a loot-locked character may not make: anything that moves an item out of where it is. */
const LOCKED_REQUESTS = ["move", "equip", "unequip", "drop", "split", "transfer"];
const LOCKED_REFUSAL = "you are being looted: your belongings cannot move until it is over";
/** Player requests a downed character (core isDowned) may not make. */
const DOWNED_REFUSED = new Set<string>([
  CHARACTER_EVENTS.move, CHARACTER_EVENTS.equip, CHARACTER_EVENTS.unequip, CHARACTER_EVENTS.drop, CHARACTER_EVENTS.split,
  CHARACTER_EVENTS.use, CHARACTER_EVENTS.loot, CHARACTER_EVENTS.pickup, CHARACTER_EVENTS.swap, CHARACTER_EVENTS.soulbind,
  CHARACTER_EVENTS.allocate,
]);
const DOWNED_REFUSAL = "you are down";

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
    creation: {
      default: "",
      description:
        "creation data-asset id (assets/creation/<id>.json) — when the body arrives with a build (netState build/<bodyId>, written by the server from the play ticket), a FRESH sheet gets its archetype lean, records its traits + appearance, and is given the archetype's startingItems (worn first; this script's own never displace them); empty = builds are ignored",
    },
    startingLevel: { default: 1, min: 1, max: 200, description: "a fresh sheet starts here, with the points that many levels imply" },
    startingItems: {
      default: [] as Array<{ itemId: string; qty?: number; equip?: boolean }>,
      description:
        '[{ "itemId": "<items/ id>", "qty": 1, "equip": false }] given to a fresh sheet in order (put the bag first, equipped, so the rest has room) — ignored when a saved sheet is restored',
    },
    startingItemsWithBuild: {
      default: true,
      description:
        "false = a character made through the creation screen (it arrives with a build) gets ONLY its archetype's kit and coins " +
        "(the creation asset's startingItems / startingCoins), never this script's startingItems / startingCoins — keep a dev " +
        "test kit here for bodies with no build (local play) without handing it to real characters",
    },
    startingCoins: {
      default: 0,
      min: 0,
      max: 100000000,
      description: "copper a FRESH sheet starts with (100 = 1 silver, 10000 = 1 gold) — ignored when a saved sheet is restored",
    },
    persist: {
      default: true,
      description:
        'save the LOCAL player\'s sheet through ctx.playerData (namespace "character") and restore it on start; NPCs and remote players never persist here',
    },
    combatLock: {
      default: "",
      description:
        "netState namespace whose `<namespace>/<bodyId>` holds a sim time (ctx.now() ms) until which the body is IN COMBAT — " +
        "e.g. transferLock, which a combat script extends on every hit. While it is in the future nothing is equipped or " +
        "unequipped (a pending change is cancelled); belt use and weapon swaps still work. Empty = no lock",
    },
    swapSeconds: {
      default: 0.8,
      min: 0,
      max: 5,
      description: "seconds a character.swap request (the weapon set in hand, netState hand/<bodyId>) takes to land; allowed in combat",
    },
    useCooldown: {
      default: 8,
      min: 0,
      max: 120,
      description: "seconds the whole belt waits after an inventory.use — one potion per moment is a choice",
    },
    bagSeconds: {
      default: 259200,
      min: -1,
      max: 2592000,
      description:
        "seconds an EARNED loot bag this character owns lies in the world (netState lootbag/<bagId>, seen by this character alone) before it " +
        "disappears with whatever is left in it: a creature's drops, a share of a party kill, a roll won (inventory.bag). Bags are " +
        "take-only (nothing is ever added to one): a claim window, not storage. Dropped items use dropSeconds. Default 3 days. On a server with a save authority the time runs in REAL " +
        "time and the bag is saved with its owner (it survives a logout and a restart, and is live only while the owner is online " +
        "in its scene); without one it lasts while the world runs. An inventory.bag may name its own lifetime. -1 = until emptied",
    },
    dropSeconds: {
      default: 600,
      min: 0,
      max: 86400,
      description:
        "seconds a bag of this character's own DROPPED items lies at their feet (real time on a server with a save authority; it " +
        "survives a restart within that time). Short on purpose: a bag is never storage, the vault is. 0 = a drop destroys the item",
    },
    dropCap: {
      default: 5,
      min: 1,
      max: 50,
      description: "dropped-item bags one character may have lying at once; dropping past it is REFUSED (nothing is destroyed) until one is picked up or expires",
    },
    bagCap: {
      default: LOOT_BAG_CAP,
      min: 1,
      max: 400,
      description: "EARNED loot bags one character may own at once (live and saved together); a new one past it removes their OLDEST earned bag with what is in it",
    },
    rollRarity: {
      default: "uncommon",
      description:
        "party loot (inventory.bag with share): items of this rarity or better (common, uncommon, rare, epic, legendary) go to a " +
        "need/greed/pass roll among the party members in range; lesser ones go round-robin. Empty = never roll",
    },
    rollSeconds: {
      default: 45,
      min: 5,
      max: 300,
      description: "seconds a party member has to answer a loot roll; no answer = pass",
    },
    partyRange: {
      default: 60,
      min: 1,
      max: 1000,
      description: "metres from the kill a party member must stand to share in its loot (rolls, round-robin, the copper split)",
    },
    pickupRadius: {
      default: 3,
      min: 0.5,
      max: 20,
      description: "metres a body may be from a loot bag it owns (inventory.loot) or a ground item (inventory.pickup) to take from it",
    },
    publishUserData: {
      default: true,
      description: "mirror derived stats onto the body's object.userData.character (and .encumbrance) so controllers/combat read them",
    },
  };

  static override events: ScriptEventDecl[] = [...characterEventDecls];
  static override commands: ScriptCommandDecl[] = [
    {
      name: "give",
      args: "<itemId> [qty] [twist,twist…]",
      description:
        "Put an item (an items/ asset id) into your own inventory — for trying gear without a drop. Twists (the game's opaque " +
        "ids, comma-separated) go on each new instance.",
      authority: true,
    },
    {
      name: "soulbind",
      args: "<slot|uid|itemId> [off]",
      description:
        "Soulbind one of your equipment slots to the item worn there now (it cannot be looted from you while it stays worn " +
        "there) — or free it with 'off'. A testing override of the soul binder: no slot limit, no price. Names a slot " +
        "(chest, primary, …) or a WORN item by uid or item id.",
      authority: true,
    },
  ];

  /** The 1–100 a party loot roll uses; replaceable in tests. */
  static rollD100 = (): number => 1 + Math.floor(Math.random() * 100);

  private store!: SheetStoreLike;
  private env!: SheetEnv;
  private actorId = "";
  private cancelPersist: (() => void) | null = null;
  private usedLocalStore = false;
  private actionElapsed = 0;

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
      this.ctx.events?.on(name, (payload, meta) => {
        // a downed character (core isDowned) asks for nothing: no inventory, no looting, no belt
        if (DOWNED_REFUSED.has(name) && (payload as { actorId?: string }).actorId === this.actorId && this.store.isAuthority() && isDowned(this.store, this.actorId)) {
          this.refuse(name.slice(name.indexOf(".") + 1), DOWNED_REFUSAL);
          return;
        }
        fn(payload as T, meta);
      });
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
    on<{ actorId: string; itemId: string; qty: number; twists?: string[] }>(CHARACTER_EVENTS.give, (p, meta) => {
      if (meta?.from !== undefined) return;
      const r = this.handle("give", p, meta, (s) => {
        const added = addItem(s, p.itemId, p.qty ?? 1, this.env);
        // rolled twists belong to an instance: only an item that does not stack can carry them
        if (added.ok && p.twists?.length && this.env.catalog(p.itemId)?.stack === 1) {
          for (const uid of added.uids) added.sheet.items[uid]!.twists = [...p.twists];
        }
        return added;
      });
      if (r?.ok && r.placed < (p.qty ?? 1)) this.refuse("give", `only ${r.placed} of ${p.qty} ${p.itemId} fit`);
    });
    on<{ actorId: string; fraction?: number }>(CHARACTER_EVENTS.wear, (p, meta) => {
      if (meta?.from !== undefined) return; // wear is authority-internal (a death)
      this.handle("wear", p, meta, (s) => ({ ok: true, sheet: wearEquipped(s, this.env, p.fraction ?? 0.1).sheet }));
    });
    on<{ actorId: string; uid: string; to: GridTarget }>(CHARACTER_EVENTS.move, (p, meta) =>
      this.handle("move", p, meta, (s) => moveItem(s, p.uid, p.to, this.env), { kind: "move", uid: p.uid, to: p.to }),
    );
    on<{ actorId: string; uid: string; slot?: EquipmentSlot }>(CHARACTER_EVENTS.equip, (p, meta) =>
      this.handle("equip", p, meta, (s) => equip(s, p.uid, p.slot, this.env), { kind: "equip", uid: p.uid, slot: p.slot }),
    );
    on<{ actorId: string; slot: EquipmentSlot; to?: GridTarget }>(CHARACTER_EVENTS.unequip, (p, meta) =>
      this.handle("unequip", p, meta, (s) => unequip(s, p.slot, p.to, this.env), { kind: "unequip", uid: readSheet(this.store, this.actorId)?.equipment[p.slot] ?? "", slot: p.slot, to: p.to }),
    );
    on<{ actorId: string; uid: string; qty?: number }>(CHARACTER_EVENTS.drop, (p, meta) => {
      const keeps = this.param<number>("dropSeconds") > 0;
      // past the cap a drop is refused, never a silent loss of the oldest bag
      if (keeps && p.actorId === this.actorId && this.store.isAuthority() && this.mayAct(meta) && this.droppedBags() >= this.param<number>("dropCap")) {
        return this.refuse("drop", `you already have ${this.param<number>("dropCap")} bags of dropped items lying about: pick one up first`);
      }
      const r = this.handle("drop", p, meta, (s) =>
        s.items[p.uid] && isEntrusted(this.env, s.items[p.uid]!.itemId) ? { ok: false, error: "that was entrusted to you: keep it until the task is done" } : removeItem(s, p.uid, p.qty, this.env),
      );
      if (r?.ok) {
        const body = this.ctx.getObject(this.actorId) ?? this.object;
        const at = this.settle([body.position.x, body.position.y, body.position.z]);
        // the stack goes into a NEW bag of the dropper's own at their feet WITH its instance data (wear, twists)
        const bagId = keeps ? this.dropIntoBag(r.removed, at) : undefined;
        this.ctx.events?.emit(CHARACTER_EVENTS.dropped, { actorId: this.actorId, ...r.removed, at, ...(bagId ? { bagId } : {}) });
      }
    });
    on<BagRequest>(CHARACTER_EVENTS.bag, (p, meta) => this.makeBag(p, meta));
    on<CorpseRequest>(CHARACTER_EVENTS.corpse, (p, meta) => this.makeCorpse(p, meta));
    on<LootRequest>(CHARACTER_EVENTS.loot, (p, meta) => this.loot(p, meta));
    on<{ actorId: string; rollId: string; choice: RollChoice }>(CHARACTER_EVENTS.roll, (p, meta) => this.answerRoll(p, meta));
    on<{ actorId: string; slot: EquipmentSlot; bound?: boolean }>(CHARACTER_EVENTS.soulbind, (p, meta) => {
      if (meta?.from !== undefined) return; // authority-internal: an admin or the console, never a peer
      this.handle("soulbind", p, meta, (s): SheetResult => {
        const next = structuredClone(s);
        const slots = { ...(next.soulslots ?? {}) };
        if (p.bound === false) delete slots[p.slot];
        else {
          const uid = s.equipment[p.slot];
          if (!uid) return { ok: false, error: `you wear nothing in the ${p.slot} slot` };
          slots[p.slot] = uid;
        }
        if (Object.keys(slots).length > 0) next.soulslots = slots;
        else delete next.soulslots;
        return { ok: true, sheet: next };
      });
    });
    on<{ actorId: string; dropId: string }>(CHARACTER_EVENTS.pickup, (p, meta) => this.pickup(p, meta));
    on<TransferRequest>(CHARACTER_EVENTS.transfer, (p, meta) => this.transfer(p, meta));
    on<{ actorId: string; slot: EquipmentSlot }>(CHARACTER_EVENTS.use, (p, meta) => {
      const r = this.handle("use", p, meta, (s) =>
        useItem(s, p.slot, this.env, { now: this.ctx.now(), cooldownMs: this.param<number>("useCooldown") * 1000 }),
      );
      if (r?.ok) this.ctx.events?.emit(CHARACTER_EVENTS.used, { actorId: this.actorId, slot: p.slot, itemId: r.itemId, skill: r.skill });
    });
    on<{ actorId: string; set?: 0 | 1 }>(CHARACTER_EVENTS.swap, (p, meta) => this.swap(p, meta));
    on<{ actorId: string; uid: string; qty: number; to: GridTarget }>(CHARACTER_EVENTS.split, (p, meta) =>
      this.handle("split", p, meta, (s) => splitStack(s, p.uid, p.qty, p.to, this.env), { kind: "split", uid: p.uid, qty: p.qty, to: p.to }),
    );
  }

  /**
   * A brand-new sheet from the params: level, the creation build, the script's
   * starting items, then the build's ARCHETYPE kit (creation `startingItems`:
   * a starting armour set) — after, so a bag in the script's list has made room.
   */
  private fresh(): CharacterSheet {
    let sheet = createSheet(this.env.progression, this.param<number>("startingLevel"));
    sheet = this.withBuild(sheet);
    // the archetype kit FIRST, worn straight out of the (still empty) pockets; the
    // script's own list after it never takes a worn kit piece off (see give)
    const creation = this.creationRules();
    if (creation && sheet.build) sheet = this.give(sheet, archetypeStartingItems(creation, sheet.build.archetype));
    const own = !sheet.build || this.param<boolean>("startingItemsWithBuild");
    if (own) sheet = this.give(sheet, this.param<Array<{ itemId?: string; qty?: number; equip?: boolean }>>("startingItems") ?? []);
    const kitCoins = creation && sheet.build ? archetypeStartingCoins(creation, sheet.build.archetype) : undefined;
    return { ...sheet, coins: kitCoins ?? (own ? (this.param<number>("startingCoins") ?? 0) : 0) };
  }

  /**
   * Add (and equip) a starting kit in order; a refused entry is skipped with a
   * warning. `equip` only fills an EMPTY slot: a starting item never displaces
   * one already worn (the archetype's gloves stay on over the script's).
   */
  private give(sheet: CharacterSheet, entries: ReadonlyArray<{ itemId?: string; qty?: number; equip?: boolean }>): CharacterSheet {
    for (const entry of entries) {
      if (!entry?.itemId) continue;
      const r = addItem(sheet, entry.itemId, entry.qty ?? 1, this.env);
      if (!r.ok) {
        console.warn(`[character-sheet] ${this.actorId}: starting item skipped — ${r.error}`);
        continue;
      }
      sheet = r.sheet;
      const item = this.env.catalog(entry.itemId);
      const free = item ? EQUIPMENT_SLOTS.some((slot) => itemFitsSlot(item, slot) && !sheet.equipment[slot]) : false;
      if (entry.equip && free) {
        const worn = equip(sheet, r.uids[r.uids.length - 1]!, undefined, this.env);
        if (worn.ok) sheet = worn.sheet;
        else console.warn(`[character-sheet] ${this.actorId}: could not equip starting ${entry.itemId} — ${worn.error}`);
      }
    }
    return sheet;
  }

  /** The creation rules named by the `creation` param, or null. */
  private creationRules(): CharacterCreation | null {
    const id = this.param<string>("creation");
    const asset = id ? this.ctx.getDataAsset?.(id) : undefined;
    return asset?.type === "creation" ? (asset.data as CharacterCreation) : null;
  }

  /**
   * The build the body arrived with, stamped on. Re-validated here: this is
   * the authority, and the build is the one thing about a character a player
   * chose from a client.
   */
  private withBuild(sheet: CharacterSheet): CharacterSheet {
    const raw = this.store.get(`build/${this.actorId}`);
    const id = this.param<string>("creation");
    if (raw === undefined || !id) return sheet;
    const asset = this.ctx.getDataAsset?.(id);
    if (asset?.type !== "creation") {
      console.warn(`[character-sheet] creation asset "${id}" not found — build ignored`);
      return sheet;
    }
    const creation = asset.data as CharacterCreation;
    const v = validateBuild(creation, raw);
    if (!v.ok) {
      console.warn(`[character-sheet] ${this.actorId}: build refused — ${v.error}`);
      return sheet;
    }
    return applyBuild(sheet, creation, v.build);
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

  override onCommand(name: string, args: string[]): string | null {
    if (name === "soulbind") {
      const what = args[0];
      if (!what) throw new Error("usage: /soulbind <slot|uid|itemId> [off]");
      const actorId = this.ctx.localPlayer?.() ?? this.actorId;
      const sheet = readSheet(this.store, actorId);
      const worn = (uid: string | undefined): EquipmentSlot | undefined =>
        uid ? EQUIPMENT_SLOTS.find((slot) => sheet?.equipment[slot] === uid) : undefined;
      const slot = (EQUIPMENT_SLOTS as readonly string[]).includes(what)
        ? (what as EquipmentSlot)
        : worn(sheet?.items[what] ? what : EQUIPMENT_SLOTS.map((s) => sheet?.equipment[s]).find((u) => u && sheet?.items[u]?.itemId === what));
      if (!slot) throw new Error(`/soulbind: "${what}" is not a slot or an item you wear`);
      const bound = args[1] !== "off";
      this.ctx.events?.emit(CHARACTER_EVENTS.soulbind, { actorId, slot, bound });
      return `${bound ? "soulbinding" : "freeing"} the ${slot} slot of ${actorId}`;
    }
    if (name !== "give") return null;
    const itemId = args[0];
    if (!itemId) throw new Error("usage: /give <itemId> [qty]");
    const qty = args[1] === undefined ? 1 : Number(args[1]);
    if (!Number.isInteger(qty) || qty < 1) throw new Error(`/give: "${args[1]}" is not a quantity`);
    if (!this.env.catalog(itemId)) throw new Error(`/give: no item "${itemId}" (assets/items/<id>.json)`);
    // The console runs this on the FIRST sheet script, which on a server may
    // be anybody's — so it names this tab's own body and lets that sheet's
    // authority-side handler take it like any other grant.
    const actorId = this.ctx.localPlayer?.() ?? this.actorId;
    const twists = (args[2] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    this.ctx.events?.emit(CHARACTER_EVENTS.give, { actorId, itemId, qty, ...(twists.length ? { twists } : {}) });
    return `giving ${qty} ${itemId}${twists.length ? ` (${twists.join(", ")})` : ""} to ${actorId}`;
  }

  private handle<T>(
    request: string,
    payload: { actorId: string },
    meta: { from?: string } | undefined,
    reduce: (sheet: CharacterSheet) => SheetResult<T>,
    command?: InventoryCommand,
  ): ({ ok: true; sheet: CharacterSheet } & T) | null {
    if (payload.actorId !== this.actorId) return null;
    if (!this.store.isAuthority()) return null;
    if (!this.mayAct(meta)) {
      this.refuse(request, "that is not your character");
      return null;
    }
    const sheet = readSheet(this.store, this.actorId);
    if (!sheet) return null;
    if (LOCKED_REQUESTS.includes(request) && this.lootLocked()) {
      this.refuse(request, LOCKED_REFUSAL);
      return null;
    }
    if (sheet.inventoryAction && ["move", "equip", "unequip", "drop", "split"].includes(request)) {
      this.refuse(request, "finish the current inventory action first");
      return null;
    }
    const gear = command ?? (request === "drop" ? { kind: "drop" as const, uid: (payload as { uid?: string }).uid ?? "" } : null);
    if (gear && this.inCombat() && changesWornGear(sheet, gear)) {
      this.refuse(request, "you cannot change gear in combat");
      return null;
    }
    const r = reduce(sheet);
    if (!r.ok) {
      this.refuse(request, r.error);
      return null;
    }
    const duration = command ? actionSeconds(sheet, command, this.env) : 0;
    if (command && duration > 0) {
      this.actionElapsed = 0;
      this.write({ ...sheet, inventoryAction: { command, duration, remaining: duration, requestedBy: meta?.from } }, false);
      return null;
    }
    this.write(r.sheet, true);
    return r;
  }

  /**
   * Pick a ground item up (`ground/<dropId>`): within `pickupRadius`, it comes
   * in with its instance data, and what does not fit stays where it lay. The
   * record is read and rewritten in this one handler on the authority, so two
   * hands reaching for the same item cannot both get it.
   */
  private pickup(p: { actorId: string; dropId: string }, meta?: { from?: string }): void {
    if (p.actorId !== this.actorId || !this.store.isAuthority()) return;
    if (!this.mayAct(meta)) return this.refuse("pickup", "that is not your character");
    const key = `${GROUND_NETSTATE}/${p.dropId}`;
    const parsed = groundItemSchema.safeParse(this.store.get(key));
    if (!parsed.success) return this.refuse("pickup", "it is gone");
    const ground = parsed.data;
    if (ground.until !== undefined && ground.until <= this.ctx.now()) {
      this.store.delete(key);
      return this.refuse("pickup", "it is gone");
    }
    const body = this.ctx.getObject(this.actorId);
    if (!body) return;
    const d = Math.hypot(body.position.x - ground.at[0], body.position.y - ground.at[1], body.position.z - ground.at[2]);
    if (d > this.param<number>("pickupRadius")) return this.refuse("pickup", "too far away");
    const sheet = readSheet(this.store, this.actorId);
    if (!sheet) return;
    const r = pickUp(sheet, ground, this.env);
    if (!r.ok) return this.refuse("pickup", r.error);
    if (r.left) this.store.set(key, r.left);
    else this.store.delete(key);
    this.write(r.sheet, true);
  }

  /**
   * Hand a stack, with its instance data, from this character to another
   * (`inventory.transfer`, authority-internal: the primitive a trade window or
   * a loot screen calls once it has decided). Both must be here and within
   * `range`; the receiver must have room for all of it; both sheets change or
   * neither does.
   */
  private transfer(p: TransferRequest, meta?: { from?: string }): void {
    if (p.actorId !== this.actorId || !this.store.isAuthority()) return;
    if (meta?.from !== undefined) return; // never from a peer: a client cannot move another's items
    const refuse = (error: string): void => this.refuse("transfer", error);
    if (p.toActorId === this.actorId) return refuse("that is already yours");
    if (this.lootLocked()) return refuse(LOCKED_REFUSAL);
    const from = readSheet(this.store, this.actorId);
    const to = readSheet(this.store, p.toActorId);
    const a = this.ctx.getObject(this.actorId);
    const b = this.ctx.getObject(p.toActorId);
    if (!from || !to || !a || !b) return refuse("they are not here");
    const pa = a.getWorldPosition(a.position.clone());
    const pb = b.getWorldPosition(b.position.clone());
    if (pa.distanceTo(pb) > (p.range ?? 4)) return refuse("too far away");
    const error = this.handOver(this.actorId, p.toActorId, p.uid, p.qty, { to: p.to, allowWorn: p.allowWorn });
    if (error) refuse(error);
  }

  /**
   * The one way a stack moves between two characters (a transfer, a body
   * looted): `transferStack`, then both sheets written — the giver first, and
   * restored if the receiver's write is refused — then `inventory.transferred`.
   * Returns the refusal, or null when it moved.
   */
  private handOver(fromId: string, toId: string, uid: string, qty: number | undefined, opts: StackTransferOptions): string | null {
    const from = readSheet(this.store, fromId);
    const to = readSheet(this.store, toId);
    if (!from || !to) return "they are not here";
    if (from.inventoryAction && from.inventoryAction.command.uid === uid) return "finish the current inventory action first";
    const r = transferStack(from, to, uid, qty, this.env, opts);
    if (!r.ok) return r.error;
    if (!this.store.set(sheetKey(fromId), r.from)) return "the transfer was refused";
    if (!this.store.set(sheetKey(toId), r.to)) {
      this.store.set(sheetKey(fromId), from);
      return "the transfer was refused";
    }
    this.publish();
    this.schedulePersist();
    this.ctx.events?.emit(CHARACTER_EVENTS.transferred, { actorId: fromId, toActorId: toId, ...r.moved });
    return null;
  }

  // -- loot bags (core loot.ts: lootbag/<bagId>, owner-only) ------------------------------------

  /** Where a bag lies: straight down from `at` onto whatever is below (not a body), or `at` when nothing answers. */
  private settle(at: [number, number, number], exclude: string[] = []): [number, number, number] {
    const hit = this.ctx.sim?.raycast?.([at[0], at[1] + 0.5, at[2]], [0, -1, 0], 6, { exclude: [this.actorId, ...exclude] });
    return hit ? [at[0], hit.point[1], at[2]] : at;
  }

  /** Sim time a new bag of this owner's expires at (undefined = never), from `seconds` or `bagSeconds`. */
  private bagUntil(seconds?: number): number | undefined {
    const s = seconds ?? this.param<number>("bagSeconds");
    return s > 0 ? this.ctx.now() + s * 1000 : undefined;
  }

  private newBagId(): string {
    return `${this.actorId}.${Math.round(this.ctx.now())}.${++dropSeq}`;
  }

  /** A dropped stack into a NEW bag of this character's own at their feet (bags are take-only: never added to). */
  private dropIntoBag(stack: LooseStack, at: [number, number, number]): string | undefined {
    return this.putInBag(this.actorId, at, [stack], 0, this.ctx.now() + this.param<number>("dropSeconds") * 1000, this.actorId, true);
  }

  /** Bags of this character's own dropped items lying live in this world. */
  private droppedBags(): number {
    let n = 0;
    for (const key of this.store.keys(`${LOOT_NETSTATE}/`)) {
      const bag = this.store.get(key) as LootBag | undefined;
      if (bag?.owner === this.actorId && bag.dropped) n++;
    }
    return n;
  }

  /**
   * A NEW bag `owner` owns at `at` holding these stacks (and copper). Bags are
   * take-only: nothing is ever added to an existing one. An earned bag past the
   * owner's `bagCap` removes their oldest earned bag (live or saved) first.
   */
  private putInBag(owner: string, at: [number, number, number], stacks: LooseStack[], coins: number, until: number | undefined, from: string | undefined, dropped = false): string | undefined {
    if (!dropped) this.makeRoomForBag(owner);
    const bagId = this.newBagId();
    const bag = lootBag(owner, at, stacks.slice(0, 64), { until, from, coins, made: lootClock.now(), dropped });
    return this.store.set(`${LOOT_NETSTATE}/${bagId}`, bag) ? bagId : undefined;
  }

  /** At the cap: remove `owner`'s oldest EARNED bag, live (lootbag/) or saved for another scene (lootbags/<owner>). */
  private makeRoomForBag(owner: string): void {
    const cap = this.param<number>("bagCap");
    const live: Array<[string, number]> = [];
    for (const key of this.store.keys(`${LOOT_NETSTATE}/`)) {
      const bag = this.store.get(key) as LootBag | undefined;
      if (bag?.owner === owner && bag.body === undefined && !bag.dropped) live.push([key, bag.made ?? 0]);
    }
    const savedKey = `${LOOT_SAVE_NETSTATE}/${owner}`;
    const saved = savedBagsSchema.safeParse(this.store.get(savedKey));
    const dormant = saved.success ? saved.data.bags.filter((b) => !b.dropped) : [];
    const dormantDropped = saved.success ? saved.data.bags.filter((b) => b.dropped) : [];
    while (live.length + dormant.length >= cap && live.length + dormant.length > 0) {
      live.sort((a, b) => a[1] - b[1]);
      dormant.sort((a, b) => (a.made ?? 0) - (b.made ?? 0));
      if (live.length > 0 && (dormant.length === 0 || live[0]![1] <= (dormant[0]!.made ?? 0))) this.store.delete(live.shift()![0]);
      else dormant.shift();
    }
    if (saved.success && dormant.length + dormantDropped.length !== saved.data.bags.length) this.store.set(savedKey, { owner, bags: [...dormant, ...dormantDropped] });
  }

  /**
   * `inventory.bag` (authority-internal): a bag only this character sees — a
   * creature's drops (shared with the party in range when `share`), or the
   * right to take from a killed character, who is loot-locked while it lasts.
   */
  private makeBag(p: BagRequest, meta?: { from?: string }): void {
    if (p.actorId !== this.actorId || !this.store.isAuthority()) return;
    if (meta?.from !== undefined) return; // a client can never make itself loot
    const at = this.settle(p.at, p.from ? [p.from] : []);
    const until = this.bagUntil(p.seconds);
    if (p.body !== undefined) {
      const offer = p.offer ?? [];
      const carried = p.carried ?? [];
      const coins = p.coins ?? 0;
      if (offer.length === 0 && carried.length === 0 && coins <= 0) return;
      const bagId = this.newBagId();
      const bag: LootBag = {
        owner: this.actorId,
        at,
        items: [],
        body: p.body,
        offer: [...offer],
        takes: offer.length > 0 ? (p.takes ?? 1) : 0,
        carried: [...carried],
        ...(coins > 0 ? { coins } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(p.from ? { from: p.from } : {}),
      };
      if (!this.store.set(`${LOOT_NETSTATE}/${bagId}`, bag)) return;
      // the victim's belongings stay put (and their body stays on the server) until this bag is gone
      this.store.set(`${LOOT_LOCK_NETSTATE}/${p.body}`, { until: until ?? this.ctx.now() + 3_600_000, by: this.actorId, bag: bagId });
      return;
    }
    const stacks: LooseStack[] = [];
    for (const entry of p.items ?? []) {
      const item = this.env.catalog(entry.itemId);
      if (!item) continue;
      const qty = entry.qty ?? 1;
      // rolled twists belong to an instance: only an item that does not stack carries them, one instance a stack
      if (entry.twists?.length && item.stack === 1) {
        for (let i = 0; i < qty; i++) stacks.push({ itemId: entry.itemId, qty: 1, twists: [...entry.twists] });
      } else stacks.push({ itemId: entry.itemId, qty });
    }
    const coins = p.coins ?? 0;
    if (stacks.length === 0 && coins <= 0) return;
    if (p.share) {
      const party = this.partyInRange(at);
      if (party && party.members.length > 1) return this.shareKill(party, at, stacks, coins, until, p.from);
    }
    this.putInBag(this.actorId, at, stacks, coins, until, p.from);
  }

  // -- party loot: need / greed / pass, round-robin, the copper split ------------------------------

  /**
   * This character's party (comms.party/<peer>, the peer from owner/<body>) and
   * its members whose bodies stand within `partyRange` of `at`, sorted by body
   * id, this character always among them. Null when not in a party.
   */
  private partyInRange(at: readonly [number, number, number]): { party: string; members: string[] } | null {
    const peer = this.store.get(`owner/${this.actorId}`);
    const party = typeof peer === "string" ? this.store.get(`comms.party/${peer}`) : undefined;
    if (typeof party !== "string" || !party) return null;
    const range = this.param<number>("partyRange");
    const members = new Set<string>([this.actorId]);
    for (const key of this.store.keys("comms.party/")) {
      if (this.store.get(key) !== party) continue;
      const body = this.store.get(`player/${key.slice("comms.party/".length)}`);
      if (typeof body !== "string" || !readSheet(this.store, body)) continue;
      const obj = this.ctx.getObject(body);
      if (!obj) continue;
      const p = obj.getWorldPosition(obj.position.clone());
      if (Math.hypot(p.x - at[0], p.y - at[1], p.z - at[2]) <= range) members.add(body);
    }
    return { party, members: [...members].sort() };
  }

  /**
   * A party kill: items at or above `rollRarity` go to a roll among the members
   * in range; the rest round-robin; the copper splits evenly (the odd coppers
   * from the killer on). Each member's share lies in a bag of their own.
   */
  private shareKill(party: { party: string; members: string[] }, at: [number, number, number], stacks: LooseStack[], coins: number, until: number | undefined, from: string | undefined): void {
    const { members } = party;
    const threshold = (RARITIES as readonly string[]).indexOf(this.param<string>("rollRarity"));
    const shares = new Map<string, { stacks: LooseStack[]; coins: number }>(members.map((m) => [m, { stacks: [], coins: 0 }]));
    let turns = roundRobin.get(this.store);
    if (!turns) roundRobin.set(this.store, (turns = new Map()));
    for (const stack of stacks) {
      const rarity = (RARITIES as readonly string[]).indexOf(this.env.catalog(stack.itemId)?.rarity ?? "common");
      if (threshold >= 0 && rarity >= threshold) {
        this.startRoll(stack, members, at, from);
        continue;
      }
      const turn = turns.get(party.party) ?? 0;
      turns.set(party.party, turn + 1);
      shares.get(members[turn % members.length]!)!.stacks.push(stack);
    }
    const base = Math.floor(coins / members.length);
    const odd = coins - base * members.length;
    const order = [this.actorId, ...members.filter((m) => m !== this.actorId)];
    order.forEach((m, i) => (shares.get(m)!.coins = base + (i < odd ? 1 : 0)));
    for (const [member, share] of shares) {
      if (share.stacks.length > 0 || share.coins > 0) this.putInBag(member, at, share.stacks, share.coins, until, from);
    }
  }

  private startRoll(item: LooseStack, eligible: string[], at: [number, number, number], from: string | undefined): void {
    const roll: LootRoll = {
      item: { ...item },
      at,
      ...(from ? { from } : {}),
      killer: this.actorId,
      eligible: [...eligible],
      choices: {},
      until: this.ctx.now() + this.param<number>("rollSeconds") * 1000,
    };
    this.store.set(`${LOOT_ROLL_NETSTATE}/${this.newBagId()}`, roll);
  }

  /** `loot.roll`: this character answers a roll it is eligible for, once; the last answer settles it. */
  private answerRoll(p: { actorId: string; rollId: string; choice: RollChoice }, meta?: { from?: string }): void {
    if (p.actorId !== this.actorId || !this.store.isAuthority()) return;
    if (!this.mayAct(meta)) return this.refuse("roll", "that is not your character");
    const key = `${LOOT_ROLL_NETSTATE}/${p.rollId}`;
    const parsed = lootRollSchema.safeParse(this.store.get(key));
    if (!parsed.success || !parsed.data.eligible.includes(this.actorId)) return this.refuse("roll", "that roll is over");
    if (parsed.data.choices[this.actorId] !== undefined) return this.refuse("roll", "you have already chosen");
    const roll: LootRoll = { ...parsed.data, choices: { ...parsed.data.choices, [this.actorId]: p.choice } };
    if (rollAnswered(roll)) this.settleRoll(key, roll);
    else this.store.set(key, roll);
  }

  /**
   * Settle a roll (`resolveRoll`): a member no longer here counts as a pass; the
   * item goes into a new bag of the winner's at the corpse, and `loot.rolled` tells the party.
   */
  private settleRoll(key: string, roll: LootRoll): void {
    this.store.delete(key);
    const present = (id: string): boolean => readSheet(this.store, id) !== null && !!this.ctx.getObject(id);
    const choices: LootRoll["choices"] = {};
    for (const id of roll.eligible) choices[id] = present(id) ? (roll.choices[id] ?? "pass") : "pass";
    const outcome = resolveRoll({ ...roll, choices }, CharacterSheetScript.rollD100);
    this.putInBag(outcome.winner, roll.at, [roll.item], 0, this.bagUntil(), roll.from);
    this.ctx.events?.emit(CHARACTER_EVENTS.rolled, {
      rollId: key.slice(LOOT_ROLL_NETSTATE.length + 1),
      itemId: roll.item.itemId,
      qty: roll.item.qty,
      ...(roll.from ? { from: roll.from } : {}),
      winner: outcome.winner,
      choice: outcome.choice,
      roll: outcome.roll,
      rolls: outcome.rolls,
    });
  }

  /** Whether this character is being looted right now (lootlock/<self>). */
  private lootLocked(): boolean {
    return isLootLocked(this.store, this.actorId, this.ctx.now());
  }

  /** A body bag is over: remove it and lift its victim's lock (if the lock is this bag's). */
  private closeBodyBag(key: string, bag: LootBag): void {
    this.store.delete(key);
    this.liftLock(key, bag);
  }

  /** Move `n` copper from one character to another; both written or neither. Returns the refusal, or null. */
  private handCoins(fromId: string, toId: string, n: number): string | null {
    const from = readSheet(this.store, fromId);
    const to = readSheet(this.store, toId);
    if (!from || !to) return "they are not here";
    if (n <= 0) return null;
    if (!this.store.set(sheetKey(fromId), { ...from, coins: from.coins - n })) return "the transfer was refused";
    if (!this.store.set(sheetKey(toId), { ...to, coins: to.coins + n })) {
      this.store.set(sheetKey(fromId), from);
      return "the transfer was refused";
    }
    this.publish();
    this.schedulePersist();
    return null;
  }

  /**
   * `inventory.loot`: take from a bag this character OWNS, within
   * `pickupRadius`. An item bag gives one stack (`index`) or everything that
   * fits; what does not fit stays in the bag. A body bag gives the one offered
   * stack chosen (`uid`) through the same hand-over as a transfer, and closes
   * once its `takes` are used. Read and rewritten in this one handler on the
   * authority, so a bag can never give the same thing twice.
   */
  private loot(p: LootRequest, meta?: { from?: string }): void {
    if (p.actorId !== this.actorId || !this.store.isAuthority()) return;
    if (!this.mayAct(meta)) return this.refuse("loot", "that is not your character");
    const key = `${LOOT_NETSTATE}/${p.bagId}`;
    const parsed = lootBagSchema.safeParse(this.store.get(key));
    // somebody else's bag answers exactly like a missing one: it does not exist for them
    if (!parsed.success || parsed.data.owner !== this.actorId) return this.refuse("loot", "it is gone");
    const bag = parsed.data;
    if (bag.until !== undefined && bag.until <= this.ctx.now()) {
      this.store.delete(key);
      return this.refuse("loot", "it is gone");
    }
    const body = this.ctx.getObject(this.actorId);
    if (!body) return;
    const d = Math.hypot(body.position.x - bag.at[0], body.position.y - bag.at[1], body.position.z - bag.at[2]);
    if (d > this.param<number>("pickupRadius")) return this.refuse("loot", "too far away");
    if (bag.body !== undefined) return this.lootBody(key, bag, p);
    if (bag.corpse !== undefined) return this.lootCorpse(key, bag, p);
    const sheet = readSheet(this.store, this.actorId);
    if (!sheet) return;
    const r = p.coins ? takeBagCoins(sheet, bag) : takeFromBag(sheet, bag, p.index, this.env);
    if (!r.ok) return this.refuse("loot", r.error);
    if (r.bag) this.store.set(key, r.bag);
    else this.store.delete(key);
    this.write(r.sheet, true);
    if (r.left) this.refuse("loot", "no room for the rest");
  }

  /**
   * Take from a killed character (a body bag): the copper (`coins`), any of
   * their `carried` stacks (one by `uid`, or `all` that fit), or ONE of the
   * `offer`ed worn items — each through the same hand-over as a transfer, data
   * intact; what does not fit stays with the victim. `done` leaves the rest.
   * The bag closes (and the victim's lock lifts) once nothing is left to take.
   */
  private lootBody(key: string, bag: LootBag, p: LootRequest): void {
    const victim = bag.body!;
    if (p.done) return this.closeBodyBag(key, bag);
    const next: LootBag = { ...bag, offer: [...(bag.offer ?? [])], carried: [...(bag.carried ?? [])] };
    let error: string | null = null;
    let moved = false;
    const noRoom = (e: string): string => (e === "no room in their bags" ? "no room in your bags" : e);
    if (p.coins || p.all) {
      const n = Math.min(next.coins ?? 0, readSheet(this.store, victim)?.coins ?? 0);
      if (n > 0) error = this.handCoins(victim, this.actorId, n);
      if (!error) {
        delete next.coins;
        moved = moved || n > 0;
      }
    }
    if (p.all) {
      for (const uid of [...next.carried!]) {
        const e = this.handOver(victim, this.actorId, uid, undefined, {});
        if (e === null || e === "no such item" || e === "it is soulbound" || e === "it is entrusted") {
          next.carried = next.carried!.filter((u) => u !== uid);
          moved = moved || e === null;
        } else error ??= noRoom(e);
      }
    } else if (p.uid) {
      if (next.carried!.includes(p.uid)) {
        error = this.handOver(victim, this.actorId, p.uid, undefined, {});
        if (error === null || error === "no such item") next.carried = next.carried!.filter((u) => u !== p.uid);
        if (error) error = noRoom(error);
        else moved = true;
      } else if (next.offer!.includes(p.uid)) {
        if ((next.takes ?? 0) <= 0) return this.refuse("loot", "you have already taken your one piece of their gear");
        error = this.takeWorn(victim, p.uid, bag.plunder ?? 0);
        if (error === "it is soulbound" || error?.startsWith("they were plundered")) return this.refuse("loot", error);
        if (!error) {
          moved = true;
          next.takes = (next.takes ?? 1) - 1;
          next.offer = next.offer!.filter((u) => u !== p.uid);
        }
      } else return this.refuse("loot", "you may not take that");
    } else if (!p.coins) return this.refuse("loot", "choose what to take");
    else if (!moved && !error) return this.refuse("loot", "there is no money to take");
    if (bodyBagSpent(next)) this.closeBodyBag(key, next);
    else if (moved || next.carried!.length !== (bag.carried?.length ?? 0) || next.coins !== bag.coins) this.store.set(key, next);
    if (error) this.refuse("loot", error);
  }

  /**
   * Take ONE worn item off a dead character (a body bag's or a claimed corpse's
   * choice): never what a soulbound slot protects, never from a character still
   * plundered; through the same hand-over as a transfer. A taken item plunders
   * them for `plunder` seconds (sheet `plunderedUntil`, wall clock). Returns the
   * refusal, or null.
   */
  private takeWorn(victim: string, uid: string, plunder: number): string | null {
    const before = readSheet(this.store, victim);
    if (before && soulProtected(before, uid)) return "it is soulbound";
    if (isPlundered(before)) return "they were plundered moments ago: their gear is safe for now";
    const error = this.handOver(victim, this.actorId, uid, undefined, { allowWorn: true });
    if (error) return error === "no room in their bags" ? "no room in your bags" : error;
    const after = readSheet(this.store, victim);
    if (plunder > 0 && after) this.store.set(sheetKey(victim), { ...after, plunderedUntil: lootClock.now() + plunder * 1000 });
    return null;
  }

  /**
   * `inventory.corpse` (authority-internal, on the DEAD character's sheet): what
   * they carried — every grid stack but the entrusted, and all their copper —
   * leaves them into a corpse at the body. With a killer's claim the killer owns
   * it first (and may choose from `offer`, worn gear that stays on the dead
   * character until taken); the dead character is loot-locked meanwhile. Then it
   * is theirs until `seconds` after the death.
   */
  private makeCorpse(p: CorpseRequest, meta?: { from?: string }): void {
    if (p.actorId !== this.actorId || !this.store.isAuthority()) return;
    if (meta?.from !== undefined) return; // a client can never make a corpse
    const sheet = readSheet(this.store, this.actorId);
    if (!sheet) return;
    const { sheet: emptied, items, coins } = corpseContents(sheet, this.env);
    const now = this.ctx.now();
    const claim = !!p.killer && p.killer !== this.actorId && (p.claimSeconds ?? 0) > 0;
    const offer = claim ? [...new Set(p.offer ?? [])].filter((uid) => sheet.items[uid] && !soulProtected(sheet, uid)) : [];
    if (items.length === 0 && coins <= 0 && offer.length === 0) return;
    const at = this.settle(p.at);
    const until = now + (p.seconds ?? 900) * 1000;
    const claimUntil = now + (p.claimSeconds ?? 0) * 1000;
    // a corpse holds 64 stacks; a bigger kit lies in more than one
    const chunks: LooseStack[][] = [];
    for (let i = 0; i < items.length; i += 64) chunks.push(items.slice(i, i + 64));
    if (chunks.length === 0) chunks.push([]);
    const made: string[] = [];
    chunks.forEach((chunk, i) => {
      const bagId = this.newBagId();
      const bag: LootBag = {
        ...lootBag(claim ? p.killer! : this.actorId, at, chunk, { until, from: p.from ?? this.actorId, coins: i === 0 ? coins : 0, made: lootClock.now() }),
        corpse: this.actorId,
        ...(claim ? { claimUntil } : {}),
        ...(claim && i === 0 ? { offer, takes: offer.length > 0 ? (p.takes ?? 1) : 0, ...((p.plunder ?? 0) > 0 ? { plunder: p.plunder } : {}) } : {}),
      };
      if (this.store.set(`${LOOT_NETSTATE}/${bagId}`, bag)) made.push(bagId);
    });
    if (made.length === 0) return;
    this.write(emptied, true);
    // the dead character's worn gear stays put (and their body on the server) while the killer's claim lasts
    if (claim) this.store.set(`${LOOT_LOCK_NETSTATE}/${this.actorId}`, { until: claimUntil, by: p.killer!, bag: made[0]! });
  }

  /**
   * Take from a CORPSE this character owns: as the dead character, like any
   * item bag; as the killer under a claim, the contents too, ONE worn item from
   * `offer`, and `done` ends the claim early (the corpse passes to its owner).
   */
  private lootCorpse(key: string, bag: LootBag, p: LootRequest): void {
    const claimed = corpseClaimed(bag);
    if (p.done) {
      if (claimed) this.endClaim(key, bag);
      return;
    }
    if (p.uid !== undefined) {
      if (!claimed || !(bag.offer ?? []).includes(p.uid)) return this.refuse("loot", "you may not take that");
      if ((bag.takes ?? 0) <= 0) return this.refuse("loot", "you have already taken your one piece of their gear");
      const error = this.takeWorn(bag.corpse!, p.uid, bag.plunder ?? 0);
      if (error) return this.refuse("loot", error);
      this.settleCorpse(key, { ...bag, takes: (bag.takes ?? 1) - 1, offer: (bag.offer ?? []).filter((u) => u !== p.uid) });
      return;
    }
    const sheet = readSheet(this.store, this.actorId);
    if (!sheet) return;
    const r = p.coins ? takeBagCoins(sheet, bag) : takeFromBag(sheet, bag, p.all ? undefined : p.index, this.env);
    if (!r.ok) return this.refuse("loot", r.error);
    this.write(r.sheet, true);
    const next: LootBag = r.bag ?? { ...bag, items: [] };
    if (!r.bag) delete next.coins;
    this.settleCorpse(key, next);
    if (r.left) this.refuse("loot", "no room for the rest");
  }

  /** Write a corpse back after a take, or remove it once nothing is left for anyone (and lift the lock it holds). */
  private settleCorpse(key: string, bag: LootBag): void {
    const empty = bag.items.length === 0 && (bag.coins ?? 0) <= 0;
    const choiceLeft = corpseClaimed(bag) && (bag.takes ?? 0) > 0 && (bag.offer?.length ?? 0) > 0;
    if (!empty || choiceLeft) {
      this.store.set(key, bag);
      return;
    }
    this.store.delete(key);
    this.liftLock(key, bag);
  }

  /** A killer's claim on a corpse is over (time, Leave the rest): it passes to the dead character, or goes if empty. */
  private endClaim(key: string, bag: LootBag): void {
    const released = releaseCorpse(bag);
    if (released) this.store.set(key, released);
    else this.store.delete(key);
    this.liftLock(key, bag);
  }

  /** Lift the loot lock a body bag or a claimed corpse put on its dead character (only if the lock is this bag's). */
  private liftLock(key: string, bag: LootBag): void {
    const victim = bag.body ?? bag.corpse;
    if (!victim) return;
    const lockKey = `${LOOT_LOCK_NETSTATE}/${victim}`;
    const lock = this.store.get(lockKey) as { bag?: string } | undefined;
    if (lock?.bag === key.slice(LOOT_NETSTATE.length + 1)) this.store.delete(lockKey);
  }

  /**
   * Once a second per store, whichever sheet gets there first: clear expired
   * ground items and loot bags (`until`; an expired body bag lifts its lock),
   * settle loot rolls whose time is up, and drop loot locks whose bag is gone.
   */
  private sweepGround(): void {
    const now = this.ctx.now();
    const last = lastSweep.get(this.store);
    if (last !== undefined && Math.abs(now - last) < 1000) return;
    lastSweep.set(this.store, now);
    for (const ns of [GROUND_NETSTATE, LOOT_NETSTATE]) {
      for (const key of this.store.keys(`${ns}/`)) {
        const value = this.store.get(key) as (Partial<LootBag> & { until?: number }) | undefined;
        if (value?.until !== undefined && value.until <= now) this.store.delete(key);
        // a killer's claim on a corpse that has run out: it passes to the dead character
        else if (ns === LOOT_NETSTATE && value?.claimUntil !== undefined && value.claimUntil <= now && corpseClaimed(value as LootBag)) this.endClaim(key, value as LootBag);
      }
    }
    for (const key of this.store.keys(`${LOOT_ROLL_NETSTATE}/`)) {
      const roll = lootRollSchema.safeParse(this.store.get(key));
      if (!roll.success) this.store.delete(key);
      else if (roll.data.until <= now) this.settleRoll(key, roll.data);
    }
    for (const key of this.store.keys(`${LOOT_LOCK_NETSTATE}/`)) {
      const lock = this.store.get(key) as { until?: number; bag?: string; by?: string } | undefined;
      const bag = lock ? (this.store.get(`${LOOT_NETSTATE}/${lock.bag}`) as LootBag | undefined) : undefined;
      // over when its time is up, its bag is gone, or its bag no longer belongs to the looter (a released corpse)
      if (!lock || (lock.until ?? 0) <= now || !bag || bag.owner !== lock.by) this.store.delete(key);
    }
  }

  override onFixedUpdate(dt: number): void {
    if (!this.store.isAuthority()) { this.actionElapsed = 0; return; }
    this.sweepGround();
    this.finishSwap();
    const sheet = readSheet(this.store, this.actorId);
    const action = sheet?.inventoryAction;
    if (!sheet || !action) { this.actionElapsed = 0; return; }
    // a fight that starts mid-change stops it: the item stays where it was; so does being looted (any change)
    const locked = this.lootLocked();
    if (locked || (this.inCombat() && changesWornGear(sheet, action.command))) {
      this.actionElapsed = 0;
      const next = { ...sheet }; delete next.inventoryAction;
      this.write(next, false);
      this.refuse(action.command.kind, locked ? `interrupted: ${LOCKED_REFUSAL}` : "interrupted — you cannot change gear in combat");
      return;
    }
    this.actionElapsed += dt;
    const remaining = Math.max(0, action.remaining - this.actionElapsed);
    if (remaining > 1e-6) {
      if (this.actionElapsed >= 0.1) {
        this.actionElapsed = 0;
        this.write({ ...sheet, inventoryAction: { ...action, remaining } }, false);
      }
      return;
    }
    this.actionElapsed = 0;
    const next = { ...sheet }; delete next.inventoryAction;
    const command = action.command;
    let result: SheetResult = { ok: false, error: "that is not your character" };
    if (this.mayAct({ from: action.requestedBy })) {
      if (command.kind === "move") result = moveItem(next, command.uid, command.to, this.env);
      else if (command.kind === "split") result = splitStack(next, command.uid, command.qty, command.to, this.env);
      else if (command.kind === "equip") result = equip(next, command.uid, command.slot, this.env);
      else result = next.equipment[command.slot] === command.uid ? unequip(next, command.slot, command.to, this.env) : { ok: false, error: "the equipped item changed" };
    }
    this.write(result.ok ? result.sheet : next, true);
    if (!result.ok) this.refuse(command.kind, result.error);
  }

  /** Whether the `combatLock` key says this body is fighting right now. */
  private inCombat(): boolean {
    const ns = this.param<string>("combatLock");
    if (!ns) return false;
    const until = this.store.get(`${ns}/${this.actorId}`);
    return typeof until === "number" && until > this.ctx.now();
  }

  /**
   * Start a weapon-set swap: the hand state records where it is going and when
   * it lands, so every tab can show the progress. A swap already under way is
   * not restarted; swapping to an empty secondary set is refused.
   */
  private swap(p: { actorId: string; set?: 0 | 1 }, meta?: { from?: string }): void {
    if (p.actorId !== this.actorId || !this.store.isAuthority()) return;
    if (!this.mayAct(meta)) return this.refuse("swap", "that is not your character");
    const hand = readHand(this.store, this.actorId);
    if (hand.swapTo !== undefined) return;
    const to: 0 | 1 = p.set ?? (hand.set === 1 ? 0 : 1);
    if (to === hand.set) return;
    if (to === 1 && !readSheet(this.store, this.actorId)?.equipment.secondary) {
      return this.refuse("swap", "nothing in the secondary slot");
    }
    const now = this.ctx.now();
    const seconds = this.param<number>("swapSeconds");
    if (seconds <= 0) {
      this.store.set(handKey(this.actorId), { set: to });
      return;
    }
    this.store.set(handKey(this.actorId), { set: hand.set, swapTo: to, swapFrom: now, swapUntil: now + seconds * 1000 });
  }

  /** Land a pending swap once its time is up (authority). */
  private finishSwap(): void {
    const hand = readHand(this.store, this.actorId);
    if (hand.swapTo === undefined || (hand.swapUntil ?? 0) > this.ctx.now()) return;
    this.store.set(handKey(this.actorId), { set: hand.swapTo });
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
      const saved = { ...sheet }; delete saved.inventoryAction; delete saved.beltReadyAt;
      this.ctx.playerData
        ?.set("character", "sheet", saved)
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
      delete parsed.data.inventoryAction;
      delete parsed.data.beltReadyAt;
      let restored = parsed.data;
      // A smaller authored grid must never strand saved belongings offscreen.
      for (const [uid, stack] of Object.entries(restored.items)) {
        if (!stack.container) continue;
        const grid = gridOf(restored, stack.container, this.env);
        if (grid && (stack.x ?? 0) < grid.cols && (stack.y ?? 0) < grid.rows) continue;
        for (const container of ["pockets", "bag"] as const) {
          const cell = firstFit(restored, container, this.env);
          if (!cell) continue;
          const result = moveItem(restored, uid, { container, ...cell }, this.env);
          if (result.ok) { restored = result.sheet; break; }
        }
      }
      this.write(restored, false);
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
