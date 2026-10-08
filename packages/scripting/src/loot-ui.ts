import * as THREE from "three";
import {
  CHARACTER_EVENTS,
  LOOT_NETSTATE,
  LOOT_ROLL_NETSTATE,
  lootBagSchema,
  lootRollSchema,
  RARITY_TINT,
  roomFor,
  type CharacterSheet,
  type Item,
  type LooseStack,
  type LootBag,
  type LootRoll,
  type RollChoice,
  type SheetEnv,
  corpseClaimed,
} from "@hitreg/core";
import { Script } from "./script.js";
import { catalogOf, progressionOf, readSheet, sheetStoreOf, type SheetStoreLike } from "./character-store.js";
import { fillItemTip } from "./character-ui.js";

/** One row of the open window: an item bag's stack (by index) or a body's stack (by uid; `worn` = one of the choice). */
interface Row {
  itemId: string;
  qty: number;
  stack: LooseStack;
  index?: number;
  uid?: string;
  worn?: boolean;
}

/** A `loot.rolled` result as shown. */
interface RollResult {
  itemId: string;
  winner: string;
  choice: RollChoice;
  roll: number | null;
  rolls: Array<{ actorId: string; choice: RollChoice; roll?: number }>;
}

/**
 * The player's side of loot bags (core loot.ts, `lootbag/<bagId>`): each bag
 * THIS character owns lies on the ground as a small prop, a "[F] Loot" prompt
 * shows within reach, and the key opens a window listing what is in it, with
 * the inventory's own icons and tooltips (wear and rolled twists included).
 * Take one stack, or take all (the copper too); a stack that will not fit says
 * "No room" and stays in the bag (a part of a stack takes what fits).
 *
 * A body bag (a character you killed) shows three parts: their copper (take
 * it), the contents of their bags (take any, or all that fit) and their worn
 * gear (choose ONE); "Leave the rest" ends it early. A CORPSE you hold a
 * killer's claim on shows the same three parts (its contents are in the
 * corpse itself); your OWN corpse (what you carried when you fell) is an
 * ordinary bag titled "your corpse".
 *
 * Party loot rolls (`lootroll/<rollId>`) this character is asked about show as
 * prompts in the same frames: the item's icon and full tooltip, Need / Greed /
 * Pass and the time left. Each settled roll prints one line to chat.
 *
 * It only ever ASKS (`inventory.loot`, `loot.roll`); the character-sheet
 * decides on the authority. A dedicated server never sends this tab anyone
 * else's bags (an owner-only namespace); a bag that arrives anyway (a P2P
 * session) is not drawn unless it is ours.
 *
 * Put it on the player prefab with `actor` naming the body: it is inert on
 * every other player's copy. `template` names a hidden entity whose object is
 * cloned for each bag: its mesh is the bag's look, replaceable in one place;
 * `dropTemplate` / `dropIcon` are the ONE place a smaller look and prompt icon
 * for a bag of your own dropped items go.
 */
export class LootUi extends Script {
  static override scriptName = "loot-ui";
  static override presentation = true;

  static override params = {
    actor: {
      default: "",
      description: "body whose bags to show; empty = this tab's own player. On a player prefab name the body: the script stays inert on every other player's copy",
    },
    key: {
      default: "KeyF",
      description:
        "KeyboardEvent.code that opens the nearest bag in reach, and closes the window (Escape also closes). Keep it off E (talk) and the combat keys",
    },
    radius: {
      default: 3,
      min: 0.5,
      max: 20,
      description: "metres within which a bag can be opened; match the character-sheet pickupRadius (the authority checks it again)",
    },
    template: {
      default: "",
      description:
        "entity id whose object is CLONED for every bag on the ground (a hidden prop: its mesh is the bag's look, scale included). Empty = a small built-in box",
    },
    dropTemplate: {
      default: "",
      description:
        "entity id cloned for a bag of YOUR OWN dropped items (the place for a smaller look); empty = `template`",
    },
    dropIcon: {
      default: "",
      description: "texture path drawn in the prompt of a bag of your own dropped items (a small icon); empty = text only",
    },
    title: { default: "Loot", description: "window title before the source's name" },
    cssClass: {
      default: "",
      description: "game skin classes on the root (space-separated; the inventory's own skin makes the window match it). Styles stay owned by the project",
    },
  };

  private store!: SheetStoreLike;
  private catalog!: (id: string) => Item | undefined;
  private env!: SheetEnv;
  private root: HTMLDivElement | null = null;
  private prompt!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private rollStack!: HTMLDivElement;
  private tip!: HTMLDivElement;
  /** Bag id → its prop on the ground. */
  private readonly props = new Map<string, THREE.Object3D>();
  private templateReady = false;
  private openId = "";
  /** Body / corpse bags this client chose a worn piece from (the bag alone cannot tell "taken" from "none offered"). */
  private readonly tookWorn = new Set<string>();
  private nearId = "";
  private dirty = false;
  private scanIn = 0;
  private status = "";
  private shown = "";
  private rollsShown = "";
  /** Settled rolls this character was part of, newest last, with the time they arrived (ms, performance clock). */
  private readonly results: Array<{ line: string; at: number }> = [];
  private readonly offs: Array<() => void> = [];

