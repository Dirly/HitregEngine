/// <reference lib="dom" />
/**
 * WebRTC DataChannel transport — host-star topology (ARCHITECTURE §3a).
 *
 * Every peer opens one RTCPeerConnection to the HOST: the host's Transport
 * sees each peer, peers see only the host. Two data channels per connection
 * map onto the Transport channels — "reliable" (ordered) and "unreliable"
 * (unordered, zero retransmits) — both in binary mode (arraybuffer).
 *
 * Signaling (SDP offer/answer + trickle ICE) is injected through the small
 * `SignalingChannel` interface: in dev the playground's vite websocket relay,
 * later a platform service. ICE uses Google's public STUN only — fine for
 * dev/LAN; peers behind symmetric NAT need a TURN relay, which is
 * deliberately out of scope until the platform milestone (§3a).
 *
 * Browser-only at RUNTIME, Node-safe to IMPORT: no browser global is touched
 * at module scope — RTCPeerConnection is only referenced when a transport is
 * constructed (client) or receives an offer (host).
 */

import type { Channel, PeerState, Transport } from "./transport.js";

/**
 * Carries SDP/ICE envelopes between peers before any P2P link exists.
 * `send`/`onMessage` payloads are the opaque `RtcSignal` values below —
 * implementations just move them (dev: vite ws relay, prod: platform API).
 */
export interface SignalingChannel {
  readonly selfId: string;
  send(to: string, data: unknown): void;
  onMessage(cb: (from: string, data: unknown) => void): () => void;
}

export interface WebRtcTransportOptions {
  /** Override the ICE servers (default: Google public STUN, no TURN). */
  iceServers?: RTCIceServer[];
}

// -- signal envelope -----------------------------------------------------------

export type RtcSignal =
  | { rtc: "offer"; sdp: string }
  | { rtc: "answer"; sdp: string }
  /** `candidate: null` is the end-of-candidates marker (trickle ICE). */
  | { rtc: "ice"; candidate: RTCIceCandidateInit | null };

/**
 * Validate an incoming signaling payload. Returns null for anything
 * malformed — signaling is a shared relay in dev, so garbage (or messages
 * from a future protocol version) must be droppable without throwing.
 */
export function parseRtcSignal(data: unknown): RtcSignal | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  switch (msg.rtc) {
    case "offer":
    case "answer":
      return typeof msg.sdp === "string" ? { rtc: msg.rtc, sdp: msg.sdp } : null;
    case "ice":
      if (msg.candidate === null) return { rtc: "ice", candidate: null };
      return typeof msg.candidate === "object" && msg.candidate !== null
        ? { rtc: "ice", candidate: msg.candidate as RTCIceCandidateInit }
        : null;
    default:
      return null;
  }
}

// No TURN in dev: STUN suffices for same-machine tabs and most home NATs.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// -- per-connection state --------------------------------------------------------

interface LinkEvents {
  /** Fires once, when BOTH data channels are open. */
  onOpen: () => void;
  /** Fires once on teardown; `wasOpen` distinguishes drop from failed dial. */
  onClose: (wasOpen: boolean) => void;
  onMessage: (channel: Channel, data: Uint8Array) => void;
}

/** One RTCPeerConnection + its two data channels, shared by host and client. */
class RtcLink {
  private readonly peerId: string;
  private readonly sendSignal: (data: RtcSignal) => void;
  private readonly events: LinkEvents;
  private readonly pc: RTCPeerConnection;
  private reliable: RTCDataChannel | null = null;
  private unreliable: RTCDataChannel | null = null;
  /** ICE candidates that arrived before the remote description was set. */
  private readonly pendingIce: Array<RTCIceCandidateInit | null> = [];
  private hasRemoteDescription = false;
  private opened = false;
  private closed = false;

