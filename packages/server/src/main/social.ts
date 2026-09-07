import type { PlayerDataBackend, PlayerDataRecord } from "@hitreg/core";

/**
 * Friends, blocks and guild membership — the durable half of the social
 * system (docs/hosting.md → "Parties and friends").
 *
 * A friendship is between ACCOUNTS: you befriend a person, not one of
 * their characters, and every character on either account sees it. It is
 * made through a character name ("/friend finn" finds Finn's account), and
 * the character it was made through is remembered so a friend who is
 * offline still has a name in the list. One `social` player-data record
 * per account holds friends, requests in flight, the accounts it has
 * blocked, and the guild its characters belong to. Main is the only writer
 * and the backend is compare-and-swap on revision, so a change that touches
 * two accounts is two writes, each retried on conflict.
 *
 * Parties are not here: they are session state on main (`Party` in
 * main.ts) and die with the process, which is what a party is.
 */

export const SOCIAL_NAMESPACE = "social";
export const MAX_FRIENDS = 200;
export const MAX_PENDING = 50;
export const MAX_BLOCKED = 200;

/** Another account, and the character the link was made through (its name is what the list shows while they are offline). */
export interface FriendRef {
  playerId: string;
  characterId: string;
  characterName: string;
}

export interface GuildMembership {
  id: string;
  name: string;
  /** "leader" | "officer" | "member" — the guild record is the authority; this is the login-time hint. */
  rank: string;
}

export interface SocialRecord {
  friends: FriendRef[];
  /** Requests other accounts sent us. */
  incoming: FriendRef[];
  /** Requests we sent. */
  outgoing: FriendRef[];
  /** Accounts we hear nothing from: no requests, no invitations, no chat. */
  blocked: FriendRef[];
  /** Guild per CHARACTER (a guild is a character's, like a party). */
  guilds?: Record<string, GuildMembership>;
}

export function emptySocial(): SocialRecord {
  return { friends: [], incoming: [], outgoing: [], blocked: [], guilds: {} };
}

/** A stored record with every list present (older records may lack some). */
export function normalizeSocial(data: unknown): SocialRecord {
  const d = (data ?? {}) as Partial<SocialRecord>;
  return {
    friends: Array.isArray(d.friends) ? d.friends : [],
    incoming: Array.isArray(d.incoming) ? d.incoming : [],
    outgoing: Array.isArray(d.outgoing) ? d.outgoing : [],
    blocked: Array.isArray(d.blocked) ? d.blocked : [],
    guilds: d.guilds && typeof d.guilds === "object" ? d.guilds : {},
  };
}

const has = (list: readonly FriendRef[], playerId: string): boolean => list.some((f) => f.playerId === playerId);
const without = (list: readonly FriendRef[], playerId: string): FriendRef[] => list.filter((f) => f.playerId !== playerId);

export function isBlocked(record: SocialRecord, playerId: string): boolean {
  return has(record.blocked, playerId);
}

export type RequestOutcome = "sent" | "already-friends" | "already-sent" | "accepted" | "full" | "unavailable";

export class SocialStore {
  constructor(
    private readonly backend: PlayerDataBackend,
    private readonly experienceId: string,
  ) {}

  async load(playerId: string): Promise<SocialRecord> {
    const record = await this.backend.load({ playerId, experienceId: this.experienceId }, SOCIAL_NAMESPACE);
    return normalizeSocial(record?.data);
  }

