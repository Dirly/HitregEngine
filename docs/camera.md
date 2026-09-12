# The third-person camera

One implementation — `ThirdPersonCameraRig` in `@hitreg/render`
(`packages/render/src/camera-rig.ts`) — drives play mode in the editor
(`apps/playground/src/main.ts`) and the published runtime
(`apps/playground/src/play.ts`). Both used to carry their own copy, which
drifted; a fix to how the boom behaves now lands in both or neither.

Fields: the `camera` component's `rig` block in `spec.json`. Judgment and the
traps: here.

## What the rig owns

Everything: the pivot, the orbit, the boom length, collision, and the final
`camera.position` / `lookAt`. `camera-controls` is parked for as long as a
follow target exists (`rigDrivesCamera` in the editor host, `followId` in the
runtime) and only drives the editor's free camera and rigless scenes.

**That single ownership is the point, not a tidiness preference.** The
arrangement it replaced split the job: `camera-controls` smooth-damped the
orbit *target* toward the player while the host measured clearance from the
player's *true* position and called `dollyTo` with the answer. Those are two
origins. `camera-controls`' default `smoothTime` is 0.25 s, so at the MMO
scene's sprint (9.5 m/s) the pivot trailed the character by over two metres,
and a boom length proved clear against the character was applied about a pivot
that far behind them. In open country the error is invisible. In a town whose
alleys are three metres wide it puts the camera through the housefront the
sweep had just cleared — the "buildings block the view of the player" bug.

So: smooth the pivot in the rig, resolve collision against that same smoothed
pivot, write the pose. One origin, and what the sweep proves is what you get.

## Collision

A sphere sweep (`sim.spherecast`) from the pivot to the wanted eye, per frame.

- **Physics, not meshes.** A mesh list only ever sees the scene doc, so
  streamed chunk terrain and every scattered tree were invisible to it; and
  `camera-controls`' own dolly-collision brute-force raycasts every triangle
  of every listed mesh with no acceleration structure — once profiled at 70%
  of frame time (`performance-lessons.md`). One broadphase sweep sees exactly
  what the player can collide with. Measured cost of the whole rig in
  Ashenhold: **0.05 ms/frame.**
- **A sphere, not a ray**, with a radius that must exceed the near plane's
  half-diagonal, or a ray grazing a trunk still leaves the corner of the view
  inside it.
- **Masked to `WORLD | TERRAIN | CAMERA_BLOCKER`** — never `ACTOR`, `PLAYER`,
  `PROP` or `TRIGGER`. The old query ran against `Layers.ALL`, so a townsfolk
  NPC wandering behind the player slammed the boom to nothing once per
  passer-by. Verified live in Ashenhold: a level sweep at chest height toward
  each of the scene's seven NPCs is stopped by every one of them under the old
  mask and by none under the new one.
- **The target is excluded.** A sweep that starts inside its own capsule is
  stopped by itself at distance 0, which parks the camera in the character's
  head every frame.
- **A penetrating start floors at `minDistance`**, which is deliberately
  small (0.25 m). Backed into a corner the camera goes effectively FIRST
  PERSON, which shows the player their surroundings; a boom floored a metre out
  just fills the screen with the wall it is inside. The first cut of this rig
  floored at 1.1 m and hid the body there, which read — correctly — as the
  camera being stuck in a wall.

## Getting the shot back, in order

1. **Lift over.** When the boom is cut below 75% of its framing, the rig tries
   rising over the obstruction (up to `liftMax`) before accepting a shortened
   one — a boom that can only shorten ends up flat against a housefront, which
   is a picture of masonry. A lift is only taken if it *restores* the shot;
   tilting skyward to buy 40 cm against an infinitely tall wall trades a clean
   shortened view for a worse tilted one.
2. **Shorten**, if nothing clears.
3. **Hide the body** below `fadeTargetBelow`. Squeezing into a doorway
   otherwise renders the inside of the character's own head.

