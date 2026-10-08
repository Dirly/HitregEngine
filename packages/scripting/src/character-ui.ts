import {
  ATTRIBUTES,
  CHARACTER_EVENTS,
  DERIVED_STATS,
  EQUIPMENT_SLOTS,
  derivedStats,
  firstFit,
  RARITY_TINT,
  currentDurability,
  formatCoins,
  slotKind,
  soulStatus,
  twoHanderOf,
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
 * Stashes (a bank vault, later a guild bank or a mailbox) dock beside the
 * bags: another script dispatches `hitreg:inventory-stash` on window with a
 * {@link StashLink} (or `{ owner, closed: true }`). While one is linked the
 * screen opens as a bags-only window next to it (no scrim, no keyboard
 * capture); right-click or double-click a stack sends it across
 * (`quickMove`, shift = one), and dragging it onto an element marked
 * `data-drop="external"` fires a bubbling `hr-item-drop` DOM event there
 * with `{ uid, actorId }` — the stash decides what that means.
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
    modal: { default: true, description: "Show a scrim and capture gameplay keys while open. False creates a floating nonmodal window; text fields still own their input." },
    title: { default: "Character" },
    showDetails: { default: true, description: "Show a permanent selected-item column; false uses floating item tooltips only." },
    showSearch: { default: true, description: "Show the inventory text-search field." },
    equipmentSlots: { default: [...EQUIPMENT_SLOTS], description: "Ordered equipment slot ids to display. Existing occupied slots are always retained so gear cannot become inaccessible." },
    expandKinds: { default: true, description: "a listed slot also shows its numbered siblings right after it (trinket → trinket2, consumable → consumable2, consumable3)" },
    cssClass: { default: "", description: "Optional game skin class; styles stay owned by the project." },
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
  /** {@link lookSignature} of the sheet the portrait was cloned from. */
  private portraitLook = "";
  private cancelToast: (() => void) | null = null;
  private store!: SheetStoreLike;
  private actorId = "";
  private open = false;
  private dirty = false;
  private drag: DragState | null = null;
  private readonly offs: Array<() => void> = [];
  private catalog!: (id: string) => Item | undefined;
  private selectedUid = "";
  private search = "";
  private category = "all";
  private renderedContent = "";
  /** A linked stash (bank vault …): bags dock beside it and quick-move into it. */
  private stash: StashLink | null = null;
  /** The screen was opened by the stash, so it closes with it. */
  private openedByStash = false;

  override onStart(): void {
    if (typeof document === "undefined") return;
    this.store = sheetStoreOf(this.ctx);
    this.catalog = catalogOf(this.ctx);
    this.actorId = this.param<string>("actor") || this.ctx.localPlayer?.() || "";

    const root = document.createElement("div");
    root.className = "hr-char";
    const skin = this.param<string>("cssClass");
    if (/^[a-zA-Z][\w-]*$/.test(skin)) root.classList.add(skin);
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
    scrim.hidden = !this.param<boolean>("modal");
    scrim.addEventListener("pointerdown", () => this.setOpen(false));
    root.append(scrim);
    this.panel = el("div", "hr-panel");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", String(this.param<boolean>("modal")));
    this.panel.setAttribute("aria-label", this.param<string>("title"));
    this.body = el("div", "hr-body");
    this.panel.append(this.body);
    root.append(this.panel);
    this.tip = el("div", "hr-tip");
    this.tip.setAttribute("role", "tooltip");
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
      if (e.repeat) return;
      if (e.code === "Escape" && this.open) { e.preventDefault(); this.setOpen(false); return; }
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (e.code === this.param<string>("toggleKey")) {
        e.preventDefault();
        this.setOpen(!this.open);
      }
    };
    window.addEventListener("keydown", onKey);
    this.offs.push(() => window.removeEventListener("keydown", onKey));
    const resize = (): void => { if (this.open && !this.drag) this.render(); };
    window.addEventListener("resize", resize);
    this.offs.push(() => window.removeEventListener("resize", resize));
    const toggle = (): void => this.setOpen(!this.open);
    window.addEventListener("hitreg:character-toggle", toggle);
    this.offs.push(() => window.removeEventListener("hitreg:character-toggle", toggle));
    const onStash = (e: Event): void => this.linkStash((e as CustomEvent<StashLink | { owner: string; closed: true }>).detail);
    window.addEventListener("hitreg:inventory-stash", onStash);
    this.offs.push(() => window.removeEventListener("hitreg:inventory-stash", onStash));
    const onMove = (e: PointerEvent): void => this.dragMove(e);
    const onUp = (e: PointerEvent): void => this.dragEnd(e);
    const onCancel = (): void => this.cancelDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    this.offs.push(
      () => window.removeEventListener("pointermove", onMove),
      () => window.removeEventListener("pointerup", onUp),
      () => window.removeEventListener("pointercancel", onCancel),
    );

    this.offs.push(this.store.onChange((key) => {
      if (key === sheetKey(this.actorId)) this.dirty = true;
    }));
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
      const sheet = this.sheet();
      const signature = sheet ? JSON.stringify({ ...sheet, inventoryAction: undefined }) : "";
      const progress = this.body.querySelector<HTMLElement>(".hr-action");
      if (sheet && progress && signature === this.renderedContent) this.renderAction(progress, sheet);
      else this.render();
      // The portrait is a CLONE of the body taken when it mounted (plus copies of
      // the helm and pads): equipping while the screen is open changes the body
      // in the world, not the clone. Re-clone on a change of what is worn — by
      // now character-look has dressed the body (it reacts to the same change).
      if (this.portraitDispose && this.lookSignature(sheet) !== this.portraitLook) {
        this.portraitDispose();
        this.portraitDispose = null;
        this.mountPortrait();
      }
    }
  }

  /** What the portrait shows: the worn items and the build's looks. */
  private lookSignature(sheet: CharacterSheet | null): string {
    return sheet ? JSON.stringify([sheet.equipment, sheet.build?.appearance ?? null]) : "";
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

  private linkStash(detail: StashLink | { owner: string; closed: true } | null | undefined): void {
    if (!detail || !this.root) return;
    if ("closed" in detail) {
      if (this.stash?.owner !== detail.owner) return;
      this.stash = null;
      this.applyDock();
      if (this.openedByStash) this.setOpen(false);
      else if (this.open) this.render();
      this.openedByStash = false;
      return;
    }
    this.stash = detail;
    this.applyDock();
    if (!this.open) {
      this.openedByStash = true;
      this.setOpen(true);
    } else this.render();
  }

  /** Docked = a stash is linked: bags only, beside it, no scrim, the keyboard left alone. */
  private applyDock(): void {
    if (!this.root) return;
    const docked = !!this.stash;
    this.root.classList.toggle("hr-docked", docked);
    const scrim = this.root.querySelector<HTMLElement>(".hr-scrim");
    if (scrim) scrim.hidden = docked || !this.param<boolean>("modal");
    this.panel.setAttribute("aria-modal", String(!docked && this.param<boolean>("modal")));
    if (this.open) this.ctx.input.captureKeyboard?.(this.entityId, !docked && this.param<boolean>("modal"));
  }

  private setOpen(open: boolean): void {
    if (!this.root || open === this.open) return;
    this.open = open;
    if (!open) this.openedByStash = false;
    this.root.hidden = !open;
    window.dispatchEvent(new CustomEvent("hitreg:character-visibility", { detail: { open } }));
    this.ctx.input.captureKeyboard?.(this.entityId, open && !this.stash && this.param<boolean>("modal"));
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
    this.portraitLook = this.lookSignature(this.sheet());
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
    this.renderedContent = sheet ? JSON.stringify({ ...sheet, inventoryAction: undefined }) : "";
    const head = el("div", "hr-head");
    head.append(el("div", "hr-title", this.param<string>("title")));
    if (!sheet) {
      head.append(el("div", "hr-hint", "no character sheet — add a character-sheet script to the player"));
      this.panel.prepend(head);
      return;
    }
    const { derived, env } = this.derived(sheet);
    if (this.stash) {
      // docked beside a stash: the bags and the purse, nothing else
      head.querySelector(".hr-title")!.textContent = "Bags";
      head.append(el("div", "hr-purse", formatCoins(sheet.coins)));
      head.append(this.closeButton());
      this.panel.prepend(head);
      body.append(this.renderGrids(sheet, derived, env));
      return;
    }
    if (!this.selectedUid || !sheet.items[this.selectedUid]) this.selectedUid = Object.keys(sheet.items).find(uid => sheet.items[uid]?.container !== undefined) ?? "";

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
    head.append(this.closeButton());
    this.panel.prepend(head);

    const character = el("div", "hr-character-column");
    character.append(this.renderDoll(sheet), this.renderStats(sheet, derived));
    body.append(character, this.renderGrids(sheet, derived, env));
    if (this.param<boolean>("showDetails")) body.append(this.renderDetails(sheet, derived, env));
  }

  private closeButton(): HTMLButtonElement {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "hr-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close inventory");
    close.onclick = () => this.setOpen(false);
    return close;
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
      const pct = s === "crit" || s === "spellCrit" ? "%" : "";
      list.append(el("span", "", STAT_LABEL[s]), el("span", "", fmt(derived.stats[s]) + pct));
    }
    list.append(el("span", "", "weight"));
    list.append(
      el("span", derived.encumbrance > 1 ? "over" : "", `${fmt(derived.weight)} / ${fmt(derived.stats.capacity)} kg`),
    );
    list.append(el("span", "", "purse"), el("span", "hr-purse", formatCoins(sheet.coins)));
    section.append(list);
    return section;
  }

  private renderDoll(sheet: CharacterSheet): HTMLElement {
    const section = el("section", "hr-section");
    section.append(el("h4", "", "equipment"));
    const doll = el("div", "hr-doll");
    const portraitWrap = el("div", "hr-portrait-wrap");
    portraitWrap.style.gridColumn = "2";
    const requested = (this.param<string[]>("equipmentSlots") ?? [...EQUIPMENT_SLOTS]).filter(s => EQUIPMENT_SLOTS.includes(s as EquipmentSlot)) as EquipmentSlot[];
    // a listed slot brings its numbered siblings (trinket → trinket2, consumable → the whole belt)
    const listed = this.param<boolean>("expandKinds")
      ? requested.flatMap(s => EQUIPMENT_SLOTS.filter(o => o === s || (/\d$/.test(o) && slotKind(o) === s)))
      : requested;
    const slots = [...new Set([...listed, ...Object.keys(sheet.equipment)])] as EquipmentSlot[];
    const rows = Math.ceil(slots.length / 2);
    portraitWrap.style.gridRow = `1 / ${rows + 1}`;
    portraitWrap.append(this.portrait);
    doll.append(portraitWrap);
    for (const [i, slot] of slots.entries()) {
      const col = i < rows ? 1 : 3;
      const row = i % rows + 1;
      const cellEl = el("div", "hr-slot");
      cellEl.style.gridColumn = String(col);
      cellEl.style.gridRow = String(row);
      cellEl.dataset["drop"] = "slot";
      cellEl.dataset["slot"] = slot;
      cellEl.append(el("div", "lbl", slotKind(slot)));
      cellEl.title = slotKind(slot);
      const uid = sheet.equipment[slot];
      // a soulbound slot: a rune, solid while it holds the item attuned to it (protected), hollow and struck through
      // while something else is worn there (not protected) — shape and words, never colour alone
      const attuned = sheet.soulslots?.[slot];
      if (attuned !== undefined) {
        const holds = !!uid && attuned === uid;
        const rune = el("span", `hr-soul${holds ? "" : " hr-soul-off"}`, holds ? "◆" : "◇");
        rune.setAttribute("aria-label", holds ? "soulbound: protected" : "soulbound slot: not protecting this item");
        cellEl.append(rune);
        cellEl.title = `${slotKind(slot)} — ${holds ? "soulbound: what you wear here cannot be looted from you" : "soulbound slot, attuned to another item: this one is NOT protected until a soul binder attunes it"}`;
      }
      const stack = uid ? sheet.items[uid] : undefined;
      if (uid && stack) {
        const item = this.catalog(stack.itemId);
        const itemEl = this.renderItem(uid, stack.qty, item, stack.itemId);
        itemEl.style.inset = "0";
        itemEl.dataset["slot"] = slot;
        itemEl.addEventListener("dblclick", () => this.emit(CHARACTER_EVENTS.unequip, { slot }));
        cellEl.append(itemEl);
      }
      // a two-hander fills the off hand too: the slot goes grey, marked "2H"
      // (never colour alone). A worn off-hand item stays in it, inactive; an
      // empty slot shows the two-hander ghosted.
      const twoHander = slot === "offhand" ? twoHanderOf(sheet, { catalog: this.catalog }) : null;
      if (twoHander) {
        cellEl.classList.add("hr-blocked");
        cellEl.title = stack
          ? `${twoHander.name} is held in both hands — inactive until it is put away`
          : `${twoHander.name} is held in both hands`;
        if (!stack) {
          const ghost = el("div", "hr-item hr-ghosted");
          ghost.style.inset = "0";
          const url = twoHander.icon ? this.iconUrl(twoHander.icon) : undefined;
          if (url) {
            const img = document.createElement("img");
            img.src = url;
            img.alt = "";
            img.draggable = false;
            ghost.append(img);
          }
          cellEl.append(ghost);
        }
        cellEl.append(el("span", "hr-2h", "2H"));
      }
      doll.append(cellEl);
    }
    section.append(doll);
    return section;
  }

  private renderGrids(sheet: CharacterSheet, derived: DerivedSheet, env: SheetEnv): HTMLElement {
    const section = el("section", "hr-section");
    section.classList.add("hr-inventory-column");
    const filters = el("div", "hr-filters");
    for (const [id, label] of [["all", "All"], ["equipment", "Gear"], ["consumable", "Consumables"], ["material", "Materials"], ["quest", "Quest"]]) {
      const button = document.createElement("button");
      button.textContent = label!;
      button.className = id === this.category ? "active" : "";
      button.setAttribute("aria-pressed", String(id === this.category));
      button.onclick = () => { this.category = id!; this.render(); };
      filters.append(button);
    }
    const search = document.createElement("input");
    search.type = "search"; search.placeholder = "Search belongings…"; search.value = this.search;
    search.setAttribute("aria-label", "Search inventory");
    search.oninput = () => {
      this.search = search.value;
      for (const item of Array.from(section.querySelectorAll<HTMLElement>(".hr-grid .hr-item"))) {
        const uid = item.dataset["uid"]!;
        const def = this.catalog(sheet.items[uid]!.itemId);
        item.classList.toggle("hr-filtered", !this.matches(def));
      }
    };
    // docked beside a stash the bags stay plain, like a bank bag: no filters, no search
    if (!this.stash) {
      section.append(filters);
      if (this.param<boolean>("showSearch")) section.append(search);
    }
    const progress = el("div", "hr-action");
    progress.setAttribute("role", "progressbar"); progress.setAttribute("aria-label", "Inventory action");
    progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100");
    progress.append(el("i", ""), el("span", "")); section.append(progress);
    this.renderAction(progress, sheet);
    const grids: Array<[Container, GridSize | null]> = [
      ["bag", derived.grids.bag],
      ["pockets", derived.grids.pockets],
    ];
    const cell = this.cellPixels();
    const overflow = el("div", "hr-overflow");
    for (const [container, grid] of grids) {
      section.append(el("h4", "", grid ? `${container} ${grid.cols}×${grid.rows}` : `${container} — none worn`));
      if (!grid) continue;
      const gridEl = el("div", "hr-grid");
      gridEl.dataset["drop"] = "grid";
      gridEl.dataset["container"] = container;
      gridEl.dataset["cols"] = String(grid.cols);
      gridEl.dataset["rows"] = String(grid.rows);
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
        if ((stack.x ?? 0) >= grid.cols || (stack.y ?? 0) >= grid.rows) {
          itemEl.style.width = itemEl.style.height = `${cell}px`; itemEl.style.position = "relative";
          overflow.append(itemEl); continue;
        }
        itemEl.classList.toggle("hr-filtered", !this.matches(item));
        itemEl.style.left = `${(stack.x ?? 0) * cell}px`;
        itemEl.style.top = `${(stack.y ?? 0) * cell}px`;
        itemEl.style.width = `${cell}px`;
        itemEl.style.height = `${cell}px`;
        itemEl.addEventListener("dblclick", (e) => {
          if (this.stash) this.stash.quickMove(uid, e.shiftKey && stack.qty > 1 ? 1 : undefined);
          else if (item && item.slots.length > 0) this.emit(CHARACTER_EVENTS.equip, { uid });
        });
        itemEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          if (this.stash) return this.stash.quickMove(uid, e.shiftKey && stack.qty > 1 ? 1 : undefined);
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
    for (const [uid, stack] of Object.entries(sheet.items)) {
      if (stack.container !== "bag" || derived.grids.bag) continue;
      const itemEl = this.renderItem(uid, stack.qty, this.catalog(stack.itemId), stack.itemId);
      itemEl.style.width = itemEl.style.height = `${cell}px`; itemEl.style.position = "relative"; overflow.append(itemEl);
    }
    if (overflow.childElementCount) section.append(el("h4", "", "Overflow · drag to a free slot"), overflow);
    if (this.stash) section.append(el("p", "hr-hint hr-stash-hint", `Right-click or double-click: ${this.stash.label} · Shift: just one · Drag to place`));
    const trash = el("div", "hr-trash", "drop here to discard");
    trash.dataset["drop"] = "trash";
    section.append(trash);
    return section;
  }

  private matches(item: Item | undefined): boolean {
    return (!this.search || item?.name.toLowerCase().includes(this.search.toLowerCase()) === true) && (this.category === "all" || item?.kind === this.category);
  }

  private cellPixels(): number {
    return (this.root && Number.parseFloat(getComputedStyle(this.root).getPropertyValue("--hr-cell"))) || this.param<number>("cellSize");
  }

  private renderDetails(sheet: CharacterSheet, derived: DerivedSheet, env: SheetEnv): HTMLElement {
    const panel = el("section", "hr-details");
    const stack = sheet.items[this.selectedUid];
    const item = stack ? this.catalog(stack.itemId) : undefined;
    if (!stack || !item) {
      panel.append(el("h4", "", "Item details"), el("p", "hr-muted", "Select a belonging to inspect it."), el("p", "hr-muted", "Drag to move · Double-click to equip · Right-click to split"));
      return panel;
    }
    const url = item.icon ? this.iconUrl(item.icon) : undefined;
    if (url) { const img = document.createElement("img"); img.src = url; img.alt = item.name; panel.append(img); }
    const name = el("h3", "", item.name); name.style.color = item.tint ?? RARITY_TINT[item.rarity];
    panel.append(name, el("p", "hr-item-kind", `${item.rarity} · ${item.kind}`));
    for (const [key, value] of Object.entries(item.modifiers)) panel.append(el("p", "hr-modifier", `${value > 0 ? "+" : ""}${value} ${STAT_LABEL[key] ?? key}`));
    if (item.bag) panel.append(el("p", "", `${item.bag.cols * item.bag.rows} bag slots · ${item.bag.cols} × ${item.bag.rows}`));
    for (const line of skillLines(item, stack.twists)) panel.append(skillLine("p", "hr-skill", line, (icon) => this.iconUrl(icon)));
    panel.append(el("p", "hr-description", item.description || "A trusty companion on the road."), el("p", "hr-muted", `${item.weight} kg · ${stack.qty} owned${item.value > 0 ? ` · worth ${formatCoins(item.value)}` : ""}`));
    for (const [key, value] of Object.entries(item.requires)) panel.append(el("p", "hr-requirement", `Requires ${key} ${value}`));
    const wear = this.wearLine(item, this.selectedUid, "p");
    if (wear) panel.append(wear);
    const slot = EQUIPMENT_SLOTS.find(s => sheet.equipment[s] === this.selectedUid);
    const action = (label: string, run: () => void): void => {
      const b = document.createElement("button"); b.textContent = label; b.onclick = run; panel.append(b);
    };
    if (slot) action("Unequip", () => this.emit(CHARACTER_EVENTS.unequip, { slot }));
    else if (item.slots.length) action("Equip", () => this.emit(CHARACTER_EVENTS.equip, { uid: this.selectedUid }));
    action("Drop", () => this.emit(CHARACTER_EVENTS.drop, { uid: this.selectedUid }));
    if (stack.qty > 1 && !slot) action("Split stack", () => {
      const to = (derived.grids.bag && spotIn(sheet, "bag", env)) ?? spotIn(sheet, "pockets", env);
      if (to) this.emit(CHARACTER_EVENTS.split, { uid: this.selectedUid, qty: Math.floor(stack.qty / 2), to });
      else this.showToast("No room to split");
    });
    return panel;
  }

  private renderItem(uid: string, qty: number, item: Item | undefined, itemId: string): HTMLDivElement {
    const node = el("div", "hr-item");
    node.dataset["uid"] = uid;
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", item?.name ?? itemId);
    const select = (): void => {
      this.selectedUid = uid;
      const sheet = this.sheet();
      if (sheet) { const { derived, env } = this.derived(sheet); this.body.querySelector(".hr-details")?.replaceWith(this.renderDetails(sheet, derived, env)); }
      this.body.querySelectorAll(".hr-item.selected").forEach(e => e.classList.remove("selected"));
      node.classList.add("selected");
    };
    node.onclick = select;
    node.onkeydown = e => { if (e.code === "Enter" || e.code === "Space") { e.preventDefault(); select(); } };
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
    node.addEventListener("pointerenter", (e) => this.showTip(item, itemId, e, uid));
    const worn = item ? this.sheet()?.items[uid] : undefined;
    if (worn && currentDurability(worn, item) === 0) {
      node.classList.add("hr-broken");
      node.setAttribute("aria-label", `${item!.name} (broken)`);
    }
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

  /** "Durability 37 / 80", or "Broken · Durability 0 / 80 — no stats until repaired" (word, not just colour). */
  private wearLine(item: Item, uid: string, tag = "div"): HTMLElement | null {
    return wearLineOf(item, uid ? this.sheet()?.items[uid] : undefined, tag);
  }

  private showTip(item: Item | undefined, itemId: string, e: PointerEvent, uid = ""): void {
    const tip = this.tip;
    const sheet = this.sheet();
    fillItemTip(tip, item, itemId, uid ? sheet?.items[uid] : undefined, (i) => this.iconUrl(i), {
      soul: uid && sheet ? soulStatus(sheet, uid) : null,
    });
    if (this.drag?.moved) return;
    tip.append(el("div", "meta", this.stash ? `Right-click: ${this.stash.label} · Drag to move` : "Drag to move · Double-click to equip / unequip · Right-click to split"));
    tip.hidden = false;
    this.placeTip(e);
  }

  private placeTip(e: PointerEvent): void {
    if (this.tip.hidden) return;
    const pad = 14;
    const r = this.tip.getBoundingClientRect();
    const x = Math.max(4, Math.min(e.clientX + pad, window.innerWidth - r.width - 4));
    const y = Math.max(4, Math.min(e.clientY + pad, window.innerHeight - r.height - 4));
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }

  // -- drag and drop ---------------------------------------------------------------

  private dragStart(e: PointerEvent, node: HTMLDivElement, uid: string): void {
    if (e.button !== 0 || this.drag) return;
    if (this.sheet()?.inventoryAction) { this.showToast("Finish the current inventory action first"); return; }
    e.preventDefault();
    const rect = node.getBoundingClientRect();
    const ghost = node.cloneNode(true) as HTMLDivElement;
    ghost.classList.add("hr-ghost");
    ghost.style.inset = "";
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.display = "none";
    // Keep the ghost in the inventory's stacking context, above its raised panel.
    this.root!.append(ghost);
    this.tip.hidden = true;
    this.drag = {
      uid,
      fromSlot: (node.dataset["slot"] as EquipmentSlot | undefined) ?? null,
      node,
      ghost,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      over: null,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  }

  private renderAction(progress: HTMLElement, sheet: CharacterSheet): void {
    const action = sheet.inventoryAction;
    progress.hidden = !action;
    if (!action) return;
    const pct = Math.max(0, Math.min(100, (1 - action.remaining / action.duration) * 100));
    progress.setAttribute("aria-valuenow", String(Math.round(pct)));
    progress.querySelector<HTMLElement>("i")!.style.width = `${pct}%`;
    const label = action.command.kind === "equip" ? "Equipping" : action.command.kind === "unequip" ? "Unequipping" : "Transferring";
    const item = sheet.items[action.command.uid];
    progress.querySelector("span")!.textContent = `${label} ${item ? this.catalog(item.itemId)?.name ?? item.itemId : "item"} · ${action.remaining.toFixed(1)}s`;
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    d.moved = true;
    d.ghost.style.display = "";
    d.node.classList.add("lifted");
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
    if (!target || !d.moved) return;
    if (target.kind === "external") {
      target.el.dispatchEvent(new CustomEvent("hr-item-drop", { bubbles: true, detail: { uid: d.uid, actorId: this.actorId, fromSlot: d.fromSlot } }));
    } else if (target.kind === "trash") {
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
      if (kind === "external") return { kind, el: node };
      if (kind === "slot") return { kind, el: node, slot: node.dataset["slot"] as EquipmentSlot };
      if (kind === "grid") {
        const cell = this.cellPixels();
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
  startX: number;
  startY: number;
  moved: boolean;
  uid: string;
  fromSlot: EquipmentSlot | null;
  node: HTMLDivElement;
  ghost: HTMLDivElement;
  grabX: number;
  grabY: number;
  over: HTMLElement | null;
}

/** What a stash script hands the bags through `hitreg:inventory-stash`. */
export interface StashLink {
  /** Who linked it — only the same owner can unlink. */
  owner: string;
  /** Verb for the hints, e.g. "store in the vault". */
  label: string;
  /** Send a carried stack across (`qty` undefined = the whole stack). */
  quickMove(uid: string, qty?: number): void;
}

type DropTarget =
  | { kind: "trash"; el: HTMLElement }
  | { kind: "external"; el: HTMLElement }
  | { kind: "slot"; el: HTMLElement; slot: EquipmentSlot }
  | { kind: "grid"; el: HTMLElement; to: { container: Container; x: number; y: number } };

function spotIn(sheet: CharacterSheet, container: Container, env: SheetEnv) {
  const cell = firstFit(sheet, container, env);
  return cell ? { container, ...cell } : null;
}

/** "Durability 37 / 80", or "Broken · Durability 0 / 80 — no stats until repaired", for one instance (or the item's maximum without one). */
function wearLineOf(item: Item, stack: { durability?: number } | undefined, tag = "div"): HTMLElement | null {
  const cur = stack ? currentDurability(stack, item) : item.durability ?? null;
  if (cur === null || item.durability === undefined) return null;
  if (cur === 0) return el(tag, "hr-broken-line", `Broken · Durability 0 / ${item.durability} — no stats until repaired`);
  return el(tag, "hr-wear-line", `Durability ${cur} / ${item.durability}`);
}

/**
 * The inventory's item tooltip, for any window that shows an item INSTANCE
 * (the bags, a loot bag, a vault): name in its rarity tint, rarity · kind ·
 * weight, modifiers, requirements, the skills it puts on the bar as THIS
 * instance casts them (its rolled twists), its wear, its description. Replaces
 * `tip`'s children; the caller adds its own hint line and shows it.
 */
export function fillItemTip(
  tip: HTMLElement,
  item: Item | undefined,
  itemId: string,
  stack: { durability?: number; twists?: string[] } | undefined,
  iconUrl: (icon: string) => string | undefined,
  extra: { soul?: { slot: string; state: "protected" | "swapped" | "carried" } | null } = {},
): void {
  tip.replaceChildren();
  if (!item) {
    tip.append(el("div", "nm", itemId), el("div", "req", "unknown item — no assets/items file"));
    return;
  }
  const nm = el("div", "nm", item.name);
  nm.style.color = item.tint ?? RARITY_TINT[item.rarity];
  tip.append(nm);
  // its soulbound slot (core soulStatus), in words: protected only while worn in the slot attuned to it
  const soul = extra.soul;
  if (soul?.state === "protected") tip.append(el("div", "soulbound", `◆ Soulbound (${soul.slot}) — cannot be looted from you while worn there`));
  else if (soul?.state === "swapped") tip.append(el("div", "soulbound hr-soul-off", `◇ In a soulbound slot (${soul.slot}), but NOT protected — attune it at a soul binder`));
  else if (soul?.state === "carried") tip.append(el("div", "soulbound hr-soul-off", `◇ Attuned to your ${soul.slot} slot — protected only while worn there`));
  // entrusted to its holder by a quest (item `entrusted`)
  if (item.entrusted) tip.append(el("div", "entrusted", "Entrusted — cannot be traded, dropped, stored, sold or looted; you keep it if you fall"));
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
  // the skills it puts on the bar, named and explained when the game says how
  // ...as THIS instance casts them (its rolled twists, which only the game can read)
  const twists = stack?.twists;
  for (const id of item.skills?.bar.slice(0, item.twoHanded ? 2 : 1) ?? []) {
    const icon = skillIconOf(id, twists);
    tip.append(skillLine("div", "skill", { text: skillLabel(id, true, twists), ...(icon ? { icon } : {}) }, iconUrl));
  }
  const wear = wearLineOf(item, stack);
  if (wear) tip.append(wear);
  if (item.description) tip.append(el("div", "desc", item.description));
}

function el(tag: string, className: string, text?: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * How a GAME names and explains its ability ids, for the item panels. The
 * ids are opaque to the engine; a game registers this once (its HUD script)
 * and the panels show "Name — what it does" instead of the bare id.
 * `twists` are the item INSTANCE's rolled twists (its stack's `twists`,
 * opaque here too): a game that rolls them names and explains the skill as
 * that instance casts it. `icon` (optional) is a texture path the panels
 * draw beside the line. Reserved `@` verbs (a guard) are asked too; a game
 * that returns null for one leaves its id as it is.
 */
export type SkillDescriber = (abilityId: string, twists?: readonly string[]) => { name: string; text: string; icon?: string } | null;
let skillDescriber: SkillDescriber | null = null;

/** Register (or with null, clear) the game's skill describer for every character-ui panel. */
export function setSkillDescriber(fn: SkillDescriber | null): void {
  skillDescriber = fn;
}

/** An ability id as a game describes it: "Name — text", or the id itself. */
function skillLabel(id: string, long: boolean, twists?: readonly string[]): string {
  const d = skillDescriber?.(id, twists);
  if (!d) return id;
  return long && d.text ? `${d.name} — ${d.text}` : d.name;
}

/** The icon a game gives an ability id, if any (a texture path). */
function skillIconOf(id: string, twists?: readonly string[]): string | undefined {
  return skillDescriber?.(id, twists)?.icon;
}

/** One item-panel line, with the skill's icon in front when the game gives one. */
function skillLine(tag: string, cls: string, line: { text: string; icon?: string }, url: (icon: string) => string | undefined): HTMLElement {
  const p = el(tag, cls, line.text);
  const src = line.icon ? url(line.icon) : undefined;
  if (src) {
    const img = document.createElement("img");
    img.className = "hr-skill-icon";
    img.src = src;
    img.alt = "";
    p.prepend(img);
  }
  return p;
}

/**
 * The verbs an item carries (`skills`), one line each. Ability ids are the
 * game's: named and explained by the game's `setSkillDescriber`, or shown as
 * they are without one.
 */
function skillLines(item: Item, twists?: readonly string[]): Array<{ text: string; icon?: string }> {
  const s = item.skills;
  const out: Array<{ text: string; icon?: string }> = [];
  const line = (label: string, id: string, long: boolean): { text: string; icon?: string } => {
    const icon = skillIconOf(id, twists);
    return { text: `${label}: ${skillLabel(id, long, twists)}`, ...(icon ? { icon } : {}) };
  };
  if (s) {
    if (s.primary) out.push(line("Left click", s.primary, false));
    if (s.secondary) out.push(line("Right click", s.secondary, false));
    const allowed = item.twoHanded ? 2 : 1;
    for (const id of s.bar.slice(0, allowed)) out.push(line("Skill", id, true));
    if (s.use) out.push({ text: `Use: ${s.use}` });
    const g = s.guard;
    if (g && g.kind !== "none") {
      const bits: string[] = [g.kind];
      if (g.school) bits.push(`${g.school} ward`);
      if (g.wardAlly) bits.push("can be thrown on an ally");
      if (g.reward) bits.push(`perfect: ${g.reward}`);
      if (g.blockPower !== undefined) bits.push(`absorbs ${Math.round(g.blockPower * 100)}%`);
      if (g.parryWindow !== undefined) bits.push(`parry window ${g.parryWindow}s`);
      out.push({ text: `Guard: ${bits.join(" · ")}` });
    }
  }
  if (item.equipSeconds !== undefined) out.push({ text: `Takes ${item.equipSeconds}s to put on` });
  return out;
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
  crit: "crit",
  spellCrit: "spell crit",
  ...Object.fromEntries(ATTRIBUTES.map((a) => [a, a])),
};

const CSS = `
.hr-char .hr-details{min-width:180px;max-width:260px;padding:12px;background:#10131a;border:1px solid #39425a}
.hr-char .hr-skill-icon{width:20px;height:20px;vertical-align:-5px;margin-right:6px;image-rendering:pixelated}
.hr-char .hr-details>img{display:block;width:64px;height:80px;object-fit:contain;margin:12px auto;image-rendering:pixelated}
.hr-char .hr-details button,.hr-char .hr-filters button,.hr-char .hr-close{font:inherit;color:inherit;background:#202735;border:1px solid #45516a;padding:7px 10px;cursor:pointer}
.hr-char .hr-details button{margin:4px}.hr-char .hr-filters{display:flex;gap:3px;margin-bottom:9px}.hr-char .hr-filters .active{background:#453627}
.hr-char .hr-inventory-column input{width:100%;box-sizing:border-box;margin-bottom:12px;background:#10131a;border:1px solid #39425a;color:inherit;padding:8px;font:inherit}
.hr-char .hr-filtered{opacity:.18;pointer-events:none}.hr-char .hr-item.selected{box-shadow:inset 0 0 0 2px #ffd57b}
.hr-char .hr-muted{color:#aaa397}.hr-char .hr-description{font-style:italic;line-height:1.6}.hr-char .hr-modifier{color:#9cb58b}
.hr-char :focus-visible{outline:2px solid #eed399;outline-offset:2px}
.hr-char .hr-character-column>.hr-section+section{margin-top:12px}
@media(max-width:800px){.hr-char .hr-body{grid-template-columns:auto auto}.hr-char .hr-details{grid-column:1/-1;max-width:none}.hr-char .hr-head{min-width:0;flex-wrap:wrap}}
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
.hr-char .hr-body{display:grid;grid-template-columns:auto auto 220px;gap:18px;align-items:start}
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
.hr-char .hr-slot.hr-blocked .hr-item{opacity:.35;filter:grayscale(1)}.hr-char .hr-item.hr-ghosted{pointer-events:none}
.hr-char .hr-slot .hr-2h{position:absolute;right:2px;bottom:1px;font-size:8px;font-weight:700;letter-spacing:.04em;color:#9aa3b5;pointer-events:none}
.hr-char .hr-grid{position:relative}
.hr-char .hr-overflow{display:flex;flex-wrap:wrap;gap:4px}
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
.hr-char .hr-broken-line{color:#ff6b5a;font-weight:600}.hr-char .hr-wear-line{color:#8b93a7}
.hr-char .hr-tip .soulbound{color:#c9a7ff;letter-spacing:.04em}.hr-char .hr-tip .soulbound.hr-soul-off{color:#a59bb8;font-style:italic}
.hr-char .hr-tip .entrusted{color:#e8c66a;letter-spacing:.04em}
.hr-char .hr-slot .hr-soul{position:absolute;left:-6px;top:-6px;width:18px;height:18px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
  font-size:13px;line-height:1;color:#c9a7ff;background:#140f1c;border:1px solid #c9a7ff;border-radius:50%;box-shadow:0 0 4px #000;pointer-events:none;z-index:3}
.hr-char .hr-slot .hr-soul.hr-soul-off{color:#a59bb8;border-style:dashed;border-color:#8d84a0;text-decoration:line-through}
.hr-char .hr-item.hr-broken{border-color:#ff5a5a;box-shadow:inset 0 0 0 1px #ff5a5a66}.hr-char .hr-item.hr-broken img{filter:sepia(.6) saturate(2.2) hue-rotate(-30deg) brightness(.8)}
.hr-char.hr-docked{pointer-events:none}
.hr-char.hr-docked .hr-panel{pointer-events:auto;left:calc(50% + 8px);top:50%;transform:translateY(-50%);max-width:calc(50vw - 16px)}
.hr-char.hr-docked .hr-head{min-width:0}
.hr-char.hr-docked .hr-body{grid-template-columns:auto}
.hr-char.hr-docked .hr-purse{margin-left:auto;color:#d8c38e;font-variant-numeric:tabular-nums}
.hr-char .hr-stash-hint{margin:8px 0 0;white-space:normal;max-width:360px}
@media(max-width:760px){.hr-char.hr-docked .hr-panel{left:50%;top:auto;bottom:8px;transform:translateX(-50%);max-width:96vw;max-height:48vh}}
.hr-char .hr-toast{position:fixed;left:50%;bottom:12%;transform:translateX(-50%);padding:6px 12px;background:rgba(80,20,20,.92);border:1px solid #ff5a5a;border-radius:6px;color:#ffd6d6;font-size:11px;z-index:85;pointer-events:none}
`;
