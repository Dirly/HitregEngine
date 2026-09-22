/**
 * The standard fire set: standing `vfx` effects for every environmental flame
 * in a game, plus the materials that colour them. PSX style.
 *
 *   node tools/fx.mjs fire <project> [--force]
 *
 * Writes into projects/<project>/assets/:
 *   vfx/env/fire-candle|torch|brazier|campfire|bonfire.json
 *   materials/fx/fire.json            orange (the default)
 *   materials/fx/fire-spirit.json     blue
 *   materials/fx/fire-fel.json        green
 *   materials/fx/ember-bed.json       what burns UNDER the fire: unlit, the
 *                                     ember texture (textures/fx/embers.png,
 *                                     copied in with --embers <png>) with a
 *                                     pixelated scrolling heat overlay. Put it
 *                                     on the torch head, the brazier's coals,
 *                                     the campfire's bed.
 *
 * Place one with a single component on an entity whose origin is the BASE of
 * the flame (the torch head, the log pile):
 *
 *   "vfx": { "effect": "env/fire-torch", "material": "fx/fire" }
 *
 * The five sizes are one recipe scaled by `s`, so they read as the same fire at
 * different sizes — which is the point of a standard. Entity scale does NOT
 * scale an effect (a module's sizes are metres); a new size is a new file.
 *
 * Every flame colour is a palette slot (glow / primary / secondary), and the
 * `vfx` component takes the palette from its material: color = body, emissive
 * = hot core, the dark tips = color darkened. Recolour by editing a material
 * or pointing at another one; never by editing the effects. Only smoke keeps
 * a fixed colour, because smoke is smoke whatever burns.
 *
 * THE PSX LOOK (every layer, all particle-engine fields):
 *   sprite    flame/square/pixel — nearest-filtered pixel art, never a soft blob
 *   steps     colour, size and opacity in 3–4 hard jumps, not a smooth ramp
 *   snap      positions and sizes on a world grid scaled to the fire, the
 *             vertex-precision wobble
 *   frameRate the simulation ticks at 12 fps (smoke 8): flames jump, never glide
 *   no softFade, no stretch — hard intersections and square texels are the era
 * The scene's `postfx.pixelate` (480, nearest) does the rest; these are built to
 * be seen through it.
 *
 * Existing files are left alone (they are data a human tunes after install);
 * --force overwrites.
 */
import fs from "node:fs";
import path from "node:path";

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The flame strip: one row of a flipbook, played once per particle. Made from
 * the purchased effect library with
 *   HITREG_FX_ROOT=".../HitRegStudios/Effect and FX" \
 *   node tools/fx.mjs particle-sheet <project> flame-lick=12:30 --row 5
 * (Effects 12 / 580.png, the white row, 14 frames).
 */
const FLAME_SHEET = "fx/flame-lick.png";

/** Simulation ticks per second for flames and embers; smoke is lazier. */
const FLAME_FPS = 12;
const SMOKE_FPS = 8;

/**
 * Per size: the scale, the light, and which layers it has. Light values follow
 * the `light` component's calibration (a room torch wants 6–15 over 8–12 m;
 * a torch at 2 is a glowing dot that lights nothing).
 */
const SIZES = {
  candle: { s: 0.25, light: [2.5, 3.5], flicker: 0.2, embers: false, smoke: false, cull: 25 },
  torch: { s: 1, light: [10, 9], flicker: 0.32, embers: true, smoke: true, cull: 60 },
  brazier: { s: 1.6, light: [14, 11], flicker: 0.3, embers: true, smoke: true, cull: 70 },
  campfire: { s: 2.2, light: [18, 13], flicker: 0.28, embers: true, smoke: true, cull: 80 },
  bonfire: { s: 4.5, light: [40, 22], flicker: 0.25, embers: true, smoke: true, cull: 140 },
};

/** Pool size for a stream: what can be alive at once, with headroom. */
const maxFor = (rate, lifeMax) => Math.ceil(rate * lifeMax * 1.3) + 4;

