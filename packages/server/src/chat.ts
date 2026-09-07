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
 */

import { WS_HOST_ID } from "@hitreg/net";
import { regionAt, type RegionDoc } from "@hitreg/core";
import { BRIDGED_CHANNELS, ChatService, hostLink, netStateMembership, registerCommsNetState, type BridgeScope, type ChatMessage } from "@hitreg/comms";
import type { GameServer } from "./server.js";
import type { ClusterLink } from "./cluster/link.js";
import type { BridgedChatLine } from "./cluster/protocol.js";

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
  log?: (line: string) => void;
}

export interface LayerChat {
  chat: ChatService;
  /** The zone a player stands in right now, or null when not in the world. */
  zoneOf(peerId: string): string | null;
  /** Bridged lines delivered here from other layers (diagnostics). */
  readonly foreignDelivered: number;
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

  let foreignDelivered = 0;
  const chat = new ChatService({
    link: hostLink(server.host, WS_HOST_ID, "server"),
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
              link.chat({ id: msg.id, channel: msg.channel as "zone" | "global" | "party", from: msg.from, name: msg.name, text: msg.text, at: msg.at, zone: scope.zone, party: scope.party ?? null });
            },
          },
        }
      : {}),
    config: { proximityRadius: opts.proximityRadius ?? 25 },
  });

  const offChat = link?.onChat((line: BridgedChatLine) => {
    const msg: ChatMessage = { id: line.id, channel: line.channel, from: line.from, name: line.name, text: line.text, at: line.at };
    foreignDelivered += chat.deliverForeign(msg, { zone: line.zone, party: line.party ?? null });
  });
  log(`[serve] chat: ${link ? "zone/global/party bridged through main" : "this server only"}`);

  return {
    chat,
    zoneOf,
    get foreignDelivered() {
      return foreignDelivered;
    },
    dispose: () => {
      offChat?.();
      chat.dispose();
    },
  };
}
