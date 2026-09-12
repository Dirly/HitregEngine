# Character animation

Judgment and pitfalls for getting an animated humanoid into a scene. Field
lists live in the spec (`animator` component, `third-person-controller`
params) — read those for exact names, and this for what will silently go
wrong.

## Getting clips onto a character

The engine loads **GLB / self-contained glTF only**, and a character needs its
mesh, skeleton and clips in *one* file. Two facts decide the whole pipeline:

- **An animation library almost never shares your character's skeleton.** They
  differ in bone names, bone count, bone axes, and — the one that quietly ruins
  the result — **rest pose**. The libraries built on the Unreal mannequin rig
  (`pelvis` / `spine_01` / `upperarm_l`) are modelled T-posed; an auto-rigged
  scan out of AccuRig / Character Creator (`CC_Base_*`) lands in a steep A-pose,
  arms ~70-85° lower. Copy local rotations across and every clip plays with the
  arms welded to the character's sides. Three's own `SkeletonUtils.retarget` has
  the same failure: it assigns the source's world rotation to the target and
  assumes the rests already match.
- **Use the in-place clips, not the root-motion ones.** A library that ships
  both (`Library.fbx` and `Library_RM.fbx`) gives you a choice, and the
  controller here drives movement through physics velocity. Root-motion clips
  would move the character a second time and fight it. Nothing in the engine
  currently consumes root motion.

`pnpm -F playground retarget` does the conversion:

```
pnpm -F playground retarget --anim Library.fbx --list      # what's in there
pnpm -F playground retarget \
  --mesh Character.fbx --anim Library.fbx \
  --out projects/<game>/assets/models/<name>.glb
```

It reads the source rig's rest pose, poses *your* rig into that same pose by
aligning each mapped bone's aim direction, and measures every frame as a delta
from there. Bones with no counterpart — twist bones, share bones, toes, the
face rig — hold their bind pose, which reads far better than driving them from
a bone they don't correspond to. The tool prints how many bones it drives and
the largest rest correction it applied; **a run reporting 0 corrected bones on
rigs you know differ means the bone map didn't match**, not that no correction
was needed.

**What to ask of the source character.** Two choices in the auto-rigger decide
how good the result can be, and neither is recoverable afterwards. Export the
**full set of finger bones** — with only index and thumb the library's other
digits have nowhere to go, and the hand has to aim down its index instead of
its middle finger, which throws off hand roll. And rig in a **T-pose** where
the tool offers it: the further the character's rest is from the library's, the
more correction the reconciliation carries (a steep A-pose costs 80°+ at the
upperarms), and correction is where error lives. Re-exporting is otherwise a
drop-in — the map keys on names, and the rest reconciliation is measured at
bake time from whatever pose the new file has.

Skeleton correspondences are data in `apps/playground/tools/rig-map.mjs`
(`bones`, plus the `aim` chain that makes the rest reconciliation possible).
An `aim` may list several candidate children so one map covers rigs of
differing completeness.
A new rig pair is an entry there, never a change to the retarget math. Clip
selections live in the same file as presets; `locomotion` emits the exact clip
names `third-person-controller` looks for.

Hip travel is measured between the rigs in **world** space and converted back
through the hip's parent before it is stored. That conversion is not
bookkeeping: an auto-rigged export whose root bone carries a Z-up correction
will otherwise take the entire vertical bob and write it into the forward axis,
which reads as a character gliding at one fixed height with its feet never
reaching the ground. If a converted run looks like it is hovering, measure the
hip's Y range across the clip before touching anything else — a constant one is
this bug.

Two things worth checking on any freshly converted character:

- **Scale.** Auto-rigged exports are routinely half or 100× life size. The tool
  normalises to `--height` (default 1.8m) and prints the factor it used; leave
  the entity's own transform scale at 1 so that stays the single place stature
  is set.
- **Facing.** The controller yaws the character to `atan2(x, z)`, which points
  a model's local **+Z** down its direction of travel. A model authored facing
  some other axis needs `modelYaw` to make up the difference — that param
  exists for exactly this, and a character that runs sideways or backwards is
  always this and never the clips.

