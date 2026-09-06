/**
 * Communication channels — shared by text chat and voice.
 *
 * - "proximity": heard by players within a radius of the speaker ("say").
 * - "zone":      heard by every player in the speaker's world ZONE — across
 *                every layer of the cluster when a bridge is mounted. The
 *                answer to "the world is vast and I never see the other 40":
 *                everyone standing in the same region talks, whichever copy
 *                of the world they are on.
 * - "global":    everyone in the session (bridged across layers too).
 * - "team":      players sharing the speaker's team (netState `comms.team/*`).
 * - "party":     players sharing the speaker's party (netState `comms.party/*`);
 *                bridged across layers too — on a cluster, main owns the party
 *                list and pushes each member's party into their layer's netState.
 *
 * The routing rule for each lives in ONE place (`recipientsFor` below) so
 * text and voice can never disagree about who is allowed to hear whom.
 * Voice never offers a `zoneOf`, so zone voice is refused by construction —
 * a zone is a text room, not a hundred open mics.
 */

export type CommsChannel = "proximity" | "zone" | "global" | "team" | "party";

export const COMMS_CHANNELS: readonly CommsChannel[] = ["proximity", "zone", "global", "team", "party"];

/** Channels a cluster bridge carries between layers (what one copy of the world says, every copy hears). */
export const BRIDGED_CHANNELS: readonly CommsChannel[] = ["zone", "global", "party"];

/** What travels with a bridged line so the receiving layer can route it: the sender's zone and party (only the origin — or main — knows them). */
export interface BridgeScope {
  zone: string | null;
  party?: string | null;
}

export interface ChannelMeta {
  /** Short UI label. */
  label: string;
  /**
   * Text glyph shown beside the label — meaning is never carried by color
   * alone (WCAG / colorblind-safe): "[S]ay", "[Z]one", "[G]lobal", "[T]eam", "[P]arty".
   */
  glyph: string;
  /** Slash-prefixes that select this channel for one message ("/t hello"). */
  prefixes: readonly string[];
}

// Channel prefixes are the SHORT forms only: "/team red" and "/party blue"
// are membership commands, so the long words can't double as channels.
export const CHANNEL_META: Readonly<Record<CommsChannel, ChannelMeta>> = {
  proximity: { label: "say", glyph: "[S]", prefixes: ["/s", "/say", "/l"] },
  zone: { label: "zone", glyph: "[Z]", prefixes: ["/z", "/zone"] },
  global: { label: "global", glyph: "[G]", prefixes: ["/g", "/all"] },
  team: { label: "team", glyph: "[T]", prefixes: ["/t"] },
  party: { label: "party", glyph: "[P]", prefixes: ["/p"] },
};

export function isCommsChannel(value: unknown): value is CommsChannel {
  return typeof value === "string" && (COMMS_CHANNELS as readonly string[]).includes(value);
}

/** The channel a slash prefix selects, or null if the word isn't one. */
export function channelForPrefix(word: string): CommsChannel | null {
  const lower = word.toLowerCase();
  for (const channel of COMMS_CHANNELS) {
    if (CHANNEL_META[channel].prefixes.includes(lower)) return channel;
  }
  return null;
}

export type ParsedChatInput =
  | { kind: "message"; channel: CommsChannel; text: string }
  | { kind: "command"; name: string; args: string[] }
  | { kind: "empty" };

/**
 * Parse what the player typed. A channel prefix ("/t go left") selects the
 * channel for that message only; a bare prefix ("/t") is a command the UI
 * treats as "switch my active channel"; any other slash word is a command
 * for the app (e.g. "/party red"). Everything else is a message on
 * `activeChannel`.
 */
