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
the project                 the spell lab (scripts/fx-lab.ts) and the sprite
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
| `trail` | ribbon behind a moving anchor, or the surface a weapon's edge sweeps (`edge`) | one strip in the shared trail batch |
| `telegraph` | the declared volume: fill grows over the windup, rim, curtain | ported from the combat prototype, draped |
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

### The five schools (`vfx/elements.ts`)

`element` is one of exactly five schools of magic: **shadow, holy, nature,
water, destruction** — nothing else validates. Water covers frost and ice;
destruction covers fire, lightning and raw force. Each school has one palette
(primary / secondary / glow), a default `feel`, the closest authored colour
row of the purchased flipbooks, its own debris character, name adjectives, and
its own **symbol sheet** — magic circles, emblems, sparks and glyphs drawn in
that school's motifs. Symbol catalog entries carry `elements: [school]`; a
school's spells draw only their own symbols, and unschooled symbols (the
original hand-drawn `fx-symbols`) are only the fallback for a school that has
none for a role.

School sheets are generated (docs/image-generation.md) at 1024 px on black and
taken in with `fx.mjs symbols ... --downsample 2 --elements <school>`: the
box-filtered halving puts them on the 512 px page the hand-drawn sheet was
made at, so their circles land in the same ~88 px cells.

Each school also has a **projectile sheet** `fx-projectiles-<school>`
(heads drawn pointing up, plus the same kinds stuck in the ground; symbols
intake with `--rows 0-2=head,3-4=stuck`) and a **decal page**
`fx-decals-<school>` (below). The projectile's head is a symbol; what
streams off it is `travel.wake`, a particle stream in the school's own
matter — flames lick up off destruction, droplets drip off water, leaves
tumble off nature, motes float off holy, smoke rolls off shadow.

### Ground decals that grow in (`decal` module, `fx.mjs decals`)

A `decal` lies on (and drapes over) the ground and GROWS: cracks race out
from the strike, frost feathers across, vines unfurl, flowers open. The page
is data, not art: **R = when each texel appears**, G = the drawn brightness,
A = coverage. `fx.mjs decals <project> <name> <sheet.png> --grid 3x3
--downsample 2 --elements <school> --cells "crack,web;vine,leaf;…"` computes
R as the shortest path ALONG the mark from the texel nearest the cell centre,
so a crack travels down its own line instead of wiping in as a circle; a
piece that does not touch the rest (a hail stone, a separate leaf) starts
when a radial front reaches it, then grows along itself. The shader moves
one uniform (the front): texels behind it show, texels it crossed less than
`edge` ago burn in `edgeColor`. It holds for its life, then fades or, with
`recede`, runs the front backwards (growth withdraws, frost melts back).
Sampled nearest and WITHOUT sRGB decode (`loadTexture(..., nearest, data)`)
— the channels are timing. One mesh, one draw per decal; pooled per sheet.

The `scar` grammar slot places them: `impact.scar` under a landing (sized
to the blast, gone inside the impact tail), `linger.scar` across a lingering
floor, `cast.stompScar` under a slam or war-cry. Dark schools (shadow,
destruction) leave normal-blended matter with a glowing front; bright ones
leave additive light. Decal tags (`crack`, `vine`, `frost`, `chain`…) let
the status effect bias the pick: a root prefers vines, roots and chains.
Catalog: `assets/fx-catalog/decals.json`, same school rule as symbols.

Traps: the intake's Dijkstra must store distances as Float64 — a Float32
store rounds below the key it was pushed with and the stale-entry check
then drops every texel after the seed (every mark came out "all at once").
A generated sheet can come back black-on-white even when asked otherwise
(a black-on-white LAYOUT reference did it); the symbol intake reads either
page colour, but outline art on white becomes hollow outlines — regenerate.

### One texel for the whole spell (`texel`)

