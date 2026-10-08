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

The other direction is three more small bridges, each optional:

| Brain says / hears | Means | A game typically |
|---|---|---|
| `mob.engaged { engaged }` | it has a target or any threat left (fired on change; the first think always says which) | publishes an "aware" flag, so an opener on an unaware mob can exist |
| `mob.guard { on }` | `guardBetween` mob wants its guard up / down (on change) | forwards to its own guard request |
| `mob.interrupt { seconds }` (heard) | the game broke the wind-up (a parry, a stagger) | emits it on every stagger of a mob body |

## Movesets

With no `moves`, a mob swings one of its `abilities` at its threat target every
`attackInterval` — fine for a training dummy, flat in a party fight. A
**moveset** is a short list of moves, each WHEN and AT WHOM, never WHAT:

```json
"moves": [
  { "ability": "mobClaw",  "target": "threat",   "range": [0, 2.6], "cooldown": 0,  "weight": 3,   "windup": 0.45 },
  { "ability": "mobSlam",  "target": "threat",   "range": [0, 2.9], "cooldown": 6,  "weight": 2,   "windup": 1.05 },
  { "ability": "mobLash",  "target": "behind",   "range": [0, 2.6], "cooldown": 6,  "weight": 2.5, "windup": 0.5, "turnRate": 300 },
  { "ability": "mobLeap",  "target": "furthest", "range": [5, 14],  "cooldown": 10, "weight": 2,   "windup": 1.3, "lunge": true }
]
```

The schema is `MobBrain.moveSchema` (a bad moveset is warned about and dropped,
and the mob falls back to `abilities`). Every `attackInterval` — counted from
the END of the last wind-up — the brain takes every move that is off its own
cooldown and whose **target rule** finds someone inside its `range` band, and
draws one by `weight`:

- `threat` — the current target (the tank, when the tank is doing its job);
- `nearest` / `furthest` — over every valid enemy within `deaggroRange`;
- `behind` — the nearest enemy in the mob's rear half (a turn-and-lash).

The last three are the point: a mob that only ever hits the tank lets the rest
of the party ignore it. Moves are tried while chasing too, so a leap or a shot
opens a fight from range. A non-threat pick costs one sight ray, for the winner.