  constructor(
    peerId: string,
    sendSignal: (data: RtcSignal) => void,
    events: LinkEvents,
    iceServers: RTCIceServer[],
  ) {
    this.peerId = peerId;
    this.sendSignal = sendSignal;
    this.events = events;
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = (ev) => {
      // trickle ICE: forward candidates as they surface (null = gathering done)
      try {
        this.sendSignal({ rtc: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null });
      } catch (error) {
        console.warn(`[webrtc] failed to signal ICE candidate to "${this.peerId}":`, error);
      }
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === "failed" || state === "closed" || state === "disconnected") this.close();
    };
    // non-initiator side receives the channels the initiator created
    this.pc.ondatachannel = (ev) => this.adopt(ev.channel);
  }

  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  /** Connection diagnostics (context bridge / HUD debugging). */
  describe(): Record<string, string> {
    return {
      connection: this.pc.connectionState,
      ice: this.pc.iceConnectionState,
      signalingState: this.pc.signalingState,
      reliable: this.reliable?.readyState ?? "none",
      unreliable: this.unreliable?.readyState ?? "none",
    };
  }

  /** Client side: create both channels, then offer. */
  openAsInitiator(): void {
    this.adopt(this.pc.createDataChannel("reliable", { ordered: true }));
    this.adopt(this.pc.createDataChannel("unreliable", { ordered: false, maxRetransmits: 0 }));
    void (async () => {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ rtc: "offer", sdp: offer.sdp ?? "" });
    })().catch((error) => console.warn(`[webrtc] offer to "${this.peerId}" failed:`, error));
  }

  /** Apply a validated signal. Never throws — failures warn and drop. */
  handleSignal(signal: RtcSignal): void {
    void this.apply(signal).catch((error) =>
      console.warn(`[webrtc] signal from "${this.peerId}" failed:`, error),
    );
  }

  send(channel: Channel, data: Uint8Array): void {
    const ch = channel === "reliable" ? this.reliable : this.unreliable;
    if (!ch || ch.readyState !== "open") return; // not connected — drop silently
    try {
      // Transport payloads are plain Uint8Arrays; the cast only narrows the
      // buffer generic (lib.dom's send() rejects SharedArrayBuffer views).
      ch.send(data as Uint8Array<ArrayBuffer>);
    } catch (error) {
      console.warn(`[webrtc] send to "${this.peerId}" failed:`, error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const wasOpen = this.opened;
    try {
      this.pc.close();
    } catch {
      // already closed
    }
    try {
      this.events.onClose(wasOpen);
    } catch (error) {
      console.warn(`[webrtc] close handler failed for "${this.peerId}":`, error);
    }
  }

  private async apply(signal: RtcSignal): Promise<void> {
    if (this.closed) return;
    switch (signal.rtc) {
      case "offer": {
        await this.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        this.hasRemoteDescription = true;
        // answer BEFORE flushing queued ICE: a bad candidate must never be
        // able to abort the answer (that deadlocks the whole handshake)
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal({ rtc: "answer", sdp: answer.sdp ?? "" });
        await this.flushPendingIce();
        return;
      }
      case "answer":
        await this.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        this.hasRemoteDescription = true;
        await this.flushPendingIce();
        return;
      case "ice":
        if (!this.hasRemoteDescription) {
          this.pendingIce.push(signal.candidate); // too early — queue for the description
          return;
        }
        await this.addIce(signal.candidate);
        return;
    }
  }

  private async flushPendingIce(): Promise<void> {
    const queued = this.pendingIce.splice(0);
    for (const candidate of queued) await this.addIce(candidate);
  }

  private async addIce(candidate: RTCIceCandidateInit | null): Promise<void> {
    try {
      // end-of-candidates (null): the no-arg form is spec-legal but flaky
      // across browsers, and connections complete fine without it — skip.
      if (candidate === null) return;
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      // one bad candidate must not poison the rest of the handshake
      console.warn(`[webrtc] addIceCandidate from "${this.peerId}" failed:`, error);
    }
  }

  private adopt(ch: RTCDataChannel): void {
    if (ch.label !== "reliable" && ch.label !== "unreliable") {
      console.warn(`[webrtc] unexpected data channel "${ch.label}" from "${this.peerId}" — ignored`);
      return;
    }
    const channel: Channel = ch.label;
    ch.binaryType = "arraybuffer";
    if (channel === "reliable") this.reliable = ch;
    else this.unreliable = ch;
    ch.onopen = () => this.maybeOpen();
    ch.onclose = () => this.close();
    ch.onmessage = (ev) => {
      const raw: unknown = ev.data;
      if (!(raw instanceof ArrayBuffer)) return; // binary-only protocol — drop strays
      try {
        this.events.onMessage(channel, new Uint8Array(raw));
      } catch (error) {
        console.warn(`[webrtc] message handler failed for "${this.peerId}":`, error);
      }
    };
    this.maybeOpen(); // a channel adopted late can already be open
  }

  private maybeOpen(): void {
    if (this.opened || this.closed) return;
    if (this.reliable?.readyState !== "open" || this.unreliable?.readyState !== "open") return;
    this.opened = true;
    try {
      this.events.onOpen();
    } catch (error) {
      console.warn(`[webrtc] open handler failed for "${this.peerId}":`, error);
    }
  }
}

// -- shared handler plumbing -----------------------------------------------------

abstract class WebRtcTransportBase implements Transport {
  readonly localId: string;
  protected readonly signaling: SignalingChannel;
  protected readonly iceServers: RTCIceServer[];
  protected readonly unsubSignal: () => void;
  protected closed = false;
  private readonly messageHandlers = new Set<
    (from: string, channel: Channel, data: Uint8Array) => void
  >();
  private readonly peerHandlers = new Set<(peer: string, state: PeerState) => void>();

  constructor(signaling: SignalingChannel, options: WebRtcTransportOptions) {
    this.localId = signaling.selfId;
    this.signaling = signaling;
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.unsubSignal = signaling.onMessage((from, data) => {
      // Signaling callbacks must never throw back into the relay.
      try {
        this.handleSignal(from, data);
      } catch (error) {
        console.warn(`[webrtc] signaling from "${from}" failed:`, error);
      }
    });
  }

  protected abstract handleSignal(from: string, data: unknown): void;
  abstract peers(): string[];
  abstract send(peer: string, channel: Channel, data: Uint8Array): void;
  abstract close(): void;

  broadcast(channel: Channel, data: Uint8Array): void {
    for (const peer of this.peers()) this.send(peer, channel, data);
  }

  onMessage(cb: (from: string, channel: Channel, data: Uint8Array) => void): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onPeer(cb: (peer: string, state: PeerState) => void): () => void {
    this.peerHandlers.add(cb);
    return () => this.peerHandlers.delete(cb);
  }

  protected dispatchMessage(from: string, channel: Channel, data: Uint8Array): void {
    if (this.closed) return;
    for (const cb of [...this.messageHandlers]) cb(from, channel, data);
  }

  protected dispatchPeer(peer: string, state: PeerState): void {
    if (this.closed) return;
    for (const cb of [...this.peerHandlers]) cb(peer, state);
  }
}

// -- host ------------------------------------------------------------------------

/**
 * The star's center: accepts an offer from every joining peer. Which peer
 * hosts is decided OUTSIDE the transport (dev: the signaling relay's
 * first-joiner rule; later: matchmaking).
 */
export class WebRtcHostTransport extends WebRtcTransportBase {
  private readonly links = new Map<string, RtcLink>();

  constructor(signaling: SignalingChannel, options: WebRtcTransportOptions = {}) {
    super(signaling, options);
  }

  peers(): string[] {
    return [...this.links].filter(([, link]) => link.isOpen).map(([id]) => id);
  }

  /** Per-link RTC states, open or not (context bridge / HUD debugging). */
  linkStates(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [id, link] of this.links) out[id] = link.describe();
    return out;
  }

  send(peer: string, channel: Channel, data: Uint8Array): void {
    if (this.closed) return;
    this.links.get(peer)?.send(channel, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubSignal();
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }

  protected handleSignal(from: string, data: unknown): void {
    if (this.closed || from === this.localId) return;
    const signal = parseRtcSignal(data);
    if (signal === null) return;
    let link = this.links.get(from);
    if (signal.rtc === "offer" && link) {
      // fresh dial from a peer we thought we had — replace the stale link
      this.links.delete(from);
      link.close();
      link = undefined;
    }
    if (!link) {
      if (signal.rtc !== "offer") return; // stray ICE for a connection we never had
      link = this.createLink(from);
      this.links.set(from, link);
    }
    link.handleSignal(signal);
  }

  private createLink(peerId: string): RtcLink {
    const link: RtcLink = new RtcLink(
      peerId,
      (data) => this.signaling.send(peerId, data),
      {
        onOpen: () => this.dispatchPeer(peerId, "connected"),
        onClose: (wasOpen) => {
          if (this.links.get(peerId) === link) this.links.delete(peerId);
          if (wasOpen) this.dispatchPeer(peerId, "disconnected");
        },
        onMessage: (channel, data) => this.dispatchMessage(peerId, channel, data),
      },
      this.iceServers,
    );
    return link;
  }
}

// -- client ----------------------------------------------------------------------

/** A spoke: dials the host immediately; its only peer is the host. */
export class WebRtcClientTransport extends WebRtcTransportBase {
  private readonly hostId: string;
  private readonly link: RtcLink;

  constructor(signaling: SignalingChannel, hostId: string, options: WebRtcTransportOptions = {}) {
    super(signaling, options);
    this.hostId = hostId;
    this.link = new RtcLink(
      hostId,
      (data) => this.signaling.send(hostId, data),
      {
        onOpen: () => this.dispatchPeer(hostId, "connected"),
        onClose: (wasOpen) => {
          if (wasOpen) this.dispatchPeer(hostId, "disconnected");
        },
        onMessage: (channel, data) => this.dispatchMessage(hostId, channel, data),
      },
      this.iceServers,
    );
    this.link.openAsInitiator();
  }

  peers(): string[] {
    return this.link.isOpen ? [this.hostId] : [];
  }

  /** RTC state of the host link (context bridge / HUD debugging). */
  linkStates(): Record<string, Record<string, string>> {
    return { [this.hostId]: this.link.describe() };
  }

  send(peer: string, channel: Channel, data: Uint8Array): void {
    if (this.closed || peer !== this.hostId) return;
    this.link.send(channel, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubSignal();
    this.link.close();
  }

  protected handleSignal(from: string, data: unknown): void {
    if (this.closed || from !== this.hostId) return;
    const signal = parseRtcSignal(data);
    if (signal === null) return;
    this.link.handleSignal(signal);
  }
}
