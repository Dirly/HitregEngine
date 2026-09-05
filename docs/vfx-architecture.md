# VFX architecture — a system for effects nobody authors

Status: **Phases 1–4 shipped** (2026-09-03). What remains is tuning presets
and growing the library, not building the system.

This document is about building effects *tooling*, not about building effects.
The distinction matters because of one requirement that makes this engine's
situation different from every other engine's: **spells are generated.** Nobody
will hand-author the effect for a sword that rolled "arcing frost cleave" on a
server nobody has visited yet.

That single fact reorders every priority below.

## The requirement, stated properly

The job is not "make one effect look good". It is:

> Produce a SPACE of effects that a generator can sample from, such that every
> sample is (a) legible in combat, (b) inside the frame budget, and (c) visually
> coherent with the ability it belongs to.

A system that can express beautiful effects but only when a human tunes them is
a failure here. A system that produces merely *decent* effects from a seed,
every time, without supervision, is a success.

## Combinatorial, not parametric

A generator that samples raw floats — size 0.3–4.0, speed 1–20, colour anywhere
on the wheel — produces mush. Everything looks like everything else, and the
outliers look broken. This is why procedurally generated content usually reads
as noise.

What works is composing **hand-authored modules**: a small library of pieces
that each look deliberate, with a grammar for combining them. Every module
preset is authored by a human once, and the generator only ever chooses
*which* and *how many*, within declared envelopes.

## What shipped, and where

```
@hitreg/core   src/vfx/     the vocabulary, the spell document, the presets,
                            the generator, the audit  (headless, tested)
@hitreg/render src/vfx/     VfxSystem: pooled renderers per module kind,
                            slot lights, camera shake, the spell sequencer
@hitreg/scripting           ctx.vfx.play / ctx.vfx.playSpell / stopAll,
                            ctx.getDataAsset — ids and sockets resolved for you
apps/playground             src/vfx-host.ts wires one VfxSystem per app
combat-demo                 the spell lab (scripts/fx-lab.ts) and the sprite
                            catalog that maps the purchased library onto roles
```

### The vocabulary (`vfx/modules.ts`)

Thirteen module kinds, each a Zod schema in a discriminated union, each rendered
by one pooled class in `@hitreg/render`:

| kind | what it is | renders as |
| --- | --- | --- |
| `sprite` | a flipbook quad (billboard / ground / vertical / facing / velocity) | one quad, two uniforms per frame |
| `particles` | the `particles` component as a module (burst or stream) | the engine's own emitter |
| `ring` | disc or annulus — shockwaves, runes, portal faces, floors | unit disc, band drawn in the shader, draped |
| `shell` | sphere with fresnel rim, 3D noise, dissolve — orbs, wards, domes, pops | four styles by uniform |
| `column` | pillar / cone / hanging beam, noise-scrolled, cap-faded | one open cylinder, far radius in the vertex shader |
| `beam` | a line between two points, glow + core, pulsing | two of the same cylinder |
| `bolt` | lightning: jagged path re-rolled at `refreshHz`, with forks | camera-facing ribbon, glow + core |
| `light` | the secondary light | a borrowed slot light |
| `mesh` | a real body: drop / rise / hover / orbit / launch | procedural primitive or a model |
| `trail` | ribbon behind a moving anchor | rebuilt strip |
| `telegraph` | the declared volume: fill grows over the windup, rim, curtain | ported from combat-demo, draped |
| `shake` | camera shake | applied inside the draw only |
| `sound` | one-shot audio | host hook |

Every module shares an **anchor** (`origin` / `caster` / `target` / `path` /
`ground`, an optional bone socket, an offset in the spell's own frame,
`follow`), a `delay`, a `duration` (0 = natural length), a palette-slot
`color`, a blend mode and optional opacity/size curves. The vocabulary is
deliberately small and orthogonal: a pillar of light, a breath cone and a
judgement beam are one `column`; a portal is a facing `ring` with swirl plus a
`shell`; a summon is a `mesh` rising through a ground `ring`.

