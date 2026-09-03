# @hitreg/server

The dedicated game server: the same play session the playground runs —
expanded scene, physics, scripts, event bus, replicated session state — in a
headless Node process, with browser tabs as `RoomClient`s over a WebSocket.

```
pnpm -F @hitreg/server serve --scene mmo            # ws://127.0.0.1:8787 (+ admin HTTP on the same port)
http://localhost:5173/?server=ws://127.0.0.1:8787   # a playground tab becomes its client; press ` to play
curl -s http://127.0.0.1:8787/admin/status
pnpm -F @hitreg/server exec tsx bin/bots.ts --count 20 --seconds 60   # load
```

| module | job |
| --- | --- |
| `assets.ts` | read every project's `assets/` off disk into one `AssetLibrary` (same id namespace as the dev server) |
| `scripts.ts` | import `projects/*/scripts/*.ts` and register them; `static clientOnly = true` opts a script out |
| `world.ts` | `HeadlessWorld` — plain `three` `Object3D` graph + `PhysicsSim` + `ScriptRuntime` + `EventBus` + `NetStateStore` |
| `terrain.ts` | voxel colliders around every dynamic body; `applyEdits` re-cooks touched cells (terraform) |
| `players.ts` | clone the scene's `player` subtree per joiner; `PlayerDriver` moves bodies from movement intent |
| `server.ts` | `GameServer` — `RoomHost`, snapshots, the `world` module (entity docs, presence, recipe), reconnect grace, terraform |
| `npcs.ts` | adopt the authored roster, spawn/despawn templates at runtime, respawn the dead |
| `admin.ts` | HTTP: status, npcs, templates, netstate, events, spawn, despawn, terraform |
| `serve.ts` / `bin/serve.ts` | boot it all on one port; the CLI |

Design, verification record and the RESUME hand-off: **docs/dedicated-server.md**.
