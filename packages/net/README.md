# @hitreg/net

Networking stack, milestone 0+: transport abstraction, in-memory loopback
transport, the room protocol, and a WebRTC DataChannel transport adapter.
Engine-agnostic — zero runtime deps, no imports from `@hitreg/core` (sim
integration is milestone 1).

## Three layers

```
┌────────────────────┐
│     simulation     │  fixed-tick game state (not in this package yet)
└─────────┬──────────┘
          │ input commands ↓ / snapshots ↑
┌─────────┴──────────┐
│ replication (room) │  RoomHost / RoomClient — protocol.ts envelope
└─────────┬──────────┘
          │ Uint8Array on "reliable" | "unreliable" channels
┌─────────┴──────────┐
│     transport      │  Transport interface — LoopbackHub today,
└────────────────────┘  WebRTC / WebSocket / WebTransport adapters later
```

The simulation never knows which transport carries its packets; authority
location (P2P host vs dedicated server) is a deployment choice.

## Trust rule (hard)

Clients send input **commands** (intentions), never state. The authoritative
side (host) is the only producer of snapshots. `RoomHost` has no code path
that applies state from a client — host-only message types arriving from a
client are dropped with a one-time warning. Commands carry per-client seq
numbers; duplicates and reordered replays are dropped.

## What exists

- `Transport` — peer ids, `reliable`/`unreliable` channels, `Uint8Array`
  payloads, message + peer-lifecycle subscriptions.
- `LoopbackHub` — in-memory hub for any number of peers (single-player and
  tests; the reference behavior for future adapters). Delivery is always
  async (microtask) to force real-network code paths; optional deterministic
  test modes: `manualFlush` (deliver only on `hub.flush()`) and a `drop` rule
  (pattern array or counter predicate — never `Math.random`) for the
  unreliable channel.
- `protocol.ts` — message envelope: 1-byte format tag (`0x01` = JSON) then
  payload, so binary snapshot encoding can arrive later as a new tag.
  `hello`/`command`/`bye` upstream; `welcome`/`snapshot`/`peerJoined`/
  `peerLeft`/`reject` downstream.
- `RoomHost` — admits hellos (up to `maxPeers`), injects state via
  `setStateSource(full, delta?)`, dedups commands, broadcasts a snapshot on
  the unreliable channel every `snapshotEvery` ticks (default 3; full state
  in v1, delta hook wired).
- `RoomClient` — `join(name)`, auto tick/seq `sendCommand(input)`,
  `onSnapshot`, `onPeers`, tolerates the host or other peers vanishing.
- `webrtc.ts` — `WebRtcHostTransport` / `WebRtcClientTransport`: WebRTC
  DataChannels in a host-star topology (every peer dials the host). Two
  channels per connection — `reliable` (ordered) and `unreliable` (unordered,
  zero retransmits) — binary mode. Signaling (SDP offer/answer + trickle ICE)
  is injected via the small `SignalingChannel` interface; STUN-only in dev
  (no TURN until the platform milestone). Node-safe to import, browser-only
  to run — live RTC is exercised by the playground, not unit tests.

### Dev demo (playground)

The playground's vite dev server doubles as the signaling relay
(`hitreg:net-signal` over the vite websocket): room membership per scene
(`scene:<name>`), host = first joiner still present, SDP/ICE envelopes
relayed between tabs. Open the same scene in two tabs, enter play mode in
both, and each tab renders the other's player as a colored capsule with a
name label (`apps/playground/src/net-presence.ts`); the HUD shows
`net: host|peer · N players`. Game traffic is pure P2P — the dev server
only brokers the connection.

## What's next

- WebSocket / WebTransport transport adapters; TURN for NAT-blocked peers.
- Simulation integration (milestone 1): fixed-tick loop feeding
  commands in, snapshots out of `@hitreg/core` state.
- Client-side prediction + reconciliation.
- Binary snapshot encoding (new format tag) alongside ECS tables.
- Interest management (per-peer relevancy filtering).
