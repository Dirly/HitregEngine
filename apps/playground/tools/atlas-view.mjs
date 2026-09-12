#!/usr/bin/env node
/**
 * Look at the swords an atlas run made.
 *
 *   pnpm -F playground atlas-view --recipe longsword --atlas tools/atlas/out-bone/atlas.png
 *   pnpm -F playground atlas-view --model <file.glb> --atlas a.png b.png c.png
 *
 * A shell glob over the atlas output folders works too and is the usual way in.
 *
 * Point it at one or more ATLASES of the same model and it stands one finished
 * weapon per atlas in a row, each wearing its own sheet, with that sheet on the
 * wall behind it. Generate three sets, run this, see all three built.
 *
 * The model is an UBERMESH — every variant of every part stacked in the same
 * place — so the scene shows one of each family (blade, guard, collar, pommel)
 * assembled into a weapon. Families come from the node names with their
 * trailing number removed, which is the naming the model already uses;
 * `--variant 2` takes the second of each instead of the first.
 *
 * Nothing here is sword-specific. It reads the model's node names and its
 * materials, and works on anything unwrap-weapon has been through.
 *
 * HOW THE ATLAS GETS ONTO THE MESH, which is the one subtle thing in here. The
 * mesh's UVs are glTF's (V from the top), but the engine loads a texture ASSET
 * through three's TextureLoader, whose flipY is true — so a sheet applied
 * through an engine material lands upside down. Rather than ship a second mesh
 * with flipped UVs, each atlas is copied in FLIPPED, and the engine's flip
 * turns it back. Two flips, no mesh variants, and swapping a sheet is dropping
 * a PNG in place. The panel on the wall uses the unflipped copy, because that
 * one is a picture of the sheet rather than a wrapping of it.
 */
import "./node-dom-shim.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { execFileSync } from "node:child_process";
import { decodePng, encodePng } from "./_png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(here, "..");
const ENGINE = path.resolve(PLAYGROUND, "../..");
const STUDIO = path.resolve(ENGINE, "..");

