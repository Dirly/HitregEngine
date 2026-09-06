# Hosting — main, layers, instances

**Status (2026-09-05): built and verified end to end** — unit + socket tests
in `packages/server/test/{ticket,cluster,spawn-areas,instances}.test.ts`, and
a headless-Chrome run of the playground in gateway mode: sign-up → character
→ Play → body on `layer-1` → a second layer scaled up → an admin transfer
that hopped the tab to `layer-2` mid-play, save on disk afterwards. Not yet
exercised: a real Postgres (the backend is written and typed, the compose
file runs one), TLS in front, and the `mmo` scene under load across layers.

This is the topology decided on 2026-09-05 for the open world: a
**Diablo-style pool of copies** rather than spatial shards, **scoped by
zone** so that a copy's players are near each other (→ "Zones" below).
Nobody sees everyone; everybody sees the same world.

**Zones (added later the same day, verified in `test/zones.test.ts`):** a
layer hosts a SET of the recipe's regions. At low population one process
hosts all of them; when a zone's players on a copy reach its cap, main opens
a dedicated copy of that zone; a player who walks into a zone their layer
does not host is handed to a copy that does, out of combat and clear of
packs on both sides. Derek's objection to whole-world copies — "why would
someone on one end of the continent be on the same layer as someone in the
south" — is what this answers: a zone with 40 players online has all 40 on
one copy.

```
                       browser (playground, ?gateway=…)
                          │ https          │ wss (ticket)
                          ▼                ▼
   ┌──────────── MAIN ────────────┐   ┌── LAYER ──┐ ┌── LAYER ──┐ ┌─ INSTANCE ─┐
   │ login · characters · /play   │◄──┤ whole     │ │ whole     │ │ one dungeon│
   │ placement · parties          │ws │ world,    │ │ world,    │ │ for one    │
   │ player-data (the only DB     │   │ ≤cap      │ │ ≤cap      │ │ party,     │
   │   client) · recipe writer    │   │ players   │ │ players   │ │ exits when │
   │ supervisor (child processes) │   └───────────┘ └───────────┘ │ empty      │
   │ admin HTTP                   │        ▲              ▲       └────────────┘
   └──────────────────────────────┘        └── same binary: bin/serve.ts ──┘
```

| role | process | holds | never does |
| --- | --- | --- | --- |
| **main** | `bin/main.ts` — `pnpm -F @hitreg/server main` | accounts, player data, the recipe file, the layer registry, parties, tickets | simulate anything; sit on the hot path |
| **layer** | `bin/serve.ts` with `--main` | a `GameServer` for the whole world, session state only | write durable data itself (every save is an RPC to main) |
| **instance** | `bin/serve.ts --kind instance` | one scene for one party/key; exits after `--idle-exit` empty | outlive its players |

Why this shape and not borders/ghost bands: a layer is exactly the process
that already existed (`docs/dedicated-server.md`), the world is a pure
function of its recipe so every copy is identical, and a **transfer** —
say bye here, dial there with a ticket — is one primitive that serves
dungeons, party pulls, rebalancing, and zero-downtime content rollout.

## The flow

1. **Sign in** at main (`/auth/register`, `/auth/login` → a session token;
   scrypt passwords, no email). Make characters (`/characters`).
2. **Play**: `POST /play {characterId}` → main *places* the character and
   answers `{ url, ticket, server }`. Placement (`main/registry.ts`):
   a party member's layer if it has room → the layer this character was
   on most recently (affinity, 30 min) → the **fullest** layer with room →
   otherwise start another layer (up to `--max`) and wait for it.
3. **Join**: the client dials the layer with the ticket in the WebSocket
   handshake. The layer verifies it (HMAC, expiry, *bound to this server
   id*) and **the peer id becomes the character id** — whatever the tab
   proposed. No ticket, wrong layer, expired: refused at the door.
4. **Save-before-spawn**: the layer loads the character's save through
   main (`character` = the sheet, `world` = position per scene), seeds
   `character/<bodyId>` into netState *before* the body's scripts start
   (so the `character-sheet` builtin finds a sheet and keeps it), and
   spawns the body where it logged out.
5. **Commits**: every 30 s (staggered), on leave, and before a transfer.
   Compare-and-swap on revision. A save that cannot land because main is
   down is queued on the layer and retried until it does (`pendingSaves` in
   `/admin/status`).
6. **Transfer** (`GameServer.handoff`): the source commits, mints a ticket
   for the destination *bound to the committed revisions*, and sends the
   client `{ t: "transfer", url, ticket }` on the `world` module. The
   client says bye (the body is torn down at once — no grace, no second
   save) and dials the destination, which refuses to spawn from a save
   older than the ticket promised. Two servers never both own a sheet.
   The rendered world stays; only the server's entities swap.
7. **Instances**: a script/admin asks main (`transfer.request { kind:
   "instance", scene, party: true }`), main's supervisor starts
   `serve.ts --kind instance --instance-of <party>`, waits for it to
   register, and pushes `transfer.begin` to every member's layer. The
   instance exits when empty for `--instance-idle` seconds.

