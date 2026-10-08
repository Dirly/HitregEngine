import {
  COPPER_PER_GOLD,
  COPPER_PER_SILVER,
  damagedItems,
  EQUIPMENT_SLOTS,
  formatCoins,
  type EquipmentSlot,
  INTERACT_RANGE,
  NPC_EVENTS,
  QUEST_EVENTS,
  RARITY_TINT,
  shopBuyPrice,
  shopSellPrice,
  type CharacterSheet,
  type Conversation,
  type Item,
  type Shop,
  type ShopState,
  type Vault,
  vaultUsed,
} from "@hitreg/core";
import { Script } from "./script.js";
import { catalogOf, readSheet, sheetStoreOf, type SheetStoreLike } from "./character-store.js";
import { presentFor } from "./presence.js";

interface Talker {
  id: string;
  name: string;
  title: string;
  radius: number;
  /** talk: an `npc`; read: an `npc` with readable: true; enter: a `portal`; use: any other `interactable` (player.interact). */
  kind: "talk" | "read" | "enter" | "use";
  /** A portal's own verb (its `prompt` param); absent = the kind's. */
  verb?: string;
}

/**
 * An interactable's visible bounds as offsets from its origin (world axes): the centre the
 * inspect hover aims at, the bounding-sphere radius that sizes the hit, and the top a thing's
 * icon sits on. Measured from its meshes' geometry boxes during the proximity scan, never per frame.
 */
export interface Extent {
  cx: number;
  cy: number;
  cz: number;
  r: number;
  top: number;
}

type Obj = import("three").Object3D;

/** An object's WORLD origin (its matrixWorld translation): an interactable parented under a POI root has a local `position` that says nothing about where it stands. */
function worldOrigin(o: Obj): { x: number; y: number; z: number } {
  const e = o.matrixWorld.elements;
  return { x: e[12]!, y: e[13]!, z: e[14]! };
}

