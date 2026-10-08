import {
  castBarProgress,
  questOfferProblem,
  questSource,
  readBadges,
  readCastBar,
  type Dialogue,
  type Quest,
  type QuestJournal,
} from "@hitreg/core";
import { presentFor } from "./presence.js";
import { Script } from "./script.js";
import { sheetStoreOf, type SheetStoreLike } from "./character-store.js";

interface Plate {
  el: HTMLDivElement;
  name: HTMLSpanElement;
  title: HTMLSpanElement;
  mark: HTMLSpanElement;
  text: string;
  badges: HTMLDivElement;
  /** Last drawn badge row (texts, colours and whole seconds), so the DOM is touched only on change. */
  badgeShown: string;
  cast: HTMLDivElement;
  castFill: HTMLDivElement;
  castText: HTMLSpanElement;
  /** Last drawn cast bar: its text and fill, so the DOM is touched only on change. */
  castShown: string;
  castDrawn: number;
  /** Laid-out size (px, unscaled), read once per content change: what `avoid` pushes clear. */
  size: { w: number; h: number } | null;
}

/** A screen rectangle, px. */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Name tags over characters: other players (their name from the server,
 * netState `name/<bodyId>`) and NPCs (the `npc` builtin's name and title).
 * Over an NPC it also shows the quest marker — `!` when it has a quest this
 * character can take now, `?` when a quest is waiting to be handed in to it —
 * read from the NPC's dialogue (the quests its choices accept and hand in) and
 * this character's replicated journal.
 *
 * CAST BARS: any body with a cast in progress in netState `<castBarKey>/<bodyId>`
 * (core `castBarSchema`, namespace `cast` by default) gets a bar under its tag,
 * filled over the wind-up in the cast's colour with its tag and label; an
 * interrupted cast holds where it stopped, marked, for `castBarLinger`. A cast
 * published `show: false` with a `mark` (a creature's swing class) draws a
 * small chip with that marker instead, filled the same way. The body needs no
 * tag: the bar follows the key, so a game's creatures get bars without being
 * named. What a cast is, and which casts show, are the writer's.
 *
 * BADGES: timed statuses in netState `<badgeKey>/<bodyId>` (core
 * `plateBadgesSchema`: an interrupt's school lock, say) sit over the bar, each
 * with its whole seconds left.
 *
 * Bars and badges are read to `castBarDistance` (further than names: a spell
 * is cast from range), stack over a body's overhead `billboard` (its HP bar)
 * when it has one, and are pushed clear of any HUD panel matching `avoid`.
 *
 * DOM, not sprites: a tag or a bar costs no draw call, however many bodies
 * carry one. Each follows its entity through the host's `ctx.worldToScreen`
 * and fades out toward its distance; nothing is drawn headless or on a host
 * without the hook. Client only, one per scene.
 */
export class Nameplates extends Script {
  static override scriptName = "nameplates";
  static clientOnly = true;
  static override params = {
    tags: { default: "player,interactable", description: "comma-separated entity tags that get a name tag (players, NPCs — add a mob tag to name monsters)" },
    maxDistance: { default: 32, min: 4, max: 200, description: "metres from the camera past which tags are hidden (they fade over the last third)" },
    height: { default: 1.1, min: 0, max: 5, description: "metres above the entity's origin (a capsule body's centre) the tag floats" },
    titleDistance: { default: 14, min: 0, max: 200, description: "metres past which an NPC's title is dropped and only the name shows (a crowd's titles overlap)" },
    showSelf: { default: false, description: "tag this tab's own player too" },
    questMarkers: { default: true, description: "show ! (a quest to take) and ? (a quest to hand in) over NPCs" },
    cssClass: { default: "", description: "optional game skin class on the root (.hr-plates); styles stay owned by the project" },
    castBarKey: {
      default: "cast",
      description:
        "netState namespace of casts in progress: `<ns>/<bodyId>` holding core castBarSchema draws a cast bar over that body " +
        "(no tag needed). Empty = no cast bars. This tab's own body gets none unless showSelf (a HUD shows your own).",
    },
    castBarLinger: { default: 0.8, min: 0, max: 5, description: "seconds an interrupted cast's bar stays up, frozen and marked, after it was stopped" },
    castBarDistance: {
      default: 48,
      min: 4,
      max: 300,
      description:
        "metres from the camera past which cast bars, wind-up chips and badges are hidden (fading over the last third). " +
        "Further than maxDistance on purpose: a caster is read from as far as its spells reach.",
    },
    badgeKey: {
      default: "badge",
      description:
        "netState namespace of overhead badges: `<ns>/<bodyId>` holding core plateBadgesSchema (timed statuses such as an " +
        "interrupt's lock) draws each over that body with its seconds left. Empty = none.",
    },
    stackOnBillboard: {
      default: true,
      description:
        "lift a body's plate to just above its overhead `billboard` (an HP bar on a child), so bar, badges and HP read as one " +
        "stack instead of a bar floating over the face. Off = always `height`.",
    },
    avoid: {
      default: "[data-hud-panel]",
      description:
        "CSS selector of HUD panels a plate carrying a bar or badge is pushed clear of (re-measured twice a second), so a " +
        "caster at the screen edge never puts its bar under the quest window. Empty = none.",
    },
  };

  private store!: SheetStoreLike;
  private root: HTMLDivElement | undefined;
  private plates = new Map<string, Plate>();
  private questsOf = new Map<string, { gives: string[]; takes: string[] }>();
  private scan = 0;
  private ids: string[] = [];
  /** Bodies with a key under castBarKey or badgeKey, kept by onChange rather than a scan of every key per frame. */
  private readonly casting = new Set<string>();
  private readonly badged = new Set<string>();
  /** Per body: metres above its origin its plate sits (`height`, or over its billboard). */
  private readonly lifts = new Map<string, number>();
  /** HUD panels to stay clear of, measured at the scan. */
  private panels: Rect[] = [];
  private unwatch: Array<() => void> = [];

  override onStart(): void {
    if (typeof document === "undefined" || !this.ctx.worldToScreen) return;
    this.store = sheetStoreOf(this.ctx);
    const root = document.createElement("div");
    root.className = "hr-plates";
    root.setAttribute("aria-hidden", "true");
    const skin = this.param<string>("cssClass");
    if (/^[a-zA-Z][\w-]*$/.test(skin)) root.classList.add(skin);
    root.innerHTML = `<style>${CSS}</style>`;
    document.body.append(root);
    this.root = root;
    this.watch(this.param<string>("castBarKey").trim(), this.casting);
    this.watch(this.param<string>("badgeKey").trim(), this.badged);
  }

  /** Keep `into` the set of bodies holding a key under namespace `ns`. */
  private watch(ns: string, into: Set<string>): void {
    if (!ns) return;
    const prefix = `${ns}/`;
    for (const key of this.store.keys(prefix)) into.add(key.slice(prefix.length));
    this.unwatch.push(
      this.store.onChange((key, value) => {
        if (!key.startsWith(prefix)) return;
        const id = key.slice(prefix.length);
        if (value === undefined) into.delete(id);
        else into.add(id);
      }),
    );
  }

  override onDispose(): void {
    for (const off of this.unwatch) off();
    this.unwatch = [];
    this.casting.clear();
    this.badged.clear();
    this.root?.remove();
    this.root = undefined;
    this.plates.clear();
  }

  /** The quests an NPC's dialogue hands out and takes in, read once. */
  private npcQuests(id: string, dialogueId: string): { gives: string[]; takes: string[] } {
    let q = this.questsOf.get(id);
    if (q) return q;
    q = { gives: [], takes: [] };
    const asset = dialogueId ? this.ctx.getDataAsset?.(dialogueId) : undefined;
    if (asset?.type === "dialogue") {
      for (const node of Object.values((asset.data as Dialogue).nodes)) {
        for (const choice of node.choices) {
          for (const a of choice.do) {
            if (a.do === "acceptQuest" && !q.gives.includes(a.quest)) q.gives.push(a.quest);
            if (a.do === "turnInQuest" && !q.takes.includes(a.quest)) q.takes.push(a.quest);
          }
        }
      }
    }
    this.questsOf.set(id, q);
    return q;
  }

  private quest(id: string): Quest | undefined {
    const a = this.ctx.getDataAsset?.(id);
    return a?.type === "quest" ? (a.data as Quest) : undefined;
  }

  /** "!" / "?" / "" for an NPC, for this tab's character. */
  private marker(id: string, dialogueId: string, journal: QuestJournal | undefined, level: number): string {
    const { gives, takes } = this.npcQuests(id, dialogueId);
    if (takes.some((q) => journal?.quests[q]?.status === "ready")) return "?";
    for (const qid of gives) {
      const q = this.quest(qid);
      // only a person advertises a quest: an object, a presence or a place carries no marker (players find those through leads)
      if (q && questSource(q).kind === "npc" && questOfferProblem(journal, q) === null && q.level <= level + 3) return "!";
    }
    return "";
  }

  private plate(id: string): Plate {
    let p = this.plates.get(id);
    if (p) return p;
    const el = document.createElement("div");
    el.className = "hr-plate";
    const mark = document.createElement("span");
    mark.className = "hr-plate-mark";
    const name = document.createElement("span");
    name.className = "hr-plate-name";
    const title = document.createElement("span");
    title.className = "hr-plate-title";
    const badges = document.createElement("div");
    badges.className = "hr-plate-badges";
    const cast = document.createElement("div");
    cast.className = "hr-plate-cast off";
    const castFill = document.createElement("div");
    castFill.className = "hr-plate-cast-fill";
    const castText = document.createElement("span");
    castText.className = "hr-plate-cast-text";
    cast.append(castFill, castText);
    el.append(mark, name, title, badges, cast);
    this.root!.append(el);
    p = { el, name, title, mark, text: "", badges, badgeShown: "", cast, castFill, castText, castShown: "", castDrawn: -1, size: null };
    this.plates.set(id, p);
    return p;
  }

  /**
   * Metres above a body's origin its plate sits: `height`, or just over the
   * top of an overhead `billboard` on the body or a child (its HP bar), so
   * the cast bar stacks on the HP bar rather than over the face. Read once.
   */
  private liftOf(id: string): number {
    let lift = this.lifts.get(id);
    if (lift !== undefined) return lift;
    lift = this.param<number>("height");
    const body = this.ctx.getObject(id);
    if (this.param<boolean>("stackOnBillboard") && body) {
      body.traverse((node) => {
        const eid = node.userData["entityId"];
        if (typeof eid !== "string") return;
        const board = this.ctx.getEntity(eid)?.components["billboard"] as { offset?: number[]; size?: number[] } | undefined;
        if (!board) return;
        const top = (node === body ? 0 : node.position.y) + (board.offset?.[1] ?? 0) + (board.size?.[1] ?? 0) / 2 + 0.12;
        lift = Math.max(lift!, top);
      });
    }
    this.lifts.set(id, lift);
    return lift;
  }

  /** Re-measure the HUD panels plates keep clear of. */
  private measurePanels(): void {
    const selector = this.param<string>("avoid").trim();
    this.panels = [];
    if (!selector) return;
    let found: NodeListOf<Element>;
    try {
      found = document.querySelectorAll(selector);
    } catch {
      return; // a bad selector is a param mistake, not a crash
    }
    for (let i = 0; i < found.length; i++) {
      const r = found[i]!.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) this.panels.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }

  /**
   * Where a plate anchored at (x, y) — bottom centre, `w` x `h` px — has to
   * move so it covers no panel: the smallest push out of each panel it
   * overlaps, sideways or up/down, kept on screen.
   */
  private clear(x: number, y: number, w: number, h: number): [number, number] {
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const r of this.panels) {
        const left = x - w / 2;
        const top = y - h;
        if (left >= r.right || left + w <= r.left || top >= r.bottom || y <= r.top) continue;
        const pushes: Array<[number, number]> = [
          [r.left - (left + w) - 4, 0],
          [r.right - left + 4, 0],
          [0, r.top - y - 4],
          [0, r.bottom - top + 4],
        ];
        const ok = pushes.filter(([dx, dy]) => x + dx - w / 2 >= 0 && x + dx + w / 2 <= innerWidth && y + dy - h >= 0 && y + dy <= innerHeight);
        const best = (ok.length ? ok : pushes).reduce((a, b) => (Math.hypot(...a) <= Math.hypot(...b) ? a : b));
        x += best[0];
        y += best[1];
        moved = true;
      }
      if (!moved) break;
    }
    return [x, y];
  }

  override onLateUpdate(dt: number): void {
    if (!this.root) return;
    this.scan -= dt;
    if (this.scan <= 0) {
      this.scan = 0.5;
      const tags = this.param<string>("tags").split(",").map((t) => t.trim()).filter(Boolean);
      this.ids = [...new Set(tags.flatMap((t) => this.ctx.findByTag(t)))];
      for (const [id, p] of this.plates) {
        if (!this.ids.includes(id) && !this.casting.has(id) && !this.badged.has(id)) (p.el.remove(), this.plates.delete(id), this.lifts.delete(id));
      }
      this.measurePanels();
    }
    const me = this.ctx.localPlayer?.() ?? null;
    const journal = me ? (this.store.get(`quests/${me}`) as QuestJournal | undefined) : undefined;
    const level = me ? ((this.store.get(`character/${me}`) as { level?: number } | undefined)?.level ?? 1) : 1;
    const max = this.param<number>("maxDistance");
    const barMax = Math.max(max, this.param<number>("castBarDistance"));
    const castNs = this.param<string>("castBarKey").trim();
    const badgeNs = this.param<string>("badgeKey").trim();
    const now = this.ctx.now() / 1000;
    const ids = this.casting.size || this.badged.size ? [...new Set([...this.ids, ...this.casting, ...this.badged])] : this.ids;
    for (const id of ids) {
      const object = this.ctx.getObject(id);
      const doc = this.ctx.getEntity(id);
      if (!object || !doc || (id === me && !this.param<boolean>("showSelf"))) {
        this.plates.get(id)?.el.classList.add("off");
        continue;
      }
      // a presence that is not there for this player has no name over its head either
      if (!presentFor(this.ctx, this.store, id, me)) {
        this.plates.get(id)?.el.classList.add("off");
        continue;
      }
      const script = doc.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
      const isNpc = script?.name === "npc";
      const name = isNpc ? String(script?.params?.["name"] || doc.name) : (this.store.get(`name/${id}`) as string | undefined) ?? (id === me ? "You" : "");
      const raw = castNs && this.casting.has(id) ? readCastBar(this.store.get(`${castNs}/${id}`)) : null;
      // a hidden cast that carries a marker is drawn as its chip
      const chip = !!raw && raw.show === false && !!raw.mark;
      const bar = raw && chip ? { ...raw, show: true } : raw;
      const cast = bar ? castBarProgress(bar, now, this.param<number>("castBarLinger")) : null;
      const badges = badgeNs && this.badged.has(id) ? readBadges(this.store.get(`${badgeNs}/${id}`), now) : [];
      const busy = !!cast?.visible || badges.length > 0;
      const p = object.position;
      const at = name || busy ? this.ctx.worldToScreen!(p.x, p.y + this.liftOf(id), p.z) : null;
      const plate = this.plate(id);
      const named = !!at && !!name && at.distance <= max;
      if (!at || (!named && !(busy && at.distance <= barMax))) {
        plate.el.classList.add("off");
        continue;
      }
      const title = isNpc ? String(script?.params?.["title"] ?? "") : "";
      const mark = isNpc && this.param<boolean>("questMarkers") ? this.marker(id, String(script?.params?.["dialogue"] ?? ""), journal, level) : "";
      const text = `${named ? name : ""}|${title}|${mark}`;
      if (text !== plate.text) {
        plate.text = text;
        plate.size = null;
        plate.name.textContent = named ? name : "";
        plate.title.textContent = title ? `<${title}>` : "";
        plate.mark.textContent = mark;
        plate.el.classList.toggle("npc", isNpc);
        plate.el.classList.toggle("player", !isNpc);
      }
      const badgeSig = badges.map((b) => `${b.text}${b.color ?? ""}${Math.ceil(b.until - now)}`).join("|");
      if (badgeSig !== plate.badgeShown) {
        plate.badgeShown = badgeSig;
        plate.size = null;
        plate.badges.replaceChildren(
          ...badges.map((b) => {
            const el = document.createElement("span");
            el.className = "hr-plate-badge";
            el.textContent = `${b.text} · ${Math.ceil(b.until - now)}s`;
            if (b.color) el.style.color = el.style.borderColor = b.color;
            return el;
          }),
        );
      }
      if (bar && cast?.visible) {
        const shown = `${bar.tag ?? ""}|${bar.label}|${bar.color ?? ""}|${cast.interrupted}|${chip}`;
        if (shown !== plate.castShown) {
          plate.castShown = shown;
          plate.size = null;
          plate.castText.textContent = chip
            ? bar.mark!
            : cast.interrupted
              ? `✕ ${bar.label}: interrupted`
              : bar.tag
                ? `${bar.tag} · ${bar.label}`
                : bar.label;
          plate.castFill.style.background = bar.color ?? "";
          plate.cast.classList.toggle("int", cast.interrupted);
          plate.cast.classList.toggle("chip", chip);
          if (chip) plate.cast.style.borderColor = bar.color ?? "";
          else plate.cast.style.borderColor = "";
        }
        // a hundredth of the bar is below a pixel at any plate size: skip the style write
        const fill = Math.round(cast.fill * 100) / 100;
        if (fill !== plate.castDrawn) {
          plate.castDrawn = fill;
          plate.castFill.style.transform = `scaleX(${fill})`;
        }
        plate.cast.classList.remove("off");
      } else if (plate.castShown) {
        plate.castShown = "";
        plate.castDrawn = -1;
        plate.size = null;
        plate.cast.classList.add("off");
      }
      const reach = busy ? barMax : max;
      const near = Math.max(0, Math.min(1, (reach - at.distance) / (reach / 3)));
      const scale = Math.max(busy ? 0.85 : 0.7, Math.min(1.15, 9 / Math.max(at.distance, 1)));
      plate.el.classList.remove("off");
      plate.el.classList.toggle("far", at.distance > this.param<number>("titleDistance"));
      plate.el.style.opacity = (busy ? Math.max(near, 0.35) : near).toFixed(2);
      let x = at.x;
      let y = at.y;
      if (busy && this.panels.length) {
        // read once per content change: a layout read per frame per plate is what this avoids
        plate.size ??= { w: plate.el.offsetWidth, h: plate.el.offsetHeight };
        [x, y] = this.clear(x, y, plate.size.w * scale, plate.size.h * scale);
      }
      plate.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      plate.el.style.zIndex = String(10000 - Math.round(at.distance * 10));
    }
  }
}

const CSS = `
.hr-plates{position:fixed;inset:0;pointer-events:none;z-index:40;overflow:hidden}
.hr-plate{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;white-space:nowrap;transform-origin:50% 100%;font:600 13px/1.15 system-ui,sans-serif;text-shadow:0 1px 2px #000,0 0 3px #000}
.hr-plate.off{display:none}
.hr-plate.player .hr-plate-name{color:#cfe3ff}
.hr-plate.npc .hr-plate-name{color:#f1dcab}
.hr-plate-title{font-size:11px;font-weight:400;color:#c9c2b0}
.hr-plate-mark{font:700 22px/1 system-ui,sans-serif;color:#ffd24a}
.hr-plate-mark:empty{display:none}
.hr-plate.far .hr-plate-title{display:none}
.hr-plate-name:empty,.hr-plate-title:empty{display:none}
.hr-plate-badges{display:flex;flex-wrap:wrap;justify-content:center;gap:3px;margin-top:2px}
.hr-plate-badges:empty{display:none}
.hr-plate-badge{padding:1px 6px;border:1px solid #c9c2b0;border-radius:3px;background:#0d1017e6;color:#e6e2d6;font:700 12px/16px system-ui,sans-serif;letter-spacing:.03em;font-variant-numeric:tabular-nums}
.hr-plate-cast{position:relative;min-width:140px;max-width:240px;height:16px;margin-top:3px;background:#0d1017e6;border:1px solid #000;border-radius:3px;overflow:hidden;box-shadow:0 1px 4px #000c}
.hr-plate-cast.off{display:none}
.hr-plate-cast.chip{min-width:96px;height:18px;border-width:2px}
.hr-plate-cast-fill{position:absolute;inset:0;background:#c9c2b0;transform-origin:0 50%;transform:scaleX(0);opacity:.92}
.hr-plate-cast.chip .hr-plate-cast-fill{opacity:.45}
.hr-plate-cast.int{border-color:#fff}
.hr-plate-cast.int .hr-plate-cast-fill{background:#5a5a5a !important}
.hr-plate-cast-text{position:relative;display:block;padding:0 6px;font:700 11px/16px system-ui,sans-serif;color:#fff;text-align:center;overflow:hidden;text-overflow:ellipsis;letter-spacing:.02em}
.hr-plate-cast.chip .hr-plate-cast-text{line-height:14px;font-size:11px;letter-spacing:.06em}
`;
