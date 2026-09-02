/**
 * CommsLink — how the comms module talks to the session, abstracted so the
 * same chat/voice code runs on the host, on a peer, and alone.
 *
 * It is a thin view over the room's MODULE channel (`RoomHost.onModule` /
 * `RoomClient.sendModule`): every message carries a module id, and the
 * star topology is preserved — a peer can only send to the host; the host
 * fans out. Anything peer↔peer (voice signaling) is relayed BY the host's
 * module handler, which validates the envelope before forwarding.
 */

import type { RoomClient, RoomHost } from "@hitreg/net";

export type CommsRole = "host" | "peer" | "local";

export interface CommsLink {
  readonly selfId: string;
  readonly selfName: string;
  readonly role: CommsRole;
  /** The authority's peer id (peers: the host; host: self; local: self). */
  readonly hostId: string;
  /** Every OTHER participant this endpoint can address (host: joined peers; peer: [host]). */
  peers(): string[];
  /** All participants including self, with names (host: full roster; peer: roster from the host). */
  roster(): Array<{ peerId: string; name: string }>;
  nameOf(peerId: string): string;
  /** Host: send to one peer. Peer: `to` must be the host. Local: no-op. */
  send(moduleId: string, to: string, data: unknown): void;
  onMessage(moduleId: string, cb: (from: string, data: unknown) => void): () => void;
  /** Roster changed (joins/leaves). */
  onRoster(cb: () => void): () => void;
}

/** Alone: nothing leaves the machine; chat echoes locally, voice has nobody to call. */
export function localLink(selfId: string, selfName: string): CommsLink {
  return {
    selfId,
    selfName,
    role: "local",
    hostId: selfId,
    peers: () => [],
    roster: () => [{ peerId: selfId, name: selfName }],
    nameOf: (id) => (id === selfId ? selfName : id),
    send: () => undefined,
    onMessage: () => () => undefined,
    onRoster: () => () => undefined,
  };
}

/**
 * The host's view. `host.peers()` is the joined set; roster changes are
 * observed through the transport's peer events by the app, which calls
 * the returned `notifyRoster()` — RoomHost itself has no roster hook.
 */
export function hostLink(
  host: RoomHost,
  selfId: string,
  selfName: string,
): CommsLink & { notifyRoster(): void } {
  const rosterHandlers = new Set<() => void>();
  return {
    selfId,
    selfName,
    role: "host",
    hostId: selfId,
    peers: () => host.peers().map((p) => p.peerId),
    roster: () => [{ peerId: selfId, name: selfName }, ...host.peers()],
    nameOf: (id) =>
      id === selfId ? selfName : (host.peers().find((p) => p.peerId === id)?.name ?? id),
    send: (moduleId, to, data) => host.sendModule(to, moduleId, data),
    onMessage: (moduleId, cb) => host.onModule(moduleId, cb),
    onRoster: (cb) => {
      rosterHandlers.add(cb);
      return () => {
        rosterHandlers.delete(cb);
      };
    },
    notifyRoster: () => {
      for (const cb of [...rosterHandlers]) cb();
    },
  };
}

/** A peer's view: the host is the only addressable endpoint. */
export function clientLink(
  client: RoomClient,
  hostId: string,
  hostName: string,
  selfId: string,
  selfName: string,
): CommsLink {
  return {
    selfId,
    selfName,
    role: "peer",
    hostId,
    peers: () => [hostId],
    roster: () => [
      { peerId: hostId, name: hostName },
      { peerId: selfId, name: selfName },
      ...client.peers(),
    ],
    nameOf: (id) =>
      id === selfId
        ? selfName
        : id === hostId
          ? hostName
          : (client.peers().find((p) => p.peerId === id)?.name ?? id),
    send: (moduleId, to, data) => {
      if (to === hostId) client.sendModule(moduleId, data);
    },
    onMessage: (moduleId, cb) => client.onModule(moduleId, (data) => cb(hostId, data)),
    onRoster: (cb) => client.onPeers(() => cb()),
  };
}
