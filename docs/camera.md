# The third-person camera

One implementation — `ThirdPersonCameraRig` in `@hitreg/render`
(`packages/render/src/camera-rig.ts`) — drives play mode in the editor
(`apps/playground/src/main.ts`) and the published runtime
(`apps/playground/src/play.ts`). Both used to carry their own copy, which
drifted; a fix to how the boom behaves now lands in both or neither.

Fields: the `camera` component's `rig` block in `spec.json`. Judgment and the
traps: here.

**The model is the classic MMO camera (EverQuest, WoW).** The boom only ever
SHORTENS. The wheel runs from a wide shot all the way into first person.
Nothing but the player's mouse ever changes the angle. Every "smart" behaviour
an earlier cut added on top of that — rising over rooftops, most of all — read
in the hand as the camera fighting the player.

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

## The pivot has to be inside the body

`pivotHeight` is measured from the target's **origin**, and its 1.6 default
assumes an origin at the feet. But a collider is centred on its entity unless
it is offset, so the usual capsule character has its origin at its **waist** —
and 1.6 above that is 0.7 m over its head, where nothing stops the pivot
entering a door lintel or a low ceiling. A boom sweep that *starts* inside a
lintel reports distance 0, and the camera slams to first person for as long as
it lasts.

That was the MMO town's "janky entering buildings". Measured by running the
old rig and the new one on identical inputs through the merchant house's front
door: the old rig cut **7.25 m in a single frame** at the threshold, went first
person twice, hid and re-showed the body, and then sat stuck in first person
beside the lintel for as long as the character stood there.

Two guards, in order of importance:

1. **`fitRigToBody(rig, collider)`** — both hosts run the authored rig through
   it. For a sized primitive collider it caps `pivotHeight` at the collider's
   top *minus the probe radius*, so the probe sphere at the pivot never pokes
   out of the body. Physics keeps the collider out of the world; a pivot inside
   the collider inherits that for free, and "the sweep starts inside the
   lintel" cannot happen by construction. Author `pivotHeight` anyway (the MMO
   scene says 0.6 — 1.5 m over the feet): a server-spawned body may carry no
   collider doc to fit against.
2. **The lag guard.** The smoothed pivot trails the character (by
   `speed / damping` metres) and would cut the door jamb on a turn, or still be
   up under the ceiling of the stair it just came down. Each frame the rig
   sweeps from where the pivot is *headed* (inside the body, vouched for) to
   where the smoothed pivot *is*, and stops it at anything in between.

Do **not** try to rescue a badly placed pivot with a sweep from the entity
origin instead. Rapier's `stopAtPenetration: false` is dependable for a probe
that *grazes* something it is moving away from, and not for one that starts
deep inside it — measured: a probe sunk two-thirds into a box and moving
straight out of it can still report a hit at 0, with a garbage normal.

## Collision

Sphere sweeps (`sim.spherecast`) from the pivot to the wanted eye, per frame.

- **Physics, not meshes.** A mesh list only ever sees the scene doc, so
  streamed chunk terrain and every scattered tree were invisible to it; and
  `camera-controls`' own dolly-collision brute-force raycasts every triangle
  of every listed mesh with no acceleration structure — once profiled at 70%
  of frame time (`performance-lessons.md`). Measured cost of the whole rig
  running through the town, look-ahead included: **0.08 ms/frame** (one sweep
  at rest, up to six while moving).
- **A sphere, not a ray**, with a radius that must exceed the near plane's
  half-diagonal, or a ray grazing a trunk still leaves the corner of the view
  inside it.
- **Masked to `WORLD | TERRAIN | CAMERA_BLOCKER`** — never `ACTOR`, `PLAYER`,
  `PROP` or `TRIGGER`. The old query ran against `Layers.ALL`, so a townsfolk
  NPC wandering behind the player slammed the boom to nothing once per
  passer-by.
- **The target is excluded.** A sweep that starts inside its own capsule is
  stopped by itself at distance 0.
- **Sweeps ask for `fromInside`** (the host maps it to
  `stopAtPenetration: false`): a probe grazing a jamb it is moving *away* from
  must not read as a hit at 0.