function fireEffect(size, { s, light, flicker, embers, smoke }) {
  const modules = [];
  const grow = (k) => Math.pow(s, k);
  // one "texel" of the fire's world grid — flames are ~6 of these across
  const grid = r3(0.04 * s);

  // THE FLAME DOES NOT MOVE. Derek, on the first PSX pass: flame sprites that
  // rise read as shapes floating away, not as fire. Every flame particle is
  // born in place at full size and only shrinks and fades where it stands;
  // the flame's silhouette comes from WHERE they are born — three stacked
  // volumes, wide and dim at the base, bright in the core, narrow at the tip —
  // and its flicker from new ones popping in at random points of those
  // volumes on every 12 fps tick. Only embers and smoke travel.
  // Each flame particle PLAYS the flame-lick strip once over its life (the
  // white row of the purchased sheet, tinted by the palette), so a flame
  // licks and changes shape in place instead of a static sprite shrinking.
  // The art fills only the middle of its 64 px cell, hence the big quads.
  const flameLayer = (id, { rate, life, at, volume, size, opacity, color, colorEnd }) => ({
    kind: "particles",
    id,
    stream: true,
    color,
    colorEnd,
    blend: "additive",
    anchor: { at: "origin", offset: [0, r3(at * s), 0] },
    emitter: {
      rate: r3(rate * grow(0.7)),
      max: maxFor(rate * grow(0.7), life[1]),
      lifetime: life,
      shape: "sphere",
      shapeSize: volume.map((v) => r3(v * s)),
      direction: [0, 1, 0],
      speed: [0, 0],
      sizeCurve: [[0, r3(size * s)], [1, r3(size * 0.35 * s)]],
      opacityCurve: opacity,
      texture: FLAME_SHEET,
      subUV: { cols: 14, rows: 1, mode: "life", fps: 24 },
      filter: "nearest",
      steps: 4,
      snap: grid,
      frameRate: FLAME_FPS,
      blending: "additive",
    },
  });

  // The body: the wide, dimmer mass of the flame, cooling to the dark tips.
  // Born low and close together — no layer spawns above the flame any more:
  // a separate "tip" volume read as small bits floating over the fire.
  modules.push(
    flameLayer("body", {
      rate: 10,
      life: [0.5, 0.8],
      at: 0.22,
      volume: [0.12, 0.04, 0.12],
      size: 0.8,
      opacity: [[0, 0.75], [0.5, 0.5], [1, 0]],
      color: "primary",
      colorEnd: "secondary",
    }),
  );
  // The hot core: smaller and brighter, at the root of the flame.
  modules.push(
    flameLayer("core", {
      rate: 12,
      life: [0.4, 0.65],
      at: 0.14,
      volume: [0.06, 0.03, 0.06],
      size: 0.55,
      opacity: [[0, 1], [0.5, 0.8], [1, 0]],
      color: "glow",
      colorEnd: "primary",
    }),
  );

  // Embers: single hard square specks thrown up and wandering off. Exactly one
  // grid cell each (a smaller ember would snap up to one anyway), no streak.
  if (embers) {
    const rate = r3(5 * grow(0.8));
    const life = [r3(0.7 * grow(0.25)), r3(1.4 * grow(0.25))];
    const speck = r3(0.02 * grow(0.5));
    modules.push({
      kind: "particles",
      id: "embers",
      stream: true,
      color: "glow",
      colorEnd: "primary",
      blend: "additive",
      anchor: { at: "origin", offset: [0, r3(0.15 * s), 0] },
      emitter: {
        rate,
        max: maxFor(rate, life[1]),
        lifetime: life,
        shape: "sphere",
        shapeSize: [r3(0.08 * s), r3(0.04 * s), r3(0.08 * s)],
        direction: [0, 1, 0],
        speed: [r3(0.7 * grow(0.5)), r3(1.4 * grow(0.5))],
        spread: 25,
        turbulence: 2.5,
        turbulenceSpeed: 2.2,
        drag: 0.9,
        sizeStart: speck,
        sizeEnd: speck,
        sprite: "square",
        steps: 3,
        snap: speck,
        frameRate: FLAME_FPS,
        opacityCurve: [[0, 0], [0.1, 1], [0.7, 0.8], [1, 0]],
        blending: "additive",
      },
    });
  }

  // Smoke: normal-blended pixel blobs above the flame, thin enough never to hide
  // it, on a coarser grid and a slower tick than the flame.
  if (smoke) {
    const rate = r3(2.5 * grow(0.6));
    const life = [r3(2.2 * grow(0.3)), r3(3.6 * grow(0.3))];
    modules.push({
      kind: "particles",
      id: "smoke",
      stream: true,
      color: "#2b2622",
      colorEnd: "#57504a",
      blend: "normal",
      anchor: { at: "origin", offset: [0, r3(0.4 * s), 0] },
      emitter: {
        rate,
        max: maxFor(rate, life[1]),
        lifetime: life,
        shape: "sphere",
        shapeSize: [r3(0.08 * s), r3(0.05 * s), r3(0.08 * s)],
        direction: [0, 1, 0],
        speed: [r3(0.35 * grow(0.6)), r3(0.6 * grow(0.6))],
        spread: 10,
        turbulence: r3(0.5 * grow(0.5)),
        turbulenceSpeed: 0.8,
        drag: 0.3,
        sizeCurve: [[0, r3(0.2 * s)], [1, r3(0.9 * s)]],
        opacityCurve: [[0, 0], [0.2, 0.25], [1, 0.05]],
        sprite: "pixel",
        steps: 3,
        snap: r3(grid * 1.5),
        frameRate: SMOKE_FPS,
        blending: "normal",
      },
    });
  }

  // The light the fire casts, held for as long as it burns.
  modules.push({
    kind: "light",
    id: "light",
    color: "primary",
    anchor: { at: "origin", offset: [0, r3(0.25 * s), 0] },
    intensity: light[0],
    range: light[1],
    flicker,
    intensityCurve: [[0, 1], [1, 1]],
  });

  return { name: `fire-${size}`, tags: { feel: ["soft"] }, modules };
}