A move **commits** the body for its `windup`: no walking, no new move, and it
turns toward its target only at `windupTurnRate` (or the move's `turnRate`).
`windup` must equal the ability's own wind-up — the brain cannot know it, and a
mismatch is a mob that walks off while its swing lands. A `lunge` springs at
the point the target stood on (`mob.attack.at`) through the last part of the
wind-up so the body lands as the ability resolves. `mob.interrupt` drops the
wind-up and holds the body still for its `seconds`.

## Facing and noticing

The brain owns the facing once it has claimed it, and turns it at a FINITE rate
every tick (`turnRate`, slower `windupTurnRate` mid-move) before handing it to
the controller's `faceYaw` channel. That is what makes stepping round a heavy
swing, or a tank holding a mob's facing, possible.

Acquisition has a **sight cone** (`sightAngle`, half-angle) plus a short
**`hearRadius`** that notices all round, so a mob can be walked up on from
behind. Only acquisition: a target already held, a grudge and a packmate's
shout are all-round. The default `sightAngle: 180` is the old omniscient
behaviour; creatures set ~70. Stealth plugs into ONE place, `noticeScale` in
`mob-brain.ts` (marked `HOOK(stealth)`), which scales aggro and hearing for the
approaching body and returns 1 today.

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

## Death: ragdoll or clip

The server decides the death (`combat/<id>.dead`, loot, XP); how the body
falls is each client's own business. A mob prefab that carries a child entity
with the `ragdoll` builtin falls as a cosmetic ragdoll; one without it plays
its death clip. The flow, per tab:

1. The death is seen: `userData.ragdollKick` (combat-actor's `die()` stamps it
   with the blow's direction on the tab that resolved the hit), or `frozen` +
   `actionClip === deathClip`, or the replicated `deadKey`
   (`combat/{actor}.dead`) on a tab that only watches the body. A body already
   dead the first time a tab sees it (a late join) keeps its clip.
2. Skips, each leaving the clip: further than `maxDistance` (30 m) from the
   local camera; `maxActive` (8) ragdolls already falling on this tab; no
   WORLD/TERRAIN collider under the feet (terrain only collides inside the
   simulation ring, and a body that falls where nothing was built falls forever).
3. `leadIn` (0.35 s) of the clip, then at most `spawnsPerFrame` (4) builds per
   tick: capsules from the pose at that instant, the clip's motion plus the
   blow. The rig preset comes from the skeleton (`rig: auto`): **upright**
   (bipeds: the spine bends but hardly twists) or **horizontal** (four legs: the
   short spine bones merge into a stiff back that hardly rolls, a tip of 1.2 rad/s
   onto a flank, and a roll guard that turns it back if it goes over onto its back).
4. The bodies drive the bones until they lie still (every body slow for 0.5 s,
   or nothing moving more than ~1.5% of the creature's size in 0.5 s), else at
   `maxSeconds` (5); damping grows the longer it lies, so a body does not roll
   down a slope forever. Then the bodies go and the bones stay: a corpse costs
   nothing. A body that drops through the ground (well below where it died, with
   ground above it) gets its clip back.
5. Respawn clears the death signal: the bones and the mixer come back.

Which families fall (2026-10-07): ON for zombies, ghouls, ffh-butler and the
other opaque human-rig mobs, rats, wolves and every Dog-donor mammal (bear,
bison, rhino, lion/lioness, horse, elk, mule deer, bighorn, goat/nanny, sheep,
pig, wild dog, hyena) and their skeletal (`-undead`) variants. OFF (clip) for
spirits (`ghost-*`, the translucent ffh spirits, `-ghost` spectral variants:
they fade, they do not slump) and the legrig creatures with deaths of their
own: cobra, dragon/drake, T-Rex, fish and sharks, fliers, insects, spiders,
scorpion, alligator/sailback, salamander. The opt-in lives in the generators
(MMO `make-prefabs.mjs` `RAGDOLL`, `rig-ratwolf.sh prefabs`,
`authoring/mob-intake/zombie-prefabs.mjs`, `spectral-variants.mjs` drops it on
ghosts); ghoul, ffh and `-undead` prefabs carry it directly. Its `actor` param
is bound to the prefab's `actor` prop like combat-actor's.

Checking a fall: voxel-demo `tools/ragdoll-bench.mts` (Node, real GLBs + real
Rapier, flat or `--slope`: rest time, which way up, spine twist, limbs inside
the trunk, floating/sinking), `tools/ragdoll-strip.mjs` (browser frame strips,
`--slope` on the voxel-demo world) and `tools/ragdoll-measure.mjs` (cost).
Cost at the cap of 8: ~0.4 ms physics + ~0.35 ms script per frame while they
fall; 0 once frozen.

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

A move's wind-up is a number the author repeats from the ability; the brain does
not read the game's ability table (it must not), so a game should test the two
against each other. A lunge is a straight spring through the drive channel —
no terrain probe, no cliff check — so keep lunge bands short.

Threat is a flat number per source — no per-ability modifiers, no threat
transfer, no split tables for a multi-target pull. Packs share a target and
nothing else: no formations, no ranged mobs holding a line while melee closes,
no leader. Factions are a two-sided test plus an allowlist, not a reputation
system. And it all honours the landing grace (`landing.ts`) — a body that just
logged in or arrived from another layer is left alone.

## Cost

At the default `steerHz: 8`, a mob walking in the open costs **three raycasts
per steering tick** (ground here, ground ahead, obstacle ahead) plus one sight
ray when it has a candidate target (and one more when a move goes for someone
other than its target). The fan — up to fifteen — is only paid when
the way ahead is actually blocked. `steerHz` is the lever when a layer has too
many mobs: it makes them think less often, not move choppily, because the drive
channel is written every tick regardless.

Background on why raycast budgets matter here: `docs/performance-lessons.md`.

## Patrols

A `spawnArea` may carry `patrol`: points relative to the area, walked in order and back while the pack is idle. Each
NPC gets them as the mob-brain `patrol` param in world coordinates; the leash, the way home and the server's fence are
then measured from the nearest point of the route, so a long route needs no long leash.

## Boss mechanics

Boss mechanics are engine builtins in `@hitreg/scripting`, one file each, configured by parameters only. A dungeon
holds the DATA that uses them (which boss, which thresholds, which spawn markers, which template), never code. The set:

| Builtin | File | What it does |
|---|---|---|
| `encounter-waves` | `packages/scripting/src/encounter-waves.ts` | Adds join the fight at the boss's health thresholds: waves `{ atHp, count, mouths }` from named mouths, at most `maxAlive` alive, corpses removed after `corpseSeconds` (adds never respawn), re-armed when the boss dies or heals home. Reads `combat/<boss>.hp`/`.maxHp`/`.dead`; asks the server for bodies with the `npc.spawn` / `npc.despawn` events, which `NpcManager` answers. |

Add the next mechanic (an enrage timer, a shield phase, a summoned totem) as its own builtin beside it, with its own
tests, and list it here.
