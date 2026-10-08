# Character animation

Judgment and pitfalls for getting an animated humanoid into a scene. Field
lists live in the spec (`animator` component, `third-person-controller`
params) — read those for exact names, and this for what will silently go
wrong.

Distance-based pose evaluation is opt-in on `animator` (see the generated spec).
Use it for background residents: stable looping poses can update less often
while their playback clock continues. Keep combat layers, one-shots and transitions
at full rate so completion events and contact timing retain their existing behavior.
The runtime does this automatically for opted-in models, and protects the followed
character. Hosts pass the camera and followed entity to `AnimationSystem.update`;
hosts that omit camera context retain full-rate evaluation. Physics and AI updates
are independent of the pose schedule.

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

**Libraries stack.** `--anim` may be repeated (or comma-joined) for packs that
share a rig — an expansion is baked *beside* the base, not instead of it, and a
later file wins a name collision. Packs on one rig share that rig's first
file's skeleton; packs on a different rig get their own (see *Libraries on
different rigs* below). The human in this repo is the two Quaternius universal
libraries plus Mixamo's weapon packs, one folder per pack:

```
pnpm -F playground retarget \
  --mesh HumanRigged.fbx --anim UAL1.fbx --anim UAL2.fbx \
  --anim mixamo/swordshield --anim mixamo/greatsword --anim mixamo/torch --anim mixamo/staff \
  --clips locomotion+combat+ual2+weapons \
  --out projects/<game>/assets/models/mmo/human.glb
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

**Aim only where the rests differ in POSE, not where the riggers differ in
JOINTS.** Aiming a bone rotates it until it points along its source bone. For a T-pose arm against an A-pose arm
that is the point. For a torso it is wrong. Riggers disagree about where the
joints go: the UE mannequin's clavicle starts at the sternum and runs 38° back
to the shoulder, while AccuRig's starts beside the spine and runs out. AccuRig's
neck joint also sits behind the head joint, leaning 28° to the mannequin's 11°.
Aimed, the human's shoulders swept ~50° back (glenohumeral 3-4% of height
behind the hips in every clip) and its face tipped 17° up. Derek called it
"stretched-back shoulders and a bird neck". The map's `keepBind` list (the spine
above the hip, the neck, the head and the clavicles) leaves those bones at bind:
both rigs stand neutral there, and the source's world deltas apply on top.
Hands came out too: palm roll against the source went from 10.5° to 3.4°,
because the upperarm no longer inherits the swung clavicle. The hip stays aimed
(0.9°), so the legs and every `clipSpeeds`/`clipFootfalls`/`clipAdvance` number
are unchanged. Check a new rig pair with anatomical landmarks the two rigs
share: skull base (head joint) against the glenohumeral joints (upperarms)
against the hip, plus face pitch. Joint-to-joint directions mislead here,
because they differ by convention. `--keep-bind none` reproduces the old bake.

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

### Libraries on different rigs, and one-clip downloads

`--anim` takes libraries on **different** skeletons in one run — the UE
mannequin libraries and Mixamo downloads bake side by side. Each file's rig is
detected from its bone names (`detectRigMap` in rig-map.mjs), every rig gets
its own rest reconciliation, and each clip is measured against the rest pose it
was authored from. A **folder** stands for every `.fbx` directly inside it,
which is how Mixamo arrives: one clip per file, every clip named `mixamo.com`.
A file holding one such generic clip names it after the file
(`great sword slash (3)`).

A clip selector may carry modifiers: `Source@mirror` plays it with the other
hand (a left-handed torch swing becomes a right-handed staff swing — reflected
through the body's measured left-right axis, left and right bones swapped), and
`Source@0.4-1.6` trims to those seconds of the source. Trim attacks so the hit
lands about half-way through: the caster fits an attack clip to its windup +
recovery, and the hit happens at the end of the windup.

Four things that went wrong silently on the way, all fixed, all worth knowing:

- **Root motion is stripped by default.** A Mixamo download not ticked "in
  place" carries the hips metres forward; the controller already moves the body,
  so that is double movement and a snap back at the loop. The horizontal drift
  start→end is removed linearly, which keeps a cycle's sway and a lunge's weight
  shift. The bake lists every clip that travelled — a one-shot that lunged 5 m
  will skate played in place; trim it or pick another. `--keep-root` opts out.
- **A skinned Mixamo character file ("X Bot") loads with a duplicate
  `mixamorigHips`** nested under the first. Used as the reference skeleton, the
  mixer animated one copy while the bake read the other and every clip lost its
  hip travel. Files with duplicate bone names are never picked as a rig's
  reference; the skinless animation files share its true T-pose rest anyway.
- **Source clips are sampled as clamped one-shots.** On the default repeat the
  sample at `t = duration` wraps to 0, so every bake used to END ON A COPY OF
  ITS FIRST FRAME: invisible on a cycle, a death clip that stands back up.
  Cycles are then closed the way `autorig` closes them (see *The hitch at the
  top of every cycle*), judged on the baked clip after root motion is gone; the
  bake prints how many were open, closed and one-shots.
- **About one Mixamo download in five would not load** ("Unknown property
  type"). The file is fine: three finds where binary FBX node data ends by
  guessing the footer's size from the file length. `_fbx.mjs` walks the
  top-level records to the real end instead.

### Weapon stances

A character plays `<Stance>_<clip>` wherever its model has one, in place of
`<clip>` — `GreatSword_Run` for `Run`, `Staff_Attack2` for `Attack2`,
`SwordShield_Death` for `Death` — locomotion and actions alike, so a combat
script asks for "Attack1" or "Block" without knowing what is held. The stance
list lives in the body's `userData.stance`, most specific first, and the
`weapon-stance` builtin fills it from the held items' `stance` field: an
off-hand stance is a suffix on each main-hand stance, so a sword with a shield
is `["SwordShield", "Sword"]`. A bake therefore only needs the clips that
DIFFER: a greataxe (`["Axe2H", "TwoHanded"]`) is a few axe attacks over the
shared two-handed set, and anything no stance has falls to the plain clip. The
`weapons` preset in rig-map.mjs is the current set; `/stance GreatSword,TwoHanded`
previews one without the item (on the local player's `weapon-stance`, `console: true`).

**A weapon changes how a character FIGHTS, not how it walks.** Actions are
always the stance's, but idle, walk, run and turns take the stance's clips only
while `userData.combatUntil` is in the future (`stanceGaits: "combat"`, the
default; `always` / `never` exist). Out of a fight the character stands and
moves on the plain library with the weapon simply carried. That was Derek's
call after seeing a shield-up run and a guarded idle all the time: it read as
a different, stiffer character. The game sets `combatUntil` a few seconds past
every swing, block and hit.

**Even in a fight, the legs are the plain gait's (`stanceCarry: "upper"`, the
default).** A two-handed library's own run is a different run: shorter stride,
sunk hips, its own cadence. Next to the plain jog every one-hander uses, Derek
found it "reaaaally bad". So in walk, run, sprint, strafe and backpedal the base
clip is always the plain one (`Run`, `Run_Left` …, paced by ITS `clipSpeeds`),
and the stance rides the upper-body layer:

- **The stance's own clip for the gait** (`TwoHanded_Run` over `Run`) is
  phase-locked to the legs. The layer is held at the base's normalised phase
  plus an offset every frame and paced to it (`phaseLock` on
  `setAnimationLayer`, `AnimationSystem.lockLayer`), so the arms swing with the
  stride at any rate. The offset lines up the two clips' LEFT-foot contacts
  from `clipFootfalls` (`carryPhaseOffset`). That is why the order in those
  lists matters (see *Footsteps*): `Run`'s first contact is the left foot and
  `TwoHanded_Run`'s the right, so aligning first contacts put the arms half a
  stride out.
- **No clip for the gait**, for a stance listed in `stanceCarryHold` (default
  `SwordShield`, `Shield`): the stance's idle upper body is held as a carry
  pose, so a shield rides up while walking instead of swinging at the side.
- **Neither** (a one-handed `Sword`): nothing rides over the gait. The plain
  jog keeps its own arm swing, which is the jog Derek asked the others to match.

Idle and turns stay the stance's full-body clips. The carry follows
`stanceGaits`: out of combat nothing is carried. `stanceCarry: "full"`
restores the whole-body stance gait per controller. An
upper-body ACTION owns the layer while it runs (see *Layers*); the carry fades
back over it (0.2 s) when it ends. So blocking while walking is plain `Walk`
legs under `SwordShield_Block`, and letting go returns to the carried shield
without the arms dropping in between.

**The layer's torso sits on the layer clip's hips, not the gait's** (a
mesh-space blend, `Anchor` in `packages/render/src/animation.ts`). Stance idles
stand BLADED: `SwordShield_Idle` turns the hips −54° and twists the spine and
neck back so the chest, shield and eyes face forward. Masked naively, that
counter-twist lands on the walk's square hips and the shield and head point
~40° (guard: ~60°) off to the side while moving. Every frame, after the mixer,
the spine chain (Waist → Spine01 → Spine02, the turn shared between them) is
turned by the difference between the live hips and the clip's own, so the
upper body keeps its standing-stance orientation relative to the character.
It applies to every override layer (casts over a run too) and eases out with
the layer's fade.

A held pose — a raised guard — sets `actionHold` beside `actionClip`, and the
controller plays it ONCE at its authored pace and holds its last frame for as
long as the guard is up, instead of fitting it to the window (a block is a
raise-and-hold clip; looped, the shield re-raised every 1.4 s). A pose meant to
REPEAT — a channel, a cast loop — sets `actionLoop` instead: looped at its
authored pace, never fitted. It also sets `actionUpperBody`: a guard is ARMS, and one raised standing still
would otherwise take the whole body for as long as it is held, so the
character slides rather than walks when it moves behind the shield.

**A shield can have two poses** (off for the MMO player: Derek places one pose and wants it to hold in every state — a second pose that took over in every fight read as "my placement doesn't stick"). Carried, it hangs flat against the outside of the
forearm; in every guard clip in these libraries it is held like a centre-grip
shield, square to a forearm pushed forward. No single socket is right for both
— upright at the side sticks out like a plank in a guard, face-forward lies
like a tray while walking. `bone-socket` takes a second pose (`altBone`,
`altOffset`, `altRotationDeg`) eased in while `altWhen` holds (a userData key on
the character — `combatUntil` for the shield); `fit-grip --grip center --bone
<Hand> --as alt --when combatUntil` computes it, and `pose-sheet --alt` shows it.

**A swing faces forward.** The Mixamo weapon packs cut their attacks out of
spinning sequences: `Sword_Attack3` opened with the chest 160° from forward,
`SwordShield_Attack3` turned 250°, `GreatSword_Attack3` 300°, `Axe2H_Heavy`
nearly 600°. Standing, that is a pirouette on the spot; moving, the swing rides
the upper-body layer with its torso anchored to the clip's own hips, so the
torso spins over legs that keep walking. Derek: "some swings make the torso do
a 360 which looks very very odd … especially while moving". A selector's
`@yaw60` keeps the chest within 60° of forward by turning the HIP about world
up, per key: a spin (the chest ends 150°+ from where it started) becomes a
sweep across ±36° in the same direction, paced by the original's progress; any
other turn is soft-clamped (untouched up to 60% of the limit). The arms keep
what they do relative to the chest, so the blade path is the clip's own minus
the pirouette. The rig-map `weapons` preset carries it on every swing that
turned past the limit, and consecutive combo steps now hand over near the same
facing (one sweep ends where the next begins) instead of snapping 130°.

A held GUARD squares up instead: `@yaw10@arms` on `TwoHanded_Block` /
`_Block_Hit` turns the chest to face forward while the clavicles take half the
counter-turn and the upper arms the rest, so the blade stays where the parry
put it and the SHOULDERS do the reaching; the neck keeps its facing, or the
head would inherit the turn and look 30° off to the side. (Derek on the
two-handed parry: "the torso doesnt twist to go into position and its moreso
the shoulders".) Stance idles that stand bladed on purpose (`SwordShield_Idle`,
`SwordShield_Block`) are left alone.

`tools/clip-yaw.mjs <glb>` reports every clip's chest yaw (lo, hi, net, and
chest-vs-hips twist; SPIN flags). `--preset combat+weapons --write` applies the
preset's `@yaw` modifiers to an existing GLB by rewriting only those bones'
rotation keys in the binary chunk, so nothing else in the file changes; a
re-bake applies them itself. The MMO player draws `human-body.glb`, which
carries its OWN copy of the clips (reskin copies them): patch it as well as
`human.glb`.

**Look at a bake with the weapons in hand before shipping it.**
`tools/pose-sheet.mjs` renders clips as a contact sheet — one row per clip per
view, one column per sampled frame — with the scene's own sockets and the
equipped items' parts, so what it shows is what the game will draw.
`--override` tries socket params without touching the scene, `--zoom <bone>`
crops to a hand. A clip named `Legs+Upper` (`Run+TwoHanded_Run`,
`Walk+SwordShield_Idle`) draws a stance carry: the first clip below
`CC_Base_Waist`, the second from it up, locked by the doc's `clipFootfalls`
(`@0.25` forces the offset). (Its renderer, `_softrender.mjs`, draws mirror images; the
sheet flips them back. Anything else using it for handedness must too.)

**Fit a socket; don't nudge it.** `tools/fit-grip.mjs` computes a
`bone-socket`'s offset and rotation from the hand's anatomy — palm centre from
the vertices skinned to the hand, thumb side from the index knuckle, palm side
from which way the index curls in a fist clip — and the item's own shape
(handle centroid, handle→blade axis, the blade's thin direction). A handle
leaves the fist over the thumb, its flat to the palm (`--tilt -35` tips it up
with the arm hanging — how Derek wants a carried sword); a shield rides the
forearm, face out from the back of the hand (`--lean 20` stands it upright at
the side). Six numbers tuned against one
pose are wrong the moment the wrist turns; this frame is right in every pose.
`--write` applies them as an ops batch. Neither tool can close fingers the rig
does not have: a character exported with only index and thumb holds everything
in a mitten.

**Placing one by hand.** Held items resolve in EDIT mode too: the editor
stands every character in the first frame of its idle
(`AnimationSystem.poseStill`) and does the socket's sums itself
(apps/playground/src/socket-preview.ts, the math in @hitreg/render
`socket-pose`), showing the item the character starts with equipped — or, while
a slot is selected, the first starting item that fits it. So: open the
character's prefab (in voxel-demo, the **Player rig** scene → select `player` →
Edit prefab), select a weapon slot, and move it:

- The gizmo on a held item writes the SOCKET (`offset`/`rotationDeg` in the
  bone's axes, or the alt pose if that is what is showing), never a transform
  the socket would override. Grid snap does not apply to held items.
- **X** toggles world/local gizmo axes; local on a held item is the bone's frame.
- **Shift** while dragging moves a tenth as far.
- A held item's gizmo pivots on its GRIP (the part named handle/haft/grip/shaft,
  else its centre — `MovingInstanceSystem.gripOf`), not its model origin: a
  Blockbench export's origin is wherever the modeller left it (the greataxe's
  sits 0.84 m from its haft). Local axes on a held item are the item's own.
- Inspector edits during play or pause are patched into the running script
  (`ScriptRuntime.updateParams` / `Script.onParamsChanged`) without restarting
  the session; the socket re-poses at once, paused or not.

Sockets re-seat after each frame's animation (`Script.onLateUpdate`), not only on the fixed tick, so an item never trails a moving arm by a frame. Edits save (the editor autosaves; a prefab edit saves to the prefab file and
every scene using it picks it up). Editing a character that is NOT a prefab
works the same in its own scene.

**Holstering.** `weapon-stance` with a `holsterKey` (G on the MMO player)
sheathes and draws. The state replicates (`holster/<actor>`, written by the
authority on a `stance.holster` request from the body's owner) and shows as
`userData.holstered`, which every weapon slot's `bone-socket` takes as its
`altWhen`: the second pose is the BACK slot (`altBone` a spine bone). A
`Sheathe`/`Draw` clip plays on the arms, and the weapons change slot
`swapDelay` seconds in, when the hand reaches the back. A NEW fight after
holstering (anything that pushes `combatUntil` later — a swing, a block, a
hit) draws on its own; one still lingering when G went down does not.
Place the back slots in the editor with the toolbar's **holstered** toggle on:
every weapon shows in its back slot and the gizmo writes that pose.
`fit-grip --grip back --bone CC_Base_Spine02 --as alt --when holstered`
computes starting points (`--head-up` for axes, staves and maces). Derek's rule: greatswords, greataxes, great hammers, staves, bows, crossbows and shields go on the BACK (`--grip back`, `--head-up` for hafted heads); one-handers (sword, mace, wand, dagger, axe) go on the hip by HAND — the main hand's on the LEFT hip, the off hand's on the RIGHT (`--grip hip --bone CC_Base_Hip`, `--right`), each drawn across the body. Every one-hander has a slot in each hand (the off-hand ones watch the `offhand` equipment slot), and one-handed items list `offhand` among their slots. The grip tool reads each hand's palm from a clip where THAT hand makes a fist — `Sword_Idle` leaves the left hand open, so the left defaults to `SwordShield_Idle`.

**Every weapon kind has its own slot.** `tools/placeholder-weapons.mjs` writes
stand-in models (greatsword, staff, bow, crossbow, axe, mace, dagger) in one
known frame — grip at the origin, +Y up the weapon, +Z the thin side — with
part names unique per model, so a slot per kind can watch the same hand and only
the one drawing the equipped item's model shows it (`equipment-look` hides a
look for another model). `fit-grip --model-frame` fits them without measuring.
Replace a placeholder by pointing its slot's mesh at the real model.

## A remodelled body on the same rig: `reskin`

When the modeller reworks a rigged character — cuts the body into switchable
pieces, adds a robe — re-rigging it with an auto-rigger means a new skeleton:
new rolls and rest pose, so every retargeted clip, fitted grip and socket would
be redone (and AccuRig's spine placement is what went wrong the first time).
`tools/reskin.mjs` keeps the rig instead. Each new vertex takes the weights of
the closest point on the OLD skinned surface, blended across that triangle, and
the rig GLB is edited surgically: the primitive's accessors are replaced, the
clips and every extra stay byte for byte.

```
node tools/reskin.mjs --rig projects/voxel-demo/assets/models/mmo/human.glb \
  --in <HumanBase.obj> --parts <body pieces> --mirror <one-sided pieces> \
  --bind TassetFront=CC_Base_Pelvis --bind TassetBack=CC_Base_Pelvis \
  --bind ChestHalo=CC_Base_Spine02 --texture <atlas.png> \
  --out projects/voxel-demo/assets/models/mmo/human-body.glb