export function parseChatInput(raw: string, activeChannel: CommsChannel): ParsedChatInput {
  const text = raw.trim();
  if (text.length === 0) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "message", channel: activeChannel, text };
  const space = text.indexOf(" ");
  const word = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? "" : text.slice(space + 1).trim();
  const channel = channelForPrefix(word);
  if (channel) {
    return rest.length > 0
      ? { kind: "message", channel, text: rest }
      : { kind: "command", name: "channel", args: [channel] };
  }
  const args = rest.length > 0 ? rest.split(/\s+/) : [];
  return { kind: "command", name: word.slice(1).toLowerCase(), args };
}

// -- the one routing rule --------------------------------------------------------

/** Where participants are and what they belong to — supplied by the app. */
export interface RoutingContext {
  teamOf(peerId: string): string | null;
  partyOf(peerId: string): string | null;
  /** World position of a participant, or null when not in the world (not playing). */
  positionOf(peerId: string): readonly [number, number, number] | null;
  /**
   * The world zone a participant stands in (the recipe's zone id, or the
   * scene name for a world without zones), or null when not in the world.
   * Absent entirely = this endpoint has no zone chat (voice, a bare host).
   */
  zoneOf?(peerId: string): string | null;
}

export type RoutingResult =
  | { ok: true; recipients: string[] }
  | { ok: false; reason: string };

/**
 * Who may hear `sender` on `channel`, out of `participants` (which should
 * include the sender — a speaker always hears themselves). Team/party
 * require membership; proximity and zone require the sender to be in the
 * world. Pure: the host uses it to route text, every client uses it to gate
 * outgoing voice, and tests pin it down.
 */
export function recipientsFor(
  sender: string,
  channel: CommsChannel,
  participants: readonly string[],
  ctx: RoutingContext,
  proximityRadius: number,
): RoutingResult {
  switch (channel) {
    case "global":
      return { ok: true, recipients: [...participants] };
    case "team": {
      const team = ctx.teamOf(sender);
      if (team === null) return { ok: false, reason: "you are not on a team" };
      return { ok: true, recipients: participants.filter((p) => ctx.teamOf(p) === team) };
    }
    case "party": {
      const party = ctx.partyOf(sender);
      if (party === null) return { ok: false, reason: "you are not in a party" };
      return { ok: true, recipients: participants.filter((p) => ctx.partyOf(p) === party) };
    }
    case "zone": {
      if (!ctx.zoneOf) return { ok: false, reason: "zone chat is not available here" };
      const zone = ctx.zoneOf(sender);
      if (zone === null) return { ok: false, reason: "you are not in the world" };
      return { ok: true, recipients: participants.filter((p) => p === sender || ctx.zoneOf!(p) === zone) };
    }
    case "proximity": {
      const origin = ctx.positionOf(sender);
      if (origin === null) return { ok: false, reason: "you are not in the world" };
      const r2 = proximityRadius * proximityRadius;
      const recipients = participants.filter((p) => {
        if (p === sender) return true;
        const pos = ctx.positionOf(p);
        if (pos === null) return false;
        const dx = pos[0] - origin[0];
        const dy = pos[1] - origin[1];
        const dz = pos[2] - origin[2];
        return dx * dx + dy * dy + dz * dz <= r2;
      });
      return { ok: true, recipients };
    }
  }
}

/**
 * Who on THIS endpoint may hear a message that arrived from another layer of
 * the cluster: `scope.zone` for zone lines (players standing in that zone
 * here), the members of `scope.party` for party lines, everyone for global.
 * The sender is elsewhere, so nobody is excluded as "self".
 */
export function foreignRecipients(
  channel: CommsChannel,
  scope: BridgeScope,
  participants: readonly string[],
  ctx: RoutingContext,
): string[] {
  if (channel === "global") return [...participants];
  if (channel === "zone" && ctx.zoneOf && scope.zone !== null) {
    return participants.filter((p) => ctx.zoneOf!(p) === scope.zone);
  }
  if (channel === "party" && typeof scope.party === "string") {
    return participants.filter((p) => ctx.partyOf(p) === scope.party);
  }
  return [];
}