  override onStart(): void {
    if (typeof document === "undefined") return;
    this.store = sheetStoreOf(this.ctx);
    this.catalog = catalogOf(this.ctx);
    this.env = { catalog: this.catalog };
    this.offs.push(
      this.store.onChange((key) => {
        if (key.startsWith(`${LOOT_NETSTATE}/`) || key.startsWith(`${LOOT_ROLL_NETSTATE}/`) || key.startsWith("character/")) this.dirty = true;
      }),
    );
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || !this.isMine()) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (e.code === "Escape" && this.openId) {
        this.close();
        e.preventDefault();
      } else if (e.code === this.param<string>("key")) {
        if (this.openId) this.close();
        else if (this.nearId) this.open(this.nearId);
        else return;
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    this.offs.push(() => document.removeEventListener("keydown", onKey));
    const off = this.ctx.events?.on(CHARACTER_EVENTS.refused, (p) => {
      const r = p as { actorId?: string; request?: string; error?: string };
      if (r.actorId !== this.actor() || (r.request !== "loot" && r.request !== "roll")) return;
      this.status = r.error ? r.error.charAt(0).toUpperCase() + r.error.slice(1) : "";
      this.dirty = true;
    });
    if (off) this.offs.push(off);
    const offRolled = this.ctx.events?.on(CHARACTER_EVENTS.rolled, (p) => this.onRolled(p as RollResult));
    if (offRolled) this.offs.push(offRolled);
  }

  /** The body this window serves: the param, else this tab's player. */
  private actor(): string {
    return this.param<string>("actor") || this.ctx.localPlayer?.() || "";
  }

  /** Only the tab whose player this is shows anything. */
  private isMine(): boolean {
    const actor = this.actor();
    const local = this.ctx.localPlayer?.();
    return !!actor && (local === undefined || local === null ? !this.param<string>("actor") : local === actor);
  }

  /** Every bag this character owns, read from the replica (ours alone on a dedicated server). */
  private bags(): Array<[string, LootBag]> {
    const actor = this.actor();
    const out: Array<[string, LootBag]> = [];
    for (const key of this.store.keys(`${LOOT_NETSTATE}/`)) {
      const parsed = lootBagSchema.safeParse(this.store.get(key));
      if (parsed.success && parsed.data.owner === actor) out.push([key.slice(LOOT_NETSTATE.length + 1), parsed.data]);
    }
    return out;
  }

  /** Rolls this character is asked about and has not answered yet. */
  private openRolls(): Array<[string, LootRoll]> {
    const actor = this.actor();
    const out: Array<[string, LootRoll]> = [];
    for (const key of this.store.keys(`${LOOT_ROLL_NETSTATE}/`)) {
      const parsed = lootRollSchema.safeParse(this.store.get(key));
      if (parsed.success && parsed.data.eligible.includes(actor) && parsed.data.choices[actor] === undefined) {
        out.push([key.slice(LOOT_ROLL_NETSTATE.length + 1), parsed.data]);
      }
    }
    return out.sort((a, b) => a[1].until - b[1].until);
  }

  override onLateUpdate(dt: number): void {
    if (!this.store) return;
    if (!this.isMine()) {
      if (this.props.size > 0 || this.root) this.teardown();
      return;
    }
    this.scanIn -= dt;
    if (this.scanIn <= 0 || this.dirty) {
      this.scanIn = 0.25;
      this.scan();
      this.renderRolls();
    }
    if (this.dirty) {
      this.dirty = false;
      this.render();
    } else if (this.openId) this.renderTimer();
    this.renderRollTimers();
  }

  /** Props for our bags, the nearest one in reach, and the window closed when its bag is gone or out of reach. */
  private scan(): void {
    const bags = this.bags();
    const live = new Set(bags.map(([id]) => id));
    for (const [id, obj] of this.props) {
      if (!live.has(id)) {
        obj.removeFromParent();
        this.props.delete(id);
      }
    }
    // the template's mesh streams in after start: rebuild what was drawn as the fallback box
    if (!this.templateReady && this.templateMeshReady(this.param<string>("template"))) {
      this.templateReady = true;
      for (const obj of this.props.values()) obj.removeFromParent();
      this.props.clear();
    }
    const body = this.ctx.getObject(this.actor());
    const reach = this.param<number>("radius");
    let near = "";
    let best = Infinity;
    for (const [id, bag] of bags) {
      if (!this.props.has(id)) this.props.set(id, this.place(bag));
      if (!body) continue;
      const d = Math.hypot(body.position.x - bag.at[0], body.position.y - bag.at[1], body.position.z - bag.at[2]);
      if (d <= reach && d < best) {
        best = d;
        near = id;
      }
    }
    if (near !== this.nearId) {
      this.nearId = near;
      this.dirty = true;
    }
    if (this.openId && (!live.has(this.openId) || (body && this.distanceTo(this.openId, body) > reach + 1))) this.close();
  }

  private distanceTo(bagId: string, body: THREE.Object3D): number {
    const bag = lootBagSchema.safeParse(this.store.get(`${LOOT_NETSTATE}/${bagId}`));
    if (!bag.success) return Infinity;
    const at = bag.data.at;
    return Math.hypot(body.position.x - at[0], body.position.y - at[1], body.position.z - at[2]);
  }

