# Mob AI

Enemies that stand somewhere, notice you, come after you, and give up.

Three pieces:

- **`mob-brain`** (`@hitreg/scripting`, `src/mob-brain.ts`) — the builtin
  behavior. A six-state machine: `idle → roam → chase → attack → leash → dead`.
- **`TerrainSteering`** (`@hitreg/scripting`, `src/steering.ts`) — how it gets
  anywhere. No navmesh, no bake, no graph: every decision is probed out of the
  live physics world.
- **`ThreatTable`** (`@hitreg/core`, `src/threat.ts`) — who it is angriest at.
  Pure and headless, so a server or an admin readout can use it too.

The schemas are the reference (`GET /__hitreg/spec` → `scripts["mob-brain"]`
for every param, `events` for `mob.attack` / `mob.state` / `mob.threat` /
`mob.alert`). This file is the judgment: how to wire one, and the traps.

## Wiring a mob

**A mob is two entities**, because an entity carries exactly one `script` and
because the sim owns a rigidbody's rotation:

```
boar            rigidbody + collider + script: third-person-controller   tags: ["npc"]
  boar-visual   mesh + animator
  boar-brain    script: mob-brain  { actor: "boar", ... }
```

The brain never writes velocity — it drives the controller's `impulseVel`
channel, and claims the facing through `faceYaw` while it stands still to
swing. Both are deadline channels (`impulseUntil`, `faceUntil`): a brain that
dies mid-swing releases the body instead of freezing it.

**Populations come from `spawnArea`**, not from placing mobs in a scene. The
area holds the pack templates; `SpawnAreaManager` wakes it when a player
arrives, pauses it in place when they leave, and hands every scripted entity in
the spawned subtree `home`, `leash`, `roam` and `spawnArea` as params — which
is exactly the brain's tuning. A layer therefore costs what its players cost.

**And you don't place those by hand.** `pnpm -F playground worldgen spawn
<world> --scene <name>` sites camps across the wilderness from the current
terrain, writes them into the recipe as `features.camps`, and patches the
`spawnArea` entities into the scene — including a placeholder capsule mob with
a `mob-brain`, so a freshly generated world has monsters in it before any art
exists. It is idempotent (rewrites its own `camp-*`, keeps hand-written ones),
so re-run it after moving a river or redrawing a zone. See "Placing camps".

**Damage is yours.** The brain decides where a body goes and when it wants to
swing; it never decides what a swing does. It emits `mob.attack`
(`{ mobId, targetId, abilityId, aim, distance }`) and your combat layer bridges
it:

```ts
ctx.events?.on("mob.attack", (p) => {
  const { mobId, abilityId, aim } = p as MobAttack;
  ctx.events?.emit("combat.cast.request", { casterId: mobId, abilityId, aim });
});
```

`mob.state` fires on every transition and carries the target — the hook an "!"
over an alerted enemy hangs off. Every `mob.*` event is authority-internal:
brains run only on the session authority, and one arriving from the wire would
be a second brain arguing with the first.

## Threat: feeding it is the game's job

The engine cannot know what a hit is worth, so nothing generates threat on its
own. Your combat layer reports it and the brain decides what it means:

```ts
// when a hit lands
ctx.events?.emit("mob.threat", { mobId, sourceId: attackerId, amount: damage });
// a heal near a fight is conventionally worth about half
ctx.events?.emit("mob.threat", { mobId, sourceId: healerId, amount: healed * 0.5 });
// a taunt: top of the table AND forced target for a few seconds
ctx.events?.emit("mob.threat", { mobId, sourceId: tankId, kind: "taunt", seconds: 4 });
```

Once anyone has earned threat, it decides the target — that is what makes a
tank a role rather than a costume. `threatHalfLife` is the feel knob: short and
the mob turns on whoever hit it last; long and the first person to commit holds
it all fight. Threat is wiped on leash and on death, which is what makes
running away a real escape rather than a pause.

**A threat target is not checked for line of sight.** Acquisition needs sight;
a grudge does not, or every mob would drop you the moment you stepped behind a
tree.

## Factions and packs

A mob publishes `faction` to `combat/<id>.faction` and the rule is the simple
one: **a different published faction is an enemy, the same one never is.**
Goblins and dwarves are at war without anyone writing a matrix, and neither
side has to be tagged. `hostileTo` narrows it when a world has three sides.
Anything publishing no faction falls back to `targetTags`, so a plain scene
with no combat layer still works.

Pulling is loud: a mob emits `mob.alert` once per target, from where the fight
started, and same-faction mobs within `alertRadius` take the same target. An
assist arrives as a **seed of threat**, not as a forced target — so whoever
actually hits the mob still takes it off the friend who shouted, which is what
stops a whole camp tunnelling one player while a second carves through them.

## Placing camps

`worldgen spawn` decides where monsters live. Every rule it follows is there to
keep some other part of the system true, not for taste:

- **Clear of every zone border by the camp's whole reach** (spread + leash +
  roam + band). This is the same measurement `SpawnAreaManager.borderWarnings`
  audits, so a generated world passes it by construction — see trap 3.
- **Never inside a town pad or a sanctuary.** Those are the places the game
  promises are safe.
- **Beside the paths, never on them.** A camp on a footpath is a wall across
  the only route between two towns; one eighty metres off it is an encounter.
  Paths repel close up and attract at range.
- **On ground a pack can stand and walk on** — above water, off the bog, under
  the slope the brain would refuse to climb anyway.
- **One per zone before density fills the rest in**, because a zone with no
  monsters is a zone with nothing to do. Nested town zones are skipped: they
  are the safe cut-outs.

Knobs worth knowing: `--per-km2` (default 0.8) or `--count`, `--pack-min/max`,
`--radius` (wake distance), `--leash`, `--band`, `--town-clearance`,
`--template <id>` to point at your own NPC subtree instead of the placeholder.

Checking the result without opening the browser: `/admin/spawn-areas` lists
every area and whether it is awake; `/admin/npcs` now carries an `ai` block per
NPC — state, target and the whole threat table, straight off `Script.onDebug`.
That is how you answer "why is it chasing HIM" on a live layer.

## Debugging a live mob

Any script can implement `onDebug()` and it shows up wherever the engine
surfaces it — for a mob that is:

```json
{ "script": "mob-brain", "state": "chase", "target": "player:ann",
  "faction": "monster", "home": [168, 24.3, 1992], "leash": 30,
  "threat": [{ "id": "player:ann", "threat": 412 }], "taunted": "" }
