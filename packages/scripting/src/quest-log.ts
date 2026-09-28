import { z } from "zod";
import {
  acceptQuest,
  advanceQuest,
  NPC_EVENTS,
  questJournalSchema,
  type CharacterSheet,
  type Quest,
  type QuestJournal,
} from "@hitreg/core";
import { Script, type ScriptEventDecl } from "./script.js";
import { readSheet, sheetKey, sheetStoreOf, type SheetStoreLike } from "./character-store.js";

/**
 * A character's quest journal (`quests/<bodyId>`), advanced on the session
 * authority from what actually happened: kills (the `killEvent` a combat
 * script emits), items carried (`collect`), standing in a quest's area
 * (`visit`), and conversations opened with an NPC (`talk`, from the `npc`
 * builtin's `npc.talked`).
 *
 * Quests are `quest` data assets (assets/quests/<id>.json) looked up by id —
 * the journal only holds the ones the character has: accepted from an NPC's
 * dialogue (`acceptQuest`), or `autoStart`ed here on a fresh journal. A quest
 * with a `turnIn` NPC stops at READY until that NPC's dialogue hands it in;
 * one without completes (and pays its `rewardXp`) the moment its objectives do.
 *
 * Clients only ask to change which quest is tracked (`quest.track`); progress
 * never accepts a peer's word. Saving is the server's (quests/ is committed
 * with the character) or, in local play, `player-records`.
 */
export class QuestLog extends Script {
  static override scriptName = "quest-log";
  static override params = {
    actor: { default: "", description: "body entity id whose journal this is; empty = this entity" },
    autoStart: { default: [] as string[], description: "quest ids put in a FRESH journal as active (the quests nobody hands out), the first one tracked" },
    killEvent: {
      default: "combat.killed",
      description: "event a kill is announced on, payload { killerId, victimId } — a `kill` objective's target matches the victim id, its `<target>-` prefix, or a spawned `#<target>#` template id",
    },
  };
  static override events: ScriptEventDecl[] = [
    {
      name: "quest.track",
      schema: z.object({ actorId: z.string(), questId: z.string().nullable() }),
      options: { replicate: "to-authority" },
    },
  ];

  private store!: SheetStoreLike;
  private actor = "";
  private kills: string[] = [];
  private talks: string[] = [];
  private pendingTrack: string | null | undefined;
  private elapsed = 0;

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    this.actor = this.param<string>("actor") || this.entityId;
    this.ctx.events?.on("quest.track", (data, meta) => {
      const p = data as { actorId: string; questId: string | null };
      if (!this.store.isAuthority() || p.actorId !== this.actor) return;
      if (meta?.from !== undefined && this.store.get(`owner/${this.actor}`) !== meta.from) return;
      this.pendingTrack = p.questId;
    });
    this.ctx.events?.on(this.param<string>("killEvent"), (data, meta) => {
      if (meta?.from !== undefined || !this.store.isAuthority()) return;
      const p = data as { killerId?: string; victimId?: string };
      if (p.killerId === this.actor && p.victimId) this.kills.push(p.victimId);
    });
    this.ctx.events?.on(NPC_EVENTS.talked, (data, meta) => {
      if (meta?.from !== undefined || !this.store.isAuthority()) return;
      const p = data as { actorId: string; npcId: string };
      if (p.actorId === this.actor) this.talks.push(p.npcId);
    });
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

  static matchesKill(victimId: string, target: string): boolean {
    return victimId === target || victimId.startsWith(`${target}-`) || victimId.includes(`#${target}#`);
  }

  /** A quest with no hand-in NPC pays out the moment it completes. */
  private reward(q: Quest): void {
    if (q.rewardXp) this.ctx.events?.emit("character.xp", { actorId: this.actor, amount: q.rewardXp });
    for (const r of q.rewardItems) this.ctx.events?.emit("inventory.give", { actorId: this.actor, itemId: r.itemId, qty: r.qty });
    const sheet = readSheet(this.store, this.actor);
    if (q.rewardCoins && sheet) this.store.set(sheetKey(this.actor), { ...sheet, coins: sheet.coins + q.rewardCoins });
  }

  override onFixedUpdate(dt: number): void {
    if (!this.store.isAuthority()) return;
    const key = `quests/${this.actor}`;
    let journal = this.store.get(key) as QuestJournal | undefined;
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
      this.elapsed = 0;
      const body = this.ctx.getObject(this.actor);
      const sheet: CharacterSheet | null = readSheet(this.store, this.actor);
      for (const [id, state] of Object.entries(journal.quests)) {
        if (state.status !== "active") continue;
        const q = this.quest(id);
        if (!q) continue;
        for (const o of q.objectives) {
          let amount = 0;
          if (o.kind === "visit" && body && q.area && Math.hypot(body.position.x - q.area.center[0], body.position.z - q.area.center[1]) <= q.area.radius) amount = 1;
          if (o.kind === "kill") amount = this.kills.filter((v) => QuestLog.matchesKill(v, o.target)).length;
          if (o.kind === "talk") amount = this.talks.filter((n) => n === o.target).length;
          if (o.kind === "collect" && sheet) {
            let owned = 0;
            for (const s of Object.values(sheet.items)) if (s.itemId === o.target) owned += s.qty;
            amount = Math.max(0, owned - (journal.quests[id]?.progress[o.id] ?? 0));
          }
          journal = advanceQuest(journal, q, o.id, amount);
        }
        if (journal.quests[id]?.status === "complete") this.reward(q);
      }
      this.kills = [];
      this.talks = [];
    }
    if (journal !== before) this.store.set(key, questJournalSchema.parse(journal));
  }
}