**Why the node material matters.** Every procedural kind hangs TSL nodes on
`MeshBasicNodeMaterial` — the same material the particle emitter and the water
surface use — so fresnel, scrolling `mx_fractal_noise`, dissolve, soft bands
and vertex displacement all run on the WebGPU backend and its WebGL fallback
with no second shader system. Nothing in the library needs a texture except
the flipbook sprites.

### The spell document (`vfx/spell.ts`)

```
{ name, element, palette?, feel[], seed,
  archetype: { kind, shape, radius, range, windup, duration, ticksPerSecond,
               speed, growTo?, height, cooldown, intensity },
  phases:    { telegraph?, charge?, cast?, travel?, impact?, tick?, linger?, end? } }
```

Thirteen archetype **kinds** — melee, projectile, bolt, beam, area, zone,
channel, pulse, buff, shout, debuff, summon, portal — and `spellTimeline()`
turns an archetype into *when* each phase fires: the telegraph at 0 for the
windup, charge across the windup, cast at the windup, travel for `range/speed`,
impact on arrival, ticks at `ticksPerSecond` through the duration, linger for
the duration, end after it. The sequencer in the renderer and the lab's
timeline bar read the same function, so they cannot disagree.

**The archetype is the reference every visual scales from.** A 6 m nova and a
1.5 m poke share presets; they differ in radius, and every sprite, ring, shell,
light range and particle count is a multiple of it. That is the whole answer to
"the scale has to make sense": nothing is sized in isolation. For line shapes
the reference is the width, not the length — a 16 m beam is not a 16 m
explosion.

### Presets and grammar (`vfx/presets.ts`)

A preset is a function from the spell's reference numbers (`R`, intensity,
windup, duration, palette, feel, catalog) to a module whose every value lands
inside a band that was looked at and judged. Presets carry tags: which phases
they serve, which grammar **slot** they fill (core, ground, debris, light,
tower, gather, release, head, tail, line, body, aura, mark, thing, gate,
dissipate…), which spell kinds and elements they suit (or are restricted to),
which sprite role they need, a minimum intensity.

`GRAMMAR` says, per phase, which slots to fill, how many, and how likely —
some scaled by intensity. `debris()` is one function with ten looks: what a hit
throws off is the strongest element cue after colour, so it is tuned per
element (embers rise and curl, ice shards streak and fall, storm sparks are
fast and stretched, blood drops are normal-blended matter).

**Sprites are asked for by role, never by name.** The engine ships no sheets;
a project maps its library onto `SpriteCatalog` roles (burst, flash, ring,
rune, slash, vortex, smoke, bolt, pillar, portal, gather, lightning, shard,
wave). A missing role is simply never chosen — the procedural modules carry the
effect. combat-demo's catalog is `scripts/lib/spell-catalog.ts`, classified off
a contact sheet of the greyscale row.

### The generator (`vfx/generator.ts`)

