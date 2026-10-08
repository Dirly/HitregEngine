/**
 * Text chat on a dedicated layer.
 *
 * The playground's comms module routes chat on the session HOST, and on a
 * dedicated server the host is this process — so without this file a
 * client's `{k:"say"}` lands on a server with nobody listening and chat is
 * silently dead in every hosted game. Here the layer runs the same
 * `ChatService` a P2P host runs, over `hostLink(server.host)`, with the
 * world supplying positions and zones.
 *
 * ZONE chat is the cluster's answer to "the world is vast and I never see
 * the other 40": a zone line is delivered to every player standing in that
 * recipe zone on THIS layer, then published up the cluster link; main fans
 * it to every other layer, each of which delivers it to its own players in
 * that zone (`deliverForeign`). Everyone in the valley talks, whichever copy
 * of the valley they are on. Global and PARTY ride the same bridge — main
 * owns the party list, pushes each member's party into their layer's
 * netState (`comms.party/<characterId>`) and stamps the sender's party on
 * every bridged party line; proximity and team stay per layer.
 *
 * A world without zones (a flat test scene) is one zone named after the
 * scene, so zone chat still works there.
 *
 * Every line this layer delivers — routed here or bridged in — also lands in
 * a rolling moderation buffer (`moderation/chat-buffer.ts`, 15 minutes): who
 * said it, from which account, where they stood, in which zone, and who
 * received it. Main asks for the slice involving two characters when one
 * reports the other (`evidence`, docs/moderation.md §2); nothing else ever
 * leaves memory.
 */

import { WS_HOST_ID } from "@hitreg/net";
import { regionAt, type RegionDoc } from "@hitreg/core";
import { BRIDGED_CHANNELS, CHAT_MODULE, ChatService, hostLink, netStateMembership, registerCommsNetState, type BridgeScope, type ChatMessage } from "@hitreg/comms";
import type { GameServer } from "./server.js";
import type { ClusterLink } from "./cluster/link.js";
import type { BridgedChatLine } from "./cluster/protocol.js";
import { ChatBuffer, LAYER_CHAT_BUFFER_LINES, toEvidenceLine, type BufferedChatLine, type ChatBufferOptions, type ChatEvidence, type EvidencePlace } from "./moderation/chat-buffer.js";

export interface LayerChatOptions {
  server: GameServer;
  scene: string;
  /** Cluster link; absent on an open/standalone server (chat is then per server). */
  link: ClusterLink | null;
  /** Meters for "say" (default 25). */
  proximityRadius?: number;
  /** Zones to use instead of the recipe's (a flat test scene given borders). */
  regions?: ReadonlyArray<RegionDoc>;
  /** Block lists: may `recipient` hear `sender`? Absent = everyone. */
  mayHear?: (recipient: string, sender: string) => boolean;
  /**
   * Mutes (docs/moderation.md §3): the line to show a sender whose chat is
   * refused right now, or null. A muted player's every `say` is dropped
   * before routing — nobody hears it, nothing is buffered or bridged — and
   * answered with this line (a system line on their client), once per try.
   */
  muted?: (sender: string) => string | null;
  /** This server's id, stamped on the lines it buffers (default "layer"). */
  serverId?: string;
  /** Moderation buffer bounds (default 15 minutes, 5000 lines). */
  buffer?: ChatBufferOptions;
  log?: (line: string) => void;
}

export interface LayerChat {
  chat: ChatService;
  /** The zone a player stands in right now, or null when not in the world. */
  zoneOf(peerId: string): string | null;
  /** Bridged lines delivered here from other layers (diagnostics). */
  readonly foreignDelivered: number;
  /** The rolling moderation buffer of every line delivered here. */
  readonly buffer: ChatBuffer;
  /**
   * Evidence for a report (docs/moderation.md §2): the buffered lines either
   * character spoke in the last `minutes`, whether each of them received them,
   * and where both stand now. Other players' lines are never included.
   */
  evidence(reporter: string, target: string, minutes?: number): ChatEvidence;
  dispose(): void;
}