`pixel` counts cells ACROSS A SHAPE, so at 24 a 12 m ring had 50 cm blocks
and a 1 m slash 4 cm ones — every piece of a spell pixelated at a different
scale, and the big ones looked broken. `texel` is the PSX look in WORLD
metres per texel, stamped on every module by the generator and carried on
the spell (`spell.texel`, applied to any module that leaves its own at 0, so
rerolled and hand-added pieces match). Each renderer derives its cells from
its real size every frame (`LiveModule.cellsAcross`), so an expanding
shockwave keeps its block size. Sprites snap their UVs to the grid and read
the sheet's mip level whose texels match it, so thin line art fades instead
of dropping out; decals and drawn bodies quantise the same way. **3 cm** is
the default: it is the hand-drawn sheets' own density at typical sizes —
6 cm turned a 1.6 m sigil into 27 texels of mush.

### Symbol glow, ground spin, the crown

A symbol sprite's `glow` builds a halo from its own shape (the strongest
line within `glowSize`, full near and half at the outer ring, banded on the
texel grid; confined to its cell so neighbours on the sheet never bleed in).
An AVERAGE of the taps reads nothing on thin line art and a boosted one fills
a sigil's interior into a white disc. `SCHOOL_GLOW` sets each school's
strength (holy brightest, shadow smouldering).

Derek's rule: a symbol lying on the ground never spins — `symbolSprite`
zeroes spin for `orient: "ground"`. Orbiting a body is fine: `crown.glyphs`
revolves glyphs above the caster's head through the charge, and through the
whole of a channel or held buff.

### Summoned bodies are drawings (`mesh.sheet` + `cells`)

Procedural cones, octahedra and spheres read as placeholder geometry and are
never generated: a `mesh` preset without a model asset gets the school's
`object` symbols instead (`fx-objects-<school>`: rows of spikes, crystals,
rocks, orbs, blades, drawn upright with the base on the cell floor — intake
`--roles object --row-tags 0=spike,... --align bottom`), matched by the old
primitive's name. Each body is an upright quad that yaws to the camera; all
motions (drop, rise, hover, orbit, launch, forward) are kept. One shared
material — each body's quad carries its cell in its own UVs. Without a
drawing for it, a spike/crystal/orb body is simply not generated. Real
models (`asset`) still render in 3D.

### No generated telegraph; world-space projectiles

The generator no longer fills the spell's `telegraph` phase: the dodge
volume is the host's to draw from the ABILITY (voxel-demo's telegraph pool),
and a second one baked into the spell only doubled it. The audit no longer
demands one; it still keeps the windup's rim clear.

Projectile heads and stuck projectiles use sprite `orient: "world"` +
`crossed`: fixed in the world with the art's top along the motion (at rest:
upright, square to the spell direction), a second quad at 90° around the
long axis so it never vanishes edge-on, spin rolling around that axis. They
no longer turn to face the camera. Symbols lying on the ground get no glow
(the offset taps read as a ghosted second copy under the caster).

### Visuals stay inside the damage volume (`vfx/fit.ts`)