const MATERIALS = {
  fire: { color: "#ff7a2a", emissive: "#ffd58a", note: "The standard flame: orange body, yellow-white core." },
  "fire-spirit": { color: "#3aa8ff", emissive: "#d8f4ff", note: "Ghost / arcane fire: blue body, pale core." },
  "fire-fel": { color: "#58e05a", emissive: "#e6ffb8", note: "Cursed / fel fire: green body, pale lime core." },
};

function writeOnce(file, doc, force, written, skipped) {
  if (fs.existsSync(file) && !force) {
    skipped.push(file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  written.push(file);
}

/** The ember bed: the texture's cracks glow, and a pixelated heat noise churns over them. */
const EMBER_BED = {
  shader: "unlit",
  color: "#ffffff",
  map: "fx/embers.png",
  filter: "nearest",
  emissive: "#000000",
  overlay: {
    // yellow over red art, strong: the first version (orange, 1.1, fully
    // masked) was all but invisible in play
    color: "#ffd070",
    opacity: 2.2,
    scale: 2.5,
    speed: [0.06, 0.15],
    threshold: 0.3,
    mask: "map",
    maskStrength: 0.9,
    // only the light parts move: measured on the 128 px ember art, 62% of
    // texels (the coals) sit under 0.2 linear and the cracks run 0.3 to 1.0
    maskCutoff: 0.3,
    // 64 cells on the 128 px ember texture: 2x2-texel heat blocks on its grid
    pixel: 64,
    steps: 4,
    frameRate: 12,
  },
};

export function cmdFire(project, force = false, embers = undefined) {
  if (!project) throw new Error("usage: node tools/fx.mjs fire <project> [--force] [--embers <png>]");
  const base = path.join("projects", project, "assets");
  if (!fs.existsSync(base)) throw new Error(`no such project assets folder: ${base}`);
  const written = [];
  const skipped = [];
  for (const [size, spec] of Object.entries(SIZES)) {
    writeOnce(path.join(base, "vfx", "env", `fire-${size}.json`), fireEffect(size, spec), force, written, skipped);
  }
  for (const [id, m] of Object.entries(MATERIALS)) {
    // `unlit` so a thumbnail of the material shows the colour it paints; the
    // effect reads only color + emissive
    writeOnce(
      path.join(base, "materials", "fx", `${id}.json`),
      { shader: "unlit", color: m.color, emissive: m.emissive, emissiveIntensity: 1 },
      force,
      written,
      skipped,
    );
  }
  const emberTexture = path.join(base, "textures", "fx", "embers.png");
  if (embers) {
    if (!fs.existsSync(embers)) throw new Error(`--embers: no such file ${embers}`);
    if (fs.existsSync(emberTexture) && !force) skipped.push(emberTexture);
    else {
      fs.mkdirSync(path.dirname(emberTexture), { recursive: true });
      fs.copyFileSync(embers, emberTexture);
      written.push(emberTexture);
    }
  }
  writeOnce(path.join(base, "materials", "fx", "ember-bed.json"), EMBER_BED, force, written, skipped);
  if (!fs.existsSync(path.join(base, "textures", FLAME_SHEET))) {
    console.warn(
      `  WARNING: textures/${FLAME_SHEET} is missing — the flames render as untextured quads. Make it with:\n` +
        `    node tools/fx.mjs particle-sheet ${project} flame-lick=12:30 --row 5`,
    );
  }
  if (!fs.existsSync(emberTexture)) {
    console.warn(`  WARNING: ${emberTexture} is missing — pass --embers <png>, or fx/ember-bed renders untextured`);
  }
  for (const f of written) console.log(`  wrote   ${f}`);
  for (const f of skipped) console.log(`  kept    ${f} (exists; --force to overwrite)`);
  console.log(`\nfire set in projects/${project}. Place one on an entity at the base of the flame:`);
  console.log(`  "vfx": { "effect": "env/fire-torch", "material": "fx/fire" }`);
  console.log(`sizes: ${Object.entries(SIZES).map(([k, v]) => `${k} (cullDistance ${v.cull})`).join(", ")}`);
}
