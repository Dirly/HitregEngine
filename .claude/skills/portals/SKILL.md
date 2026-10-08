---
name: portals
description: Install, fit and prove a walk-through portal (dungeon door, instance exit, zone boundary) — the `portal` builtin, portal-return, portal-veil, portal-cover (+ --fit), portal-trip, the real-client portal-play test and loading art. Use when a dungeon gets its world door or return portal, after any scene rebuild that touches a portal, when the `portals` / `portal play` row or stage fails, or when a player cannot get in or out.
---

# portals

Source docs: `docs/zone-pipeline.md` "Sites outside the quest plan" (portal paragraphs), `docs/hosting.md`
(portal builtin, PortalHarness, "Loading art"), `docs/scene-authoring.md` Portals. Every tool's header comment is
its manual (`apps/playground/tools/portal-*.mts`). Run from `apps/playground`.

## When
- A landmark's dungeon gets its world door, or an instance gets its way out.
- After `build-scene`, a re-install or any edit near a door (rebuilds drop hand-sized boxes; data survives).
- A `portals` / `portal play` row in `zonegen status`, or the `portals` / `portal play` dungeon stage, is not ok.

## Order (each step re-runnable)
1. **Return portal** in the instance: `npx tsx tools/portal-return.mts --project <p> --scene <inst> --exit <anchor>
   --to <world scene> <anchor>` (`back: true`, fallback destination for a traveller with no recorded way back).
   `--remove` seals it.
2. **Veil** (the shared swirl, both sides): `npx tsx tools/portal-veil.mts --project <p> --scene <id>` for the world
   scene AND the instance. Never hand-place a veil.
3. **Cover**: `npx tsx tools/portal-cover.mts --scene <id> [--portal <ids>]`; on failure `--fit`, which sizes trigger
   and veil from the rock, writes `authoring/portal-veils.json` (kept through rebuilds) and one ops batch with its
   inverse (`--undo <inverse>`).
4. **Headless trip**: `npx tsx tools/portal-trip.mts --scene <world> --portal <id> --exit <exit anchor>` (runs cover
   on both doors first).
5. **Real client, last**: `npx tsx tools/portal-play.mts --dungeon <instance>` (Playwright + system Chrome, W held):
   in through the world door and out, then a reload INSIDE and straight out. Reuse one vite with `--url` across
   dungeons; runs ~8-9 min; never beside a perf run.
6. **Loading art**: `npx tsx tools/loading-art.mts --project <p> [--view <name>]` (needs a dev server; painting goes
   through `image-request.mjs gen --paint`, never codex by hand).

## Gates: what a failure means -> the fix
- cover `TRIGGER` fails: a body can step past the sides or jump over the box (the box must catch the body CENTRE:
  0.9 m up walking, ~2.9 m at a jump apex, 0.4 m off each wall) -> `--fit`.
- cover `VEIL` gap / protrusion: opening shows past the veil, or veil shows over rock -> `--fit`.
- cover section OPEN: box/veil plane stands outside the mouth and can be walked round -> move the portal anchor
  onto a closed cross-section within ~1.5 m; `--fit` only RESIZES where it stands (a portal behind its doorway, in a
  wide hall, cannot be fitted: move it to the narrowest section first).
- Default box (2.4 x 2.6 m) or a box sized from a plan corridor number: unmeasured -> always run cover.
- portal-trip fails to arrive / lands > 4 m off the return anchor: wrong `--to` anchor, wrong `portal:<x>` tag pairing,
  or the exit sits inside the arrival point -> fix the anchors, rerun steps 1-2.
- portal-play fails while portal-trip passes: a client-only fault (arrival placement, curtain, collision on the way to
  the box, scene swap); its failure line says where the body stopped and the box distance -> fix that, never accept
  the headless pass. `portal play` goes STALE when either door changes: rerun, do not argue.
- Cover limits: render-only meshes without colliders are invisible to it; it does not look from the far side.

## Judgment (not checks)
- Each landmark owns its own dungeon; a dungeon has ONE door. Never point a second site's door at an existing instance.
- The door is a walk-through portal set deep in a real passage, the swirl on both sides; the swirl is one hue everywhere.
- A traveller has one recorded way back: two dungeons cannot link door to door; a second door needs its own return.
- Walk bodies with real input in tests; a teleport across a box is not a walk-in.
- Pictures of a world portal: wait for ground under the spawn to stream; place at the passage floor height, not the
  field height (a tunnel's field height is the hill on top).
