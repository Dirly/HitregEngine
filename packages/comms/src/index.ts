/**
 * @hitreg/comms — pluggable text chat + VoIP for any HitReg game.
 *
 *   const comms = createComms({ link, membership, positionOf, listenerPose, assign, emitEvent });
 *   comms.chat.send("team", "push left");     // routed by the host to teammates only
 *   await comms.voice.enable();               // mic + presence; PTT keys via attachKeyboard()
 *   comms.setLink(nextLink);                  // host migration / joined a room / went solo
 *   comms.update();                           // once per frame: gates, VAD, spatial gains
 *
 * One rule decides who hears whom for BOTH media (`recipientsFor`), on the
 * authority for text and on the sender for voice. Membership is netState
 * (`comms.team/<peer>`, `comms.party/<peer>`), so game scripts assign teams
 * with the API they already have. Headless-safe: nothing touches the DOM or
 * WebRTC until `voice.enable()` — the UI is a separate entry (`@hitreg/comms/ui`).
 */

export {
  COMMS_CHANNELS,
  CHANNEL_META,
  isCommsChannel,
  channelForPrefix,
  parseChatInput,
  recipientsFor,
  type CommsChannel,
  type ChannelMeta,
  type ParsedChatInput,
  type RoutingContext,
  type RoutingResult,
} from "./channels.js";
export { localLink, hostLink, clientLink, type CommsLink, type CommsRole } from "./link.js";
export {
  COMMS_NETSTATE,
  registerCommsNetState,
  isValidGroupName,
  netStateMembership,
  staticMembership,
  type MembershipSource,
} from "./membership.js";
export {
  CHAT_MODULE,
  ChatRouter,
  ChatService,
  registerCommsEvents,
  type ChatMessage,
  type ChatConfig,
  type ChatDeps,
  type ChatSendResult,
} from "./chat.js";
export { voiceTargets, proximityGain, isOfferer, rms, VoiceGate } from "./voice-policy.js";
export {
  VOICE_MODULE,
  VoiceService,
  type VoiceConfig,
  type VoiceDeps,
  type VoiceMode,
  type VoiceState,
  type VoicePeerState,
  type ListenerPose,
} from "./voice.js";

import type { CommsLink } from "./link.js";
import type { MembershipSource } from "./membership.js";
import { ChatService, type ChatConfig } from "./chat.js";
import { VoiceService, type ListenerPose, type VoiceConfig } from "./voice.js";

export interface CommsOptions {
  link: CommsLink;
  membership: MembershipSource;
  /** World position of a participant (self included), or null when not in the world. */
  positionOf(peerId: string): readonly [number, number, number] | null;
  /** The local listener (camera) for spatial voice. */
  listenerPose?(): ListenerPose | null;
  /** Authority: apply "/team x" / "/party x" (write netState). Absent = disabled. */
  assign?(peerId: string, kind: "team" | "party", value: string | null): boolean;
  /** Tap delivered chat into the gameplay event bus as "chat.message". */
  emitEvent?(name: string, payload: unknown): void;
  chat?: ChatConfig;
  voice?: VoiceConfig;
}

export interface Comms {
  chat: ChatService;
  voice: VoiceService;
  /** Session changed: rebind both services. */
  setLink(link: CommsLink): void;
  /** Once per frame. */
  update(): void;
  dispose(): void;
}

/** The whole module in one call — chat + voice sharing membership, positions, and link. */
export function createComms(opts: CommsOptions): Comms {
  const chat = new ChatService({
    link: opts.link,
    membership: opts.membership,
    positionOf: opts.positionOf,
    ...(opts.assign ? { assign: opts.assign } : {}),
    ...(opts.emitEvent ? { emitEvent: opts.emitEvent } : {}),
    ...(opts.chat ? { config: opts.chat } : {}),
  });
  const voice = new VoiceService({
    link: opts.link,
    membership: opts.membership,
    positionOf: opts.positionOf,
    ...(opts.listenerPose ? { listenerPose: opts.listenerPose } : {}),
    ...(opts.voice ? { config: opts.voice } : {}),
  });
  return {
    chat,
    voice,
    setLink: (link) => {
      chat.setLink(link);
      voice.setLink(link);
    },
    update: () => voice.update(),
    dispose: () => {
      voice.dispose();
      chat.dispose();
    },
  };
}
