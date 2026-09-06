# Barriers, passes and sanctuaries — making a generated world net-codable

**Status: BUILT (2026-09-06), all five steps.** Decided with Derek on
2026-09-05/06 after zone-scoped layers shipped (`docs/hosting.md` → "Zones",
`packages/server/test/zones.test.ts`); built the same day. Nothing in this
document changes the cluster's rules — it changes the WORLD so those rules
produce a good game. Tests: `packages/core/test/{barriers,borders,regions}.test.ts`,
`packages/server/test/{sanctuary,party-chat,zones}.test.ts`,
`packages/comms/test/party.test.ts`; the demo world carries the result.

**What practice changed from the design below** (the text is left as decided;
these are the deviations, each with its reason):

- **Border samples match at 48 m, not 2 m** (`--border-tolerance`). The draft
  simplifies each zone's outline on its own, so two neighbours' polygons sit
  up to a grid cell apart along a shared edge; at 2 m the audit saw 15 m of a
  1.5 km border. The ridge is built on the first zone's outline; its flanks
  (72 m) cover the gap between the two.
- **There is no `recipe.snowLine`.** The cap is read off the biome height
  windows: the lowest `height[0]` of a snow-topped biome that is NOT gated to
  climate zones (tundra is snow by latitude, not altitude), else the ceiling.
- **A crest is capped at 3× `height`**, and a plateau already above the cap
  still gets the minimum ridge. Measured literally, "above the higher flank"
  built a 357 m wall at a cliff foot, and the cap left every high border open.
- **A town zone is `within` its wilderness zone, not cut out of its polygon.**
  A simple polygon cannot hold a hole; `regionAt` prefers the nested zone,
  the audit treats the pair as neighbours, and the town's polygon is a 12-gon
  at radius + falloff + 4 m. The sanctuary list publishes a town as the
  circle round its hub that covers every vertex.
- **Far more open ground than "two of seventeen".** Under the classifier's
  thresholds the demo had 39 open runs on 21 borders (≈ 22 km of border, a
  third of it open); the stage wrote 71 ridges. The two the eye had found
  were the longest.
- **Cross-layer party chat** rides the existing bridge with a party scope
  MAIN resolves, and main pushes each member's party into their layer's
  netState so the local routing rule works unchanged (docs/comms.md).
- Two admin routes were needed to verify it: `GET /admin/players` and
  `POST /admin/teleport` on a layer (docs/hosting.md → admin table).

## The problem this solves

A zone border is now a server line: past the band, a player is handed to a
copy of the zone they walked into. That is invisible only if nobody can
see across the border. Today `worldgen zones` drafts borders by a cost
flood that prefers rivers and ridges, but where the terrain offers
neither, the border runs over open ground — two of seventeen do in the
demo world. And rivers are **authored by the agent, not generated**, so the
generator cannot count on them being where a border needs one.

Derek's framing: *we are not only building the netcode, we are building the
world generator that produces a world the netcode can host.* Rivers form
first, then zones are drawn around them, and whatever is still open has to
become a barrier. Chokepoints follow from that — and chokepoints are where
PvP happens, which is both the fun and the danger.

## Decisions

1. **Barriers are written into the recipe, not hoped for.** A new feature
   kind, `ridges`, raises terrain along a polyline. The `barriers` stage
   walks every zone border, classifies it, and writes ridges over the open
   runs. The recipe stays the world save; a ridge is a few lines of JSON
   like a canyon.
2. **Passes are deliberate.** A ridge is broken wherever a footpath already
   crosses that border, wide enough that the path's ground is untouched.
   A zone pair whose shared border has no path crossing at all still gets
   one pass at the run's midpoint, so no border is ever a complete wall.
   Passes are the chokepoints; the transfer band lives there.
3. **Every pass gets a waystation POI**, and the waystation is a small
   **sanctuary**: no player may damage another inside its radius. NPCs are
   already excluded by the band rule. The radius is small (35 m) — a
   breather at the exact spot where a player is briefly on another server
   and landing, not a safe road. The chase across a mountain range stays;
   you cannot be killed *at the swap*. Sanctuaries are PvP-only, and a
   flag turns them off for a world that wants none (`--no-safe`).
4. **The audit is quantitative.** `worldgen regions` measures every shared
   border: metres of water, steep ground, canyon, coast, ridge, and OPEN.
   Open runs of 60 m or more are findings (exit 1). After `barriers` the
   only open ground on a border is inside a pass, which is listed, not
   flagged.
