/**
 * What a layer saves about a character, and how.
 *
 * Two namespaces in the player-data contract (ARCHITECTURE §3c, category 2):
 *
 *   character  { sheet }                 the `character/<bodyId>` netState value
 *   world      { "pos:<scene>": {position, yaw} }   where the body stood, per scene
 *
 * The layer is the save authority: it reads the sheet the character-sheet
 * script maintains in netState and writes it here; nothing on a client ever
 * commits. Writes are compare-and-swap on revision with a few retries, and
 * the revisions come back so a transfer ticket can bind the destination to
 * them. Deliberately NOT `PlayerDataService`: that class is the SCRIPT-facing
 * API with a per-namespace write budget; a server commit is not a script.
 */

import { playerDataRecordSchema, type PlayerDataBackend, type PlayerDataRecord, type PlayerDataScope } from "@hitreg/core";

export const NS_CHARACTER = "character";
export const NS_WORLD = "world";

export interface PlayerSave {
  sheet: unknown | null;
  position: [number, number, number] | null;
  yaw: number;
  /** Revisions of the records the save came from. */
  rev: Record<string, number>;
}

export interface CommitInput {
  sheet: unknown | undefined;
  scene: string;
  position: [number, number, number] | null;
  yaw: number;
}

export class PlayerStore {
  constructor(
    private readonly backend: PlayerDataBackend,
    private readonly experienceId: string,
    private readonly retries = 4,
  ) {}

  scope(playerId: string): PlayerDataScope {
    return { playerId, experienceId: this.experienceId };
  }

  private async record(playerId: string, namespace: string): Promise<PlayerDataRecord | null> {
    const raw = await this.backend.load(this.scope(playerId), namespace);
    if (!raw) return null;
    const parsed = playerDataRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Load a character's save for `scene`. `atLeast` (from a transfer ticket)
   * names revisions the source committed; a stale read is retried briefly
   * rather than trusted, so two servers never both own an older sheet.
   */
  async load(playerId: string, scene: string, atLeast: Record<string, number> = {}): Promise<PlayerSave> {
    const rev: Record<string, number> = {};
    let character: PlayerDataRecord | null = null;
    let world: PlayerDataRecord | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      [character, world] = await Promise.all([this.record(playerId, NS_CHARACTER), this.record(playerId, NS_WORLD)]);
      const stale =
        ((atLeast[NS_CHARACTER] ?? -1) > (character?.revision ?? -1)) || ((atLeast[NS_WORLD] ?? -1) > (world?.revision ?? -1));
      if (!stale) break;
      if (attempt === this.retries) throw new Error("save not yet at the revision the ticket promised");
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
    if (character) rev[NS_CHARACTER] = character.revision;
    if (world) rev[NS_WORLD] = world.revision;
    const pos = world?.data[`pos:${scene}`] as { position?: unknown; yaw?: unknown } | undefined;
    const position =
      pos && Array.isArray(pos.position) && pos.position.length === 3 && pos.position.every((n) => typeof n === "number" && Number.isFinite(n))
        ? (pos.position as [number, number, number])
        : null;
    return {
      sheet: character?.data["sheet"] ?? null,
      position,
      yaw: typeof pos?.yaw === "number" && Number.isFinite(pos.yaw) ? pos.yaw : 0,
      rev,
    };
  }

  /** Save; returns the new revisions per namespace written. */
  async commit(playerId: string, input: CommitInput): Promise<Record<string, number>> {
    const rev: Record<string, number> = {};
    if (input.sheet !== undefined) {
      rev[NS_CHARACTER] = await this.write(playerId, NS_CHARACTER, (data) => {
        data["sheet"] = input.sheet;
      });
    }
    if (input.position) {
      rev[NS_WORLD] = await this.write(playerId, NS_WORLD, (data) => {
        data[`pos:${input.scene}`] = { position: input.position, yaw: input.yaw };
      });
    }
    return rev;
  }

  private async write(playerId: string, namespace: string, mutate: (data: Record<string, unknown>) => void): Promise<number> {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const current = await this.record(playerId, namespace);
      const data: Record<string, unknown> = structuredClone(current?.data ?? {});
      mutate(data);
      const record: PlayerDataRecord = {
        schemaVersion: current?.schemaVersion ?? 1,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
        data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
      };
      const outcome = await this.backend.store(this.scope(playerId), namespace, record, current ? current.revision : null);
      if (outcome === "ok") return record.revision;
    }
    throw new Error(`player data "${namespace}" for ${playerId} kept conflicting`);
  }
}