## Zones

With `regions` in the recipe (docs/world-editing/zones.md), main runs
zone-scoped placement; without them everything below is inert and layers
are whole-world.

**Hosted sets.** Every layer carries a hosted set: `"all"` or a list of zone
ids. The first layer is always `"all"` (somebody has to take the quiet
zones); a layer main starts because a zone's copies are full hosts exactly
that zone. Main tells a layer its set on registration and whenever it
changes (`zones` message; `POST /admin/zones { id, hosted }` by hand). A
layer simulates the world wherever its players stand regardless — spawn
areas wake around anyone — the set only says which zones main places
players there for, and which zones a player may stand in without being
moved.

**Placement** (`ServerRegistry.placeInZone`): the zone is the character's
saved position's zone, else the spawn point's. Candidates are layers that
host that zone with room in the process AND fewer than the zone's `cap`
(the region's own, else `--zone-cap`, else the process cap) standing in
it; party first, affinity second, then the copy with the most people in
that zone. None → start a dedicated copy of the zone (up to `--max`).
Main counts zone populations from the positions in every layer's status
report, plus reservations, so a burst of logins cannot overfill a copy.

**Crossing a border.** Twice a second each layer looks at every player's
zone (`regionAt`). A player standing in a zone the layer does not host,
more than `--zone-band` metres (default 20) inside it, is a crossing:

1. the layer checks its own gate — not dead, no combat lock, no awake
   pack in view here — and otherwise leaves them be: **someone in combat
   stays on the server they are on, wherever they run**, until the lock
   lapses (12 s after the last hit taken or dealt);
2. it asks main for a copy of that zone that is not itself; main asks that
   copy whether the spot is quiet there (`arrival.check` → no awake pack in
   aggro range) and answers "go" or "wait" — the layer asks again every
   two seconds, and after fifteen waits asks with `force`;
3. commit, mint a ticket bound to the revision, hand the client over. The
   body spawns on the far side exactly where it stood; the terrain never
   changes for the client, only the server's entities do.

**Landing grace.** A body that just spawned — login or transfer — carries
`landing/<bodyId>` (sim time, 5 s, `--landing`… `landingSeconds`). NPC
brains must neither target nor aggro a landing body (`isLanding` in
`@hitreg/core`; voxel-demo's `dummy-brain` honours it), and an
authoritative combat script clears it on the first hit the body deals
(`clearLanding`; voxel-demo's `combat-actor` does). This is the backstop for
the one case the arrival check cannot wait out: a camp on the far copy that
stays awake because players are fighting in it.

**Bands.** Nothing should be spawned within a band of any border, on either
side, so a normal crossing shows nothing. At boot a layer warns for every
spawn area whose reach (spread + leash + roam + band) crosses its zone's
border, and `/admin/spawn-areas` lists them; the fix is to move the area or
the border. The playbook's rule that a border must sit where nobody can see
across it (a ridge, a river, the coast) is what makes the swap invisible
for OTHER players.

`GET /admin/status` on main reports `zones` (population and cap per zone)
and each server's `hosted` set and per-zone counts.

## Layers cost what their players cost

A whole-world layer is only affordable because the population is
**proximity-activated**: give a place a `spawnArea` component (in the spec)
and its packs spawn the first time a player comes within `radius`, then
**pause in place** when nobody has been inside `sleepRadius` for
`idleSeconds` — scripts suspended, bodies out of the physics world, the
ground under them free to unload — and resume where they stood when
someone returns. Each NPC's root script receives `home`, `leash`, `roam`
and `spawnArea` params; the manager fences at 1.5× the leash as a backstop.

Two consequences worth knowing:

- **Nobody is moved between layers within sight of an awake pack.** That
  is the default transfer gate (`SpawnAreaManager.clearToTransfer`), so a
  swap never shows enemies blinking. A main-initiated move waits up to
  60 s for a clear moment, then reports `transfer.failed`.
- **Nobody is moved mid-fight.** `GameServer.canTransfer` also refuses while
  netState `transferLock/<bodyId>` (a sim-time deadline, `@hitreg/core`
  `transferLockKey`) is in the future. The engine cannot see combat from
  outside a game's scripts, so the game's authoritative combat script writes
  it on every hit taken OR dealt (voxel-demo's `combat-actor` does, param
  `transferLockSeconds`, default 12 s). A chased player cannot escape into a
  dungeon, and the attacker cannot pull their party out of a fight they are
  losing; the lock extends while the fight continues and lapses on its own.

## Chat

Text chat routes on the host, and on a layer the host is the layer: each one
runs a `ChatService` (`packages/server/src/chat.ts`) with the world supplying
positions and zones. **Zone** and **global** lines cross the cluster — the
origin delivers locally, publishes the line up its cluster link, main fans it
to every other layer, each delivers it to its own players standing in that
zone (or everyone, for global). This is the answer to a vast world with 40
players per copy: whoever is in your region talks to you, on every layer.
Proximity, team and party stay per layer. Details: docs/comms.md.
- **Keep spawn areas at least aggro + leash away from any place you
  intend to swap people** (a bridge, a pass, a gate). A padding band with
  no spawn table in it is the whole trick; there is no audit for it yet.

Authored NPCs (`npc`-tagged subtrees in the scene) still exist from tick 0
as before; convert big populations to spawn areas.

## Running it

**Dev, one box, no Docker:**

```
pnpm -F @hitreg/server main --scene mmo --secret dev --public-host 127.0.0.1
pnpm -F playground dev
# open http://localhost:5173/?gateway=http://127.0.0.1:8780 → sign in → Play
curl -s -H "Authorization: Bearer dev" http://127.0.0.1:8780/admin/status
```

Main starts `--min` layers (default 1) as child processes on `--ports`
(8801-8899), adds one whenever free slots across the pool drop below
`--headroom`, and retires a layer that has been empty for `--retire`
seconds (never below `--min`). Persistence is files under
`<playground>/.hitreg/data` unless `--database <postgres url>` is given.

**Small community (one VPS, Docker):** `deploy/` — Caddy for TLS and the
built client, main with its layers, Postgres. `deploy/README.md` has the
five commands. A home box is the same with `deploy/hitreg-main.service`
under systemd and a cheap VPS in front (WireGuard or a Cloudflare tunnel)
so the home IP stays private.

**Open dev server, no gateway** (`serve --scene x` without `--secret`)
still works exactly as before: `?server=ws://…`, anyone joins, nothing
persists. `--secret` alone (no `--main`) is *standalone*: tickets required,
saves through `--playerData`-style backends — only tests use that.

## Admin surface (main, bearer = admin token or the secret)

| call | does |
| --- | --- |
| `GET /admin/status` | every server with players/cap/tick, booting children, parties, where each character is |
| `POST /admin/transfer { characterId, srv }` | move one character to a layer (`scene` instead of `srv` → an instance; `party: true` → the whole party) |
| `POST /admin/instance { scene, characterIds, key? }` | start (or reuse) an instance and move those characters in |
| `POST /admin/scale { layers }` | start layers up to that count |
| `POST /admin/drain { id }` | a layer stops accepting, moves everyone out, exits when empty |
| `POST /admin/terraform { edits }` | forwarded to the primary layer; main saves the recipe and fans it to the rest |
| `POST /admin/recipe { id, recipe }` | replace a whole recipe everywhere (the agent's weekly edit) |

Each layer keeps its own `/admin/*` (players, NPCs, spawn areas, netState,
events) on its port — plus `POST /admin/transfer` that asks main for a
destination and moves the character.

## The agent's weekly edit and running servers

- **Small live edits** are terraform: `POST /admin/terraform` on main.
  The primary layer applies the ops batch, main writes the recipe file
  (main is the writer of record — layers run with recipe persistence off)
  and pushes the recipe to every other layer, which re-cooks its resident
  cells; clients re-stream. Nothing restarts.
- **A content version** (new scripts, new scenes, new items) is a commit of
  the project repo and a rolling handoff: start layers on the new version,
  `POST /admin/drain` the old ones one at a time (they move their players
  to the layers with room, which are the new ones once the old ones stop
  accepting), and the old processes exit when empty. Running instances
  finish on the old version; new ones start on the new. Rollback is the
  same sequence backwards. Bots (`bin/bots.ts`) against a staging main are
  the pre-flight.

## Trust boundary, restated

Clients present tickets and send intent; layers validate against netState
ownership and are the save authority; main is the only process with a
database connection and the only signer of tickets. A P2P host never
touches any of this. The MMO project declares `multiplayer: "server"` in
its project.json (ARCHITECTURE §3a amendment, 2026-09-05), so for its
scenes this cluster is the only multiplayer path — a peer host could fudge
everything it simulates — and the playground forms no peer room for them
(`?p2p=1` overrides for a two-tab engine experiment). Other games on the
engine may still choose peer rooms.

## What is deliberately not here yet

- Cross-layer PARTY chat (zone and global already cross layers — see
  "Chat" above; party membership lives in main, so party lines need main to
  tell each layer who is in which party).
- A spawn-area/zone-edge audit in `worldgen audit`.
- Pre-spawning the body on the destination before the client dials it
  (today a transfer is one round trip of nothing; with prediction it is
  invisible on a LAN and a short hitch on a bad link). The destination is
  asked whether the spot is quiet, but the body is not built there early.
- Merging two sparse copies of a zone back into one (a copy retires only
  when empty; players are not moved to consolidate).
- Splitting a hosted set: a dedicated copy hosts one zone; an `"all"` host
  is never narrowed. Fine at hobby scale, revisit when one process should
  host a handful of neighbouring zones.
- Owner-authoritative anything; binary snapshots; a 30 Hz sim tick — the
  per-layer capacity levers from `docs/dedicated-server.md` still apply.