Snap **in** immediately — one frame inside a wall shows the player the world's
backfaces — then **hold** `recoverDelay`, then return at a linear
`recoverSpeed`. The hold refreshes while an obstruction is still binding the
boom, not only when it cuts: without that, something that flickers in and out
(a fence, a colonnade, a row of market stalls seen edge-on) outlives the hold
every other frame and the boom yo-yos.

## Look limits are a collision setting, not just taste

`lookUp` / `lookDown` (degrees, on the rig block; 32 / 66 by default) bound
the orbit. `lookUp` is the one that matters: past roughly
`asin(pivotHeight / distance)` the eye would sit under the ground, so
collision crushes the boom to first person for as long as the player holds
that angle. That reads as the camera being **stuck**, not as a look limit.
Measured in Ashenhold at 32°, the boom holds its full 7.5 m across the entire
band at open, street and against-a-wall spots, with mild compression only at
the very top of the look-up. At the 51° the first cut allowed, looking up
buried the camera and pinned it there.

## `height` is a pitch, not a translation

The authored `rig.height` is an **eye elevation**; the rig orbits
`rig.pivotHeight` (chest height, default 1.6). The difference between them is
therefore seeded as a **pitch** — a follow rig authored at height 3.1 over
distance 7.5 starts looking gently down at the character. Before this the
follow rig ignored `height` outright.

In `chase` the framing is rigid instead: the authored distance is horizontal,
the height literal, the boom the hypotenuse, and the pitch pinned to it. Chase
now gets collision too, which it never had — it wrote an exact pose every
frame and clipped through everything.

## Traps

- **Never let `camera-controls` update on a frame the rig wrote.** It restores
  the camera from its own spherical state and the rig's pose is gone. Both
  hosts guard it (`if (!flyLookMode && !rigDrivesCamera) controls.update(dt)`).
- **Hand the pose back on leaving play.** `camera-controls` still holds the
  orbit from before play, so without a `setLookAt` from the rig's last pose the
  editor camera snaps across the world on the first drag.
- **Pivot the chest, not the feet.** Orbiting the origin swings the character
  around the screen, and a sweep starting at ground level is stopped by the
  ground.
- **Smooth Y looser than XZ.** A hill town is stairs; a pivot that tracks Y as
  tightly as XZ bobs once per step. Past `verticalSnap` it tracks immediately
  again, so a fall still reads as a fall.
- **Hide the body every frame, not on change.** A scene rebuild restores
  `visible` from the entity doc and puts the head back in front of the lens.
- **Judge the lift from the UNLIFTED direction.** Judging it from where the
  camera currently sits makes it self-cancelling: risen over the eave the shot
  is clear, so the rig stops lifting, so the eave blocks again — the camera
  pumps over the roofline for as long as you stand there.
- **`pitch` is the EYE's elevation**, so looking down means RAISING the
  camera: mouse forward has to LOWER the pitch. The sign is invisible in code
  and instantly obvious in the hand; `camera-rig.test.ts` pins both axes.
- **Re-applying an authored rig mid-session throws away the player's zoom.**
  `applyAuthored` reseeds framing and pitch, which is right on a scene change
  and wrong when `resolveFollowTarget` re-runs because a server spawned your
  body. The editor host only applies it when the rig block actually changed.
- **Guard the target position for NaN.** Every comparison against a NaN pivot
  is false, including the teleport test that would re-seed it, so one bad frame
  freezes the camera for the rest of the session.

## Checking it in a town

`packages/render/test/camera-rig.test.ts` covers the math headlessly (a fake
sweep function; no DOM, no physics). For the real thing, drive the playground
in headless Chrome and ask the physics world the question the complaint was
about — *is anything between the character's chest and the eye?* Two gotchas
worth knowing before you write that probe:

- Entering play **pins the body** until the landing terrain is in
  (`holdForPlayLanding`), so teleports are silently reverted; wait for
  `chunkManager.isViewReady()` and then verify the teleport actually stuck.
- Colliders only build around the **player**, so a straight teleport into a
  town 130 m away lands on nothing. Hop there in stages.