5. **Pipeline order** becomes `init → canyons → rivers (authored) → towns →
   zones → paths → barriers → pois → trails → caves → map`. Barriers come
   after paths because passes are cut where paths cross; pois after
   barriers so waystations exist when the pois stage places its own.
   Re-running `zones --force` after rivers move invalidates barriers:
   `barriers` is idempotent (ids `barrier-<a>-<b>-<n>`, `pass-<a>-<b>-<n>`)
   and rewrites its own features only.

## Towns are zones of their own (decided 2026-09-06)

Derek: a town in the middle of a wilderness zone is where players actually
gather, and it is also where PvP cannot sensibly be enforced. So a town is
its OWN zone: a small region drawn on the town's outskirts (its wall or
palisade line, or `radius + falloff` for a town without one), with

- a **higher cap** than a wilderness zone — a town simulates no packs, so
  a copy of it is cheap; default `cap` 3× the wilderness cap (120 at 40),
  set per region as usual. Everyone in a region who goes to town lands in
  the same copy until it is full, which is what "feels populated" means;
- **the whole town a sanctuary** (`safe` on the town region, honoured by
  the same combat rule as a waystation): no player damage inside. A chase
  ends at the gate — that is the classic rule and the intended one;
  pursuers who wait outside are the game working;
- **gates as passes**: the town zone's border crosses each road out of
  town at a gate; the pass sanctuary extends 35 m OUTSIDE the gate so gate
  camping cannot kill someone mid-swap. No ridge is built on a town border
  (the wall or the outskirts are the barrier; a swap at a gate is a swap in
  a doorway, invisible by construction).

Consequences the build must respect: `worldgen zones` seeds one region per
town AND the wilderness region around it (the town polygon is cut out of
its wilderness zone — regions never overlap); `auditRegions` stops
reporting "no town inside" for wilderness zones that contain a town zone,
and reports a town whose polygon lies in no zone at all; placement treats
a town zone like any other (a party leaving town through the same gate is
co-placed by the party rule, strangers may not be — Diablo's trade-off,
accepted); the old edge case "a border through a town is a finding"
becomes "a town not fully enclosed by its own region is a finding".

## The `ridges` feature

```jsonc
// recipe.features.ridges[]
{
  "id": "barrier-zone-7-zone-11-2",
  "points": [[5350, 3911], [5402, 4260], [5494, 5014]],   // world metres [x, z]
  "height": 35,     // metres ABOVE natural terrain at the crest
  "width": 24,      // crest width (flat top)
  "falloff": 60,    // horizontal distance the flanks take to meet natural ground
  "heights": [35, 42, 35],   // optional per-point crest heights
  "tags": ["barrier", "zone:zone-7", "zone:zone-11"]
}
```

Evaluation (`field.ts` `applyFeatures`): after canyons, before water and
towns. `raised = natural + height * profile(d)` where `d` is distance to
the polyline, `profile = 1` inside `width/2`, then `1 - smoothstep(0,
falloff, d - width/2)`. **Raise only** (`out = max(out, raised)`), so a ridge
never digs, and a ridge crossing a river bed stays out of the water because
the river's cut runs later in the chain and rivers are excluded from the
sampling anyway. Polyline ends have round caps of radius `width/2 +
falloff`, which is what makes a gap between two ridge pieces a saddle: the
**pass width** must be at least `width + 2·falloff + pathWidth + 2·shoulder`
so the path's tread and shoulders sit on natural ground (with the defaults,
≈ 24 + 120 + 2.4 + 16 ≈ 165 m of gap; the ridge tapers into it from both
sides, which reads as a col, not a doorway).

Other consumers: `featureFootprint` in `terraform.ts` (bounds = points ±
`width/2 + falloff`) so a terraform edit re-cooks the right cells;
`featureClearance` treats a ridge crest like a canyon rim so scatter does
not stand a tree on a knife-edge; `heightRange` includes ridges (it already
scans additive blobs). Spec regeneration picks up the schema.

Sampling rule for `heights`: the stage sets each point's height so the
crest sits at least `height` above the HIGHER of the two flanks measured
`falloff` out on either side — a 35 m ridge on a 30 m slope is a step, not
a wall, unless it is measured that way.

