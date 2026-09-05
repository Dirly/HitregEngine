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

So grounded is decided from *sustained* evidence — vertical speed beyond
`fallSpeed`, held for longer than `coyoteTime` — and the same window doubles as
the grace period that lets a jump register just after walking off a ledge. A
downward raycast is firmer still, but it costs a query per character per tick
and this costs nothing. If a character on a steep slope starts playing the fall
clip, raise `fallSpeed` before anything else.
