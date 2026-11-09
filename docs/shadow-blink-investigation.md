# Shadow and armor blink: what has been tried

Film fault found and fixed 2026-11-07 (see "What the film showed"); a blink with no moving unit near it is still unproven. Derek sees shadows blink for 1-2 frames during turning or movement, and in Codex's promo film
(`weeping-sun-promo.mp4`, engine root, 30 fps) he sees a patrol unit's **armor and shadow blink in the first 20 seconds**.
Update this file as the fault is narrowed. Timing numbers belong in `docs/performance-lessons.md` once it is closed.

## What Derek reports

- It lasts 1 or 2 frames: "unless your looking at every frame you wont be able to replicate it".
- It happens while turning or moving, and it was seen before this round too ("we had that blinking issue with the shadoes before").
- He says it is "absolutely there" and a full system restart was still to be tried.
- Later clue: shadows stuttered while other units walked, and bodies vanished on hit. Both of those were real and are fixed below.
- In the film the blink is on a unit's ARMOR as well as its shadow, which points at more than the shadow map.

## What the film showed (2026-11-07)

The first patrol unit is `patrol-vestibule-watch/slot-0`, on the right of the vestibule, at the end of its route at about 9.3 s. Frames from `weeping-sun-picture.mp4`, numbered from 0:

- **Frame 280:** the body has swung about 80 degrees from frame 279. The shield is still where frame 279 drew it, edge-on, and the sword is missing from the empty hand. Frame 281 has both back on the body.
- **Frame 288:** the body swings again to face the camera. The sword keeps frame 287's angle and the shield is not on the arm. Frame 289 has them back.
- The body never disappears. Nothing vanishes: everything drawn by a moving batch (head, hair, helm, pads, sword, shield) is one frame behind the skinned body.

**Cause, two faults that multiply:**

1. **The network clock ran at a third of the server's tick rate.** `net-presence.ts` built `InterpolationClock` with `hz: 20` (the P2P host's rate), but a dedicated server numbers snapshots with its 60 Hz sim tick. The clock fell behind, passed the 8-tick snap line and snapped forward about every 0.25 s, for every remote body at once. Between snaps bodies walked at half speed. In a turn each snap is a 78 degree pop. It is why frames 280 and 288 are 8 apart.
2. **The editor host sampled the network after everything that reads a body.** `netPresence.update` ran after `animations.update`, late scripts, `movingInstances.update` and `updateCharacterGrounding`, and just before the draw. A skinned body reads its root at the draw; gear and the contact patch had already copied last frame's. So gear and the contact shadow share one mechanism, which is why armor and shadow go together and the body stays. The size of the error is the size of the step, so fault 1 makes fault 2 visible.

**Measured** (instrumented re-run of the capture, 641 frames, promo scene, both walkers):

| Run | Frames with gear behind the body | Worst gear error | Steps over 8 cm | Step per frame |
|---|---|---|---|---|
| A: before (the control) | 641 of 641 | 78.4 degrees, 0.16 m | 80, every 8 frames | 0.014-0.019 m, then 0.147 m |
| B: frame order fixed | 0 | 0 | 80 | same sawtooth |
| C: order and clock fixed | 0 | 0 | 0 | 0.032 m, even |

The server stream itself was smooth in every run: 0.0161 m and at most 8.9 degrees per tick. A turn in run C is 17 degrees a frame, with no pop.

**Live, not only the film:** real time, true 60 Hz server loop (59.996 ticks/s), default 20 Hz snapshots, 30 fps client, old clock values against new in one session. Old: steps lurch between 0.048 and 0.096 m (p10 0.010, p90 0.096). New: 0.033 m with p10 0.030, p90 0.062, and the larger steps are slow frames. This used the fixed frame order, so gear error in live play was not measured separately; it is the same `main.ts` frame order the film ran.

**Not proven:**
- Weeping Sun has no shadow-casting light: 201 lights, none casts, and no shadow pass ran. Its only character "shadow" is the contact patch. Its one-frame lag follows from the order, but it was not seen in a film frame, nor measured.
- Outdoors, the sun shadows of remote units step with these faults, which fits "shadows stuttered while other units walked". That was not measured. A blink with nothing moving nearby, on camera turn alone, is not explained by this.
- The film predating the cascade and first-hit fixes does not matter here: this scene runs no cascades, and nobody is hit in the first 20 s.

**Found, not changed:** `play.ts`, the published runtime, never calls `scripts.lateUpdate`, so `bone-socket` places gear only on the fixed tick and `character-look` pieces are not placed at all. It samples the network early, so the frame order is right there, and it gets the clock fix. Adding the call turns on every late script in a runtime nobody tested them in, and needs its own check.

**Dead ends this round:** the motion-robust detector (a pixel differs from both neighbours, which agree) was swamped by dust motes, flame and moving cracks. The whole-frame darkening at frames 597-598 and the shield going thin and wide are not faults: the first is light and haze, the second the arm swing. Tracked crops from `motion.json` and `route.mjs` are what found the frames. A `setInterval(1000/60)` server on Windows runs near 30 Hz and hides fault 1: use an accumulator.