## The `barriers` stage

```
pnpm -F playground worldgen barriers <world> [--min-run 60] [--sample 15]
    [--height 35] [--width 24] [--falloff 60] [--pass-width auto]
    [--no-safe] [--sanctuary-radius 35] [--dry]
```

For each pair of regions that share border geometry:

1. **Sample** the shared edge every `--sample` metres (walk each polygon
   edge; a sample belongs to the pair whose other polygon is within 2 m —
   the draft's simplified outlines share vertices but not always segments,
   so match by proximity, not identity).
2. **Classify** each sample with the world field:
   - `water`: `field.waterY(x,z) !== null` or `shoreDistance < 6`
   - `canyon`: within `width/2 + rim` of a canyon polyline
   - `steep`: `field.slope(x,z) > 0.7` (≈ 35°) **or** the height difference
     across ±25 m perpendicular to the border exceeds 18 m — a ridge line
     you cannot see over, not a hillside you can
   - `coast`: `field.height(x,z) <= seaLevel + 2` or beyond the world limit
   - `ridge`: within `width/2 + falloff` of an existing `ridges` feature
   - `town`: inside a town's `radius + falloff` — never build here: the
     town is its own zone and its border is a wall or a gate, not a ridge
   - `open`: none of the above
3. **Runs**: consecutive `open` samples; keep runs ≥ `--min-run`. Bridge
   single non-open samples inside a run (a puddle does not end a wall).
4. **Passes** on a run: every footpath (`features.roads`) that crosses the
   run gets a pass centred on the crossing point; passes closer than one
   pass width merge. A pair with **no** crossing anywhere on its border
   gets one pass at the midpoint of its longest open run. A pass wider
   than the run leaves the run unbuilt (and listed as a pass).
5. **Write**: the run minus its passes as one or more `ridges` entries;
   one `pois` entry per pass: `{ id: "pass-<a>-<b>-<n>", kind:
   "waystation", position: [x, groundY, z], rotationY: <along the path>,
   radius: 35, tags: ["pass", "safe", "zone:<a>", "zone:<b>"] }` (`safe`
   omitted with `--no-safe`). `--dry` prints the plan and writes nothing.
6. **Idempotent**: every existing `barrier-*` ridge and `pass-*` poi is
   removed first, then rewritten from the current borders.

Print per pair: border length, metres by class before and after, ridges
written, passes and their positions. Then run the regions audit and exit
with its code.