/** `--atlas a.png b.png` collects every value until the next flag. */
function parseArgs(argv) {
  const out = {};
  let key = null;
  for (const a of argv) {
    if (a.startsWith("--")) {
      key = a.slice(2);
      out[key] = true;
      continue;
    }
    if (!key) continue;
    out[key] = out[key] === true ? a : [].concat(out[key], a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const list = (v) => (v === undefined || v === true ? [] : [].concat(v));

const RECIPE_DEFAULTS = {
  longsword: { model: "MMO/3d/Weapons/LongSword-unwrapped.glb" },
};
const recipe = args.recipe && RECIPE_DEFAULTS[String(args.recipe)];
if (!args.model && !recipe) {
  console.error("usage: atlas-view --model <file.glb> --atlas <sheet.png> [<sheet.png> ...]");
  process.exit(1);
}
const modelPath = path.resolve(
  args.model && args.model !== true ? String(args.model) : path.join(STUDIO, recipe.model),
);
if (!fs.existsSync(modelPath)) {
  console.error(`! no model at ${modelPath}`);
  process.exit(1);
}

  const defaultName = args["atlas-dir"]
    ? "atlas-carousel"
    : path.basename(modelPath).replace(/\.(glb|gltf)$/i, "").toLowerCase();
  const name = String(args.name && args.name !== true ? args.name : defaultName);
const assets = path.join(PLAYGROUND, "assets");
const modelId = `${name}.glb`;

// ---------------------------------------------------------------------------
// the atlases
// ---------------------------------------------------------------------------
//
// A sheet is named for the folder it came out of — out-bone/atlas.png is
// "bone" — because that is what an atlas run is called and what you would say
// out loud comparing two of them.
const sheets = [];
const seenSheets = new Set();
const addSheet = (file) => {
  const abs = path.resolve(String(file));
  if (seenSheets.has(abs) || !fs.existsSync(abs)) return;
  seenSheets.add(abs);
  const dir = path.basename(path.dirname(abs)).replace(/^out-/, "");
  const stem = path.basename(abs).replace(/\.png$/i, "");
  const label = (stem === "atlas" ? dir : stem).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  sheets.push({ abs, label });
};
for (const file of list(args.atlas)) {
  if (!fs.existsSync(path.resolve(String(file)))) console.warn(`! skipped ${file}: not there`);
  addSheet(file);
}
if (args["atlas-dir"] && args["atlas-dir"] !== true) {
  const atlasDir = path.resolve(String(args["atlas-dir"]));
  if (!fs.existsSync(atlasDir)) {
    console.warn(`! atlas directory not found: ${atlasDir}`);
  } else {
    // An atlas RUN writes `out-<name>/atlas.png`. The folder also holds raw art
    // sheets, keys and check renders — none of them atlases, and none of them
    // even the same size. Prefer the runs; fall back to loose PNGs only when
    // there are no runs at all.
    const runs = fs
      .readdirSync(atlasDir)
      .filter((d) => d.startsWith("out-") && fs.existsSync(path.join(atlasDir, d, "atlas.png")))
      .sort();
    if (runs.length) for (const d of runs) addSheet(path.join(atlasDir, d, "atlas.png"));
    else
      for (const file of fs.readdirSync(atlasDir).filter((f) => /\.png$/i.test(f)).sort())
        addSheet(path.join(atlasDir, file));
  }
}
if (!sheets.length) {
  console.error("! no atlases given — pass --atlas <sheet.png> [<sheet.png> ...] or --atlas-dir <folder>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// the model: families of alternatives, and which parts are decoration
// ---------------------------------------------------------------------------

const buf = fs.readFileSync(modelPath);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  "",
);
gltf.scene.updateMatrixWorld(true);

const parts = [];
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  const m = o.material;
  parts.push({
    name: o.name || `part${parts.length}`,
    uv: !!o.geometry.attributes.uv,
    // A part on a CUT-OUT material — masked and double-sided — is decoration,
    // not structure. The pipeline already gives the ornaments their own
    // material because they need one, so the mesh states which parts those are
    // and no name has to be matched here.
    trim: !!m && m.alphaTest > 0 && m.side === THREE.DoubleSide,
  });
});
if (!parts.length) {
  console.error("! the model has no meshes");
  process.exit(1);
}
const noUv = parts.filter((p) => !p.uv).map((p) => p.name);
if (noUv.length) console.warn(`! no UVs on: ${noUv.join(", ")} — those will render flat`);

const families = new Map();
for (const p of parts) {
  const fam = p.name.replace(/\d+$/, "") || p.name;
  if (!families.has(fam)) families.set(fam, []);
  families.get(fam).push(p);
}
const variant = Math.max(1, Number(args.variant ?? 1));
const showTrim = String(args.trim ?? "yes") !== "no";
const build = [];
for (const [, members] of families) {
  const pick = members[Math.min(variant, members.length) - 1];
  if (pick.trim && !showTrim) continue;
  build.push(pick);
}

const whole = new THREE.Box3().setFromObject(gltf.scene);
const wholeSize = whole.getSize(new THREE.Vector3());
const TARGET = Number(args.height ?? 2.4);
const unit = Number(args.scale ?? TARGET / Math.max(wholeSize.y, 1e-6));

console.log(`atlas-view: ${name}`);
console.log(`  model ${path.relative(STUDIO, modelPath)} — ${parts.length} parts`);
console.log(`  building ${build.map((p) => p.name).join(" + ")}`);

// ---------------------------------------------------------------------------
// copy the assets in
// ---------------------------------------------------------------------------

fs.mkdirSync(path.join(assets, "models"), { recursive: true });
fs.copyFileSync(modelPath, path.join(assets, "models", modelId));
fs.mkdirSync(path.join(assets, "textures"), { recursive: true });
const mat = path.join(assets, "materials", "atlas-view");
fs.mkdirSync(mat, { recursive: true });

const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

for (const s of sheets) {
  const png = decodePng(fs.readFileSync(s.abs));
  s.size = png.width;
  // The wall panel: the sheet as a picture, the way up it was painted.
  s.panelId = `${name}-sheet-${s.label}.png`;
  fs.copyFileSync(s.abs, path.join(assets, "textures", s.panelId));
  // The wrapping copy, flipped so the engine's own flip puts it back.
  const flipped = new Uint8Array(png.data.length);
  const row = png.width * 4;
  for (let y = 0; y < png.height; y++)
    flipped.set(png.data.subarray(y * row, y * row + row), (png.height - 1 - y) * row);
  s.mapId = `${name}-atlas-${s.label}.png`;
  fs.writeFileSync(path.join(assets, "textures", s.mapId), encodePng(png.width, png.height, flipped));

  // Two materials per sheet: the metal, and the cut-out one the ornaments need.
  // They have to be separate because a mesh component's material overrides
  // EVERY submesh of the model it is put on — one material for the lot would
  // make the ornaments solid and leave their alpha unused.
  s.solid = `atlas-view/${s.label}-solid`;
  s.trim = `atlas-view/${s.label}-trim`;
  write(path.join(mat, `${s.label}-solid.json`), {
    shader: "standard",
    color: "#ffffff",
    map: s.mapId,
    filter: "nearest",
    roughness: 0.6,
    metalness: 0.1,
  });
  write(path.join(mat, `${s.label}-trim.json`), {
    shader: "standard",
    color: "#ffffff",
    map: s.mapId,
    filter: "nearest",
    roughness: 0.6,
    metalness: 0.1,
    // At 128px, thin ornament strokes are often fractional-alpha texels
    // after area downsampling. Keep those edge texels instead of discarding
    // most of the openwork at the default 0.5 cutoff.
    alphaTest: 0.1,
    side: "double",
  });
  write(path.join(mat, `${s.label}-panel.json`), {
    shader: "unlit",
    color: "#ffffff",
    map: s.panelId,
    filter: "nearest",
    side: "double",
  });
  s.panel = `atlas-view/${s.label}-panel`;
  console.log(`  sheet ${s.label.padEnd(14)} ${png.width}x${png.height}  ${path.relative(STUDIO, s.abs)}`);
}


// ---------------------------------------------------------------------------
// the ubermesh, the packed sheet, and one material for the lot
// ---------------------------------------------------------------------------
//
// Every weapon on every stand is the SAME mesh and the SAME material; what
// differs is per-instance. That is the whole reason this is one draw call:
// a material boundary is a draw-call boundary, so the sheet cannot be a
// material per theme and the parts cannot be an entity per part.
const uberPath = modelPath.replace(/.glb$/i, "-uber.glb");
const partsPath = modelPath.replace(/.glb$/i, "-parts.json");
if (!fs.existsSync(uberPath) || !fs.existsSync(partsPath)) {
  console.error(
    `! no ubermesh beside the model (${path.basename(uberPath)}). Run unwrap-weapon first — it writes it.`,
  );
  process.exit(1);
}
const uberId = `${name}-uber.glb`;
fs.copyFileSync(uberPath, path.join(assets, "models", uberId));
const partIndex = JSON.parse(fs.readFileSync(partsPath, "utf8")).parts;

// Every page of the carousel shows a ROW OF DIFFERENT WEAPONS in that
// theme, not one weapon repainted. The model is an ubermesh — four blades,
// four crossguards, three collars, three pommels — and showing one
// combination proves the sheet changed and nothing else.
//
// Each weapon on the row takes the NEXT member of every family, wrapping
// where a family is shorter, so a row as long as the biggest family covers
// every member of every family at least once. The masks are per-instance,
// so the extra weapons cost nothing: they share the one batch.
const famList = [...families.entries()].map(([fam, members]) => ({ fam, members }));
const rowLength = Math.max(...famList.map((f) => f.members.filter((m) => !m.trim).length));
const builds = Array.from({ length: rowLength }, (_, v) => {
  const chosen = [];
  const names = [];
  for (const { members } of famList) {
    const usable = members.filter((m) => !m.trim);
    if (usable.length) {
      const pick = usable[v % usable.length];
      chosen.push(pick);
      if (usable.length > 1) names.push(pick.name);
    }
    // The cut-out parts are decoration, not a family to cycle: they go on
    // every weapon here so the ornaments are visible on each sheet.
    if (showTrim) for (const m of members) if (m.trim) chosen.push(m);
  }
  return {
    label: `v${v + 1}`,
    names,
    mask: chosen.reduce((m, part) => m | (1 << (partIndex[part.name] ?? 0)), 0),
  };
});
for (const b of builds) console.log(`  ${b.label}: ${b.names.join(" + ")}`);

// Pack every sheet into one texture. FLIPPED, because this is bound through
// an engine material and the engine's TextureLoader flips what it loads —
// two flips and the paint lands the way it was painted. Each tile keeps an
// 8-texel gutter of its own edge pixels, or the lower mips average one
// sword's pommel into its neighbour's blade.
{
  const PAD = 8;
  const all = sheets.map((sh) => ({ sh, png: decodePng(fs.readFileSync(sh.abs)) }));
  // The pack's size is the size MOST of the sheets are, not whichever sorted
  // first: a shared atlas folder holds the armour sheets too, and taking the
  // alphabetical first one threw away every sword. `--size` forces it.
  const tally = new Map();
  for (const d of all) tally.set(d.png.width, (tally.get(d.png.width) ?? 0) + 1);
  const size = Number(
    args.size && args.size !== true
      ? args.size
      : [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0],
  );
  const decoded = all.filter((d) => {
    if (d.png.width === size && d.png.height === size) return true;
    console.warn(`! skipped ${d.sh.label}: ${d.png.width}px, not the pack's ${size}`);
    return false;
  });
  sheets.length = 0;
  sheets.push(...decoded.map((d) => d.sh));
  const cols = Math.ceil(Math.sqrt(decoded.length));
  const rows = Math.ceil(decoded.length / cols);
  const stride = size + PAD * 2;
  const W = cols * stride;
  const H = rows * stride;
  const packed = new Uint8Array(W * H * 4);
  for (const [i, { sh, png }] of decoded.entries()) {

    const ox = (i % cols) * stride + PAD;
    const oy = Math.floor(i / cols) * stride + PAD;
    for (let y = -PAD; y < size + PAD; y++) {
      const sy = Math.min(size - 1, Math.max(0, y));
      for (let x = -PAD; x < size + PAD; x++) {
        const sx = Math.min(size - 1, Math.max(0, x));
        const src = (sy * size + sx) * 4;
        const dst = ((oy + y) * W + ox + x) * 4;
        packed[dst] = png.data[src];
        packed[dst + 1] = png.data[src + 1];
        packed[dst + 2] = png.data[src + 2];
        packed[dst + 3] = png.data[src + 3];
      }
    }
    sh.tile = [ox / W, oy / H, size / W].map((v) => +v.toFixed(6));
  }
  const packId = `${name}-pack.png`;
  const packPath = path.join(assets, "textures", packId);
  fs.writeFileSync(packPath, encodePng(W, H, packed));
  console.log(`  packed ${decoded.length} sheets of ${size}px -> ${W}x${H}`);

  // BAKE the packed sheet into the ubermesh rather than binding it through an
  // engine material. Not a preference: an instanced batch clones its material
  // at build time, and a material asset attaches its maps ASYNCHRONOUSLY, so
  // the clone keeps whatever the original had at that instant — usually
  // nothing, and the weapons draw untextured with no error anywhere. A mesh
  // that carries its own sheet also matches what ships.
  if (args.recipe && args.recipe !== true) {
    execFileSync(
      process.execPath,
      [path.join(here, "unwrap-weapon.mjs"), "--recipe", String(args.recipe), "--atlas", packPath, "--no-check"],
      { stdio: "pipe" },
    );
    fs.copyFileSync(uberPath, path.join(assets, "models", uberId));
    console.log(`  baked it into ${path.basename(uberPath)}`);
  } else {
    console.warn("! --model was given without --recipe, so the pack could not be baked in; pass --recipe to texture it");
  }
}
// ---------------------------------------------------------------------------
// the scene: one bay per atlas — the weapon, and its sheet on the wall behind
// ---------------------------------------------------------------------------

const step = Math.max(wholeSize.x * unit * 5, 0.45);
const bay = Number(args.spacing ?? Math.max(TARGET * 0.85, 1.6) + step * (builds.length - 1));
const rackW = Math.max(bay * sheets.length, 3);
// Each sheet hangs behind its OWN weapon with air either side, so it reads as
// that weapon's sheet rather than one long wall of texture.
const panel = Math.min(TARGET * 0.55, bay * 0.62);

const entities = {};
const ent = (id, body) => {
  entities[id] = {
    name: body.name ?? id,
    parent: body.parent ?? null,
    tags: body.tags ?? [],
    components: body.components,
  };
};

ent("sky", { name: "Sky", components: { sky: { top: "#232a33", bottom: "#4a5360", light: 0.9 } } });
ent("sun", {
  name: "Sun",
  components: {
    transform: { position: [4, 8, 5] },
    light: { kind: "directional", intensity: 2.1, color: "#fff3e2", castShadow: true },
  },
});
ent("fill", {
  name: "Fill",
  components: { light: { kind: "ambient", intensity: 0.85, color: "#9fb2c6" } },
});
write(path.join(mat, "floor.json"), {
  shader: "standard",
  color: "#2c3239",
  roughness: 0.95,
  metalness: 0,
});
ent("floor", {
  name: "Floor",
  components: {
    transform: { position: [0, -0.03, 0] },
    mesh: {
      source: { kind: "primitive", shape: "box", size: [rackW * 2.4, 0.05, rackW * 1.4] },
      material: "atlas-view/floor",
      receiveShadow: true,
    },
  },
});

for (const [i, s] of sheets.entries()) {
  const x = 0;

  // A thin BOX, not a `plane`: the renderer lays a plane primitive flat, and
  // `size` wants all THREE numbers on every shape — two throws during scene
  // expansion and takes the whole build with it.
  if (false) ent(`panel-${s.label}`, {
    name: `${s.label} sheet`,
    components: {
      transform: { position: [x, panel / 2, -Math.max(TARGET * 0.5, 0.9)] },
      mesh: {
        source: { kind: "primitive", shape: "box", size: [panel, panel, 0.02] },
        material: s.panel,
      },
    },
  });

  ent(`stand-${s.label}`, {
    name: s.label,
    tags: ["atlas-carousel-item"],
    components: {
      visibility: { visible: i === 0 },
      transform: { position: [x, 0, 0] },
      script: { name: "spinner", params: { speed: 0.5 } },
    },
  });
  // ONE entity, the whole ubermesh, wearing this sheet's tile of the packed
  // atlas and showing only the parts this weapon is made of. Both of those are
  // per-INSTANCE, so every weapon on the stand — and every weapon anywhere
  // else in the world drawn the same way — collapses into a single instanced
  // draw. The older shape here put one entity on each PART and a material on
  // each theme; that is one draw per part per theme, and it was the thing this
  // replaced.
  for (const [v, b] of builds.entries()) {
    const bx = (v - (builds.length - 1) / 2) * step;
    ent(`build-${s.label}-${b.label}`, {
      name: `${s.label} ${b.label}`,
      parent: `stand-${s.label}`,
      components: {
        transform: {
          position: [bx - (whole.min.x + wholeSize.x / 2) * unit, -whole.min.y * unit, 0],
          scale: [unit, unit, unit],
        },
        mesh: {
          source: {
            kind: "asset",
            assetId: uberId,
            textureFilter: "nearest",
            atlasTile: s.tile,
            partMask: b.mask,
          },
          renderMode: "instanced",
          castShadow: true,
          receiveShadow: true,
        },
      },
    });
  }
}

ent("atlas-carousel", {
  name: "Atlas Carousel",
  components: { script: { name: "atlas-carousel" } },
});

// Only one weapon is visible at a time, so frame the active sword rather than
// fitting the entire atlas row into view. The sheets remain available behind
// the selected sword without making the weapon tiny on screen.
{
  // Framed on ONE page: the carousel shows a page at a time, so what has to
  // fit is the row of variants on it, not the whole rack.
  const page = step * builds.length + TARGET * 0.6;
  const eye = [0, TARGET * 0.62, Math.max(page * 1.25, TARGET * 1.65)];
  const at = [0, TARGET * 0.45, 0];
  const pitch = Math.atan2(at[1] - eye[1], eye[2] - at[2]);
  ent("camera", {
    name: "Camera",
    components: {
      transform: { position: eye, rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] },
      camera: { active: true, fov: 38, near: 0.01, far: 400 },
    },
  });
}

fs.mkdirSync(path.join(assets, "scenes"), { recursive: true });
const scenePath = path.join(assets, "scenes", `${name}.scene.json`);
write(scenePath, { version: 1, name, entities });

console.log(`  wrote ${path.relative(PLAYGROUND, scenePath)} — ${sheets.length} weapons`);
console.log(`\n  pnpm -F playground dev   then pick "${name}" in the scene menu`);
