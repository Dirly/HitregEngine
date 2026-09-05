import {
  ATTRIBUTES,
  CHARACTER_EVENTS,
  DERIVED_STATS,
  derivedStats,
  firstFit,
  RARITY_TINT,
  slotKind,
  type Attribute,
  type CharacterSheet,
  type Container,
  type DerivedSheet,
  type EquipmentSlot,
  type GridSize,
  type Item,
  type SheetEnv,
} from "@hitreg/core";
import { Script } from "./script.js";
import { catalogOf, progressionOf, readSheet, sheetKey, sheetStoreOf, type SheetStoreLike } from "./character-store.js";

/**
 * The character screen: attributes and level on the left, a paper doll of
 * equipment slots around a live portrait of the character in the middle,
 * the grid inventory (bag + pockets) on the right. Press the toggle key
 * (default I) in play mode.
 *
 * It is a VIEW over netState: it reads `character/<bodyId>`, re-renders on
 * change, and every interaction is a request event — drag a stack onto a
 * cell → `inventory.move`; onto a slot → `inventory.equip`; a worn item onto
 * the grid → `inventory.unequip`; onto the drop zone → `inventory.drop`;
 * double-click → equip/unequip; right-click a stack → split it in half; the
 * "+" beside an attribute → `character.allocate`. The authority answers by
 * replicating the new sheet (or `character.refused`, which shows as a toast).
 * Nothing here ever writes the sheet, so the same script is correct on a
 * peer, a P2P host, and a client of a dedicated server.
 *
 * The portrait is the host's `ctx.renderPortrait` (a `@hitreg/render`
 * PortraitView): the body's runtime object cloned into a private scene,
 * looping its idle clip on its own mixer (`portraitClip`) regardless of what
 * the character is doing in the world. Mounted while the screen is open,
 * torn down when it closes.
 *
 * Skinning: panels, cells and slots are CSS 9-slices (`border-image`), fed by
 * two texture ids (`panelSkin`, `slotSkin`) plus their slice insets — drop a
 * PNG frame in assets/textures and name it, no code. Without a skin a
 * generated SVG frame stands in. Everything else is plain CSS under
 * `.hr-char`, meant to be overridden by a game's own stylesheet.
 *
 * While open, the script captures the keyboard (`ctx.input.captureKeyboard`)
 * so WASD and ability keys go nowhere, and exits pointer lock so the mouse
 * is usable. Presentation only — a dedicated server never instantiates it.
 */
export class CharacterUi extends Script {
  static override scriptName = "character-ui";
  /** Presentation only — the server's script filter skips it (see @hitreg/server). */
  static clientOnly = true;

  static override params = {
    actor: { default: "", description: "body whose sheet to show; empty = this tab's own player" },
    progression: {
      default: "",
      description:
        "progression data-asset id for stats when the sheet script has not published them yet; normally leave empty — grids and formulas come from the sheet's own publication",
    },
    toggleKey: { default: "KeyI", description: "KeyboardEvent.code that opens/closes the screen (Escape always closes)" },
    startOpen: { default: false },
    title: { default: "Character" },
    cellSize: { default: 44, min: 24, max: 96, description: "pixels per inventory cell and equipment slot" },
    portraitSpin: { default: 0, min: -3, max: 3, description: "turntable speed of the centre portrait, radians/second; 0 faces you" },
    portraitClip: {
      default: "Idle",
      description: "animation clip the portrait loops on its own mixer, whatever the character is doing in the world (falls back to any clip named *idle*, then the first clip)",
    },
    panelSkin: {
      default: "",
      description: "texture asset id of a 9-slice frame for the panel (assets/textures/…); empty = built-in dark frame",
    },
    panelSlice: { default: 16, min: 1, max: 128, description: "9-slice inset of the panel skin, in source pixels" },
    panelBorder: { default: 14, min: 1, max: 128, description: "how wide the panel frame draws on screen, in pixels" },
    slotSkin: { default: "", description: "texture asset id of a 9-slice frame for cells and equipment slots; empty = built-in" },
    slotSlice: { default: 6, min: 1, max: 64 },
    slotBorder: { default: 4, min: 1, max: 32 },
  };

