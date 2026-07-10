import type { PlayerDataBackend, PlayerDataRecord, PlayerDataScope } from "@hitreg/core";

/**
 * Dev implementation of the PlayerDataBackend contract: the vite bridge
 * persists records as files under .hitreg/player-data/ (gitignored). The
 * platform backend replaces this with the real service in Phase 3 — scripts
 * never notice, they only ever see ctx.playerData.
 */
export class BridgePlayerDataBackend implements PlayerDataBackend {
  async load(scope: PlayerDataScope, namespace: string): Promise<PlayerDataRecord | null> {
    const res = await fetch(
      `/__hitreg/player-data?experience=${encodeURIComponent(scope.experienceId)}` +
        `&player=${encodeURIComponent(scope.playerId)}&namespace=${encodeURIComponent(namespace)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as PlayerDataRecord | null;
  }

  async store(
    scope: PlayerDataScope,
    namespace: string,
    record: PlayerDataRecord,
    expectedRevision: number | null,
  ): Promise<"ok" | "conflict"> {
    const res = await fetch("/__hitreg/player-data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        experience: scope.experienceId,
        player: scope.playerId,
        namespace,
        record,
        expectedRevision,
      }),
    });
    if (!res.ok) throw new Error(`player-data store failed (${res.status})`);
    const out = (await res.json()) as { ok: boolean };
    return out.ok ? "ok" : "conflict";
  }
}
