# Statue Maker

An engine-hosted first-party tool for freezing a character or creature into a
static stone sculpture. `statue.mjs` is the shared implementation used by the
CLI and registered `hitreg.statue-maker` host. Geometry stays in the source
shape; the tool changes poses and scale, then calculates smooth vertex normals.
It adds no facial features, subdivisions, ornaments, or replacement anatomy.

Library entry: `buildStatue(recipe, readModelBytes, options?)` returns
`{model, prefab, report, triangles}`. `readModelBytes(assetId)` may be async.
For pedestal builds, `options.pedestalPrefab` supplies the actual pedestal
document; the CLI reads it automatically. `humanRecipe(catalog, choices)`
compiles a human profile into an ordinary explicit recipe.

The tool needs the engine workspace's installed Three.js, tsx and core schemas,
plus the first-party WFC glTF writer. Source models and generated content belong
to the target project's assets, never this distribution directory. No source
character art ships with this tool. Run commands from the engine root.

## Inspect and freeze a creature

```powershell
node tools/statue-maker/cli.mjs inspect --assets PATH/TO/assets --model creatures/wolf.glb
node tools/statue-maker/cli.mjs build --assets PATH/TO/assets --recipe PATH/TO/wolf.json --report PATH/TO/report.json --preview PATH/TO/clay.png
```

A minimal recipe:

```json
{
  "version": 1,
  "name": "statues/wolf",
  "height": 2,
  "materialId": "stone",
  "body": { "model": "creatures/wolf.glb" },
  "pose": { "kind": "clip", "clip": "Idle", "time": 0.4 }
}
```

`inspect` gives actual part names, bones and clip durations. Omit `body.parts`
for the whole mesh. `pose.kind: "rest"` freezes the source pose; `clip` samples
one existing source clip at a time in its duration. Optional `pose.rotations`
maps actual bone names to local XYZ Euler offsets in degrees, applied after the
pose. All skinned and morph vertices are evaluated before export. The output
contains no skin, skeleton, animation, source texture page or atlas-painted face.
Inputs must be GLB or self-contained glTF; external buffer URLs are refused.

The output height measures the full figure, including head attachments. Scaling
is uniform and its lowest point is y=0. Its source X/Z origin and facing survive.
Imported nonhuman models therefore keep their own orientation; the bundled human
profile is Y-up and faces +Z. This is not automatic rig retargeting or arbitrary
creature posing: custom rigs use their own source pose, clip, or explicit bone
rotations.

## Human profiles

```powershell
node tools/statue-maker/cli.mjs human --catalog PATH/TO/assets/creation/creation.json --out PATH/TO/recipe.json --name statues/scholar --height 3 --material stone --sex female --hood yes --robe yes --shoulders simple --sword-model weapons/greatsword-uber.glb
```

`human.mjs` consumes a compatible modular-human creation catalog. It selects
actual male/female body and head parts, sex-specific mounts, and the catalog's
mirrored shoulder placement. Hair stays when hood is off; selecting a hood
suppresses covered hair. Robes use the front/back robe parts and exclude the
back tasset. Shoulder choices are `none` or the plain `ShoulderBase1`, with no
rims, accents or ornate parts. `hairParts` and `sources` can be supplied through
the library to adapt a compatible kit; every chosen part and bone is validated.

The generated recipe records explicit source models, named parts, mounts, arm
bone mapping and targets. Review it before building a different rig. The current
human profile supplies the CC rig's two-hand sword-rest pose; it does not claim
to fit other skeletons automatically. IK rejects unreachable targets.

The optional point-down `sword` uses a source whose blade axis is +Y, broad axis
Z and thin axis X. Its `parts` list is explicit. `pommelHeight`, `front`, `width`
and `depth` are dimensions in the unscaled figure's source units, not output
metres. They scale uniformly with the figure. Sword tip y=0 and both arm targets
are recorded in the report. Source part-rule conflicts fail the build.

## Output and replay

The result is `models/<name>.gltf` and `prefabs/<name>.json`. A prefab has an
empty foot anchor, a static mesh child, shared material reference, and exact
trimesh collision using that same mesh. Prefabs are authored through core ops
and schema validation. Materials must exist in the target project; the tool
does not copy or invent textures. Terrain-splat materials receive a constant
second-layer weight (`[0,1,0,0]`); use that layer for the stone texture, or use a
standard shared material. Texture density remains the material's responsibility.

Each build reports source SHA-256 hashes, exact bounds, dimensions, triangle
count, IK error and pedestal bearings when present. Keep the recipe beside the
report. Rebakes require `--replace yes`; registered runs refuse existing output
names. No scene is edited or installed by the tool.

`--preview` produces front, side and three-quarter neutral-clay renders directly
from the exported POSITION/NORMAL attributes. It verifies smooth shading and
silhouette, but is not evidence of the final material, lighting or in-world fit.

## Reusable DC pedestal

An optional `pedestal` is `{ "prefabId": "stone/plinth", "model":
"stone/plinth.gltf", "height": 1.8 }`. It nests the existing anchored pedestal
prefab and lifts the sculpture by its height. Supply the static baked model in
exactly the pedestal prefab's local frame, with its bottom at zero and its top
at the declared height; the tool checks these against the geometry. It raycasts
the lowest left/right figure and sword bearing samples against the actual
pedestal triangles, rejects overhangs and gaps greater than 0.06m, and records
every support hit. The pedestal prefab must reference that same mesh at identity
transform. The CLI reads the destination prefab and rejects a mismatched model,
nonidentity transforms, extra mesh geometry or nested prefabs. Retain the
builder's original DC extraction evidence with the pedestal asset.

## Registered host and portable bundles

The dev server discovers installed tool manifests when it starts. A server that
was already running when this tool was added needs its next normal restart
before Statue Maker appears in the editor menu. The CLI is available immediately.

```powershell
node tools/statue-maker/cli.mjs pack --assets PATH/TO/assets --recipe PATH/TO/recipe.json --out PATH/TO/statue-bundle.json
```

Choose this JSON in the registered tool's file input. A bundle contains
`{recipe, models:{assetId:base64}}`, plus the exact pedestal prefab document and
its SHA-256 when present; it makes sources portable without adding
project-specific filesystem paths to the tool or requiring an undeclared host
asset reader. Existing material and pedestal references still resolve in the
destination project. The registered host checks the bundled prefab/model
relationship and actual bearings, but cannot read the destination prefab to
certify it matches the bundle; this limit appears in its warnings and report.
The CLI checks the actual destination file. The host writes all outputs through its permission-checked
asset writer and keeps recipe/report/clay preview in its run record.

## Verification

`node --test tools/statue-maker/self-test.mjs` checks frozen skin displacement,
smooth normals and source boundaries, height and anchored collision, bad
parts/rigs/clips, sex/hood choices, real pedestal bearing failures, and registered
writer contracts. Root `pnpm test` includes these tests. Project-specific art
proofs are deliberately outside the tool distribution.
