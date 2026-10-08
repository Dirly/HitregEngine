import { z } from "zod";
import {
  acceptQuest,
  advanceQuest,
  carriedCount,
  DEFAULT_PERFORM_ACTIONS,
  INTERACT_RANGE,
  NPC_EVENTS,
  npcMemorySchema,
  objectiveArea,
  objectiveOpen,
  PERFORM_TOLERANCE,
  QUEST_EVENTS,
  questEventDecls,
  questJournalSchema,
  questOfferProblem,
  questSource,
  questState,
  takeCarried,
  testCondition,
  type CharacterSheet,
  type DialogueFacts,
  type NpcMemory,
  type Quest,
  type QuestArea,
  type QuestConsequence,
  type QuestJournal,
  migrateJournal,
} from "@hitreg/core";
import { Script, type ScriptCommandDecl, type ScriptEventDecl } from "./script.js";
import { worldFactsAt } from "./world-facts.js";
import { presentFor } from "./presence.js";
import { catalogOf, readSheet, sheetKey, sheetStoreOf, type SheetStoreLike } from "./character-store.js";

export { worldFactsAt } from "./world-facts.js";

const inArea = (a: QuestArea | undefined, x: number, z: number): boolean => !!a && Math.hypot(x - a.center[0], z - a.center[1]) <= a.radius;

/**
 * A character's quest journal (`quests/<bodyId>`), advanced on the session
 * authority from what actually happened: kills (the `killEvent` a combat
 * script emits), items carried (`collect`), standing in an area (`visit`,
 * `endure`), conversations opened (`talk`, from the `npc` builtin's
 * `npc.talked`), readables opened (`read`, `player.read`), entities used
 * (`interact`, `deliver`, from `player.interact`) and actions performed
 * (`perform`, from `player.perform`). Every objective kind is a registered
 * quest action block (core `questBlocks`); `after` orders steps, `when` gates
 * them (clock, weather with the biome underfoot, flags …) and `then` runs the
 * step's consequences.
 *
 * Quests are `quest` data assets (assets/quests/<id>.json) looked up by id —
 * the journal only holds the ones the character has: accepted from an NPC's
 * or an object's dialogue (`acceptQuest`), `autoStart`ed here on a fresh
 * journal, or `autoOffer`ed here once an `auto` source holds. A started
 * quest is always in the journal; only its START goes unadvertised.
 *
 * Clients only ASK: change the tracked quest (`quest.track`), use an entity
 * (`player.interact`, owner + range checked) or perform an action
 * (`player.perform`, owner + vocabulary + position + rate checked). Progress
 * never accepts a peer's word. Saving is the server's (quests/ is committed
 * with the character) or, in local play, `player-records`.
 */
export class QuestLog extends Script {
  static override scriptName = "quest-log";
  static override params = {
    actor: { default: "", description: "body entity id whose journal this is; empty = this entity" },
    autoStart: { default: [] as string[], description: "quest ids put in a FRESH journal as active (the quests nobody hands out), the first one tracked" },
    autoOffer: {
      default: [] as string[],
      description:
        "quest ids with an `auto` source this character takes up by itself, in any journal, the moment the source's `when` and `area` hold " +
        "(no marker ever points at it). Checked four times a second on the authority.",
    },
    killEvent: {
      default: "combat.killed",
      description: "event a kill is announced on, payload { killerId, victimId } — a `kill` objective's target matches the victim id, its `<target>-` prefix, or a spawned `#<target>#` template id",
    },
    performActions: {
      default: "",
      description: "`performActions` data-asset id whose actions are added to the engine's perform vocabulary (dance, dig, kneel, pray, sing, wave, sit, listen); empty = the engine's only",
    },
    performCooldown: { default: 1.5, min: 0, max: 30, description: "seconds between two accepted perform requests of this character (the rate check)" },
  };
  static override events: ScriptEventDecl[] = [
    {
      name: "quest.track",
      schema: z.object({ actorId: z.string(), questId: z.string().nullable() }),
      options: { replicate: "to-authority" },
    },
    ...questEventDecls,
  ];
  /** Player chat commands: every perform action (the engine's and the project's `performActions`) is `/<name>`. */
  static override playerCommands: ScriptCommandDecl[] = [
    ...DEFAULT_PERFORM_ACTIONS.map((a) => ({ name: a.name, description: `perform "${a.label}" where you stand (the project may add more by data)` })),
  ];