```

- The output is a skinned UBERMESH: part index in TEXCOORD_1, `parts` in the
  mesh node's extras, so a character shows chest, trousers, robe and tassets by
  part mask on one draw.
- It prints how far each part sat from the old surface. Under ~0.3% of body
  height is the same body; a part far from everything took the wrong weights.
- `--mirror` builds the other side of a piece modelled once (an arm, a foot),
  sharing its UVs. `--bind` pins a piece to one bone: a back plate to the spine;
  a tasset to the PELVIS, never the thighs. The auto-rigger bound tassets to the
  thighs, which is what warped them. Pinned, they hang, and `clothSway` gives
  them their swing (they still do not collide with a thigh in a full stride).
  An open robe keeps its copied weights and moves with the legs.
- `--theme <sheetId>=<atlas.png>` (repeated) packs every outfit's sheet onto
  one page and writes the `tiles` table, like `weapon-page`; the first theme is
  the default look (KHR_texture_transform). An outfit is then a tile plus a
  part list, and every body is still one draw. `--rules` bakes a part-rules
  table (`tools/atlas/sets/human-body/rules.json`).
- A second body on the same rig goes in the SAME mesh. The female is the male
  at 0.96 (measured: chest, hips, hands and feet all 0.95-0.96), so
  `--grow 1.041667:<her parts>` stores her pieces at male size: they fit the
  one skeleton, take the male surface's weights (within ~2% of it; the bust
  and belt are the furthest), and her UVs share every outfit sheet. A female
  character is the whole model at 0.96 (the creation `sex` option's `scale`),
  which brings her head and shoulders down with the bones. `--repeat
  Name=F_Name,Name` names her accessories, which share their names with his.
- The material masks at alpha 0.5 and draws both faces: the robe's frayed hem
  and the back ornament's open ring are authored in the sheet's alpha. Check a
  theme's alpha at the body's real UVs before shipping it: several armor sheets
  left holes in the boots, which only show once alpha is honoured.

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

**Hit reactions are generated too, on every autorig bake** (no donor we use has
one: the dog has no hit clip). `Hit` (0.4 s) and `Hit_Heavy` (0.9 s) are the
Idle's pose, frame by frame, struck from the front: the hip recoils back and
down and pitches nose-up, the trunk (spine up to the bone the forelegs hang
from) takes most of that pitch back and twists, the neck (spine past it) and
the bone called `Head` jerk back and up a beat later, the left forepaw lifts
(heavy: steps back and up again, the right one braces out, a sideways sway and
a head shake), and every foot is put back where the Idle had it by damped CCD
(the leg's root bone — shoulder, pelvis — is left alone, so a welded chest
holds: the wolf's chest box measures x1.45 / x1.56, under its Run's x2.54).
Rotations are applied in WORLD axes, since the donor's bone frames are its own.
The skull is `Head` by name, never the path's last bone: the dog's `Nose` is a
`--skip` bone left at the donor's position, and turning it swings the snout
about a point outside the head. Made before `--dangle`, so a hung tail swings
through them; left out of the clip-speed measurement (`--hits none` skips them,
`--hit-scale f | Hit=f,Hit_Heavy=f` tones a stiff neck down).

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

### Feet on the floor, heads that hold, deaths that fall (2026-10-06)

Derek's review of the dog-donor mammals — the pig's ears bouncing and
stretching the top of its head, the rhino and bison half in the ground, the
lions and the bear "so bad" — traced to a handful of general faults, all fixed
in `autorig` itself rather than per animal:

- **Ears and the snout rode an unfitted bone.** The dog's `Ear_*` and
  `Headtip` are children of its `Nose`, which the jaw skip left at the
  DONOR's position, outside the target's head. Ear bones then took the top of
  the skull (220 of the pig's head vertices) and `Headtip` the snout, all
  swinging about that outside point. Now: `Ear*` bones are skipped like the
  jaw (`--keep-ears` to allow a mesh with separate flopping ears), anything
  parented under a skipped bone is skipped too, and a skipped bone inside the
  body is still *fitted* — only a top-level anchor (`root`) stays put. Ears
  modelled into the head ride `Head`; a separate ear piece is `--bind`'d.
- **The fit pose bent the knees.** Every mesh is modelled standing on straight
  legs; fitted in a walk's average (knees bent) every leg came out too long,
  and every clip that straightened one drove the foot through the floor — the
  rhino's Idle 53 cm deep, the lion's 29. The default reference is now the
  IDLE's average for the legs and trunk, with the neck, head and tail taking
  their *world* rotation from the walk's average (an alert idle holds the head
  high and the tail up; a level-modelled head bound to that plays star-gazing).
  The symmetry pass now centres any bone *named* for the midline (spine, neck,
  head, tail) however far the idle swung it.
- **Grounding pass, every clip** (`--ground-fix none` to skip). Re-sampled at
  30 fps (60 for a cycle under 1.2 s), frame by frame: each foot's SOLE (the
  rest-floor vertices on that leg) is given the height the donor's same foot
  has above its floor, scaled by leg length; the hips move by the mean error;
  each leg is solved to its height by IK of the bones above the ankle (the
  ankle and foot keep the clip's world orientation, no joint turning more than
  20° from the clip — a sitting thigh carries rump flesh); anything still under
  the floor lifts the body. Generated clips keep their own arcs and are offset
  so each foot's lowest point is the floor; hits and attacks put planted feet
  on the floor and leave a lifted paw lifted; a Death matches the donor's
  lowest point. Result on all 17 mammals: lowest point ≥ -1 cm in every frame
  of every clip (it was -55 cm). Never sample clips with a mixer after
  `skeleton.pose()`: three's PropertyMixer only rewrites a value that CHANGED,
  so a constant track (the dog's Hips through Howl) is lost after frame one —
  `sampleClip` reads the tracks directly.
- **Midline weights.** A chest or belly vertex between a pair of legs is
  nearest the two legs and took them 50/50 with nothing on the spine; legs
  folding together dragged it out like taffy (the bison's chest x18 in its
  death). Whatever a vertex holds of both sides of a limb pair moves to the
  central bone they hang from (`--no-midline`).
- **Generated gaits are re-solved analytically.** `_gait.mjs` CCDs each frame
  from rest, toes and all: it curls paws flat back in swing and now and then
  lands on the other branch (the bear's foreleg and shoulder spun 172° in one
  frame of its gallop). Autorig stops the gait at the ANKLE (`--gait-ankle
  none` to undo), then re-solves every leg at the gait's own keys with
  two-bone IK in the rest knee's plane (an anatomical elbow-back/stifle-forward
  pole, with some up in it, when the leg was fitted straight), the paw riding
  the shin. New footfall tables `lumber` (a bear's or boar's short heavy step)
  and `prowl` (a big cat's long, low, level stride); `--gait-sway <deg>` rolls
  the hips and shoulders once per stride.
- **`--death collapse`** replaces the dog's stage death (rears up, goes over
  backwards) with a generated one: forelegs buckle, hindquarters follow, the
  body rolls onto its side, the head and tail go down last, grounded every
  frame. **`--attack gore`** generates the attack (`Bite`) for a horned or
  tusked animal: hips drive forward, the head drops and thrusts, then hooks up.

Recipes in use: dogs, hyena, wolf, rat, horse, elk, deer, sheep keep the dog's
clips (+ collapse for the hoofed); pig and bear `Walk=lumber,Run=gallop`
+ sway + collapse (+ gore for the pig); bison and rhino also generate their
Idle (`Idle=idle`) and gore; the lion `Walk=prowl,Run=gallop`, `--belly
between` (its belly was measured on the floor — the knee-at-the-hoof fit),
collapse, and an idle head held up with `--damp`. Checked with a probe of
every clip (lowest vertex per frame, lowest per foot, worst edge stretch per
part) and the `--render` sheets, which now draw the floor line and paint
anything below it RED.

**Same day, corrected** (Derek: "the wolf animation is all forms of fucked…
all the hoofed animals are also messed up"). Two of the changes above broke
borrowed gallops and are reversed: the fit is back in the WALK's average
(fitted in the idle, every dog Run flung the hind legs up level behind the
body), and grounding a BORROWED clip now solves only the feet the donor has
planted — a foot the donor has in the air keeps the donor's leg, carried by
the hip shift (frames with no foot down take the shift interpolated from their
neighbours; `--ground-swing solve` is the old behaviour). What the walk fit
leaves under the floor the planted-foot IK takes out. The rule for any change
here: render every clip against the last good GLB before shipping; no clip may
look worse. Also: `--call roar[:Clip]` generates the call clip as a STANDING
roar (legs planted, chest up, head raised and thrust forward) — the dog's
Howl sits the animal down, which suits canines only; it is used for the lion,
bear, pig, sheep, goat and every hoofed animal. A generated gait's `clipSpeeds`
entry is its built speed, not the slip measurement (which read a gallop's paw
roll as 1.86 m/s on a 4.46 m/s pig). The pig's gallop runs with
`--gait-ankle none` (the ankle re-solve folded its hind legs under the belly).

## When no donor fits: `legrig`

`autorig` needs a donor with the same body plan. There is no eight-legged
donor, and a sprawler is not a dog: fitted to `Dog.glb`, the alligator's
legs (which stick out sideways and bend at an elbow pointing up) barely moved,
and its shoulders sheared. `pnpm -F playground legrig` reads the skeleton off
the mesh instead and GENERATES the clips:

```
pnpm -F playground legrig --creature spider \
  --texture ../../tools/atlas/out/spider/<theme>/atlas-seamblend.png \
  --out projects/<game>/assets/models/mmo/mobs/spider.glb --render /tmp/rig
