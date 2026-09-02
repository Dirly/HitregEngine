/// <reference lib="dom" />
/**
 * VoiceService — proximity / global / team / party VoIP.
 *
 * Topology: a full mesh of audio-only RTCPeerConnections between every
 * participant with voice enabled. Signaling (SDP/ICE) rides the room's
 * module channel through the host, which relays `{k:"sig", from, to}`
 * envelopes after checking the sender is who it claims — peers never talk
 * to each other except through media the host brokered.
 *
 * Gating is on the SENDER (see voice-policy.ts): each outgoing connection
 * carries its own clone of the mic track and is enabled only while this
 * player is transmitting on a channel the remote peer may hear. Receivers
 * shape what arrives: proximity audio is spatialized (WebAudio panner at
 * the speaker's world position, listener at the camera) with a distance
 * roll-off; team/party/global audio plays flat.
 *
 * Browser-only at RUNTIME (getUserMedia, RTCPeerConnection, AudioContext),
 * Node-safe to IMPORT and to construct: nothing browser-specific runs until
 * `enable()`. The host relays signaling whether or not it enabled a mic.
 */

import { isCommsChannel, type CommsChannel, type RoutingContext } from "./channels.js";
import type { CommsLink } from "./link.js";
import type { MembershipSource } from "./membership.js";
import { VoiceGate, isOfferer, proximityGain, rms, voiceTargets } from "./voice-policy.js";

export const VOICE_MODULE = "voice";

export type VoiceMode = "ptt" | "open";

export interface VoiceConfig {
  /** Meters. Proximity voice is sent to players within this distance (default 25). */
  proximityRadius?: number;
  /** Meters. Full volume inside this distance, rolling off to silence at the radius (default 5). */
  fullVolumeRadius?: number;
  /** "ptt": transmit while a key is held. "open": voice-activated (default "ptt"). */
  mode?: VoiceMode;
  /**
   * Push-to-talk keys by channel (KeyboardEvent.code). Default
   * { proximity: "KeyV", team: "KeyB", party: "KeyN" } — no global key:
   * shouting to the whole server is opt-in per game.
   */
  pttKeys?: Partial<Record<CommsChannel, string>>;
  /** Spatialize proximity voice (default true). Off = distance gain only. */
  spatial?: boolean;
  /** RMS level that counts as speech for the VAD / speaking indicator (default 0.02). */
  vadThreshold?: number;
  /** Ms of silence before open-mic transmission closes (default 350). */
  vadHoldMs?: number;
  /** ICE servers (default: Google public STUN — dev/LAN; add TURN for production). */
  iceServers?: RTCIceServer[];
  /** Mesh cap: beyond this many voice peers, further links aren't dialed (default 16). */
  maxPeers?: number;
  /** Share the game's AudioContext (otherwise one is created on enable). */
  audioContext?: AudioContext;
  /** Received-audio master gain (default 1). */
  outputGain?: number;
}

export interface ListenerPose {
  position: readonly [number, number, number];
  forward: readonly [number, number, number];
  up: readonly [number, number, number];
}

export interface VoiceDeps {
  link: CommsLink;
  membership: MembershipSource;
  positionOf(peerId: string): readonly [number, number, number] | null;
  /** Where the local listener is (the camera). Null = no spatial audio this frame. */
  listenerPose?(): ListenerPose | null;
  config?: VoiceConfig;
}

export interface VoicePeerState {
  peerId: string;
  name: string;
  /** ICE connected and receiving a track. */
  connected: boolean;
  /** Audible speech from this peer right now. */
  speaking: boolean;
  /** Channel the peer is currently transmitting on (announced). */
  channel: CommsChannel;
  /** Current receive gain (0 = silent: out of range, deafened, …). */
  gain: number;
}

export interface VoiceState {
  /** Mic captured and presence announced. */
  enabled: boolean;
  /** Why enable() failed, if it did (permission denied, no device, …). */
  error: string | null;
  muted: boolean;
  deafened: boolean;
  mode: VoiceMode;
  speakChannel: CommsChannel;
  /** Audio is being sent to at least one peer right now. */
  transmitting: boolean;
  /** Local VAD: the mic hears speech. */
  speaking: boolean;
  /** Peers this tab knows have voice enabled (connected or dialing). */
  peers: VoicePeerState[];
}

