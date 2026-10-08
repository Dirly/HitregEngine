import {
  acceptQuest,
  addItem,
  attuneSoulSlots,
  takeEntrusted,
  type EquipmentSlot,
  availableChoices,
  CHARACTER_EVENTS,
  fillPlaces,
  freshShopState,
  isDowned,
  isLootLocked,
  NPC_EVENTS,
  nodeText,
  QUEST_EVENTS,
  npcEventDecls,
  npcMemorySchema,
  repairAll,
  repairItem,
  shopBuy,
  soulBindSchema,
  shopSell,
  startNode,
  takeCarried,
  turnInQuest,
  vaultCoins,
  vaultDeposit,
  vaultSchema,
  vaultMove,
  vaultWithdraw,
  type CharacterSheet,
  type Conversation,
  type Dialogue,
  type DialogueAction,
  type DialogueFacts,
  type NpcMemory,
  type Places,
  type Quest,
  type QuestJournal,
  type SheetEnv,
  type Shop,
  type ShopState,
  type SoulBind,
  type GridTarget,
  type Vault,
} from "@hitreg/core";
import { Script, type ScriptEventDecl } from "./script.js";
import { catalogOf, readSheet, sheetKey, sheetStoreOf, type SheetStoreLike } from "./character-store.js";
import { worldFactsAt } from "./world-facts.js";
import { presentFor, showIfPresent } from "./presence.js";

/** What a choice's actions leave behind, applied all-or-nothing. */
interface Draft {
  sheet: CharacterSheet;
  bind: SoulBind | null;
  journal: QuestJournal | undefined;
  memory: NpcMemory;
  panel: Conversation["panel"];
  xp: number;
}

/**
 * A townsperson you can talk to: its conversation (a `dialogue` asset), and
 * optionally a shop (a `shop` asset), the bank vault, a repair bench, the
 * hearth bind (an innkeeper: `bindSoul`, where the character respawns) and
 * soulbound slots (a soul binder: `openSoulbind`).
 *
 * The server half: every request a player sends this NPC (`npc.talk`,
 * `npc.choose`, `shop.buy`, `vault.deposit` …) is decided HERE, on the session
 * authority — the sender must own the body and stand within `radius`, a choice
 * must be one the current node offers and whose condition holds now, and a
 * choice's actions (accept or hand in a quest, pay, give, open the shop) run
 * all-or-nothing. The result is replicated state: the conversation
 * (`dialogue/<bodyId>`), the character's sheet, quest journal, NPC memory
 * (`npc/<bodyId>`) and vault (`vault/<bodyId>`), and the shop's shelf
 * (`shop/<shopId>`), which restocks here too. The `npc-ui` builtin only draws
 * that state and asks.
 *
 * The client half (presentation): the NPC turns to face the local player
 * while they talk.
 *
 * Put it on the NPC's root entity (the one with the collider), tagged
 * `interactable` so `npc-ui` finds it.
 */