  /** A bag of this character's own dropped items (the one that may wear `dropTemplate` / `dropIcon`). */
  private isOwnDrop(bag: LootBag): boolean {
    return bag.dropped === true || (bag.body === undefined && bag.corpse === undefined && bag.from === this.actor());
  }

  /**
   * A template's object: the entity named `id`, or — inside an expanded prefab, whose child ids are prefixed
   * ("player:player-loot-bag", "player:p-1/player:player-loot-bag") while a param keeps the bare id — the sibling or
   * relative whose id ends with it.
   */
  private templateObject(id: string): THREE.Object3D | undefined {
    if (!id) return undefined;
    const direct = this.ctx.getObject(id);
    if (direct) return direct;
    const matches = (o: THREE.Object3D): boolean => {
      const e = o.userData["entityId"];
      return typeof e === "string" && (e.endsWith(`:${id}`) || e.endsWith(`/${id}`));
    };
    for (let at = this.object.parent; at; at = at.parent) {
      const hit = at.children.find(matches);
      if (hit) return hit;
    }
    return undefined;
  }

  private templateMeshReady(id: string): boolean {
    const t = this.templateObject(id);
    let mesh = false;
    t?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) mesh = true;
    });
    return mesh;
  }

  /** A bag's prop on the ground: a clone of its template (scale kept), or a small box until there is one. */
  private place(bag: LootBag): THREE.Object3D {
    let obj: THREE.Object3D;
    const id = (this.isOwnDrop(bag) && this.param<string>("dropTemplate")) || this.param<string>("template");
    const template = this.templateObject(id);
    if (template && this.templateMeshReady(id)) {
      obj = template.clone(true);
      obj.traverse((o) => {
        o.userData = {};
      });
      const s = new THREE.Vector3();
      template.getWorldScale(s);
      obj.scale.copy(s);
    } else {
      obj = new THREE.Mesh(LootUi.boxGeometry(), LootUi.boxMaterial());
      obj.position.y = 0.15;
      const group = new THREE.Group();
      group.add(obj);
      obj = group;
    }
    obj.visible = true;
    obj.name = "loot-bag";
    obj.position.set(bag.at[0], bag.at[1], bag.at[2]);
    obj.rotation.set(0, (bag.at[0] * 7.13 + bag.at[2] * 3.7) % (Math.PI * 2), 0);
    let scene: THREE.Object3D = this.object;
    while (scene.parent) scene = scene.parent;
    scene.add(obj);
    obj.updateMatrixWorld(true);
    return obj;
  }

  private static box: THREE.BoxGeometry | null = null;
  private static boxMat: THREE.MeshStandardMaterial | null = null;
  private static boxGeometry(): THREE.BoxGeometry {
    return (LootUi.box ??= new THREE.BoxGeometry(0.36, 0.3, 0.3));
  }
  private static boxMaterial(): THREE.MeshStandardMaterial {
    return (LootUi.boxMat ??= new THREE.MeshStandardMaterial({ color: 0x7a5a36, roughness: 0.9 }));
  }

  // -- the window ---------------------------------------------------------------------------------

  private mount(): void {
    if (this.root) return;
    const root = el("div", "hr-loot");
    for (const c of this.param<string>("cssClass").split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(c)) root.classList.add(c);
    root.innerHTML = `<style>${CSS}</style>`;
    this.prompt = el("div", "hr-loot-prompt");
    this.prompt.hidden = true;
    this.panel = el("div", "hr-panel hr-loot-panel");
    this.panel.dataset["windowId"] = "loot";
    this.panel.setAttribute("role", "dialog");
    this.panel.hidden = true;
    this.rollStack = el("div", "hr-roll-stack");
    this.rollStack.setAttribute("aria-live", "polite");
    this.tip = el("div", "hr-tip");
    this.tip.setAttribute("role", "tooltip");
    this.tip.hidden = true;
    root.append(this.prompt, this.panel, this.rollStack, this.tip);
    // appended on first use, so the inventory's own root comes first in the page
    document.body.append(root);
    this.root = root;
  }

  private open(bagId: string): void {
    this.mount();
    this.openId = bagId;
    this.status = "";
    this.shown = "";
    if (document.pointerLockElement) document.exitPointerLock();
    this.dirty = true;
  }

  private close(): void {
    this.openId = "";
    this.status = "";
    this.shown = "";
    if (this.root) {
      this.panel.hidden = true;
      this.tip.hidden = true;
    }
    this.dirty = true;
  }

  private render(): void {
    if (!this.nearId && !this.openId) {
      if (this.root) this.prompt.hidden = true;
      return;
    }
    this.mount();
    const key = keyLabel(this.param<string>("key"));
    const near = this.nearId ? this.bagOf(this.nearId) : null;
    this.prompt.hidden = !!this.openId || !near;
    if (near && !this.openId) {
      const parts: Node[] = [el("kbd", "", key)];
      const icon = this.isOwnDrop(near) && this.param<string>("dropIcon") ? this.iconUrl(this.param<string>("dropIcon")) : undefined;
      if (icon) {
        const img = document.createElement("img");
        img.className = "hr-loot-prompt-icon";
        img.src = icon;
        img.alt = "";
        parts.push(img);
      }
      parts.push(el("span", "", ` ${this.param<string>("title")} ${this.sourceName(near)}`));
      this.prompt.replaceChildren(...parts);
    }
    const bag = this.openId ? this.bagOf(this.openId) : null;
    this.panel.hidden = !bag;
    if (!bag) return;
    const sheet = readSheet(this.store, this.actor());
    // the grids the sheet's own script published (its progression's pockets), as character-ui reads them
    const published = this.ctx.getObject(this.actor())?.userData["character"] as { grids?: { pockets?: { cols: number; rows: number } } } | undefined;
    const base = progressionOf(this.ctx, "");
    this.env = { catalog: this.catalog, progression: published?.grids?.pockets ? { ...base, pockets: published.grids.pockets } : base };
    const rows = this.rowsOf(bag);
    const coins = this.coinsOf(bag);
    // re-render only when something shown changed (the timer ticks on its own)
    const signature = JSON.stringify([this.openId, bag, rows, coins, this.status, sheet?.items, sheet?.coins]);
    if (signature === this.shown) return;
    this.shown = signature;
    this.tip.hidden = true;
    const head = el("div", "hr-head");
    const bodyLike = bag.body !== undefined || corpseClaimed(bag);
    const title = el("div", "hr-title", bodyLike ? `${this.sourceName(bag)}` : `${this.param<string>("title")} · ${this.sourceName(bag)}`);
    const close = button("hr-close", "×", () => this.close());
    close.setAttribute("aria-label", "Close");
    head.append(title, close);
    const parts: HTMLElement[] = [head];
    if (bodyLike) parts.push(...this.bodySections(bag, rows, coins, sheet));
    else {
      parts.push(
        el(
          "p",
          "hr-loot-intro",
          bag.corpse !== undefined
            ? "What you carried when you fell. Only you can see it; when the time runs out it is gone, with whatever is left in it."
            : "Only you can see this bag.",
        ),
      );
      const list = el("div", "hr-loot-list");
      list.setAttribute("role", "list");
      if (coins > 0) list.append(this.coinRow(coins, () => this.take({ coins: true })));
      for (const row of rows) list.append(this.rowEl(row, sheet, false));
      if (rows.length === 0 && coins <= 0) list.append(el("p", "hr-loot-empty", "Nothing left to take."));
      parts.push(list);
    }
    const status = el("p", "hr-loot-status", this.status);
    status.setAttribute("role", "status");
    status.hidden = !this.status;
    const foot = el("div", "hr-loot-foot");
    foot.append(el("span", "hr-loot-timer"));
    if (!bodyLike && rows.length + (coins > 0 ? 1 : 0) > 1) foot.append(button("hr-loot-all", "Take all", () => this.take({})));
    if (bodyLike) foot.append(button("hr-loot-done", "Leave the rest", () => this.take({ done: true })));
    parts.push(status, foot);
    this.panel.replaceChildren(...parts);
    this.panel.setAttribute("aria-label", title.textContent ?? "Loot");
    this.renderTimer();
  }

  /** A body bag's three parts: their copper, their bags' contents (any), their worn gear (one). */
  private bodySections(bag: LootBag, rows: Row[], coins: number, sheet: CharacterSheet | null): HTMLElement[] {
    const out: HTMLElement[] = [];
    out.push(el("p", "hr-loot-intro", "Yours to take until the time runs out: all their money, anything in their bags, and ONE piece of the gear they wear."));
    const money = section("Money");
    if (coins > 0) money.body.append(this.coinRow(coins, () => this.take({ coins: true })));
    else money.body.append(el("p", "hr-loot-empty", "No money left."));
    out.push(money.root);
    const carried = rows.filter((r) => !r.worn);
    const bags = section("Their bags · take any");
    if (carried.length > 1) bags.head.append(button("hr-loot-all", "Take all", () => this.take({ all: true })));
    // a body's stacks move whole (a transfer); a corpse's take what fits, like any bag
    for (const row of carried) bags.body.append(this.rowEl(row, sheet, bag.body !== undefined));
    if (carried.length === 0) bags.body.append(el("p", "hr-loot-empty", "Nothing left in their bags."));
    out.push(bags.root);
    const worn = rows.filter((r) => r.worn);
    const left = bag.takes ?? 0;
    // takes is 0 both after our pick and when nothing was offered (plundered, or all of it soulbound): say which (X3)
    const took = this.tookWorn.has(this.openId);
    const gear = section(left > 0 ? "Worn · choose ONE" : took ? "Worn · your one piece is taken" : "Worn · none to take");
    for (const row of worn) gear.body.append(this.rowEl(row, sheet, true));
    if (left > 0 && worn.length === 0) gear.body.append(el("p", "hr-loot-empty", "Nothing worn that may be taken."));
    if (left <= 0 && !took) {
      gear.body.append(el("p", "hr-loot-empty", "Nothing they wear may be taken: soulbound, or plundered by a killer in the last minutes."));
    }
    out.push(gear.root);
    return out;
  }

  private coinRow(coins: number, take: () => void): HTMLElement {
    const line = el("div", "hr-loot-row hr-loot-coins");
    line.setAttribute("role", "listitem");
    const slot = el("div", "hr-loot-slot");
    slot.append(el("div", "hr-item hr-coin-ico", "¤"));
    const info = el("div", "hr-loot-info");
    info.append(el("div", "hr-loot-name", formatCoins(coins)));
    const btn = button("hr-loot-take", "Take", take);
    btn.setAttribute("aria-label", `Take ${formatCoins(coins)}`);
    line.append(slot, info, btn);
    return line;
  }

  /** "Gone in 9:41" under the list; ticks without re-rendering the rows. */
  private renderTimer(): void {
    const bag = this.openId ? this.bagOf(this.openId) : null;
    const timer = this.root?.querySelector<HTMLElement>(".hr-loot-timer");
    if (!bag || !timer) return;
    if (bag.until === undefined) {
      timer.textContent = "";
      return;
    }
    const claimed = corpseClaimed(bag) && bag.claimUntil !== undefined;
    const ends = claimed ? bag.claimUntil! : bag.until;
    const text = `${bag.body !== undefined || claimed ? "Chance ends in" : "Gone in"} ${formatLeft(ends - this.ctx.now())}`;
    if (timer.textContent !== text) timer.textContent = text;
  }

  private bagOf(bagId: string): LootBag | null {
    const parsed = lootBagSchema.safeParse(this.store.get(`${LOOT_NETSTATE}/${bagId}`));
    return parsed.success && parsed.data.owner === this.actor() ? parsed.data : null;
  }

  /** A name for a body id: its nameplate (name/<body>), its entity's name, or the id's tail. */
  private nameOf(id: string): string {
    if (id === this.actor()) return "You";
    const named = this.store.get(`name/${id}`);
    return typeof named === "string" && named ? named : this.ctx.getEntity(id)?.name || id.replace(/^.*[/:]/, "") || "someone";
  }

  /** "Timber Wolf", "Ana's belongings", "your dropped items". */
  private sourceName(bag: LootBag): string {
    if (bag.corpse !== undefined && bag.corpse === this.actor()) return "your corpse";
    if (bag.corpse !== undefined) return `${this.nameOf(bag.corpse)}'s belongings`;
    const from = bag.from ?? bag.body ?? "";
    if (from === this.actor()) return "your dropped items";
    if (!from) return "the ground";
    const name = this.nameOf(from);
    return bag.body !== undefined ? `${name}'s belongings` : name;
  }

  /** The copper a bag offers: an item bag's own, or a body's (never more than the victim still carries). */
  private coinsOf(bag: LootBag): number {
    if (bag.body === undefined) return bag.coins ?? 0;
    return Math.min(bag.coins ?? 0, readSheet(this.store, bag.body)?.coins ?? 0);
  }

  private rowsOf(bag: LootBag): Row[] {
    if (bag.body === undefined) {
      const rows: Row[] = bag.items.map((s, index) => ({ itemId: s.itemId, qty: s.qty, stack: s, index }));
      // a corpse under our claim: its dead character's worn gear to choose ONE from
      const victim = corpseClaimed(bag) && (bag.takes ?? 0) > 0 ? readSheet(this.store, bag.corpse!) : null;
      for (const uid of victim ? (bag.offer ?? []) : []) {
        const st = victim!.items[uid];
        if (!st) continue;
        const { container: _c, x: _x, y: _y, ...loose } = st;
        rows.push({ itemId: st.itemId, qty: st.qty, stack: loose, uid, worn: true });
      }
      return rows;
    }
    const victim = readSheet(this.store, bag.body);
    if (!victim) return [];
    const rows: Row[] = [];
    const add = (uid: string, worn: boolean): void => {
      const s = victim.items[uid];
      if (!s) return;
      const { container: _c, x: _x, y: _y, ...loose } = s;
      rows.push({ itemId: s.itemId, qty: s.qty, stack: loose, uid, ...(worn ? { worn } : {}) });
    };
    for (const uid of bag.carried ?? []) add(uid, false);
    if ((bag.takes ?? 0) > 0) for (const uid of bag.offer ?? []) add(uid, true);
    return rows;
  }

  private itemNode(item: Item | undefined, itemId: string, qty: number): HTMLDivElement {
    const node = el("div", "hr-item");
    node.style.setProperty("--tint", item?.tint ?? (item ? RARITY_TINT[item.rarity] : "#ff5a5a"));
    const url = item?.icon ? this.iconUrl(item.icon) : undefined;
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.draggable = false;
      node.append(img);
    } else node.append(el("span", "ini", initials(item?.name ?? itemId)));
    if (qty > 1) node.append(el("span", "qty", String(qty)));
    return node;
  }

  private tipOn(target: HTMLElement, item: Item | undefined, itemId: string, stack: LooseStack): void {
    target.addEventListener("pointerenter", (e) => this.showTip(item, itemId, stack, e));
    target.addEventListener("pointermove", (e) => this.placeTip(e));
    target.addEventListener("pointerleave", () => (this.tip.hidden = true));
  }

  private rowEl(row: Row, sheet: CharacterSheet | null, whole: boolean): HTMLElement {
    const item = this.catalog(row.itemId);
    const line = el("div", "hr-loot-row");
    line.setAttribute("role", "listitem");
    const slot = el("div", "hr-loot-slot");
    slot.append(this.itemNode(item, row.itemId, row.qty));
    this.tipOn(slot, item, row.itemId, row.stack);
    const name = el("div", "hr-loot-name", `${item?.name ?? row.itemId}${row.qty > 1 ? ` ×${row.qty}` : ""}`);
    name.style.color = item?.tint ?? (item ? RARITY_TINT[item.rarity] : "");
    // what fits, by the rule the authority will use (a body's item must fit whole)
    const fits = sheet ? roomFor(sheet, row.stack, this.env) : row.qty;
    const state = fits <= 0 || (whole && fits < row.qty) ? "No room" : fits < row.qty ? `Room for ${fits}` : "";
    const info = el("div", "hr-loot-info");
    info.append(name);
    if (state) {
      info.append(el("small", "hr-loot-room", state));
      line.classList.add(state === "No room" ? "hr-loot-full" : "hr-loot-partial");
    }
    const verb = row.worn ? "Choose" : "Take";
    const take = button("hr-loot-take", verb, () => {
      if (row.worn) this.tookWorn.add(this.openId);
      this.take(row.uid !== undefined ? { uid: row.uid } : { index: row.index });
    });
    take.setAttribute("aria-label", `${verb} ${item?.name ?? row.itemId}${state ? ` (${state.toLowerCase()})` : ""}`);
    line.append(slot, info, take);
    return line;
  }

  private take(what: { index?: number; uid?: string; all?: boolean; coins?: boolean; done?: boolean }): void {
    if (!this.openId) return;
    this.status = "";
    this.ctx.events?.emit(CHARACTER_EVENTS.loot, { actorId: this.actor(), bagId: this.openId, ...what });
    this.dirty = true;
  }

  // -- party rolls ----------------------------------------------------------------------------------

  /** One prompt per roll this character has not answered, plus the recent results. */
  private renderRolls(): void {
    const rolls = this.openRolls();
    const now = performance.now();
    while (this.results.length > 0 && now - this.results[0]!.at > 30_000) this.results.shift();
    const signature = JSON.stringify([rolls.map(([id]) => id), this.results.map((r) => r.line)]);
    if (signature === this.rollsShown) return;
    this.rollsShown = signature;
    // a card replaced under the pointer never sends pointerleave: its tooltip goes with it
    if (this.root) this.tip.hidden = true;
    if (rolls.length === 0 && this.results.length === 0) {
      this.rollStack?.replaceChildren();
      return;
    }
    this.mount();
    const cards: HTMLElement[] = [];
    for (const [rollId, roll] of rolls.slice(0, 4)) cards.push(this.rollCard(rollId, roll));
    if (this.results.length > 0) {
      const log = el("div", "hr-panel hr-roll-log");
      log.setAttribute("role", "log");
      for (const r of this.results.slice(-5)) log.append(el("div", "hr-roll-line", r.line));
      cards.push(log);
    }
    this.rollStack.replaceChildren(...cards);
  }

  private rollCard(rollId: string, roll: LootRoll): HTMLElement {
    const item = this.catalog(roll.item.itemId);
    const card = el("div", "hr-panel hr-roll");
    card.dataset["rollId"] = rollId;
    card.setAttribute("role", "group");
    const top = el("div", "hr-roll-top");
    const slot = el("div", "hr-loot-slot");
    slot.append(this.itemNode(item, roll.item.itemId, roll.item.qty));
    this.tipOn(slot, item, roll.item.itemId, roll.item);
    const info = el("div", "hr-loot-info");
    const name = el("div", "hr-loot-name", `${item?.name ?? roll.item.itemId}${roll.item.qty > 1 ? ` ×${roll.item.qty}` : ""}`);
    name.style.color = item?.tint ?? (item ? RARITY_TINT[item.rarity] : "");
    info.append(name, el("small", "hr-roll-from", `${item?.rarity ?? ""} · from ${roll.from ? this.nameOf(roll.from) : "the kill"}${roll.item.twists?.length ? " · twisted" : ""}`));
    top.append(slot, info);
    card.setAttribute("aria-label", `Roll for ${item?.name ?? roll.item.itemId}`);
    const bar = el("div", "hr-roll-bar");
    bar.append(el("div", "hr-roll-fill"));
    const left = el("span", "hr-roll-left");
    const buttons = el("div", "hr-roll-buttons");
    for (const [choice, label] of [["need", "Need"], ["greed", "Greed"], ["pass", "Pass"]] as const) {
      const b = button(`hr-roll-${choice}`, label, () => this.ctx.events?.emit(CHARACTER_EVENTS.roll, { actorId: this.actor(), rollId, choice }));
      b.setAttribute("aria-label", `${label} on ${item?.name ?? roll.item.itemId}`);
      buttons.append(b);
    }
    buttons.append(left);
    card.append(top, bar, buttons);
    return card;
  }

  /** The time bars and "0:41" on each roll prompt. */
  private renderRollTimers(): void {
    if (!this.root) return;
    for (const card of Array.from(this.rollStack.querySelectorAll(".hr-roll")) as HTMLElement[]) {
      const roll = lootRollSchema.safeParse(this.store.get(`${LOOT_ROLL_NETSTATE}/${card.dataset["rollId"]}`));
      if (!roll.success) continue;
      const ms = roll.data.until - this.ctx.now();
      const fill = card.querySelector(".hr-roll-fill") as HTMLElement | null;
      const left = card.querySelector(".hr-roll-left") as HTMLElement | null;
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, (ms / 45_000) * 100))}%`;
      const text = formatLeft(ms);
      if (left && left.textContent !== text) left.textContent = text;
    }
  }

  /** A settled roll this character was in: one line to chat and to the prompt column. */
  private onRolled(r: RollResult): void {
    if (!this.isMine() || !r.rolls?.some((x) => x.actorId === this.actor())) return;
    const item = this.catalog(r.itemId)?.name ?? r.itemId;
    const who = this.nameOf(r.winner);
    const how = r.choice === "pass" ? "everyone passed" : `${r.choice === "need" ? "Need" : "Greed"} ${r.roll ?? "?"}`;
    const others = r.rolls
      .filter((x) => x.actorId !== r.winner)
      .map((x) => `${this.nameOf(x.actorId)} ${x.choice === "pass" ? "passed" : `${x.choice}${x.roll !== undefined ? ` ${x.roll}` : ""}`}`)
      .join(", ");
    const line = `Loot: ${item} → ${who} (${how})${others ? ` · ${others}` : ""}`;
    this.ctx.chat?.system(line);
    this.results.push({ line, at: performance.now() });
    this.dirty = true;
  }

  // -- tooltip --------------------------------------------------------------------------------------

  private showTip(item: Item | undefined, itemId: string, stack: LooseStack, e: PointerEvent): void {
    fillItemTip(this.tip, item, itemId, stack, (i) => this.iconUrl(i));
    this.tip.hidden = false;
    this.placeTip(e);
  }

  private placeTip(e: PointerEvent): void {
    if (this.tip.hidden) return;
    const r = this.tip.getBoundingClientRect();
    this.tip.style.left = `${Math.max(4, Math.min(e.clientX + 14, window.innerWidth - r.width - 4))}px`;
    this.tip.style.top = `${Math.max(4, Math.min(e.clientY + 14, window.innerHeight - r.height - 4))}px`;
  }

  private iconUrl(icon: string): string | undefined {
    if (/^(https?:|data:|blob:|\/)/.test(icon)) return icon;
    return this.ctx.textureUrl?.(icon);
  }

  private teardown(): void {
    for (const obj of this.props.values()) obj.removeFromParent();
    this.props.clear();
    this.root?.remove();
    this.root = null;
    this.openId = "";
    this.nearId = "";
    this.rollsShown = "";
  }

  override onDispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.teardown();
  }
}

function el(tag: string, className: string, text?: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, text) as unknown as HTMLButtonElement;
  b.type = "button";
  b.onclick = onClick;
  return b;
}

/** A titled part of the body window. */
function section(title: string): { root: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const root = el("section", "hr-loot-section");
  const head = el("div", "hr-loot-section-head");
  head.append(el("h3", "hr-loot-section-title", title));
  const body = el("div", "hr-loot-list");
  body.setAttribute("role", "list");
  root.append(head, body);
  return { root, head, body };
}

/** 12345 copper → "1g 23s 45c". */
function formatCoins(c: number): string {
  const g = Math.floor(c / 10000);
  const s = Math.floor((c % 10000) / 100);
  const cc = c % 100;
  return [g ? `${g}g` : "", s ? `${s}s` : "", cc || (!g && !s) ? `${cc}c` : ""].filter(Boolean).join(" ");
}

/** ms → "9:41" (hours shown past one: "71:59:10"). */
function formatLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function keyLabel(code: string): string {
  return code.replace(/^Key/, "").replace(/^Digit/, "");
}

/**
 * Built-in look; a game skin (cssClass) restyles it. Positioning rules use a repeated class so they hold against an
 * inventory skin that also matches `.hr-panel`.
 */
const CSS = `
.hr-loot{position:fixed;inset:0;z-index:61;pointer-events:none;font:12px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#dfe3ec;user-select:none}
.hr-loot.hr-loot .hr-loot-prompt{position:absolute;left:50%;bottom:24%;transform:translateX(-50%);padding:6px 14px;background:rgba(13,16,22,.9);border:1px solid #39425a;white-space:nowrap}
.hr-loot .hr-loot-prompt kbd{display:inline-block;min-width:18px;padding:0 5px;margin-right:4px;text-align:center;border:1px solid currentColor;font:inherit}
.hr-loot .hr-loot-prompt-icon{width:16px;height:16px;vertical-align:-3px;margin-right:2px;image-rendering:pixelated}
.hr-loot.hr-loot.hr-loot .hr-loot-panel{pointer-events:auto;position:fixed;left:calc(50% + 120px);top:50%;transform:translateY(-50%);width:420px;min-width:0;max-width:92vw;max-height:none;overflow:visible;box-sizing:border-box}
.hr-loot .hr-loot-list{max-height:min(40vh,360px);overflow:auto}
@media(max-width:1000px){.hr-loot.hr-loot.hr-loot .hr-loot-panel{left:50%;transform:translate(-50%,-50%)}}
.hr-loot:not(.mmo-screen) .hr-panel{padding:10px 12px;background:#0f131b;border:1px solid #39425a}
.hr-loot.hr-loot .hr-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;margin-bottom:6px}
.hr-loot.hr-loot .hr-title{font-size:15px;letter-spacing:.06em}
.hr-loot .hr-close{min-width:30px;min-height:28px;padding:0;font-size:16px;line-height:1;cursor:pointer}
.hr-loot .hr-loot-intro{margin:0 0 8px;font-size:11px;opacity:.75}
.hr-loot .hr-loot-section{margin-top:8px}
.hr-loot .hr-loot-section .hr-loot-list{max-height:min(22vh,200px)}
.hr-loot .hr-loot-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid rgba(255,255,255,.18);padding-bottom:3px}
.hr-loot .hr-loot-section-title{margin:0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;opacity:.85}
.hr-loot .hr-loot-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.hr-loot .hr-loot-slot{position:relative;flex:none;width:44px;height:44px}
.hr-loot .hr-loot-slot .hr-item{position:absolute;inset:0;box-sizing:border-box;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:help}
.hr-loot:not(.mmo-screen) .hr-loot-slot .hr-item{border:1px solid var(--tint,#b9c0d0);background:#1a1f2b}
.hr-loot .hr-loot-slot .hr-item img{max-width:86%;max-height:86%;image-rendering:pixelated;pointer-events:none}
.hr-loot .hr-loot-slot .hr-item .qty{position:absolute;right:3px;bottom:1px;font-size:10px;text-shadow:0 0 3px #000}
.hr-loot .hr-loot-slot .hr-item .ini{font-weight:600;font-size:13px;color:var(--tint,#b9c0d0)}
.hr-loot .hr-coin-ico{font-size:20px;color:#e8c070;cursor:default}
.hr-loot .hr-loot-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.hr-loot .hr-loot-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hr-loot .hr-loot-room{font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.hr-loot .hr-loot-full .hr-loot-room{color:#ff8a78}.hr-loot .hr-loot-partial .hr-loot-room{color:#e8c070}
.hr-loot .hr-loot-full .hr-loot-slot{opacity:.6}
.hr-loot .hr-loot-take,.hr-loot .hr-loot-all,.hr-loot .hr-loot-done{flex:none;min-width:72px;cursor:pointer}
.hr-loot .hr-loot-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}
.hr-loot .hr-loot-timer{font-size:11px;opacity:.75;font-variant-numeric:tabular-nums}
.hr-loot .hr-loot-status{margin:8px 0 0;color:#ff9b8a}
.hr-loot .hr-loot-empty{opacity:.7;margin:6px 0}
.hr-loot.hr-loot .hr-roll-stack{position:fixed;left:50%;bottom:calc(24% + 80px);transform:translateX(-50%);display:flex;flex-direction:column-reverse;gap:40px;width:330px;max-width:calc(100vw - 32px)}
@media(max-width:1000px){.hr-loot.hr-loot .hr-roll-stack{left:16px;transform:none;bottom:16px}}
.hr-loot.hr-loot.hr-loot .hr-roll,.hr-loot.hr-loot.hr-loot .hr-roll-log{pointer-events:auto;position:relative;isolation:isolate;left:auto;top:auto;transform:none;width:auto;min-width:0;max-width:none;box-sizing:border-box}
.hr-loot .hr-roll-top{display:flex;align-items:center;gap:10px}
.hr-loot .hr-roll-from{font-size:11px;opacity:.75;text-transform:capitalize}
.hr-loot .hr-roll-bar{height:4px;margin:8px 0 6px;background:rgba(255,255,255,.12)}
.hr-loot .hr-roll-fill{height:100%;background:#e8c070}
.hr-loot .hr-roll-buttons{display:flex;align-items:center;gap:6px}
.hr-loot .hr-roll-buttons button{flex:none;min-width:62px;cursor:pointer}
.hr-loot .hr-roll-left{margin-left:auto;font-size:11px;opacity:.75;font-variant-numeric:tabular-nums}
.hr-loot .hr-roll-log{font-size:11px}
.hr-loot .hr-roll-line{padding:2px 0}
.hr-loot .hr-tip{position:fixed;z-index:80;max-width:260px;padding:8px 10px;pointer-events:none;font-size:11px}
.hr-loot:not(.mmo-screen) .hr-tip{background:rgba(13,16,22,.96);border:1px solid #2a3040}
.hr-loot .hr-tip .nm{font-size:13px}.hr-loot .hr-tip .meta{opacity:.7;margin-bottom:4px}.hr-loot .hr-tip .mods{color:#8fc27a}.hr-loot .hr-tip .req{color:#ffb454}
.hr-loot .hr-tip .desc{margin-top:4px;font-style:italic;opacity:.85}.hr-loot .hr-broken-line{color:#ff6b5a}.hr-loot .hr-wear-line{opacity:.75}
.hr-loot .hr-tip .soulbound{color:#c9a7ff;letter-spacing:.04em}.hr-loot .hr-tip .entrusted{color:#e8c66a;letter-spacing:.04em}
.hr-loot .hr-skill-icon{width:20px;height:20px;vertical-align:-5px;margin-right:6px;image-rendering:pixelated}
.hr-loot [hidden]{display:none!important}
`;