// -- wire format (module "voice") ----------------------------------------------------

type VoiceMsg =
  | { k: "presence"; from: string; on: boolean }
  | { k: "roster"; peers: string[] }
  | { k: "sig"; from: string; to: string; data: unknown }
  | { k: "mode"; from: string; channel: CommsChannel };

function parseVoiceMsg(data: unknown): VoiceMsg | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.k) {
    case "presence":
      return typeof m.from === "string" && typeof m.on === "boolean"
        ? { k: "presence", from: m.from, on: m.on }
        : null;
    case "roster":
      return Array.isArray(m.peers) && m.peers.every((p) => typeof p === "string")
        ? { k: "roster", peers: m.peers as string[] }
        : null;
    case "sig":
      return typeof m.from === "string" && typeof m.to === "string"
        ? { k: "sig", from: m.from, to: m.to, data: m.data }
        : null;
    case "mode":
      return typeof m.from === "string" && isCommsChannel(m.channel)
        ? { k: "mode", from: m.from, channel: m.channel }
        : null;
    default:
      return null;
  }
}

type RtcSignal =
  | { rtc: "offer"; sdp: string }
  | { rtc: "answer"; sdp: string }
  | { rtc: "ice"; candidate: RTCIceCandidateInit | null };

function parseRtc(data: unknown): RtcSignal | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if ((m.rtc === "offer" || m.rtc === "answer") && typeof m.sdp === "string") {
    return { rtc: m.rtc, sdp: m.sdp };
  }
  if (m.rtc === "ice") {
    if (m.candidate === null) return { rtc: "ice", candidate: null };
    return typeof m.candidate === "object" && m.candidate !== null
      ? { rtc: "ice", candidate: m.candidate as RTCIceCandidateInit }
      : null;
  }
  return null;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const DEFAULT_PTT: Partial<Record<CommsChannel, string>> = {
  proximity: "KeyV",
  team: "KeyB",
  party: "KeyN",
};

// -- per-peer audio graph -----------------------------------------------------------------

interface VoicePeer {
  peerId: string;
  pc: RTCPeerConnection;
  /** Our mic clone on this link — enabled/disabled per frame by the gate. */
  outTrack: MediaStreamTrack | null;
  pendingIce: Array<RTCIceCandidateInit | null>;
  hasRemote: boolean;
  connected: boolean;
  channel: CommsChannel;
  speaking: boolean;
  gain: number;
  // receive graph (built on first track)
  audioEl: HTMLAudioElement | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  gainDirect: GainNode | null;
  gainSpatial: GainNode | null;
  panner: PannerNode | null;
  gate: VoiceGate;
}

export class VoiceService {
  private link: CommsLink;
  private readonly config: Required<Omit<VoiceConfig, "audioContext">> & { audioContext?: AudioContext };
  private readonly linkUnsubs: Array<() => void> = [];
  private readonly handlers = new Set<(state: VoiceState) => void>();
  private readonly peers = new Map<string, VoicePeer>();
  /** Voice-enabled participants known to this tab (host: authoritative roster). */
  private readonly voiceRoster = new Set<string>();
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localSamples: Float32Array<ArrayBuffer> | null = null;
  private readonly localGate: VoiceGate;
  private enabled = false;
  private error: string | null = null;
  private muted = false;
  private deafened = false;
  private mode: VoiceMode;
  private speakChannel: CommsChannel = "proximity";
  private pttHeld = false;
  private speaking = false;
  private transmitting = false;
  private announcedChannel: CommsChannel | null = null;
  private warnedCap = false;
  private disposed = false;
  private keyUnsub: (() => void) | null = null;

  constructor(private readonly deps: VoiceDeps) {
    const c = deps.config ?? {};
    this.config = {
      proximityRadius: c.proximityRadius ?? 25,
      fullVolumeRadius: c.fullVolumeRadius ?? 5,
      mode: c.mode ?? "ptt",
      pttKeys: c.pttKeys ?? DEFAULT_PTT,
      spatial: c.spatial ?? true,
      vadThreshold: c.vadThreshold ?? 0.02,
      vadHoldMs: c.vadHoldMs ?? 350,
      iceServers: c.iceServers ?? DEFAULT_ICE,
      maxPeers: c.maxPeers ?? 16,
      outputGain: c.outputGain ?? 1,
      ...(c.audioContext ? { audioContext: c.audioContext } : {}),
    };
    this.mode = this.config.mode;
    this.localGate = new VoiceGate(this.config.vadThreshold, this.config.vadHoldMs);
    this.link = deps.link;
    this.bind(deps.link);
  }