  private root: HTMLDivElement | undefined;
  private panel!: HTMLDivElement;
  private body!: HTMLDivElement;
  private tip!: HTMLDivElement;
  private toast!: HTMLDivElement;
  private portrait!: HTMLCanvasElement;
  private portraitDispose: (() => void) | null = null;
  private cancelToast: (() => void) | null = null;
  private store!: SheetStoreLike;
  private actorId = "";
  private open = false;
  private dirty = false;
  private drag: DragState | null = null;
  private readonly offs: Array<() => void> = [];
  private catalog!: (id: string) => Item | undefined;

  override onStart(): void {
    if (typeof document === "undefined") return;
    this.store = sheetStoreOf(this.ctx);
    this.catalog = catalogOf(this.ctx);
    this.actorId = this.param<string>("actor") || this.ctx.localPlayer?.() || "";

    const root = document.createElement("div");
    root.className = "hr-char";
    root.hidden = true;
    root.innerHTML = `<style>${CSS}</style>`;
    const cell = this.param<number>("cellSize");
    root.style.setProperty("--hr-cell", `${cell}px`);
    root.style.setProperty("--hr-panel-img", this.frame("panelSkin", "#0f131b", "#39425a", 10));
    root.style.setProperty("--hr-panel-slice", String(this.param<number>("panelSlice")));
    root.style.setProperty("--hr-panel-border", `${this.param<number>("panelBorder")}px`);
    root.style.setProperty("--hr-slot-img", this.frame("slotSkin", "#151a24", "#2c3444", 4));
    root.style.setProperty("--hr-slot-slice", String(this.param<number>("slotSlice")));
    root.style.setProperty("--hr-slot-border", `${this.param<number>("slotBorder")}px`);

    const scrim = el("div", "hr-scrim");
    scrim.addEventListener("pointerdown", () => this.setOpen(false));
    root.append(scrim);
    this.panel = el("div", "hr-panel");
    this.body = el("div", "hr-body");
    this.panel.append(this.body);
    root.append(this.panel);
    this.tip = el("div", "hr-tip");
    this.tip.hidden = true;
    root.append(this.tip);
    this.toast = el("div", "hr-toast");
    this.toast.hidden = true;
    root.append(this.toast);
    // one canvas for the life of the screen — it is moved into each re-rendered
    // doll rather than recreated, so the portrait's GPU context survives
    this.portrait = document.createElement("canvas");
    this.portrait.className = "hr-portrait";
    document.body.append(root);
    this.root = root;

    const onKey = (e: KeyboardEvent): void => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.code === this.param<string>("toggleKey")) {
        e.preventDefault();
        this.setOpen(!this.open);
      } else if (e.code === "Escape" && this.open) {
        this.setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    this.offs.push(() => window.removeEventListener("keydown", onKey));
    const onMove = (e: PointerEvent): void => this.dragMove(e);
    const onUp = (e: PointerEvent): void => this.dragEnd(e);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    this.offs.push(
      () => window.removeEventListener("pointermove", onMove),
      () => window.removeEventListener("pointerup", onUp),
      () => window.removeEventListener("pointercancel", onUp),
    );

    this.store.onChange((key) => {
      if (key === sheetKey(this.actorId)) this.dirty = true;
    });
    this.ctx.events?.on(CHARACTER_EVENTS.refused, (payload) => {
      const p = payload as { actorId: string; error: string };
      if (p.actorId === this.actorId) this.showToast(p.error);
    });

    if (this.param<boolean>("startOpen")) this.setOpen(true);
  }

  override onFixedUpdate(): void {
    if (!this.root) return;
    if (!this.actorId) {
      this.actorId = this.param<string>("actor") || this.ctx.localPlayer?.() || "";
      if (!this.actorId) return;
      this.dirty = true;
    }
    if (this.dirty && this.open && !this.drag) {
      this.dirty = false;
      this.render();
    }
  }

