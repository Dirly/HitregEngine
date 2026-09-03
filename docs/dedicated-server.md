# Dedicated game server

**Status: in progress (overnight build, started 2026-09-02).** The RESUME
section at the bottom is the hand-off note — read it first if you are picking
this up cold.

## What it is

A headless Node process that runs the SAME simulation a P2P host tab runs today
(ARCHITECTURE §3 / §3a: "where the authority runs is a deployment choice"),
so a scene streams its voxel world, simulates its NPCs, validates every combat
cast, and owns every player's movement — with browser tabs connecting as
ordinary `RoomClient`s over a WebSocket transport instead of electing one of
themselves as host.

Nothing in the room protocol changes. What the server adds on top:

| layer | piece | where |
| --- | --- | --- |
| transport | `WebSocketHostTransport` (Node, `ws`) / `WebSocketClientTransport` (browser + Node) | `@hitreg/net` (`./server` entry for the host side) |
| simulation | `HeadlessWorld` — registries, expanded scene, headless `Object3D` map, `PhysicsSim`, `EventBus`, `NetStateStore`, `ScriptRuntime`, voxel collider streamer, fixed loop | `@hitreg/server` |
| session | `GameServer` — `RoomHost` + per-peer player entities + server-side movement driver + snapshots/events/state fan-out + the `world` spawn module | `@hitreg/server` |
| population | `NpcManager` — spawn/despawn/respawn at runtime; the hook the AI dungeon master drives | `@hitreg/server` |
| ops | HTTP admin (`/admin/*`) — list players/NPCs, spawn, despawn, netState dump | `@hitreg/server` |
| client | `?server=ws://…` mode in the playground: pure client, no election, spawns replicated entity docs the server sends | `apps/playground` |

## Milestones (checked = verified headless)

- [ ] M1 WebSocket transport + tests
- [ ] M2 `@hitreg/server`: headless world boots a project scene, streams terrain colliders around players, ticks scripts
- [ ] M3 players: join → server spawns the player template, drives the body from movement intent, combat requests validated against `owner/<entity>`
- [ ] M4 playground `?server=` client mode with replicated spawn/despawn
- [ ] M5 NPC manager + admin endpoints + respawn
- [ ] M6 `mmo` project: voxel-demo world + combat roster, one scene the server hosts
- [ ] M7 two-client headless verification (Playwright), RESUME written

## Design decisions (made overnight — Derek to ratify)

1. **Players are replicated entity docs, not a scene-doc `player`.** The
   server clones the scene's `player`-tagged subtree as a template per joiner
   (`player:<peerId>` ids), sends the docs to every client through the
   `world` module, and the joining client builds *its own* body from that doc.
   One id everywhere: netState keys, cast requests, snapshots. In server mode
   the client ignores the scene doc's own player entity.
2. **The server does not run `third-person-controller`.** Input is per-tab;
   the server has one `ScriptRuntime`. Player bodies are driven by
   `PlayerDriver` from the same movement-intent command the P2P host already
   accepts (clamped desired velocity + jump + yaw), honouring the body's
   `speedMult` / `frozen` / `impulseVel` userData channels the combat scripts
   write — so a dash, a stagger and armour weight all still apply.
3. **Ownership is netState.** `owner/<entityId> = peerId` and
   `player/<peerId> = entityId`. A to-authority request whose `meta.from`
   does not own the entity it names is dropped — the trust check every
   authoritative handler needs, expressed as data every script can read.
4. **Terrain on the server is colliders only.** The same `voxelChunkDoc` →
   `chunkToSceneDoc` → `expandScene` → `sim.addEntities` path the browser's
   ChunkManager uses, minus rendering: cells in the simulation ring around
   every player, hysteresis on leave.
5. **NPC spawn/despawn replicates as entity docs** on the `world` module
   (reliable). This is the missing "runtime spawn replication" item from the
   multiplayer roadmap, done for the server case first.

## RESUME

(filled in as milestones land)
