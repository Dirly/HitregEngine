# HitReg — Vision & Roadmap

**Status:** Direction set 2026-07-09. ARCHITECTURE.md holds the locked technical
decisions that serve this vision.

## Thesis

A metaverse built from the ground up for AI construction — Roblox's social loop
with the creation barrier removed by AI, on the one platform AI is natively
fluent in: the web.

Two structural advantages no incumbent engine has:

1. **The runtime is a website, and the AI's primary sense is data, not pixels.**
   Traditional engines are opaque to AI — it squints at screenshots. Here the
   running game *is* structured text (JSON scene docs, schemas, queryable ECS
   state). The AI reads the world, edits it through the same ops channel the
   editor uses, and sees its changes as diffs. Models are more fluent in
   web/Three.js than any other game substrate, by training-data volume alone.
2. **Zero-install joins.** Roblox requires a client download; a URL that drops
   you into your friend's world on a phone or school Chromebook is *less*
   friction than Roblox. Friction is the whole game for the kid demographic.

The market proof: Roblox's biggest hits (99 Nights in the Forest, Steal a
Brainrot) are not technically hard. The creation barrier AI removes is the real
barrier. What AI does *not* remove: the player network (cold start is the #1
risk) and trust & safety (kids + UGC + AI generation — a core competency the
moment sharing goes public, with COPPA and content-filtering obligations).

## The back-and-forth that makes it work

The core loop is developer/player standing *inside* the running game:

> Click the crate. "Hey, it'd be great if the player could pick this up."

The click is the context — the AI receives the entity's GUID, component JSON,
prefab lineage, and surroundings (not a screenshot with a crate somewhere in
it). The request resolves to a data op: attach the standard `pickable`
component. Instant, schema-validated, undoable. Most creation is composing the
standard vocabulary; new code is the escape hatch, and good escape hatches
graduate into the vocabulary.

## North-star demo

*A kid types a prompt; a world exists sixty seconds later; they text a link; a
friend joins from a phone browser; they edit the world together by talking to
AI while standing in it.*

This demo is the pitch, the marketing asset, and the forcing function. It
requires: engine, hosting, avatars, presence, live AI editing. It does NOT
require: discovery feed, economy, content library at Roblox scale.

## Phased roadmap

**Phase 1 — Engine kernel.** Build the engine per ARCHITECTURE.md (core →
render → editor → MCP → physics → scripting → net → perf). Exit criteria: it
runs, AI can build and modify a live scene, multiplayer works.

**Phase 2 — Proving-ground game.** Build a real (small, multiplayer) game with
the engine. Nothing exposes a fake abstraction like real use. Exit criteria: a
game fun enough to share, built substantially through the AI loop.
A big static scene proves nothing — the slice must deliberately pressure the
whole platform at once: streaming/partitioning, instancing, animation and
physics-body counts, character controllers, asset load/dispose, network
interest management, persistence, editing performance, AI context retrieval,
publish/rollback. Think: a multiplayer town — reusable buildings, NPCs,
physics props, combat, inventory, quests, persistent housing, avatar
cosmetics, multiple streamed regions.

**Phase 3 — Identity & sharing.** Persistent avatar (a user-owned JSON prefab
that follows the account across worlds; games may constrain/restyle it),
friends/presence, publish + join-by-link, instant world provisioning (headless
Node sim per world — the engine is already renderer-free server-side).

**Phase 4 — Metaverse platform.** Discovery, the social layer at scale,
moderation infrastructure, creator ecosystem. Only if the Phase 3 magic moment
lands.

**Publishing is a spectrum the whole way:** standalone web or Electron/Steam
export always works; metaverse-attached is an option creators add, not a cage.

## Standing risks

- **Cold start / distribution** — AI lowers the creation barrier, not the
  player-network barrier. Marketing and social loops are product work, not
  engine work.
- **Trust & safety** — kids + UGC + AI generation. Deferred, not ignored.
- **AI cost model** — Roblox creation is free to the creator; AI tokens are not.
  Quotas/freemium to be designed in Phase 3.