A player reads a spell's visuals as the danger zone, so anything drawn past
the edge the hit test uses is a lie. `moduleReach` measures each module's
horizontal reach from its anchor — rings and shells at full expansion,
sprites and decals by half their size (+ orbit), columns, drawn bodies
(spread + size), stepped repeats by their last step, and particles by
emitter extent + how far they actually travel (speed with drag over their
life, only the sideways share of it) + turbulence + their own size.
`fitSpellToVolume` scales back every piece on the volume (impact, tick,
linger, end; the cast too when the volume is centred on the caster) to
`FOOTPRINT_TOLERANCE` × the radius, iterating because a particle's own size
does not scale. The generator fits every spell and every reroll/add; the
audit's `footprint` rule flags anything still outside. A game fits a spell
to the ABILITY that plays it (its real radius, a projectile's splash):
voxel-demo's saved spells had pieces reaching 1.25–1.9× their radius.

### Rapid fire and homing are part of the spell

`archetype.volley { count, interval, spread }` and `archetype.homing
{ turnRate, acquire, cone }` (projectile only) make a spell fire several
shots and/or seek. The timeline carries `shots`/`shotInterval`; the
sequencer gives EVERY shot its own path, travel play and impact: simulated
(launched on the burst's rhythm, scattered by its blooming spread —
`shotSpread`, 0.3× → 1×, seeded so a spell scatters the same way every play
— steered toward `frame.targetObject` when homing, landing where it
arrives), or driven by a host through `handle.launch(pos, vel)` → a shot
handle (`setPath`, `impact`, `end`). The generator rolls volleys and
seekers, and `shapeVolley` keeps a burst in the budget one heavy bolt fits
in: no light or shake per shot, particles thinned by √shots, smaller heads,
each shot's impact trimmed to its most telling pieces, and the cast
REPEATING with the burst so each shot gets its own flash. The audit counts
travel and impact once per shot.

A barrage should not be a line of bullets: `archetype.wiggle
{ amplitude, wavelength }` makes shots WEAVE (`wiggleOffset`: each shot its
own phase from its seed, easing in so it leaves the hand straight — the
same pure function a game's hit test uses, so a shot hits where it is
drawn), `volley.jitter` scatters each launch point around the hand
(`shotJitter`), and `shapeVolley` shrinks every travel piece by
max(0.4, 1.1/√shots). Generated rapid fire rolls 5–12 shots every
0.04–0.09 s with a weave.

### The lab: solo, mute, ban

Every module card in the spell lab has ▶ (play ONLY that piece, on the
spell's own timeline, so travel pieces still fly), mute (leave it out of Play
without deleting it) and ban (never generate that preset again for this
project — `assets/fx-catalog/presets.json`, read into
`catalog.disabledPresets`; the Banned section under the audit unbans).

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
some scaled by intensity. `debris()` is one function with five looks: what a hit
throws off is the strongest element cue after colour, so it is tuned per
school (destruction embers rise and curl, water droplets streak and fall,
nature spores drift, holy motes float up, shadow is normal-blended smoke).

**Sprites are asked for by role, never by name.** The engine ships no sheets;
a project maps its library onto `SpriteCatalog` roles (burst, flash, ring,
rune, slash, vortex, smoke, bolt, pillar, portal, gather, lightning, shard,
wave). A missing role is simply never chosen — the procedural modules carry the
effect. voxel-demo's catalog is `scripts/lib/spell-catalog.ts`, classified off
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
the offset, and it **falls off with distance**: `strength` is what a camera
standing at the effect feels, `range` (default 30 m) is where it reaches
nothing, quadratic in between and measured from the camera's position on the
last `update`. A shake with `range: 0` is felt everywhere in the world — an
NPC fight across the map jolts every player, so treat 0 as a deliberate
world-event choice, not a default.

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

`fx-lab` in voxel-demo: **Randomize** (R) rolls a whole spell and plays it on
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
  status lands on. Buffs and debuffs
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

## Weapon trails, one batch, and hit-stop (2026-10-04)

Built for voxel-demo's melee (its `docs/combat-build/V-melee-visuals.md` has
the game side: what drives each piece from combat events and skill data).

- **Every trail is one draw.** `TrailLive` owns no mesh: each live trail
  writes its strip into the system's `TrailBatch` (`modules/trail-batch.ts`)
  between `begin`/`end` in `VfxSystem.update`, one mesh per blend mode. What
  used to be per-trail uniforms (head/tail colour, fade, alpha steps, texel
  dither cells, opacity) are vertex attributes, and only the written range is
  uploaded (`addUpdateRange`). Six fighters' sword trails plus a volley's
  projectile tails: one draw. `sys.trails.stats()` reports vertices per layer.
