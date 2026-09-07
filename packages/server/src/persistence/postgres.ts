/**
 * Postgres backends — the same two contracts on a real database, for the
 * day one box is not enough or the saves must outlive a disk. Two tables,
 * created on first use; records are JSONB so the schema never needs a
 * migration when a namespace grows a field (that is what `schemaVersion`
 * inside the record is for).
 *
 * Compare-and-swap is one statement: an UPDATE guarded by the expected
 * revision, or an INSERT ... ON CONFLICT DO NOTHING for "must not exist".
 * Connect with `HITREG_DATABASE_URL` or `--database`.
 */

import pg from "pg";
import type { PlayerDataBackend, PlayerDataRecord, PlayerDataScope } from "@hitreg/core";
import { matchCharacter, type CharacterMatch, type AccountRecord, AccountStore } from "./accounts.js";

export class PostgresStore {
  readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 8 });
  }

  /** Create the tables if missing (idempotent, once per process). */
  migrate(): Promise<void> {
    this.ready ??= (async () => {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS hitreg_player_data (
          experience TEXT NOT NULL,
          player     TEXT NOT NULL,
          namespace  TEXT NOT NULL,
          revision   INTEGER NOT NULL,
          record     JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (experience, player, namespace)
        );
        CREATE TABLE IF NOT EXISTS hitreg_accounts (
          id         TEXT PRIMARY KEY,
          name_lower TEXT NOT NULL UNIQUE,
          record     JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
    })();
    return this.ready;
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  get playerData(): PlayerDataBackend {
    return new PostgresPlayerDataBackend(this);
  }

  get accounts(): AccountStore {
    return new PostgresAccountStore(this);
  }
}

class PostgresPlayerDataBackend implements PlayerDataBackend {
  constructor(private readonly db: PostgresStore) {}

  async load(scope: PlayerDataScope, namespace: string): Promise<PlayerDataRecord | null> {
    await this.db.migrate();
    const r = await this.db.pool.query<{ record: PlayerDataRecord }>(
      "SELECT record FROM hitreg_player_data WHERE experience=$1 AND player=$2 AND namespace=$3",
      [scope.experienceId, scope.playerId, namespace],
    );
    return r.rows[0]?.record ?? null;
  }

  async store(scope: PlayerDataScope, namespace: string, record: PlayerDataRecord, expectedRevision: number | null): Promise<"ok" | "conflict"> {
    await this.db.migrate();
    if (expectedRevision === null) {
      const r = await this.db.pool.query(
        "INSERT INTO hitreg_player_data (experience, player, namespace, revision, record) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [scope.experienceId, scope.playerId, namespace, record.revision, JSON.stringify(record)],
      );
      return r.rowCount === 1 ? "ok" : "conflict";
    }
    const r = await this.db.pool.query(
      "UPDATE hitreg_player_data SET revision=$4, record=$5, updated_at=now() WHERE experience=$1 AND player=$2 AND namespace=$3 AND revision=$6",
      [scope.experienceId, scope.playerId, namespace, record.revision, JSON.stringify(record), expectedRevision],
    );
    return r.rowCount === 1 ? "ok" : "conflict";
  }
}

class PostgresAccountStore implements AccountStore {
  constructor(private readonly db: PostgresStore) {}

  async find(name: string): Promise<AccountRecord | null> {
    await this.db.migrate();
    const r = await this.db.pool.query<{ record: AccountRecord }>("SELECT record FROM hitreg_accounts WHERE name_lower=$1", [name.toLowerCase()]);
    return r.rows[0]?.record ?? null;
  }
  async get(id: string): Promise<AccountRecord | null> {
    await this.db.migrate();
    const r = await this.db.pool.query<{ record: AccountRecord }>("SELECT record FROM hitreg_accounts WHERE id=$1", [id]);
    return r.rows[0]?.record ?? null;
  }
  async create(record: AccountRecord): Promise<"ok" | "taken"> {
    await this.db.migrate();
    const r = await this.db.pool.query(
      "INSERT INTO hitreg_accounts (id, name_lower, record) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [record.id, record.nameLower, JSON.stringify(record)],
    );
    return r.rowCount === 1 ? "ok" : "taken";
  }
  async update(record: AccountRecord): Promise<void> {
    await this.db.migrate();
    await this.db.pool.query("UPDATE hitreg_accounts SET record=$2, updated_at=now() WHERE id=$1", [record.id, JSON.stringify(record)]);
  }
  async findCharacter(name: string): Promise<CharacterMatch | null> {
    await this.db.migrate();
    const r = await this.db.pool.query<{ record: AccountRecord }>(
      "SELECT record FROM hitreg_accounts WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(record->'characters') c WHERE lower(c->>'name') = $1) LIMIT 1",
      [name.toLowerCase()],
    );
    return r.rows[0] ? matchCharacter(r.rows[0].record, { name }) : null;
  }
  async findCharacterById(id: string): Promise<CharacterMatch | null> {
    await this.db.migrate();
    const r = await this.db.pool.query<{ record: AccountRecord }>(
      "SELECT record FROM hitreg_accounts WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(record->'characters') c WHERE c->>'id' = $1) LIMIT 1",
      [id],
    );
    return r.rows[0] ? matchCharacter(r.rows[0].record, { id }) : null;
  }
}
