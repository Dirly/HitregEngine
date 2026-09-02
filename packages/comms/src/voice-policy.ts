/**
 * Voice policy — the pure half of VoIP, testable without WebRTC or WebAudio.
 *
 * Voice is a full mesh of audio-only peer connections (fine for the party
 * sizes P2P rooms serve — see ARCHITECTURE §3a). Who HEARS you is decided
 * on the SENDING side: every outgoing track is gated per peer with the same
 * `recipientsFor` rule text chat uses, so team voice never leaves the team
 * at the packet level. The receiving side only shapes what it was sent:
 * distance attenuation + spatialization for proximity, flat for the rest.
 */

import { recipientsFor, type CommsChannel, type RoutingContext } from "./channels.js";

/**
 * Peers an outgoing voice track should be ENABLED for right now. Self is
 * never a target (you don't hear yourself through the network).
 */
export function voiceTargets(
  selfId: string,
  channel: CommsChannel,
  participants: readonly string[],
  ctx: RoutingContext,
  proximityRadius: number,
): Set<string> {
  const routed = recipientsFor(selfId, channel, participants, ctx, proximityRadius);
  if (!routed.ok) return new Set();
  return new Set(routed.recipients.filter((p) => p !== selfId));
}

/**
 * Distance → gain for proximity voice: full volume inside `fullRadius`,
 * then a smooth quadratic roll-off to silence at `radius`. Matches the
 * sender's gate (anyone beyond `radius` was never sent audio), so the
 * curve reaches exactly zero where the packets stop — no audible cut.
 */
export function proximityGain(distance: number, radius: number, fullRadius: number): number {
  if (!(radius > 0)) return 0;
  const full = Math.min(Math.max(fullRadius, 0), radius);
  if (distance <= full) return 1;
  if (distance >= radius) return 0;
  const t = (distance - full) / (radius - full);
  const g = (1 - t) * (1 - t);
  return g < 0.001 ? 0 : g;
}

/**
 * Which of a pair dials: deterministic so two peers learning of each other
 * simultaneously never both offer (glare). The lexicographically smaller
 * id is the offerer.
 */
export function isOfferer(selfId: string, otherId: string): boolean {
  return selfId < otherId;
}

/** Root-mean-square of a time-domain sample block — the VAD's loudness measure. */
export function rms(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Voice-activity hysteresis: opens above `threshold`, closes only after
 * the level has stayed below `threshold * 0.6` for `holdMs` — so a pause
 * between words doesn't chop the tail off a sentence.
 */
export class VoiceGate {
  private open = false;
  private belowSince: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly holdMs: number,
  ) {}

  update(level: number, nowMs: number): boolean {
    if (level >= this.threshold) {
      this.open = true;
      this.belowSince = null;
      return true;
    }
    if (!this.open) return false;
    if (level >= this.threshold * 0.6) {
      this.belowSince = null;
      return true;
    }
    if (this.belowSince === null) this.belowSince = nowMs;
    if (nowMs - this.belowSince >= this.holdMs) {
      this.open = false;
      this.belowSince = null;
      return false;
    }
    return true;
  }

  isOpen(): boolean {
    return this.open;
  }
}