## Faults found and fixed (these are not the open blink, unless the film predates them)

| Fault | Cause | Fix | Evidence |
|---|---|---|---|
| Creature body gone through a tell | each glow step wrote a new `emissiveNode`: a new shader, no draw until compiled | `applyModelEmissive` writes uniforms | 0 of 44 frames drawn before |
| Body gone when given a new material | async pipelines skip the draw until ready | `spreadShaderBuilds` draws the last material until the new one is ready | 3 alligators kept drawing |
| Body gone on first hit (rim-lit) | first glow gave the drawn material a new shader, with nothing to stand in | blend goes on a fresh copy; `glow: null` builds it too | 0 of 22 frames old way, 26 of 26 fixed |
| Walking unit's shadow stepped | cascades past the first redrew every 2nd/4th frame, and cascade 0 ends at 20.6 m | a cascade whose slice starts inside `skinnedShadowLimit()` renders every frame | 108 m cascade 99 of 99 frames; 284 m stays 27 of 99 |
| Gear and contact patch a frame behind the body; remote bodies snapped 4 times a second | see "What the film showed" | `setTickRate` from the server's `simMs`; network sampled before animation | gear lag 641 of 641 frames to 0, snaps 80 to 0 |
| Shadow edges crawled | sun moved a sliver each frame, turning every cascade's texel grid | held sun, stepped (`stepHeldSun`) | edges changed per frame with the clock on, not frozen |

## Tried, and did not find the open blink

- **905-frame lap test** at the Bell Strand spawn: same camera path flown for several laps, each frame compared with its own repeats. Frozen sun, standing player, worst 0.3% of pixels. Its blind spot: nothing walked, fought or animated near the camera, and the sun was frozen.
- **Adjacent-frame difference** as a blink detector: measures motion, not blink. Dropped.
- **Cascade gap at corners** with the stagger on: the far cascade misses a few metres, too small to explain it. An earlier larger figure was contaminated by the first frame.
- **Light budget:** interior candles past the budget are correctly hidden by interior place roots, not a pop. Slots and fog lamps now fade across their line (`budgetEdgeFade`).
- **AO:** a flat sky with AO on was weather. Toggling AO mid-game recompiles for several seconds, so it is not the 1-2 frame fault.

## Not ruled out

- `?shadowStagger=0` and `?asyncPipelines=0` were asked of Derek. No result came back.
- Skinned shadow range at 40 m (`skinned-shadows.ts`, 2 m hysteresis): a unit's shadow switches at once at the edge. Distance is judged per frame from the camera, so a turning or orbiting camera could cross it.
- Skinned shadow range flip: not seen in the film. Still open for outdoor scenes.
- Animation pose LOD and `animations.skip` (`skipMobPose`, `CROWD_POSE_LOD`): a mob held or stepped at a lower rate.
- Bounds: skinned frustum culling (`beginSkinnedBoundsFrame`), `hideNonRenderingBranches`, screen-size cull, shadow-camera culling of casters.
- Armor is separate meshes on the body (helm, shoulders, equipment looks), so it can fail apart from the body: per-part culling, `character-look` / `equipment-look` re-dressing, part masks, a look re-applied each time state arrives.
- The server sends `anim` every snapshot and the client applies it each frame. Since 2026-11-07 the server knows model clips (`packages/server/src/model-clips.ts`), so stance clips and carry layers now replicate. Any change there changes what a patrol does.
- Pipelines for the shadow pass: a depth or override material not ready leaves a caster out of a cascade with no stand-in (`spreadShaderBuilds` skips override materials).

## Method notes

- Count real draws by wrapping `renderer.backend.draw` (`h.renderer.renderer.backend`); a `QuadMesh` pass also uses an orthographic camera, so filter `isQuadMesh` when counting cascades.
- `tools/town-perf.mjs --scene X --port N` boots its own vite, with `--eval`, `--eval-after @file`, `--query`, `--at`, `--shot`. Never use :5173 or :5174.
- **Spawned mobs only exist under a server.** Start `packages/server`: `npx tsx bin/serve.ts --scene <id> --port <n> --no-persist --terrain-bake off`, and add `--query server=ws://127.0.0.1:<n>`.
- `kill` on that shell job stops only the `npx` wrapper and leaves the old server on the port. Use `taskkill //F //T` on the listening pid, and check the log for `EADDRINUSE`, or the run silently tests old code.
- `POST /admin/teleport {peerId, position}` moves a player; `peerId` drops the `player:` prefix. A teleport over unstreamed floor falls through it.
- Mobs sleep past 160 m from a player, and an asleep mob shows only its animator default.

## Evidence on disk

- `weeping-sun-promo.mp4` (engine root) and `apps/playground/projects/weeping-sun-tombs/reports/promo/` (`weeping-sun-picture.mp4`, the master picture; `capture.json`, `verification.json`).
- `apps/playground/projects/weeping-sun-tombs/reports/character-lighting/temporal-analysis.json`: Codex's own temporal analysis.
- Capture tooling: `apps/playground/projects/weeping-sun-tombs/authoring/promo/`.