- **`trail.edge`: the surface an edge sweeps.** Two points (`from`, `to`) in
  METRES in the anchor object's own axes (its rotation, not its scale — a
  held weapon's entity carries its 0.019 import scale), optionally on a named
  `bone` under it (a creature's hand). Each frame samples both; the ribbon
  spans them, smoothed by `subdivide` Catmull-Rom points so a fast swing draws
  an arc; `rootOpacity` keeps the hilt side see-through; `taper` slides the
  inner side out to the tip as a sample ages; `minSpeed` fades samples whose
  outer point moved slower than that (a wind-up's raise and the pause at the
  top leave no smear, the cut does). Anchor it `{ at: "caster", follow: true }`
  and pass the weapon's entity as the frame's caster.
- **Hit-stop is a userData stamp.** `AnimationSystem.update` skips any model
  whose root, entity or a body up to three levels up carries
  `userData.poseHoldUntil` later than `performance.now()` (ms): the pose holds,
  the held time is dropped (the clip resumes a beat behind), the simulation is
  untouched. Presentation only; a script sets it on a body.

Second pass (2026-10-04, same day):

- **A trail can lead with a hot edge.** `trail.falloff` (brightness =
  `(1 - age/length)^falloff`; 1 = the old linear sheet, 2.5-4 = a short
  glowing wake) and `trail.coreColor` (a third colour: the ribbon ramps in hard
  steps core → `color` → `colorEnd`, the core and middle bands are drawn SOLID
  and the tail band at half strength under the dither; with `edge` the
  brightness also leans to the outer point, so the core runs along the blade
  near its tip). Both are vertex attributes of the same batch (`aCore`,
  `aEdge`): no new material, no new draw. With `falloff > 1` the `taper` slides
  the inner side all the way to the tip's line. A dark `colorEnd` under
  additive blending is what makes the tail fall to nothing; a pale one is a
  translucent sheet.
- **`anchor.local`: a point ON the anchor object.** With `at: caster|target`,
  `offset` is in the object's own axes (rotation, not scale) and the module
  faces with it, re-resolved every frame under `follow`. A particle emitter
  with `space: "local"` then rides a held weapon's tip — the wind-up gather and
  glint on any weapon (the first pass's tip glint "landed off the blade"
  because the offset was in the spell frame and sampled once).
- **A textured particle look draws nothing until its sheet has loaded**
  (`ParticleBatch.awaitingTexture`): the stand-in sprite played through a
  sub-UV grid was a hard white box for the first play. Warm a look you need on
  frame one (play it once out of sight) so the sheet and its pipeline are ready.
- **Hit flinch is a userData stamp too:** `userData.poseFlinch = { at, dir,
  angle, ms, twist?, wobble? }` (same lookup as `poseHoldUntil`) bends the
  spine chain along the blow after the mixer and the anchors, with the same
  undo-first rule; it snaps out even during a hit-stop. See
  `docs/character-animation.md` "Hit flinch".

Traps: a decal's drape probes the frame's `ground`; the runtime's default probe
hits bodies standing on the ground, which spikes the decal mesh up around
them — pass a terrain-only `ground` for anything under a fight. A particle
emitter's pool key is its whole emitter JSON: vary a per-hit effect through the
module (`burst`, palette slots, anchor), never the emitter, or every hit builds
a new emitter.

## Standing effects: torches, braziers, campfires (the `vfx` component)

Environmental fire is not a spell, but it is authored in the same vocabulary so
there is one effects system, not two. An entity carrying
`"vfx": { "effect": "env/fire-torch", "material": "fx/fire" }` plays that `vfx`
asset for as long as it exists (`AmbientVfx` in `render/src/vfx/ambient.ts`,
wired by `createAmbientVfx` in the playground host):

- **It never ends.** The play's phase length is infinite, so `duration: 0`
  modules and `stream: true` particle modules sustain. Flames are `particles`
  modules — the engine's own emitter, nothing new.
- **Its light is its own.** A `light` module on a standing effect gets a
  dedicated PointLight registered with the scene's `LightBudgetSystem` (32
  slots) instead of borrowing VfxSystem's four flash slots, which twenty
  torches would steal from each other. The light is hidden from birth, so it
  never enters the renderer's light set — no recompile.
