import { Script } from "@hitreg/scripting";

/**
 * Smallest possible persistence demo: counts play sessions across reloads via
 * ctx.playerData (experience-scoped, revisioned, quota-enforced — see
 * ARCHITECTURE.md §3c). Attach to any entity and press play twice.
 */
export default class SessionCounter extends Script {
  static override scriptName = "session-counter";
  static override params = {
    namespace: { default: "stats", description: "playerData namespace to count in" },
  };

  override onStart(): void {
    void this.ctx.playerData
      ?.increment(this.param<string>("namespace"), "sessions")
      .then((n) => console.log(`[session-counter] play session #${n} — persisted across reloads`))
      .catch((error) => console.warn("[session-counter]", error));
  }
}
