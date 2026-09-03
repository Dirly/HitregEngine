# Dedicated game server

**Status: basics working end to end (overnight build, 2026-09-02 → 03).** The
RESUME section at the bottom is the hand-off note — read it first if you are
picking this up cold.

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
| ops | HTTP admin (`/admin/*`) — list players/NPCs, spawn, despawn, netState dump, events trace, **terraform** | `@hitreg/server` |
| client | `?server=ws://…` mode in the playground: pure client, no election, spawns replicated entity docs the server sends | `apps/playground` |

## Milestones (checked = verified headless)

- [x] M1 WebSocket transport + tests (`packages/net/test/websocket.test.ts`)
- [x] M2 `@hitreg/server`: headless world boots a project scene, streams terrain colliders around players, ticks scripts
- [x] M3 players: join → server spawns the player template, drives the body from movement intent, combat requests validated against `owner/<entity>`
- [x] M4 playground `?server=` client mode with replicated spawn/despawn
- [x] M5 NPC manager + admin endpoints + respawn
- [x] M6 `mmo` project: voxel-demo world + combat roster, one scene the server hosts
- [x] M7 two-client headless verification (Playwright, real WebGPU Chrome), RESUME written
- [x] M8 terraform: `POST /admin/terraform` applies recipe edits on the server (touched cells re-cook), clients re-stream, the recipe file is saved; the inverse batch undoes

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

## Editing the world from outside (the DM hook)

```
curl -s -X POST http://127.0.0.1:8787/admin/terraform -H 'content-type: application/json' -d '{
  "edits": [
    { "edit": "add-feature", "kind": "blobs",
      "feature": { "id": "crater", "center": [1663, 47, -6252], "radius": 5, "op": "remove", "falloff": 2.5 } }
  ]}'
# → { ok, inverse: [...], added: ["crater"], touchedCells: [[34,-131]], reloaded: ["34_-131"] }
```

The batch is the same `RecipeEdit` vocabulary the worldgen CLI and editor
use (`RECIPE_EDIT_SPECS` in @hitreg/core, in `spec.json`), validated and
atomic. The server re-cooks only the resident cells the footprint touched,
every client gets the new recipe over the `world` module and re-streams,
and the recipe file is written back (atomic rename) because the recipe IS
the world save — restart the server and the crater is still there. POST the
returned `inverse` to undo. `--no-persist` for experiments. Verified live:
a crater and a pillar appeared in a connected client within a few seconds;
the undo removed them (iteration 3).

## How to run it

```
pnpm -F @hitreg/server serve --scene mmo              # ws://127.0.0.1:8787 + admin HTTP on the same port
pnpm -F playground dev                                 # the usual playground
# then open, in as many tabs/machines as you like:
http://localhost:5173/?server=ws://127.0.0.1:8787      # press ` to play
curl -s http://127.0.0.1:8787/admin/status             # who is on, where
curl -s http://127.0.0.1:8787/admin/npcs
curl -s -X POST http://127.0.0.1:8787/admin/spawn -H 'content-type: application/json' \
  -d '{"template":"hero0","at":[1670,50,-6250],"id":"boss"}'