export class NpcScript extends Script {
  static override scriptName = "npc";
  static override presentation = true;
  static override params = {
    name: { default: "", description: "display name (\"Wynna Coyle\"); empty = the entity's name" },
    title: { default: "", description: "what they are, under the name (\"Teller, the Counting House\")" },
    dialogue: { default: "", description: "dialogue data-asset id (assets/dialogues/<id>.json) — what they say" },
    places: {
      default: "",
      description: "places data-asset id (assets/places/<town>.json) the dialogue's {dir:id} / {far:id} / {place:id} resolve against — directions come from the world, never from the text",
    },
    shop: { default: "", description: "shop data-asset id (assets/shops/<id>.json) its `openShop` actions may open; empty = sells nothing" },
    vault: { default: false, description: "a banker: its dialogue may `openVault` (the character's own vault, the same at every banker)" },
    bindPoint: {
      default: [] as number[],
      description:
        "[x, y, z] world point a `bindSoul` action binds the talker's respawn (HEARTH) to (an innkeeper: the inn's hearth, its door); empty = this NPC's own position",
    },
    bindName: { default: "", description: "place name the hearth bind is known by (\"Brinehold\"); empty = this NPC's name" },
    radius: { default: 3.5, min: 1, max: 20, description: "metres a player must be within to talk (and to keep talking: walking 3 m past it ends the conversation)" },
    holstered: {
      default: false,
      description: "carry held items in their SECOND pose (sheathed on the hip or back): sets userData.holstered on this body, which the weapon sockets read as `altWhen`",
    },
    face: { default: true, description: "turn toward the local player while talking (presentation only); false for an object (a notice board, a stone) that offers quests" },
    presence: {
      default: {} as Record<string, unknown>,
      description:
        "only THERE while this condition holds (an hour window, weather at this spot, a flag of the character looking): hidden " +
        "per player and refusing talk otherwise, never removed, and an open conversation holds it. {} = always there (a `presence` quest source)",
    },
    readable: {
      default: false,
      description:
        "a thing to READ (a sign, a slab, a book): opening it also emits player.read, which counts `read` objectives aimed at it. Its text is the dialogue's, tokens resolved the same way",
    },
    turn: { default: "", description: "entity turned to face the talker; empty = <this id>-visual when it exists (the body model)" },
  };
  static override events: ScriptEventDecl[] = [...npcEventDecls];

  private store!: SheetStoreLike;
  private env!: SheetEnv;
  private dialogue: Dialogue | null = null;
  private shop: Shop | null = null;
  private places: Places | null = null;
  private restock = new Map<string, number>();
  private tick = 0;
  private turnId = "";
  private restYaw: number | null = null;

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    this.env = { catalog: catalogOf(this.ctx) };
    const d = this.asset("dialogue", "dialogue");
    this.dialogue = d as Dialogue | null;
    this.shop = this.asset("shop", "shop") as Shop | null;
    this.places = this.asset("places", "places") as Places | null;
    const self = this.ctx.getEntity(this.entityId);
    if (this.param<boolean>("holstered")) this.object.userData["holstered"] = true;
    this.turnId = this.param<string>("turn") || (this.ctx.getEntity(`${this.entityId}-visual`) ? `${this.entityId}-visual` : "");
    if (self && !self.tags.includes("interactable")) console.warn(`[npc] ${this.entityId}: tag it "interactable" so npc-ui finds it`);

