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
 * of the valley they are on. Global rides the same bridge; proximity, team
 * and party stay per layer (team/party are netState the game assigns).
 *
 * A world without zones (a flat test scene) is one zone named after the
 * scene, so zone chat still works there.
 */

import { WS_HOST_ID } from "@hitreg/net";
import { regionAt } from "@hitreg/core";
import { ChatService, hostLink, netStateMembership, registerCommsNetState, type ChatMessage } from "@hitreg/comms";
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
  const zoneOf = (peerId: string): string | null => {
    const p = positionOf(peerId);
    if (!p) return null;
    const region = field ? regionAt(field.recipe.regions, p[0], p[2]) : null;
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
    ...(link
      ? {
          bridge: {
            publish: (msg: ChatMessage, scope: { zone: string | null }) => {
              if (msg.channel !== "zone" && msg.channel !== "global") return;
              link.chat({ id: msg.id, channel: msg.channel, from: msg.from, name: msg.name, text: msg.text, at: msg.at, zone: scope.zone });
            },
          },
        }
      : {}),
    config: { proximityRadius: opts.proximityRadius ?? 25 },
  });

  const offChat = link?.onChat((line: BridgedChatLine) => {
    const msg: ChatMessage = { id: line.id, channel: line.channel, from: line.from, name: line.name, text: line.text, at: line.at };
    foreignDelivered += chat.deliverForeign(msg, { zone: line.zone });
  });
  log(`[serve] chat: ${link ? "zone/global bridged through main" : "this server only"}`);

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