```

`--host 0.0.0.0` serves the LAN. `--scene field` hosts combat-demo's terrain
scene instead; any project scene with a `player`-tagged entity works.
The setting also persists per browser: `localStorage.setItem("hitreg:server",
"ws://…")` — remove it to go back to P2P dev rooms.

## What was verified (2026-09-03, all headless)

- `packages/net`: real socket pair, both channels, id collision rename,
  reject past maxPeers, the room protocol end to end.
- `packages/server/test/field.test.ts` (loopback hub, combat-demo `field`):
  join → body spawned from the template with params rewritten → docs sent
  with `self` → ground streamed under it → walks from intent, speed clamped
  (a claimed 100 m/s moves at sprint cap) → strike request validated,
  stamina spent on the server, dummy damaged → a request naming a body the
  sender does not own is dropped → leave tears everything down.
- `packages/server/test/serve.test.ts` (real `ws` + HTTP, port 0): two
  clients see each other's bodies, spawn/despawn through the admin API,
  a killed dummy respawns with full pools after the delay.
- Two headless Chrome tabs (Playwright, WebGPU) on `field` AND on `mmo`:
  both join as `peer (ws)`, each renders the other's character model,
  a held W key moves the body ~8 m on the server, Digit4 (meteor) spends 30
  mana and Digit2 (cleave) 21 stamina on the server, nothing else runs
  locally for the other player (console: `host-simulated entities: +7 -0`).

## RESUME

**Morning checklist (2026-09-03).** Five overnight iterations, 12 commits on
`feat/ai-native-tweakability`, every package's tests and typecheck green.

1. `pnpm -F @hitreg/server serve --scene mmo` in one terminal, `pnpm -F playground dev`
   in another, open `http://localhost:5173/?server=ws://127.0.0.1:8787` in two
   browsers (or one browser + a second machine on the LAN with `--host 0.0.0.0`),
   press ` in both. You should see each other's characters run, cast, and be
   fought by the heroes. `curl -s localhost:8787/admin/status` while you play.
2. Then read **Design decisions** above and say which to keep.
3. Then the **Known gaps** below — each is a one-line decision.

**Where things stand.** Movement and combat work online against a dedicated
Node server, with the server owning every player body, every NPC, every
cast and the terrain colliders; the world can be edited live from the admin
API (terraform), and the edit is the save. Nothing else persists yet
(player state dies with the body); nothing is authenticated; one scene per
process; ~50 players per process at 60 Hz with headroom.

**Uncommitted content changes** (project folders are gitignored; combat-demo
is not a git repo yet, voxel-demo untouched, `mmo` got its own repo):
- `projects/combat-demo/scripts/combat-caster.ts`: ownership check on
  `combat.cast.request`, dash as `combat.dash.request` (to-authority, with
  local prediction).
- `projects/combat-demo/scripts/{combat-hud,telegraph-pool,fx-pool,fx-emitter,fx-lab}.ts`
  and `projects/voxel-demo/scripts/motion-dust.ts`: `static clientOnly = true`.
- `combat-hud.ts` / `telegraph-pool.ts`: resolve "me" via `ctx.localPlayer()`;
  `dummy-brain.ts`: fights the NEAREST living player, not the first tagged.
- `projects/mmo/` (new, committed in its own repo).

**Also verified (later the same night):** a peer sees the other player's
body RUNNING (server-published gait clip → client animator); another
player's cleave telegraph and meteor impact draw on the peer; hero NPCs
engage a joined player (frostNova/cleave requests in `/admin/events`); NPCs
stand on streamed ground from tick 0 (`/admin/npcs` heights ≈ terrain).
Found and fixed by the trace: NPCs used to fall through a world that only
streamed around players — terrain foci are now every dynamic body.

**Headless-testing trap:** two tabs in ONE headless Chrome context — the
background tab gets discarded/reloaded under GPU pressure and its keys go
nowhere; it looks exactly like "casts don't reach the server". One browser
per player (see the scratch scripts' `remote-visuals-2.mjs` pattern).

**Load (iteration 2, `bin/bots.ts` — N fake players over real sockets,
wandering at run speed, casting every ~3 s, against the `mmo` scene):**

| players | tick p50 | tick p95 | max (spikes) | resident cells |
| --- | --- | --- | --- | --- |
| 20 | 2.6 ms | 4.5 ms | ~70 ms | 24 → 67 |
| 50 | 4.8 ms | 11.6 ms | ~70 ms | 45 → 75 |

Budget is 16.7 ms at 60 Hz, so ~50 players per process is the comfortable
ceiling today. The spikes WERE synchronous voxel cell generation + trimesh
cooking on the tick; iteration 4 moved generation to worker threads
(`VoxelPool`, default min(4, cpus-1), `--workers 0` for inline): a cell
now costs the tick ~4 ms (expand + attach against a pre-marched mesh) and
the same 50-bot run peaks at 15-22 ms instead of ~70. Next levers: a 30 Hz
sim tick, then binary snapshots. `GET /admin/status` reports `tickMs` live.
Run it: `pnpm -F @hitreg/server exec tsx bin/bots.ts --url ws://127.0.0.1:8787 --count 20 --seconds 60`.

**Reconnect grace (iteration 2):** a dropped socket (or a `bye`) holds the
body for `--grace` seconds (default 30), standing still, still replicated;
the same peer id re-dialing inside the window gets its body back where it
stood (the client's peer id is stable per tab, so a flaky link is not a
death). The `world` module carries `{ t: "presence", peerId, linked }` so
clients can show "away"; the playground ignores it for now.

**Not verified yet:**
1. Client-side prediction feel over real latency (only 0 ms tested).

**Known gaps / decisions for Derek:**
- The playground connects on PLAY and says bye on stop (`wantsSession` in
  NetPresence), so an editor tab holds nothing on the server; the body then
  lives out the grace window. Verified in-browser (iteration 2).
- Cell loads are budgeted (`loadBudgetMs`, default 6 ms per update) and
  generated on worker threads; spawn-time `ensureAround` loads stay inline
  so ground exists before a body does. `primeVoxelMesh` (new in core) is
  how a worker's marched mesh reaches the cache the physics cook reads.
- The server has no GLB loader: asset-mesh (trimesh/convex) colliders fall
  back to boxes. Voxel terrain + scatter primitives are exact.
- Admin HTTP has no auth — bind to localhost or front it.
- Voxel terrain colliders land on the WORLD layer, not TERRAIN (physics
  `defaultMembership` only tags heightmaps) — on the server AND in the
  browser. Combat's "TERRAIN first, WORLD fallback" ground probe therefore
  always falls back, which is why a tree trunk can anchor a telegraph. The
  fix is one line in `packages/physics/src/sim.ts` where a voxel source is
  cooked; left alone because it changes both sides at once.
- One scene per process; Cloudflare Durable Objects (the hosting Derek
  mentioned) would wrap `GameServer` per zone — `serve()` is the shape.
- The P2P dev path is untouched and still the default without `?server=`.
- CLAUDE.md pointer to this doc is left as an uncommitted edit (the file
  carries Derek's own uncommitted changes).
