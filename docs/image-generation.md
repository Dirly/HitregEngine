# Image generation

Agents working in this repo cannot draw. The Codex CLI can, and it runs headless on this machine, so an
agent can get a picture made inside its own turn — no human in the loop. `apps/playground/tools/image-request.mjs`
is the only entry point; it owns the prompts, the verification and the provenance record.

Use it for texture tiles, prop and gear art, and the plan/section/concept reference images the dungeon and town
workflows ask for. It does not produce normal, roughness or metallic maps — those are material settings recorded
alongside the asset (see `docs/dungeon-materials.md`), not something an image generator hands you.

## The command

```
cd apps/playground

# one image
node tools/image-request.mjs gen --id flagstone \
  --target projects/<name>/assets/textures/flagstone.png \
  --size 512x512 --purpose "floor role" --prompt-file /path/prompt.txt \
  [--ref projects/<name>/assets/textures/wall.png] [--alpha] [--timeout 900] [--force]

# a whole set in ONE session (cheaper and more consistent than N runs)
node tools/image-request.mjs gen-set --manifest /path/set.json [--timeout 1800]

node tools/image-request.mjs list          # every request and its status
```

`gen` blocks until the PNG exists, then prints JSON: `seconds`, and per image `target`, `bytes`, actual
`size`, `alpha`. Exit 0 means every image was written and verified; 1 means at least one failed (the reason is
in the JSON and in the request record). Exit 4 means the Codex CLI is not on PATH — fall back to the queue below.

A `gen-set` manifest is either a bare array of images, or an object with a `brief` prepended to every prompt —
which is how a texture set keeps one theme across eleven tiles:

```json
{
  "brief": "Dungeon theme: damp volcanic basalt, cold grey-green palette, heavy wear. PSX-era pixel art, straight-on flat lighting, no baked highlights or directional shadows, no perspective. 2 m per tile.",
  "images": [
    { "id": "floor-flagstone", "target": "projects/x/assets/textures/floor-flagstone.png", "size": "512x512",
      "prompt": "Seamless tiling floor of irregular flagstones with mossy mortar joints." },
    { "id": "torch", "target": "projects/x/assets/props/torch.png", "size": "512x512", "alpha": true,
      "prompt": "A wooden wall torch seen from the side, lit." }
  ]
}
```

Per-image keys: `id`, `target`, `prompt` (required), plus `size`, `alpha`, `ref`, `purpose`. `target` and `ref`
resolve against `apps/playground`.

## What it verifies

The generator is told the exact pixel size, but it renders large and downsamples, so it can hand back the wrong
thing. The tool reads the PNG header and refuses anything that is not a PNG, is not the requested size, or — with
`--alpha` — has no alpha channel. Generation runs in `.hitreg/image-staging/`, and only a verified PNG is copied to
`target`; anything else the generator wrote alongside it (it likes to leave a notes file) is discarded and listed
as `discardedStrays`. Never run `codex exec` by hand with a project folder as its cwd — that is how prompt logs end
up committed next to art.

Prompts live in the request record under `.hitreg/image-requests/<id>.json` (gitignored), never in a project
folder. Project manifests reference request ids.

## Writing the prompt

- **Say the style every time.** The default look for this game is PSX-era pixel art — see the
  [PSX style](../CLAUDE.md) convention. Say "straight-on, evenly lit, no baked highlights, no directional shadows,
  no perspective" for anything that becomes a texture; the generator adds cinematic lighting otherwise.
- **`--ref` locks palette, grain and pixel density — not layout.** A flagstone tile passed as reference for a
  basalt tile returns basalt in the same palette and grain, but with its own masonry cut. Describe the layout you
  want in words; use the reference for the look.
- **Seamlessness is claimed, not guaranteed.** Ask for it, then check by tiling the result before it ships.
- **Alpha needs demanding.** Pass `--alpha` (or `"alpha": true`) and say "fully transparent background, real PNG
  alpha, not white, not a checkerboard" — the flag also makes the tool reject an opaque result.
- **Nearest-neighbour on the downsample** is in the shared brief already; it is what keeps pixel art crisp.

## Cost and shape of a run

One image is about 90 seconds and ~25k Codex tokens; a reference image roughly doubles the tokens. Several images
in one `gen-set` share a single session, which is both cheaper and visually more consistent than the same images
requested one at a time. Budget accordingly for a full texture set, and prefer regenerating a single failed id
over re-running a set.

## When Codex is not available

The original two-session bridge still works, and is the fallback when `gen` reports the CLI is missing or when
Derek wants to draw something himself:

```
node tools/image-request.mjs new --id plan --target projects/x/references/plan.png \
  --size 1024x1280 --purpose "top-down plan reference" --prompt-file /path/prompt.txt
node tools/image-request.mjs wait --id plan --timeout 900   # 0 done, 1 failed, 3 timed out (still queued)
```

A separate Codex session picks these up through its `hitreg-image-bridge` skill and marks them
`done --id <id> --by codex` after writing the target. `gen` and `new` share one queue, so `list` shows both.
