/**
 * Replication protocol — message envelope and wire encoding.
 *
 * Wire format v1: a 1-byte format tag followed by the payload bytes.
 * Tag 0x01 = UTF-8 JSON. Binary snapshot encoding (planned alongside ECS
 * tables) will arrive as a new tag; the envelope never changes shape, so
 * transports and old decoders can reject unknown tags cleanly.
 *
 * Trust rule encoded in the types: clients send input COMMANDS (intentions),
 * never state. Only the host produces `snapshot`/`welcome` messages.
 */

export const FORMAT_JSON = 0x01;

// -- client → host -----------------------------------------------------------

export interface HelloMessage {
  t: "hello";
  name: string;
}

export interface CommandMessage {
  t: "command";
  /** Client's view of the simulation tick the input applies to. */
  tick: number;
  /** Monotonic per-client sequence number; the host drops stale/duplicate seqs. */
  seq: number;
  input: unknown;
}

export interface ByeMessage {
  t: "bye";
}

export type ClientMessage = HelloMessage | CommandMessage | ByeMessage;

// -- host → client -----------------------------------------------------------

export interface WelcomeMessage {
  t: "welcome";
  peerId: string;
  tick: number;
  /** Full authoritative state at join time. */
  full: unknown;
}

export interface SnapshotMessage {
  t: "snapshot";
  tick: number;
  /** Tick the delta is based on, or null for a full snapshot. */
  baseTick: number | null;
  state: unknown;
}

export interface PeerJoinedMessage {
  t: "peerJoined";
  peerId: string;
  name: string;
}

export interface PeerLeftMessage {
  t: "peerLeft";
  peerId: string;
}

export interface RejectMessage {
  t: "reject";
  reason: string;
}

export type HostMessage =
  | WelcomeMessage
  | SnapshotMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RejectMessage;

export type Message = ClientMessage | HostMessage;

// -- encode / decode ----------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeMessage(message: Message): Uint8Array {
  const json = textEncoder.encode(JSON.stringify(message));
  const out = new Uint8Array(1 + json.length);
  out[0] = FORMAT_JSON;
  out.set(json, 1);
  return out;
}

/**
 * Decode a wire message. Returns null for anything malformed: unknown format
 * tag, invalid JSON, unknown message type, or wrong field types. Callers
 * treat null as "drop it" — bad packets must never throw into the loop.
 */
export function decodeMessage(data: Uint8Array): Message | null {
  if (data.length < 1 || data[0] !== FORMAT_JSON) return null;
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(data.subarray(1)));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const msg = value as Record<string, unknown>;
  switch (msg.t) {
    case "hello":
      return typeof msg.name === "string" ? { t: "hello", name: msg.name } : null;
    case "command":
      return typeof msg.tick === "number" && typeof msg.seq === "number"
        ? { t: "command", tick: msg.tick, seq: msg.seq, input: msg.input }
        : null;
    case "bye":
      return { t: "bye" };
    case "welcome":
      return typeof msg.peerId === "string" && typeof msg.tick === "number"
        ? { t: "welcome", peerId: msg.peerId, tick: msg.tick, full: msg.full }
        : null;
    case "snapshot":
      return typeof msg.tick === "number" &&
        (msg.baseTick === null || typeof msg.baseTick === "number")
        ? { t: "snapshot", tick: msg.tick, baseTick: msg.baseTick ?? null, state: msg.state }
        : null;
    case "peerJoined":
      return typeof msg.peerId === "string" && typeof msg.name === "string"
        ? { t: "peerJoined", peerId: msg.peerId, name: msg.name }
        : null;
    case "peerLeft":
      return typeof msg.peerId === "string" ? { t: "peerLeft", peerId: msg.peerId } : null;
    case "reject":
      return typeof msg.reason === "string" ? { t: "reject", reason: msg.reason } : null;
    default:
      return null;
  }
}
