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
resolve against `apps/playground`. `ref` may be a LIST (an atlas key plus a sheet whose face placement to copy):
the set attaches every distinct reference once, in first-seen order, so the prompts name them by position
("the FIRST attached image is the key, the SECOND is ...").

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
- **A sheet asked for opaque can come back TRANSPARENT.** Measured on a ratkin atlas: 59.5% of it fully
  transparent, every border pixel at alpha 0, artwork complete. Downstream that is indistinguishable from a
  sheet drawn on black and the atlas importer refuses it outright. Unlike black it is trivially recoverable —
  the ground is absent, not wrong — so `gen` now composites an opaque request onto white before installing and
  reports `fixed` in its JSON. Keep saying "background must be pure white" anyway; this is the safety net.
- **Alpha needs demanding.** Pass `--alpha` (or `"alpha": true`) and say "fully transparent background, real PNG
  alpha, not white, not a checkerboard" — the flag also makes the tool reject an opaque result.
- **Nearest-neighbour on the downsample** is in the shared brief already; it is what keeps pixel art crisp.

## Skin: the tint contract

Characters pick a skin tone in the creator, and the engine recolours painted skin on the head and body pages in
the shader (render `appearance.ts`; one extra R8 mask per page, no extra draw). That only works if every sheet
that shows bare skin paints it in ONE palette, and says so:

- **Paint skin as the existing faces do**: warm tan, hue 16–26°, saturation 0.46–0.64, value 0.45–0.90 for the
  lit skin; shadows may go down to value 0.26 and hue 14–28.5° as long as they touch lit skin. Measured
  2026-09-25: faces mean #9A6043, the unequipped body mean #A76D4B, both with their shading intact. Don't paint
  skin pink, grey or yellow for "variety": the tone comes from the player's pick, the sheet only supplies shading.
- **Features are carved out of the skin by contrast, not colour** (render `carveSkinFeatures`): the faces paint
  lash lines, brows, nostrils and the mouth in skin's own hue, only darker. A texel more than 0.10 OKLab L below
  the skin around it is a feature LINE: it takes the painted or the toned colour, whichever is darker, so it stays
  a line on porcelain and never becomes a pale speck on ebony. A texel more than 5.5° hue or 0.085 saturation off
  its neighbourhood is KEPT as painted (eye whites, irises, lips), unless it is a lighter texel on skin's hue (a
  highlight, which follows the tone). So paint eye whites and irises visibly OFF skin's hue/saturation and lips
  toward red, or they tone. The heads' eye whites are painted a warm dull tan ("nothing painted may be white"):
  kept as painted, they read as bright tan on the darkest tones.
- **The mouth is kept whole** on a head sheet (option `skin: "face"`, render `protectMouth`): the lowest row of
  carved features at least 4 texels wide near the face's centre column (45–85% down the tile) is the mouth; its
  lines and everything between them keep the painted lip colour, and the ring of texels around them is half
  toned, so lips never take the tone and never sit in a hard ring. Found on all 16 MMO faces. Keep painting the
  mouth as a closed horizontal shape under the nose, as the key's mouth bar asks.
- **How the tone lands**: in OKLab. Each skin texel's step in lightness from the page's mean skin is carried onto
  the tone (highlights scaled into the headroom the tone has left, shadows part-way with its lightness), hue from
  the tone, chroma easing off in deep shadow and up to 1.3× in highlights. A dark tone keeps warm highlights and
  readable shadows. The creator lights its preview neutral-warm (`PortraitView` `lights`): the default cool fill
  turned dark skin grey-violet.
- **Keep cloth out of it by saturation**: the base sheets' linen reads hue 27–36°, saturation 0.2–0.35 and is
  never taken; leather is value ~0.28 (dark) and is only ever judged inside a sheet that opted in.
- **Hair colour is the same path on a WHOLE sheet**: a colour slot with `tintModels: ["mmo/human-hair.glb"]` tints
  every opaque texel of that model (styles, beards and moustache are one ubermesh, so one choice colours them all).
  The painted strand contrast is carried 1:1 in OKLab and compressed only where the colour lacks the room
  (render `TONE_FIT`: the sheet's 97th/3rd-percentile strands kept within L 0.05–0.95), so blond and grey keep
  their strands and black keeps its sheen. Paint the hair sheet as ONE neutral-ish hair with real strand
  contrast; its colour does not matter.
- **Opt the sheet in.** Nothing is tinted unless the option drawing it says `skin` (creation asset
  `appearance[].options[].skin`): `true` for a face or the unequipped body, a list of PART names (the hands) for
  a gloved set whose fingers show. Armour that never opted in is never touched, whatever its colours.

Measured on the live pages with that setup: every face 97.9–98.5% toned skin plus 62–81 feature-line texels, with
eye whites, irises and lips kept; unequipped body 32% (male) / 42% (female) of opaque texels, linen untouched; ranger 1.3% and magus 0.3% (fingers only, inside the
hand islands); vanguard, cleric and every armour sheet not opted in 0%. Re-measure after regenerating a sheet —
the mask is derived from the pixels at load, never stored.

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
