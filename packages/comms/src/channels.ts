/**
 * Communication channels — shared by text chat and voice.
 *
 * - "proximity": heard by players within a radius of the speaker ("say").
 * - "global":    everyone in the session.
 * - "team":      players sharing the speaker's team (netState `comms.team/*`).
 * - "party":     players sharing the speaker's party (netState `comms.party/*`).
 *
 * The routing rule for each lives in ONE place (`recipientsFor` below) so
 * text and voice can never disagree about who is allowed to hear whom.
 */

export type CommsChannel = "proximity" | "global" | "team" | "party";

export const COMMS_CHANNELS: readonly CommsChannel[] = ["proximity", "global", "team", "party"];

export interface ChannelMeta {
  /** Short UI label. */
  label: string;
  /**
   * Text glyph shown beside the label — meaning is never carried by color
   * alone (WCAG / colorblind-safe): "[S]ay", "[G]lobal", "[T]eam", "[P]arty".
   */
  glyph: string;
  /** Slash-prefixes that select this channel for one message ("/t hello"). */
  prefixes: readonly string[];
}

// Channel prefixes are the SHORT forms only: "/team red" and "/party blue"
// are membership commands, so the long words can't double as channels.
export const CHANNEL_META: Readonly<Record<CommsChannel, ChannelMeta>> = {
  proximity: { label: "say", glyph: "[S]", prefixes: ["/s", "/say", "/l"] },
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
}

export type RoutingResult =
  | { ok: true; recipients: string[] }
  | { ok: false; reason: string };

/**
 * Who may hear `sender` on `channel`, out of `participants` (which should
 * include the sender — a speaker always hears themselves). Team/party
 * require membership; proximity requires the sender to be in the world.
 * Pure: the host uses it to route text, every client uses it to gate
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
