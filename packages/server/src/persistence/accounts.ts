/**
 * Accounts — ARCHITECTURE §3c category 1, the platform side. A hobbyist
 * deployment needs exactly this much: a name, a password hash, and the
 * characters the account owns. No email, no OAuth; add them behind the
 * same interface when the day comes.
 *
 * Passwords: scrypt from node:crypto (no dependency), per-account salt,
 * constant-time compare. Account and character ids are also peer ids on a
 * layer, so they must satisfy the transport's id shape (`[A-Za-z0-9_-]{3,64}`).
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export interface CharacterRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface AccountRecord {
  id: string;
  name: string;
  /** Lower-cased login key. */
  nameLower: string;
  salt: string;
  hash: string;
  createdAt: string;
  characters: CharacterRecord[];
}

export interface AccountStore {
  /** By login name (case-insensitive). */
  find(name: string): Promise<AccountRecord | null>;
  /** By id. */
  get(id: string): Promise<AccountRecord | null>;
  /** Create; "taken" when the name exists. */
  create(record: AccountRecord): Promise<"ok" | "taken">;
  /** Replace the whole record (characters changed). */
  update(record: AccountRecord): Promise<void>;
  /** A character by NAME (case-insensitive) with its account — "/friend <name>", "/invite <name>". */
  findCharacter(name: string): Promise<CharacterMatch | null>;
  /** A character by id with its account — the owner of a friend, the name of a party member. */
  findCharacterById(id: string): Promise<CharacterMatch | null>;
}

export interface CharacterMatch {
  account: AccountRecord;
  character: CharacterRecord;
}

/** The match inside one record, or null. */
export function matchCharacter(record: AccountRecord, by: { name?: string; id?: string }): CharacterMatch | null {
  const lower = by.name?.toLowerCase();
  const character = record.characters.find((c) => (by.id !== undefined && c.id === by.id) || (lower !== undefined && c.name.toLowerCase() === lower));
  return character ? { account: record, character } : null;
}

export const ACCOUNT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_ -]{1,22}[A-Za-z0-9_]$/;
export const CHARACTER_NAME = /^[A-Za-z][A-Za-z' -]{1,18}[A-Za-z]$/;
export const MAX_CHARACTERS = 8;

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "x")}`;
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")): Promise<{ salt: string; hash: string }> {
  const key = await scrypt(password, salt, 32);
  return { salt, hash: key.toString("hex") };
}

export async function checkPassword(record: Pick<AccountRecord, "salt" | "hash">, password: string): Promise<boolean> {
  const key = await scrypt(password, record.salt, 32);
  const want = Buffer.from(record.hash, "hex");
  return key.length === want.length && timingSafeEqual(key, want);
}

/** Tests and single-process dev. */
export class MemoryAccountStore implements AccountStore {
  private readonly byId = new Map<string, AccountRecord>();
  private readonly byName = new Map<string, string>();
  find(name: string): Promise<AccountRecord | null> {
    const id = this.byName.get(name.toLowerCase());
    return Promise.resolve(id ? structuredClone(this.byId.get(id)!) : null);
  }
  get(id: string): Promise<AccountRecord | null> {
    const r = this.byId.get(id);
    return Promise.resolve(r ? structuredClone(r) : null);
  }
  create(record: AccountRecord): Promise<"ok" | "taken"> {
    if (this.byName.has(record.nameLower)) return Promise.resolve("taken");
    this.byId.set(record.id, structuredClone(record));
    this.byName.set(record.nameLower, record.id);
    return Promise.resolve("ok");
  }
  update(record: AccountRecord): Promise<void> {
    this.byId.set(record.id, structuredClone(record));
    return Promise.resolve();
  }
  findCharacter(name: string): Promise<CharacterMatch | null> {
    for (const r of this.byId.values()) {
      const m = matchCharacter(r, { name });
      if (m) return Promise.resolve(structuredClone(m));
    }
    return Promise.resolve(null);
  }
  findCharacterById(id: string): Promise<CharacterMatch | null> {
    for (const r of this.byId.values()) {
      const m = matchCharacter(r, { id });
      if (m) return Promise.resolve(structuredClone(m));
    }
    return Promise.resolve(null);
  }
}