- **It follows its entity** (anchors forced to `follow`), **sleeps past
  `cullDistance`** (10% hysteresis, fade out/in), and **dies with its group**
  (a streamed cell unloading takes its torches with it).
- **Its colour is a material.** `paletteFromMaterial` (core) turns a material
  asset into the palette: `color` → primary (the flame body), `emissive` →
  glow (the hot core), `color` darkened → secondary (the tips). Effects
  reference palette slots, never hexes, so a blue spirit-fire is a different
  material on the same effect. Editing the material live restarts the effects
  using it; editing a `vfx/` file live restarts the effects playing it.

**The standard fire set** is written into a project, not shipped by the
engine: `node tools/fx.mjs fire <project>` (from `apps/playground`) writes
`vfx/env/fire-{candle,torch,brazier,campfire,bonfire}.json` and
`materials/fx/fire{,-spirit,-fel}.json`. The five sizes are one recipe scaled
by `s` (core, body, embers, smoke, light), so they read as the same fire;
entity scale does not scale an effect. Existing files are kept — they are
data to tune — unless `--force`.

**PSX particles.** The first set looked right in a smooth render and wrong for
the game: soft round blobs, a colour ramp that glides, sub-pixel drift. Four
`particles` fields (engine-wide, so spells use them too — the generator's
`pixel` pass sets `steps`) are what make an emitter read as 1998:

| field | does | fire uses |
| --- | --- | --- |
| `sprite: "flame"` | an 8x8 nearest-filtered pixel-art flame tongue (with `square` and `pixel`, the hard-texel sprites) | square embers, pixel smoke (flames now play a sheet, below) |
| `steps` | colour, size and opacity in N hard jumps over life, each sampled mid-step | 4 flame, 3 embers/smoke |
| `snap` | rendered positions on a world grid, quad sizes in whole cells (never below one) | `0.04 × s`; embers are exactly one cell |
| `frameRate` | the simulation advances in whole 1/N ticks — particles hold, then jump; billboards still face the camera every frame | 12 flame, 8 smoke |

**Flame particles never move** (Derek: rising flame sprites read as shapes
floating away). The body, core and tip layers have `speed: [0, 0]`: each
particle is born at full size inside its layer's volume and only shrinks and
fades in place. The silhouette is the stacked birth volumes; the flicker is new
sprites popping in on each tick. Only embers and smoke travel.

**Flames play a flipbook.** The body and core layers use `fx/flame-lick.png`
— the white row of the purchased library's Effects 12 / 580.png, cut to a
14-frame strip with `fx.mjs particle-sheet … flame-lick=12:30 --row 5` —
with `subUV` mode `life` (each particle licks through the strip once) and the
particle `filter: "nearest"`. The palette tints the white art. The art fills
only the middle of its 64 px cell, so the quads are large (0.8 × s body). A
third "tip" layer born above the flame was removed: small sprites spawning
over the fire read as bits floating away from it.

**Particles are batched by look.** Emitters no longer own meshes: every
emitter with the same sprite/texture, blending, sheet grid, soft-fade distance
and filter writes into one `ParticleBatch` mesh each frame, drawn single-pass
(`forceSinglePass` — three otherwise draws a transparent double-sided material
twice). Measured on fire-lab (seven fires, 33 emitters): 94 draw calls → 31;
the particles went from 66 draws to 3. A fire layer costs one draw however
many torches share it. `ParticleSystem.drawOf(id)` / `stats()` expose the
batching to probes and tests; the VFX system parents its batches under
`vfx.root` so the warmup precompile still reaches them.