- **A genuinely wedged boom floors at `minDistance`** (0.25 m). Backed against
  a wall with the camera on the wall's side, the view goes first person, which
  shows the player the room; a boom floored a metre out fills the screen with
  the wall it is inside.

## How the boom moves

- **An actual intrusion is instant.** One frame inside a wall shows the player
  the world's backfaces.
- **But it should rarely come to that — the look-ahead.** The rig forecasts
  where the pivot and the orbit will be over the next `lookAhead` seconds (0.4)
  and asks the same question from there, at three points along the way. When a
  forecast is shorter than the boom, the boom closes toward it at a steady
  speed sized to *arrive as the obstruction does* (`gap / lookAhead`). Through
  the merchant house door that is a 17 m/s dolly-in with a worst single-frame
  step of 0.2 m, where the hard limit alone was a 7 m jump cut.
  - Sample *along* the way, not only at the end: under a lintel the boom is
    shortest for the metre just inside the door and longer beyond, so a single
    far sample walks past the minimum and the hard limit still lands as a jump.
  - A constant speed, not an exponential: an exponential close across a doorway
    starts at 60 m/s and reads as the cut it was meant to replace.
  - At rest the look-ahead costs nothing — it is skipped below 12 cm of forecast
    travel and a few degrees of forecast turn.
- **Hold, then settle back.** The return waits `recoverDelay` (0.3 s), then
  closes the gap proportionally, capped at `recoverSpeed`. The hold refreshes
  while an obstruction is still binding the boom, not only when it cuts:
  without that, something that flickers in and out (a fence, a colonnade, a row
  of market stalls seen edge-on) outlives the hold every other frame and the
  boom yo-yos.
- **The wheel glides.** `addZoom` moves a goal; the framing eases to it. A
  notch is scaled by the current distance, so about a dozen clicks run from the
  wide shot into first person and no single click is a lurch.
- **Hide the body with hysteresis.** Below `fadeTargetBelow` the body is out
  of the shot; it comes back a fifth further out than it left, so a boom
  hovering at the threshold cannot strobe the character.

## Looking up, and first person

`lookUp` / `lookDown` (degrees, on the rig block) bound the orbit. Past roughly
`asin(pivot height over the ground / distance)` the eye meets the ground and
**slides in along it toward the character** — which is how an MMO camera looks
at the sky. The band only decides how far that slide may go: 32° (the default)
keeps the boom near full length, the MMO scene authors 50°.

Rolled all the way in (`wantedFraming <= firstPersonBelow`) the rig is in
**first person**: the body is hidden and the look band opens to ±80°, because
there is no boom left to bury in the ground. Rolling back out walks the pitch
into the third-person band rather than snapping it.

## Only the mouse pitches the camera — and the "inverted Y" report

An earlier cut tried **rising over an obstruction** (adding pitch of its own)
before accepting a shortened boom. It is gone, and this is why: looking *up*
drives the eye into the ground, the boom compressed, and the rig "helpfully"
rose over the "obstruction" — so **pushing the mouse forward moved the view
down**. Measured in open country: a steady push forward raised the camera on 8
frames and left it parked 12.5° above where the mouse had asked for. Derek
reported it, accurately, as the Y axis feeling inverted; the sign of `addLook`
was correct the whole time. In a doorway the same logic pumped the camera up
and down as the lift engaged and released.

If a player really does want the flight-stick convention, `rig.invertY` flips
the vertical axis and nothing else.

## `height` is a pitch, not a translation

The authored `rig.height` is an **eye elevation**; the rig orbits
`rig.pivotHeight`. The difference between them is therefore seeded as a
**pitch** — a follow rig authored at height 2.4 over pivot 0.6 and distance 7.5
starts looking gently down at the character.

In `chase` the framing is rigid instead: the authored distance is horizontal,
the height literal, the boom the hypotenuse, and the pitch pinned to it.

## The body can be the jank

