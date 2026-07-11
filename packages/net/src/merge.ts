/**
 * mergeTransports — one Transport facade over several underlying transports.
 *
 * The host-side companion to the relay fallback: a host listens on WebRTC
 * AND the relay at once, so each client can connect over whichever works in
 * its environment. Upper layers (RoomHost) see a single peer set.
 *
 * Rules:
 * - A peer belongs to whichever transport reported it "connected" last;
 *   sends route there. (Clients use one transport at a time, so overlap
 *   only happens across a reconnect — latest wins.)
 * - "connected" is dispatched on 0→1 ownership, "disconnected" only when
 *   the owning transport drops the peer.
 * - close() closes every underlying transport.
 */

import type { Channel, PeerState, Transport } from "./transport.js";

export function mergeTransports(transports: Transport[]): Transport {
  if (transports.length === 0) throw new Error("mergeTransports: no transports given");
  const localId = transports[0]!.localId;
  for (const t of transports) {
    if (t.localId !== localId) {
      throw new Error(
        `mergeTransports: mismatched local ids ("${localId}" vs "${t.localId}")`,
      );
    }
  }

  const owner = new Map<string, Transport>();
  const messageHandlers = new Set<(from: string, channel: Channel, data: Uint8Array) => void>();
  const peerHandlers = new Set<(peer: string, state: PeerState) => void>();
  let closed = false;

  const dispatchPeer = (peer: string, state: PeerState) => {
    if (closed) return;
    for (const cb of [...peerHandlers]) cb(peer, state);
  };

  const unsubs: Array<() => void> = [];
  for (const t of transports) {
    unsubs.push(
      t.onMessage((from, channel, data) => {
        if (closed) return;
        for (const cb of [...messageHandlers]) cb(from, channel, data);
      }),
      t.onPeer((peer, state) => {
        if (state === "connected") {
          const isNew = !owner.has(peer);
          owner.set(peer, t); // latest connect wins ownership
          if (isNew) dispatchPeer(peer, "connected");
        } else if (owner.get(peer) === t) {
          owner.delete(peer);
          dispatchPeer(peer, "disconnected");
        }
      }),
    );
  }

  return {
    localId,
    peers: () => [...owner.keys()],
    send: (peer, channel, data) => {
      if (closed) return;
      owner.get(peer)?.send(peer, channel, data);
    },
    broadcast: (channel, data) => {
      if (closed) return;
      for (const [peer, t] of owner) t.send(peer, channel, data);
    },
    onMessage: (cb) => {
      messageHandlers.add(cb);
      return () => messageHandlers.delete(cb);
    },
    onPeer: (cb) => {
      peerHandlers.add(cb);
      return () => peerHandlers.delete(cb);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const unsub of unsubs.splice(0)) unsub();
      owner.clear();
      for (const t of transports) t.close();
    },
  };
}