  // -- public state ---------------------------------------------------------------------

  state(): VoiceState {
    return {
      enabled: this.enabled,
      error: this.error,
      muted: this.muted,
      deafened: this.deafened,
      mode: this.mode,
      speakChannel: this.speakChannel,
      transmitting: this.transmitting,
      speaking: this.speaking,
      peers: [...this.voiceRoster]
        .filter((id) => id !== this.link.selfId)
        .map((id) => {
          const p = this.peers.get(id);
          return {
            peerId: id,
            name: this.link.nameOf(id),
            connected: p?.connected ?? false,
            speaking: p?.speaking ?? false,
            channel: p?.channel ?? "proximity",
            gain: p?.gain ?? 0,
          };
        }),
    };
  }

  onChange(cb: (state: VoiceState) => void): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  /** Capture the mic and announce presence. Call from a user gesture (autoplay policy). */
  async enable(): Promise<boolean> {
    if (this.disposed || this.enabled) return this.enabled;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.error = "voice is not available in this environment";
      this.notify();
      return false;
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.notify();
      return false;
    }
    if (this.disposed) {
      this.stopMic();
      return false;
    }
    this.error = null;
    this.ensureAudioContext();
    const ctx = this.ctx!;
    // local VAD / speaking indicator: analyser only — never routed to the output
    const src = ctx.createMediaStreamSource(this.mic);
    this.localAnalyser = ctx.createAnalyser();
    this.localAnalyser.fftSize = 512;
    this.localSamples = new Float32Array(this.localAnalyser.fftSize);
    src.connect(this.localAnalyser);
    this.enabled = true;
    this.applyMute();
    this.handlePresence(this.link.selfId, true); // host: records + broadcasts; peer: sends up
    this.announceMode(true);
    this.notify();
    return true;
  }

  /** Release the mic, hang up every link, announce absence. */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.transmitting = false;
    this.speaking = false;
    this.handlePresence(this.link.selfId, false);
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.stopMic();
    this.notify();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMute();
    this.notify();
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    this.notify();
  }

  setMode(mode: VoiceMode): void {
    this.mode = mode;
    this.pttHeld = false;
    this.notify();
  }

  /** Channel outgoing voice goes to (also selected by the PTT keys). */
  setSpeakChannel(channel: CommsChannel): void {
    if (this.speakChannel === channel) return;
    this.speakChannel = channel;
    this.announceMode(false);
    this.notify();
  }

  /** PTT: hold/release. In "open" mode this is ignored (the VAD decides). */
  setPushToTalk(held: boolean, channel?: CommsChannel): void {
    if (channel) this.setSpeakChannel(channel);
    this.pttHeld = held;
  }

  /**
   * Bind the configured PTT keys on a window. Keys typed into form fields
   * are ignored. In "open" mode a key press just selects the channel.
   */
  attachKeyboard(target: Window = window): () => void {
    this.keyUnsub?.();
    const keys = this.config.pttKeys;
    const channelFor = (code: string): CommsChannel | null => {
      for (const [channel, key] of Object.entries(keys)) {
        if (key === code && isCommsChannel(channel)) return channel;
      }
      return null;
    };
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable);
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const channel = channelFor(e.code);
      if (!channel) return;
      if (this.mode === "ptt") this.setPushToTalk(true, channel);
      else this.setSpeakChannel(channel);
    };
    const onUp = (e: KeyboardEvent) => {
      const channel = channelFor(e.code);
      if (!channel || this.mode !== "ptt") return;
      if (this.speakChannel === channel) this.setPushToTalk(false);
    };
    const onBlur = () => this.setPushToTalk(false);
    target.addEventListener("keydown", onDown);
    target.addEventListener("keyup", onUp);
    target.addEventListener("blur", onBlur);
    this.keyUnsub = () => {
      target.removeEventListener("keydown", onDown);
      target.removeEventListener("keyup", onUp);
      target.removeEventListener("blur", onBlur);
      this.keyUnsub = null;
    };
    return this.keyUnsub;
  }

  /** Session changed: hang up everything and re-announce on the new link. */
  setLink(link: CommsLink): void {
    if (this.disposed) return;
    for (const off of this.linkUnsubs.splice(0)) off();
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.voiceRoster.clear();
    this.announcedChannel = null;
    this.link = link;
    this.bind(link);
    if (this.enabled) {
      this.handlePresence(link.selfId, true);
      this.announceMode(true);
    }
    this.notify();
  }

  /**
   * Once per frame: gate outgoing tracks, update the VAD, place the
   * listener, and set every peer's receive gain from distance/channel.
   */
  update(): void {
    if (this.disposed) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    let changed = false;

    // local speech level (indicator; the trigger in open-mic mode)
    let level = 0;
    if (this.localAnalyser && this.localSamples) {
      this.localAnalyser.getFloatTimeDomainData(this.localSamples);
      level = rms(this.localSamples);
    }
    const speaking = this.enabled && !this.muted && this.localGate.update(level, now);
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      changed = true;
    }

    // outgoing gate: who may hear the current channel
    const wantSend = this.enabled && !this.muted && (this.mode === "ptt" ? this.pttHeld : speaking);
    const targets = wantSend
      ? voiceTargets(
          this.link.selfId,
          this.speakChannel,
          this.participants(),
          this.routing(),
          this.config.proximityRadius,
        )
      : new Set<string>();
    let sendingToAnyone = false;
    for (const peer of this.peers.values()) {
      const on = targets.has(peer.peerId);
      if (peer.outTrack && peer.outTrack.enabled !== on) peer.outTrack.enabled = on;
      if (on && peer.connected) sendingToAnyone = true;
    }
    if (sendingToAnyone !== this.transmitting) {
      this.transmitting = sendingToAnyone;
      changed = true;
    }

    // incoming shaping
    const ctx = this.ctx;
    if (ctx) {
      const pose = this.deps.listenerPose?.() ?? null;
      if (pose && this.config.spatial) this.placeListener(ctx, pose);
      const t = ctx.currentTime;
      for (const peer of this.peers.values()) {
        if (!peer.source) continue;
        let gain = 0;
        let spatial = false;
        if (!this.deafened) {
          if (peer.channel === "proximity") {
            const me = pose?.position ?? this.deps.positionOf(this.link.selfId);
            const them = this.deps.positionOf(peer.peerId);
            if (me && them) {
              const d = Math.hypot(them[0] - me[0], them[1] - me[1], them[2] - me[2]);
              gain = proximityGain(d, this.config.proximityRadius, this.config.fullVolumeRadius);
              spatial = this.config.spatial && pose !== null;
              if (spatial && peer.panner) this.placePanner(peer.panner, them, t);
            }
          } else {
            gain = 1;
          }
        }
        peer.gainDirect?.gain.setTargetAtTime(spatial ? 0 : gain, t, 0.05);
        peer.gainSpatial?.gain.setTargetAtTime(spatial ? gain : 0, t, 0.05);
        if (Math.abs(gain - peer.gain) > 0.01) {
          peer.gain = gain;
          changed = true;
        }
        // remote speaking indicator: audible level, not just packets
        let heard = false;
        if (peer.analyser && gain > 0.01) {
          const buf = new Float32Array(peer.analyser.fftSize);
          peer.analyser.getFloatTimeDomainData(buf);
          heard = peer.gate.update(rms(buf), now);
        } else {
          peer.gate.update(0, now);
        }
        if (heard !== peer.speaking) {
          peer.speaking = heard;
          changed = true;
        }
      }
    }
    if (changed) this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disable();
    this.disposed = true;
    this.keyUnsub?.();
    for (const off of this.linkUnsubs.splice(0)) off();
    this.handlers.clear();
    if (this.ctx && !this.config.audioContext) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }

  // -- signaling --------------------------------------------------------------------------

  private bind(link: CommsLink): void {
    this.linkUnsubs.push(
      link.onMessage(VOICE_MODULE, (from, data) => {
        try {
          this.handleMessage(from, data);
        } catch (error) {
          console.warn("[voice] message handling failed:", error);
        }
      }),
      link.onRoster(() => this.pruneRoster()),
    );
  }

  private handleMessage(from: string, data: unknown): void {
    const msg = parseVoiceMsg(data);
    if (!msg) return;
    const isHost = this.link.role === "host";
    switch (msg.k) {
      case "presence":
        // host: only the sender may announce itself; peers: trust the host's relay
        if (isHost && msg.from !== from) return;
        this.handlePresence(msg.from, msg.on);
        return;
      case "roster":
        if (isHost) return; // peers only ever receive a roster
        for (const id of msg.peers) {
          if (id !== this.link.selfId) this.voiceRoster.add(id);
        }
        this.dialKnown();
        this.notify();
        return;
      case "sig":
        if (isHost) {
          if (msg.from !== from) return; // spoofed origin — drop
          if (msg.to !== this.link.selfId) {
            this.link.send(VOICE_MODULE, msg.to, msg); // relay peer → peer
            return;
          }
        } else if (msg.to !== this.link.selfId) {
          return;
        }
        this.handleSignal(msg.from, msg.data);
        return;
      case "mode": {
        if (isHost && msg.from !== from) return;
        if (isHost) {
          // fan out so every peer knows how to shape this speaker's audio
          for (const peer of this.link.peers()) {
            if (peer !== from) this.link.send(VOICE_MODULE, peer, msg);
          }
        }
        const peer = this.peers.get(msg.from);
        if (peer) {
          if (peer.channel !== msg.channel) {
            peer.channel = msg.channel;
            this.notify();
          }
        } else {
          this.pendingModes.set(msg.from, msg.channel); // link not up yet — apply on create
        }
        return;
      }
    }
  }

  /** Speak-channel announcements that arrived before the peer's link existed. */
  private readonly pendingModes = new Map<string, CommsChannel>();

  /** A participant's voice presence changed (own, or relayed). */
  private handlePresence(peerId: string, on: boolean): void {
    const self = peerId === this.link.selfId;
    const isHost = this.link.role === "host";
    if (self && !isHost) {
      // peer: tell the host; the host answers with the roster and fans out
      if (this.link.role === "peer") {
        this.link.send(VOICE_MODULE, this.link.hostId, { k: "presence", from: peerId, on } satisfies VoiceMsg);
      }
      if (!on) this.voiceRoster.clear();
      return;
    }
    if (on) this.voiceRoster.add(peerId);
    else this.voiceRoster.delete(peerId);
    if (isHost) {
      for (const other of this.link.peers()) {
        if (other !== peerId) {
          this.link.send(VOICE_MODULE, other, { k: "presence", from: peerId, on } satisfies VoiceMsg);
        }
      }
      if (on && !self) {
        this.link.send(VOICE_MODULE, peerId, {
          k: "roster",
          peers: [...this.voiceRoster].filter((id) => id !== peerId),
        } satisfies VoiceMsg);
      }
    }
    if (!self) {
      if (on) this.dialKnown();
      else this.dropPeer(peerId);
    }
    this.notify();
  }

  /** Dial every roster member we're the offerer for and aren't linked to yet. */
  private dialKnown(): void {
    if (!this.enabled) return;
    for (const id of this.voiceRoster) {
      if (id === this.link.selfId || this.peers.has(id)) continue;
      if (!isOfferer(this.link.selfId, id)) continue; // they dial us
      if (this.peers.size >= this.config.maxPeers) {
        if (!this.warnedCap) {
          this.warnedCap = true;
          console.warn(`[voice] mesh cap (${this.config.maxPeers}) reached — not dialing further peers`);
        }
        return;
      }
      const peer = this.createPeer(id);
      void this.offer(peer);
    }
  }

  private announceMode(force: boolean): void {
    if (!this.enabled) return;
    if (!force && this.announcedChannel === this.speakChannel) return;
    this.announcedChannel = this.speakChannel;
    const msg: VoiceMsg = { k: "mode", from: this.link.selfId, channel: this.speakChannel };
    if (this.link.role === "host") {
      for (const peer of this.link.peers()) this.link.send(VOICE_MODULE, peer, msg);
    } else if (this.link.role === "peer") {
      this.link.send(VOICE_MODULE, this.link.hostId, msg);
    }
  }

  private sendSignal(to: string, data: RtcSignal): void {
    const msg: VoiceMsg = { k: "sig", from: this.link.selfId, to, data };
    if (this.link.role === "host") this.link.send(VOICE_MODULE, to, msg);
    else if (this.link.role === "peer") this.link.send(VOICE_MODULE, this.link.hostId, msg);
  }

  private handleSignal(from: string, data: unknown): void {
    const signal = parseRtc(data);
    if (!signal || !this.enabled) return;
    let peer = this.peers.get(from);
    if (!peer) {
      if (signal.rtc !== "offer") return; // stray ICE/answer for a link we don't have
      if (this.peers.size >= this.config.maxPeers) return;
      this.voiceRoster.add(from);
      peer = this.createPeer(from);
    }
    void this.applySignal(peer, signal).catch((error) =>
      console.warn(`[voice] signal from "${from}" failed:`, error),
    );
  }

  private async applySignal(peer: VoicePeer, signal: RtcSignal): Promise<void> {
    const pc = peer.pc;
    switch (signal.rtc) {
      case "offer": {
        if (isOfferer(this.link.selfId, peer.peerId) && pc.signalingState !== "stable") {
          return; // glare: we are the offerer for this pair — ignore theirs
        }
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        peer.hasRemote = true;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal(peer.peerId, { rtc: "answer", sdp: answer.sdp ?? "" });
        await this.flushIce(peer);
        return;
      }
      case "answer":
        if (pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        peer.hasRemote = true;
        await this.flushIce(peer);
        return;
      case "ice":
        if (!peer.hasRemote) {
          peer.pendingIce.push(signal.candidate);
          return;
        }
        await this.addIce(peer, signal.candidate);
        return;
    }
  }

  private async flushIce(peer: VoicePeer): Promise<void> {
    for (const c of peer.pendingIce.splice(0)) await this.addIce(peer, c);
  }

  private async addIce(peer: VoicePeer, candidate: RTCIceCandidateInit | null): Promise<void> {
    if (candidate === null) return;
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn(`[voice] addIceCandidate from "${peer.peerId}" failed:`, error);
    }
  }

  private async offer(peer: VoicePeer): Promise<void> {
    try {
      const offer = await peer.pc.createOffer({ offerToReceiveAudio: true });
      await peer.pc.setLocalDescription(offer);
      this.sendSignal(peer.peerId, { rtc: "offer", sdp: offer.sdp ?? "" });
    } catch (error) {
      console.warn(`[voice] offer to "${peer.peerId}" failed:`, error);
      this.dropPeer(peer.peerId);
    }
  }

  // -- peer lifecycle ----------------------------------------------------------------------

  private createPeer(peerId: string): VoicePeer {
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    const peer: VoicePeer = {
      peerId,
      pc,
      outTrack: null,
      pendingIce: [],
      hasRemote: false,
      connected: false,
      channel: this.pendingModes.get(peerId) ?? "proximity",
      speaking: false,
      gain: 0,
      audioEl: null,
      source: null,
      analyser: null,
      gainDirect: null,
      gainSpatial: null,
      panner: null,
      gate: new VoiceGate(this.config.vadThreshold, this.config.vadHoldMs),
    };
    this.pendingModes.delete(peerId);
    // our mic on this link: a CLONE, so enabling/disabling is per peer
    const micTrack = this.mic?.getAudioTracks()[0];
    if (micTrack) {
      const clone = micTrack.clone();
      clone.enabled = false; // gated open by update()
      peer.outTrack = clone;
      pc.addTrack(clone, new MediaStream([clone]));
    }
    pc.onicecandidate = (ev) => {
      this.sendSignal(peerId, { rtc: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") {
        this.dropPeer(peerId);
        // the roster still lists them — the offerer redials on the next presence/roster
        // update; a dropped link during a session is a transient we don't retry-loop
        return;
      }
      if (s === "connected" && !peer.connected) {
        peer.connected = true;
        this.notify();
      }
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.attachReceive(peer, stream);
    };
    this.peers.set(peerId, peer);
    this.notify();
    return peer;
  }

  private attachReceive(peer: VoicePeer, stream: MediaStream): void {
    this.ensureAudioContext();
    const ctx = this.ctx!;
    if (peer.source) return; // one receive graph per link
    // Chromium quirk: a remote MediaStream produces no audio through
    // WebAudio unless it is also attached to a media element — keep a muted
    // one around purely to "wake" the stream.
    if (typeof document !== "undefined") {
      const el = document.createElement("audio");
      el.muted = true;
      el.autoplay = true;
      el.srcObject = stream;
      el.setAttribute("aria-hidden", "true");
      el.style.display = "none";
      document.body.appendChild(el);
      void el.play().catch(() => undefined);
      peer.audioEl = el;
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const gainDirect = ctx.createGain();
    const gainSpatial = ctx.createGain();
    gainDirect.gain.value = 0;
    gainSpatial.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "linear"; // gain is ours (proximityGain) — the panner only positions
    panner.refDistance = 1;
    panner.maxDistance = 10000;
    panner.rolloffFactor = 0;
    source.connect(analyser);
    source.connect(gainDirect);
    source.connect(gainSpatial);
    gainDirect.connect(this.master!);
    gainSpatial.connect(panner);
    panner.connect(this.master!);
    peer.source = source;
    peer.analyser = analyser;
    peer.gainDirect = gainDirect;
    peer.gainSpatial = gainSpatial;
    peer.panner = panner;
    peer.connected = true;
    this.notify();
  }

  private dropPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    try {
      peer.outTrack?.stop();
      peer.source?.disconnect();
      peer.analyser?.disconnect();
      peer.gainDirect?.disconnect();
      peer.gainSpatial?.disconnect();
      peer.panner?.disconnect();
      if (peer.audioEl) {
        peer.audioEl.srcObject = null;
        peer.audioEl.remove();
      }
      peer.pc.onicecandidate = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.ontrack = null;
      peer.pc.close();
    } catch {
      // already torn down
    }
    this.notify();
  }

  /** Roster shrank (someone left the room): forget their voice presence. */
  private pruneRoster(): void {
    const present = new Set(this.link.roster().map((p) => p.peerId));
    let changed = false;
    for (const id of [...this.voiceRoster]) {
      if (id !== this.link.selfId && !present.has(id)) {
        this.voiceRoster.delete(id);
        this.dropPeer(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  // -- audio plumbing -----------------------------------------------------------------------

  private ensureAudioContext(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
      return;
    }
    const ctx = this.config.audioContext ?? new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.config.outputGain;
    this.master.connect(ctx.destination);
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  }

  private placeListener(ctx: AudioContext, pose: ListenerPose): void {
    const l = ctx.listener;
    const t = ctx.currentTime;
    const [px, py, pz] = pose.position;
    const [fx, fy, fz] = pose.forward;
    const [ux, uy, uz] = pose.up;
    if (l.positionX) {
      l.positionX.setTargetAtTime(px, t, 0.02);
      l.positionY.setTargetAtTime(py, t, 0.02);
      l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(fy, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.setTargetAtTime(ux, t, 0.02);
      l.upY.setTargetAtTime(uy, t, 0.02);
      l.upZ.setTargetAtTime(uz, t, 0.02);
    } else {
      // older WebAudio (Safari): deprecated setters only
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(px, py, pz);
      (l as unknown as { setOrientation(...v: number[]): void }).setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  private placePanner(panner: PannerNode, p: readonly [number, number, number], t: number): void {
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(p[0], t, 0.02);
      panner.positionY.setTargetAtTime(p[1], t, 0.02);
      panner.positionZ.setTargetAtTime(p[2], t, 0.02);
    } else {
      (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p[0], p[1], p[2]);
    }
  }

  private applyMute(): void {
    // the clones are gated per frame; muting the SOURCE track is the belt to
    // that suspenders — nothing leaves the mic while muted, whatever update() does
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !this.muted;
    if (this.muted) {
      for (const peer of this.peers.values()) {
        if (peer.outTrack) peer.outTrack.enabled = false;
      }
    }
  }

  private stopMic(): void {
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    this.localAnalyser?.disconnect();
    this.localAnalyser = null;
    this.localSamples = null;
  }

  private participants(): string[] {
    const ids = new Set<string>([this.link.selfId, ...this.voiceRoster]);
    return [...ids];
  }

  private routing(): RoutingContext {
    return {
      teamOf: (id) => this.deps.membership.teamOf(id),
      partyOf: (id) => this.deps.membership.partyOf(id),
      positionOf: (id) => this.deps.positionOf(id),
    };
  }

  private notify(): void {
    if (this.handlers.size === 0) return;
    const state = this.state();
    for (const cb of [...this.handlers]) cb(state);
  }
}
