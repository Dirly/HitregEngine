/**
 * File backends — the zero-ops choice for a home box or a single VPS.
 *
 * One JSON file per record, written to a temp name and renamed so a crash
 * mid-write never leaves a half record as the save. Compare-and-swap on
 * revision is honoured (the main server is the only writer, so an in-process
 * lock per key is a real lock). Layout under `dir`:
 *
 *   accounts/by-name/<nameLower>.json     → { id }
 *   accounts/<id>.json                    → AccountRecord
 *   player-data/<experience>/<player>/<namespace>.json → PlayerDataRecord
 *
 * Back it up with `tar` — that is the whole ops story.
 */

import fs from "node:fs";
import path from "node:path";
import type { PlayerDataBackend, PlayerDataRecord, PlayerDataScope } from "@hitreg/core";
import { matchCharacter, type AccountRecord, type AccountStore, type CharacterMatch } from "./accounts.js";

const SAFE = /^[A-Za-z0-9_.-]{1,64}$/;

function safe(segment: string): string {
  if (!SAFE.test(segment)) throw new Error(`unsafe path segment: ${JSON.stringify(segment)}`);
  return segment;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Serialise operations per key so CAS is exact. */
class KeyLocks {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(key, next.catch(() => undefined));
    return next;
  }
}

export class FilePlayerDataBackend implements PlayerDataBackend {
  private readonly locks = new KeyLocks();
  constructor(readonly dir: string) {}

  private file(scope: PlayerDataScope, namespace: string): string {
    return path.join(this.dir, "player-data", safe(scope.experienceId), safe(scope.playerId), `${safe(namespace)}.json`);
  }

  load(scope: PlayerDataScope, namespace: string): Promise<PlayerDataRecord | null> {
    const file = this.file(scope, namespace);
    return this.locks.run(file, () => readJson<PlayerDataRecord>(file));
  }

  store(scope: PlayerDataScope, namespace: string, record: PlayerDataRecord, expectedRevision: number | null): Promise<"ok" | "conflict"> {
    const file = this.file(scope, namespace);
    return this.locks.run(file, () => {
      const current = readJson<PlayerDataRecord>(file);
      const have = current ? current.revision : null;
      if (have !== expectedRevision) return "conflict" as const;
      writeJsonAtomic(file, record);
      return "ok" as const;
    });
  }
}

export class FileAccountStore implements AccountStore {
  private readonly locks = new KeyLocks();
  constructor(readonly dir: string) {}

  private byId(id: string): string {
    return path.join(this.dir, "accounts", `${safe(id)}.json`);
  }
  private byName(nameLower: string): string {
    return path.join(this.dir, "accounts", "by-name", `${safe(nameLower.replace(/ /g, "_"))}.json`);
  }

  async find(name: string): Promise<AccountRecord | null> {
    const ptr = readJson<{ id: string }>(this.byName(name.toLowerCase()));
    return ptr ? this.get(ptr.id) : null;
  }
  get(id: string): Promise<AccountRecord | null> {
    return Promise.resolve(readJson<AccountRecord>(this.byId(id)));
  }
  create(record: AccountRecord): Promise<"ok" | "taken"> {
    const nameFile = this.byName(record.nameLower);
    return this.locks.run(nameFile, () => {
      if (readJson(nameFile)) return "taken" as const;
      writeJsonAtomic(this.byId(record.id), record);
      writeJsonAtomic(nameFile, { id: record.id });
      return "ok" as const;
    });
  }
  update(record: AccountRecord): Promise<void> {
    const file = this.byId(record.id);
    return this.locks.run(file, () => {
      writeJsonAtomic(file, record);
    });
  }
  /** Scan every account file — hobby scale; an index would be a premature file to keep in sync. */
  private scan(by: { name?: string; id?: string }): CharacterMatch | null {
    const dir = path.join(this.dir, "accounts");
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const record = readJson<AccountRecord>(path.join(dir, entry));
      const m = record ? matchCharacter(record, by) : null;
      if (m) return m;
    }
    return null;
  }
  findCharacter(name: string): Promise<CharacterMatch | null> {
    return Promise.resolve(this.scan({ name }));
  }
  findCharacterById(id: string): Promise<CharacterMatch | null> {
    return Promise.resolve(this.scan({ id }));
  }
}
