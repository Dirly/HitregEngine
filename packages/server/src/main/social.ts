import type { PlayerDataBackend, PlayerDataRecord } from "@hitreg/core";

/**
 * Friends — the durable half of the social system (docs/hosting.md →
 * "Parties and friends").
 *
 * A friendship is between CHARACTERS (peer id = character id everywhere in
 * the cluster), stored on the owning account: one `social` player-data
 * record per account, `characters[<characterId>]` holding that character's
 * friends and the requests in flight. Main is the only writer and the
 * backend is compare-and-swap on revision, so a request that touches two
 * accounts is two writes, each retried on conflict; the pair is repaired
 * on read (an `outgoing` with no matching `incoming` is dropped when the
 * other side answers, never shown twice).
 *
 * Parties are not here: they are session state on main (`Party` in
 * main.ts) and die with the process, which is what a party is.
 */

export const SOCIAL_NAMESPACE = "social";
export const MAX_FRIENDS = 100;
export const MAX_PENDING = 50;

export interface FriendRef {
  characterId: string;
  name: string;
  /** Owning account — where that character's own social record lives. */
  playerId: string;
}

export interface CharacterSocial {
  friends: FriendRef[];
  /** Requests others sent this character. */
  incoming: FriendRef[];
  /** Requests this character sent. */
  outgoing: FriendRef[];
}

export interface SocialRecord {
  characters: Record<string, CharacterSocial>;
}

function empty(): CharacterSocial {
  return { friends: [], incoming: [], outgoing: [] };
}

/** The character's slice of a record, created on demand. */
export function socialOf(record: SocialRecord, characterId: string): CharacterSocial {
  return (record.characters[characterId] ??= empty());
}

const has = (list: readonly FriendRef[], id: string): boolean => list.some((f) => f.characterId === id);
const without = (list: readonly FriendRef[], id: string): FriendRef[] => list.filter((f) => f.characterId !== id);

export class SocialStore {
  constructor(
    private readonly backend: PlayerDataBackend,
    private readonly experienceId: string,
  ) {}

  async load(playerId: string): Promise<SocialRecord> {
    const record = await this.backend.load({ playerId, experienceId: this.experienceId }, SOCIAL_NAMESPACE);
    return record ? (record.data as unknown as SocialRecord) : { characters: {} };
  }

  /** Read-modify-write with compare-and-swap; the mutation runs again on a conflict. */
  async mutate(playerId: string, fn: (record: SocialRecord) => void): Promise<SocialRecord> {
    const scope = { playerId, experienceId: this.experienceId };
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.backend.load(scope, SOCIAL_NAMESPACE);
      const record: SocialRecord = current ? (structuredClone(current.data) as unknown as SocialRecord) : { characters: {} };
      if (!record.characters) record.characters = {};
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
    throw new Error("social record: too many concurrent writes");
  }

  /** `from` asks `to` to be friends. Returns what happened, for the caller to tell both sides. */
  async request(from: FriendRef, to: FriendRef): Promise<"sent" | "already-friends" | "already-sent" | "accepted" | "full"> {
    if (from.characterId === to.characterId) throw new SocialError("you cannot befriend yourself");
    const mine = socialOf(await this.load(from.playerId), from.characterId);
    if (has(mine.friends, to.characterId)) return "already-friends";
    if (has(mine.outgoing, to.characterId)) return "already-sent";
    if (mine.friends.length >= MAX_FRIENDS) return "full";
    // they asked first: that is an acceptance, not a second request
    if (has(mine.incoming, to.characterId)) {
      await this.accept(from, to);
      return "accepted";
    }
    if (mine.outgoing.length >= MAX_PENDING) throw new SocialError("too many requests waiting");
    await this.mutate(from.playerId, (r) => {
      const s = socialOf(r, from.characterId);
      if (!has(s.outgoing, to.characterId)) s.outgoing.push(to);
    });
    await this.mutate(to.playerId, (r) => {
      const s = socialOf(r, to.characterId);
      if (!has(s.incoming, from.characterId) && !has(s.friends, from.characterId)) s.incoming.push(from);
    });
    return "sent";
  }

  /** `me` accepts `other`'s request (also used when both asked). */
  async accept(me: FriendRef, other: FriendRef): Promise<void> {
    await this.mutate(me.playerId, (r) => {
      const s = socialOf(r, me.characterId);
      s.incoming = without(s.incoming, other.characterId);
      s.outgoing = without(s.outgoing, other.characterId);
      if (!has(s.friends, other.characterId)) s.friends.push(other);
    });
    await this.mutate(other.playerId, (r) => {
      const s = socialOf(r, other.characterId);
      s.outgoing = without(s.outgoing, me.characterId);
      s.incoming = without(s.incoming, me.characterId);
      if (!has(s.friends, me.characterId)) s.friends.push(me);
    });
  }

  /** `me` declines (or withdraws) a request with `other`. */
  async decline(me: FriendRef, other: FriendRef): Promise<void> {
    await this.mutate(me.playerId, (r) => {
      const s = socialOf(r, me.characterId);
      s.incoming = without(s.incoming, other.characterId);
      s.outgoing = without(s.outgoing, other.characterId);
    });
    await this.mutate(other.playerId, (r) => {
      const s = socialOf(r, other.characterId);
      s.outgoing = without(s.outgoing, me.characterId);
      s.incoming = without(s.incoming, me.characterId);
    });
  }

  /** Both sides forget each other. */
  async remove(me: FriendRef, other: FriendRef): Promise<void> {
    await this.mutate(me.playerId, (r) => {
      const s = socialOf(r, me.characterId);
      s.friends = without(s.friends, other.characterId);
    });
    await this.mutate(other.playerId, (r) => {
      const s = socialOf(r, other.characterId);
      s.friends = without(s.friends, me.characterId);
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
