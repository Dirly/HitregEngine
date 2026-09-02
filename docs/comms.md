# Comms — text chat and VoIP (`@hitreg/comms`)

A drop-in module for player communication: **text chat and voice, each on
four channels — proximity, global, team, party** — that plugs into any
game built on the engine's room protocol. Headless core with tests; the
browser parts (mic, WebRTC, WebAudio, the default overlay) are opt-in.

```ts
import { createComms, hostLink, clientLink, localLink, netStateMembership,
         registerCommsNetState, registerCommsEvents } from "@hitreg/comms";
import { mountCommsUI } from "@hitreg/comms/ui";

registerCommsNetState(netState);   // comms.team/<peer>, comms.party/<peer> (spec'd)
registerCommsEvents(events);       // "chat.message" (local-only) for scripts

const comms = createComms({
  link: localLink(selfId, name),                 // swap per session (below)
  membership: netStateMembership(netState),      // who is on which team/party
  positionOf: (peer) => world.positionOf(peer),  // null = not in the world
  listenerPose: () => cameraPose(),              // spatial voice
  assign: (peer, kind, value) => netState.set(`comms.${kind}/${peer}`, value), // "/team red"
  emitEvent: (name, p) => bus.emit(name, p),
  chat:  { proximityRadius: 25 },
  voice: { proximityRadius: 25, mode: "ptt" },
});
mountCommsUI({ chat: comms.chat, voice: comms.voice });
comms.voice.attachKeyboard(window);   // V = say, B = team, N = party (push-to-talk)
// session changes: host → hostLink(roomHost, …), peer → clientLink(roomClient, …), alone → localLink
comms.setLink(link);
// once per frame
comms.update();
```

In the playground this is already wired (`apps/playground/src/main.ts`):
Enter opens chat, `/g /t /p /s` pick a channel for one line, Tab cycles,
`/team red` and `/party blue` self-assign (a rules-driven game turns
`allowSelfAssign` off and assigns from a script), the mic button enables
voice.

## How it plugs in: the module channel

`@hitreg/net`'s room protocol carries a `module` message in both
directions — `{ t: "module", id, data }` — with `RoomHost.onModule(id, cb)`
/ `sendModule` / `broadcastModule` and `RoomClient.onModule` / `sendModule`.
It's an opaque, reliable-ordered envelope for features that ride the room
without extending the core protocol: comms uses ids `"chat"` and `"voice"`;
emotes, votes, or a scoreboard can use their own. **The trust rule holds:**
a host-side module handler treats client data as a *request* to validate,
never as state to apply. `CommsLink` is the thin view over this channel
that chat and voice code against (`hostLink` / `clientLink` / `localLink`).

## One routing rule, two media

`recipientsFor(sender, channel, participants, ctx, radius)` decides who may
hear whom — global: everyone; team/party: peers sharing the sender's
membership (a sender with none is refused); proximity: peers within the
radius of the sender's position (a sender not in the world is refused).
Text applies it **on the host**, voice **on the sender**:

- **Text** — a peer sends `{k:"say"}` to the host; the host sanitizes
  (control chars stripped, whitespace collapsed, 240 chars), rate-limits
  (token bucket: 5 burst, 2/s sustained), routes, and delivers a stamped
  `ChatMessage` to exactly the allowed peers. A tab that shouldn't see a
  team line never receives its bytes — a client-side filter would be one
  devtools call from a leak. Refusals come back as a local system line.
- **Voice** — a full mesh of audio-only `RTCPeerConnection`s among the
  players with voice enabled, signaled through the host (`{k:"sig", from,
  to}` envelopes the host relays after checking `from` is the real sender;
  the lexicographically smaller id offers, so there's no glare). Every
  outgoing link carries its own *clone* of the mic track, enabled per frame
  only while you're transmitting on a channel that peer may hear — team
  voice never leaves the team at the packet level. Receivers only shape
  what arrives: proximity audio goes through a WebAudio `PannerNode` at the
  speaker's world position (listener = camera) with `proximityGain`'s
  roll-off (full inside `fullVolumeRadius`, silent at `proximityRadius`,
  matching the sender's gate so there's no audible cut); team/party/global
  play flat. Push-to-talk per channel, or open mic with a hysteresis VAD
  (`VoiceGate`). Mute stops the source track (belt) *and* the clones
  (suspenders). Mesh cap `maxPeers` (16) — beyond that, use a server-hosted
  SFU, which is the right answer for an MMO anyway.

## Membership is netState

Team and party are ordinary replicated facts: `comms.team/<peerId>` and
`comms.party/<peerId>` (schemas registered by `registerCommsNetState`, so
they validate and show in `/__hitreg/spec`'s `netState`). A script assigns
teams with what it already has —
`ctx.netState.set("comms.team/" + peerId, "red")` on the authority — and a
scoreboard reads the same keys. Every peer holds the replica, so a promoted
host inherits membership through migration for free.

## Scripts

`ctx.chat` (when the app mounts comms): `send(channel, text)` speaks as this
tab's player; `announce(text)` posts a system line to everyone when run on
the authority; `system(text)` is local; `on(cb)` / `history()` see only the
lines this tab was allowed to receive (auto-unsubscribed on dispose). The
same lines arrive on the event bus as `chat.message { channel, from, name,
text }` — local-only by construction — for chat commands ("!ready"), bots,
or reactions. Example: a script that starts the round when every player has
typed `!ready` is `ctx.chat.on` + a Set + `ctx.netState`.

## Adding it to a new game

1. `registerCommsNetState` + `registerCommsEvents` at bootstrap.
2. `createComms` with a `positionOf` (your presence layer) and a
   `listenerPose` (your camera).
3. `setLink` whenever the session changes (the playground does it from
   `NetPresence.onSession`).
4. Mount the default UI or build your own on `chat.onMessage` /
   `voice.onChange` — the services are UI-agnostic.
5. Gate hotkeys on `ui.isTyping()` if your input layer doesn't already
   ignore form fields.

## Limits and what comes next

- P2P mesh voice scales to party/lobby sizes, not servers — the
  server milestone gets an SFU (same `CommsLink`, different transport).
- Mesh voice needs a TURN server for peers behind symmetric NAT (config
  `iceServers`); dev uses STUN only, like the data transport.
- Moderation (mute lists, reports, profanity) is platform-side and not
  here; `ChatRouter` is where a per-peer block list would slot in.
- Names come from the room roster (`hello`), i.e. the dev `guest-xxxx`
  identities; the platform's identity service replaces that.