`poiSchema` gains `radius?: number` ("area of effect for kinds that have
one — a waystation's sanctuary circle").

## The audit (`worldgen regions`)

Adds to today's report, per shared border pair: `length`, a class
breakdown, the open runs ≥ 60 m as findings with their x/z extents, and
the passes on that border. `auditRegions` in core stays pure; the
classification needs the field, so it lives in the tool
(`worldgen-audit.mts` or a new `worldgen-borders.mts`) and takes a
`classify(x, z)` callback — unit-testable with a fake.

`worldgen map`: open runs drawn **red**, passes as a small white diamond
with the pass number. A world is ready for hosting when the map shows no
red on any border.

## Runtime: sanctuaries and the chase

- The layer publishes `sanctuaries/list` in netState once at boot: every
  poi tagged `safe` as `[x, z, radius]`. Replicated, tiny, readable by any
  script on any peer. Core helper `sanctuaryAt(list, x, z)`.
- voxel-demo's `combat-actor` refuses a hit when **both** source and target
  are player-owned bodies (`owner/<id>` in netState) and either stands in
  a sanctuary. NPC damage is untouched; the band and the landing grace
  already handle NPCs at a pass.
- Nothing else changes: the transfer lock, the arrival check and the
  landing grace apply as before. What the sanctuary adds is that the one
  spot where a player is provably alone on a copy for a moment cannot be
  the spot they die.
- **The chase policy, stated:** a pursuit across a border is allowed and
  expected. Both fighters stay on the origin server while locked; the
  runner gets a 35 m circle at the pass and nothing more; the pursuer can
  wait outside it on either side. Loot-carrying runs across a range are a
  feature. What is not allowed is dying to someone you cannot see, which
  is the only thing the sanctuary prevents.

## Edge cases the build must handle

- **A border along a river the agent later moves.** `zones --force`
  redrafts; `barriers` rerun removes stale ridges by id. A ridge that was
  built on a run that is now water is deleted, not kept (classification
  runs before writing).
- **A ridge would cross a path that is not a border crossing** (a path
  running parallel then across). Any path within `pass width` of the run
  gets a pass; the stage does not distinguish "crossing" from "near".
- **Two runs on the same pair separated by a short river.** Separate
  ridges, one pass each only if a path crosses each; otherwise the pair's
  single guaranteed pass goes on the longest run.
- **Towns.** Their own zones (above); a town border gets no ridge, and a
  town whose region does not enclose its `radius + falloff` is a finding.
- **Coast borders.** `coast` is a barrier class; a zone that is an island
  (Frostcrag, Greenspire) has no land border and no passes. Its "pass" is
  wherever the game puts a boat later — out of scope.
- **Ridge over a spawn area.** Spawn areas are scene entities the generator
  cannot see. The layer's boot warning (`SpawnAreaManager.borderWarnings`)
  already lists areas whose reach crosses a border; after barriers the
  band around a ridge is dead ground by construction, and only passes need
  the check. Keep the warning.
- **Pass width vs. cell size.** A 165 m gap spans 3–4 cells at 48 m; the
  ridge's round caps must be sampled by `featureFootprint` so both cells
  re-cook on a terraform edit.
- **Performance.** Ridges use the same segment buckets as canyons; a world
  with ~40 ridges costs what 40 canyons cost, which is nothing measurable
  (`worldgen stats` before/after must agree within noise).
- **Height cap.** Never raise a ridge above `recipe.snowLine + 40` or into
  a lake outline: clamp per point, and skip samples inside lake outlines
  entirely.
- **A pass with no path yet** (the pair had no crossing). `paths` was
  already run; the guaranteed pass is a gap in the ridge with a waystation
  and no path. Re-running `paths` after `barriers` routes through it
  naturally (the grade cap steers paths into cols). Document: run
  `barriers` then `paths` once more if a world shows a pass with no path.

## Build plan (in order; each step green before the next)

1. **core**: `ridgeSchema` + `RidgeDoc`, `features.ridges`, `applyFeatures`
   raise, `featureClearance`, `heightRange`, terraform `FEATURE_KINDS` +
   footprint, `poiSchema.radius`, `sanctuaryAt`. Tests: a ridge raises the
   crest by `height` and leaves the ground `width/2 + falloff` away
   unchanged; a gap between two pieces leaves the path's ground
   unchanged; footprint bounds; `sanctuaryAt`. `pnpm spec`.
2. **tool**: border sampling + classification (`worldgen-borders.mts`,
   with the `classify` callback), `commandBarriers`, the audit extension,
   the map's red runs and pass diamonds, `all` order. Self-check: run on
   `voxel-demo` — the two open borders (Rustcliff/Snowcrown at roughly
   x −2400…−1500, z −2100…−1500; Longmere/Saltdune near x 5350…5494,
   z 3911…5014) get ridges and passes; `regions` exits 0; the map shows
   no red; `worldgen audit` still exits 0 (rivers untouched).
3. **runtime**: `sanctuaries/list` publish in `serve.ts`, the combat-actor
   rule in voxel-demo, a socket test in `packages/server/test` that a
   player-on-player hit inside a sanctuary is refused and one outside is
   not (the field scene given one sanctuary poi via `regions`-style
   override — add a `pois` override option next to `regions`).
4. **docs**: zones.md (barriers step between "name" and "audit"; the
   sanctuary trade-off), hosting.md (one paragraph under "Crossing a
   border" pointing here), CLAUDE.md worldgen line (`barriers` in the
   stage list), voxel-worlds.md feature list. Memory: update
   `hosting-topology`.
5. **Verify in the browser** on `mmo`: a player walks a pass, sees the
   ridge on both sides, the waystation prefab (any placeholder prop), and
   the transfer lands them in place. Screenshot both sides.

## Open, deliberately

- The waystation's look (a prefab id per project; the stage writes
  `kind: "waystation"` and the pois stage or the agent assigns a prefab).
- Whether a pass should also carry a spawn area for guards (an NPC
  presence that makes it feel like a border post). Needs the band audit
  to allow non-hostile spawns; not now.
- Zone-scoped chat already works at passes; a "you are entering …" line
  when the zone changes is one event on the layer (`zone.entered`), cheap
  and worth doing in step 3.
