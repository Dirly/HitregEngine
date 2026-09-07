import { randomBytes } from "node:crypto";
import type { PlayerDataBackend, PlayerDataRecord } from "@hitreg/core";
import { SocialError, type FriendRef, type SocialStore } from "./social.js";

/**
 * Guilds — durable, named, ranked (docs/hosting.md → "Parties and friends").
 *
 * A guild is a CHARACTER's (like a party; an account can be in several
 * guilds through its characters). It lives in the player-data backend
 * under a synthetic scope — player id = the guild id (`gld-…`) — with a name
 * index at `guilds-index` / `index`, so the same compare-and-swap store main already
 * owns keeps guild names unique and every write atomic. A member's own
 * social record carries the membership (`guilds[characterId]`) so login
 * finds it without a scan.
 *
 * Ranks: leader (one), officer (invite, kick members, set the message of
 * the day), member. The leader may promote, demote, hand over, disband.
 * When the leader leaves, the oldest officer — else the oldest member —
 * leads; an empty guild is disbanded.
 */

export type GuildRank = "leader" | "officer" | "member";

export interface GuildMember {
  characterId: string;
  name: string;
  playerId: string;
  rank: GuildRank;
  joinedAt: string;
}

export interface GuildRecord {
  id: string;
  name: string;
  leader: string;
  members: Record<string, GuildMember>;
  motd: string;
  createdAt: string;
  disbanded?: boolean;
}

