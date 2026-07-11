import { Script } from "@hitreg/scripting";

/**
 * Minimal event-system example: count how many times something enters THIS
 * entity's trigger volume and show it on the billboard.
 *
 * Attach to an entity with `collider: { isTrigger: true }` (plus `billboard: {
 * kind: "text" }` for the label). Events are queued on emit and drained in
 * FIFO order at a fixed point each tick, so handlers here are deterministic —
 * and the runtime auto-unsubscribes ctx.events subscriptions when the script
 * disposes, so no onDispose cleanup is needed.
 */
export default class EventDemo extends Script {
  static override scriptName = "event-demo";
  static override params = {
    label: { default: "hits", description: "Billboard text prefix" },
  };

  private hits = 0;

  override onStart(): void {
    this.ctx.setBillboard?.({ text: `${this.param<string>("label")}: 0` });
    this.ctx.events?.on("trigger.enter", (payload) => {
      const { trigger } = payload as { trigger: string; other: string };
      if (trigger !== this.entityId) return; // someone else's trigger volume
      this.hits += 1;
      this.ctx.setBillboard?.({ text: `${this.param<string>("label")}: ${this.hits}` });
    });
  }
}