```

Nothing calls it on a schedule, so it costs nothing until someone looks — which
is why the alternative (replicating diagnostics through netState) was not worth
it. A paused pack reports nothing at all rather than something stale, because
its script instances genuinely do not exist while it sleeps.

## The traps

**1. Terrain and furniture are judged by different probes.** Slope is a HEIGHT
question (sample the ground ahead, subtract, compare the grade); walls are a
RAY question. The horizontal obstacle ray deliberately excludes `TERRAIN`,
because at chest height it hits a perfectly walkable hillside about two metres
ahead — put terrain back in that mask and every hill on the map reads as a
wall, with the pack milling around at the bottom of it.

**2. `groundHeightAt` returns `null`, and `null` is not zero.** An unstreamed
chunk, the void past the world edge, a body that fell through the floor — all
normal. Default it to a constant and your mobs walk, correctly, fourteen metres
underground, silently. The steerer treats "I do not know where the floor is" as
"disable the height tests", not as "y = 0".

**3. The leash is a zone contract, not a difficulty knob.** `SpawnAreaManager`
fences anything 1.5× past its leash straight home with a warning — that is a
BACKSTOP for a broken brain, not the mechanism. A pack dragged over a zone
border stands in the transfer band, and `clearToTransfer` then refuses to move
players between layers there. Keep `leash` inside the zone, and check
`/admin/spawn-areas` plus `borderWarnings` for areas whose reach crosses a
border (docs/hosting.md).

**4. The controller's `walkSpeed` is a THRESHOLD, not a speed — and a
non-human needs its own.** For an AI body the brain drives movement through
`impulseVel`, so `walkSpeed` never sets how fast anything walks; what it still
does is decide what COUNTS as walking, because the idle boundary is
`max(0.15, walkSpeed * 0.35)`. Leave a human's 1.4 on a wolf and the boundary
lands at 0.49 m/s, right where a quadruped's `roamSpeed` nets out once terrain
has taken its cut — so the mob roams with its idle clip playing, feet still,
sliding along. Set `walkSpeed` and `speed` to the speeds the clips are
ACTUALLY authored at (`autorig`/`retarget` measure and print them, and they go
in `clipSpeeds` too) and the tiers line up on their own: the wolf's 0.55 m/s
walk puts the idle boundary at 0.19, where any real movement is a walk.

**5. Line of sight ends at the target's centre, which is inside the target.**
`requireLineOfSight` is on by default and the sight ray must exclude the body
it is looking AT — a character is a dynamic rigidbody, and a dynamic collider
defaults to the `PROP` layer, one of the three that sight is traced against.
Fixed in `canSee`, with a test, but the shape of the bug is worth remembering:
it presents as a mob that roams calmly past a player standing next to it, at
every range, and looks exactly like a targeting or faction problem.

## What it does not do

Steering is **local**. It slides around a boulder, up a hill and away from a
cliff; it cannot plan around a mountain range. That is the right trade for
leashed mobs, and a global path (a coarse nav grid derived from the voxel field
per chunk) belongs on top of this, not instead of it.

Threat is a flat number per source — no per-ability modifiers, no threat
transfer, no split tables for a multi-target pull. Packs share a target and
nothing else: no formations, no ranged mobs holding a line while melee closes,
no leader. Factions are a two-sided test plus an allowlist, not a reputation
system. And it all honours the landing grace (`landing.ts`) — a body that just
logged in or arrived from another layer is left alone.

## Cost

At the default `steerHz: 8`, a mob walking in the open costs **three raycasts
per steering tick** (ground here, ground ahead, obstacle ahead) plus one sight
ray when it has a candidate target. The fan — up to fifteen — is only paid when
the way ahead is actually blocked. `steerHz` is the lever when a layer has too
many mobs: it makes them think less often, not move choppily, because the drive
channel is written every tick regardless.

Background on why raycast budgets matter here: `docs/performance-lessons.md`.