export const GUILD_NAME = /^[A-Za-z][A-Za-z' -]{2,30}[A-Za-z]$/;
export const MAX_GUILD_MEMBERS = 200;
export const GUILD_NAMESPACE = "guild";
const INDEX_SCOPE_ID = "guilds-index";
const INDEX_NAMESPACE = "index";

interface GuildIndex {
  byName: Record<string, string>;
}

const RANK_ORDER: Record<GuildRank, number> = { leader: 2, officer: 1, member: 0 };
export const rankAbove = (a: GuildRank, b: GuildRank): boolean => RANK_ORDER[a] > RANK_ORDER[b];

export class GuildStore {
  constructor(
    private readonly backend: PlayerDataBackend,
    private readonly experienceId: string,
    private readonly social: SocialStore,
  ) {}

  private scope(id: string) {
    // the id itself ("gld-…"): a file-backed store rejects a colon in a scope id
    return { playerId: id, experienceId: this.experienceId };
  }

  async load(id: string): Promise<GuildRecord | null> {
    const r = await this.backend.load(this.scope(id), GUILD_NAMESPACE);
    const g = r ? (r.data as unknown as GuildRecord) : null;
    return g && !g.disbanded ? g : null;
  }

  private async write<T>(scope: { playerId: string; experienceId: string }, namespace: string, initial: T, fn: (v: T) => void): Promise<T> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.backend.load(scope, namespace);
      const value = current ? (structuredClone(current.data) as unknown as T) : structuredClone(initial);
      fn(value);
      const next: PlayerDataRecord = {
        schemaVersion: current?.schemaVersion ?? 1,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
        data: value as unknown as Record<string, unknown>,
      };
      if ((await this.backend.store(scope, namespace, next, current?.revision ?? null)) === "ok") return value;
    }
    throw new SocialError("guild record: too many concurrent writes", 503);
  }

  async mutate(id: string, fn: (g: GuildRecord) => void): Promise<GuildRecord> {
    const g = await this.write<GuildRecord | null>(this.scope(id), GUILD_NAMESPACE, null, (v) => {
      if (!v || v.disbanded) throw new SocialError("no such guild", 404);
      fn(v);
    });
    return g!;
  }

  async idByName(name: string): Promise<string | null> {
    const r = await this.backend.load({ playerId: INDEX_SCOPE_ID, experienceId: this.experienceId }, INDEX_NAMESPACE);
    const index = r ? (r.data as unknown as GuildIndex) : null;
    return index?.byName[name.toLowerCase()] ?? null;
  }

  /** Found a guild: reserve the name, write the record, mark the founder's character. */
  async create(name: string, founder: FriendRef): Promise<GuildRecord> {
    if (!GUILD_NAME.test(name)) throw new SocialError("guild name: 4-32 letters (spaces, ' and - allowed)");
    // short enough for the comms membership key (32 chars): "gld-" + 12 hex
    const id = `gld-${randomBytes(6).toString("hex")}`;
    await this.write<GuildIndex>({ playerId: INDEX_SCOPE_ID, experienceId: this.experienceId }, INDEX_NAMESPACE, { byName: {} }, (index) => {
      if (index.byName[name.toLowerCase()]) throw new SocialError(`a guild called "${name}" already exists`, 409);
      index.byName[name.toLowerCase()] = id;
    });
    const now = new Date().toISOString();
    const record: GuildRecord = {
      id,
      name,
      leader: founder.characterId,
      members: { [founder.characterId]: { characterId: founder.characterId, name: founder.characterName, playerId: founder.playerId, rank: "leader", joinedAt: now } },
      motd: "",
      createdAt: now,
    };
    await this.write<GuildRecord>(this.scope(id), GUILD_NAMESPACE, record, () => undefined);
    await this.social.setGuild(founder.playerId, founder.characterId, { id, name, rank: "leader" });
    return record;
  }

  async addMember(id: string, who: FriendRef): Promise<GuildRecord> {
    const g = await this.mutate(id, (guild) => {
      if (Object.keys(guild.members).length >= MAX_GUILD_MEMBERS) throw new SocialError("guild is full");
      guild.members[who.characterId] ??= { characterId: who.characterId, name: who.characterName, playerId: who.playerId, rank: "member", joinedAt: new Date().toISOString() };
    });
    await this.social.setGuild(who.playerId, who.characterId, { id, name: g.name, rank: "member" });
    return g;
  }

  /**
   * Remove a member (leave, kick). The leadership moves to the oldest
   * officer, else the oldest member; an empty guild is disbanded and its
   * name freed. Returns the guild after, and who leads now if that changed.
   */
  async removeMember(id: string, characterId: string): Promise<{ guild: GuildRecord; newLeader: GuildMember | null; disbanded: boolean }> {
    const before = await this.load(id);
    const leaving = before?.members[characterId];
    if (!before || !leaving) throw new SocialError("not a member of that guild");
    const out = { newLeader: null as GuildMember | null, disbanded: false };
    const g = await this.mutate(id, (guild) => {
      if (!guild.members[characterId]) throw new SocialError("not a member of that guild");
      delete guild.members[characterId];
      const rest = Object.values(guild.members).sort((a, b) => RANK_ORDER[b.rank] - RANK_ORDER[a.rank] || a.joinedAt.localeCompare(b.joinedAt));
      if (rest.length === 0) {
        guild.disbanded = true;
        out.disbanded = true;
      } else if (guild.leader === characterId) {
        const next = rest[0]!;
        next.rank = "leader";
        guild.leader = next.characterId;
        out.newLeader = next;
      }
    });
    if (out.disbanded) await this.freeName(g.name, id);
    await this.social.setGuild(leaving.playerId, characterId, null);
    if (out.newLeader) await this.social.setGuild(out.newLeader.playerId, out.newLeader.characterId, { id, name: g.name, rank: "leader" });
    return { guild: g, newLeader: out.newLeader, disbanded: out.disbanded };
  }

  async setRank(id: string, characterId: string, rank: Exclude<GuildRank, "leader">): Promise<GuildRecord> {
    let playerId = "";
    const g = await this.mutate(id, (guild) => {
      const m = guild.members[characterId];
      if (!m) throw new SocialError("not a member of that guild");
      if (m.rank === "leader") throw new SocialError("the leader's rank changes by handing the guild over");
      m.rank = rank;
      playerId = m.playerId;
    });
    await this.social.setGuild(playerId, characterId, { id, name: g.name, rank });
    return g;
  }

  async setLeader(id: string, characterId: string): Promise<{ guild: GuildRecord; previous: GuildMember }> {
    let previous: GuildMember | null = null;
    let next: GuildMember | null = null;
    const g = await this.mutate(id, (guild) => {
      const m = guild.members[characterId];
      if (!m) throw new SocialError("not a member of that guild");
      previous = guild.members[guild.leader]!;
      previous.rank = "officer";
      m.rank = "leader";
      guild.leader = characterId;
      next = m;
    });
    await this.social.setGuild(previous!.playerId, previous!.characterId, { id, name: g.name, rank: "officer" });
    await this.social.setGuild(next!.playerId, next!.characterId, { id, name: g.name, rank: "leader" });
    return { guild: g, previous: previous! };
  }

  async setMotd(id: string, text: string): Promise<GuildRecord> {
    return this.mutate(id, (guild) => {
      guild.motd = text.slice(0, 240);
    });
  }

  /** The leader dissolves the guild: every member's record is cleared, the name freed. */
  async disband(id: string): Promise<GuildRecord> {
    const g = await this.mutate(id, (guild) => {
      guild.disbanded = true;
    });
    for (const m of Object.values(g.members)) await this.social.setGuild(m.playerId, m.characterId, null);
    await this.freeName(g.name, id);
    return g;
  }

  private async freeName(name: string, id: string): Promise<void> {
    await this.write<GuildIndex>({ playerId: INDEX_SCOPE_ID, experienceId: this.experienceId }, INDEX_NAMESPACE, { byName: {} }, (index) => {
      if (index.byName[name.toLowerCase()] === id) delete index.byName[name.toLowerCase()];
    });
  }
}
