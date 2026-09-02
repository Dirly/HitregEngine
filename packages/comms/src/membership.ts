/**
 * Team / party membership — replicated session facts, kept in netState so
 * every tab agrees and a promoted host inherits them.
 *
 *   comms.team/<peerId>  = "red"
 *   comms.party/<peerId> = "party-7"
 *
 * Game scripts assign membership with the netState API they already have
 * (`ctx.netState.set("comms.team/" + peerId, "red")` on the authority);
 * chat and voice read it through `MembershipSource`. Nothing here is
 * comms-specific state — a scoreboard can read the same keys.
 */

import { z } from "zod";
import type { NetStateStore } from "@hitreg/core";

export const COMMS_NETSTATE = {
  team: "comms.team",
  party: "comms.party",
} as const;

const GROUP_NAME = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, "letters, digits, space, _ or -");

/**
 * Register the membership namespaces on a NetStateStore (so values validate
 * and the namespaces appear in the AI-facing spec). Safe to call once per
 * store; throws on a second call like any duplicate `define`.
 */
export function registerCommsNetState(store: NetStateStore): void {
  store.define(
    COMMS_NETSTATE.team,
    GROUP_NAME.describe(
      "Team name of a player, keyed by peer id (comms.team/<peerId>). Team text/voice chat reaches exactly the peers sharing this value. Authority-written; a peer requests a change through a to-authority event.",
    ),
  );
  store.define(
    COMMS_NETSTATE.party,
    GROUP_NAME.describe(
      "Party name of a player, keyed by peer id (comms.party/<peerId>). Party text/voice chat reaches exactly the peers sharing this value. Authority-written.",
    ),
  );
}

export function isValidGroupName(value: unknown): value is string {
  return GROUP_NAME.safeParse(value).success;
}

export interface MembershipSource {
  teamOf(peerId: string): string | null;
  partyOf(peerId: string): string | null;
  /** Fires when any membership changes (voice re-gates, UI re-labels). */
  onChange(cb: () => void): () => void;
}

/** Membership read from a NetStateStore replica (works on host and peers alike). */
export function netStateMembership(store: NetStateStore): MembershipSource {
  const read = (namespace: string, peerId: string): string | null => {
    const value = store.get(`${namespace}/${peerId}`);
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  return {
    teamOf: (peerId) => read(COMMS_NETSTATE.team, peerId),
    partyOf: (peerId) => read(COMMS_NETSTATE.party, peerId),
    onChange: (cb) =>
      store.onChange((key) => {
        if (key.startsWith(`${COMMS_NETSTATE.team}/`) || key.startsWith(`${COMMS_NETSTATE.party}/`)) {
          cb();
        }
      }),
  };
}

/** In-memory membership for tests and apps without netState. */
export function staticMembership(
  init: { teams?: Record<string, string>; parties?: Record<string, string> } = {},
): MembershipSource & {
  setTeam(peerId: string, team: string | null): void;
  setParty(peerId: string, party: string | null): void;
} {
  const teams = new Map(Object.entries(init.teams ?? {}));
  const parties = new Map(Object.entries(init.parties ?? {}));
  const handlers = new Set<() => void>();
  const notify = () => {
    for (const cb of [...handlers]) cb();
  };
  return {
    teamOf: (id) => teams.get(id) ?? null,
    partyOf: (id) => parties.get(id) ?? null,
    onChange: (cb) => {
      handlers.add(cb);
      return () => {
        handlers.delete(cb);
      };
    },
    setTeam: (id, team) => {
      if (team === null) teams.delete(id);
      else teams.set(id, team);
      notify();
    },
    setParty: (id, party) => {
      if (party === null) parties.delete(id);
      else parties.set(id, party);
      notify();
    },
  };
}