## Rigging a creature that has no skeleton

`retarget` bakes clips from one skeleton onto another. A modelled creature —
a wolf out of Blockbench, a prop-shop OBJ — has **no** skeleton, so there is
nothing to bake onto. `pnpm -F playground autorig` covers that case: it takes a
donor rig that already animates (any GLB with a skeleton and clips), warps that
skeleton into the new mesh's proportions, and skins the mesh to it.

```
pnpm -F playground autorig --rig Dog.glb --mesh Wolf.obj --forward +x \
  --texture Wolf.png --clips "Idle=Idle_Alert,Walk,Run,Bite,Howl,Death" \
  --height 0.95 --out projects/<game>/assets/models/mobs/wolf.glb \
  --render /tmp/wolf.png
```

**The clips are copied, not baked** — and that is only sound because of one
rule the tool never breaks: bone **rotations** stay the donor's, only bone
**offsets** move. A clip sets local rotations absolutely, so a skeleton with
the donor's hierarchy and rest rotations but its own limb lengths plays the
donor's clips exactly, at the new creature's proportions. (`--report` prints
every bone's donor position next to its fitted one; the fitted skeleton's world
rotations match the donor's frame for frame, within track quantisation.) The
corollary is the failure mode: anything that rotates a rest bone — including a
"fix" for a limb that looks slightly off — silently rewrites every frame from
that bone down.

Three things decide whether the result is any good:

- **The reference pose, which is the one real judgment call.** The fit happens
  in a pose, and the closer that pose is to how the target was *modelled*, the
  better everything lands. A donor's **bind pose is usually not it**: the dog
  rig this was built for binds with its tail straight out behind, while every
  one of its clips lets the tail hang — and the wolf is modelled with a hanging
  tail. Fit to bind and the hanging geometry gets bound to bones pointing
  backwards, so frame 1 of any clip folds the tail under the belly. The default
  is therefore `--pose avg:<clip>` over a walk: for a quadruped that averages to
  a neutral stand with the tail, head and legs where the animation actually
  keeps them. `--pose bind` and `--pose Walk@0.25` are there when a donor's
  bind pose really is its neutral.
- **Landmarks, then relaxation.** Both meshes are measured for the same
  anatomical points — ground, belly, back, nose, tail, the two leg columns,
  half-width — and the donor's bones are mapped through the piecewise-linear
  transform those pairs define. That gets the skeleton the right *size*;
  `--relax` (2 passes by default) then settles each joint into the middle of
  the geometry around it, which is what walks a tail chain down a tail the
  donor holds out straight. Relaxation moves positions only, never rotations.
  The head is fitted separately, by similarity onto the target's head: a skull's
  height is set by where it hangs off the neck, not by the torso's profile.
- **Symmetry.** Any left/right asymmetry in the reference pose is baked into the
  bind pose, where it reads as a permanent limp on a creature modelled standing
  square. The pose is folded onto its own mirror before anything is fitted
  (`--no-symmetry` to keep it). This is also why the default clip preference is
  walk → trot → run → idle: a run averages to a crouch with the feet off the
  ground, an idle to whatever the donor happened to be looking at.

`--render <file.png>` writes a textured turntable strip — four frames, side on
and three-quarter — with a software rasteriser, so a run can be *looked at*
without a browser or a GPU. **Look at it.** Everything above is measurement, and
measurement cannot tell you a wolf's foreleg is bound to its chest.
`--preview <clip>` is the same check as an ASCII silhouette in the terminal.

The tool measures `clipSpeeds` off the finished clips exactly as `retarget`
does and prints them ready to paste (see [Gaits](#gaits)); a donor whose walk
is a 0.55 m/s amble and whose run is 5.3 m/s will skate by a factor of ten if
you skip that. Clip names are what the controller looks up, so rename on the
way through with `Out=Source` — `Idle=Idle_Alert` makes a donor's alert idle
land on the `idleClip` default.

Two things about the numbers it prints. They are measured **after** `--height`
scales the model, so a small creature's walk can fall under the 0.4 m/s floor
that separates locomotion from an idle shuffle and be silently left out of the
list — a rat at 0.5 m gets a `Run` and no `Walk`. Speeds are linear in the
scale, so bake once at some absurd `--height` to read them all and divide.

**Blockbench exports ASCII FBX, and three refuses it** — "Unknown format", or a
`TypeError` from deep inside the text parser. Neither is a problem with the
file: `isFbxFormatASCII` is a coincidence test that fails or passes depending on
how long the comment banner is, and the TextParser cannot represent the
top-level `FileId:`/`CreationTime:` lines every writer emits. `tools/_fbx.mjs`
hands the loader a copy it accepts, and both `autorig` and `retarget` go through
it, so a `.fbx` straight out of Blockbench just loads. Two things survive that
detour worth knowing about: the mesh's normals are dropped (three does not read
`ByVertex` mapping, which is what Blockbench writes) and get recomputed, which
is what a cube model wants anyway; and a texture the artist **pasted** into the
Blockbench project exports as `Material::pasted_N` pointing at a `Path` of
`"pasted"` with no extension, so nothing can resolve it. Blockbench does write
the image out beside the FBX at export time — pass it with `--texture`.

### The hitch at the top of every cycle

Exporters routinely write a cycle's keys starting at frame **one** — times
running 0.0333 … 0.4667 for a 14-frame gallop — and leave the clip's duration
at the last key. Nothing is wrong with the animation and it looks fine scrubbed,
but on a loop it is wrong twice. Nothing is keyed below the first key, so `t`
from 0 to one frame holds the opening pose: every cycle opens on a held frame,
which on a 14-frame run is 7% of the stride spent stopped, once per stride. And
the last key sits exactly at the duration, so the wrap back to the first happens
in no time at all rather than over a frame — a pop of one frame's motion. That
pair is a large share of what gets reported as "the run looks rough", and it was
in every clip the dog library ships.

`autorig` now slides the keys down so the first sits at zero and, for a cycle
whose ends are a frame apart, appends the opening pose one frame past the last
so the wrap has a frame to happen in. A cycle's duration comes out unchanged; a
one-shot just loses the dead frame at its head. `--loop-fix none` keeps the
donor's timing.

Three cases, not two, and the `loops:` line names which one each clip got:
**closed** (the last key is already a copy of the first — the other convention;
appending would re-add the hold), **open** (ends one frame apart — append), and
**once** (a one-shot; appending would snap a death animation back upright at the
end). The verdict is measured in units of the clip's *own* frames, because a
cycle's ends are a frame apart by construction and any absolute threshold calls
every fast gait a one-shot.

### Generating locomotion instead of borrowing it

Borrowing a donor's clips is a bargain for most of a creature. **Gait is where
it stops being one, because gait is anatomy.** A dog trots — diagonal pairs,
half a cycle apart — and gallops in a rotary sequence. A rat BOUNDS: both hind
feet leave and land together, the spine folding and snapping open to do most of
the work, the forefeet catching a stride later. Retiming a dog's Run never
produces that; the footfall *pattern* differs, not the timing of the same
pattern. It is the one part of a borrowed library you cannot patch on the way
through, the way `--dangle` patches a tail.

`--gait` generates the cycles instead. Pick a footfall pattern, put each foot on
a trajectory, let IK find the joint angles:

```
--gait "Idle=idle,Walk=walk,Run=bound"      # a rodent
--gait                                       # Idle, Walk, Run=gallop
```

Generated clips replace same-named donor ones and leave the rest alone, so the
usual shape is generated locomotion plus a borrowed Bite and Death. **Generate
the locomotion, borrow the performance** — a bite has intent in it, and intent
is not derivable from proportions.

**Everything but the pattern is derived from the animal.** Animals of different
sizes move alike at equal Froude number, v²/(g·h) with h the hip height — that
is why a mouse's scurry and an elephant's amble are the same gait, and why
scaling a dog's walk to rat size geometrically gives a rat that minces. Each
gait carries a Froude coefficient and its speed falls out of the hip height the
skeleton was actually fitted to; stride length comes from leg length the same
way. Nothing is retyped per creature.

That makes the depicted speed a *derived* quantity, and autorig's own clip-speed
check then measures it back off the finished clip — which is a real test, not a
formality. It immediately caught the one arithmetic error worth naming here: the
distance a foot travels backward during stance is **stride × duty**, not the
stride. The body covers a whole stride per cycle but the foot is only down for
part of it, so dragging it the full stride inflates the depicted speed by
1/duty — 1.5× on a walk, over 3× on a gallop. Generated and measured now agree
within about 10% (the rest is the reach clamp shortening some steps).

Two things that are deliberately NOT clever:

- **Bound versus gallop is not derived.** It ought to follow from shape —
  long-backed and short-legged animals bound — but it does not, measurably:
  trunk-between-the-hips over leg length is 0.35 for this rat and 0.36 for the
  wolf, because the fit puts leg roots in much the same relative place whatever
  the animal. Size is worse; it calls a dire rat a wolf. So `Run` defaults to
  gallop and a rodent says `Run=bound`. Don't put a threshold back without two
  animals it actually separates.
- **The legs are found structurally, not by name.** A leg is a chain ending near
  the ground whose root is the highest ancestor leading to exactly one such
  ending — which is the shoulder and the pelvis on any rig, because the bone
  above them is the one the other legs also hang from.

`--gait-seed` jitters stride, lift, duty, clearance and spine flex a few percent
per bake, so two mobs built from one mesh do not move identically.

### When the donor's anatomy doesn't transfer

Borrowing a library borrows an anatomy of motion along with it, and some of it
does not survive the trip. A dog **carries** its tail — short, muscular, held
up, keyed as deliberately as a limb. A rat's tail is long, limp and heavy: it
hangs, it drags, and it arrives wherever the body left it a moment ago. Playing
the dog's tail on the rat is wrong in every clip at once, in the same way,
because a carried tail is a pose and a hung tail is a consequence.

`--dangle` takes that chain off the keyframes and hangs it instead — a Verlet
rope pulled down by gravity, back toward the pose the rig carries, with the
ground as a floor. Bare, it finds the first bone matching `/tail/`; otherwise
name the chain roots. `--dangle-gravity` is weight, `--dangle-stiffness` is how
much the body still carries it (0 is a dead rope), `--dangle-damping` is the
lag. They are in chain-lengths, not metres, so they mean the same thing on a
rat and on a dragon.

The floor is most of what sells it. A rat's tail reaching the ground and
*staying* there is the read; an arc that ends in mid-air is a dog again.
`--dangle-floor none` turns it off for something that hangs off a ledge.

Two things to know:

- **It rewrites clips, never the rest pose** — the same rule the rest of the
  tool lives by. Everything is still measured against the donor's rest
  rotations; only the tracks change.
- **A cycle must be told apart from a one-shot**, and the tool does it by
  measuring the clip's first pose against its last *in units of one of its own
  frames* — not against zero. Cycles are conventionally authored so the last
  key is the frame before the repeat, so a fast gallop's ends are a whole
  stride-frame apart and any absolute threshold calls it a one-shot. Get this
  wrong and either a run cycle pops its tail every loop (read as a one-shot, so
  never settled across the seam) or a death animation opens with its tail
  already limp on the floor (read as a cycle, so its ending overwrote its
  beginning). The `cycles:` line prints the verdict and the seam it measured;
  that figure is what to look at when a tail misbehaves at a loop point.

Baked, not live, and that is a choice worth restating because `clothSway` in
the renderer argues the other way for cloth. Cloth has to answer to what the
player is doing this instant. A tail's motion is almost entirely a function of
the clip playing — a running rat's tail does the same thing every stride — so
solving it once costs nothing at runtime, on every client and on a headless
server with no renderer at all. What it cannot do is react to a turn the
animation does not contain; if that matters, this becomes the resting shape and
a live spring layers over it.

## Wiring it into a scene

A character is **two entities**: the physics body (rigidbody + collider +
`script`) and its model on a **child** entity (`mesh` + `animator`). This is not
a style choice — the sim owns a rigidbody's rotation and writes it back every
step, so the visual has to be separately steerable. Put the model's origin at
the feet and offset the child down by half the capsule height.

Scripts address animation by their own entity id, so the child registers itself
as the body's stand-in for animation lookups (`AnimationSystem`, first model
under a parent wins). That means `ctx.setAnimation` on the body reaches the
model on the child, and you don't have to think about it — but it is why a
*second* animated model under the same body will not be found.

## Gaits

`third-person-controller` crossfades an idle → walk → run → sprint ladder plus
an airborne clip. Two things about it are worth knowing:

- **The gait is chosen from measured velocity, not from the key held.** A
  character slowed by terrain, or driven by AI instead of input, still picks
  the clip matching how fast it is actually travelling. Thresholds sit midway
  between the `walkSpeed`/`speed`/`sprintSpeed` params, so retuning speeds
  retunes the transitions with them.
- **Every clip past idle and run is optional.** The controller asks the model
  what it shipped with (`ctx.animationClips`) and falls back to the run cycle
  rather than requesting a clip that isn't there and freezing mid-stride. A
  two-clip model behaves exactly as it did before the ladder existed.

- **Two different speeds decide two different things.** WHICH clip comes from
  the horizontal speed — the pace the character is travelling at. How fast it
  PLAYS comes from the distance actually covered, vertical included, because on
  a hillside the feet travel further than the horizontal speed says. Paying
  that out at the horizontal rate is skating downhill and mincing uphill.
- **A gait holds against flicker.** Thresholds carry a hysteresis band, and a
  gait that has just changed will not change BACK inside `gaitDwell`
  (speeding up is instant — that is the player's own input). Without both, a
  body hovering either side of a threshold, which is exactly what running along
  a hillside is, crossfades several times a second. That churn is most of what
  gets reported as "the animation is rough".

`syncClipSpeed` scales playback to the ground actually covered, which is what
stops feet skating between gaits — in-place clips are authored for one speed.
It's clamped, so a heavily slowed character reads as slow, not as slow motion.
Turn it off only for clips carrying their own root motion.

**Tell the controller what speed each clip was authored at.** This is the
single most common cause of a character that glides, and it is invisible from
the code: without `clipSpeeds`, a clip is assumed to be authored at whatever
speed its gait happens to be tuned to, and every unit of difference between the
two is skating feet. The clips are not all near each other either — the library
this pipeline was built for authors its walk at **1.0 m/s** and its run at
**6.0**, so a walk gait tuned to a game-feel 2 m/s skates by a factor of two
while the run looks fine. `retarget` measures each baked clip (a planted foot
slides backwards under the hip at exactly the speed the clip depicts) and
prints the numbers ready to paste.

**How a clip's speed is measured, and why the number may have moved.** In
`autorig` — `retarget` still uses the older fixed line, deliberately, because a
biped's feet reach the ground in every gait and changing it would move numbers
already tuned against — a foot is treated as planted at the bottom of *its own*
arc in *that* clip: its lowest sample plus 6% of body height. A gallop
lifts the whole animal (this dog's Run carries its hips a fifth of a
body-height higher than its Walk), so against a fixed line a running quadruped's
feet never touch and the clip cannot be measured at all. It is also why a
dangled chain is excluded from the foot set: a tail tip lying on the floor is a
ground-level leaf bone, and letting it vote replaces a stride measurement with
a tail measurement — which is exactly what happened to this rat's Run, silently,
until the tail was taken off the keyframes.

Restricting to true stance also raises the numbers slightly, because samples
taken while a foot is still descending carry less slip than the ground speed.
The dog library re-measures at **Walk 0.75 / Run 5.44** where the older method
read 0.55 / 5.26. Anything baked before this — the wolves — carries the old
figures in its scene's `clipSpeeds` and is walking about 25% slower than its
clip depicts. Re-bake or re-tune when convenient; it is a gliding walk, not a
broken one.

## Travelling one way while facing another

Backing up and strafing need their own clips; a forward run cycle played while
sliding sideways *is* skating, and no playback rate fixes it. `backClip` /
`leftClip` / `rightClip` cover it, and like every other clip they're optional.

They are consulted only where the facing is deliberately independent of travel
— camera-facing mode, or a backpedal. In movement-facing mode the character
turns to face where it runs, so travel and facing disagree by up to 180° for
the first few frames of every move; reading a heading off that flickers the
back clip at the start of each run. For the same reason the heading is measured
against the facing the character is turning *toward*, not its current
interpolated yaw.

`backpedal` (on by default) is the other half: pressing back keeps the
character facing forward and plays the back clip, rather than spinning it round
to sprint at the camera. Turn it off for the soulslike feel where the character
always turns to face its movement.

## Layers: casting while running

A character plays **one base clip** — crossfaded, Unity-style — plus **one
masked layer** over it. The layer is what lets a caster keep running while it
casts: the clip is restricted to a bone subtree (the upper body by default) and
the gait keeps everything else.

```ts
ctx.setAnimationLayer("Cast_Fire", { fade: 0.08, loop: true });
// … later, or when the action's window ends
ctx.clearAnimationLayer(0.15);
```

`third-person-controller` already does this for you. The `actionClip` /
`actionUntil` channel it has always read now rides on a layer while the
character is moving and takes the whole body when it is standing still —
`actionBlend` (`auto` / `layer` / `full`) sets the policy, and a script can
force one action full-body with `userData.actionFullBody` (a dodge roll is not
an upper-body affair). **The choice is made once, when the action starts**, so a
cast does not flip between layered and full-body as you cross the walk
threshold mid-animation.

**Where the split lands.** The mask defaults to the rig's shallowest
spine/waist/chest bone — the first joint above the hips, which is the split
every game uses and the one every rig `retarget` produces has. Override it per
character with the animator's `upperBody`, or per call with `mask`. A rig with
no matching bone falls back to a plain full-body play and says so in the
console: better a cast that stops the legs than a cast nobody sees.

**Why the base clip is re-masked underneath.** Three's mixer *averages* every
action that touches a binding, weighted. Two full-body actions at weight 1 give
you a pose half-way between the run and the cast, not a layered one — a
character casting while doing a strange half-crouch. So an override layer
re-plays the base clip masked to the complement of what the layer actually
drives (its playhead carried across, or the legs pop back to frame 0), leaving
exactly one driver per bone. The complement is measured against the layer
clip's **tracks**, not against the mask, so a bone the mask covers but the clip
never animates still gets its motion from the gait instead of freezing.

**Additive layers** (`additive: true`) skip all of that: they accumulate on top
of the base pose rather than replacing it, which is what aim offsets, leans and
small hit reactions want. `weight` is meaningful there — it is how much of the
offset to apply.

Three things to know before you reach for this:

- **A layered clip loses whatever it did below the mask.** A cast animation
  authored with a big lunge is, layered, a cast with a run underneath. That is
  usually the point; when it isn't, that clip wants `actionFullBody`.
- **A one-shot layer holds its last pose until it is cleared.** `loop: false`
  clamps at the end and raises `animation.completed` (under the name you asked
  for, not the derived masked clip's). Nothing clears it for you.
- **Playback rate is the base clip's alone.** `setAnimationSpeed` — the
  foot-skate cure — scales the gait only, so a cast layered over a sprint plays
  at its authored speed rather than at sprint rate. The layer carries its own
  rate instead (`speed` on `setAnimationLayer`), which is what fits a cast to
  its cast time.

## An action lasts as long as it was told to

`actionClip` comes with `actionUntil`, and the two rarely agree: a cast that
runs three seconds animated by a clip that runs one. Repeating the clip three
times is the most obvious tell there is that an animation was bolted onto a
timer, so the controller **fits the clip to the window** — one slow cast rather
than three quick ones, and a clip longer than its window speeds up to land on
time. `ctx.animationDuration(clip)` is where the length comes from.

Two limits keep it honest. Past `ACTION_RATE_MIN` the clip loops after all (a
two-second pose spread over thirty seconds is not slow, it is stopped), and a
clip nobody can measure — a model still loading, a headless host with no mixer
— keeps the old looping behaviour rather than guessing. `fitActionClip: false`
turns the whole thing off.

The same fit applies to a **frozen** body's held clip, which is how a death
animation stops playing twice.

A one-shot played a second time needs `restart`: the clip is already the
current one, clamped on its last frame, so a plain re-play is a no-op that
reads as a character frozen mid-swing. The controller passes it on every action
start; a script driving `ctx.setAnimation` itself has to say so.

The layer replicates alongside the base clip (`animL` in the entity snapshot,
and the dedicated server applies the same moving/standing rule to player
bodies), so other clients see the cast over the run, not one or the other.

## Free-hanging cloth

A tabard, tassets or a cloak get secondary motion from the `clothSway`
component, put on the entity carrying the model. It is a vertex-shader lag, not
simulated bones: one spring integrated per character and one uniform uploaded,
with the displacement riding along in a vertex shader that was already running.
A crowd costs what one character costs. The trade is real — cloth flows, it does
not drape, and it never collides with the legs. Bones are the answer when you
need a cloak to catch on a shoulder.

**Which geometry moves is worked out from shape, and it has to be.** The two
obvious tests both fail on a real character:

- *Height* — everything below the belt — catches the legs, and swaying a
  character's shins is instantly worse than doing nothing.
- *Skin weights* — "bound to the hip, not the legs" — fails because an
  auto-rigger routinely binds a skirt **to the thigh bones**. Measured on the
  character this was built for, leg vertices hung further below their driving
  bone than skirt vertices did below theirs, so no threshold separates them.

What does separate them is that a hanging panel is a connected island of
geometry which is thin, hangs a long way, and attaches around the waist. A limb
is none of those. So selection runs on connected components, needing no naming
convention, no material split and nothing authored into the model. The four
`panel*` fields are that test as fractions of body height; when nothing is
found the warning prints every island's measured numbers next to the thresholds,
so widening the right one is a reading rather than a guess.

One trap worth stating outright: **do not size this off `Box3.setFromObject`.**
On a skinned mesh it goes through skinning-aware bounds, which on a real
character rig came back mis-scaled *and* offset by tens of metres — every
island's attach height measured as -101. Bounds here are built from each mesh's
own geometry box instead.

## The grounded check is not "is vertical speed zero"

A resting dynamic body never has a vertical velocity of zero. Gravity moves it
about 0.16 m/s in a single 60Hz tick, and contact resolution leaves more, so
`Math.abs(vy) < 0.05` reads **airborne on almost every frame**.

That was survivable while the test only gated the jump key — you occasionally
miss a jump and shrug. The moment it also picks the clip, the character plays a
falling pose permanently: legs tucked, feet still, sliding along the ground.
Which is indistinguishable, to anyone reporting it, from "the animation is
gliding and it isn't the walk cycle".

So grounded is decided from *sustained* evidence — vertical speed past a
threshold, held for longer than `coyoteTime` — and the same window doubles as
the grace period that lets a jump register just after walking off a ledge.

## Slopes

A slope is that same bug wearing a hat, and it is the most common report about
character animation there is. Three things go wrong on a hillside and each has
its own fix.

**A fixed fall threshold cannot tell a descent from a drop.** Running at 6 m/s
down a 30° slope, the body descends at 3.5 m/s with its feet planted the whole
way — well past any `fallSpeed` low enough to catch a real fall. So the
allowance GROWS with travel speed: `slopeTolerance` is the steepest descent
still counted as ground, as a ratio (0.8 ≈ 39°, about as steep as a body
walks). If a character running downhill plays the falling clip, that param is
the first place to look, not `fallSpeed`.

**Velocity alone is guessing; a ray knows.** `groundProbe` casts one downward
ray every so often (0.05s by default; 0 turns it off) and settles the question
outright — and the same hit carries the surface NORMAL, so the two slope
problems are one query rather than two. The resting distance is *measured*, not
derived from the collider: the ray starts at the body's origin, which sits at a
different height above the feet for every capsule, offset and model, so the
first probe taken while the velocity heuristic is confident records it and
everything after is a comparison against that. It costs one query per character
per interval — raise the interval for a crowd, and everything degrades to the
velocity path when there is no `raycast` to call.

**A character standing bolt upright on a hillside is wrong even when its clips
are right.** `slopeAlign` leans the body onto the ground normal, capped by
`slopeAlignMax` and smoothed, because a ray is a step function and a body is
not. It deliberately does not go all the way: full alignment reads as a toy on
a ramp. Feet still do not land on the ground individually — that is IK, which
this engine does not have yet.

### The one that is not an animation bug at all

A body driven by `setLinvel` travels in a **straight line**, so every convex
break in the ground throws it off. At the crest of a hill it keeps going
straight while the ground drops away, and it is genuinely airborne until
gravity catches up. Measured on a 25° ramp at 6.5 m/s: half a second of real
air at the crest, and half a second of the falling clip with it. On terrain
that merely rolls, that is a character permanently half in the air — which is
reported, every time, as "he glides on slopes". **No clip-picking rule can fix
it, because the character really is flying.**

So the controller **follows the ground**: within `groundStick` metres of the
surface it writes the vertical rate that keeps a body on a plane of that
normal, capped by the slope it is allowed to walk. Downhill it stays in
contact; uphill it climbs the slope instead of grinding into it; past the gap,
a real drop still falls. This is what a kinematic character controller's
`snapToGround` does, done for a dynamic body.

Two rules keep it from eating things it should not. A jump owns the body for
its grace window, and a rise is only cancelled if **this** wrote it last tick —
otherwise a knockback or a launch pad would be quietly deleted. That second
rule is also why running uphill does not read as airborne: the rise is the
ground, climbed, not a body leaving it.

The **dedicated server runs the same function on player bodies**. It has to: a
client predicting the ground while the authority arcs over it is worse than
either alone, since every slope becomes a fight the authority wins by yanking
the player back.

## Jumps, landings and turning on the spot

Every one of these is an optional clip: a model that shipped without them
behaves exactly as it did before they existed.

- `jumpClip` is the push-off, played once as the body leaves the ground before
  `airClip` loops. A jump that opens on its airborne pose has no weight.
- `landClip` is the touchdown, played once after a fall longer than
  `landDrop`. It is skipped at speed on purpose: a character landing mid-run
  should flow back into the run, and stopping to absorb it reads as a stumble.
- `turnLeftClip` / `turnRightClip` cover the pivot. In camera-facing mode the
  character turns whenever the camera does, and an idle clip played through
  that pivot is a statue on a turntable. They start above `turnClipSpeed`
  radians per second and hold down to a much slower one, so a turn that eases
  off does not flicker back to idle halfway through.

## The same arithmetic, everywhere

Gait thresholds, the fall allowance, playback rates and the action fit live in
`@hitreg/scripting/locomotion` as pure functions, and BOTH callers use them:
the controller running on a body you can see, and the dedicated server picking
the clip every other client shows for a remote player. When those two disagree
you get a body that walks on your screen and runs on everybody else's.

Replication carries more than the clip name for the same reason. `anim` and
`animL` (base and layer) are joined by `animR`, the playback rate — without it
every remote body plays its walk cycle at the authored speed whatever pace it
is really travelling at, which is foot-skate by construction — and `animD`,
how much of a one-shot action's window is left, because only the client knows
how long the clip is and therefore only the client can fit it.