```

- **The mesh is the unwrap's `-parts.obj`.** The creature is already cut into
  named parts for its atlas (docs/mob-atlas.md), so the rig reuses that cut:
  `trunk` parts are skinned along a chain of stations down the body axis, and
  every leg part (both sides, from `mirrorCopy`) becomes a two-bone chain:
  root where it meets the body, knee off the root-foot line (toward the
  `pole`: `"out"` for a sprawler's elbow, `"up"` for a spider's apex), foot at
  the far end. A creature is a `CREATURES` entry at the top of the tool, like
  an unwrap recipe.
- **Locomotion is two-bone IK on a footfall table**, not keyed rotations: each
  foot drags back through stance and lifts forward through swing, so feet stay
  planted and the printed `clipSpeeds` is exact, `stride / (duty x period)`.
  Phases are per leg (`phase`): diagonal pairs for the alligator, an
  alternating tetrapod (L1 R2 L3 R4) for the spider. A sprawler's trunk also
  swings in a travelling S-wave (`sway`).
- Clips: `Idle`, `Walk`, `Run`, `Bite` (the name `mobBite` plays) and `Death`
  (a roll onto the back, legs curled over the belly; play it once and clamp).
- The output is an UBERMESH like the unwrap's: part index in TEXCOORD_1 and
  the unwrap's `-parts.json` table in the mesh node's extras, so an optional
  part (the alligator's `Gator_Sail`) is shown or hidden by `partMask` /
  a look's `parts` on the animated mob, one draw either way.
- Output faces +Z, in metres (`length` or `span` in the entry), feet on y = 0,
  the same contract as `autorig`. `--render` writes a side + three-quarter
  contact sheet per clip; look at Walk and Death before shipping.

What the later creatures added (dragon, lion, goat, ant, trout):

- **`pole: "rest"`** bends each knee the way the MODEL'S knee already bends
  (the knee's offset off the root-foot line, carried with the body). Use it for
  any upright quadruped; `"out"` is only right for a true sprawler.
- **`rigid: { part: bone }`** binds a piece whole to one bone: horns, eyes,
  ears, a mane, back spikes, fins. Left on the trunk chain, a horn that reaches
  back past the skull bends with the neck.
- **`wings: [{ part, name, parent }]`** builds a two-bone wing (root, half way,
  tip) that the clips raise, flap and fold.
- **The seam weld.** The parts were cut out of ONE shell, so a body vertex and
  a leg vertex share every position along the cut. Weighted separately they
  tear into slivers the moment a leg moves; the tool gives every vertex at a
  shared position the limb's weights (`welded N seam vertices`), and a leg's
  root is fully the body's.
- **No legs is allowed.** A fish is `legs: []` with the trunk wave as its
  swim: Walk and Run carry only `sway`, and `stride / duty` sets the speed it
  prints.
- **`alternatives` and `profile`.** A `scaledCopy` part (the ant queen's
  gaster) is listed in `alternatives` so it does not count toward the size the
  creature is scaled to, and `profile` names the parts the trunk's length and
  station heights are measured on (also what keeps the alligator's sail from
  lifting its spine).
- **`plan: "quad"`** (the dragon): the body moves with the legs — hips and
  chest pitch against each other (twice a stride walking, once galloping), the
  weight rolls side to side, the neck nods against the head, the tail follows a
  beat behind — plus a per-gait `phase` (a gallop: fronts, then hinds), and
  Idle / Bite (coil and strike) / Roar (rear up, wings spread) / Death (onto
  the side). `blend: [{ part, axis, bones }]` weights a part along its own axis
  through a chain (the dragon's upright neck: chest → neck → head); left on the
  body's length axis it moved as one block and tore at both ends.
- **Smooth shading.** The mesh is a triangle soup, so three's
  `computeVertexNormals` gave every face its own normal and the animal read as
  a faceted cage (Derek). Normals are averaged over every face meeting at a
  position within `crease` degrees (default 100: box-section legs have 90° corners; 60 and 80 left low-poly
  corners faceted), which also welds the shading across part seams. One
  helper, `tools/_normals.mjs`, serves legrig AND autorig (`--crease`):
  autorig used to keep the unwrapped OBJ's flat normals, so every Dog-donor
  mammal shipped faceted. "All mobs need smooth shading" (Derek, 2026-10-06).
- **Dog-shaped animals go to `autorig` after all.** The lion and the goat
  looked stiff on generated gaits; on `Dog.glb`'s library (`--clips
  "Idle=Idle_Alert,Walk,Run,Bite,Death,Roar=Howl"`) they move like animals.
  `autorig` now takes an unwrap's `-parts.obj`: `--bind Part=Bone` pins a
  piece whole to one bone (`Lion_Mane=Head`, `Goat_Horn=Head`), and the part
  index (TEXCOORD_1 + `parts`) is carried through so the mane or the horns
  still toggle by mask. `--dangle --dangle-stiffness 1.2 --dangle-gravity 9`
  hangs a lion's tail the dog carries straight out. A long neck does not fit
  the dog (the dragon's collapsed into the dog's short neck): that one stays on
  `legrig`.
- **`chains`: a part that bends along its own curve** (the scorpion's tail runs
  back, up and over; its arms): `{ part, name, parent, bones, sides }` lays
  bones down the part by distance ALONG THE SURFACE from where it meets the
  body, so a curled tail is segmented down its curl, not by height. `sting`
  (arachnid) uses a tail chain and arm chains: Bite is a tail strike SOLVED so
  the stinger lands at `reach`/`height` past the body's front with the body
  lunging and arching, Heavy is a claw seize plus two stabs, Pinch claw snaps,
  and Death goes belly-down with the tail and claws laid limp along the ground
  (`flatten`). A scorpion must never die on its back: it rests on its raised tail.
- **Flying insects' legs fold** (`fold: [out, up, fwd]` per leg, leg lengths from
  the leg root in the body's frame, `pole: "body"`): IK tucks them under the
  thorax with a little dangle (`legSwing`), `biteFold` reaches them forward,
  `deadFold` curls them on the back. Split a one-part leg set per pair with
  `regions` by shell. An abdomen or long tail as several trunk links `curl`s,
  `pump`s and sways (`tailSway`) per gait; `flight.deadCurl` sets how it lies
  dead. `--full` renders a flyer's sheets over the whole clip, not one wing beat.
- **Stride is capped by the leg.** A stride longer than the leg can reach
  stretches the hip into slivers; the lion settled at about two-thirds of its
  leg length for Walk.
- **Check the found joints with `--verbose` before tuning motion** (2026-10-06). The
  automatic search put the gator's elbow 0.12 m from its shoulder (the whole leg
  swung from the shoulder: the run's pinch) and the dragon's leg ROOT at its toes
  (the real feet rode the body). Place them by hand: `rootAt` / `kneeAt`
  `[out, up, fwd]` in output metres, `root: "top"` for hanging legs, `foot: f` to
  keep a foot flat, `kneeBand` to soften a thick elbow. A stride longer than the
  leg's reach goes straight and skates: shorten stride AND period together so
  `clipSpeeds` stays the same.
- **`girdle` (sprawl gaits): the trunk bends with the legs.** Shoulders and hips
  yaw so the reaching leg's shoulder goes forward with it (the lizard's standing
  S), `roll` onto the stance legs; the free `sway` wave had turned the shoulders
  against the stride. Gator run shoulder stretch went x4.06 -> x1.78.
- **`groundIgnore: [parts]`** — grounding (every `ground()`, every Death) ignores
  these: a gator on its back rests on its back with the sail through the ground,
  a dead dragon on its belly with wings/spikes/horns wherever they fall.
- **`plan: "serpent"`** (the cobra): the body is one `chains` part (36 links,
  `band: 0.5`) laid along a world POLYLINE by `follow` (link by link at its own
  length, level-framed so it never rolls). Idle/Bite/Hit keep the modelled coil
  planted (FABRIK on the front `anchor` links only); Walk/Run follow a sine track
  that scrolls back at exactly the clip speed (stride = wavelength), so contacts
  never slide sideways; Death drops the hood beside/over the coil and searches
  the head down onto the ground. `junction` blends a ragged upright part into its
  chain, `hood` adds a leaf bone with a SCALE track (the flare), `stiffTip` keeps
  a hooked tail tip's modelled bend.
- **Walker wings fold** (`quad` plan): `wings[].fold` dirs + normal in the body
  frame; `wingFold(k)` from the model's raised wings, `wingSplay(s)` lays dead
  wings out over the ground. Quad Death = belly crash with neck/tail searched
  down onto the ground; biped Death = topple onto the side with the legs folded
  in the body's frame and neck/tail searched down.
- **Every plan gets `Hit` (0.4 s flinch) and `Hit_Heavy` (0.9 s stagger).**
  Both are the plan's own Idle (`idlePose`) struck from the front: the root
  recoils back a few % of the trunk span, the hub pitches nose-up (the tail's
  base link takes the pitch back so a ground-lying tail is not driven in), the
  front trunk compresses and twists, neck and head jerk back and up a beat
  later, the tail whips, and the legs are re-solved onto `foot0`. Per plan:
  quad/sprawl lift a front paw (heavy: a step back and up again, the other
  forefoot braced, a sideways sway and a head shake); arachnid pulls its legs
  in pair by pair; biped rocks back on its heels (`footPitch` < 0) with a
  stumble step on the heavy one; a legless sprawl swims it off (sideways jerk,
  C-bend, tail kick, a roll on the heavy one); a flyer jolts back, drops and
  misses a beat (wings mixed toward a stalled pose). A spec's `hit` tunes it:
  `{ style: "strike" }` gives a legless creature that rears (the cobra) the
  walkers' recoil instead of the swim; `light` / `heavy` override the numbers.
  combat-actor plays them as `hitClip` / `staggerClip` (below, "Hit reactions").

- **Deaths turn on the body's own centre** (2026-10-06, Derek: "shouldn't it be a
  turn on their center axis instead of the off center roll?"). The root sits on
  the floor under the body, so every Death that rolled the root (sprawl and
  arachnid flips, quad crash, biped topple, flyer fall, the sting death, the
  sprawl Heavy's barrel roll) swung the animal out sideways about a point on
  the ground — the T-rex's trunk travelled 3.4 m. legrig's `pivotRoot()` moves
  the root so the trunk centroid (on the midline) stays put after any root
  rotation, and grounding settles it — continuously through a topple or roll,
  so it never hangs in the air; the old hand lifts (+0.32 m arachnid, +0.15 m
  sprawl, the quad's 0.12 m sideways shift) are gone. autorig holds the BODY
  part's centre (else the hips+spine vertices) over its footprint in every
  Death, borrowed or `collapse` (`--death-hold none` to skip). Max trunk drift
  now: wolf 0.9 cm (was 32), shark 1.4 (55), alligator 9 (44), T-rex 45 (344;
  the rest is its scripted stagger step on a 12 m animal).
- **Antennae are never legs.** A leg part cut with the antennae in it (the
  hornet's Hornet_Leg holds both) gets a `regions` entry re-tagging the antenna
  shells (`as: "Hornet_Antenna"`) plus `rigid` on the head; left in a leg
  region they became part of the leg's IK chain and swung off the face.
  Check `-parts.json` shells (by centroid) for every insect before rigging.

### Themes as materials, and the flip

A mob variant is the SAME rigged GLB with a different texture: a material
asset (`materials/mobs/<mob>-<theme>.json`, `map` + `filter: "nearest"`) named
by the prefab's `mesh.material`, as the ghoul variants do. **The PNG must be
stored upside down**: a material map loads with `flipY` on, while the GLB's
UVs follow glTF's top-left convention, so an atlas copied straight across lands
mirrored top to bottom on the model (orange legs where the hide should be).
The ghoul's shipped textures are flipped copies of their atlases; measured, a
flipped comparison matches them exactly. An optional part is chosen per
prefab with `mesh.source.partMask` (the bits are the unwrap's `-parts.json`).

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
- **A deliberate slow-down is taken back out before the gait is read.** A
  strafe or backpedal moves at `sideSpeedMult` of the gait by design — in the
  MMO 6.5 × 0.65 = 4.2 m/s, under the 4.35 walk/run line — so read raw, every
  sideways or diagonal RUN played the walk cycle at its 2.5× rate cap and still
  skated. The multiplier is the player's own intent, so it is divided back out
  (`gaitReadingSpeed`); a swamp, a wade or an AI slowing the body still reads
  as measured.
- **Gait switches are phase-matched.** Walk → run → sprint (and run → strafe)
  starts the incoming cycle at the outgoing one's normalised time
  (`setAnimation(..., { sync: true })`) over a 0.25 s fade; restarting it at
  frame 0 swaps the feet mid-stride. The new clip's rate is set AFTER the play,
  so the cycle fading out keeps its own pace. Idles and actions keep their own
  snappier fades and start from the top.

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
slides under the hip at exactly the speed the clip depicts) and prints the
numbers ready to paste — `clipSpeeds`, and next to it `clipFootfalls` (see
*Footsteps* below). It prints them after every bake, and
`pnpm -F playground retarget --measure <model.glb>` reads them off a finished
GLB without the source FBXs. The measurement lives in `tools/_locomotion.mjs`.

**How a clip's speed is measured, and why the number may have moved.** Both
tools treat a foot as planted at the bottom of *its own* arc in *that* clip,
and take the slip as a planar magnitude (a strafe's ground goes by sideways).
`retarget` uses the foot's lowest sample plus 2% of body height, and only for a
foot that reaches the ground at all. It used to use a fixed line at the bind
pose's sole, which a strafe defeats: a sideways run lands on the edge of the
foot, the toe bone rides a few centimetres up through the stance, and the line
kept mostly the roll-on and roll-off frames where the foot barely moves. That
read the human's `Run_Left`/`Run_Right` at 1.16/1.13 m/s; per foot they measure
1.98/2.02, which is also what the stride covers. The forward gaits barely moved
(Walk 1.01 → 1.02, Run 6.01 → 5.98, Run_Bwd 4.87 → 4.91); Sprint went 8.69 →
9.18. In `autorig` the band is 6% of body height. A gallop
lifts the whole animal (this dog's Run carries its hips a fifth of a
body-height higher than its Walk), so against a fixed line a running quadruped's
feet never touch and the clip cannot be measured at all. It is also why a
dangled chain is excluded from the foot set: a tail tip lying on the floor is a
ground-level leaf bone, and letting it vote replaces a stride measurement with
a tail measurement — which is exactly what happened to this rat's Run, silently,
until the tail was taken off the keyframes.

**A swimming clip has no ground speed**, and the measurement does not pretend
otherwise: legs kicking past the hip read as ~0.8 m/s of slip, and a controller
handed that number plays the stroke at four times its rate. `retarget` leaves
`Swim`/`Tread_Water` out of the printed `clipSpeeds` on purpose — the
controller paces a stroke against its own `swimSpeed` instead.

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
interpolated yaw. The edges (50° to the side, 130° to the back) hold the clip
already in force for 4° either way, so travel wandering across one does not
flicker; the band stays under 5° so the keyboard's exact 45°/135° diagonals
land the same way every time. At a WALK the controller plays
`walkBackClip`/`walkLeftClip`/`walkRightClip` (`Walk_Bwd`, `Walk_Left`,
`Walk_Right`) where the model has them, else the run's directional clip paced
down to the walk.

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
every game uses and the one every rig `retarget` produces has. On the MMO's CC
rig that is `CC_Base_Waist`, a SIBLING of `CC_Base_Pelvis` under `CC_Base_Hip`:
the hip and the legs stay the gait's, waist-up is the action's. Override it per
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
  its cast time. The exception is `phaseLock`: a locked layer is placed at the
  base's phase plus an offset each frame and paced to the base, because a
  stance carry has to swing with the legs.

**There is one layer, and the controller arbitrates it.** A layered action
wins. Otherwise the stance carry the gait asked for goes on (see *Weapon
stances*), else the layer comes off. `settleLayer` runs once at the end of each
tick. An action ending mid-walk therefore hands the arms straight to the
carry (a 0.2 s fade over the action) instead of clearing to the bare gait and
re-raising. A full-body action, a jump, a swim or a freeze clears the carry
for its length. A second layer slot in the AnimationSystem was the
alternative. It would have needed two base complements and two replicated
layers, for a case the controller can decide in one place.

## An action lasts as long as it was told to

`actionClip` comes with `actionUntil`, and the two rarely agree: a cast that
runs three seconds animated by a clip that runs one. Repeating the clip three
times is the most obvious tell there is that an animation was bolted onto a
timer, so the controller **fits the clip to the window** — one slow cast rather
than three quick ones, and a clip longer than its window speeds up to land on
time. `ctx.animationDuration(clip)` is where the length comes from.

Two limits keep it honest. Past `ACTION_RATE_MIN` the clip plays once at that
floor and holds its last frame — a one-shot is never looped to fill a window,
because a swing or a death that comes round again is a second swing nobody
asked for. A pose that SHOULD repeat says so with `actionLoop` (looped at rate
1, never fitted), and a held one with `actionHold` (once at rate 1, clamped).
A clip nobody can measure — a model still loading, a headless host with no
mixer — keeps the old looping behaviour rather than guessing.
`fitActionClip: false` turns the whole thing off.

The same fit applies to a **frozen** body's held clip, which is how a death
animation stops playing twice.

A one-shot played a second time needs `restart`: the clip is already the
current one, clamped on its last frame, so a plain re-play is a no-op that
reads as a character frozen mid-swing. The controller passes it when an action
STARTS — a new clip, or the same clip asked for again once its previous window
has run out (a chained swing set on the very tick the last one ends) — and
only then. Passed every tick it re-seeks the clip to frame 0 sixty times a
second and a standing swing never plays at all. A window pushed later while it
is still running (a channel that got longer) carries on rather than
restarting. A script driving `ctx.setAnimation` itself has to say so.

A caster that sets `actionClip` should also set `actionHold` and `actionLoop`
(to false for an ordinary one-shot): they are sticky userData, and a stale
`actionLoop` from a channel would loop the next swing.

The layer replicates alongside the base clip (`animL` in the entity snapshot,
and the dedicated server applies the same moving/standing rule to player
bodies), so other clients see the cast over the run, not one or the other.
A layer with no live action under it is a stance carry. It goes out as a loop
(`animM: "loop"`), or, when it is phase-locked, with its offset (`animO`), and
the receiver locks it to its own copy of the gait. The action flags
(`actionHold`/`actionLoop`) are sticky userData, so they are read only while an
action is live. Otherwise a stale `actionHold` replays the carry as a clamped
one-shot. **The dedicated server does not dress clips at all**: `PlayerDriver`
has no model and so no clip list. It sends plain `Attack1`/`Run` for server-mode
players, with no stance and no carry. The server runs the builtin scripts,
`weapon-stance` among them, so the stance list can be known there. What it
lacks is which `<Stance>_<clip>` the model has. Mirroring `dress` and
`stanceCarryFor` there needs that list, for example the clip names shipped to
the server with the template.

### A strike lands on its hit (contact fitting)

A fitted swing used to put the WHOLE clip over the WHOLE cast window, so the
blade crossed the target wherever its contact fell in the clip, often
100-250 ms before the authority's hit. The window is the caller's, so the caller
fixes it: play the clip at the one rate that puts its contact on the resolve,
`window = clipLength × windup / contact`. voxel-demo measures each strike
clip's contact with `projects/voxel-demo/tools/clip-contacts.mjs` (the
weapon tip, from the player prefab's own sockets, crossing the target line
fastest and furthest out; a clip with two blows lists both and the one nearest
the clip's own pace is used) and sets `actionUntil` from it in combat-caster.
Damage timing never moves.

A window longer than the cast (a slowed strike) means the same clip can be
asked for again while its last window is still open, which `actionStarting`
treats as "carrying on". A writer that bumps `userData.actionSeq` (any number,
changed per action) says "this is a new action" outright, and the controller
restarts the clip.

### Hit reactions (clips)

combat-actor (voxel-demo) has two: `staggerClip`, played when the stability
pool breaks (or a parry/guard break staggers), and `hitClip` (default "" =
off), a light flinch on an ordinary blow that landed — not one that killed,
staggered, or met a raised guard (that shows `blockHitClip`). The authority
decides and writes the body's action clip, which the server replicates like
the stagger; the flinch only takes a FREE action channel (a swing, a cast, a
held guard or a stagger already playing wins) and the next action overwrites
it, so it never interrupts an attack. `hitClipSeconds` (0.4) and
`hitClipCooldown` (0.6 s, a flurry is one flinch). Animals: `staggerClip:
"Hit_Heavy"`, `hitClip: "Hit"` (both generated by legrig/autorig, set by
make-prefabs.mjs and rig-ratwolf.sh); human rigs: `hitClip: "Hit_Chest"`. The
clip and the procedural `poseFlinch` below stack.

### Hit flinch (no clip)

`userData.poseFlinch = { at, dir, angle, ms, twist?, wobble? }` on a model, its
entity or a body up to three levels up (like `poseHoldUntil`): `at` is
performance.now() ms, `dir` the world direction the blow travels, `angle`
radians at the peak, `ms` the length, `twist` radians about up, `wobble` 0..1 a
damped sway back past upright (a reel). After the mixer and the layer anchors,
the spine chain (the upper-body split and two spine bones above it) is turned
by that world rotation split over the chain: a snap out in the first 12%, an
ease back. The rotations as left are saved first and put back before the next
mixer pass (only where a bone still holds what the flinch wrote), so a held
pose is never pushed twice; it also applies during a hit-stop. Test:
`packages/render/test/animation-flinch.test.ts`.

### A swing that steps moves the body

Every clip `retarget` bakes is in place (the hip's start-to-end drift is
removed), so a sword lunge is a planted foot sliding BACK under a body that
stays put. On a capsule that does not move, the feet skate and the character
snaps back to where it started. Derek's words: "the feet do not move the player
forward so it doesn't line up". `clipAdvance` fixes it: per one-shot, how far
the ground goes by under it, and the controller moves the body by that much
while the clip plays.

```json
"clipAdvance": { "SwordShield_Attack3": { "d": 0.7, "f": [0, 0.08, 0.12, …, 1.28] } }
```

`f` is cumulative metres along the model's +Z (its forward) at 21 evenly spaced
points from the first frame (0) to the last. `s` is the same along +X, present
only when a clip moves sideways at least 15 cm. `d` is the clip's length, used
where the host cannot report one. Keys are DRESSED names (`Sword_Attack3`, not
`Attack1`), because that is what plays.

- **Where the numbers come from.** `retarget` prints them after a bake, and
  `--measure <glb>` prints them off a finished one, next to `clipFootfalls`. While a
  foot is planted, the ground moves at minus that foot's velocity. So each sample
  follows the SUPPORT: the lowest foot (toe or ankle, each from its own low
  point), averaged with the other foot while it is within 3 cm. The average
  matters. A lunge that spreads its stance slides both feet at once in opposite
  directions (`Sword_Attack1`: left 0.9 m back, right 0.7 m forward). Following
  either foot alone reports the whole stride, forwards or backwards. A lone low
  foot moving faster than 4 m/s is landing, not planted, so the next foot up is
  followed instead. Stretches with no foot within 20 cm of the ground are
  interpolated. Walks, runs, turns, idles and swims get no entry.
- **What the controller does.** While a clip with an entry plays FULL-BODY on a
  grounded body, it adds the curve's slope times the clip's playback rate to
  the velocity, along the body's facing (`advanceScale`, 0..2, default 1,
  scales it). It is a velocity in `fixedUpdate`, so walls stop it and a ledge
  drops you. A fitted swing that plays at 1.2x covers its ground at 1.2x, so
  the feet stay planted. There is no advance during an upper-body layer (the
  legs are running), a freeze, an impulse (a dash owns horizontal velocity),
  a jump, or with `speedMult` 0 (rooted/staggered). A lower `speedMult` from
  cast commitment slows the stick, not the lunge. That is on purpose: a
  slowed lunge is exactly the foot-skate this exists to remove.
- **Combos.** "Is it walking?" is asked when each action starts, against the
  body's speed LESS last tick's advance (`ownPlanar`). Read raw, the first
  swing's lunge (1-2.5 m/s, past the 1.1 m/s walk line) would put every later
  swing of the combo on a layer with no lunge of its own.
- **No clip stripping.** The pose is not modified. The bake's in-place
  conversion already took the hip's drift out, and the curve is read off the
  feet of that same in-place pose. Moving the body by the curve plants those
  feet, and what is left of the hip's motion is the lunge's weight shift over
  the feet. A clip baked with `--keep-root` carries its own travel in the hip,
  its planted feet do not slip, and it measures (correctly) as zero.
- **Server.** The client adds the advance to the velocity it claims
  (`userData.advanceVel`, read by `getLocalInput`). `PlayerDriver` adds
  `advanceAllowance` to its speed cap while an action is live and the body
  is not rooted. The allowance is the table's peak speed × `advanceScale` ×
  `ACTION_RATE_MAX`, so a committed swing (speedMult 0.18-0.85) is not clipped
  as a speed hack. The server also decides layered/full-body ONCE per action
  now, as the controller does. The claim is one number, so it cannot take the
  lunge back out. Instead, a swing that starts within 0.25 s of a full-body
  one inherits full-body (`CHAIN_GRACE`).

Measured on human.glb after the yaw pass (see *A swing faces forward*; fwd / side m
over the clip): Sword_Attack3 0.85 / 0.26, SwordShield_Attack3 0.39 / -0.84,
SwordShield_Heavy 0.65, GreatSword_Attack3 / Axe2H_Attack1 0.40, GreatSword_Attack4
0.18 / -0.63, GreatSword_Heavy 0.26 / -0.47, Staff_Attack2 0.28 / -0.35,
Sword_Combo 1.23. Axe2H_Heavy, Attack1-3 (plain),
SwordShield_Attack1 and Staff_Attack1 are essentially in place. Turning a
clip's hips changes where its feet go, so re-run `--measure` after any
`clip-yaw` pass and paste the table again.

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

**Velocity alone is guessing; a ray knows.** `groundProbe` casts a downward
ray every so often (0.05s by default, every tick while moving; 0 turns it off)
and settles the question outright — and the same hit carries the surface
NORMAL, so the two slope problems are one query rather than two. The resting
distance comes from the collider (half its height less its offset); it is only
measured for a body whose collider cannot state it. Everything degrades to the
velocity path when there is no `raycast` to call.

**One ray from the capsule's axis is wrong on every lip it climbs.** The
rounded foot is already on the upper cell while the axis is still over the
lower one, so the centre ray reads the ground a lip's height further down —
past the 0.3 m slack for any real voxel lip, and after `coyoteTime` the air
clip played on a body sliding up the bump ("he glides up hills"). So
`readGround` (locomotion.ts) casts the centre ray first and, **only when it
reports a gap**, four more on a ring inside the footprint oriented along
travel; the nearest is the ground the capsule stands on. A flat run is still
one ray. And a RISE is no longer airborne evidence by itself: only a rise
something launched (the body's own jump, or `liftUntil`) is. An unlaunched
rise — a climb — gets `groundStick` as its slack. See `probeLeaving`.

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

Climbing has four more rules, all from voxel terrain, where a marching-cubes
hillside is a staircase of small lips with 45-55° faces:

- **No gap pull while climbing.** Closing a gap pulls DOWN, which is only right
  on the way down. Climbing (ground rising along travel, or contact lifting
  the body past what the follow wrote last tick) the gap is the lower cell the
  axis is still over, and pulling toward it drags the body back into the lip.
- **Uphill is capped at the walkable limit, not at `slopeTolerance`.**
  `slopeTolerance` is what separates following a descent from falling, so it
  still caps downhill. Capping the climb at 39° held the rise below what a 50°
  lip face asked for; the body ground into it and its measured speed sank
  under the idle threshold — a creep in the idle pose. Uphill now allows 1.5
  (≈56°, under the 60° normal cut-off).
- **A pop is clipped, not zeroed.** `stepPopCap` used to replace a contact pop
  with the plain follow (0 on flat ground). The body does have to rise a lip's
  height to cross it, so zeroing stalled it against every lip; now the rise is
  kept up to the cap. The doorway hop stays fixed: the next tick the rise is
  ours and is overwritten.
- **Step-up.** One more ray, a little past the collider's leading edge,
  measures the ground ahead against the plane underfoot. A rise up to
  `stepHeight` (0.35 m) is climbed before the capsule reaches it, at a rate
  proportional to what is left of it (capped at 5 m/s), so the body lands level
  with the top rather than hopping over it. A smooth slope measures zero here —
  the plane already predicts it.

The **dedicated server runs the same function on player bodies**. It has to: a
client predicting the ground while the authority arcs over it is worse than
either alone, since every slope becomes a fight the authority wins by yanking
the player back.

## Jumps, landings and turning on the spot

**The arc.** World gravity alone is a symmetric arc that hangs: the MMO's old
`jump` 6.5 was a 2.1 m apex (taller than the character) and 1.3 s in the air.
The controller shapes gravity itself — added as a velocity delta on the fixed
step, so it is per-character and the dedicated server's `PlayerDriver` flies
the same arc — as multiples of world gravity: `jumpGravity` while rising in
its own jump with the key held, `jumpCutGravity` while still rising after the
key is released (the short hop), `fallGravity` for every fall. A launch pad or
knockback (`liftUntil`) keeps plain gravity. Defaults — `jump` 6.2, 1.6 / 3 /
2.2 — give a **1.21 m apex and 0.73 s airtime** (a tap: 0.76 m, 0.50 s);
`jumpArc()` in locomotion.ts integrates any tuning at the fixed step, so
retune with numbers rather than by feel. Raise `jump` together with the
gravities, never instead of them.

**Air control.** Airborne, the controller no longer writes the full gait
velocity each tick (that let a body reverse in mid-air). `airControl` (0.3)
blends the velocity toward the input, and with no input the take-off momentum
carries. Dashes and knockbacks (`impulseVel`) still own the horizontal.

Every one of the following is an optional clip: a model that shipped without
them behaves exactly as it did before they existed.

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

## Footsteps

`footsteps: true` plays a surface sound (`footstepSounds`, keyed by what
`surfaceAt` reports under the body) on each foot contact. **The timing comes
from the clip, not from a clock.** `clipFootfalls` lists, per locomotion clip,
where in the clip (0..1) each foot lands:

```json
"clipFootfalls": { "Walk": [0.983, 0.479], "Run": [0, 0.5], "Run_Left": [0.917, 0.442] }
```

The LEFT foot's contact comes first, then the rest in stride order round the
loop. `retarget` prints them that way (`_locomotion.mjs` finds the left contact
bone by name). Footsteps ignore the order. The stance carry uses it to line up
one clip's arms with another clip's legs. A list measured before this (plain
ascending) may lead with the right foot. Re-measure with `retarget --measure`
before trusting a carry built on it.

The controller reads the base clip's playhead each tick
(`ctx.animationPhase()`, served by `AnimationSystem.baseClipPhase`) and plays a
step as it passes a contact. Playback rate, gait changes and speed changes
cannot put a step out of time, because the sound follows the same playhead the
pose does. The old scheme, a step every `speed / footstepCadence` metres, gave
a fixed 3.1 steps a second at a walk, a run and a sprint alike, while the walk
clip was playing at 2.2x and the run at 1.1x. Details:

- **Where the numbers come from.** `retarget` prints them after a bake, or
  `--measure <glb>` off a finished one. A foot's height is the lower of its toe
  and its ankle, each from its own lowest point in the clip, so heel strike and
  toe strike both count, whichever is first. It lands when it is within a
  couple of centimetres of that low point and its slide under the hip has
  turned to go with the ground. Height alone hears a crouch-walk a
  quarter-second late (the sole lands above where the toe ends the stance) and
  a heel that hovers before a two-handed step early. Only looping gaits get
  entries: walks, runs, sprints, strafes, crouch-walks. Swim and tread have no
  contacts.
- **Crossing rules** (`@hitreg/scripting` `footfallsCrossed` /
  `FootfallTracker`). The interval is half-open round the loop, so a contact
  the playhead lands on exactly fires once. A wrap from 0.98 to 0.02 passes a
  contact at 0. Several contacts in one tick are all counted and one sound
  plays. Whole extra loops (rate × dt ÷ duration beyond the visible move) are
  counted too. A clip change counts only a small forward move, which is what a
  phase-synced gait crossfade gives. A restart or a phase jump re-anchors with
  no sound. Steps closer than 0.12 s are one step. During a held blend the
  heavier clip answers. During a crossfade the incoming one does.
- **Fallbacks.** A gait clip with no entry, or a host with no playhead
  (headless), uses the distance cadence `footstepCadence`. Swim strokes always
  use a distance cadence. An action or idle playing while the body drifts (a
  dash, a knockback) plays no steps.
- **Only on the ground.** Steps need true contact. The coyote window is a
  jump grace, and with it a character walking off a ledge kept stepping on air.
  The landing sound needs `landSoundAir` seconds off the ground (0.25 by
  default). Before that, every curb and stair step down sounded as a landing.
- **Variation.** Each step's level varies ±12% around 0.88 of
  `footstepVolume`, so the param is still the ceiling. The two feet sit a few
  percent apart in pitch so a stride reads as two feet. A sound set is a
  comma-separated list per surface, picked at random. Swapping the audio is an
  edit to `footstepSounds` only.

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
