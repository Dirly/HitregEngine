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
import type { CharacterBuild } from "@hitreg/core";

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export interface CharacterRecord {
  id: string;
  name: string;
  createdAt: string;
  /** Character-creation choices (archetype, birth traits, appearance). Absent on characters made before creation existed. */
  build?: CharacterBuild;
  /**
   * When its owner deleted it (ISO time). A deleted character cannot be played and is not listed with the others,
   * but it can be restored for DELETE_GRACE_DAYS and keeps its name reserved meanwhile; after that it is purged.
   */
  deletedAt?: string;
  /**
   * The WORLD it lives on (a main server's world id). One character per account per world (Derek, 2026-10-07);
   * absent on characters made before worlds existed — they belong to the world that reads them.
   */
  world?: string;
  /** Server-owned save identity. Old characters keep the account save; new ones get their own character id. */
  saveId?: string;
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
  /** Replace the record; an expected record makes this an atomic compare-and-swap across world servers. */
  update(record: AccountRecord, expected?: AccountRecord): Promise<boolean>;
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
/** Days a deleted character can be restored before it is gone for good. */
export const DELETE_GRACE_DAYS = 7;

/** The world a character lives on: its own, else the reading world (characters made before worlds existed). */
export function worldOf(character: CharacterRecord, defaultWorld: string): string {
  return character.world ?? defaultWorld;
}

/** The characters an account can play (not deleted). */
export function liveCharacters(record: AccountRecord): CharacterRecord[] {
  return record.characters.filter((c) => !c.deletedAt);
}

/** Deleted characters still inside the grace window (restorable). */
export function restorableCharacters(record: AccountRecord, now = Date.now()): CharacterRecord[] {
  return record.characters.filter((c) => c.deletedAt && now - Date.parse(c.deletedAt) < DELETE_GRACE_DAYS * 86_400_000);
}

/** Drop deleted characters past the grace window; true when anything was dropped (the record needs saving). */
export function purgeDeleted(record: AccountRecord, now = Date.now()): boolean {
  const keep = record.characters.filter((c) => !c.deletedAt || now - Date.parse(c.deletedAt) < DELETE_GRACE_DAYS * 86_400_000);
  if (keep.length === record.characters.length) return false;
  record.characters = keep;
  return true;
}

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
  update(record: AccountRecord, expected?: AccountRecord): Promise<boolean> {
    if (expected && JSON.stringify(this.byId.get(record.id)) !== JSON.stringify(expected)) return Promise.resolve(false);
    this.byId.set(record.id, structuredClone(record));
    return Promise.resolve(true);
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