  /** Read-modify-write with compare-and-swap; the mutation runs again on a conflict. */
  async mutate(playerId: string, fn: (record: SocialRecord) => void): Promise<SocialRecord> {
    const scope = { playerId, experienceId: this.experienceId };
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.backend.load(scope, SOCIAL_NAMESPACE);
      const record = normalizeSocial(current ? structuredClone(current.data) : undefined);
      fn(record);
      const next: PlayerDataRecord = {
        schemaVersion: current?.schemaVersion ?? 1,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
        data: record as unknown as Record<string, unknown>,
      };
      const outcome = await this.backend.store(scope, SOCIAL_NAMESPACE, next, current?.revision ?? null);
      if (outcome === "ok") return record;
    }
    throw new SocialError("social record: too many concurrent writes", 503);
  }

  /**
   * `from` asks `to` to be friends. A block either way answers "unavailable"
   * without saying which side — the blocked one never learns they are.
   */
  async request(from: FriendRef, to: FriendRef): Promise<RequestOutcome> {
    if (from.playerId === to.playerId) throw new SocialError("that is you");
    const mine = await this.load(from.playerId);
    if (isBlocked(mine, to.playerId)) throw new SocialError(`you have blocked ${to.characterName}`);
    if (has(mine.friends, to.playerId)) return "already-friends";
    if (has(mine.outgoing, to.playerId)) return "already-sent";
    if (mine.friends.length >= MAX_FRIENDS) return "full";
    const theirs = await this.load(to.playerId);
    if (isBlocked(theirs, from.playerId)) return "unavailable";
    // they asked first: that is an acceptance, not a second request
    if (has(mine.incoming, to.playerId)) {
      await this.accept(from, to);
      return "accepted";
    }
    if (mine.outgoing.length >= MAX_PENDING) throw new SocialError("too many requests waiting");
    await this.mutate(from.playerId, (r) => {
      if (!has(r.outgoing, to.playerId)) r.outgoing.push(to);
    });
    await this.mutate(to.playerId, (r) => {
      if (!has(r.incoming, from.playerId) && !has(r.friends, from.playerId)) r.incoming.push(from);
    });
    return "sent";
  }

  /** `me` accepts `other`'s request (also used when both asked). */
  async accept(me: FriendRef, other: FriendRef): Promise<void> {
    const mine = await this.load(me.playerId);
    if (!has(mine.incoming, other.playerId) && !has(mine.friends, other.playerId)) throw new SocialError("no such friend request", 404);
    await this.mutate(me.playerId, (r) => {
      r.incoming = without(r.incoming, other.playerId);
      r.outgoing = without(r.outgoing, other.playerId);
      if (!has(r.friends, other.playerId)) r.friends.push(other);
    });
    await this.mutate(other.playerId, (r) => {
      r.outgoing = without(r.outgoing, me.playerId);
      r.incoming = without(r.incoming, me.playerId);
      if (!has(r.friends, me.playerId)) r.friends.push(me);
    });
  }

  /** `me` declines (or withdraws) a request with `other`. */
  async decline(me: FriendRef, other: FriendRef): Promise<void> {
    await this.mutate(me.playerId, (r) => {
      r.incoming = without(r.incoming, other.playerId);
      r.outgoing = without(r.outgoing, other.playerId);
    });
    await this.mutate(other.playerId, (r) => {
      r.outgoing = without(r.outgoing, me.playerId);
      r.incoming = without(r.incoming, me.playerId);
    });
  }

  /** Both sides forget each other. */
  async remove(me: FriendRef, other: FriendRef): Promise<void> {
    await this.mutate(me.playerId, (r) => {
      r.friends = without(r.friends, other.playerId);
    });
    await this.mutate(other.playerId, (r) => {
      r.friends = without(r.friends, me.playerId);
    });
  }

  /** `me` blocks `other`: the friendship and any request go, and nothing from them reaches `me` again. */
  async block(me: FriendRef, other: FriendRef): Promise<void> {
    if (me.playerId === other.playerId) throw new SocialError("that is you");
    const mine = await this.load(me.playerId);
    if (mine.blocked.length >= MAX_BLOCKED) throw new SocialError("block list is full");
    await this.mutate(me.playerId, (r) => {
      r.friends = without(r.friends, other.playerId);
      r.incoming = without(r.incoming, other.playerId);
      r.outgoing = without(r.outgoing, other.playerId);
      if (!has(r.blocked, other.playerId)) r.blocked.push(other);
    });
    await this.mutate(other.playerId, (r) => {
      r.friends = without(r.friends, me.playerId);
      r.incoming = without(r.incoming, me.playerId);
      r.outgoing = without(r.outgoing, me.playerId);
    });
  }

  async unblock(me: FriendRef, other: FriendRef): Promise<boolean> {
    let was = false;
    await this.mutate(me.playerId, (r) => {
      was = has(r.blocked, other.playerId);
      r.blocked = without(r.blocked, other.playerId);
    });
    return was;
  }

  async setGuild(playerId: string, characterId: string, guild: GuildMembership | null): Promise<void> {
    await this.mutate(playerId, (r) => {
      r.guilds ??= {};
      if (guild) r.guilds[characterId] = guild;
      else delete r.guilds[characterId];
    });
  }
}

export class SocialError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