export function mountLayerChat(opts: LayerChatOptions): LayerChat {
  const { server, link } = opts;
  const world = server.world;
  const log = opts.log ?? (() => undefined);
  try {
    registerCommsNetState(world.netState);
  } catch {
    // already registered by whoever built this world — fine
  }

  const positionOf = (peerId: string): [number, number, number] | null => {
    const player = server.players.get(peerId);
    return player ? world.positionOf(player.bodyId) : null;
  };
  // A zone is an agent-drawn REGION (recipe.regions) when the world has them;
  // failing that the generator's climate cell; failing that the whole scene.
  const field = server.terrain?.resolved.field ?? null;
  const regions: ReadonlyArray<RegionDoc> = opts.regions ?? field?.recipe.regions ?? [];
  const zoneOf = (peerId: string): string | null => {
    const p = positionOf(peerId);
    if (!p) return null;
    const region = regionAt(regions, p[0], p[2]);
    if (region) return region.id;
    const id = field ? field.zone(p[0], p[2]).id : "";
    return id.length > 0 ? id : opts.scene;
  };

  // -- moderation buffer: tap every delivery the chat service makes -----------------
  // One routed line is ONE ChatMessage object sent to each recipient in turn
  // (the sender always among them), so the first send of a new object opens a
  // buffer entry and the following sends add their recipients to it.
  const serverId = opts.serverId ?? "layer";
  const buffer = new ChatBuffer({ maxLines: LAYER_CHAT_BUFFER_LINES, ...opts.buffer });
  /** Set while a bridged line from another server is being delivered here. */
  let foreign: { origin: string; zone: string | null } | null = null;
  let lastMsg: ChatMessage | null = null;
  let lastLine: BufferedChatLine | null = null;
  const record = (msg: ChatMessage, recipient: string): void => {
    if (msg.channel === "system" || msg.from === "system") return;
    if (msg !== lastMsg || !lastLine) {
      lastMsg = msg;
      const position = foreign ? null : positionOf(msg.from);
      lastLine = buffer.push({
        id: msg.id,
        channel: msg.channel,
        from: msg.from,
        account: server.players.get(msg.from)?.identity?.playerId ?? null,
        name: msg.name,
        text: msg.text,
        at: msg.at,
        position: position ? [position[0], position[1], position[2]] : null,
        zone: foreign ? foreign.zone : zoneOf(msg.from),
        origin: foreign ? foreign.origin : serverId,
        to: [],
      });
    }
    if (recipient !== msg.from) lastLine.to!.push(recipient);
  };
  const baseLink = hostLink(server.host, WS_HOST_ID, "server");
  const tappedLink: typeof baseLink = {
    ...baseLink,
    send: (moduleId, to, data) => {
      if (moduleId === CHAT_MODULE) {
        const d = data as { k?: unknown; msg?: ChatMessage } | null;
        if (d && d.k === "msg" && d.msg) record(d.msg, to);
      }
      baseLink.send(moduleId, to, data);
    },
    onMessage: (moduleId, cb) =>
      baseLink.onMessage(
        moduleId,
        moduleId !== CHAT_MODULE || !opts.muted
          ? cb
          : (from, data) => {
              const why = (data as { k?: unknown } | null)?.k === "say" ? opts.muted!(from) : null;
              if (why) baseLink.send(CHAT_MODULE, from, { k: "err", text: why });
              else cb(from, data);
            },
      ),
  };

  let foreignDelivered = 0;
  const chat = new ChatService({
    link: tappedLink,
    membership: netStateMembership(world.netState),
    positionOf,
    zoneOf,
    assign: (peerId, kind, value) => {
      const key = `comms.${kind}/${peerId}`;
      if (value === null) {
        world.netState.delete(key);
        return true;
      }
      return world.netState.set(key, value);
    },
    emitEvent: (name, payload) => world.eventBus.emit(name, payload),
    ...(opts.mayHear ? { mayHear: opts.mayHear } : {}),
    ...(link
      ? {
          bridge: {
            publish: (msg: ChatMessage, scope: BridgeScope) => {
              if (msg.channel === "system" || !BRIDGED_CHANNELS.includes(msg.channel)) return;
              link.chat({ id: msg.id, channel: msg.channel as "zone" | "global" | "party" | "guild", from: msg.from, name: msg.name, text: msg.text, at: msg.at, zone: scope.zone, party: scope.party ?? null, guild: scope.guild ?? null });
            },
          },
        }
      : {}),
    config: { proximityRadius: opts.proximityRadius ?? 25 },
  });

  const offChat = link?.onChat((line: BridgedChatLine, origin: string) => {
    const msg: ChatMessage = { id: line.id, channel: line.channel, from: line.from, name: line.name, text: line.text, at: line.at };
    foreign = { origin, zone: line.zone };
    try {
      foreignDelivered += chat.deliverForeign(msg, { zone: line.zone, party: line.party ?? null, guild: line.guild ?? null });
    } finally {
      foreign = null;
    }
  });
  log(`[serve] chat: ${link ? "zone/global/party bridged through main" : "this server only"}`);

  const placeOf = (characterId: string): EvidencePlace => {
    const p = positionOf(characterId);
    return { characterId, here: server.players.has(characterId), position: p ? [p[0], p[1], p[2]] : null, zone: p ? zoneOf(characterId) : null };
  };
  const evidence = (reporter: string, target: string, minutes = buffer.windowMs / 60_000): ChatEvidence => ({
    server: serverId,
    scene: opts.scene,
    collectedAt: Date.now(),
    minutes,
    reporter: placeOf(reporter),
    target: placeOf(target),
    lines: buffer.involving(reporter, target, minutes).map((l) => toEvidenceLine(l, reporter, target, serverId)),
  });

  return {
    chat,
    zoneOf,
    get foreignDelivered() {
      return foreignDelivered;
    },
    buffer,
    evidence,
    dispose: () => {
      offChat?.();
      chat.dispose();
      buffer.clear();
    },
  };
}
