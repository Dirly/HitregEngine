import { questOfferProblem, type Dialogue, type Quest, type QuestJournal } from "@hitreg/core";
import { Script } from "./script.js";
import { sheetStoreOf, type SheetStoreLike } from "./character-store.js";

interface Plate {
  el: HTMLDivElement;
  name: HTMLSpanElement;
  title: HTMLSpanElement;
  mark: HTMLSpanElement;
  text: string;
}

/**
 * Name tags over characters: other players (their name from the server,
 * netState `name/<bodyId>`) and NPCs (the `npc` builtin's name and title).
 * Over an NPC it also shows the quest marker — `!` when it has a quest this
 * character can take now, `?` when a quest is waiting to be handed in to it —
 * read from the NPC's dialogue (the quests its choices accept and hand in) and
 * this character's replicated journal.
 *
 * DOM, not sprites: a tag costs no draw call. Each follows its entity through
 * the host's `ctx.worldToScreen` and fades out toward `maxDistance`; nothing
 * is drawn headless or on a host without the hook. Client only, one per scene.
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
  };

  private store!: SheetStoreLike;
  private root: HTMLDivElement | undefined;
  private plates = new Map<string, Plate>();
  private questsOf = new Map<string, { gives: string[]; takes: string[] }>();
  private scan = 0;
  private ids: string[] = [];

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
  }

  override onDispose(): void {
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
      if (q && questOfferProblem(journal, q) === null && q.level <= level + 3) return "!";
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
    el.append(mark, name, title);
    this.root!.append(el);
    p = { el, name, title, mark, text: "" };
    this.plates.set(id, p);
    return p;
  }

  override onLateUpdate(dt: number): void {
    if (!this.root) return;
    this.scan -= dt;
    if (this.scan <= 0) {
      this.scan = 0.5;
      const tags = this.param<string>("tags").split(",").map((t) => t.trim()).filter(Boolean);
      this.ids = [...new Set(tags.flatMap((t) => this.ctx.findByTag(t)))];
      for (const [id, p] of this.plates) if (!this.ids.includes(id)) (p.el.remove(), this.plates.delete(id));
    }
    const me = this.ctx.localPlayer?.() ?? null;
    const journal = me ? (this.store.get(`quests/${me}`) as QuestJournal | undefined) : undefined;
    const level = me ? ((this.store.get(`character/${me}`) as { level?: number } | undefined)?.level ?? 1) : 1;
    const max = this.param<number>("maxDistance");
    const lift = this.param<number>("height");
    for (const id of this.ids) {
      const object = this.ctx.getObject(id);
      const doc = this.ctx.getEntity(id);
      if (!object || !doc || (id === me && !this.param<boolean>("showSelf"))) {
        this.plates.get(id)?.el.classList.add("off");
        continue;
      }
      const script = doc.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
      const isNpc = script?.name === "npc";
      const name = isNpc ? String(script?.params?.["name"] || doc.name) : (this.store.get(`name/${id}`) as string | undefined) ?? (id === me ? "You" : "");
      const p = object.position;
      const at = name ? this.ctx.worldToScreen!(p.x, p.y + lift, p.z) : null;
      const plate = this.plate(id);
      if (!at || at.distance > max) {
        plate.el.classList.add("off");
        continue;
      }
      const title = isNpc ? String(script?.params?.["title"] ?? "") : "";
      const mark = isNpc && this.param<boolean>("questMarkers") ? this.marker(id, String(script?.params?.["dialogue"] ?? ""), journal, level) : "";
      const text = `${name}|${title}|${mark}`;
      if (text !== plate.text) {
        plate.text = text;
        plate.name.textContent = name;
        plate.title.textContent = title ? `<${title}>` : "";
        plate.mark.textContent = mark;
        plate.el.classList.toggle("npc", isNpc);
        plate.el.classList.toggle("player", !isNpc);
      }
      const near = Math.max(0, Math.min(1, (max - at.distance) / (max / 3)));
      const scale = Math.max(0.7, Math.min(1.15, 9 / Math.max(at.distance, 1)));
      plate.el.classList.remove("off");
      plate.el.classList.toggle("far", at.distance > this.param<number>("titleDistance"));
      plate.el.style.opacity = near.toFixed(2);
      plate.el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
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
`;