**The ember bed under the flame** is a material, not an effect:
`materials/fx/ember-bed` is `unlit`, maps the ember texture (Derek's
`Embers.png`, 128 px, nearest), and carries a material `overlay` — pixelated
noise scrolling over the surface as glow (the schema lists the knobs). It is
added to the EMISSIVE term, so it shows on unlit, standard and toon alike and
feeds bloom; two noise copies scroll against each other and the time axis
evolves the pattern in place, so the heat churns rather than sliding;
`mask: "map"` gives the heat the map's OWN colour (`maskStrength` of it), so a
crack flares hotter in its hue while a dark coal adds almost nothing. Both
earlier versions failed in play: weighted by luminance it was invisible (a red
crack's linear luminance is ~0.28), and as a flat colour strong enough to see
it washed the tile beige. `maskCutoff` then restricts the heat to the LIGHT
parts of the art: a texel whose brightest linear channel is under it gets
none (short ramp above it, so the edge does not shimmer). Pick it from the
texture — the 128 px ember art has 62% of texels under 0.2 and the cracks from
0.3 to 1.0, so the bed uses 0.3; measured headless over half a second, 0.1% of
coal pixels changed against 26% of crack pixels. `pixel` 64 on the 128 px texture
lands the heat on 2x2-texel blocks; `steps` bands it; `frameRate` steps the
clock. Every number is a uniform — a live tweak patches without a recompile.
Put it on the torch head, the brazier's coals, the campfire's bed; the fire
generator writes it (`--embers <png>` copies the texture in). Measured
headless: across one second the overlay tile changed ~20x the pixels a
texture-only tile did (the rest is light flicker on the floor); at a 0.15/s
time axis it barely moved and read as a static texture.

No `softFade` and no `stretch` on PSX layers: hard intersections and square
texels are the era. Judge them through the scene's `postfx.pixelate` (480,
nearest) — that is how every voxel-demo scene renders.

Traps:

- **Never rebuild the play clock as `startedAt + t * life`** in a module. A
  standing effect's life is Infinity and its `t` is 0, and 0 × Infinity is
  NaN — that is what a torch's light intensity was before `LiveModule.now`.
- **A background precompile must skip materials whose textures are still
  loading** (`materialMapsLoading`, checked in `EngineRenderer`'s precompile
  traverse). The graph is rewired when the maps land; a rewire mid-compile
  rebuilds the shader outside the borrowed MRT window and three logs "Color
  target has no corresponding fragment stage output". It surfaced with the
  ember bed only because no other material shares its texture, so it was the
  one still loading — 3 of 4 probes before the skip, 0 of 3 after.
- The entity's origin is the BASE of the flame. Offsets in the effect are
  metres above it.
- The spell audit's budgets do not apply to standing effects; the pool sizes
  do (`emitter.max`). A bonfire is ~340 particles, a torch ~90 — `cullDistance`
  is what keeps a dungeon of them affordable.

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
- Pale palettes (holy, water glow) saturate under additive stacking + bloom; their
  primaries are kept off-white on purpose. Reach for `glow` sparingly.
- A telegraph's rim is the only number a dodge is judged against. Nothing may
  cover it during the windup, and generated spells never do.
- Sizes are multiples of `R`; timings are fractions of the windup/duration.
  A preset that hard-codes a second or a metre is a bug.
- File names: never `aux`, `con`, `nul`, `prn` — Windows reserved device
  names, and Vite silently fails to resolve them while `tsc` is fine.

## What this replaces

The combat prototype's `fx-pool` / `fx-emitter` / tagged-entity-pool arrangement and its
flat `FxLayer[]` lists are now scaffolding on the way out: the pooling lives in
the engine, a layer list is a subset of a module list, and an ability can carry
a `spell` id instead. The old telegraph-pool remains the combat scenes' drawer
until the caster is switched over; the engine's `telegraph` module is the same
geometry with the same drape.
