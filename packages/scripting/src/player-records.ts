import { PERSISTED_PLAYER_NAMESPACES } from "@hitreg/core";
import { Script } from "./script.js";
import { sheetStoreOf, type SheetStoreLike } from "./character-store.js";

/**
 * Local-play saves for the per-character records a dedicated server commits
 * beside the sheet — the quest journal (`quests/`), NPC memory (`npc/`) and the
 * vault (`vault/`): restored into netState on start, written back through
 * ctx.playerData (namespace "records") a moment after each change.
 *
 * Only for the LOCAL player on a session that is its own authority (the
 * editor's play mode, a solo tab). On a dedicated server the server restores
 * and commits these itself and this does nothing.
 */
export class PlayerRecords extends Script {
  static override scriptName = "player-records";
  static override params = {
    actor: { default: "", description: "body entity id whose records to keep; empty = this entity" },
  };

  private store!: SheetStoreLike;
  private actor = "";
  private dirty = new Set<string>();
  private wait = 0;
  private live = false;

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    this.actor = this.param<string>("actor") || this.entityId;
    if (!this.ctx.playerData || !this.store.isAuthority() || this.ctx.localPlayer?.() !== this.actor) return;
    void this.restore();
  }

  private async restore(): Promise<void> {
    const data = this.ctx.playerData!;
    for (const ns of PERSISTED_PLAYER_NAMESPACES) {
      try {
        const saved = await data.get("records", ns);
        const key = `${ns}/${this.actor}`;
        if (saved !== undefined && saved !== null && this.store.get(key) === undefined && !this.store.set(key, saved)) {
          console.warn(`[player-records] saved ${ns} failed validation — starting fresh`);
        }
      } catch (error) {
        console.warn(`[player-records] could not restore ${ns}`, error);
      }
    }
    this.live = true;
    this.store.onChange((key) => {
      const slash = key.indexOf("/");
      const ns = key.slice(0, slash);
      if (key.slice(slash + 1) === this.actor && (PERSISTED_PLAYER_NAMESPACES as readonly string[]).includes(ns)) this.dirty.add(ns);
    });
  }

  override onFixedUpdate(dt: number): void {
    if (!this.live || this.dirty.size === 0) return;
    this.wait += dt;
    if (this.wait < 1) return;
    this.wait = 0;
    for (const ns of this.dirty) {
      const value = this.store.get(`${ns}/${this.actor}`);
      if (value !== undefined) void this.ctx.playerData!.set("records", ns, structuredClone(value)).catch((e: unknown) => console.warn(`[player-records] save ${ns} failed`, e));
    }
    this.dirty.clear();
  }
}