Not everything that looks like the camera is the camera. A capsule run at a low
lip — a door threshold, a kerb, the first stair — is thrown **up** by the
contact: its rounded foot has to climb the lip in the few centimetres it takes
to cross it. Measured at the merchant house: an 18 cm threshold at a 6.5 m/s
run left 3.9 m/s of rise, a **0.78 m hop through the front door**, head at the
lintel — and the camera, following the head, collapsed against the lintel with
it. The fix is in locomotion, not here: `groundFollowVy`'s `popCap`
(`stepPopCap` on the third-person controller, mirrored by the server's player
driver) takes back a rise the controller did not ask for. The hop is now 7 cm.
A script that launches a body on purpose sets `userData.liftUntil`.

## Traps

- **Never let `camera-controls` update on a frame the rig wrote.** It restores
  the camera from its own spherical state and the rig's pose is gone. Both
  hosts guard it (`if (!flyLookMode && !rigDrivesCamera) controls.update(dt)`).
- **Hand the pose back on leaving play.** `camera-controls` still holds the
  orbit from before play, so without a `setLookAt` from the rig's last pose the
  editor camera snaps across the world on the first drag.
- **Smooth Y looser than XZ.** A hill town is stairs; a pivot that tracks Y as
  tightly as XZ bobs once per step. Past `verticalSnap` it tracks immediately
  again, so a fall still reads as a fall.
- **Keep XZ tight.** The pivot trails by `speed / damping`; at the old 14 that
  was 0.7 m at a sprint, wider than the character, and it cut door jambs.
- **Hide the body every frame, not on change.** A scene rebuild restores
  `visible` from the entity doc and puts the head back in front of the lens.
- **`pitch` is the EYE's elevation**, so looking down means RAISING the
  camera: mouse forward has to LOWER the pitch. The sign is invisible in code
  and instantly obvious in the hand; `camera-rig.test.ts` pins both axes, and
  pins that a push forward never raises the camera even into the ground.
- **Re-applying an authored rig mid-session throws away the player's zoom.**
  `applyAuthored` reseeds framing and pitch, which is right on a scene change
  and wrong when `resolveFollowTarget` re-runs because a server spawned your
  body. The editor host only applies it when the (fitted) rig block changed.
- **Guard the target position for NaN.** Every comparison against a NaN pivot
  is false, including the teleport test that would re-seed it, so one bad frame
  freezes the camera for the rest of the session.

## Checking it in a town

`packages/render/test/camera-rig.test.ts` covers the math headlessly (fake
sweeps, including a small box world with a real doorway; no DOM, no physics).
**It is not enough.** Every feel bug this rig has had — the inverted-feeling Y,
the first-person slam in doorways, the stuck camera — was green in unit tests.
What catches them is a probe that *drives the input and reads back the pose*.

`apps/playground/projects/voxel-demo/tools/camera-probe.mjs` is that probe: it
drives the playground in headless Chrome, sweeps the mouse, finds a passable
door with physics queries, runs the real player in and out of it, and reports
the worst single-frame boom jump, peak boom speed, first-person slams, body
flickers, frames where geometry hid the character, the body's own hop, and the
rig's cost. Given an older copy of the rig it runs that in shadow mode on
identical inputs and prints both. Gotchas it already handles:

- Entering play **pins the body** until the landing terrain is in
  (`holdForPlayLanding`), so teleports are silently reverted; wait for
  `chunkManager.isViewReady()` and then verify the teleport actually stuck.
- Colliders only build around the **player**, so a straight teleport into a
  town 130 m away lands on nothing. Hop there in stages.
- A ground ray from the sky lands the body on a **roof**. In town, cast from
  head height.
- The agent-test vite config **caches engine source**; restart the server
  after every engine edit or you are measuring the old build.

## Mouse mode (the pointer is the player's)

The game runs in **cursor** mode by default: the pointer is free, it reaches
the UI and the rest of the machine, and holding **right** (or middle) over the
view turns the camera — the MMO convention. **Z** toggles **mouselook**, where
the mouse steers continuously; that one captures the pointer, because a cursor
that stops at the edge of the window cannot keep turning, and Escape, Z again
or leaving play all give it straight back.

Pointer lock is never taken on its own. It used to be: play mode captured the
pointer on entry and re-captured on every click, which is right for a shooter
and wrong here — it takes the mouse away from everything else on the machine
until the player works out that Escape is the way back, and it does it without
being asked. Both hosts (the editor's play mode and the published `play.ts`
runtime) behave the same way.
