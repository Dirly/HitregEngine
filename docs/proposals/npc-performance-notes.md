# NOTES: making NPCs, mobs and other players cheap

Status: notes, not a plan. Written 2026-10-02 after the first town with residents halved the frame
rate. The owner's call: finishing one zone comes first; this is the backlog to return to.
Residents, mobs and other players are the same problem: many animated characters on screen.

## What was measured (scene `proving`, Tidewell square, headless WebGPU, CPU-bound, GPU ~2.5 ms)

| Scene | Frame median | Draws |
|---|---|---|
| Buildings, quay, statue | 8.5 ms | 425 |
| + 25 residents | 17.0 ms | 503 |
| + furnished interiors only | 9.2 ms | 460 |

The cost is each resident's ANIMATED BODY: about 60 draws, about 49 shadow draws, about 2,050 bone
updates and 88 attachment calls per frame, plus about 200 KB of bone data uploaded per frame.
Outfits, heads and hair already batch across characters. Nameplates and the talk UI cost ~0.2 ms.
`docs/town-npcs.md` budgets 10-15 residents per town; Tidewell has 25.

## Being done now (contained fixes)

- Shadow casting for animated characters limited by distance.
- Animation level of detail: a distant character's pose evaluated at a reduced rate.
- Culling emitted by the resident generator; residents inside a building hidden from outside.
- A repeatable per-town probe report (`tools/town-perf`), for a budget gate later.

## The backlog, in the order worth doing

1. **Never animate what is not seen.** A culled, hidden or interior-hidden character must skip its
   animation mixer, bone update and attachment upkeep entirely. Cheapest large win; check first.
2. **Pose sharing for idlers.** Every character playing the same idle clip on the same rig can read
   one evaluated pose (with a per-character time offset bucket). A town of standing residents or a
   field of grazing animals then costs a handful of pose evaluations, not one each.
3. **One draw per body model (instanced skinning).** All bodies that share a mesh drawn in a single
   instanced call, with each character's bone matrices as a row in one bone texture. This is the
   real fix for draw calls and for the per-frame upload, and it matches the project's draw-calls-first
   rule. Large: touches the render adapter's skinned path, shadows, picking and culling bounds.
4. **Baked vertex animation for crowds and small creatures.** Bake each clip into a texture and
   animate in the vertex shader: no CPU bones at all, instancing is trivial. Ideal for the standard
   wildlife a zone is filled with (mice, crocodiles, skeletons at range) and for far residents. The
   low-poly, stepped-animation look suits it. Medium to large; needs a bake tool per rig and a
   hand-off rule to the full rig when a creature is close or in combat.
5. **Cheap shadows.** A blob or decal shadow for characters beyond the near range and for small
   creatures at any range; real shadow casting only for the nearest few.
6. **Fewer bones at range.** Collapse fingers, face and cloth chains with distance (one mob rig has
   77 joints). Pairs with 2 and 3.
7. **Far characters as impostors.** The engine already has octahedral impostors for props; an
   animated flip-book impostor for far mobs and far players removes skinned draws beyond a distance.
8. **Budgets, enforced.** A cap on fully animated characters in view (nearest N full, next M
   reduced, the rest impostor or hidden), per-zone spawn density that respects it, and the town
   probe as a gate so a town or camp cannot ship over budget.
9. **Server and network side.** Mob brains think at a reduced rate when no player is near and sleep
   when none is in range (spawn areas already wake by proximity); replicate only characters inside
   a player's interest radius; clients interpolate. This is what keeps hundreds of mobs and many
   players affordable regardless of rendering.
10. **Attachments.** Update a character's held items, sockets and nameplate only when it is visible
    and near; pool nameplates.

## Measure before each step

Use the town probe at the same camera, three runs, and the profiler's own bottleneck line. Report
frame median and p95, draws, shadow draws, animated bodies and bone updates. `docs/performance-lessons.md`
holds the method and the traps already found.

## Result of the contained fixes (2026-10-02) and the hand-off

Shipped: `skinnedShadowDistance` (default 40 m; `packages/render/src/skinned-shadows.ts`), `holdBones`
(bone and outfit upkeep skipped between a distant character's pose updates; `packages/render/src/animation.ts`,
read by `instancing.ts` and `moving-instances.ts`; the `character-look` builtin is in `packages/scripting/src/builtin.ts`), screen-size culling and an optional `place.inside` on residents
(`apps/playground/tools/town-npcs.mts`), and the probe `apps/playground/tools/town-perf.mjs`
(`--legacy` turns the first two off for a before/after). The gain was SMALL and inside the noise
of a busy machine: frame median 23.8 -> 22.2 ms, shadow draws 381 -> 365, bone walk 1.74 -> 1.38 ms,
outfit upkeep 0.59 -> 0.36 ms. Ten of Tidewell's residents stand within 30 m of the square, so the
distance rules barely apply there. The honest conclusion: distance tricks do not fix a town square.

The real fix is item 3 above (instanced animated bodies). Outline from the investigation:
1. Build on: one shared body model per sex; item batching that already draws all instances of a
   model in one draw; per-instance part masks and appearance.
2. Write: an instanced, skinned body draw; each body's bones in one shared texture its slot reads.
3. Per-body bounds and pose level of detail feed the slots; heads, hair and gear follow bones read
   from that texture.
4. Shadows then cost one draw per pass.
5. Size: about one to two weeks.
6. Risk: blended and layered combat animation, attachment sockets, three.js node-shader limits on
   bone counts.

## Brief for the agent that takes this over

Goal: animated characters (residents, mobs, other players) stop costing a draw set and a bone upload each.
Deliver backlog item 3, instanced animated bodies, and items 1 and 2 on the way if they are cheap.

- Read first: this file, `docs/performance-lessons.md`, `ARCHITECTURE.md`, the draw-calls-first rule
  (repeated visuals batch from version one), then `packages/render/src/{animation,instancing,moving-instances,skinned-shadows}.ts`.
- Baseline before any change: `node apps/playground/tools/town-perf.mjs --scene proving` (three runs, same
  camera; `--legacy` turns the 2026-10-02 savings off). Report frame median and p95, draws, shadow draws,
  animated bodies and bone updates after every step.
- Done means: Tidewell square with 25 residents within about 1 ms of the no-residents frame, one body draw and
  one shadow draw per body model, combat animation layers, held items, heads, hair and gear still correct,
  picking and culling bounds per character, `pnpm test` and `pnpm typecheck` green.
- Hard limits: never use or restart the dev server on :5173 (start your own vite on 5390 or above); do not edit
  `proving.scene.json`, `mmo.json`, `mmo.scene.json` or anything under `authoring/` (the zone build writes
  those); no git checkout, stash, reset or commit; engine code only (`packages/render`, `packages/scripting`,
  `apps/playground/src`), no scene content.
- Known risks: blended and layered combat animation, attachment sockets reading bones, three.js node-shader
  limits on bone counts (one mob rig has 77 joints), WebGL fallback.