/** World AABB of an object's visible, non-instanced meshes, relative to its world origin; null when it has none. */
export function extentOf(o: Obj): Extent | null {
  const wo = o.matrixWorld.elements;
  const bx = wo[12]!, by = wo[13]!, bz = wo[14]!;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const visit = (n: Obj): void => {
    if (!n.visible) return;
    const m = n as Obj & { isMesh?: boolean; isInstancedMesh?: boolean; geometry?: import("three").BufferGeometry };
    if (m.isMesh && !m.isInstancedMesh && m.geometry) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      if (b && b.min.x <= b.max.x) {
        const e = m.matrixWorld.elements;
        for (let i = 0; i < 8; i++) {
          const x = i & 1 ? b.max.x : b.min.x, y = i & 2 ? b.max.y : b.min.y, z = i & 4 ? b.max.z : b.min.z;
          const wx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
          const wy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
          const wz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
          if (wx < x0) x0 = wx;
          if (wx > x1) x1 = wx;
          if (wy < y0) y0 = wy;
          if (wy > y1) y1 = wy;
          if (wz < z0) z0 = wz;
          if (wz > z1) z1 = wz;
        }
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(o);
  if (!(x1 >= x0)) return null;
  const r = Math.max(0.05, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
  return { cx: (x0 + x1) / 2 - bx, cy: (y0 + y1) / 2 - by, cz: (z0 + z1) / 2 - bz, r, top: y1 - by };
}

/** Screen radius (px) within which the pointer hovers a thing of bounding radius `r` m at `distance` m. */
export function hitRadiusPx(r: number, distance: number): number {
  return Math.min(90, Math.max(24, (1400 * r) / Math.max(1, distance)));
}

/** Where the nameplates builtin hangs an NPC's tag above its origin (its `height` default). */
const PLATE_LIFT = 1.1;
/** Gap between the inspect icon and what it labels (DESIGN.md 4px base, 8px step). */
const ICON_GAP = 8;
/** A nameplate's stacked height in px (quest-mark slot + name + title), at the nameplate's own distance scale. */
export function plateHeightPx(distance: number, hasTitle: boolean): number {
  const scale = Math.max(0.7, Math.min(1.15, 9 / Math.max(distance, 1)));
  return (22 + 15 + (hasTitle && distance <= 14 ? 13 : 0)) * scale;
}

const VERB: Record<Talker["kind"], string> = { talk: "Talk to", read: "Read", enter: "Enter", use: "Use" };
const verbOf = (t: Talker): string => t.verb || VERB[t.kind];
/** 8×8 pixel glyphs (PSX-stepped, drawn crisp): a speech bubble, a page, an arched doorway, a hand. Shape carries the meaning, not colour. */
const GLYPH: Record<Talker["kind"], string> = {
  talk: "M1 1h6v4H4L2 7V5H1z",
  read: "M2 0h4l1 1v7H2zM3 2h3v1H3zM3 4h3v1H3z",
  enter: "M2 0h4l1 1h1v7H5V3H3v5H0V1h1z",
  use: "M3 0h1v4h1V1h1v4h1V2h1v4l-1 2H3L1 5h1l1 1z",
};

/**
 * The player's side of talking to townsfolk: a "[E] Talk" prompt near an
 * `interactable` NPC (one running the `npc` builtin), the conversation
 * (`dialogue/<bodyId>`, decided on the server), and the shop and vault
 * windows a conversation opens (shop, vault, repair). It never changes state itself — every click
 * is a request (`npc.choose`, `shop.buy`, `vault.deposit` …) the NPC's
 * authority re-checks.
 *
 * The vault is a bank window in the classic MMO shape: a grid of slots with
 * the character's bags docked beside it (it links itself to `character-ui`
 * through `hitreg:inventory-stash`). Drag between the two, or right-click /
 * double-click a stack to send it across (shift = just one); drag inside the
 * vault to rearrange it.
 *
 * Inspecting: hovering the mouse (or, while the mouse is captured, the screen
 * centre) over an `interactable` shows a small animated inspect icon with
 * what it does ("Talk to", "Read", "Use") — click it to act. Out of reach the
 * icon is muted and says "Too far"; nothing is sent. The keyboard path to the
 * same thing: `key` acts on the hovered one in reach, else the nearest. Any
 * `interactable` without an `npc` script is USED (`player.interact`, the
 * authority checks owner and range); a `presence` not there shows nothing.
 *
 * Keys: `key` (E) talks / uses / closes, 1–9 pick a line, Escape leaves. Walking away
 * ends the conversation (the server does it). Shift-click buys ten / sells a
 * whole stack.
 */
export class NpcUi extends Script {
  static override scriptName = "npc-ui";
  static clientOnly = true;
  static override params = {
    actor: { default: "", description: "body that talks; empty = this tab's own player" },
    key: { default: "KeyE", description: "KeyboardEvent.code that opens a conversation with the nearest NPC (and closes one)" },
    cssClass: { default: "", description: "optional game skin class on the root (.hr-npc); styles stay owned by the project" },
    panelSkin: { default: "", description: "texture asset id of a 9-slice frame for the panels; empty = built-in dark frame" },
    panelSlice: { default: 16, min: 1, max: 128 },
    panelBorder: { default: 14, min: 1, max: 128 },
    vaultColumns: { default: 8, min: 2, max: 20, description: "slots per row in the vault window" },
    cellSize: { default: 44, min: 24, max: 96, description: "pixels per vault slot (match character-ui's cellSize so the two windows line up)" },
  };

  private store!: SheetStoreLike;
  private catalog!: (id: string) => Item | undefined;
  private actor = "";
  private root: HTMLDivElement | undefined;
  private prompt!: HTMLDivElement;
  private talk!: HTMLDivElement;
  private service!: HTMLDivElement;
  private near: Talker | null = null;
  private scan = 0;
  private shown = "";
  /** The soul binder window's pending choice of slots (null = start from the sheet's). */
  private soulPick: EquipmentSlot[] | null = null;
  private soulPickFor = "";
  private offs: Array<() => void> = [];
  /** npc id of the vault currently linked to the bags, or "". */
  private stashFor = "";
  private tip!: HTMLDivElement;
  private drag: VaultDrag | null = null;
  private inspect!: HTMLDivElement;
  private pointer: { x: number; y: number } | null = null;
  private hover: { t: Talker; inRange: boolean } | null = null;
  private hoverShown = "";
  /** Interactables within inspecting distance (refreshed with the proximity scan). */
  private candidates: Talker[] = [];
  /** Measured visible bounds per interactable (absent/null = none known: origin + 1 m rule). */
  private extents = new Map<string, Extent | null>();
  private swallowMouse = false;

  override onStart(): void {
    if (typeof document === "undefined") return;
    this.store = sheetStoreOf(this.ctx);
    this.catalog = catalogOf(this.ctx);
    const root = el("div", "hr-npc");
    const skin = this.param<string>("cssClass");
    if (/^[a-zA-Z][\w-]*$/.test(skin)) root.classList.add(skin);
    root.innerHTML = `<style>${CSS}</style>`;
    root.style.setProperty("--hr-npc-panel", this.frame());
    root.style.setProperty("--hr-npc-slice", String(this.param<number>("panelSlice")));
    root.style.setProperty("--hr-npc-border", `${this.param<number>("panelBorder")}px`);
    this.prompt = el("div", "hr-npc-prompt");
    this.prompt.hidden = true;
    this.talk = el("div", "hr-npc-talk hr-npc-panel");
    this.talk.setAttribute("role", "dialog");
    this.talk.setAttribute("aria-live", "polite");
    this.talk.hidden = true;
    this.service = el("div", "hr-npc-service hr-npc-panel");
    this.service.hidden = true;
    root.style.setProperty("--hr-npc-cell", `${this.param<number>("cellSize")}px`);
    this.tip = el("div", "hr-npc-tip");
    this.tip.setAttribute("role", "tooltip");
    this.tip.hidden = true;
    this.inspect = el("div", "hr-npc-inspect");
    this.inspect.hidden = true;
    this.inspect.setAttribute("role", "status");
    root.append(this.prompt, this.service, this.talk, this.tip, this.inspect);
    document.body.append(root);
    this.root = root;

    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || isTyping(e.target)) return;
      const conv = this.conv();
      if (e.code === this.param<string>("key")) {
        const target = this.hover?.inRange ? this.hover.t : this.near;
        if (conv) this.leave(conv);
        else if (target) this.act(target);
        else return;
        e.preventDefault();
      } else if (e.code === "Escape" && conv) {
        this.leave(conv);
        e.preventDefault();
      } else if (conv && /^Digit[1-9]$/.test(e.code)) {
        const choice = conv.choices[Number(e.code.slice(5)) - 1];
        if (choice) {
          this.choose(conv, choice.index);
          e.preventDefault();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    this.offs.push(() => document.removeEventListener("keydown", onKey));
    this.offs.push(this.store.onChange(() => this.render()));
    const onMove = (e: PointerEvent): void => this.dragMove(e);
    const onUp = (e: PointerEvent): void => this.dragEnd(e);
    const onCancel = (): void => this.cancelDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    // inspecting: track the pointer; a click on a hovered interactable in reach acts on it and never reaches gameplay (no swing)
    const onPoint = (e: PointerEvent): void => void (this.pointer = { x: e.clientX, y: e.clientY });
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !this.hover?.inRange || this.conv() || !(e.target instanceof HTMLCanvasElement)) return;
      this.act(this.hover.t);
      this.swallowMouse = true;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (!this.swallowMouse) return;
      this.swallowMouse = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("pointermove", onPoint, { passive: true });
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    this.offs.push(
      () => window.removeEventListener("pointermove", onPoint),
      () => window.removeEventListener("pointerdown", onDown, true),
      () => window.removeEventListener("mousedown", onMouseDown, true),
    );
    this.offs.push(
      () => window.removeEventListener("pointermove", onMove),
      () => window.removeEventListener("pointerup", onUp),
      () => window.removeEventListener("pointercancel", onCancel),
    );
  }

  override onDispose(): void {
    this.linkStash("");
    this.cancelDrag();
    for (const off of this.offs) off();
    this.offs = [];
    this.root?.remove();
    this.root = undefined;
  }

  private me(): string {
    return this.actor || (this.actor = this.param<string>("actor") || this.ctx.localPlayer?.() || "");
  }

  private conv(): Conversation | null {
    const me = this.me();
    return me ? ((this.store.get(`dialogue/${me}`) as Conversation | undefined) ?? null) : null;
  }

  private leave(conv: Conversation): void {
    this.ctx.events?.emit(NPC_EVENTS.leave, { actorId: this.me(), npcId: conv.npc });
  }

  private choose(conv: Conversation, index: number): void {
    this.ctx.events?.emit(NPC_EVENTS.choose, { actorId: this.me(), npcId: conv.npc, node: conv.node, index });
  }

  /** What the player can do with an `interactable` entity, or null (not there for this player, or gone). */
  private talker(id: string): Talker | null {
    const doc = this.ctx.getEntity(id);
    if (!doc || !presentFor(this.ctx, this.store, id, this.me() || null)) return null;
    const script = doc.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
    if (script?.name === "portal") {
      const p = script.params ?? {};
      return {
        id,
        name: (p["name"] as string) || doc.name || id,
        title: "",
        radius: typeof p["radius"] === "number" ? p["radius"] : 3,
        kind: "enter",
        verb: typeof p["prompt"] === "string" && p["prompt"] ? p["prompt"] : "Enter",
      };
    }
    if (script?.name !== "npc") return { id, name: doc.name || id, title: "", radius: INTERACT_RANGE, kind: "use" };
    const p = script.params ?? {};
    return {
      id,
      name: (p["name"] as string) || doc.name || id,
      title: (p["title"] as string) || "",
      radius: typeof p["radius"] === "number" ? p["radius"] : 3.5,
      kind: p["readable"] === true ? "read" : "talk",
    };
  }

  /** Ask the authority: open the conversation (talk, read) or use the thing (player.interact). */
  private act(t: Talker): void {
    if (t.kind === "use" || t.kind === "enter") this.ctx.events?.emit(QUEST_EVENTS.interact, { actorId: this.me(), entityId: t.id });
    else this.ctx.events?.emit(NPC_EVENTS.talk, { actorId: this.me(), npcId: t.id });
  }

  /** The hovered interactable: nearest on screen to the pointer (the screen centre while the mouse is captured). */
  private updateHover(): void {
    const body = this.ctx.getObject(this.me());
    const project = this.ctx.worldToScreen;
    let best: { t: Talker; inRange: boolean; x: number; y: number; px: number } | null = null;
    if (body && project && !this.conv() && typeof document !== "undefined") {
      const locked = !!document.pointerLockElement;
      const aim = locked ? { x: innerWidth / 2, y: innerHeight / 2 } : this.pointer;
      if (aim) {
        for (const t of this.candidates) {
          const o = this.ctx.getObject(t.id);
          if (!o) continue;
          const p = worldOrigin(o);
          const ext = this.extents.get(t.id);
          const at = ext ? project(p.x + ext.cx, p.y + ext.cy, p.z + ext.cz) : project(p.x, p.y + 1, p.z);
          if (!at) continue;
          const px = Math.hypot(at.x - aim.x, at.y - aim.y);
          if (px > hitRadiusPx(ext ? ext.r : 1, at.distance)) continue;
          if (best && px >= best.px) continue;
          const d = Math.hypot(p.x - body.position.x, p.z - body.position.z);
          best = { t, inRange: d <= t.radius && Math.abs(p.y - body.position.y) < 4, x: at.x, y: at.y, px };
        }
        // anchor: an NPC's icon sits above its nameplate (both read); a thing's sits on top of the thing
        if (best) {
          const p = this.ctx.getObject(best.t.id)!.position;
          const ext = this.extents.get(best.t.id);
          const plate = best.t.kind !== "use" && best.t.kind !== "enter";
          const at = plate
            ? project(p.x, p.y + PLATE_LIFT, p.z)
            : project(p.x + (ext?.cx ?? 0), p.y + (ext ? ext.top : 1), p.z + (ext?.cz ?? 0));
          if (at) {
            best.x = at.x;
            best.y = at.y - ICON_GAP - (plate ? plateHeightPx(at.distance, !!best.t.title) : 0);
          }
        }
      }
    }
    this.hover = best ? { t: best.t, inRange: best.inRange } : null;
    const key = best ? `${best.t.id}|${best.inRange}` : "";
    if (key !== this.hoverShown) {
      this.hoverShown = key;
      this.inspect.hidden = !best;
      if (best) {
        const svg = `<svg viewBox="0 0 8 8" width="16" height="16" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="${GLYPH[best.t.kind]}"/></svg>`;
        this.inspect.className = `hr-npc-inspect ${best.inRange ? "live" : "far"}`;
        this.inspect.innerHTML = `<span class="hr-npc-glyph">${svg}</span>`;
        this.inspect.append(el("span", "", best.inRange ? `${verbOf(best.t)} ${best.t.name}` : `${best.t.name} · too far`));
        if (best.inRange) this.inspect.append(el("kbd", "", keyLabel(this.param<string>("key"))));
      }
    }
    if (best) this.inspect.style.transform = `translate(${Math.round(best.x)}px, ${Math.round(best.y)}px) translate(-50%, -100%)`;
  }

  override onLateUpdate(dt: number): void {
    if (!this.root) return;
    this.updateHover();
    this.scan += dt;
    if (this.scan < 0.15) return;
    this.scan = 0;
    const body = this.ctx.getObject(this.me());
    let best: Talker | null = null;
    let bestD = Infinity;
    this.candidates = [];
    if (body) {
      for (const id of this.ctx.findByTag("interactable")) {
        const t = this.talker(id);
        const o = this.ctx.getObject(id);
        if (!t || !o) continue;
        const p = worldOrigin(o);
        const d = Math.hypot(p.x - body.position.x, p.z - body.position.z);
        if (d <= 30) {
          this.candidates.push(t);
          // measured once; retried each scan while the model has not loaded (no meshes yet)
          if (!this.extents.get(id)) this.extents.set(id, extentOf(o));
        }
        if (d <= t.radius && d < bestD && Math.abs(p.y - body.position.y) < 4) {
          best = t;
          bestD = d;
        }
      }
    }
    if (this.extents.size > this.candidates.length + 64) {
      const keep = new Set(this.candidates.map((c) => c.id));
      for (const id of this.extents.keys()) if (!keep.has(id)) this.extents.delete(id);
    }
    if (best?.id !== this.near?.id) {
      this.near = best;
      this.render();
    }
  }

  // -- drawing --------------------------------------------------------------------------

  private render(): void {
    if (!this.root) return;
    const conv = this.conv();
    const me = this.me();
    const sheet = me ? readSheet(this.store, me) : null;
    this.linkStash(conv?.panel?.kind === "vault" ? conv.npc : "");
    const shopId = conv?.panel?.kind === "shop" ? conv.panel.shop : "";
    const key = JSON.stringify([
      conv,
      this.near?.id ?? "",
      conv?.panel ? sheet : null,
      shopId ? this.store.get(`shop/${shopId}`) : null,
      conv?.panel?.kind === "vault" ? this.store.get(`vault/${me}`) : null,
    ]);
    if (key === this.shown) return;
    this.shown = key;

    const key0 = keyLabel(this.param<string>("key"));
    this.prompt.hidden = !!conv || !this.near;
    if (this.near && !conv) {
      this.prompt.replaceChildren(el("kbd", "", key0), el("span", "", ` ${verbOf(this.near)} ${this.near.name}`));
      if (this.near.title) this.prompt.append(el("small", "", this.near.title));
    }

    // a service window replaces the conversation (its Close ends both)
    this.talk.hidden = !conv || !!conv.panel;
    this.service.hidden = !conv?.panel;
    this.service.classList.toggle("hr-npc-vault", conv?.panel?.kind === "vault");
    this.service.classList.toggle("hr-npc-repair", conv?.panel?.kind === "repair" || conv?.panel?.kind === "soulbind");
    if (conv?.panel?.kind !== "soulbind") this.soulPick = null; // a window opened again starts from the sheet
    this.tip.hidden = true; // its stack may be gone; pointerenter shows it again
    if (!conv) return;
    const who = this.talker(conv.npc);
    const head = el("header", "");
    head.append(el("h3", "", who?.name ?? conv.npc));
    if (who?.title) head.append(el("small", "", who.title));
    const text = el("p", "hr-npc-line", conv.text);
    const list = el("ol", "hr-npc-choices");
    conv.choices.forEach((c, i) => {
      const li = el("li", "");
      const b = button(`${i + 1}. ${c.text}`, () => this.choose(conv, c.index));
      li.append(b);
      list.append(li);
    });
    if (conv.choices.length === 0) {
      const li = el("li", "");
      li.append(button(`${key0}. Farewell.`, () => this.leave(conv)));
      list.append(li);
    }
    const parts: HTMLElement[] = [head, text];
    if (conv.notice) parts.push(el("p", "hr-npc-notice", conv.notice));
    parts.push(list);
    this.talk.replaceChildren(...parts);

    if (conv.panel?.kind === "shop") this.drawShop(conv, sheet);
    else if (conv.panel?.kind === "vault") this.drawVault(conv, sheet);
    else if (conv.panel?.kind === "repair") this.drawRepair(conv, sheet);
    else if (conv.panel?.kind === "soulbind") this.drawSoulbind(conv, sheet);
  }

  /**
   * The soul binder: every worn slot that may be soulbound, the ones chosen
   * marked with a rune AND the word (never colour alone), a pending choice the
   * player toggles here, and one Attune button priced by the rule the server
   * uses (a different set of slots costs the price; the same set is free).
   */
  private drawSoulbind(conv: Conversation, sheet: CharacterSheet | null): void {
    if (conv.panel?.kind !== "soulbind") return;
    const panel = conv.panel;
    const me = this.me();
    const current = (Object.keys(sheet?.soulslots ?? {}) as EquipmentSlot[]).sort();
    if (this.soulPickFor !== conv.npc || this.soulPick === null) {
      this.soulPick = [...current];
      this.soulPickFor = conv.npc;
    }
    const pick = this.soulPick;
    const col = el("section", "hr-npc-col");
    col.append(
      el(
        "p",
        "hr-npc-empty",
        `Choose up to ${panel.slots} slots. What you wear in a soulbound slot cannot be taken from you when you fall, as long as it stays worn there; put something else on and the slot protects nothing until you come back. Attuning the same slots again is free; changing which slots costs ${formatCoins(panel.price)}.`,
      ),
    );
    const slots = EQUIPMENT_SLOTS.filter((slot) => !panel.exclude.includes(slot) && sheet?.equipment[slot]);
    for (const slot of slots) {
      const uid = sheet!.equipment[slot]!;
      const stack = sheet!.items[uid];
      const attuned = sheet?.soulslots?.[slot];
      const chosen = pick.includes(slot);
      const state = attuned === undefined ? "" : attuned === uid ? "◆ soulbound" : "◇ soulbound to another item";
      const row = this.row(stack?.itemId ?? uid, 1, chosen ? "✓ chosen" : "", chosen ? "Unchoose" : "Choose", () => {
        const next = chosen ? pick.filter((s) => s !== slot) : [...pick, slot];
        if (next.length > panel.slots) return;
        this.soulPick = next;
        this.shown = "";
        this.render();
      }, !chosen && pick.length >= panel.slots);
      row.setAttribute("aria-pressed", String(chosen));
      row.classList.toggle("hr-npc-chosen", chosen);
      row.querySelector(".hr-npc-name")?.append(el("small", "hr-npc-wear", `${slot}${state ? ` · ${state}` : ""}`));
      col.append(row);
    }
    if (slots.length === 0) col.append(el("p", "hr-npc-empty", "You wear nothing that could be soulbound."));
    const after = [...pick].sort();
    const changed = current.length > 0 && (current.length !== after.length || current.some((s, i) => s !== after[i]));
    const cost = changed ? panel.price : 0;
    const coins = sheet?.coins ?? 0;
    const head = el("header", "");
    head.append(el("h3", "", "Soulbound slots"), button("Close", () => this.leave(conv)));
    const foot = el("footer", "");
    const go = button(`${after.length === 0 && current.length > 0 ? "Free all slots" : "Attune"} · ${cost > 0 ? formatCoins(cost) : "free"}`, () =>
      this.ctx.events?.emit(NPC_EVENTS.attune, { actorId: me, npcId: conv.npc, slots: after }),
    );
    go.disabled = coins < cost || (after.length === 0 && current.length === 0);
    foot.append(el("span", "hr-npc-coins", `Purse ${formatCoins(coins)} · ${after.length} / ${panel.slots} chosen`), go);
    const parts: HTMLElement[] = [head, col];
    if (conv.notice) parts.push(el("p", "hr-npc-notice", conv.notice));
    parts.push(foot);
    this.service.replaceChildren(...parts);
  }

  /** The repair bench: every damaged item (worn first) with its price, and Repair all. */
  private drawRepair(conv: Conversation, sheet: CharacterSheet | null): void {
    const rate = conv.panel?.kind === "repair" ? conv.panel.rate : 0.25;
    const me = this.me();
    const coins = sheet?.coins ?? 0;
    const list = sheet ? damagedItems(sheet, { catalog: this.catalog }, rate) : [];
    const col = el("section", "hr-npc-col");
    col.append(el("h4", "", "Needs mending"));
    for (const e of list) {
      const broken = e.current === 0;
      const state = `${broken ? "Broken · " : ""}${e.current} / ${e.max}${e.worn ? " · worn" : ""}`;
      const row = this.row(e.itemId, 1, formatCoins(e.cost), "Repair", () => this.ctx.events?.emit(NPC_EVENTS.repair, { actorId: me, npcId: conv.npc, uid: e.uid }), coins < e.cost);
      row.classList.toggle("hr-npc-broken", broken);
      row.querySelector(".hr-npc-name")?.append(el("small", "hr-npc-wear", state));
      row.setAttribute("aria-label", `${row.getAttribute("aria-label") ?? ""}, durability ${state}`);
      col.append(row);
    }
    if (list.length === 0) col.append(el("p", "hr-npc-empty", "Nothing you carry needs mending."));
    const total = list.reduce((n, e) => n + e.cost, 0);
    const head = el("header", "");
    head.append(el("h3", "", "Repairs"), button("Close", () => this.leave(conv)));
    const foot = el("footer", "");
    const all = button(`Repair all · ${formatCoins(total)}`, () => this.ctx.events?.emit(NPC_EVENTS.repairAll, { actorId: me, npcId: conv.npc }));
    all.disabled = list.length === 0 || coins < total;
    foot.append(el("span", "hr-npc-coins", `Purse ${formatCoins(coins)}`), all);
    const parts: HTMLElement[] = [head, col];
    if (conv.notice) parts.push(el("p", "hr-npc-notice", conv.notice));
    parts.push(foot);
    this.service.replaceChildren(...parts);
  }

  private icon(item: Item | undefined): HTMLElement {
    const box = el("span", "hr-npc-icon");
    const url = item?.icon ? this.ctx.textureUrl?.(item.icon) : undefined;
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      box.append(img);
    } else box.textContent = (item?.name ?? "?").slice(0, 2);
    if (item) box.style.borderColor = item.tint ?? RARITY_TINT[item.rarity];
    return box;
  }

  private row(itemId: string, qty: number, right: string, label: string, onClick: (e: MouseEvent) => void, disabled = false): HTMLElement {
    const item = this.catalog(itemId);
    const b = document.createElement("button");
    b.className = "hr-npc-row";
    b.disabled = disabled;
    b.title = item ? `${item.name}${item.description ? ` — ${item.description}` : ""}` : itemId;
    const name = el("span", "hr-npc-name", `${item?.name ?? itemId}${qty > 1 ? ` ×${qty}` : ""}`);
    if (item) name.style.color = item.tint ?? RARITY_TINT[item.rarity];
    b.append(this.icon(item), name, el("span", "hr-npc-price", right));
    b.setAttribute("aria-label", `${label} ${item?.name ?? itemId}${qty > 1 ? `, ${qty}` : ""}, ${right}`);
    b.addEventListener("click", onClick);
    return b;
  }

  /** Carried stacks (never worn ones), in grid order. */
  private carried(sheet: CharacterSheet | null): Array<[string, { itemId: string; qty: number }]> {
    if (!sheet) return [];
    return Object.entries(sheet.items)
      .filter(([, s]) => s.container !== undefined)
      .sort(([, a], [, b]) => (a.container === b.container ? (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0) : a.container === "bag" ? 1 : -1));
  }

  private drawShop(conv: Conversation, sheet: CharacterSheet | null): void {
    const shopId = conv.panel?.kind === "shop" ? conv.panel.shop : "";
    const asset = this.ctx.getDataAsset?.(shopId);
    if (asset?.type !== "shop") return void this.service.replaceChildren(el("p", "", "This shop is closed."));
    const shop = asset.data as Shop;
    const state = (this.store.get(`shop/${shopId}`) as ShopState | undefined) ?? null;
    const env = { catalog: this.catalog };
    const me = this.me();
    const coins = sheet?.coins ?? 0;

    const buy = el("section", "hr-npc-col");
    buy.append(el("h4", "", "For sale"));
    for (const entry of shop.stock) {
      const price = shopSellPrice(shop, entry.itemId, env);
      if (price === null) continue;
      const left = entry.qty === undefined ? Infinity : (state?.stock[entry.itemId] ?? entry.qty);
      const tag = `${formatCoins(price)}${left === Infinity ? "" : left <= 0 ? " · sold out" : ` · ${left} left`}`;
      buy.append(
        this.row(entry.itemId, 1, tag, "Buy", (e) => this.ctx.events?.emit(NPC_EVENTS.buy, { actorId: me, npcId: conv.npc, itemId: entry.itemId, qty: e.shiftKey ? Math.max(1, Math.min(10, left)) : 1 }), left === 0 || coins < price),
      );
    }
    for (const [index, r] of (state?.resale ?? []).entries()) {
      const price = shopSellPrice(shop, r.itemId, env);
      if (price === null) continue;
      // buying names the entry: that exact instance (its wear, its twists) is what comes back
      buy.append(this.row(r.itemId, r.qty, `${formatCoins(price)} · sold by players`, "Buy", () => this.ctx.events?.emit(NPC_EVENTS.buy, { actorId: me, npcId: conv.npc, itemId: r.itemId, qty: 1, resale: index }), coins < price));
    }

    const sell = el("section", "hr-npc-col");
    sell.append(el("h4", "", "Your bags"));
    const bags = this.carried(sheet);
    for (const [uid, s] of bags) {
      const price = shopBuyPrice(shop, s.itemId, env);
      sell.append(
        this.row(s.itemId, s.qty, price === null ? "won't buy" : `sells ${formatCoins(price)}`, "Sell", (e) => this.ctx.events?.emit(NPC_EVENTS.sell, { actorId: me, npcId: conv.npc, uid, qty: e.shiftKey ? s.qty : 1 }), price === null),
      );
    }
    if (bags.length === 0) sell.append(el("p", "hr-npc-empty", "Nothing to sell."));

    const foot = el("footer", "", `Purse: ${formatCoins(coins)}`);
    foot.append(el("small", "", "Shift-click: buy 10 · sell the stack"));
    const head = el("header", "");
    head.append(el("h3", "", shop.name));
    head.append(button("Close", () => this.leave(conv)));
    const cols = el("div", "hr-npc-cols");
    cols.append(buy, sell);
    this.service.replaceChildren(head, cols, foot);
  }

  /** Dock the bags beside the vault (npc id) or undock them (""). */
  private linkStash(npcId: string): void {
    if (npcId === this.stashFor || typeof window === "undefined") return;
    const owner = `npc-ui:${this.entityId}`;
    if (this.stashFor) window.dispatchEvent(new CustomEvent("hitreg:inventory-stash", { detail: { owner, closed: true } }));
    this.stashFor = npcId;
    if (!npcId) return;
    const quickMove = (uid: string, qty?: number): void => {
      const conv = this.conv();
      if (conv?.panel?.kind === "vault") this.ctx.events?.emit(NPC_EVENTS.deposit, { actorId: this.me(), npcId: conv.npc, uid, ...(qty ? { qty } : {}) });
    };
    window.dispatchEvent(new CustomEvent("hitreg:inventory-stash", { detail: { owner, label: "store in the vault", quickMove } }));
  }

  private drawVault(conv: Conversation, sheet: CharacterSheet | null): void {
    const me = this.me();
    const vault = (this.store.get(`vault/${me}`) as Vault | undefined) ?? { capacity: 24, coins: 0, items: [] };
    const cols = Math.max(2, Math.round(this.param<number>("vaultColumns")));
    const withdraw = (index: number, qty?: number, to?: { container: string; x: number; y: number }): void =>
      void this.ctx.events?.emit(NPC_EVENTS.withdraw, { actorId: me, npcId: conv.npc, index, ...(qty ? { qty } : {}), ...(to ? { to } : {}) });

    const grid = el("div", "hr-npc-grid");
    grid.style.gridTemplateColumns = `repeat(${cols}, var(--hr-npc-cell))`;
    grid.setAttribute("aria-label", `Vault, ${vaultUsed(vault)} of ${vault.capacity} slots used`);
    for (let i = 0; i < vault.capacity; i++) {
      const cell = el("div", "hr-npc-slot");
      cell.dataset["drop"] = "external"; // character-ui drops a bag stack here
      cell.dataset["vaultSlot"] = String(i);
      cell.addEventListener("hr-item-drop", (e) => {
        const d = (e as CustomEvent<{ uid: string; fromSlot: string | null }>).detail;
        if (d.fromSlot) return this.flash("Take it off first.");
        this.ctx.events?.emit(NPC_EVENTS.deposit, { actorId: me, npcId: conv.npc, uid: d.uid, slot: i });
      });
      const s = vault.items[i];
      if (s) {
        const item = this.catalog(s.itemId);
        const node = el("div", "hr-npc-stack");
        node.tabIndex = 0;
        node.setAttribute("role", "button");
        node.setAttribute("aria-label", `${item?.name ?? s.itemId}${s.qty > 1 ? `, ${s.qty}` : ""}. Enter to take.`);
        node.style.setProperty("--tint", item ? item.tint ?? RARITY_TINT[item.rarity] : "#ff5a5a");
        node.append(this.icon(item));
        if (s.qty > 1) node.append(el("span", "hr-npc-qty", String(s.qty)));
        node.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          withdraw(i, e.shiftKey && s.qty > 1 ? 1 : undefined);
        });
        node.addEventListener("dblclick", (e) => withdraw(i, e.shiftKey && s.qty > 1 ? 1 : undefined));
        node.addEventListener("keydown", (e) => {
          if (e.code === "Enter" || e.code === "Space") {
            e.preventDefault();
            withdraw(i, e.shiftKey && s.qty > 1 ? 1 : undefined);
          }
        });
        node.addEventListener("pointerenter", (e) => this.showTip(item, s.itemId, s.qty, e, s.durability));
        node.addEventListener("pointermove", (e) => this.placeTip(e));
        node.addEventListener("pointerleave", () => (this.tip.hidden = true));
        node.addEventListener("pointerdown", (e) => this.dragStart(e, node, i, conv.npc));
        cell.append(node);
      }
      grid.append(cell);
    }

    const purse = sheet?.coins ?? 0;
    const foot = el("footer", "");
    foot.append(el("span", "hr-npc-coins", `Vault ${formatCoins(vault.coins)}`), el("span", "hr-npc-coins", `Purse ${formatCoins(purse)}`));
    const amount = document.createElement("input");
    amount.type = "text";
    amount.placeholder = "e.g. 1g 20s";
    amount.setAttribute("aria-label", "Amount of coin");
    amount.className = "hr-npc-amount";
    const send = (sign: 1 | -1, all: number): void => {
      const n = amount.value.trim() ? parseCoins(amount.value) : all;
      if (n > 0) this.ctx.events?.emit(NPC_EVENTS.coins, { actorId: me, npcId: conv.npc, amount: sign * n });
    };
    foot.append(amount, button("Deposit", () => send(1, purse)), button("Withdraw", () => send(-1, vault.coins)));
    foot.append(el("small", "", "Right-click or double-click takes a stack out · Shift: just one · Drag to move · Empty amount = all coin"));
    const head = el("header", "");
    const title = el("div", "hr-npc-title");
    title.append(el("h3", "", "Your vault"), el("small", "", `${vaultUsed(vault)} / ${vault.capacity}`));
    head.append(title, button("Close", () => this.leave(conv)));
    const parts: HTMLElement[] = [head, grid];
    if (conv.notice) parts.push(el("p", "hr-npc-notice", conv.notice));
    parts.push(foot);
    this.service.replaceChildren(...parts);
  }

  /** A local hint in the vault window (the server's refusals arrive as the conversation notice). */
  private flash(text: string): void {
    const note = el("p", "hr-npc-notice", text);
    this.service.querySelector(".hr-npc-notice")?.remove();
    this.service.querySelector(".hr-npc-grid")?.after(note);
    this.ctx.after(2.5, () => note.remove());
  }

  private showTip(item: Item | undefined, itemId: string, qty: number, e: PointerEvent, durability?: number): void {
    if (this.drag?.moved) return;
    const name = el("div", "nm", item?.name ?? itemId);
    if (item) name.style.color = item.tint ?? RARITY_TINT[item.rarity];
    const parts: HTMLElement[] = [name];
    if (item) parts.push(el("div", "meta", [item.rarity, item.kind, qty > 1 ? `${qty} stacked` : ""].filter(Boolean).join(" · ")));
    if (item?.durability !== undefined) {
      const cur = Math.min(item.durability, durability ?? item.durability);
      parts.push(el("div", cur === 0 ? "broken" : "meta", `${cur === 0 ? "Broken · " : ""}Durability ${cur} / ${item.durability}`));
    }
    if (item?.description) parts.push(el("div", "desc", item.description));
    parts.push(el("div", "meta", "Right-click: take · Drag to move"));
    this.tip.replaceChildren(...parts);
    this.tip.hidden = false;
    this.placeTip(e);
  }

  private placeTip(e: PointerEvent): void {
    if (this.tip.hidden) return;
    const r = this.tip.getBoundingClientRect();
    this.tip.style.left = `${Math.max(4, Math.min(e.clientX + 14, window.innerWidth - r.width - 4))}px`;
    this.tip.style.top = `${Math.max(4, Math.min(e.clientY + 14, window.innerHeight - r.height - 4))}px`;
  }

  // -- dragging out of the vault ------------------------------------------------------------

  private dragStart(e: PointerEvent, node: HTMLElement, index: number, npcId: string): void {
    if (e.button !== 0 || this.drag || !this.root) return;
    e.preventDefault();
    const rect = node.getBoundingClientRect();
    const ghost = node.cloneNode(true) as HTMLDivElement;
    ghost.classList.add("hr-npc-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.display = "none";
    // on <body>, above the bags window (a later stacking context than this root)
    document.body.append(ghost);
    this.drag = { index, npcId, node, ghost, grabX: e.clientX - rect.left, grabY: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, moved: false, over: null };
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    d.moved = true;
    this.tip.hidden = true;
    d.ghost.style.display = "";
    d.node.classList.add("lifted");
    d.ghost.style.left = `${e.clientX - d.grabX}px`;
    d.ghost.style.top = `${e.clientY - d.grabY}px`;
    const over = this.vaultDropAt(e)?.el ?? null;
    if (over !== d.over) {
      d.over?.classList.remove("over");
      d.over = over;
      d.over?.classList.add("over");
    }
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const target = d.moved ? this.vaultDropAt(e) : null;
    this.cancelDrag();
    if (!target) return;
    const actorId = this.me();
    if (target.kind === "slot") this.ctx.events?.emit(NPC_EVENTS.arrange, { actorId, npcId: d.npcId, from: d.index, to: target.slot });
    else this.ctx.events?.emit(NPC_EVENTS.withdraw, { actorId, npcId: d.npcId, index: d.index, ...(target.to ? { to: target.to } : {}) });
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    d.ghost.remove();
    d.node.classList.remove("lifted");
    d.over?.classList.remove("over");
    this.drag = null;
  }

  /** Under the pointer: another vault slot, a cell of character-ui's bag grids, or anywhere on the bags window. */
  private vaultDropAt(e: PointerEvent): { kind: "slot"; el: HTMLElement; slot: number } | { kind: "bags"; el: HTMLElement; to?: { container: string; x: number; y: number } } | null {
    for (const node of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.dataset["vaultSlot"] !== undefined) return { kind: "slot", el: node, slot: Number(node.dataset["vaultSlot"]) };
      if (node.dataset["drop"] === "grid" && node.dataset["container"]) {
        const cols = Number(node.dataset["cols"]) || 1;
        const rows = Number(node.dataset["rows"]) || 1;
        const r = node.getBoundingClientRect();
        const x = Math.max(0, Math.min(cols - 1, Math.floor(((e.clientX - r.left) / r.width) * cols)));
        const y = Math.max(0, Math.min(rows - 1, Math.floor(((e.clientY - r.top) / r.height) * rows)));
        return { kind: "bags", el: node, to: { container: node.dataset["container"], x, y } };
      }
      if (node.classList.contains("hr-panel") && node.closest(".hr-char")) return { kind: "bags", el: node };
    }
    return null;
  }

  private frame(): string {
    const id = this.param<string>("panelSkin");
    const url = id ? this.ctx.textureUrl?.(id) : undefined;
    if (url) return `url("${url}")`;
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'>` +
      `<rect x='1' y='1' width='46' height='46' rx='10' fill='#0f131b' stroke='#39425a' stroke-width='1.5'/></svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  }
}

/** "1g 20s 5c", "250" (copper), "3s" → copper. */
export function parseCoins(text: string): number {
  let total = 0;
  for (const m of text.toLowerCase().matchAll(/(\d+)\s*([gsc]?)/g)) {
    const n = Number(m[1]);
    total += m[2] === "g" ? n * COPPER_PER_GOLD : m[2] === "s" ? n * COPPER_PER_SILVER : n;
  }
  return total;
}

interface VaultDrag {
  index: number;
  npcId: string;
  node: HTMLElement;
  ghost: HTMLDivElement;
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  moved: boolean;
  over: HTMLElement | null;
}

function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

function keyLabel(code: string): string {
  return code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code;
}

function el(tag: string, className: string, text?: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

const CSS = `
.hr-npc{position:fixed;inset:0;pointer-events:none;z-index:44;font:14px/1.45 system-ui,sans-serif;color:#e6e9f0}
.hr-npc [hidden]{display:none!important}
.hr-npc button{font:inherit;color:inherit;cursor:pointer}
.hr-npc button:focus-visible,.hr-npc input:focus-visible{outline:2px solid #ffd27a;outline-offset:2px}
.hr-npc-panel{position:absolute;pointer-events:auto;background:#0f131bf0;background-clip:padding-box;border:var(--hr-npc-border) solid transparent;border-image:var(--hr-npc-panel) var(--hr-npc-slice) fill / var(--hr-npc-border) stretch;box-shadow:0 6px 24px #000a}
.hr-npc-prompt{position:absolute;left:50%;bottom:22%;transform:translateX(-50%);display:flex;gap:8px;align-items:baseline;padding:6px 14px;background:#0b0e14d9;border:1px solid #39425a;border-radius:4px;white-space:nowrap}
.hr-npc-prompt kbd{font:600 13px/1 ui-monospace,monospace;padding:3px 7px;border:1px solid #8a93a8;border-radius:3px;background:#1a2030}
.hr-npc-prompt small{color:#9aa3b8;margin-left:6px}
.hr-npc-inspect{position:absolute;left:0;top:0;display:flex;align-items:center;gap:6px;padding:3px 8px 3px 4px;background:#0b0e14e6;border:1px solid #30363d;border-radius:3px;white-space:nowrap;font-size:12px;color:#e6edf3;image-rendering:pixelated}
.hr-npc-inspect .hr-npc-glyph{display:grid;place-items:center;width:20px;height:20px;border:1px solid #8b949e;border-radius:2px;color:#e6edf3;animation:hr-npc-bob 1s steps(2,jump-none) infinite}
.hr-npc-inspect kbd{font:600 11px/1 ui-monospace,monospace;padding:2px 5px;border:1px solid #8b949e;border-radius:2px;background:#161b22}
.hr-npc-inspect.far{color:#8b949e;border-style:dashed}
.hr-npc-inspect.far .hr-npc-glyph{border-style:dashed;color:#8b949e;animation:none}
@keyframes hr-npc-bob{from{transform:translateY(0)}to{transform:translateY(-2px)}}
@media (prefers-reduced-motion:reduce){.hr-npc-inspect .hr-npc-glyph{animation:none}}
.hr-npc-talk{left:50%;bottom:6%;transform:translateX(-50%);width:min(620px,94vw);padding:10px 16px 12px}
.hr-npc-talk header{display:flex;align-items:baseline;gap:10px;border-bottom:1px solid #39425a88;padding-bottom:6px}
.hr-npc h3{margin:0;font-size:16px;font-weight:600;color:#f1dcab}.hr-npc header small{color:#9aa3b8}
.hr-npc-line{margin:10px 0;font-size:15px;white-space:pre-line}
.hr-npc-notice{margin:6px 0;color:#ffb4a0}
.hr-npc-choices{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.hr-npc-choices button{width:100%;text-align:left;background:#1a2130;border:1px solid #39425a;border-radius:3px;padding:6px 10px}
.hr-npc-choices button:hover{background:#243049;color:#fff}
.hr-npc-service{left:50%;top:8%;transform:translateX(-50%);width:min(760px,96vw);max-height:56vh;display:flex;flex-direction:column;padding:10px 14px}
.hr-npc-service header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.hr-npc-service header button,.hr-npc-service footer button{background:#1a2130;border:1px solid #39425a;border-radius:3px;padding:3px 10px}
.hr-npc-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-height:0;overflow:auto}
.hr-npc-col{display:flex;flex-direction:column;gap:3px}.hr-npc h4{margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9aa3b8}
.hr-npc-row{display:grid;grid-template-columns:32px 1fr auto;align-items:center;gap:8px;text-align:left;background:#151b27;border:1px solid #2c3444;border-radius:3px;padding:3px 8px 3px 3px}
.hr-npc-row:hover:not(:disabled){background:#1f2a3d}.hr-npc-row:disabled{opacity:.45;cursor:default}
.hr-npc-icon{width:30px;height:30px;display:grid;place-items:center;border:1px solid #39425a;border-radius:2px;background:#0b0e14;font-size:11px;overflow:hidden}
.hr-npc-icon img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.hr-npc-price{font-size:12px;color:#d8c38e;white-space:nowrap}.hr-npc-empty{color:#7d869a;margin:4px 0}
.hr-npc-service footer{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;border-top:1px solid #39425a88;padding-top:8px}
.hr-npc-service footer small{flex-basis:100%;color:#7d869a}
.hr-npc-amount{width:110px;background:#0b0e14;border:1px solid #39425a;color:inherit;padding:3px 6px;font:inherit}
.hr-npc-service.hr-npc-vault{left:auto;right:calc(50% + 8px);top:50%;transform:translateY(-50%);width:auto;max-width:calc(50vw - 16px);max-height:88vh;user-select:none}
.hr-npc-title{display:flex;align-items:baseline;gap:10px}.hr-npc-title small{color:#9aa3b8;font-variant-numeric:tabular-nums}
.hr-npc-grid{display:grid;grid-auto-rows:var(--hr-npc-cell);gap:2px;overflow:auto;min-height:0;width:max-content;max-width:100%}
.hr-npc-slot{position:relative;background:#0b0e14;border:1px solid #2c3444;border-radius:3px;box-sizing:border-box}
.hr-npc-slot.over{border-color:#ffd27a;background:#1a2130}
.hr-npc-stack{position:absolute;inset:1px;display:grid;place-items:center;border:1px solid var(--tint,#b9c0d0);border-radius:3px;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(0,0,0,.28)),#1a1f2b;cursor:grab;touch-action:none}
.hr-npc-stack .hr-npc-icon{width:86%;height:86%;border:0;background:none;pointer-events:none}
.hr-npc-stack.lifted{opacity:.3}
.hr-npc-qty{position:absolute;right:3px;bottom:1px;font-size:10px;text-shadow:0 0 3px #000;pointer-events:none}
.hr-npc-ghost{position:fixed;z-index:90;pointer-events:none;opacity:.92;display:grid;place-items:center;border:1px solid var(--tint,#b9c0d0);border-radius:3px;background:#1a1f2b;color:#e6e9f0;font:11px system-ui,sans-serif}
.hr-npc-ghost .hr-npc-icon{width:86%;height:86%;display:grid;place-items:center;overflow:hidden}.hr-npc-ghost img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.hr-npc-ghost .hr-npc-qty{position:absolute;right:3px;bottom:1px;font-size:10px;text-shadow:0 0 3px #000}
.hr-npc-coins{font-variant-numeric:tabular-nums;color:#d8c38e}
.hr-npc-tip{position:fixed;z-index:90;max-width:240px;padding:8px 10px;background:rgba(13,16,22,.96);border:1px solid #2a3040;border-radius:6px;pointer-events:none;font-size:11px}
.hr-npc-tip .broken{color:#ff6b5a;font-weight:600}
.hr-npc-service.hr-npc-repair{width:min(460px,96vw)}
.hr-npc-service.hr-npc-repair .hr-npc-col{overflow:auto;min-height:0}
.hr-npc-name small.hr-npc-wear{display:block;font-size:11px;color:#9aa3b8}
.hr-npc-row.hr-npc-chosen{border-color:#b49cff;background:#1d1a2e}
.hr-npc-row.hr-npc-broken{border-color:#8a2f28}.hr-npc-row.hr-npc-broken small.hr-npc-wear{color:#ff6b5a;font-weight:600}
.hr-npc-tip .nm{font-weight:600;font-size:12px}.hr-npc-tip .meta{color:#8b93a7}.hr-npc-tip .desc{color:#b9c0d0;margin-top:4px;font-style:italic}
@media (max-width:760px){.hr-npc-service.hr-npc-vault{right:auto;left:50%;top:8px;transform:translateX(-50%);max-width:96vw;max-height:46vh}}
@media (max-width:640px){.hr-npc-cols{grid-template-columns:1fr}}
`;