  private store!: SheetStoreLike;
  private actor = "";
  private kills: string[] = [];
  private talks: string[] = [];
  private reads: string[] = [];
  private interacts: string[] = [];
  private performs: Array<{ action: string; at: [number, number, number] }> = [];
  private endured = new Map<string, number>();
  private pendingTrack: string | null | undefined;
  private elapsed = 0;
  private clock = 0;
  private lastPerform = -Infinity;
  private vocabulary: Set<string> | null = null;

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    this.actor = this.param<string>("actor") || this.entityId;
    /** A request from a peer is honoured only for this body and only from its owner. */
    const mine = (actorId: string, meta?: { from?: string }): boolean =>
      this.store.isAuthority() && actorId === this.actor && (meta?.from === undefined || this.store.get(`owner/${this.actor}`) === meta.from);
    this.ctx.events?.on("quest.track", (data, meta) => {
      const p = data as { actorId: string; questId: string | null };
      if (mine(p.actorId, meta)) this.pendingTrack = p.questId;
    });
    this.ctx.events?.on(this.param<string>("killEvent"), (data, meta) => {
      if (meta?.from !== undefined || !this.store.isAuthority()) return;
      const p = data as { killerId?: string; victimId?: string };
      if (p.killerId !== this.actor || !p.victimId) return;
      this.kills.push(p.victimId);
      // tags are read NOW, while the body still exists (a corpse may be gone before the next evaluation)
      for (const tag of this.openKillTags()) if (this.ctx.findByTag(tag).includes(p.victimId)) this.kills.push(`tag:${tag}|${p.victimId}`);
    });
    this.ctx.events?.on(NPC_EVENTS.talked, (data, meta) => {
      if (meta?.from !== undefined || !this.store.isAuthority()) return;
      const p = data as { actorId: string; npcId: string };
      if (p.actorId === this.actor) this.talks.push(p.npcId);
    });
    this.ctx.events?.on(QUEST_EVENTS.read, (data, meta) => {
      if (meta?.from !== undefined || !this.store.isAuthority()) return;
      const p = data as { actorId: string; entityId: string };
      if (p.actorId === this.actor) this.reads.push(p.entityId);
    });
    this.ctx.events?.on(QUEST_EVENTS.interact, (data, meta) => {
      const p = data as { actorId: string; entityId: string };
      if (!mine(p.actorId, meta)) return;
      if (!this.ctx.getEntity(p.entityId)?.tags.includes("interactable")) return;
      if (!presentFor(this.ctx, this.store, p.entityId, this.actor)) return;
      const me = this.positionOf(this.actor);
      const it = this.positionOf(p.entityId);
      if (!me || !it || Math.hypot(me[0] - it[0], me[2] - it[2]) > INTERACT_RANGE || Math.abs(me[1] - it[1]) >= 4) return;
      this.interacts.push(p.entityId);
      this.ctx.events?.emit(QUEST_EVENTS.interacted, { actorId: this.actor, entityId: p.entityId });
    });
    this.ctx.events?.on(QUEST_EVENTS.perform, (data, meta) => {
      const p = data as { actorId: string; action: string; at: [number, number, number] };
      if (!mine(p.actorId, meta) || !this.performVocabulary().has(p.action)) return;
      if (this.clock - this.lastPerform < this.param<number>("performCooldown")) return;
      const me = this.positionOf(this.actor);
      if (!me || Math.hypot(me[0] - p.at[0], me[1] - p.at[1], me[2] - p.at[2]) > PERFORM_TOLERANCE) return;
      this.lastPerform = this.clock;
      this.performs.push({ action: p.action, at: me });
      this.ctx.events?.emit(QUEST_EVENTS.performed, { actorId: this.actor, action: p.action, at: me });
    });
  }

  /** The perform vocabulary: the engine's, plus the project's `performActions` asset. */
  performVocabulary(): Set<string> {
    if (this.vocabulary) return this.vocabulary;
    const names = new Set(DEFAULT_PERFORM_ACTIONS.map((a) => a.name));
    const id = this.param<string>("performActions");
    if (id) {
      const a = this.ctx.getDataAsset?.(id);
      if (a?.type === "performActions") for (const x of (a.data as { actions: Array<{ name: string }> }).actions) names.add(x.name);
      else console.warn(`[quest-log] performActions: no performActions asset "${id}"`);
    }
    return (this.vocabulary = names);
  }

  /** Client: `/dance` typed in chat by THIS tab's player becomes a perform request (the authority checks it). */
  override onPlayerCommand(name: string): string | null {
    if (this.ctx.localPlayer?.() !== this.actor || !this.performVocabulary().has(name)) return null;
    const at = this.positionOf(this.actor);
    if (!at) return null;
    this.ctx.events?.emit(QUEST_EVENTS.perform, { actorId: this.actor, action: name, at });
    return "";
  }

  private positionOf(id: string): [number, number, number] | null {
    const o = this.ctx.getObject(id);
    if (!o) return null;
    const p = o.getWorldPosition(o.position.clone());
    return [p.x, p.y, p.z];
  }

  private quest(id: string): Quest | undefined {
    const a = this.ctx.getDataAsset?.(id);
    return a?.type === "quest" ? (a.data as Quest) : undefined;
  }

  private fresh(): QuestJournal {
    let journal = questJournalSchema.parse({ quests: {} });
    this.param<string[]>("autoStart").forEach((id, i) => {
      const q = this.quest(id);
      if (!q) return console.warn(`[quest-log] autoStart: no quest asset "${id}"`);
      journal = acceptQuest(journal, q, i === 0).journal;
    });
    return journal;
  }

  /**
   * Does a kill count for a kill objective? The target is an entity id, a spawn template id (every copy an area
   * spawns counts), or `tag:<tag>` for every body carrying that tag (`tag:creature:wolf` = any wolf, whatever its
   * level tier or theme). A tag match is recorded as `tag:<tag>|<victim>` when the kill happens (see the kill event).
   */
  static matchesKill(victimId: string, target: string): boolean {
    if (target.startsWith("tag:")) return victimId.startsWith(`${target}|`);
    if (victimId.startsWith("tag:")) return false;
    return victimId === target || victimId.startsWith(`${target}-`) || victimId.includes(`#${target}#`);
  }

  /** The `tag:` kill targets of the quests this character has open: only these are worth testing when something dies. */
  private openKillTags(): string[] {
    const journal = this.store.get(`quests/${this.actor}`) as QuestJournal | undefined;
    const out = new Set<string>();
    for (const [id, st] of Object.entries(journal?.quests ?? {})) {
      if (st.status !== "active") continue;
      for (const o of this.quest(id)?.objectives ?? []) if (o.kind === "kill" && o.target.startsWith("tag:")) out.add(o.target.slice(4));
    }
    return [...out];
  }

  /** A quest with no hand-in NPC pays out the moment it completes. */
  private reward(q: Quest): void {
    if (q.rewardXp) this.ctx.events?.emit("character.xp", { actorId: this.actor, amount: q.rewardXp });
    for (const r of q.rewardItems) this.ctx.events?.emit("inventory.give", { actorId: this.actor, itemId: r.itemId, qty: r.qty });
    const sheet = readSheet(this.store, this.actor);
    if (q.rewardCoins && sheet) this.store.set(sheetKey(this.actor), { ...sheet, coins: sheet.coins + q.rewardCoins });
  }

  private consequences(memory: NpcMemory, list: readonly QuestConsequence[]): NpcMemory {
    let m = memory;
    for (const c of list) {
      const flags = { ...m.flags };
      if (c.do === "setFlag") flags[c.flag] = true;
      else delete flags[c.flag];
      m = { ...m, flags };
    }
    return m;
  }

  override onFixedUpdate(dt: number): void {
    this.clock += dt;
    if (!this.store.isAuthority()) return;
    const key = `quests/${this.actor}`;
    let journal = this.store.get(key) as QuestJournal | undefined;
    if (journal?.hidden) journal = migrateJournal(journal); // an earlier build's secret quests: a started quest is always in the journal
    // player-records may still be restoring a local save: give it the first second
    if (!journal) {
      this.elapsed += dt;
      if (this.elapsed < 1 && this.ctx.playerData) return;
      journal = this.fresh();
      this.store.set(key, journal);
    }
    const before = journal;
    if (this.pendingTrack !== undefined) {
      const t = this.pendingTrack;
      if (t === null || (journal.quests[t] && journal.quests[t]!.status !== "complete")) journal = { ...journal, tracked: t };
      this.pendingTrack = undefined;
    }
    this.elapsed += dt;
    if (this.elapsed >= 0.25) {
      const step = this.elapsed;
      this.elapsed = 0;
      journal = this.evaluate(journal, step);
    }
    if (journal !== before) this.store.set(key, questJournalSchema.parse(journal));
  }

  /** One evaluation pass (four times a second): offers, then every open objective of every active quest. */
  private evaluate(start: QuestJournal, step: number): QuestJournal {
    let journal = start;
    const body = this.positionOf(this.actor);
    let sheet: CharacterSheet | null = readSheet(this.store, this.actor);
    const memory0 = (this.store.get(`npc/${this.actor}`) as NpcMemory | undefined) ?? npcMemorySchema.parse({});
    let memory = memory0;
    const world = body ? worldFactsAt(this.ctx, this.store, body[0], body[2]) : null;
    const facts = (): DialogueFacts => ({ npcId: "", memory, journal, sheet, quest: (id) => this.quest(id), metBefore: false, bind: null, bindPoint: null, world });

    // auto sources: taken up silently once they hold
    for (const id of this.param<string[]>("autoOffer")) {
      const q = this.quest(id);
      if (!q) continue;
      const src = questSource(q);
      if (src.kind !== "auto" || questOfferProblem(journal, q) !== null) continue;
      if (src.when && !testCondition(src.when, facts())) continue;
      if (src.area && !(body && inArea(src.area, body[0], body[2]))) continue;
      journal = acceptQuest(journal, q, false).journal;
    }

    const active = Object.entries(journal.quests).filter(([, s]) => s.status === "active");
    for (const [id, startState] of active) {
      const q = this.quest(id);
      if (!q) continue;
      for (const o of q.objectives) {
        const timer = `${id}/${o.id}`;
        const have = questState(journal, id)?.progress[o.id] ?? 0;
        // order is judged on the state this pass began with, so one event never satisfies a step and its successor
        if (have >= o.required || !objectiveOpen(q, startState.progress, o.id)) {
          this.endured.delete(timer);
          continue;
        }
        if (o.when && !testCondition(o.when, facts())) {
          this.endured.delete(timer);
          continue;
        }
        let amount = 0;
        switch (o.kind) {
          case "visit":
            if (body && inArea(objectiveArea(q, o), body[0], body[2])) amount = 1;
            break;
          case "kill":
            amount = this.kills.filter((v) => QuestLog.matchesKill(v, o.target)).length;
            break;
          case "talk":
            amount = this.talks.filter((n) => n === o.target).length;
            break;
          case "collect":
            if (sheet) {
              let owned = 0;
              for (const s of Object.values(sheet.items)) if (s.itemId === o.target) owned += s.qty;
              amount = Math.max(0, owned - have);
            }
            break;
          case "interact":
            amount = this.interacts.filter((e) => e === o.target).length;
            break;
          case "read":
            amount = this.reads.filter((e) => e === o.target).length;
            break;
          case "deliver": {
            if (!sheet || !this.interacts.includes(o.target)) break;
            const n = Math.min(carriedCount(sheet, o.item), o.required - have);
            if (n <= 0) break;
            const taken = takeCarried(sheet, o.item, n, { catalog: catalogOf(this.ctx) });
            if (!taken.ok) break;
            sheet = taken.sheet;
            this.store.set(sheetKey(this.actor), sheet);
            amount = n;
            break;
          }
          case "endure": {
            if (!body || !inArea(objectiveArea(q, o), body[0], body[2])) {
              this.endured.delete(timer);
              break;
            }
            const t = (this.endured.get(timer) ?? 0) + step;
            this.endured.set(timer, t);
            if (t >= o.seconds) amount = 1;
            break;
          }
          case "perform": {
            const at = o.target ? this.positionOf(o.target) : null;
            if (o.target && !at) break;
            const area = objectiveArea(q, o);
            amount = this.performs.filter(
              (p) => p.action === o.action && (at ? Math.hypot(p.at[0] - at[0], p.at[2] - at[2]) <= o.range : area ? inArea(area, p.at[0], p.at[2]) : true),
            ).length;
            break;
          }
        }
        if (amount <= 0) continue;
        journal = advanceQuest(journal, q, o.id, amount);
        if ((questState(journal, id)?.progress[o.id] ?? 0) >= o.required) {
          this.endured.delete(timer);
          if (o.then.length) memory = this.consequences(memory, o.then);
        }
      }
      if (questState(journal, id)?.status === "complete") this.reward(q);
    }
    if (memory !== memory0) this.store.set(`npc/${this.actor}`, memory);
    this.kills = [];
    this.talks = [];
    this.reads = [];
    this.interacts = [];
    this.performs = [];
    return journal;
  }
}