  override onDispose(): void {
    this.setOpen(false);
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.drag?.ghost.remove();
    this.drag = null;
    this.root?.remove();
    this.root = undefined;
  }

  // -- state -------------------------------------------------------------------

  private setOpen(open: boolean): void {
    if (!this.root || open === this.open) return;
    this.open = open;
    this.root.hidden = !open;
    this.ctx.input.captureKeyboard?.(this.entityId, open);
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      this.render();
      this.mountPortrait();
    } else {
      this.tip.hidden = true;
      this.cancelDrag();
      this.portraitDispose?.();
      this.portraitDispose = null;
    }
  }

  private mountPortrait(): void {
    if (this.portraitDispose || !this.actorId) return;
    this.portraitDispose =
      this.ctx.renderPortrait?.(this.actorId, this.portrait, {
        spin: this.param<number>("portraitSpin"),
        clip: this.param<string>("portraitClip"),
      }) ?? null;
    this.portrait.classList.toggle("empty", this.portraitDispose === null);
  }

  private sheet(): CharacterSheet | null {
    return this.actorId ? readSheet(this.store, this.actorId) : null;
  }

  /** Derived stats: the sheet script's publication when it exists (it knows the real progression), else computed here. */
  private derived(sheet: CharacterSheet): { derived: DerivedSheet; env: SheetEnv } {
    const body = this.ctx.getObject(this.actorId);
    const published = body?.userData["character"] as DerivedSheet | undefined;
    const base = progressionOf(this.ctx, this.param<string>("progression"));
    const env: SheetEnv = {
      catalog: this.catalog,
      progression: published ? { ...base, pockets: published.grids.pockets } : base,
    };
    return { derived: published ?? derivedStats(sheet, env), env };
  }

  private emit(name: string, payload: Record<string, unknown>): void {
    this.ctx.events?.emit(name, { actorId: this.actorId, ...payload });
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.hidden = false;
    this.cancelToast?.();
    this.cancelToast = this.ctx.after(2.5, () => {
      this.toast.hidden = true;
      this.cancelToast = null;
    });
  }

  // -- rendering -----------------------------------------------------------------

  private render(): void {
    const body = this.body;
    body.replaceChildren();
    this.panel.querySelector(".hr-head")?.remove();
    const sheet = this.sheet();
    const head = el("div", "hr-head");
    head.append(el("div", "hr-title", this.param<string>("title")));
    if (!sheet) {
      head.append(el("div", "hr-hint", "no character sheet — add a character-sheet script to the player"));
      this.panel.prepend(head);
      return;
    }
    const { derived, env } = this.derived(sheet);

    head.append(el("div", "hr-level", `Lv ${sheet.level}`));
    const xp = el("div", "hr-xp");
    const fill = document.createElement("i");
    const span = derived.nextLevelXp === null ? 1 : Math.max(1, derived.nextLevelXp - derived.levelXp);
    const pct = derived.nextLevelXp === null ? 1 : Math.min(1, (sheet.xp - derived.levelXp) / span);
    fill.style.transform = `scaleX(${pct})`;
    xp.append(fill);
    xp.title =
      derived.nextLevelXp === null
        ? `${sheet.xp} xp (max level)`
        : `${sheet.xp - derived.levelXp} / ${span} xp to level ${sheet.level + 1}`;
    head.append(xp);
    head.append(el("div", "hr-hint", `${keyLabel(this.param<string>("toggleKey"))} / Esc to close`));
    this.panel.prepend(head);

    body.append(this.renderStats(sheet, derived), this.renderDoll(sheet), this.renderGrids(sheet, derived, env));
  }

  private renderStats(sheet: CharacterSheet, derived: DerivedSheet): HTMLElement {
    const section = el("section", "hr-section");
    section.append(el("h4", "", "attributes"));
    for (const a of ATTRIBUTES) {
      const row = el("div", "hr-attr");
      row.append(el("span", "", a));
      const value = el("b", "", String(derived.attributes[a]));
      const mod = derived.attributes[a] - sheet.attributes[a];
      if (mod !== 0) value.append(el("span", "mod", `${mod > 0 ? "+" : ""}${mod}`));
      row.append(value);
      const plus = document.createElement("button");
      plus.className = "hr-plus";
      plus.type = "button";
      plus.textContent = "+";
      plus.title = `spend a point on ${a}`;
      plus.disabled = sheet.unspent <= 0;
      plus.addEventListener("click", () => this.emit(CHARACTER_EVENTS.allocate, { attribute: a }));
      row.append(plus);
      section.append(row);
    }
    section.append(
      el("div", "hr-unspent", sheet.unspent > 0 ? `${sheet.unspent} point${sheet.unspent > 1 ? "s" : ""} to spend` : " "),
    );
    section.append(el("h4", "", "stats"));
    const list = el("div", "hr-derived");
    for (const s of DERIVED_STATS) {
      if (s === "capacity") continue;
      list.append(el("span", "", STAT_LABEL[s]), el("span", "", fmt(derived.stats[s])));
    }
    list.append(el("span", "", "weight"));
    list.append(
      el("span", derived.encumbrance > 1 ? "over" : "", `${fmt(derived.weight)} / ${fmt(derived.stats.capacity)} kg`),
    );
    section.append(list);
    return section;
  }

  private renderDoll(sheet: CharacterSheet): HTMLElement {
    const section = el("section", "hr-section");
    section.append(el("h4", "", "equipment"));
    const doll = el("div", "hr-doll");
    const portraitWrap = el("div", "hr-portrait-wrap");
    portraitWrap.style.gridColumn = "2";
    portraitWrap.style.gridRow = `1 / ${DOLL_ROWS + 1}`;
    portraitWrap.append(this.portrait);
    doll.append(portraitWrap);
    for (const [slot, [col, row]] of Object.entries(DOLL_LAYOUT) as Array<[EquipmentSlot, [number, number]]>) {
      const cellEl = el("div", "hr-slot");
      cellEl.style.gridColumn = String(col);
      cellEl.style.gridRow = String(row);
      cellEl.dataset["drop"] = "slot";
      cellEl.dataset["slot"] = slot;
      cellEl.append(el("div", "lbl", slotKind(slot)));
      const uid = sheet.equipment[slot];
      const stack = uid ? sheet.items[uid] : undefined;
      if (uid && stack) {
        const item = this.catalog(stack.itemId);
        const itemEl = this.renderItem(uid, stack.qty, item, stack.itemId);
        itemEl.style.inset = "0";
        itemEl.dataset["slot"] = slot;
        itemEl.addEventListener("dblclick", () => this.emit(CHARACTER_EVENTS.unequip, { slot }));
        cellEl.append(itemEl);
      }
      doll.append(cellEl);
    }
    section.append(doll);
    return section;
  }

  private renderGrids(sheet: CharacterSheet, derived: DerivedSheet, env: SheetEnv): HTMLElement {
    const section = el("section", "hr-section");
    const grids: Array<[Container, GridSize | null]> = [
      ["bag", derived.grids.bag],
      ["pockets", derived.grids.pockets],
    ];
    const cell = this.param<number>("cellSize");
    for (const [container, grid] of grids) {
      section.append(el("h4", "", grid ? `${container} ${grid.cols}×${grid.rows}` : `${container} — none worn`));
      if (!grid) continue;
      const gridEl = el("div", "hr-grid");
      gridEl.dataset["drop"] = "grid";
      gridEl.dataset["container"] = container;
      gridEl.style.width = `${grid.cols * cell}px`;
      gridEl.style.height = `${grid.rows * cell}px`;
      for (let y = 0; y < grid.rows; y++) {
        for (let x = 0; x < grid.cols; x++) {
          const c = el("div", "hr-cell");
          c.style.left = `${x * cell}px`;
          c.style.top = `${y * cell}px`;
          gridEl.append(c);
        }
      }
      for (const [uid, stack] of Object.entries(sheet.items)) {
        if (stack.container !== container) continue;
        const item = this.catalog(stack.itemId);
        const itemEl = this.renderItem(uid, stack.qty, item, stack.itemId);
        itemEl.style.left = `${(stack.x ?? 0) * cell}px`;
        itemEl.style.top = `${(stack.y ?? 0) * cell}px`;
        itemEl.style.width = `${cell}px`;
        itemEl.style.height = `${cell}px`;
        if (item && item.slots.length > 0) {
          itemEl.addEventListener("dblclick", () => this.emit(CHARACTER_EVENTS.equip, { uid }));
        }
        itemEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          if (stack.qty < 2 || !item) return;
          const half = Math.floor(stack.qty / 2);
          const to = (derived.grids.bag && spotIn(sheet, "bag", env)) ?? spotIn(sheet, "pockets", env);
          if (!to) return this.showToast("no room to split");
          this.emit(CHARACTER_EVENTS.split, { uid, qty: half, to });
        });
        gridEl.append(itemEl);
      }
      section.append(gridEl);
    }
    const trash = el("div", "hr-trash", "drop here to discard");
    trash.dataset["drop"] = "trash";
    section.append(trash);
    return section;
  }

  private renderItem(uid: string, qty: number, item: Item | undefined, itemId: string): HTMLDivElement {
    const node = el("div", "hr-item");
    node.dataset["uid"] = uid;
    const tint = item?.tint ?? (item ? RARITY_TINT[item.rarity] : "#ff5a5a");
    node.style.setProperty("--tint", tint);
    const url = item?.icon ? this.iconUrl(item.icon) : undefined;
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = item?.name ?? itemId;
      img.draggable = false;
      node.append(img);
    } else {
      node.append(el("span", "ini", initials(item?.name ?? itemId)));
    }
    if (qty > 1) node.append(el("span", "qty", String(qty)));
    node.addEventListener("pointerenter", (e) => this.showTip(item, itemId, e));
    node.addEventListener("pointermove", (e) => this.placeTip(e));
    node.addEventListener("pointerleave", () => (this.tip.hidden = true));
    node.addEventListener("pointerdown", (e) => this.dragStart(e, node, uid));
    return node;
  }

  private iconUrl(icon: string): string | undefined {
    if (/^(https?:|data:|blob:|\/)/.test(icon)) return icon;
    return this.ctx.textureUrl?.(icon);
  }

  // -- tooltip -----------------------------------------------------------------

  private showTip(item: Item | undefined, itemId: string, e: PointerEvent): void {
    const tip = this.tip;
    tip.replaceChildren();
    if (!item) {
      tip.append(el("div", "nm", itemId), el("div", "req", "unknown item — no assets/items file"));
    } else {
      const nm = el("div", "nm", item.name);
      nm.style.color = item.tint ?? RARITY_TINT[item.rarity];
      tip.append(nm);
      const meta = [item.rarity, item.kind, `${fmt(item.weight)} kg`];
      if (item.stack > 1) meta.push(`stacks to ${item.stack}`);
      if (item.slots.length > 0) meta.push(item.slots.join(" / "));
      if (item.bag) meta.push(`bag ${item.bag.cols}×${item.bag.rows}`);
      tip.append(el("div", "meta", meta.join(" · ")));
      const mods = Object.entries(item.modifiers).filter(([, v]) => v !== 0);
      if (mods.length > 0) {
        tip.append(
          el(
            "div",
            "mods",
            mods
              .map(([k, v]) => `${v > 0 ? "+" : ""}${v} ${STAT_LABEL[k as keyof typeof STAT_LABEL] ?? k}`)
              .join(", "),
          ),
        );
      }
      const req = Object.entries(item.requires).filter(([, v]) => v !== undefined);
      if (req.length > 0) tip.append(el("div", "req", "requires " + req.map(([k, v]) => `${k} ${v}`).join(", ")));
      if (item.description) tip.append(el("div", "desc", item.description));
    }
    tip.hidden = false;
    this.placeTip(e);
  }

  private placeTip(e: PointerEvent): void {
    if (this.tip.hidden) return;
    const pad = 14;
    const r = this.tip.getBoundingClientRect();
    const x = Math.min(e.clientX + pad, window.innerWidth - r.width - 4);
    const y = Math.min(e.clientY + pad, window.innerHeight - r.height - 4);
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }

  // -- drag and drop ---------------------------------------------------------------

  private dragStart(e: PointerEvent, node: HTMLDivElement, uid: string): void {
    if (e.button !== 0 || this.drag) return;
    e.preventDefault();
    const rect = node.getBoundingClientRect();
    const ghost = node.cloneNode(true) as HTMLDivElement;
    ghost.classList.add("hr-ghost");
    ghost.style.inset = "";
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.append(ghost);
    node.classList.add("lifted");
    this.tip.hidden = true;
    this.drag = {
      uid,
      fromSlot: (node.dataset["slot"] as EquipmentSlot | undefined) ?? null,
      node,
      ghost,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      over: null,
    };
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    d.ghost.style.left = `${e.clientX - d.grabX}px`;
    d.ghost.style.top = `${e.clientY - d.grabY}px`;
    const target = this.dropTarget(e);
    if (target?.el !== d.over) {
      d.over?.classList.remove("over");
      d.over = target?.el ?? null;
      d.over?.classList.add("over");
    }
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const target = this.dropTarget(e);
    this.cancelDrag();
    if (!target) return;
    if (target.kind === "trash") {
      this.emit(CHARACTER_EVENTS.drop, { uid: d.uid });
    } else if (target.kind === "slot") {
      this.emit(CHARACTER_EVENTS.equip, { uid: d.uid, slot: target.slot });
    } else if (d.fromSlot) {
      this.emit(CHARACTER_EVENTS.unequip, { slot: d.fromSlot, to: target.to });
    } else {
      this.emit(CHARACTER_EVENTS.move, { uid: d.uid, to: target.to });
    }
    // the reducer's answer arrives as a sheet change; until then show the old state
    this.dirty = true;
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    d.ghost.remove();
    d.node.classList.remove("lifted");
    d.over?.classList.remove("over");
    this.drag = null;
  }

  /** What is under the pointer: a grid cell, an equipment slot, or the trash. */
  private dropTarget(e: PointerEvent): DropTarget | null {
    const d = this.drag;
    if (!d) return null;
    for (const node of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (!(node instanceof HTMLElement)) continue;
      const kind = node.dataset["drop"];
      if (kind === "trash") return { kind, el: node };
      if (kind === "slot") return { kind, el: node, slot: node.dataset["slot"] as EquipmentSlot };
      if (kind === "grid") {
        const cell = this.param<number>("cellSize");
        const r = node.getBoundingClientRect();
        const cols = Math.round(r.width / cell);
        const rows = Math.round(r.height / cell);
        return {
          kind,
          el: node,
          to: {
            container: node.dataset["container"] as Container,
            x: Math.max(0, Math.min(cols - 1, Math.floor((e.clientX - r.left) / cell))),
            y: Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - r.top) / cell))),
          },
        };
      }
    }
    return null;
  }

  /** A 9-slice frame: the named texture, or a generated SVG stand-in. */
  private frame(param: "panelSkin" | "slotSkin", fill: string, stroke: string, radius: number): string {
    const id = this.param<string>(param);
    const url = id ? this.iconUrl(id) : undefined;
    if (url) return `url("${url}")`;
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'>` +
      `<rect x='1' y='1' width='46' height='46' rx='${radius}' fill='${fill}' stroke='${stroke}' stroke-width='1.5'/></svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  }
}

interface DragState {
  uid: string;
  fromSlot: EquipmentSlot | null;
  node: HTMLDivElement;
  ghost: HTMLDivElement;
  grabX: number;
  grabY: number;
  over: HTMLElement | null;
}

type DropTarget =
  | { kind: "trash"; el: HTMLElement }
  | { kind: "slot"; el: HTMLElement; slot: EquipmentSlot }
  | { kind: "grid"; el: HTMLElement; to: { container: Container; x: number; y: number } };

function spotIn(sheet: CharacterSheet, container: Container, env: SheetEnv) {
  const cell = firstFit(sheet, container, env);
  return cell ? { container, ...cell } : null;
}

function el(tag: string, className: string, text?: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function initials(name: string): string {
  return name
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function keyLabel(code: string): string {
  return code.replace(/^Key/, "").replace(/^Digit/, "");
}

const STAT_LABEL: Record<string, string> = {
  maxHp: "health",
  maxStamina: "stamina",
  maxMana: "mana",
  armor: "armor",
  capacity: "capacity",
  ...Object.fromEntries(ATTRIBUTES.map((a) => [a, a])),
};

/** Paper doll: [column, row] per slot — armour down the left, accessories down the right, the portrait between. */
const DOLL_ROWS = 6;
const DOLL_LAYOUT: Record<EquipmentSlot, [number, number]> = {
  helm: [1, 1],
  chest: [1, 2],
  gloves: [1, 3],
  legs: [1, 4],
  boots: [1, 5],
  primary: [1, 6],
  jewelry: [3, 1],
  trinket: [3, 2],
  trinket2: [3, 3],
  offhand: [3, 4],
  bag: [3, 5],
  secondary: [3, 6],
};

const CSS = `
.hr-char{position:fixed;inset:0;z-index:60;font:12px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#dfe3ec;-webkit-font-smoothing:antialiased;user-select:none}
.hr-char[hidden]{display:none}
.hr-char .hr-scrim{position:absolute;inset:0;background:rgba(4,6,10,.35)}
.hr-char .hr-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(96vw,1180px);max-height:92vh;overflow:auto;padding:8px 12px 12px;box-sizing:border-box;
  border:var(--hr-panel-border) solid transparent;border-image:var(--hr-panel-img) var(--hr-panel-slice) fill / var(--hr-panel-border) stretch}
.hr-char .hr-head{display:flex;align-items:center;gap:12px;margin-bottom:10px;min-width:520px}
.hr-char .hr-title{font-size:15px;font-weight:600;letter-spacing:.02em}
.hr-char .hr-level{font-size:11px;padding:2px 8px;border-radius:10px;background:#1d2330;color:#9fb3ff;white-space:nowrap}
.hr-char .hr-xp{flex:1;height:6px;background:#12151c;border-radius:3px;overflow:hidden;box-shadow:inset 0 0 0 1px #272c38}
.hr-char .hr-xp i{display:block;height:100%;background:#5b8cff;transform-origin:left center}
.hr-char .hr-hint{font-size:10px;color:#6d768c;white-space:nowrap}
.hr-char .hr-body{display:grid;grid-template-columns:200px auto auto;gap:18px;align-items:start}
.hr-char .hr-section h4{margin:10px 0 6px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8b93a7;font-weight:600}
.hr-char .hr-section h4:first-child{margin-top:0}
.hr-char .hr-attr{display:grid;grid-template-columns:1fr auto 22px;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #1c2130}
.hr-char .hr-attr b{font-weight:600;font-variant-numeric:tabular-nums}
.hr-char .hr-attr .mod{color:#5fd07a;font-size:10px;margin-left:4px;font-weight:400}
.hr-char .hr-plus{width:20px;height:20px;border:1px solid #3a4560;background:#1a2030;color:#cfe0ff;border-radius:4px;cursor:pointer;font-size:13px;line-height:18px;padding:0;font-family:inherit}
.hr-char .hr-plus:hover:not(:disabled){background:#26304a}
.hr-char .hr-plus:disabled{opacity:.25;cursor:default}
.hr-char .hr-unspent{margin:6px 0 4px;font-size:11px;color:#ffb454;min-height:14px}
.hr-char .hr-derived{display:grid;grid-template-columns:1fr auto;gap:3px 10px;font-variant-numeric:tabular-nums}
.hr-char .hr-derived span:nth-child(odd){color:#8b93a7}
.hr-char .hr-derived .over{color:#ff5a5a}
.hr-char .hr-doll{display:grid;grid-template-columns:var(--hr-cell) calc(var(--hr-cell) * 3.4) var(--hr-cell);grid-auto-rows:var(--hr-cell);gap:6px}
.hr-char .hr-portrait-wrap{position:relative;border-radius:6px;background:radial-gradient(ellipse at 50% 70%,rgba(91,140,255,.10),rgba(0,0,0,0) 70%),#0c1017;box-shadow:inset 0 0 0 1px #1c2130;overflow:hidden}
.hr-char .hr-portrait{position:absolute;inset:0;width:100%;height:100%;display:block}
.hr-char .hr-portrait.empty{background:repeating-linear-gradient(135deg,#0c1017 0 6px,#10151e 6px 12px)}
.hr-char .hr-slot{width:var(--hr-cell);height:var(--hr-cell);position:relative;box-sizing:border-box;
  border:var(--hr-slot-border) solid transparent;border-image:var(--hr-slot-img) var(--hr-slot-slice) fill / var(--hr-slot-border) stretch}
.hr-char .hr-slot .lbl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:2px;font-size:7px;line-height:1.1;letter-spacing:.04em;text-transform:uppercase;color:#4d566a;text-align:center;word-break:break-all;pointer-events:none}
.hr-char .hr-slot.over,.hr-char .hr-grid.over{filter:brightness(1.35)}
.hr-char .hr-grid{position:relative}
.hr-char .hr-cell{position:absolute;width:var(--hr-cell);height:var(--hr-cell);box-sizing:border-box;
  border:var(--hr-slot-border) solid transparent;border-image:var(--hr-slot-img) var(--hr-slot-slice) fill / var(--hr-slot-border) stretch}
.hr-char .hr-item,.hr-item.hr-ghost{position:absolute;box-sizing:border-box;border:1px solid var(--tint,#b9c0d0);border-radius:4px;
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(0,0,0,.28)),#1a1f2b;display:flex;align-items:center;justify-content:center;cursor:grab;overflow:hidden;touch-action:none}
.hr-char .hr-item img,.hr-ghost img{max-width:86%;max-height:86%;image-rendering:pixelated;pointer-events:none}
.hr-char .hr-item .ini,.hr-ghost .ini{font-weight:600;font-size:13px;color:var(--tint,#b9c0d0);pointer-events:none}
.hr-char .hr-item .qty,.hr-ghost .qty{position:absolute;right:3px;bottom:1px;font-size:10px;color:#e6e8ef;text-shadow:0 0 3px #000;pointer-events:none}
.hr-char .hr-item.lifted{opacity:.3}
.hr-item.hr-ghost{position:fixed;pointer-events:none;z-index:70;opacity:.92;cursor:grabbing;color:#dfe3ec;font:12px ui-sans-serif,system-ui,sans-serif}
.hr-char .hr-trash{margin-top:10px;height:34px;border:1px dashed #3a4050;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#6d768c;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.hr-char .hr-trash.over{border-color:#ff5a5a;color:#ff5a5a}
.hr-char .hr-tip{position:fixed;z-index:80;max-width:240px;padding:8px 10px;background:rgba(13,16,22,.96);border:1px solid #2a3040;border-radius:6px;pointer-events:none;font-size:11px}
.hr-char .hr-tip .nm{font-weight:600;font-size:12px}
.hr-char .hr-tip .meta{color:#8b93a7;margin-bottom:4px}
.hr-char .hr-tip .mods{color:#5fd07a}
.hr-char .hr-tip .req{color:#ffb454}
.hr-char .hr-tip .desc{color:#b9c0d0;margin-top:4px;font-style:italic}
.hr-char .hr-toast{position:fixed;left:50%;bottom:12%;transform:translateX(-50%);padding:6px 12px;background:rgba(80,20,20,.92);border:1px solid #ff5a5a;border-radius:6px;color:#ffd6d6;font-size:11px;z-index:85;pointer-events:none}
`;