    const on = <T extends { actorId: string; npcId: string }>(name: string, fn: (p: T) => void): void => {
      this.ctx.events?.on(name, (payload, meta) => {
        const p = payload as T;
        if (p.npcId !== this.entityId || !this.store.isAuthority()) return;
        if (meta?.from !== undefined && this.store.get(`owner/${p.actorId}`) !== meta.from) return;
        fn(p);
      });
    };
    on<{ actorId: string; npcId: string }>(NPC_EVENTS.talk, (p) => this.talk(p.actorId));
    on<{ actorId: string; npcId: string; node: string; index: number }>(NPC_EVENTS.choose, (p) => this.choose(p.actorId, p.node, p.index));
    on<{ actorId: string; npcId: string }>(NPC_EVENTS.leave, (p) => this.end(p.actorId));
    on<{ actorId: string; npcId: string; itemId: string; qty?: number; resale?: number }>(NPC_EVENTS.buy, (p) =>
      this.trade(p.actorId, (sheet, state, shop) => shopBuy(sheet, state, shop, p.itemId, p.qty ?? 1, this.env, p.resale)),
    );
    on<{ actorId: string; npcId: string; uid: string; qty?: number }>(NPC_EVENTS.sell, (p) =>
      this.trade(p.actorId, (sheet, state, shop) => shopSell(sheet, state, shop, p.uid, p.qty, this.env)),
    );
    on<{ actorId: string; npcId: string; uid: string; qty?: number; slot?: number }>(NPC_EVENTS.deposit, (p) =>
      this.bank(p.actorId, (sheet, vault) => vaultDeposit(sheet, vault, p.uid, p.qty, this.env, p.slot)),
    );
    on<{ actorId: string; npcId: string; index: number; qty?: number; to?: GridTarget }>(NPC_EVENTS.withdraw, (p) =>
      this.bank(p.actorId, (sheet, vault) => vaultWithdraw(sheet, vault, p.index, p.qty, this.env, p.to)),
    );
    on<{ actorId: string; npcId: string; from: number; to: number }>(NPC_EVENTS.arrange, (p) =>
      this.bank(p.actorId, (sheet, vault) => {
        const r = vaultMove(vault, p.from, p.to, this.env);
        return r.ok ? { ok: true, sheet, vault: r.vault } : r;
      }),
    );
    on<{ actorId: string; npcId: string; amount: number }>(NPC_EVENTS.coins, (p) => this.bank(p.actorId, (sheet, vault) => vaultCoins(sheet, vault, p.amount)));
    on<{ actorId: string; npcId: string; uid: string }>(NPC_EVENTS.repair, (p) => this.mend(p.actorId, (sheet, rate) => repairItem(sheet, p.uid, this.env, rate)));
    on<{ actorId: string; npcId: string }>(NPC_EVENTS.repairAll, (p) => this.mend(p.actorId, (sheet, rate) => repairAll(sheet, this.env, rate)));
    on<{ actorId: string; npcId: string; slots: EquipmentSlot[] }>(NPC_EVENTS.attune, (p) => this.attune(p.actorId, p.slots));
  }

  private asset(param: string, type: string): unknown {
    const id = this.param<string>(param);
    if (!id) return null;
    const a = this.ctx.getDataAsset?.(id);
    if (a?.type === type) return a.data;
    console.warn(`[npc] ${this.entityId}: no ${type} asset "${id}"`);
    return null;
  }

  private displayName(): string {
    return this.param<string>("name") || this.ctx.getEntity(this.entityId)?.name || this.entityId;
  }

  private playerName(actorId: string): string {
    const n = this.store.get(`name/${actorId}`);
    return typeof n === "string" && n ? n : "traveller";
  }

  private inRange(actorId: string, slack = 0): boolean {
    const body = this.ctx.getObject(actorId);
    if (!body) return false;
    const me = this.object.getWorldPosition(this.object.position.clone());
    const at = body.getWorldPosition(body.position.clone());
    return Math.hypot(at.x - me.x, at.z - me.z) <= this.param<number>("radius") + slack && Math.abs(at.y - me.y) < 4;
  }

  private quest(id: string): Quest | undefined {
    const a = this.ctx.getDataAsset?.(id);
    return a?.type === "quest" ? (a.data as Quest) : undefined;
  }

  private memoryOf(actorId: string): NpcMemory {
    const raw = this.store.get(`npc/${actorId}`);
    return raw ? (raw as NpcMemory) : npcMemorySchema.parse({});
  }

  private vaultOf(actorId: string): Vault {
    const raw = this.store.get(`vault/${actorId}`);
    return raw ? (raw as Vault) : vaultSchema.parse({});
  }

  private conversation(actorId: string): Conversation | null {
    const c = this.store.get(`dialogue/${actorId}`) as Conversation | undefined;
    return c && c.npc === this.entityId ? c : null;
  }

  private facts(actorId: string, memory: NpcMemory, sheet: CharacterSheet | null, journal: QuestJournal | undefined, metBefore: boolean, bind?: SoulBind | null): DialogueFacts {
    return {
      npcId: this.entityId,
      memory,
      sheet,
      journal,
      quest: (id) => this.quest(id),
      metBefore,
      bind: bind === undefined ? this.bindOf(actorId) : bind,
      bindPoint: this.bindPoint(),
      world: this.worldFacts(actorId),
    };
  }

  /** Clock, weather and the biome under the talker, for `clock` / `weather` conditions. */
  private worldFacts(actorId: string): DialogueFacts["world"] {
    const body = this.ctx.getObject(actorId);
    return body ? worldFactsAt(this.ctx, this.store, body.position.x, body.position.z) : null;
  }

  private bindOf(actorId: string): SoulBind | null {
    const r = soulBindSchema.safeParse(this.store.get(`bind/${actorId}`));
    return r.success ? r.data : null;
  }

  /** Where a bindSoul here binds to: the `bindPoint` param, else this NPC's world position. */
  private bindPoint(): [number, number, number] {
    const p = this.param<unknown>("bindPoint");
    if (Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number" && Number.isFinite(n))) return [p[0], p[1], p[2]];
    const at = this.object.getWorldPosition(this.object.position.clone());
    return [at.x, at.y, at.z];
  }

  /** The conversation value for `node` as this character sees it now. */
  private show(actorId: string, node: string, facts: DialogueFacts, prev: Conversation | null, panel: Conversation["panel"], notice = ""): void {
    const d = this.dialogue!;
    const n = d.nodes[node]!;
    const seq = (prev?.seq ?? 0) + 1;
    const choices = availableChoices(d, node, facts).map((index) => ({ index, text: fillPlaces(n.choices[index]!.text, this.places) }));
    const text = fillPlaces(nodeText(n, seq + (facts.memory?.met[this.entityId] ?? 0), { name: this.playerName(actorId), npc: this.displayName() }), this.places);
    const value: Conversation = { npc: this.entityId, node, text, choices, panel, notice, seq };
    if (!this.store.set(`dialogue/${actorId}`, value)) console.warn(`[npc] ${this.entityId}: conversation for ${actorId} failed validation`);
  }

  /**
   * A character DOWNED, or being looted (lootlock/<actorId>: killed by a player, inside the looter's window), gets no NPC service at
   * all — no shop, vault, repair or quest hand-in — so nothing they carry can be sold, banked or spent out of reach.
   */
  private looted(actorId: string): boolean {
    // a DOWNED character (core isDowned: out of the fight, not dead) gets no service either: no shopping while bleeding out
    if (isDowned(this.store, actorId)) {
      this.ctx.events?.emit(CHARACTER_EVENTS.refused, { actorId, request: "talk", error: "you are down: nobody will deal with you until you are back on your feet" });
      return true;
    }
    if (!isLootLocked(this.store, actorId, this.ctx.now())) return false;
    this.ctx.events?.emit(CHARACTER_EVENTS.refused, { actorId, request: "talk", error: "you are being looted: nobody will deal with you until it is over" });
    return true;
  }

  private talk(actorId: string): void {
    if (!this.dialogue) return;
    if (this.looted(actorId)) return;
    if (!this.inRange(actorId, 1)) return;
    // a `presence` that is not there for this character cannot be spoken to
    if (!presentFor(this.ctx, this.store, this.entityId, actorId)) return;
    const memory = this.memoryOf(actorId);
    const metBefore = (memory.met[this.entityId] ?? 0) > 0;
    const sheet = readSheet(this.store, actorId);
    const journal = this.store.get(`quests/${actorId}`) as QuestJournal | undefined;
    const facts = this.facts(actorId, memory, sheet, journal, metBefore);
    const node = startNode(this.dialogue, facts);
    if (!node) return;
    const nextMemory: NpcMemory = { ...memory, met: { ...memory.met, [this.entityId]: (memory.met[this.entityId] ?? 0) + 1 } };
    this.store.set(`npc/${actorId}`, nextMemory);
    this.ctx.events?.emit(NPC_EVENTS.talked, { actorId, npcId: this.entityId });
    if (this.param<boolean>("readable")) this.ctx.events?.emit(QUEST_EVENTS.read, { actorId, entityId: this.entityId });
    // `met` inside the conversation keeps meaning "before it began"
    this.show(actorId, node, { ...facts, memory: nextMemory }, this.store.get(`dialogue/${actorId}`) as Conversation | null, null);
  }

  private end(actorId: string): void {
    if (this.conversation(actorId)) this.store.delete(`dialogue/${actorId}`);
  }

  private choose(actorId: string, node: string, index: number): void {
    const conv = this.conversation(actorId);
    const d = this.dialogue;
    if (!conv || !d || conv.node !== node || !this.inRange(actorId, 3) || this.looted(actorId)) return;
    const memory = this.memoryOf(actorId);
    const metBefore = (memory.met[this.entityId] ?? 0) > 1;
    const sheet = readSheet(this.store, actorId);
    if (!sheet) return;
    const journal = this.store.get(`quests/${actorId}`) as QuestJournal | undefined;
    const facts = this.facts(actorId, memory, sheet, journal, metBefore);
    if (!availableChoices(d, node, facts).includes(index)) return;
    const choice = d.nodes[node]!.choices[index]!;
    const bind = this.bindOf(actorId);
    let draft: Draft = { sheet, bind, journal, memory, panel: null, xp: 0 };
    for (const action of choice.do) {
      const r = this.act(draft, action);
      if (typeof r === "string") {
        this.show(actorId, node, facts, conv, conv.panel, r);
        return;
      }
      draft = r;
    }
    // commit: everything the choice touched, then the conversation
    if (draft.sheet !== sheet) this.store.set(sheetKey(actorId), draft.sheet);
    if (draft.journal !== journal && draft.journal) this.store.set(`quests/${actorId}`, draft.journal);
    if (draft.memory !== memory) this.store.set(`npc/${actorId}`, draft.memory);
    if (draft.bind !== bind && draft.bind) this.store.set(`bind/${actorId}`, draft.bind);
    if (draft.xp > 0) this.ctx.events?.emit(CHARACTER_EVENTS.xp, { actorId, amount: draft.xp });
    const after = this.facts(actorId, draft.memory, draft.sheet, draft.journal, metBefore, draft.bind);
    if (choice.goto === "end") {
      // a service window outlives the talk that opened it
      if (draft.panel) this.show(actorId, node, after, conv, draft.panel);
      else this.end(actorId);
      return;
    }
    this.show(actorId, choice.goto, after, conv, draft.panel);
  }

  /** One action on the draft, or why it cannot happen. */
  private act(draft: Draft, action: DialogueAction): Draft | string {
    switch (action.do) {
      case "setFlag":
        return { ...draft, memory: { ...draft.memory, flags: { ...draft.memory.flags, [action.flag]: true } } };
      case "clearFlag": {
        const flags = { ...draft.memory.flags };
        delete flags[action.flag];
        return { ...draft, memory: { ...draft.memory, flags } };
      }
      case "acceptQuest": {
        const q = this.quest(action.quest);
        if (!q) return `unknown quest "${action.quest}"`;
        const r = acceptQuest(draft.journal, q);
        return r.error ? `Quest: ${r.error}.` : { ...draft, journal: r.journal };
      }
      case "turnInQuest": {
        const q = this.quest(action.quest);
        if (!q) return `unknown quest "${action.quest}"`;
        const r = turnInQuest(draft.journal, q);
        if (r.error) return `Quest: ${r.error}.`;
        let sheet = draft.sheet;
        if (q.consume) {
          for (const o of q.objectives) {
            if (o.kind !== "collect") continue;
            const taken = takeCarried(sheet, o.target, o.required, this.env);
            if (!taken.ok) return taken.error;
            sheet = taken.sheet;
          }
        }
        for (const reward of q.rewardItems) {
          const given = addItem(sheet, reward.itemId, reward.qty, this.env);
          if (!given.ok || given.placed < reward.qty) return "Make room in your bags first.";
          sheet = given.sheet;
        }
        sheet = { ...sheet, coins: sheet.coins + q.rewardCoins };
        // what the quest entrusted to the character goes back with it (item `entrustedQuest`)
        sheet = takeEntrusted(sheet, action.quest, this.env);
        return { ...draft, sheet, journal: r.journal, xp: draft.xp + q.rewardXp };
      }
      case "openShop":
        if (!this.shop || action.shop !== this.param<string>("shop")) return "This shop is closed.";
        return { ...draft, panel: { kind: "shop", shop: action.shop } };
      case "openVault":
        if (!this.param<boolean>("vault")) return "There is no vault here.";
        return { ...draft, panel: { kind: "vault" } };
      case "bindSoul":
        return { ...draft, bind: { at: this.bindPoint(), name: this.param<string>("bindName") || this.displayName() } };
      case "openRepair":
        return { ...draft, panel: { kind: "repair", rate: action.rate } };
      case "openSoulbind":
        return { ...draft, panel: { kind: "soulbind", slots: action.slots, price: action.price, exclude: [...action.exclude] } };
      case "give": {
        const r = addItem(draft.sheet, action.item, action.qty, this.env);
        if (!r.ok || r.placed < action.qty) return "Make room in your bags first.";
        return { ...draft, sheet: r.sheet };
      }
      case "take": {
        const r = takeCarried(draft.sheet, action.item, action.qty, this.env);
        return r.ok ? { ...draft, sheet: r.sheet } : r.error;
      }
      case "pay":
        if (draft.sheet.coins < action.coins) return "You cannot afford that.";
        return { ...draft, sheet: { ...draft.sheet, coins: draft.sheet.coins - action.coins } };
      case "reward":
        return { ...draft, sheet: { ...draft.sheet, coins: draft.sheet.coins + action.coins }, xp: draft.xp + action.xp };
    }
  }

  private shelf(): ShopState {
    const id = this.param<string>("shop");
    return (this.store.get(`shop/${id}`) as ShopState | undefined) ?? freshShopState(this.shop!);
  }

  private trade(actorId: string, fn: (sheet: CharacterSheet, state: ShopState, shop: Shop) => { ok: true; sheet: CharacterSheet; state: ShopState } | { ok: false; error: string }): void {
    const conv = this.conversation(actorId);
    if (!conv || conv.panel?.kind !== "shop" || !this.shop || !this.inRange(actorId, 3) || this.looted(actorId)) return;
    const sheet = readSheet(this.store, actorId);
    if (!sheet) return;
    const r = fn(sheet, this.shelf(), this.shop);
    if (!r.ok) return this.notice(actorId, conv, r.error);
    this.store.set(sheetKey(actorId), r.sheet);
    this.store.set(`shop/${this.param<string>("shop")}`, r.state);
    if (conv.notice) this.notice(actorId, conv, "");
  }

  private bank(actorId: string, fn: (sheet: CharacterSheet, vault: Vault) => { ok: true; sheet: CharacterSheet; vault: Vault } | { ok: false; error: string }): void {
    const conv = this.conversation(actorId);
    if (!conv || conv.panel?.kind !== "vault" || !this.param<boolean>("vault") || !this.inRange(actorId, 3) || this.looted(actorId)) return;
    const sheet = readSheet(this.store, actorId);
    if (!sheet) return;
    const r = fn(sheet, this.vaultOf(actorId));
    if (!r.ok) return this.notice(actorId, conv, r.error);
    this.store.set(sheetKey(actorId), r.sheet);
    this.store.set(`vault/${actorId}`, r.vault);
    if (conv.notice) this.notice(actorId, conv, "");
  }

  /** A repair request at this NPC's open repair window, priced at the rate the window was opened with. */
  private mend(actorId: string, fn: (sheet: CharacterSheet, rate: number) => { ok: true; sheet: CharacterSheet } | { ok: false; error: string }): void {
    const conv = this.conversation(actorId);
    if (!conv || conv.panel?.kind !== "repair" || !this.inRange(actorId, 3) || this.looted(actorId)) return;
    const sheet = readSheet(this.store, actorId);
    if (!sheet) return;
    const r = fn(sheet, conv.panel.rate);
    if (!r.ok) return this.notice(actorId, conv, r.error);
    this.store.set(sheetKey(actorId), r.sheet);
    if (conv.notice) this.notice(actorId, conv, "");
  }

  /** `soul.attune` at this NPC's open soul binder window: soulbind these slots to what is worn there now. */
  private attune(actorId: string, slots: EquipmentSlot[]): void {
    const conv = this.conversation(actorId);
    if (!conv || conv.panel?.kind !== "soulbind" || !this.inRange(actorId, 3) || this.looted(actorId)) return;
    const sheet = readSheet(this.store, actorId);
    if (!sheet) return;
    const r = attuneSoulSlots(sheet, slots, { max: conv.panel.slots, price: conv.panel.price, exclude: conv.panel.exclude });
    if (!r.ok) return this.notice(actorId, conv, r.error);
    this.store.set(sheetKey(actorId), r.sheet);
    if (conv.notice) this.notice(actorId, conv, "");
  }

  private notice(actorId: string, conv: Conversation, text: string): void {
    const cap = text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
    this.store.set(`dialogue/${actorId}`, { ...conv, notice: cap, seq: conv.seq + 1 });
  }

  override onFixedUpdate(dt: number): void {
    if (!this.store.isAuthority()) return;
    this.tick += dt;
    if (this.tick < 0.5) return;
    const step = this.tick;
    this.tick = 0;
    // walked away (or gone): the conversation ends
    for (const key of this.store.keys("dialogue/")) {
      const actorId = key.slice("dialogue/".length);
      if (this.conversation(actorId) && !this.inRange(actorId, 3)) this.end(actorId);
    }
    // the shelf refills, one unit per restockSeconds per entry
    if (!this.shop) return;
    const id = this.param<string>("shop");
    const state = this.store.get(`shop/${id}`) as ShopState | undefined;
    if (!state) return;
    let next: ShopState | null = null;
    for (const e of this.shop.stock) {
      if (e.qty === undefined) continue;
      const have = (next ?? state).stock[e.itemId] ?? 0;
      if (have >= e.qty) {
        this.restock.delete(e.itemId);
        continue;
      }
      const t = (this.restock.get(e.itemId) ?? 0) + step;
      if (t < e.restockSeconds) {
        this.restock.set(e.itemId, t);
        continue;
      }
      this.restock.set(e.itemId, t - e.restockSeconds);
      next ??= structuredClone(state);
      next.stock[e.itemId] = have + 1;
    }
    if (next) this.store.set(`shop/${id}`, next);
  }

  private presenceScan = 0;

  /** Presentation: hidden while a `presence` keeps it away; face the local player while they talk to this NPC. */
  override onLateUpdate(dt: number): void {
    this.presenceScan -= dt;
    if (this.presenceScan <= 0) {
      this.presenceScan = 0.25;
      showIfPresent(this.ctx, this.store, this.entityId, this.object);
    }
    if (!this.param<boolean>("face") || !this.turnId) return;
    const me = this.ctx.localPlayer?.();
    const target = this.ctx.getObject(this.turnId);
    if (!target) return;
    this.restYaw ??= target.rotation.y;
    const talking = me ? this.conversation(me) : null;
    let want = this.restYaw;
    if (talking && me) {
      const body = this.ctx.getObject(me);
      const self = this.ctx.getObject(this.entityId);
      if (body && self) want = Math.atan2(body.position.x - self.position.x, body.position.z - self.position.z) - self.rotation.y;
    }
    let delta = want - target.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(delta) < 1e-3) return;
    target.rotation.y += delta * Math.min(1, dt * 6);
  }
}