`generateSpell({ seed, element?, archetype?, catalog })` is deliberately thin:
seeded RNG (mulberry32, forked per phase so one phase's draws never shift
another's), the grammar, preset weights by element/feel, and the audit. All the
taste is in the presets; retune one and every spell using it improves.
`randomArchetype()` rolls inside bands that play well **and** satisfy the
combat audit's dodgeability rule (`radius ≤ 6.5 × (windup − 0.15)`), so a
randomized spell is never one a player could not have cleared.

Also: `generatePhases` (same seed, re-derived phases after an archetype knob),
`rerollModule` (another preset for the same slot), `addFromPreset`,
`presetsAvailable`.

### The audit (`vfx/audit.ts`)

Same discipline as `auditAbilities`, pointed at presentation:

- **budget** — peak particles alive (2400 whole spell, 1400 per phase), lights
  (2 per phase, 3 at once), modules per phase (12)
- **readability** — a telegraphed kind must draw a telegraph; nothing opaque
  may sit on the volume during the windup; a lingering volume stays
  see-through (normal-blended bodies ≤ 0.6, streams ≤ 0.7)
- **lifetime** — an impact is over within 3 s and inside the cooldown; linger
  modules do not outlive the duration
- **structure** — an impact exists; a projectile has something riding `path`;
  a beam has a beam

`spellStats()` gives the numbers the lab prints. The test suite generates 150
random spells and requires all of them to pass — that is the contract that
makes unsupervised generation shippable.

### The runtime (`@hitreg/render` `vfx/system.ts`)

`VfxSystem.play(effect, frame)` and `playSpell(spell, frame, { manual? })`.
A **frame** is objects, not ids: origin, direction, target, caster/target
objects, a socket resolver, a ground probe, a palette. Modules are pooled per
kind (particles per emitter data, sprites per sheet) and bounded; a spell cast
fifty times compiles nothing new after the first.

**Lights are a fixed pool.** Three's WebGPU backend hashes the set of visible
lights into every lit material's cache key, so a light that appears for an
impact and vanishes recompiles every lit shader twice (light-budget.ts measured
2296 ms/frame). The system creates its slot lights once, keeps them in the
scene at zero intensity, and modules borrow them. Steals the dimmest when all
are busy. **Camera shake** is applied inside the draw only
(`applyShake`/`restoreShake` around `renderer.render`) so the rig never sees
the offset.

`manual` lists phases the host fires itself with `handle.trigger(phase, at?)`
— a real projectile decides when its impact happens, an authority decides when
a tick lands — and `handle.setPath(pos, vel)` drives the projectile from the
real simulation. Everything else plays on the timeline.

### Scripts (`ctx.vfx`)

```ts
ctx.vfx?.playSpell("storm-lance", { origin, casterId: this.actorId, targetId })
ctx.vfx?.play({ modules: [...] }, { origin, direction: [dx, dz] })
```

Documents or data-asset ids (`assets/spells/*.json`, `assets/vfx/*.json`, both
registered types). The runtime resolves entity ids to objects, bone sockets by
tag (`socket:rightHand` under *that* body), and probes the physics world for
ground when no `ground` is given. Absent on a dedicated server — always
optional-chain it.

### The lab

`fx-lab` in combat-demo: **Randomize** (R) rolls a whole spell and plays it on
the character at a target placed at the archetype's own range; every archetype
number is a knob that re-generates from the same seed; every module is a card
whose knobs are rendered from its schema (numbers → sliders with the schema's
bounds, enums → selects, colours → palette slot or hex, curves → JSON); reroll
/ dup / delete / add-from-preset per module; the audit and stats update live;
**Save** writes `assets/spells/<name>.json`, which any script can then play by
id. The loop this closes: an agent's generator one-shots the spell, a human
points at the part that reads wrong and turns it, and the result is data.

### Second pass: PSX, masks, rain, status effects

Looking at the first pass in the lab showed the procedural rings and floors
read as ENGINE geometry — too perfect — and every channel looked like the
same dome and floor. Four answers, all data:

- **`pixel` / `posterize`** on every module: rings, shells, columns and beams
  quantise their UV/noise coordinates to N cells and band their alpha, and
  particles switch to `sprite: "square" | "pixel"` (nearest-filtered hard
  squares and 6x6 blobs). The generator applies it spell-wide
  (`generateSpell({ pixel: 24 })`); the lab's "look" select sets it.
- **Masks**: `node tools/fx.mjs masks <project>` draws 19 black-and-white
  48-px PSX masks (dashed and runic rings, arrows in/out, spikes, roots,
  chains, stars, hourglass, chevrons, hex shield, heal cross, wedge, crescent,
  eye, drips, burst, pull triangles, bolt ring). A `ring` lays one across its
  disc (`texture`, nearest-filtered); the catalog lists them with TAGS and the
  generator asks by tag — a root gets roots or chains, a haste gets chevrons.
  Ground rings yaw onto the spell direction, so wedges and arrows point where
  the spell does; `ring.arc` cuts a sector for cone strikes.
- **Rain**: `impact.rain` / `linger.rain` / `impact.shardRain` drop stretched
  square particles from a box above the volume; `cast.breath` is a cone spray
  in front of a melee/shout; `travel.storm` is a channelled bolt with `count`
  strands and `spread` around the target; `linger.hoops` and
  `linger.stormArcs` give channels something other than a dome.
- **Status effects**: `archetype.effect` (damage, root, stun, slow, haste,
  shield, heal, shadow) gates status presets — roots and rising spikes for a
  root, orbiting orbs and a star ring overhead for a stun, an hourglass floor
  and drips for a slow, chevrons and speed lines for a haste, a hex ward for a
  shield, a normal-blended dark shroud for shadow — placed on the body the
  status lands on. A `shadow` element joined the palette. Buffs and debuffs
  FLASH (0.6–1.4 s) unless `archetype.channelled`, in which case the aura
  holds for the duration and fades; `mesh.motion: "forward"` with a body from
  `catalog.bodies` is an afterimage/projection.

Textures load once, and a first play with a cold mask is invisible until it
lands — `ctx.vfx.preload(ids)` warms them; the lab does so at start.

## Third pass: symbols, cuts, steps, and the chug

Derek's notes on the second pass, in the lab: the straight procedural
geometry still read as engine output; symbols were spinning on the wrong
axis (a chevron ring rolling around a horizontal axis); cones and the
telegraph gradient were too bright; there were no melee attacks worth the
name; everything that moved slid instead of stepping; the vertical "hoops"
read as a stretched oval from every camera; and two saved spells chugged.
Each answer is data, and each is checked by a test:

- **Symbols** (`SymbolEntry` in `presets.ts`). A hand-drawn sheet of sigils,
  glyphs, stars, arrows and stuck projectiles goes through
  `node tools/fx.mjs symbols <project> <name> <sheet.png>` — it finds every
  symbol on the page (connected pieces joined when close, never past a
  symbol's plausible size), packs them one per cell into a uniform grid, and
  writes the spritesheet plus `assets/fx-catalog/symbols.json`. A `sprite`
  module with `cell: [col, row]` draws one symbol statically; `orbit` /
  `orbitSpeed` circle it around its anchor. **Every symbol carries the rules
  a human dictated**: `roles` (sigil, glyph, star, head, stuck, mark),
  `orient` (which of ground / facing / billboard / vertical / velocity it may
  be drawn in) and `spin` — `none`, `ground` (turns only when lying flat) or
  `any` (may roll in its plane standing up, which is only right on a circle).
  The lab's **symbol browser** shows each sheet as its grid, and a click
  sets those rules, tries the symbol on the character in each orientation,
  and saves. `symbolSprite()` in the presets only ever picks a symbol at an
  orientation it allows and clips the spin to its rule; a preset that needs
  a role the catalog lacks declines. Presets: sigils under casters and
  volumes (`charge.symbolSigil`, `telegraph.symbolSigil`,
  `linger.symbolFloor`), a sigil standing in front of a charge-up
  (`charge.frontSigil`), glyphs orbiting the caster facing forward
  (`charge.orbitGlyphs`), impact marks, a symbol riding a projectile's nose
  (`travel.symbolHead`, drawn pointing up, aligned to the velocity) and the
  projectile left **stuck in the ground** for a beat (`impact.stuck`).
- **Slashes** (`slash` module). One disc whose leading edge sweeps a sector
  over `sweepTime` with a fading tail — the anime cut. `tilt` rolls the
  cutting plane around the spell direction (0 cleave, 90 overhead chop,
  ±45 diagonal), `reverse` runs it the other way. Melee casts now draw
  `cast.sweep`, `cast.chop`, `cast.cross` (two copies, alternated) and
  `cast.thrust`.
- **Steps** (`repeat` on every module). `count` copies, `every` seconds
  apart, each `step` metres on in the spell frame and `turn` degrees around
  the anchor, `scale`d per copy, spin `alternate`d. Nothing tweens between
  copies: spikes erupt one after another along a strike
  (`impact.spikeSteps`), fire pops in a line or around a circle
  (`impact.fireSteps`, `linger.stepFire`), rings appear each larger than the
  last (`impact.stepRings`), and a **column of circles turning against each
  other** (`linger.stack`, `linger.symbolStack`) replaces the hoops. The
  sequencer expands repeats once per play (`expandRepeat` in core, shared
  with the audit, which now also caps live instances per phase).
- **Pixel telegraphs and trails.** The telegraph's three surfaces are node
  materials: a world-grid checker fill, a dashed rim (`dash`), and a curtain
  that fades upward in posterised bands and dissolves cell by cell. Defaults
  are dimmer (rim 0.7, curtain 0.28). The trail bands its fade, steps its
  width with the bands, and dithers its tail away on a world grid. Sprites
  and symbols with `pixel > 0` sample a nearest-filtered copy of their sheet.
- **Brightness.** Cones sit at 0.38 opacity, pillars at 0.55, and the tube
  shader mixes 0.3 toward glow instead of 0.5 — two overlapping cones no
  longer make a white wedge.
- **The chug.** Measured in the lab with a headless probe counting GPU
  pipeline creations per play: the steady state was never the problem
  (p95 8 ms with the two saved pulses running), the FIRST play of any spell
  was — 10–12 render pipelines compiled on the main thread, a 265–739 ms
  stall, then never again for that spell. Two causes, both fixed:
  1. Every particle emitter compiled its own shader, even two with identical
     settings, because `InstancedMesh` bakes a uniform buffer named after the
     node's id and the capacity into the WGSL. The emitter is now an
     `InstancedProps` (instance matrices and colours as geometry attributes,
     the same fix the foliage got), so all emitters of a look share one
     program: a new emitter costs zero compiles.
  2. Everything else compiled on first draw. `VfxSystem.warmup()` plays an
     invisible sampler of every module kind and variant (textured ring,
     symbol sprite, one sprite per sheet, cone/line telegraphs, the particle
     blends) far below the world and hands the root to
     `EngineRenderer.precompileGroup`, so the pipelines exist before the
     first cast; both apps call it on their first frame (`warmVfx`).
  Also: mask rings have a lean shader with no noise at all; procedural
  rings, columns and shells evaluate ONE single-octave noise (coordinates
  blended between flat and spiral, not two results); effect bodies no
  longer cast shadows; the character afterimage (a full skinned clone per
  play, with a material clone per mesh) is gone. The lab prints the browser
  frame interval next to the audit so "chugging" is a number, and
  `window.__hitreg.vfxHost.play(doc, frame)` lets a probe play one module in
  isolation.

## Symbol sheets: how to draw them

One PNG per category (symbols, projectiles, radials…), any size, white on
black or black on white, symbols in loose rows with clear gaps and never
touching. The intake tool handles both page colours and packs whatever it
finds, so the page needs no grid discipline — only spacing. Draw arrows and
spears pointing **up**; draw stuck projectiles with their base at the
bottom. A 512 px page with ~75 px symbols is plenty: the atlas is
nearest-filtered, so what you draw is what renders.

## What actually reads as "cheap" (and what fixed it)

1. **Hard intersection lines** → soft-particle depth fade (Phase 1).
2. **Static particles** → per-particle sub-UV (Phase 1).
3. **Two-point lerps** → curves on everything (Phase 1, and every module).
4. **Round sparks** → velocity stretch (Phase 1); `radial: in|out` for
   gathers and explosions (Phase 4).
5. **No secondary light** → every impact borrows a slot light.
6. **No distortion / dissolve / panner** → noise-scrolled columns, dissolving
   shells, fresnel rims (Phase 3, as nodes on the existing material).
7. **A sprite alone** → the grammar never produces one module; an impact is a
   core + ground + debris + light on three clocks, staggered by `delay`.

## Judgment that is not in the schema

- Additive is light; normal is matter. Nearly everything magical is additive,
  but a cloud has to occlude — you should lose sight of a body standing in a
  poison field. The audit caps how much.
- Pale palettes (holy, storm) saturate under additive stacking + bloom; their
  primaries are kept off-white on purpose. Reach for `glow` sparingly.
- A telegraph's rim is the only number a dodge is judged against. Nothing may
  cover it during the windup, and generated spells never do.
- Sizes are multiples of `R`; timings are fractions of the windup/duration.
  A preset that hard-codes a second or a metre is a bug.
- File names: never `aux`, `con`, `nul`, `prn` — Windows reserved device
  names, and Vite silently fails to resolve them while `tsc` is fine.

## What this replaces

combat-demo's `fx-pool` / `fx-emitter` / tagged-entity-pool arrangement and its
flat `FxLayer[]` lists are now scaffolding on the way out: the pooling lives in
the engine, a layer list is a subset of a module list, and an ability can carry
a `spell` id instead. The old telegraph-pool remains the combat scenes' drawer
until the caster is switched over; the engine's `telegraph` module is the same
geometry with the same drape.
