#!/usr/bin/env node
/**
 * Unwrap a modular weapon ubermesh and write the colour KEY the armor-atlas
 * pipeline (tools/atlas) generates artwork against.
 *
 *   node tools/unwrap-weapon.mjs --recipe longsword
 *
 * Why this exists. A Blockbench weapon export has no usable UVs at all: every
 * face of every part is mapped onto the same single texel in the corner of the
 * sheet (measured on LongSword.fbx: the whole model occupies u 0..0.004,
 * v 0.984..1.0). A texture atlas needs a real unwrap, and the atlas importer
 * needs a KEY whose islands are exactly that unwrap's footprint — so the two
 * have to be produced together, by one program, from the mesh itself. Draw the
 * key by hand and the artwork lands next to the geometry rather than on it.
 *
 * What comes out:
 *   <Weapon>-unwrapped.glb   FOR THE ENGINE. Every part kept separate and
 *                            named, so the game can pick one blade, one guard
 *                            and one pommel out of the seventeen, now carrying
 *                            UVs and two materials (solid + cutout). Every
 *                            transform is baked into the geometry, so no
 *                            importer that flattens a hierarchy can move a part
 *                            off the sword.
 *   <Weapon>-unwrapped.obj   FOR THE MODELLER. ONE merged object at
 *                            Blockbench's OBJ scale, in the source file's own
 *                            world space, so it comes back exactly where it
 *                            was modelled. (V flipped on the way out: OBJ
 *                            counts V from the bottom, glTF from the top.)
 *   key-<recipe>.png         the flat colour key handed to the generator
 *   manifest-<recipe>.json   the slot table import-atlas.mjs registers against
 *   key-<recipe>-check.png   the mesh rendered WITH the key as its texture —
 *                            every part must come out its own flat slot colour
 *
 * ONE SLOT PER PART. Two parts never share texels, however similar they look:
 * a shared strip saves sheet and costs the thing the sheet is for, which is
 * telling four crossguards apart.
 *
 * The unwrap, which is the same idea for nearly every part:
 *
 *   plane   Look along X — the sword's thickness — so the island is the part's
 *           own SILHOUETTE and its FRONT and BACK land on the same texels. The
 *           part is painted once and the paint appears on both sides, which is
 *           what a symmetric weapon wants. The island being the shape of the
 *           thing is not a nicety: asked for a crossguard, a generator draws a
 *           crossguard, and when these islands were unrolled rectangles two
 *           thirds of that artwork landed on nothing.
 *   rim     The faces that view cannot see — the top and underside of a
 *           crossguard, the edge of a pommel — laid out as a bar hung directly
 *           under the silhouette, in the SAME slot. As wide as the piece and as
 *           tall as the piece is thick. See `edgeBand`, which had three goes at
 *           it before the bars came out solid.
 *   unroll  Peel the whole surface off around an axis, like a label off a
 *           bottle. Only the grip needs it: six sides, no flat-on view worth
 *           the name, and a seam that has to meet itself.
 *
 * Faces a projection cannot see at all (a blade's flat tip cap) collapse to a
 * zero-area UV triangle, which samples a line of texels and picks up whatever
 * the mip chain averages. They are given a small triangle just inside the
 * island at their own position instead, so they take the colour of the part
 * they belong to.
 */
import "./node-dom-shim.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { sanitizeFbx } from "./_fbx.mjs";
import { encodePng } from "./_png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The engine checkout, and the folder it sits in beside the art source tree. */
const ENGINE = path.resolve(here, "../../..");
const STUDIO = path.resolve(ENGINE, "..");

// ---------------------------------------------------------------------------
// recipes
// ---------------------------------------------------------------------------
//
// One entry per ubermesh. `parts` maps a mesh name in the file to the slot it
// paints and how it is unwrapped; `layout` is a flexbox-ish tree that decides
// where the islands sit on the sheet. Sizes come from the mesh, so the layout
// only says what sits next to what — the scale is solved to fit.

const RECIPES = {
  longsword: {
    // Blockbench is where this model is actually edited, so the OBJ it exports
    // is the source of record. It is written at 1/100 of the FBX's units.
    source: "MMO/3d/Weapons/LongSword.obj",
    sourceScale: 100,
    outMesh: "MMO/3d/Weapons/LongSword-unwrapped",
    sheet: 1254, // the generator's canvas; the human sheets are all 1254
    // 60 sheet px = 12 texels at a 256 atlas, which is the 2x bleed the atlas
    // importer asks for. Tighter buys density and starts mixing islands in
    // the lower mips; looser costs every island size.
    gutter: 60,
    margin: 22,
    atlas: {
      // The sword ships at 128. Everything upstream is resolution-independent
      // — UVs are 0..1 and the art sheet stays 1254 — but two numbers here are
      // measured in ATLAS texels and have to be read against 128, not 256: the
      // bleed, and the gutter the layout leaves between islands. At 128 a
      // 60-pixel gutter on the sheet is 6 texels, so a bleed of 3 fits inside
      // it on both sides, which is what the importer asks for.
      size: 128,
      bleed: 3,
      // The importer calls border-connected pixels over this luminance
      // 'ground' and drops them. Its default of 200 is tuned for a cloth
      // sheet; a sword is BRIGHT METAL, and a blade painted with a light
      // steel edge had the edge eaten (measured: a 209-luminance edge band
      // vanished and the contain fit then stretched the rest of the blade
      // 1.33x to cover the island). Only the ornaments cut here, and they are
      // asked for on pure white, so the bar can sit just under it.
      bgLum: 228,
    },
    // ONE SLOT PER PART. Nothing on this sheet is shared any more: an earlier
    // version pooled the four discs' rims into a single strip, which saved
    // sheet at the cost of making four different parts wear the same paint.
    // Slot colours are LABELS the generator must replace, never paint — cyan
    // (#00ffff) is the importer's cut colour and white is the ground, so
    // neither may be a slot. The ornaments keep the salmon the human sheet
    // uses for its iron ornament: same job, same colour, same instructions.
    //
    // `fit: contain` everywhere, because a generator sizes each piece to look
    // right rather than to fill its island: measured on the first real sheet,
    // pieces came back anywhere from 0.46x to 1.9x their island. Contain maps
    // whatever it drew onto the island it belongs to.
    slots: {
      blade1: { color: "#1f00ff", fit: "contain" },
      blade2: { color: "#a900ff", fit: "contain" },
      blade3: { color: "#00a2ff", fit: "contain" },
      blade4: { color: "#11008a", fit: "contain" },
      guard1: { color: "#ff0000", fit: "contain" },
      guard2: { color: "#a80000", fit: "contain" },
      guard3: { color: "#ff7d00", fit: "contain" },
      guard4: { color: "#b35300", fit: "contain" },
      flavor1: { color: "#00c08b", fit: "contain" },
      flavor2: { color: "#007a5a", fit: "contain" },
      flavor3: { color: "#7ae0c0", fit: "contain" },
      pommel1: { color: "#3cff00", fit: "contain" },
      pommel2: { color: "#0f3e00", fit: "contain" },
      pommel3: { color: "#9dffa8", fit: "contain" },
      grip: { color: "#6b1511", fit: "contain" },
      // The two cut-out plates. Each is ANCHORED at the edge where it meets
      // the sword — the upper one grows up out of the guard, so its artwork is
      // pinned to the island's bottom; the lower one hangs off the pommel, so
      // its artwork is pinned to the top. A design that floats free of that
      // edge reads as a decal stuck in mid-air beside the blade.
      ornate: {
        color: "#ff8b8b",
        // The cut regions. `openEnclosed` lets a closed ring's hole open even
        // though it cannot reach the border of the sheet.
        transparency: true,
        cut: true,
        openEnclosed: true,
        fit: "contain",
        anchor: "bottom",
        fitPadding: 0,
        sizeScale: 1.3, // a cutout wants texels: fine detail is the point
      },
      "ornate-bottom": {
        color: "#ffc76b",
        transparency: true,
        cut: true,
        openEnclosed: true,
        fit: "contain",
        anchor: "top",
        fitPadding: 0,
        sizeScale: 1.3,
      },
    },
    // Every solid part is unwrapped the same way: looked at along X, the
    // sword's thickness, so the island is the part's SILHOUETTE and its front
    // and back share one painting. `rim` hangs a bar under that silhouette
    // carrying the faces the view cannot see — the top and bottom of a
    // crossguard, the edge of a pommel.
    parts: {
      // Blades: 99% of every blade's area already faces X, so nothing is left
      // over and no bar is needed.
      Blade1: { slot: "blade1", method: "plane", u: "+z", v: "-y" },
      Blade2: { slot: "blade2", method: "plane", u: "+z", v: "-y" },
      Blade3: { slot: "blade3", method: "plane", u: "+z", v: "-y" },
      Blade4: { slot: "blade4", method: "plane", u: "+z", v: "-y" },
      // Crossguards: bars across the blade. Peeled open around their LENGTH,
      // seam on the TOP, so the island reads top-of-guard down to underside and
      // a generator lighting it from above lights the right face.
      // so the top of the bar — more than half its surface — keeps its texels
      // instead of being squashed into a strip under a silhouette. `fold: x`
      // mirrors the far face onto the near one: painted once, symmetric by
      // construction, which is the point of a guard.
      CrossGuard1: { slot: "guard1", method: "unroll", axis: "z", seam: "+y", u: "+z", v: "arc", fold: "x" },
      CrossGuard2: { slot: "guard2", method: "unroll", axis: "z", seam: "+y", u: "+z", v: "arc", fold: "x" },
      CrossGuard3: { slot: "guard3", method: "unroll", axis: "z", seam: "+y", u: "+z", v: "arc", fold: "x" },
      CrossGuard4: { slot: "guard4", method: "unroll", axis: "z", seam: "+y", u: "+z", v: "arc", fold: "x" },
      // The collars where the guard meets the blade.
      CrossFlavor1: { slot: "flavor1", method: "plane", u: "+z", v: "-y", rim: true },
      CrossFlavor2: { slot: "flavor2", method: "plane", u: "+z", v: "-y", rim: true },
      CrossFlavor3: { slot: "flavor3", method: "plane", u: "+z", v: "-y", rim: true },
      Pummel1: { slot: "pommel1", method: "plane", u: "+z", v: "-y", rim: true },
      // A bipyramid: four facets up, four down, and not one of them faces the
      // flat squarely — every facet is slanted the same amount, so there is no
      // silhouette to separate from a rim. Seen from ABOVE the eight tile one
      // square with no gaps, the top four sharing it with the bottom four.
      Pummel2: { slot: "pommel2", method: "plane", u: "+z", v: "+x" },
      Pummel3: { slot: "pommel3", method: "plane", u: "+z", v: "-y", rim: true },
      // Grip: a six-sided prism, so nothing is flat enough to project.
      // Unrolled the whole way round, seam at the back of the hand.
      Handle: { slot: "grip", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      // The ornament planes: two triangles each, drawn once and shown on both
      // sides by a double-sided material.
      Ornate: { slot: "ornate", method: "plane", u: "+z", v: "-y" },
      OrnateBottom: { slot: "ornate-bottom", method: "plane", u: "+z", v: "-y" },
    },
    // Blades down the left with the two ornaments under them; the crossguards
    // stacked in the middle, since they are all one length; the collars, the
    // grip and the pommels on the right.
    layout: {
      row: [
        { col: [{ row: ["blade1", "blade2", "blade3", "blade4"] }, { row: ["ornate", "ornate-bottom"] }] },
        { col: ["guard1", "guard2", "guard3", "guard4", { row: ["pommel1", "pommel2", "pommel3"] }] },
        { col: ["flavor1", "flavor2", "flavor3", "grip"] },
      ],
    },
    // Which material each slot's geometry ends up on in the exported mesh.
    cutoutSlots: ["ornate", "ornate-bottom"],
    // What the check render assembles: one frame per column, each a weapon
    // the game could actually build out of these parts.
    combos: [
      ["Blade1", "CrossGuard1", "CrossFlavor1", "Pummel1", "Handle", "Ornate", "OrnateBottom"],
      ["Blade2", "CrossGuard2", "CrossFlavor2", "Pummel2", "Handle"],
      ["Blade3", "CrossGuard3", "CrossFlavor3", "Pummel3", "Handle"],
      ["Blade4", "CrossGuard4", "CrossFlavor1", "Pummel1", "Handle", "Ornate", "OrnateBottom"],
    ],
  },
  // A CREATURE, not a modular weapon — the same machinery, one difference worth
  // stating once: there are no families and no alternatives here. The ogre's ten
  // meshes are the ten shells of ONE body, so every part is always drawn and the
  // sheet's job is not to tell four crossguards apart but to give each shell of
  // one animal its own stretch of skin. Nothing cuts; an ogre is solid.
  //
  // The body is modelled in halves that already face the way they want to be
  // unwrapped: ChestFront/LegsFront face +X (58%/54% of their area, with 1%/3%
  // facing back), ChestBack/LegsBack face -X (71%/57%, with nothing facing
  // forward). Those four are therefore pure planar shells — projected along X
  // there is no front-onto-back fold to worry about, because each shell IS one
  // face of the body.
  //
  // The head, the arm and the hands are whole pieces instead, and for a head the
  // fold direction matters: looked at along X, the face would be painted onto the
  // back of the skull. They are looked at along Z, so the island is a PROFILE and
  // the mirror puts the left cheek's paint on the right cheek, which is what a
  // bilaterally symmetric animal wants. The foot is looked at down Y, so the
  // island is a footprint and the sole — never seen — shares the top's texels.
  //
  // Arm, hand and foot exist ONCE in the file (left arm, right foot); the other
  // side is the same mesh mirrored, so it wears the same paint by construction.
  ogre: {
    // Straight off the FBX: this model is not round-tripped through Blockbench,
    // so there is no OBJ and no 1/100 to undo. The ogre stands 302 units tall
    // here; `retarget.mjs --height` is what puts a character on a metre ruler.
    source: "MMO/3d/Mobs/Ogre.fbx",
    sourceScale: 1,
    outMesh: "MMO/3d/Mobs/Ogre-unwrapped",
    sheet: 1254,
    // 48 sheet px is 9.8 texels at 256, which clears the 2x bleed the importer
    // asks for with room to spare. The sword's 60 was read against a 128 atlas;
    // read against this one it would cost density for nothing.
    gutter: 48,
    // Every island drawn 8px larger than its geometry, in its own colour, so a
    // generator that draws a piece slightly small still fills it. See STROKE.
    keyStroke: 8,
    // A body is not a set of facets. 48 degrees keeps the jaw line, the top of
    // the foot and the knuckles as edges and smooths everything else.
    smooth: 48,
    margin: 22,
    atlas: {
      // 256, twice the sword's, because this is a three-metre animal you fight
      // at arm's length rather than a prop in the corner of the screen. At the
      // layout below that is about 0.65 texels per model unit — the chest shell
      // lands ~90 texels tall, which is the PS1-era density this game is drawn
      // at. `--size 512` re-cuts it denser without touching anything else.
      size: 256,
      // 60 sheet px is 12 texels at 256, so 4 of bleed fits inside it twice
      // over, which is what the importer asks for.
      // 3, not 4: the 8px keyStroke grows every island toward its neighbour, so
      // the 48px gutter is 32px of clear space by the time the importer sees it
      // — 6.5 texels at 256, which covers a bleed of 3 on both sides and not 4.
      // Widening the gutter instead would re-cut the layout and strand every
      // sheet already painted against this key.
      bleed: 3,
      // Nothing on this sheet cuts, so the ground bar can sit higher than the
      // sword's 228: no region needs pure white for anything. 236 leaves bone
      // and tusk ivory (~218) safe while still finding a white background, and
      // an off-white one down to 236.
      bgLum: 236,
    },
    // ONE SLOT PER PART, ten of them. Colours are LABELS — white is the ground
    // and cyan #00ffff is the cut colour, so neither may be a slot.
    //
    // `matchTo` names the piece each small part MEETS on the body. A generator
    // paints every block to look right on its own, so a hand comes back paler
    // than the arm it is attached to (measured: 18% and 26% on two sheets) and
    // reads on the model as a glove. The importer gains the whole island to the
    // named island's mean luminance — level only, hue untouched, because a palm
    // IS pinker than a forearm and that is not the error.
    slots: {
      // No sizeScale. The head had 1.3 — a third more texels per unit than the
      // rest of the ogre — on the theory that the face is what a player looks
      // at. It reads as a different material: a crisp face on a soft body, which
      // is worse than either alone. One density for the whole animal.
      head: { color: "#ff0000", fit: "contain" },
      "chest-front": { color: "#ff7d00", fit: "contain" },
      "chest-back": { color: "#b35300", fit: "contain" },
      "legs-front": { color: "#3cff00", fit: "contain" },
      "legs-back": { color: "#0f3e00", fit: "contain" },
      "arm-top": { color: "#1f00ff", fit: "contain" },
      "arm-bottom": { color: "#00a2ff", fit: "contain", matchTo: "arm-top" },
      "hand-top": { color: "#a900ff", fit: "contain", matchTo: "arm-top" },
      "hand-palm": { color: "#ff8b8b", fit: "contain", matchTo: "arm-top" },
      foot: { color: "#00c08b", fit: "contain", matchTo: "legs-front" },
      // The three faces a single flat view cannot reach — see `split` below.
      "arm-front": { color: "#ffee00", fit: "contain", matchTo: "arm-top" },
      "hand-side": { color: "#00786b", fit: "contain", matchTo: "arm-top" },
      "hand-inner": { color: "#ff2e93", fit: "contain", matchTo: "arm-top" },
    },
    parts: {
      // The four body shells: looked at along X, so the island is the body seen
      // squarely from the front or the back. No rim — a shell's own sides are
      // continuous with it and belong at the edge of its island, compressed,
      // rather than in a separate bar a generator would paint as a different
      // thing.
      Ogre_ChestFront: { slot: "chest-front", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      Ogre_ChestBack: { slot: "chest-back", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      Ogre_LegsFront: { slot: "legs-front", method: "plane", u: "+z", v: "-y", flare: 0.28 },
      Ogre_LegsBack: { slot: "legs-back", method: "plane", u: "+z", v: "-y", flare: 0.2 },
      // The head: a profile, with a band under it for the skull top, the brow,
      // the face front and the underside of the jaw — everything the profile
      // cannot see. Seam at the chin, so the band reads jaw -> face -> brow ->
      // crown -> nape.
      Ogre_Head: { slot: "head", method: "plane", u: "+x", v: "-y", flare: 0.8 },
      // The arm's outer shell, seen from outside the body: shoulder at the top,
      // wrist at the bottom, with its front and back edges in the band beneath.
      Ogre_Arm_Top: {
        slot: "arm-top",
        method: "plane",
        u: "+x",
        v: "-y",
        flare: 0.5,
        // The FRONT of the arm. Measured, its faces point (0.98, 0.05, 0.18) —
        // square-on to +X and edge-on to the view down Z that the rest of the
        // shell wants, so left in arm-top they fold flat onto the outer arm.
        // Looked at down their own axis they are a clean strip: the front of a
        // limb, shoulder at the top, wrist at the bottom.
        split: [{ slot: "arm-front", facing: "+x", above: 0.6, u: "+z", v: "-y", flare: 0.3 }],
      },
      // The inner panel that closes the arm: 89% of it already faces Z, so it
      // projects whole and has no band.
      Ogre_Arm_Bottom: { slot: "arm-bottom", method: "plane", u: "+x", v: "-y", flare: 0.35 },
      // The hand is a slab hanging at 45 degrees, so neither axis sees it
      // square-on; Z keeps two thirds and the band takes the knuckles and the
      // edge of the hand.
      // The back of the hand turns a corner: measured, 52% of its area faces
      // +X and 56% faces -Z. One flat view cannot have both, so it gets two.
      Orge_HandTop: {
        slot: "hand-top",
        method: "plane",
        u: "+x",
        v: "-y",
        flare: 0.15,
        split: [{ slot: "hand-side", facing: "+x", above: 0.6, u: "+z", v: "-y", flare: 0.2 }],
      },
      // The palm, the same corner from the other side: 63% faces -X, 65% +Z.
      Orge_HandPalm: {
        slot: "hand-palm",
        method: "plane",
        u: "+x",
        v: "-y",
        flare: 0.15,
        split: [{ slot: "hand-inner", facing: "-x", above: 0.6, u: "+z", v: "-y", flare: 0.2 }],
      },
      // The foot from ABOVE: the island is a footprint with the toes to the
      // right, the sole shares the top's texels (it is never seen), and the band
      // under it wraps the sides, the toe and the heel. Seam at the heel.
      Ogre_Foot: { slot: "foot", method: "plane", u: "+x", v: "+z", flare: 0.45 },
    },
    // The sheet reads as the animal: the FRONT of the ogre down the left column
    // — head, chest, legs, in that order — the BACK down the middle, and the
    // arm with the small parts on the right. Laying the two halves out as
    // columns is also what packs: the leg shells are the tallest islands on the
    // sheet and stacking them together would set the scale for everything else.
    //
    // The arm split put three more islands on the sheet and this arrangement
    // paid for all of them: the first attempt at it solved to 2.24 px/unit and
    // this one to 2.77, which is what it was before the split. A layout is worth
    // ten minutes.
    layout: {
      row: [
        { col: ["head", "chest-front", "legs-front"] },
        { col: ["chest-back", "legs-back", "arm-front"] },
        { col: ["arm-top", "arm-bottom", { row: ["foot", "hand-top"] }, { row: ["hand-palm", "hand-side", "hand-inner"] }] },
      ],
    },
    // An ogre is solid: no alpha anywhere on this sheet.
    cutoutSlots: [],
    // One assembly, because there is only one — the whole animal.
    combos: [
      [
        "Ogre_Head",
        "Ogre_ChestFront",
        "Ogre_ChestBack",
        "Ogre_LegsFront",
        "Ogre_LegsBack",
        "Ogre_Arm_Top",
        "Ogre_Arm_Bottom",
        "Orge_HandTop",
        "Orge_HandPalm",
        "Ogre_Foot",
      ],
    ],
  },
};

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--no-")) out[a.slice(5)] = false;
    else if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SURVEY = args.survey === true;
const recipeName = String(args.recipe ?? "longsword");
const recipe = RECIPES[recipeName];
// A survey runs on a mesh that has no recipe yet — that is the point of it.
if (!recipe && !SURVEY) {
  console.error(`unwrap-weapon: unknown recipe "${recipeName}" (have: ${Object.keys(RECIPES).join(", ")})`);
  process.exit(1);
}
if (SURVEY && !recipe && !args.in) {
  console.error("unwrap-weapon --survey: pass --in <file.obj|file.fbx>");
  process.exit(1);
}

const srcPath = path.resolve(args.in ? String(args.in) : path.join(STUDIO, recipe.source));
const outMesh = path.resolve(
  args["out-mesh"] ? String(args["out-mesh"]) : path.join(STUDIO, recipe?.outMesh ?? "survey"),
);
// ONE FOLDER PER SET, named for the recipe. Everything that describes how a
// model is unwrapped — the key, the slot manifest, the check render and the
// generator prompt — lives together in tools/atlas/sets/<recipe>/, and the
// things generated FROM it live in siblings: tools/atlas/art/<recipe>/<theme>
// for the 1254 sheets and tools/atlas/out/<recipe>/<theme>/ for the atlases.
// Flat, that folder reached 40 MB and 38 output directories across three
// different keys with nothing but a filename prefix to say which was which.
const atlasDir = path.resolve(args["atlas-dir"] ? String(args["atlas-dir"]) : path.join(ENGINE, "tools/atlas"));
const setDir = path.join(atlasDir, "sets", recipeName);
const keyPath = path.join(setDir, "key.png");
const manifestPath = path.join(setDir, "manifest.json");
const checkPath = path.join(setDir, "key-check.png");

// ---------------------------------------------------------------------------
// small geometry helpers
// ---------------------------------------------------------------------------

const AXIS = { x: 0, y: 1, z: 2 };

/** "+z" / "-y" -> { axis: 2, sign: 1 }. */
function dir(spec) {
  const sign = spec[0] === "-" ? -1 : 1;
  return { axis: AXIS[spec[spec.length - 1]], sign };
}

/**
 * Lay a part's EDGE faces out as a band, by giving each face its own stretch of
 * it rather than looking up where each vertex falls.
 *
 * Every edge face contains the thickness direction, so seen down that direction
 * it collapses to a SEGMENT — its own piece of the silhouette's outline. Those
 * segments are chained into a loop and the band is divided between them in
 * proportion to their length. Nothing can overlap and nothing can be missed,
 * because each face is handed a stretch instead of asking for one.
 *
 * The obvious alternative — parameterise the outline once and look up each
 * vertex's place on it — fails on the crossguards, and took two tries to see
 * why. First by angle from the centre, which has no meaning on a bar twelve
 * units long and one and a half tall. Then by nearest point on the outline,
 * which is stable but not injective: these bars are several boxes merged, so
 * sixteen edge faces share an eight-sided outline, several of them landing on
 * the same stretch while other stretches got nothing. The islands came out as
 * bowties with white wedges bitten out of them.
 *
 * @param {THREE.Vector3[][]} tris the edge faces
 * @param {number} axis the thickness axis, looked down
 * @param {[number, number]} towards which way the seam is cut
 * @returns {{ total: number, a0: number, a1: number, uv(tri): number[][] } | null}
 */
function edgeBand(tris, axis, towards, foldPerp = null) {
  const perp = [0, 1, 2].filter((a) => a !== axis);
  const [pa, pb] = perp;

  // MIRROR the cross-section, where the part allows it: measure across from the
  // middle plane so the far side of the part lands on the near side's texels
  // and the two are painted once, together. That is the whole point on a
  // crossguard — you want to KNOW both faces match.
  //
  // It works here for the same reason the depth fold does: these parts are
  // modelled as two mirrored halves, so no face straddles the middle plane. One
  // that did would fold onto itself and collapse to a line, so the check is
  // made rather than assumed.
  const all = tris.flat();
  let mirror = null;
  if (foldPerp !== null) {
    const vals = all.map((v) => v.getComponent(foldPerp));
    const mid = (Math.min(...vals) + Math.max(...vals)) / 2;
    const eps = (Math.max(...vals) - Math.min(...vals)) * 0.05;
    const safe = tris.every((t) => {
      const d = t.map((v) => v.getComponent(foldPerp) - mid);
      return Math.max(...d) <= eps || Math.min(...d) >= -eps;
    });
    if (safe) mirror = mid;
  }
  const coord = (v, a) =>
    mirror !== null && a === foldPerp ? Math.abs(v.getComponent(a) - mirror) : v.getComponent(a);
  const flat = (v) => [coord(v, pa), coord(v, pb)];
  const q = (n) => Math.round(n * 1e4) / 1e4;
  const key = (p) => `${q(p[0])},${q(p[1])}`;

  // Each face, seen down the thickness, is a segment.
  const segs = new Map();
  const owner = [];
  for (const tri of tris) {
    const pts = tri.map(flat);
    let a = 0;
    let b = 1;
    let far = -1;
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2;
        if (d > far) { far = d; a = i; b = j; }
      }
    if (far < 1e-10) return null; // a face square-on to the thickness: not an edge
    const [A, B] = key(pts[a]) < key(pts[b]) ? [pts[a], pts[b]] : [pts[b], pts[a]];
    const id = `${key(A)}|${key(B)}`;
    if (!segs.has(id)) segs.set(id, { A, B, len: Math.sqrt(far) });
    owner.push(id);
  }

  // Chain the segments into a loop through their shared endpoints. A part whose
  // edge does not close into one loop falls back to going round by angle, which
  // is right for anything convex and is only a tidiness question anyway: every
  // face still gets its own stretch either way.
  const ends = new Map();
  for (const [id, s] of segs)
    for (const p of [s.A, s.B]) {
      const k = key(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(id);
    }
  const order = [];
  const list = [...segs.keys()];
  if ([...ends.values()].every((v) => v.length === 2)) {
    const used = new Set();
    let id = list[0];
    let at = key(segs.get(id).A);
    while (id && !used.has(id)) {
      used.add(id);
      order.push(id);
      const s = segs.get(id);
      const other = key(s.A) === at ? key(s.B) : key(s.A);
      id = (ends.get(other) ?? []).find((x) => !used.has(x));
      at = other;
    }
    if (used.size !== segs.size) order.length = 0;
  }
  if (!order.length) {
    const mid = (s) => [(s.A[0] + s.B[0]) / 2, (s.A[1] + s.B[1]) / 2];
    const c = [...segs.values()].reduce((a, s) => [a[0] + mid(s)[0] / segs.size, a[1] + mid(s)[1] / segs.size], [0, 0]);
    order.push(
      ...list.sort((x, y) => {
        const mx = mid(segs.get(x));
        const my = mid(segs.get(y));
        return Math.atan2(mx[0] - c[0], mx[1] - c[1]) - Math.atan2(my[0] - c[0], my[1] - c[1]);
      }),
    );
  }
  // Start the band at the segment furthest along the seam direction.
  let start = 0;
  let bestDot = -Infinity;
  for (const [i, id] of order.entries()) {
    const s = segs.get(id);
    const d = ((s.A[0] + s.B[0]) / 2) * towards[0] + ((s.A[1] + s.B[1]) / 2) * towards[1];
    if (d > bestDot) { bestDot = d; start = i; }
  }
  const ring = order.slice(start).concat(order.slice(0, start));
  const at = new Map();
  let run = 0;
  for (const id of ring) {
    at.set(id, run);
    run += segs.get(id).len;
  }
  const total = run || 1;
  const along = tris.flat().map((v) => v.getComponent(axis));
  const lo = Math.min(...along);
  const hi = Math.max(...along);

  // FOLD the band in half where the part allows it. These crossguards are
  // modelled as two mirrored halves, so every edge face covers only the front
  // or only the back of the thickness — laid out honestly the bar comes out
  // half empty, with the holes in different places on every guard. Measuring
  // from the middle plane instead puts each face on top of its own mirror
  // image: no holes, half the sheet, and the front and back of the part wear
  // the same paint, which a symmetric weapon wants anyway.
  //
  // Only where it is SAFE: a face that straddles the middle would fold onto
  // itself and collapse to a line. The pommels are modelled in one piece and
  // fill the bar without help, so they simply do not qualify.
  const mid = (lo + hi) / 2;
  const eps = (hi - lo) * 0.05;
  const fold = tris.every((t) => {
    const d = t.map((v) => v.getComponent(axis) - mid);
    return Math.max(...d) <= eps || Math.min(...d) >= -eps;
  });
  const depth = (v) => (fold ? Math.abs(v.getComponent(axis) - mid) : v.getComponent(axis));

  // Each segment's own depth range fills the bar's whole height. Without this
  // the bar comes out in ragged blocks: a chamfer is shallower than the face
  // beside it, a half-thickness box shallower again, and every one of them
  // leaves a sliver of bare island above it. Stretching per segment costs a
  // little honesty about proportion on a strip that is painted as plain metal,
  // and buys a bar with no holes in it for the generator to fill with nothing.
  const range = new Map();
  for (const [i, tri] of tris.entries()) {
    const id = owner[i];
    const r = range.get(id) ?? { lo: Infinity, hi: -Infinity };
    for (const v of tri) {
      const d = depth(v);
      r.lo = Math.min(r.lo, d);
      r.hi = Math.max(r.hi, d);
    }
    range.set(id, r);
  }
  const height = Math.max(...[...range.values()].map((r) => r.hi - r.lo), 1e-6);

  return {
    total,
    a0: 0,
    a1: height,
    folded: fold,
    uv(i) {
      const id = owner[i];
      const s = segs.get(id);
      const base = at.get(id);
      const r = range.get(id);
      const rise = r.hi - r.lo;
      const dx = s.B[0] - s.A[0];
      const dy = s.B[1] - s.A[1];
      const l2 = dx * dx + dy * dy || 1e-12;
      return tris[i].map((v) => {
        const p = flat(v);
        const t = Math.max(0, Math.min(1, ((p[0] - s.A[0]) * dx + (p[1] - s.A[1]) * dy) / l2));
        return [base + t * s.len, rise < 1e-9 ? 0 : ((depth(v) - r.lo) / rise) * height];
      });
    },
  };
}

/**
 * The real outline of a triangulated silhouette: every edge that only one
 * triangle owns, chained into a loop.
 *
 * The convex hull is not good enough here. A crossguard flares at the tips, so
 * its silhouette is CONCAVE, and hanging the rim off a hull stretches some
 * faces over the notch while leaving others stacked on the same stretch of
 * outline — islands came out as bowties with white wedges bitten out of them.
 * The outline the geometry actually has does not lie.
 *
 * @param {number[][][]} tris triangles as three [u, v] corners
 * @returns {number[][] | null} the longest boundary loop, or null if it is open
 */
function outlineOf(tris) {
  const q = (n) => Math.round(n * 1e4) / 1e4;
  const key = (p) => `${q(p[0])},${q(p[1])}`;
  const edges = new Map(); // undirected edge -> [count, a, b]
  for (const t of tris)
    for (let i = 0; i < 3; i++) {
      const a = t[i];
      const b = t[(i + 1) % 3];
      const ka = key(a);
      const kb = key(b);
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(id);
      if (e) e[0]++;
      else edges.set(id, [1, a, b]);
    }
  /** @type {Map<string, number[][]>} */
  const next = new Map();
  for (const [, [n, a, b]] of edges) {
    if (n !== 1) continue; // shared by two triangles: interior
    for (const [from, to] of [[a, b], [b, a]]) {
      const k = key(from);
      if (!next.has(k)) next.set(k, []);
      next.get(k).push(to);
    }
  }
  if (!next.size) return null;
  // Walk the longest loop. Boundary vertices have exactly two neighbours on a
  // clean silhouette; anything stranger means the outline is not a simple loop
  // and the caller falls back to the hull.
  let best = null;
  const seen = new Set();
  for (const [k0] of next) {
    if (seen.has(k0)) continue;
    const loop = [];
    let cur = next.get(k0)[0];
    let prevK = k0;
    loop.push(k0.split(",").map(Number));
    for (let guard = 0; guard < 4096; guard++) {
      const k = key(cur);
      seen.add(k);
      if (k === k0) break;
      loop.push(cur);
      const opts = next.get(k);
      if (!opts || opts.length !== 2) { loop.length = 0; break; }
      const step = key(opts[0]) === prevK ? opts[1] : opts[0];
      prevK = k;
      cur = step;
    }
    if (loop.length > (best?.length ?? 0)) best = loop.slice();
  }
  return best && best.length >= 3 ? best : null;
}

/** Andrew's monotone chain. Points are [x, y] pairs; returns CCW hull. */
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

console.log(`unwrap-weapon: ${recipeName}`);
console.log(`  source ${path.relative(STUDIO, srcPath)}`);

/**
 * Both source formats end up as the same thing: a list of named parts whose
 * triangle corners are plain world-space points. Nothing downstream cares which
 * file they came from.
 *
 * OBJ is here because Blockbench is where the model is actually edited, and it
 * writes OBJ at 1/100 of the units its FBX export uses (measured: Male.obj
 * against HumanTest.fbx, 100.000 on every axis). `sourceScale` puts them back
 * on the same ruler so one recipe describes the weapon either way.
 */
function loadParts(file, scale) {
  const out = [];
  if (/\.obj$/i.test(file)) {
    const group = new OBJLoader().parse(fs.readFileSync(file, "utf8"));
    group.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
      const pos = geo.attributes.position;
      const world = [];
      for (let i = 0; i < pos.count; i++)
        world.push(new THREE.Vector3().fromBufferAttribute(pos, i).multiplyScalar(scale));
      out.push({ name: o.name, world });
    });
    return out;
  }
  const root = new FBXLoader().parse(sanitizeFbx(fs.readFileSync(file)), path.dirname(file) + "/");
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const pos = geo.attributes.position;
    // Unwrap in WORLD space: the recipe talks about the assembled sword ("the
    // flat of the blade is X"), and the parts carry 90-degree node rotations.
    const world = [];
    for (let i = 0; i < pos.count; i++)
      world.push(
        new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).multiplyScalar(scale),
      );
    out.push({ name: o.name, world });
  });
  return out;
}

const SOURCE_SCALE = Number(
  args["source-scale"] ?? recipe?.sourceScale ?? (/\.obj$/i.test(srcPath) ? 100 : 1),
);
const found = loadParts(srcPath, SOURCE_SCALE);

// ---------------------------------------------------------------------------
// --survey: what shape is each part, before any recipe exists
// ---------------------------------------------------------------------------
//
// The first thing to do with a new weapon, and the number that decides
// everything else. For each part: how much of its area faces each axis, and
// how much of it a projection along X — the weapon's thickness, the flat of
// the blade — would keep.
//
//   >95% kept   plane, no rim          a blade
//   ~40% kept   band around its length  a crossguard: its top is the rest
//   split       plane + rim             a collar or a disc pommel
//   all slanted plane along the OTHER axis, or unroll
//
// Guessing instead of measuring costs a whole round trip through a generator.
if (SURVEY) {
  console.log(`\n  part               tris   faces X   faces Y   faces Z   kept by a flat view`);
  for (const p of found) {
    const n = new THREE.Vector3();
    const bucket = [0, 0, 0];
    let area = 0;
    let keptX = 0;
    for (let t = 0; t < p.world.length / 3; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => p.world[t * 3 + k]);
      n.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const len = n.length();
      if (len < 1e-12) continue;
      const tri = len / 2;
      area += tri;
      const u = [Math.abs(n.x / len), Math.abs(n.y / len), Math.abs(n.z / len)];
      bucket[u[0] >= u[1] && u[0] >= u[2] ? 0 : u[1] >= u[2] ? 1 : 2] += tri;
      keptX += tri * u[0];
    }
    if (!area) continue;
    const pc = (v) => `${((v / area) * 100).toFixed(0)}%`.padStart(6);
    console.log(
      `  ${p.name.padEnd(18)} ${String(p.world.length / 3).padStart(4)}  ${pc(bucket[0])}    ` +
        `${pc(bucket[1])}    ${pc(bucket[2])}    ${pc(keptX)}`,
    );
  }
  console.log(
    `\n  ${found.length} parts. Families are the names with their trailing number removed.\n` +
      "  docs/weapon-atlas.md -> Choosing an unwrap method\n",
  );
  process.exit(0);
}

// A working Blockbench file is not a clean export: this one carries a hood from
// the character work and several copies of a previous run of this very tool,
// re-imported and left in place. Take the parts the recipe names, first
// occurrence only, and say out loud what was ignored.
const parts = [];
const taken = new Set();
const dropped = [];
for (const p of found) {
  if (!recipe.parts[p.name] || taken.has(p.name)) {
    dropped.push(p.name);
    continue;
  }
  taken.add(p.name);
  parts.push(p);
}
if (dropped.length) {
  const tally = [...new Set(dropped)].map((n) => {
    const k = dropped.filter((d) => d === n).length;
    return k > 1 ? `${n} x${k}` : n;
  });
  console.log(`  ignored (not in the recipe, or a later copy): ${tally.join(", ")}`);
}

const missing = Object.keys(recipe.parts).filter((n) => !taken.has(n));
if (missing.length) {
  console.error(`! recipe names parts the file does not have: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`  ${parts.length} parts, ${parts.reduce((a, p) => a + p.world.length / 3, 0)} triangles`);

// The surface normal at every shared position, which both the flare (below)
// and the exported mesh's smooth shading are measured from.
const NORMALS = surfaceNormals(parts);

// ---------------------------------------------------------------------------
// per-part unwrap, in island-local world units
// ---------------------------------------------------------------------------
//
// Every method writes (iu, iv) per vertex into a slot's own coordinate space,
// where iv grows DOWNWARD — the direction a PNG's rows run, and the direction
// glTF's V runs. Islands are normalised and placed later.

/** @type {Map<string, { tris: { part: string, idx: number[], uv: number[][] }[] }>} */
const slots = new Map();
for (const name of Object.keys(recipe.slots)) slots.set(name, { tris: [] });

const axisValue = (v, d) => d.sign * v.getComponent(d.axis);

/**
 * A part peeled open around its own LENGTH — the crossguard treatment.
 *
 * The bar's whole surface lands in one rectangle: read the island across and
 * you are travelling along the guard, read it down and you are going around the
 * cross-section, from the underside up over the top. Nothing is squashed into a
 * strip and nothing is left over, so the top of a guard — which is more than
 * half of it — gets the texels it deserves rather than the sliver a silhouette
 * would leave it.
 *
 * `fold` mirrors the far side onto the near one, so the two faces of the guard
 * are painted once, together, and are symmetric by construction.
 *
 * The faces at the two ENDS are the exception: square-on to the length, they
 * have no place in a band. They are a couple of percent of the surface and get
 * the same small patch as any other face a projection cannot see.
 */
function bandUnwrap(part, spec) {
  const axis = AXIS[spec.axis];
  const target = slots.get(spec.slot);
  const body = [];
  const capped = [];
  for (let t = 0; t < part.world.length / 3; t++) {
    const p = [0, 1, 2].map((k) => part.world[t * 3 + k]);
    const n = new THREE.Vector3()
      .subVectors(p[1], p[0])
      .cross(new THREE.Vector3().subVectors(p[2], p[0]))
      .normalize();
    (Math.abs(n.getComponent(axis)) > 0.7 ? capped : body).push({ t, p });
  }
  const seam = dir(spec.seam ?? "-y");
  const perp = [0, 1, 2].filter((a) => a !== axis);
  const towards = perp.map((a) => (a === seam.axis ? seam.sign : 0));
  const band = edgeBand(
    body.map((x) => x.p),
    axis,
    towards,
    spec.fold ? AXIS[spec.fold] : null,
  );
  if (!band) {
    console.warn(`! ${part.name}: cannot band-unwrap; no face runs along ${spec.axis}`);
    return;
  }
  const uIsArc = spec.u === "arc";
  const dOther = dir(uIsArc ? spec.v : spec.u);
  const push = (t, uv) =>
    target.tris.push({ part: part.name, idx: [0, 1, 2].map((k) => t * 3 + k), uv });
  for (const [i, { t }] of body.entries())
    push(
      t,
      band.uv(i).map(([arc, along], k) => {
        const other = axisValue(body[i].p[k], dOther);
        return uIsArc ? [arc, other] : [other, arc];
      }),
    );
  // The end caps, parked at the island's edge; the rescue pass gives them a
  // patch of their own part's paint.
  for (const { t, p } of capped)
    push(
      t,
      p.map((v) => (uIsArc ? [0, axisValue(v, dOther)] : [axisValue(v, dOther), 0])),
    );
}

/**
 * A part seen flat-on, plus — for the faces that view cannot see — a bar
 * attached underneath it, IN THE SAME SLOT.
 *
 * The silhouette is the whole point: a generator asked for a crossguard draws a
 * crossguard, tips and all, and it drew exactly that over the first version of
 * this sheet, where the island was an unrolled rectangle. Two thirds of those
 * islands came back unpainted. An island shaped like the thing being painted is
 * the difference between artwork that lands and artwork that has to be rescued.
 *
 * Because the dropped axis is the sword's thickness, the FRONT and BACK of the
 * part fall on the same texels: painted once, mirrored onto the other side,
 * which is what a symmetric weapon wants.
 *
 * The bar underneath carries the edges — the top and bottom of a crossguard,
 * the rim of a disc — unrolled around the outline. It is as WIDE as the piece
 * and as TALL as the piece is THICK, which is both easy to explain in a prompt
 * and roughly the right share of the sheet. It touches the silhouette, so the
 * two read (and register) as one island rather than two.
 */
/**
 * Positions shared between triangles, and the normal of the SURFACE there.
 *
 * The mesh is non-indexed, so the same corner appears once per face with that
 * face's own normal. Anything that moves a vertex has to move every copy of it
 * the same way or the island tears, so the average at a position is the only
 * usable answer. Area-weighted, and no crease angle: a crease would split the
 * average and tear exactly the islands this is here to keep whole.
 */
function surfaceNormals(parts) {
  const q = (n) => Math.round(n * 1e3);
  const key = (v) => `${q(v.x)},${q(v.y)},${q(v.z)}`;
  const at = new Map();
  const faces = new Map();
  for (const part of parts) {
    const ns = [];
    for (let t = 0; t < part.world.length / 3; t++) {
      const p = [0, 1, 2].map((k) => part.world[t * 3 + k]);
      const n = new THREE.Vector3()
        .subVectors(p[1], p[0])
        .cross(new THREE.Vector3().subVectors(p[2], p[0]));
      const area = n.length() / 2;
      if (area > 1e-12) n.normalize();
      ns.push({ n, area });
      for (const v of p) {
        const k = key(v);
        if (!at.has(k)) at.set(k, []);
        at.get(k).push({ n, area });
      }
    }
    faces.set(part.name, ns);
  }
  const avg = new Map();
  for (const [k, list] of at) {
    const a = new THREE.Vector3();
    for (const { n, area } of list) a.addScaledVector(n, area);
    avg.set(k, a.lengthSq() > 1e-12 ? a.normalize() : new THREE.Vector3(0, 1, 0));
  }
  return { faces, at: (v) => avg.get(key(v)) ?? new THREE.Vector3(0, 1, 0), key };
}

/**
 * FLARE: unfold the part of a shell that curves away from the projection,
 * instead of letting it collapse into the silhouette's edge.
 *
 * A plane projection is honest about the face it looks at and brutal to
 * everything else. On a weapon that costs nothing — a blade has no sides worth
 * the name. On an ANIMAL it is the whole problem: the front of an ogre's face
 * is a real surface a hand's breadth across, and looked at along the head's
 * left-to-right axis it is exactly edge-on, so it lands on a one-texel line at
 * the right of the island and the artwork there smears forward over the muzzle
 * as a starburst. The sides of the chest, the outside of a thigh and the
 * knuckles all go the same way, and a face too edge-on to keep any area at all
 * ends up wearing one flat patch — the stray facets on the ogre's chest.
 *
 * So push every vertex OUTWARD, along the direction the surface is heading,
 * by how deep it sits under the part's outer surface. Unfolding a box this way
 * lays its sides out as bands attached to the front face, which is what a paper
 * model does; on a curved shell it is the same thing continuously, and it is
 * monotonic — a sphere's angle θ maps to sinθ + (1 - cosθ), which never turns
 * back on itself, so the island cannot fold over itself either.
 *
 * Depth is measured differently depending on whether the part is a SHELL or a
 * whole piece, and the difference matters:
 *
 *   one-sided (a front shell: 58% of the ogre's chest faces forward and 1%
 *     back) — depth runs from the frontmost surface backwards, so the middle of
 *     the chest does not move and its sides swing out.
 *   two-sided (a head: both cheeks) — the projection already folds left onto
 *     right, so depth is measured from the OUTER surface inward: the cheeks
 *     themselves do not move, and the muzzle, the crown and the jaw — the
 *     surfaces the fold cannot see — unfold out past the profile.
 */
function flareOf(part, spec, dropped, normals) {
  const flare = Number(spec.flare ?? 0);
  if (!flare) return null;
  let plus = 0;
  let minus = 0;
  for (let t = 0; t < part.world.length / 3; t++) {
    const { n, area } = normals.faces.get(part.name)[t];
    const c = n.getComponent(dropped);
    if (c > 0) plus += area * c;
    else minus += area * -c;
  }
  const vals = part.world.map((v) => v.getComponent(dropped));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2 || 1e-6;
  const twoSided = Math.min(plus, minus) / (plus + minus || 1) > 0.15;
  const depth = twoSided
    ? (v) => half - Math.abs(v.getComponent(dropped) - mid)
    : plus >= minus
      ? (v) => hi - v.getComponent(dropped)
      : (v) => v.getComponent(dropped) - lo;
  return { flare, depth, twoSided };
}

/**
 * A part seen flat-on — or, where one flat view cannot see all of it, SPLIT
 * into face groups that each get their own flat view.
 *
 * A shell that turns a corner defeats a single projection outright, and the
 * ogre's arm and hands are both corners: measured, 52% of the back of the hand
 * faces +X and 56% faces -Z. Look down Z and the +X half is edge-on, folds onto
 * the half you kept, and comes out as triangles laid over each other — the
 * "folded in tris" on the upper arm. Look down X and you lose the other half
 * instead. Neither axis is wrong; the assumption that one axis has to do is.
 *
 * So a part may declare `split`: a list of groups, each a direction a face has
 * to be pointing and the slot it goes to. A group may carry its own `u`/`v`
 * and its own `flare`, and then those faces are projected DOWN THEIR OWN AXIS
 * and land square-on; omit them and the group inherits the base projection,
 * which is the cheaper fix for a lip that only needs to be somewhere else.
 * Groups are tested in order and the first match wins, so put the narrow tests
 * first; anything unmatched stays with the part's own slot.
 */
function planeUnwrap(part, spec) {
  /** Base group last: it is the fallback, and it owns the rim. */
  const groups = [...(spec.split ?? []), {}].map((g, i, all) => {
    const base = i === all.length - 1;
    const du = dir(g.u ?? spec.u);
    const dv = dir(g.v ?? spec.v);
    const dropped = [0, 1, 2].find((a) => a !== du.axis && a !== dv.axis);
    const flare = flareOf(part, { flare: g.flare ?? spec.flare }, dropped, NORMALS);
    const want = base ? null : dir(g.facing);
    return {
      base,
      slot: slots.get(g.slot ?? spec.slot),
      name: g.slot ?? spec.slot,
      du,
      dv,
      dropped,
      takes: (n) => base || axisValue(n, want) > (g.above ?? 0.25),
      project: (v) => {
        const iu = axisValue(v, du);
        const iv = axisValue(v, dv);
        if (!flare) return [iu, iv];
        const n = NORMALS.at(v);
        const nu = n.getComponent(du.axis) * du.sign;
        const nv = n.getComponent(dv.axis) * dv.sign;
        const len = Math.hypot(nu, nv);
        if (len < 1e-3) return [iu, iv]; // square-on to the view: nowhere to unfold to
        const d = flare.flare * flare.depth(v);
        return [iu + (nu / len) * d, iv + (nv / len) * d];
      },
    };
  });
  const home = groups[groups.length - 1];
  const dropped = home.dropped;
  const moved = new Map();
  const rimTris = [];
  const mine = [];
  for (let t = 0; t < part.world.length / 3; t++) {
    const p = [0, 1, 2].map((k) => part.world[t * 3 + k]);
    const n = new THREE.Vector3()
      .subVectors(p[1], p[0])
      .cross(new THREE.Vector3().subVectors(p[2], p[0]))
      .normalize();
    // `rim: false` (or absent) means every face projects, however edge-on — the
    // right answer for a part with no flat-on view, such as a faceted pommel
    // seen from above, where every facet is equally slanted.
    if (spec.rim && Math.abs(n.getComponent(dropped)) < (spec.rimBelow ?? 0.7)) {
      rimTris.push({ t, p });
      continue;
    }
    const g = groups.find((x) => x.takes(n));
    const tri = {
      part: part.name,
      idx: [0, 1, 2].map((k) => t * 3 + k),
      uv: p.map(g.project),
      front: n.getComponent(g.dropped) > 0,
      p,
    };
    g.slot.tris.push(tri);
    if (g.base) mine.push(tri);
    else moved.set(g.name, (moved.get(g.name) ?? 0) + 1);
  }
  for (const [to, n] of moved) console.log(`  ${part.name}: ${n} faces split into ${to}`);
  if (!rimTris.length) return;

  // Where the silhouette ended up, so the bar can be hung under it.
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const t of mine)
    for (const [u, v] of t.uv) {
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
  const seam = dir(spec.rimSeam ?? "-y");
  const perp = [0, 1, 2].filter((a) => a !== dropped);
  const towards = perp.map((a) => (a === seam.axis ? seam.sign : 0));
  const band = edgeBand(rimTris.map((x) => x.p), dropped, towards);
  if (!band) {
    console.warn(`! ${part.name}: its edge faces are not edge-on; no bar written`);
    return;
  }
  // The bar is as WIDE as the silhouette and as TALL as the part is THICK, hung
  // directly under it so the two touch and register as one island.
  for (const [i, { t }] of rimTris.entries()) {
    home.slot.tris.push({
      part: part.name,
      idx: [0, 1, 2].map((k) => t * 3 + k),
      uv: band.uv(i).map(([arc, along]) => [
        u0 + (arc / band.total) * (u1 - u0),
        v1 + (along - band.a0),
      ]),
    });
  }
}

/**
 * Peel a run of triangles off around `axis`, like a label off a bottle.
 *
 * Returns `[arc, along]` per vertex of each triangle. Three things here are the
 * difference between a clean band and the chevron-shaped mess a naive
 * cylindrical unwrap produces on exactly these parts:
 *
 *  1. A SPINE, not one centre. A crossguard sweeps: its cross-section at the
 *     wing tips sits well above the one at the middle. Measured from a single
 *     centre, the tips' whole cross-section reads as "up", their angles bunch
 *     into a narrow band, and the island comes out a chevron. The centre is
 *     tracked along the axis instead and each vertex measured against its own
 *     slice.
 *  2. The SEAM ON A CORNER. Cut the band open down the middle of a face and
 *     that face straddles the cut, landing half at each end of the island —
 *     the thin slivers that appear either side of a grip. The requested seam
 *     direction is snapped to the nearest corner of the cross-section, where a
 *     real edge already is.
 *  3. ARC LENGTH, not angle. An angular sweep bunches three quarters of a
 *     square bar's texels into its corners. The arc is walked around the
 *     cross-section's convex hull, so a flat face keeps a flat face's share.
 *
 * A vertex ON the axis — the apex of a faceted pommel — has no angle at all.
 * It takes the mean of its triangle's other two, which is the only answer that
 * keeps the facet from collapsing to a line.
 */
function unrollTris(tris, axis, seamSpec, outlineTris, foldPx = false) {
  const perp = [0, 1, 2].filter((a) => a !== axis);
  const px = perp.includes(0) ? 0 : perp[0]; // the sword's mirror axis where there is one
  const pt = perp.find((a) => a !== px);
  const all = tris.flat();
  const along = all.map((v) => v.getComponent(axis));
  const a0 = Math.min(...along);
  const a1 = Math.max(...along);

  // A rim wraps a shape that has already been drawn flat, so its outline is
  // known exactly and the spine below would only add wobble: the part is a
  // prism through its thickness. One fixed centre, and the silhouette's own
  // boundary rather than a hull.
  const FIXED = !!outlineTris;

  // --- 1. the spine: the cross-section's centre, sampled along the axis
  const BINS = FIXED ? 1 : 8;
  const span = Math.max(1e-6, a1 - a0);
  const bins = Array.from({ length: BINS }, () => ({ x0: Infinity, x1: -Infinity, t0: Infinity, t1: -Infinity }));
  for (const v of all) {
    const b = Math.min(BINS - 1, Math.floor(((v.getComponent(axis) - a0) / span) * BINS));
    const e = bins[b];
    e.x0 = Math.min(e.x0, v.getComponent(px)); e.x1 = Math.max(e.x1, v.getComponent(px));
    e.t0 = Math.min(e.t0, v.getComponent(pt)); e.t1 = Math.max(e.t1, v.getComponent(pt));
  }
  const centres = bins.map((e) => (e.x0 === Infinity ? null : [(e.x0 + e.x1) / 2, (e.t0 + e.t1) / 2]));
  for (let i = 0; i < BINS; i++) {
    if (centres[i]) continue; // an empty slice borrows its nearest filled neighbour
    let l = i, r = i;
    while (l >= 0 && !centres[l]) l--;
    while (r < BINS && !centres[r]) r++;
    centres[i] = centres[l] ?? centres[r] ?? [0, 0];
  }
  const centreAt = (v) => {
    const f = ((v.getComponent(axis) - a0) / span) * BINS - 0.5;
    const i = Math.max(0, Math.min(BINS - 1, Math.floor(f)));
    const j = Math.max(0, Math.min(BINS - 1, i + 1));
    const w = Math.max(0, Math.min(1, f - i));
    return [
      centres[i][0] * (1 - w) + centres[j][0] * w,
      centres[i][1] * (1 - w) + centres[j][1] * w,
    ];
  };
  // MIRROR the cross-section when asked: measure across from the middle plane
  // so the far side of the part lands on the near side's texels. Both faces of
  // a crossguard are then painted once, together, and match by construction.
  // Safe only because these parts are modelled as two halves — a face that
  // straddled the middle would fold onto itself and collapse to a line.
  const straddles = tris.some((t) => {
    const d = t.map((v) => v.getComponent(px) - centreAt(v)[0]);
    return Math.max(...d) > 1e-3 && Math.min(...d) < -1e-3;
  });
  const fold = foldPx && !straddles;
  if (foldPx && straddles) console.warn("  (no mirror: a face crosses the middle plane)");
  const rel = (v) => {
    const c = centreAt(v);
    const dx = v.getComponent(px) - c[0];
    return [fold ? Math.abs(dx) : dx, v.getComponent(pt) - c[1]];
  };

  // --- 2 + 3. the outline, the seam corner, and arc length around it
  //
  // A vertex's place around the outline is found by PROJECTING IT ONTO THE
  // OUTLINE, not by its angle from the centre. The angle is the obvious way and
  // it is wrong on exactly the part that matters most here: a crossguard is a
  // long thin bar, so the whole top surface sits within a few degrees of
  // straight up while spanning half the perimeter, and near the middle of the
  // bar the angle swings wildly for a millimetre of movement. Islands came out
  // as crossed bowties with holes in them. Nearest-point has no such
  // singularity — every face of a rim lies ON the outline, so its projection is
  // stable and monotonic along it.
  // The silhouette's own outline where the caller handed one over (a rim
  // wraps the shape the flat view already drew); its convex hull otherwise.
  // Note the outline has to be measured in THIS function's frame, not the
  // island's: (px, pt) here is not the same pair, or the same order, as the
  // (u, v) the flat projection wrote.
  const poly =
    (outlineTris && outlineOf(outlineTris.map((t) => t.map(rel)))) ?? convexHull(all.map(rel));
  const seam = dir(seamSpec);
  const seamVec = new THREE.Vector3();
  seamVec.setComponent(seam.axis, seam.sign);
  const towards = [seamVec.getComponent(px), seamVec.getComponent(pt)];
  // Cut the band open at the outline corner furthest along the seam direction —
  // the underside of a guard, the back of the grip — so no face straddles it.
  let start = 0;
  let bestDot = -Infinity;
  for (const [i, p] of poly.entries()) {
    // On a mirrored band, start where the surface is cut open: the middle
    // plane. Otherwise the seam lands mid-face and the band begins nowhere.
    const d = p[0] * towards[0] + p[1] * towards[1] - (fold ? Math.abs(p[0]) * 4 : 0);
    if (d > bestDot) { bestDot = d; start = i; }
  }
  const ring = poly.slice(start).concat(poly.slice(0, start));
  const cum = [];
  let s = 0;
  const foldEps = Math.max(...poly.map((q) => Math.abs(q[0]))) * 0.02 + 1e-6;
  for (let i = 0; i < ring.length; i++) {
    cum.push(s);
    const n = ring[(i + 1) % ring.length];
    // The hull of a mirrored cross-section closes across the middle plane, but
    // there is no SURFACE there — it is where the part was cut open. Give that
    // edge no length, or a fifth of the band is spent on nothing.
    const onFold = fold && Math.abs(ring[i][0]) < foldEps && Math.abs(n[0]) < foldEps;
    s += onFold ? 0 : Math.hypot(n[0] - ring[i][0], n[1] - ring[i][1]);
  }
  const total = s || 1;
  const arcOf = (v) => {
    const p = rel(v);
    let bestArc = 0;
    let bestD = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      const d = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
      if (d < bestD) { bestD = d; bestArc = cum[i] + t * Math.sqrt(l2); }
    }
    // Deep inside the outline there is no sensible place on it — the apex of a
    // cone. Those take their triangle's average instead.
    return Math.sqrt(bestD) > total * 0.08 ? null : bestArc;
  };

  return {
    total,
    a0,
    a1,
    /** @returns {number[][]} [arc, along] per vertex of this triangle */
    uv(tri) {
      const raw = tri.map(arcOf);
      // Unwrap around the vertex furthest from the seam, so a face touching it
      // picks the end of the band its neighbours are on rather than both.
      const known = raw.map((x, k) => [x, k]).filter(([x]) => x !== null);
      let arcs;
      if (!known.length) {
        arcs = [0, 0, 0];
      } else {
        const base = known.reduce((b, e) => (Math.abs(e[0] - total / 2) < Math.abs(b[0] - total / 2) ? e : b))[0];
        arcs = raw.map((x) => {
          if (x === null) return null;
          let d = x - base;
          while (d > total / 2) d -= total;
          while (d < -total / 2) d += total;
          return base + d;
        });
        const solid = arcs.filter((x) => x !== null);
        const mean = solid.reduce((a, b) => a + b, 0) / solid.length;
        arcs = arcs.map((x) => (x === null ? mean : x));
      }
      return tri.map((v, k) => [arcs[k], v.getComponent(axis)]);
    },
  };
}

function unrollUnwrap(part, spec) {
  const axis = AXIS[spec.axis];
  const tris = [];
  for (let t = 0; t < part.world.length / 3; t++) tris.push([0, 1, 2].map((k) => part.world[t * 3 + k]));
  // The seam is cut on the least-seen face: the underside of a guard, the back
  // of the grip.
  const un = unrollTris(tris, axis, spec.seam, undefined, spec.fold === "x");
  const target = slots.get(spec.slot);
  const uIsArc = spec.u === "arc";
  const dOther = dir(uIsArc ? spec.v : spec.u);
  for (const [t, tri] of tris.entries()) {
    const uv = un.uv(tri);
    const mapped = uv.map(([arc], k) =>
      uIsArc ? [arc, axisValue(tri[k], dOther)] : [axisValue(tri[k], dOther), arc],
    );
    // A face square-on to the axis — the END of a bar, the cap of a grip — has
    // no place on a band that goes AROUND that axis: pushed through the arc it
    // comes out as a spike across the island. Collapse it to a point and let the
    // rescue pass give it a small patch of its own part's paint instead.
    const n = new THREE.Vector3()
      .subVectors(tri[1], tri[0])
      .cross(new THREE.Vector3().subVectors(tri[2], tri[0]))
      .normalize();
    const cap = Math.abs(n.getComponent(axis)) > 0.7;
    target.tris.push({
      part: part.name,
      idx: [0, 1, 2].map((k) => t * 3 + k),
      uv: cap ? mapped.map(() => mapped[0]) : mapped,
    });
  }
}

for (const part of parts) {
  const spec = recipe.parts[part.name];
  if (!spec) continue;
  if (spec.method === "plane") planeUnwrap(part, spec);
  else if (spec.method === "band") bandUnwrap(part, spec);
  else if (spec.method === "unroll") unrollUnwrap(part, spec);
  else throw new Error(`unknown method ${spec.method}`);
}

// ---------------------------------------------------------------------------
// island boxes and layout
// ---------------------------------------------------------------------------

/** Island extent, in the source file's own units. */
const boxes = new Map();
for (const [name, slot] of slots) {
  if (!slot.tris.length) {
    console.warn(`! slot ${name} has no geometry`);
    continue;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of slot.tris)
    for (const [u, v] of t.uv) {
      x0 = Math.min(x0, u); x1 = Math.max(x1, u);
      y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
  boxes.set(name, { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 });
}

// Overridable so a set can be re-cut denser or with roomier gutters without
// editing the recipe: --sheet 1254 --gutter 78 --size 512.
const SHEET = Number(args.sheet ?? recipe.sheet);
const GUT = Number(args.gutter ?? recipe.gutter);
const MAR = Number(args.margin ?? recipe.margin);
if (args.size) recipe.atlas.size = Number(args.size);
if (args.bleed) recipe.atlas.bleed = Number(args.bleed);

function measure(node, scale) {
  if (typeof node === "string") {
    const b = boxes.get(node);
    const s = scale * (recipe.slots[node]?.sizeScale ?? 1);
    return { w: b.w * s, h: b.h * s, node };
  }
  const kids = (node.row ?? node.col).map((k) => measure(k, scale));
  const gaps = GUT * Math.max(0, kids.length - 1);
  return node.row
    ? { w: kids.reduce((a, k) => a + k.w, 0) + gaps, h: Math.max(...kids.map((k) => k.h)), kids, row: true }
    : { w: Math.max(...kids.map((k) => k.w)), h: kids.reduce((a, k) => a + k.h, 0) + gaps, kids, row: false };
}

function place(m, x, y, out) {
  if (m.node) {
    out.set(m.node, { x, y, w: m.w, h: m.h });
    return;
  }
  let cx = x;
  let cy = y;
  for (const k of m.kids) {
    place(k, cx, cy, out);
    if (m.row) cx += k.w + GUT;
    else cy += k.h + GUT;
  }
}

// Solve the largest scale that still fits the sheet — the blades are 50 units
// long and set the ceiling, everything else follows at the same texel density.
let lo = 0.1;
let hi = 200;
for (let i = 0; i < 60; i++) {
  const mid = (lo + hi) / 2;
  const m = measure(recipe.layout, mid);
  if (m.w <= SHEET - 2 * MAR && m.h <= SHEET - 2 * MAR) lo = mid;
  else hi = mid;
}
const SCALE = lo;
const measured = measure(recipe.layout, SCALE);
const placed = new Map();
place(measured, MAR, MAR, placed);
console.log(
  `  layout ${measured.w.toFixed(0)}x${measured.h.toFixed(0)} of ${SHEET} at ${SCALE.toFixed(2)} px/unit ` +
    `(${(SCALE * (recipe.atlas.size / SHEET)).toFixed(2)} texels/unit at ${recipe.atlas.size})`,
);

// `--islands` prints where every island ended up, which is what the region key
// in prompt-<recipe>.md has to be written from: a prompt that describes a block
// the layout no longer puts there is worse than no prompt at all.
if (args.islands) {
  for (const [name, at] of [...placed].sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x))
    console.log(
      `    ${name.padEnd(13)} x ${at.x.toFixed(0).padStart(4)}..${(at.x + at.w).toFixed(0).padStart(4)}  ` +
        `y ${at.y.toFixed(0).padStart(4)}..${(at.y + at.h).toFixed(0).padStart(4)}  ` +
        `(${at.w.toFixed(0)}x${at.h.toFixed(0)} px, ${((at.w * recipe.atlas.size) / SHEET).toFixed(0)}x${((at.h * recipe.atlas.size) / SHEET).toFixed(0)} texels)`,
    );
}

// Island-local -> sheet pixels -> normalised UV.
for (const [name, slot] of slots) {
  const b = boxes.get(name);
  const at = placed.get(name);
  if (!b || !at) continue;
  const sx = at.w / (b.x1 - b.x0 || 1);
  const sy = at.h / (b.y1 - b.y0 || 1);
  for (const t of slot.tris) t.px = t.uv.map(([u, v]) => [at.x + (u - b.x0) * sx, at.y + (v - b.y0) * sy]);
}

// One atlas texel, in sheet pixels: the finest distinction the finished sheet
// can hold, and so the size below which a triangle cannot carry its own paint.
const TEXEL_PX = SHEET / recipe.atlas.size;
const STROKE = Number(args.stroke ?? recipe.keyStroke ?? 0);

// Faces a projection could not see get a small triangle cut out of a NEIGHBOUR
// rather than a zero-area one, which would sample a line of texels.
//
// Two things here were paid for on the ogre, whose shells are nothing but faces
// turned edge-on to their projection.
//
// WHICH triangles. Zero area is not the test — a face a degree off edge-on
// comes out a hundred pixels long and ONE across, which has area to spare and
// still cannot carry paint: it samples a one-pixel line of the sheet, and where
// that line falls in the gutter the face renders as background. Measured on the
// ogre's first sheet: black bands down the arm and the shin, on faces of 43 to
// 91 square pixels. Anything thinner than one ATLAS texel is in this position,
// since a texel is the finest thing the sheet can say.
//
// WHERE the patch goes. Inside the island's BOX is not good enough: an island
// is a silhouette, and the box around a pair of legs is mostly the gap between
// them. The patch is a shrunken copy of the nearest triangle that DID project,
// which is inside that triangle by construction and so is painted, and near
// enough that it takes the colour of the part of the shell the face belongs to.
let rescued = 0;
for (const [name, slot] of slots) {
  const at = placed.get(name);
  if (!at) continue;
  const centroid = (px) => [(px[0][0] + px[1][0] + px[2][0]) / 3, (px[0][1] + px[1][1] + px[2][1]) / 3];
  // A NEEDLE ONLY NEEDS RESCUING WHEN IT HAS NOWHERE TO LAND. It was rescued
  // because a face a degree off edge-on samples a one-pixel line of the sheet
  // that mostly is not its island — but `keyStroke` grows every island outward
  // in its own colour, so with a margin wider than a texel that line IS its
  // island and the face takes a smear of the skin beside it. That is the better
  // answer by far: a patch is one flat colour over the whole face, and on a
  // shell that cannot flare far — the ogre's legs run at 0.15 so the gap
  // between them survives — fifteen inner-thigh faces of up to 225 square units
  // came out as flat facets floating in the leg. Below the margin, the old rule
  // stands; a triangle that cannot be sampled at all is always rescued.
  const needles = STROKE < TEXEL_PX;
  const carries = (px) => {
    const [a, b, c] = px;
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    if (area < 1) return false;
    if (!needles) return true;
    const L = (i, j) => Math.hypot(px[i][0] - px[j][0], px[i][1] - px[j][1]);
    return (2 * area) / Math.max(L(0, 1), L(1, 2), L(0, 2)) >= TEXEL_PX;
  };
  const hosts = slot.tris.filter((t) => carries(t.px));
  if (!hosts.length) continue; // a slot of nothing but edge-on faces: leave it alone
  for (const t of slot.tris) {
    if (carries(t.px)) continue;
    const [cx, cy] = centroid(t.px);
    let host = hosts[0];
    let best = Infinity;
    for (const h of hosts) {
      const [hx, hy] = centroid(h.px);
      const d = (hx - cx) ** 2 + (hy - cy) ** 2;
      if (d < best) { best = d; host = h; }
    }
    const [hx, hy] = centroid(host.px);
    t.px = host.px.map(([x, y]) => [hx + (x - hx) * 0.35, hy + (y - hy) * 0.35]);
    rescued++;
  }
}
if (rescued) console.log(`  ${rescued} edge-on triangles given a patch cut out of a neighbour`);

// OVERLAP: how much of an island is covered by more than one triangle.
//
// A plane projection folds the two sides of the dropped axis onto each other.
// That is the point of it on a symmetric part — paint once, appear twice — and
// it is a fault anywhere the two sides are not the same surface. A shell that
// wraps past its own silhouette has faces pointing BACK along the view axis,
// and those land on top of the faces pointing forward: two different pieces of
// skin fighting over one patch of sheet, which reads on the model as warping
// that no amount of repainting fixes.
//
// Rasterised at one sample per sheet pixel, which is exact enough to act on and
// cheap enough to run every time.
{
  const rows = [];
  for (const [name, slot] of slots) {
    const at = placed.get(name);
    if (!at || !slot.tris.length) continue;
    const w = Math.max(1, Math.ceil(at.w));
    const h = Math.max(1, Math.ceil(at.h));
    const count = new Uint8Array(w * h);
    const by = new Map();
    for (const t of slot.tris) {
      const P = t.px.map(([x, y]) => [x - at.x, y - at.y]);
      const [a, b, c] = P;
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1])) / area;
          const w1 = ((px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])) / area;
          if (w0 < 0 || w1 < 0 || 1 - w0 - w1 < 0) continue;
          const d = y * w + x;
          if (count[d] === 1) by.set(t.part, (by.get(t.part) ?? 0) + 1);
          if (count[d] < 255) count[d]++;
        }
    }
    let covered = 0;
    let twice = 0;
    for (const n of count) {
      if (n >= 1) covered++;
      if (n >= 2) twice++;
    }
    // IS THE OVERLAP THE POINT? A plane projection folds the two sides of the
    // dropped axis together. On a part with real surface on BOTH sides — a head,
    // whose two cheeks are one mirrored surface, or a foot, whose sole is never
    // seen — that fold is the whole reason for the projection and the island is
    // ~100% doubled by design. On a SHELL, where one side carries the area and
    // the other is a lip that turned back, the same number is a fault. Same test
    // the flare uses, so the two always agree about what a part is.
    let mirrored = false;
    for (const t of slot.tris) {
      const ps = recipe.parts[t.part];
      if (!ps || ps.slot !== name) continue;
      // An unroll or a band asked to `fold` mirrors its far face onto its near
      // one deliberately — that is what makes a crossguard symmetric by
      // construction — so its island is doubled on purpose, same as a head's.
      if (ps.method !== "plane") {
        mirrored = !!ps.fold;
        break;
      }
      const drop = [0, 1, 2].find((a) => a !== dir(ps.u).axis && a !== dir(ps.v).axis);
      let plus = 0;
      let minus = 0;
      for (const { n, area } of NORMALS.faces.get(t.part)) {
        const c = n.getComponent(drop);
        if (c > 0) plus += area * c;
        else minus += area * -c;
      }
      mirrored = Math.min(plus, minus) / (plus + minus || 1) > 0.15;
      break;
    }
    if (twice) rows.push([name, (100 * twice) / (covered || 1), [...by.keys()].join(", "), mirrored]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  for (const [name, pct, who, mirrored] of rows) {
    const bad = pct >= 5 && !mirrored;
    const line = mirrored
      ? `    ${name}: ${pct.toFixed(0)}% doubled — mirrored, which is what this projection is for`
      : `  ${bad ? "!" : " "} ${name}: ${pct.toFixed(1)}% of the island is covered twice (${who})` +
        (bad ? " — split the faces a flat view cannot reach into their own group" : "");
    if (bad) console.error(line);
    else if (args.overlap) console.log(line);
  }
}

// `--debug-slot <name>` draws one island's triangles in alternating colours,
// zoomed, which is the only way to see whether they tile it or fight over it.
if (args["debug-slot"]) {
  const name = String(args["debug-slot"]);
  const slot = slots.get(name);
  const at = placed.get(name);
  if (!slot || !at) {
    console.error(`! no slot ${name}`);
  } else {
    const Z = 4, pad = 4;
    const W2 = Math.ceil((at.w + pad * 2) * Z), H2 = Math.ceil((at.h + pad * 2) * Z);
    const buf = new Uint8Array(W2 * H2 * 4).fill(24);
    for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
    const PAL = [[230,60,60],[60,180,230],[240,190,60],[120,220,120],[200,120,240],[250,140,60],[120,140,250],[60,220,200]];
    for (const [i, t] of slot.tris.entries()) {
      const c = PAL[i % PAL.length];
      const P = t.px.map(([x, y]) => [(x - at.x + pad) * Z, (y - at.y + pad) * Z]);
      const [a, b, cc] = P;
      const area = (b[0]-a[0])*(cc[1]-a[1]) - (cc[0]-a[0])*(b[1]-a[1]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a[0],b[0],cc[0]))), x1 = Math.min(W2-1, Math.ceil(Math.max(a[0],b[0],cc[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1],b[1],cc[1]))), y1 = Math.min(H2-1, Math.ceil(Math.max(a[1],b[1],cc[1])));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0]-a[0])*(py-a[1]) - (px-a[0])*(b[1]-a[1])) / area;
        const w1 = ((px-a[0])*(cc[1]-a[1]) - (cc[0]-a[0])*(py-a[1])) / area;
        if (w0 < 0 || w1 < 0 || 1 - w0 - w1 < 0) continue;
        const o = (y * W2 + x) * 4;
        // half-blend, so an overlap shows as a muddle rather than a clean colour
        buf[o] = (buf[o] + c[0]) >> 1; buf[o+1] = (buf[o+1] + c[1]) >> 1; buf[o+2] = (buf[o+2] + c[2]) >> 1;
      }
    }
    const out = path.join(setDir, `debug-${name}.png`);
    fs.writeFileSync(out, encodePng(W2, H2, buf));
    console.log(`  wrote ${path.relative(STUDIO, out)} — ${slot.tris.length} triangles`);
  }
}
// ---------------------------------------------------------------------------
// draw the key
// ---------------------------------------------------------------------------

const key = new Uint8Array(SHEET * SHEET * 4);
key.fill(255); // white ground — what the importer treats as "not artwork"
const owner = new Int16Array(SHEET * SHEET).fill(-1);
const slotIds = [...slots.keys()];
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * Flat, unfiltered triangle fill with a half-pixel outset.
 *
 * No antialiasing: the importer finds islands by exact colour, and a blended
 * boundary pixel that happens to land on another slot's colour becomes a stray
 * fragment of the wrong island. The outset closes the hairline cracks a
 * top-left fill rule leaves between two triangles sharing an edge.
 */
function fillTri(tri, rgb, id, clash) {
  const [a, b, c] = tri;
  const cxm = (a[0] + b[0] + c[0]) / 3;
  const cym = (a[1] + b[1] + c[1]) / 3;
  const grow = ([x, y]) => {
    const dx = x - cxm;
    const dy = y - cym;
    const l = Math.hypot(dx, dy) || 1;
    return [x + (dx / l) * 0.7, y + (dy / l) * 0.7];
  };
  const [A, B, C] = [grow(a), grow(b), grow(c)];
  const area = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0])));
  const x1 = Math.min(SHEET - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
  const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
  const y1 = Math.min(SHEET - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((B[0] - A[0]) * (py - A[1]) - (px - A[0]) * (B[1] - A[1])) / area;
      const w1 = ((px - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (py - A[1])) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const at = y * SHEET + x;
      if (owner[at] >= 0 && owner[at] !== id) clash.add(`${slotIds[owner[at]]} / ${slotIds[id]}`);
      owner[at] = id;
      key[at * 4] = rgb[0];
      key[at * 4 + 1] = rgb[1];
      key[at * 4 + 2] = rgb[2];
      key[at * 4 + 3] = 255;
    }
}

const clash = new Set();
for (const [i, name] of slotIds.entries()) {
  const slot = slots.get(name);
  const rgb = rgbOf(recipe.slots[name].color);
  for (const t of slot.tris) fillTri(t.px, rgb, i, clash);
}

// STROKE: grow every island outward by a few pixels in its OWN colour.
//
// A generator draws a piece, not a mask. Measured on the first ogre sheet, the
// artwork's own outline sat one to three pixels inside the island's on nearly
// every piece and 4-19% of each island came back unpainted, which is a fringe
// of wrong colour all the way round a limb. Drawn a little large the artwork
// instead runs off the edge, where it is cropped and nobody can tell.
//
// So the island the generator is shown is the island the geometry uses plus a
// margin. Everything downstream reads that: the importer takes the island's
// extent from this key, so the fit lands on the grown outline, and a triangle
// whose UV hangs a pixel past its geometry still samples its own paint.
//
// Growth is a level-synchronous flood from every island at once into WHITE
// only, so two islands cannot meet in the middle — the nearest one takes each
// pixel — and no island can ever eat another's. The layout's gutter is 48
// pixels, so a stroke of a few costs nothing it needs.
if (STROKE > 0) {
  let frontier = [];
  for (let d = 0; d < SHEET * SHEET; d++) if (owner[d] >= 0) frontier.push(d);
  for (let step = 0; step < STROKE && frontier.length; step++) {
    const next = [];
    for (const d of frontier) {
      const x = d % SHEET;
      const y = (d / SHEET) | 0;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= SHEET || ny >= SHEET) continue;
        const nd = ny * SHEET + nx;
        if (owner[nd] >= 0) continue;
        owner[nd] = owner[d];
        const rgb = rgbOf(recipe.slots[slotIds[owner[d]]].color);
        key[nd * 4] = rgb[0];
        key[nd * 4 + 1] = rgb[1];
        key[nd * 4 + 2] = rgb[2];
        key[nd * 4 + 3] = 255;
        next.push(nd);
      }
    }
    frontier = next;
  }
  console.log(`  islands grown ${STROKE}px in their own colour, as a margin for the artwork`);
}
if (clash.size) {
  console.error(`! islands overlap: ${[...clash].join(", ")}`);
  process.exit(1);
}

fs.mkdirSync(setDir, { recursive: true });
fs.writeFileSync(keyPath, encodePng(SHEET, SHEET, key));
console.log(`  wrote ${path.relative(STUDIO, keyPath)}`);

// ---------------------------------------------------------------------------
// UVs onto the mesh
// ---------------------------------------------------------------------------
//
// glTF counts V from the TOP of the image, which is the direction the key's
// rows already run — so the sheet pixel IS the UV, scaled. OBJ counts V from
// the bottom and gets it flipped on the way out.

// `--flip-v` writes the other convention, for a mesh driven by an ENGINE
// material instead of the texture inside the GLB: the engine loads a texture
// asset through three's TextureLoader, whose flipY default is true, so the
// same UVs would land the paint upside down.
const FLIP_V = args["flip-v"] === true;

// Blockbench reads and writes OBJ at 1/100 of the units its FBX export uses.
// Measured, not assumed: Male.obj against HumanTest.fbx — the same model out
// of Blockbench both ways — is 0.92122375 tall against 92.122, a ratio of
// 100.000 on all three axes with no offset. Override with --obj-scale for a
// DCC that disagrees.
const OBJ_SCALE = Number(args["obj-scale"] ?? recipe.objScale ?? 0.01);

for (const part of parts) {
  part.uv = new Float32Array(part.world.length * 2);
  part.uvKey = new Float32Array(part.world.length * 2); // sheet-space, for the check render
}
const byName = new Map(parts.map((p) => [p.name, p]));
for (const [, slot] of slots)
  for (const t of slot.tris) {
    const p = byName.get(t.part);
    for (let k = 0; k < 3; k++) {
      const v = t.px[k][1] / SHEET;
      p.uv[t.idx[k] * 2] = t.px[k][0] / SHEET;
      p.uv[t.idx[k] * 2 + 1] = FLIP_V ? 1 - v : v;
      p.uvKey[t.idx[k] * 2] = t.px[k][0] / SHEET;
      p.uvKey[t.idx[k] * 2 + 1] = v;
    }
  }

// ---------------------------------------------------------------------------
// verify: every triangle must sample its own slot colour
// ---------------------------------------------------------------------------
//
// The check that makes the rest trustworthy. Sample the key at points inside
// every triangle's UVs; anything that lands on white, or on another slot's
// colour, means the artwork for that face will come from the wrong island.

const BARY = [
  [0.6, 0.2, 0.2],
  [0.2, 0.6, 0.2],
  [0.2, 0.2, 0.6],
  [1 / 3, 1 / 3, 1 / 3],
];
let bad = 0;
let slivers = 0;
const badBy = new Map();
// One atlas texel, in sheet pixels. A triangle smaller than that cannot be
// point-sampled reliably — its own rasterised footprint may miss every pixel
// centre — and it takes its colour from its island's bleed regardless. Checking
// one is a false alarm, not a finding.
const TEXEL = TEXEL_PX ** 2;
// A NEEDLE is that same false alarm wearing a different shape, and a creature's
// shells are full of them: a face turned nearly edge-on to the projection comes
// out a hundred pixels long and one across. It has area to spare, so the test
// above lets it through, and then the sample rounds to a pixel centre just
// outside it. Measured on the ogre: minimum altitudes of 0.84 to 1.27 sheet
// pixels, a fifth of an atlas texel. Anything thinner than one atlas texel
// takes its colour from the island around it whatever its UVs say, exactly as
// a sub-texel triangle does.
const thinnerThanATexel = (px) => {
  const L = (i, j) => Math.hypot(px[i][0] - px[j][0], px[i][1] - px[j][1]);
  const longest = Math.max(L(0, 1), L(1, 2), L(0, 2));
  const a = Math.abs(
    (px[1][0] - px[0][0]) * (px[2][1] - px[0][1]) - (px[2][0] - px[0][0]) * (px[1][1] - px[0][1]),
  ) / 2;
  return longest > 0 && (2 * a) / longest < TEXEL_PX;
};
for (const [name, slot] of slots) {
  const want = rgbOf(recipe.slots[name].color).join(",");
  for (const t of slot.tris)
    for (const w of BARY) {
      const area =
        Math.abs(
          (t.px[1][0] - t.px[0][0]) * (t.px[2][1] - t.px[0][1]) -
            (t.px[2][0] - t.px[0][0]) * (t.px[1][1] - t.px[0][1]),
        ) / 2;
      if (area < TEXEL || (STROKE < TEXEL_PX && thinnerThanATexel(t.px))) { slivers++; break; }
      const u = w[0] * t.px[0][0] + w[1] * t.px[1][0] + w[2] * t.px[2][0];
      const v = w[0] * t.px[0][1] + w[1] * t.px[1][1] + w[2] * t.px[2][1];
      const x = Math.min(SHEET - 1, Math.max(0, Math.round(u - 0.5)));
      const y = Math.min(SHEET - 1, Math.max(0, Math.round(v - 0.5)));
      const at = (y * SHEET + x) * 4;
      const got = [key[at], key[at + 1], key[at + 2]].join(",");
      if (got !== want) {
        bad++;
        badBy.set(`${t.part}->${name}`, (badBy.get(`${t.part}->${name}`) ?? 0) + 1);
      }
    }
}
if (bad) {
  console.error(`! ${bad} UV samples land outside their island: ${[...badBy].map(([k, n]) => `${k} x${n}`).join(", ")}`);
} else {
  console.log(
    `  verified: every triangle samples its own island` +
      (slivers ? ` (${slivers} under a texel, left to the bleed)` : ""),
  );
}

// Gutter check: the atlas importer dilates each island outward by `bleed`
// texels, so two islands closer than that trade colours along their edges.
const need = (recipe.atlas.bleed * 2 * SHEET) / recipe.atlas.size;
for (const [a, pa] of placed)
  for (const [b, pb] of placed) {
    if (a >= b) continue;
    const gap = Math.max(pa.x - (pb.x + pb.w), pb.x - (pa.x + pa.w), pa.y - (pb.y + pb.h), pb.y - (pa.y + pa.h));
    if (gap < need - 0.5)
      console.warn(`! ${a} and ${b} are ${gap.toFixed(0)}px apart, under the ${need.toFixed(0)}px the bleed needs`);
  }

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

const manifest = {
  size: recipe.atlas.size,
  bleed: recipe.atlas.bleed,
  ...(recipe.atlas.bgLum === undefined ? {} : { bgLum: recipe.atlas.bgLum }),
  ...(recipe.atlas.bgSat === undefined ? {} : { bgSat: recipe.atlas.bgSat }),
  keyColor: "#00ffff",
  groundFringe: 1,
  fitSearch: 1.6,
  slots: {},
};
for (const [name, cfg] of Object.entries(recipe.slots)) {
  const { color, sizeScale, ...rest } = cfg;
  manifest.slots[color] = {
    name,
    transparency: rest.transparency === true,
    cut: rest.cut ?? false,
    ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "transparency" && k !== "cut")),
  };
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`  wrote ${path.relative(STUDIO, manifestPath)}`);

// ---------------------------------------------------------------------------
// export the mesh
// ---------------------------------------------------------------------------

// `--atlas out-longsword/atlas.png` bakes the finished atlas INTO the GLB, so
// the weapon is one self-contained file — the same thing retarget.mjs does for
// a character. That also settles the V question: a glTF-embedded texture is
// loaded with flipY false, which is the convention these UVs are written in.
// An engine material asset pointing at the same PNG would be flipped (and
// would flatten the cutout material onto every part), so drive the sword from
// the mesh's own materials unless you exported with --flip-v.
let atlasTex = null;
if (args.atlas) {
  const atlasFile = path.resolve(String(args.atlas));
  if (!fs.existsSync(atlasFile)) {
    console.error(`! --atlas ${atlasFile} does not exist`);
    process.exit(1);
  }
  atlasTex = new THREE.TextureLoader().load(atlasFile);
  atlasTex.flipY = FLIP_V;
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.magFilter = THREE.NearestFilter; // PS1-era sheet: keep the texels hard
  atlasTex.minFilter = THREE.NearestMipmapLinearFilter;
  console.log(`  embedding ${path.relative(STUDIO, atlasFile)} (${atlasTex.image?.width ?? "?"}px)`);
}

const solid = new THREE.MeshStandardMaterial({
  name: `${recipeName}`,
  color: 0xffffff,
  map: atlasTex,
  roughness: 0.6,
  metalness: 0.1,
});
// The one cut-out material on the weapon: the ornament is a single plane, so it
// has to render from both sides, and alphaTest rather than `transparent` keeps
// it writing depth and sorting like the solid metal it is drawn as.
const cutout = new THREE.MeshStandardMaterial({
  name: `${recipeName}-ornate`,
  color: 0xffffff,
  map: atlasTex,
  roughness: 0.6,
  metalness: 0.1,
  side: THREE.DoubleSide,
  alphaTest: 0.5,
  transparent: false,
});
const isCutout = (part) => {
  const spec = recipe.parts[part.name];
  return !!spec && recipe.cutoutSlots.includes(spec.slot);
};

// ---------------------------------------------------------------------------
// GLB: the parts kept apart, every transform BAKED
// ---------------------------------------------------------------------------
//
// The parts stay separate and named — that is the whole point of an ubermesh,
// and the game shows one blade, one guard and one pommel out of the seventeen.
// But nothing is left standing on a node transform: each part is rebuilt from
// its own world-space points with its node at identity, so no importer that
// flattens a hierarchy can move a part off the sword.
//
// Normals are recomputed rather than carried over, which on this art is not a
// loss: the mesh is non-indexed and every face is flat, so the recomputed
// normal IS the authored one, and it survives whatever the source format did
// or did not store.
//
// `smooth: <degrees>` averages them instead, ACROSS THE WHOLE BODY rather than
// within a part — the shells share their border vertices, so smoothing each one
// alone would leave a shading seam exactly where the chest meets the back. Flat
// is right for a weapon: a blade's bevel is a real crease and every facet of a
// pommel is meant to read. It is wrong for an animal, where the same facets
// read as the low-poly cage they are. The angle is a crease threshold: faces
// that meet sharper than it keep their own normal, so a jaw line or the top of
// a foot stays an edge while the barrel of a chest goes smooth.


/**
 * Per-vertex normals, averaged at shared positions but only across faces that
 * meet within `degrees` of each other, so a crease survives.
 */
function creasedNormals(parts, degrees) {
  const cos = Math.cos((degrees * Math.PI) / 180);
  const q = (n) => Math.round(n * 1e3);
  const key = (v) => `${q(v.x)},${q(v.y)},${q(v.z)}`;
  const at = new Map();
  const faceOf = new Map();
  for (const part of parts) {
    const ns = [];
    for (let t = 0; t < part.world.length / 3; t++) {
      const p = [0, 1, 2].map((k) => part.world[t * 3 + k]);
      const n = new THREE.Vector3()
        .subVectors(p[1], p[0])
        .cross(new THREE.Vector3().subVectors(p[2], p[0]));
      const area = n.length() / 2;
      if (area > 1e-12) n.normalize();
      ns.push({ n, area });
      for (const v of p) {
        const k = key(v);
        if (!at.has(k)) at.set(k, []);
        at.get(k).push({ n, area });
      }
    }
    faceOf.set(part.name, ns);
  }
  for (const part of parts) {
    const out = new Float32Array(part.world.length * 3);
    for (let t = 0; t < part.world.length / 3; t++) {
      const f = faceOf.get(part.name)[t].n;
      for (let k = 0; k < 3; k++) {
        const acc = new THREE.Vector3();
        for (const c of at.get(key(part.world[t * 3 + k])) ?? [])
          if (c.n.dot(f) >= cos) acc.addScaledVector(c.n, c.area);
        (acc.lengthSq() > 1e-12 ? acc.normalize() : f).toArray(out, (t * 3 + k) * 3);
      }
    }
    part.normal = out;
  }
}
if (recipe.smooth) creasedNormals(parts, Number(recipe.smooth));

const baked = new THREE.Group();
baked.name = path.basename(outMesh);
for (const part of parts) {
  const pos = new Float32Array(part.world.length * 3);
  for (const [i, v] of part.world.entries()) v.toArray(pos, i * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(part.uv, 2));
  if (part.normal) geo.setAttribute("normal", new THREE.BufferAttribute(part.normal, 3));
  else geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, isCutout(part) ? cutout : solid);
  mesh.name = part.name;
  baked.add(mesh);
}
baked.updateMatrixWorld(true);

const glb = await new GLTFExporter().parseAsync(baked, { binary: true, onlyVisible: false });
fs.mkdirSync(path.dirname(outMesh), { recursive: true });
fs.writeFileSync(`${outMesh}.glb`, Buffer.from(glb));
console.log(
  `  wrote ${path.relative(STUDIO, outMesh)}.glb — ${(glb.byteLength / 1024).toFixed(0)} KB, ` +
    `${parts.length} named parts, all transforms baked`,
);

// ---------------------------------------------------------------------------
// the UBERMESH: every part welded into ONE mesh, with a part index per vertex
// ---------------------------------------------------------------------------
//
// This is the mesh the game draws. One geometry and one material means every
// weapon in sight collapses into a single instanced draw — a material boundary
// is a draw-call boundary, so the whole design hangs on there being exactly one
// of each. The parts a given weapon does NOT use are dropped in the vertex
// stage from a per-instance mask, which costs no fragments at all; the price is
// that every weapon submits all of the triangles, which is the cheap half of
// the trade.
//
// The part index rides in **uv1** (TEXCOORD_1) rather than a custom attribute:
// glTF carries a second UV set natively, every exporter and loader already
// round-trips it, and a `_PARTINDEX` would need plumbing at both ends to say
// the same thing.
{
  const order = parts.map((p) => p.name);
  let n = 0;
  for (const p of parts) n += p.world.length;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const uv1 = new Float32Array(n * 2);
  const nrm = parts.every((p) => p.normal) ? new Float32Array(n * 3) : null;
  let at = 0;
  for (const [index, part] of parts.entries()) {
    for (const [i, v] of part.world.entries()) {
      v.toArray(pos, (at + i) * 3);
      if (nrm) nrm.set(part.normal.subarray(i * 3, i * 3 + 3), (at + i) * 3);
      uv[(at + i) * 2] = part.uv[i * 2];
      uv[(at + i) * 2 + 1] = part.uv[i * 2 + 1];
      uv1[(at + i) * 2] = index; // which part this vertex belongs to
    }
    at += part.world.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  if (nrm) geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  else geo.computeVertexNormals();
  // ONE material for the lot, so it stays one draw. `alphaTest` is free on the
  // solid parts — the atlas is opaque everywhere except the ornament cuts — and
  // double-sided is what those single-plane ornaments need.
  const uber = new THREE.MeshStandardMaterial({
    name: `${recipeName}-uber`,
    color: 0xffffff,
    map: atlasTex,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
  });
  const mesh = new THREE.Mesh(geo, uber);
  mesh.name = recipeName;
  const wrap = new THREE.Group();
  wrap.name = `${path.basename(outMesh)}-uber`;
  wrap.add(mesh);
  wrap.updateMatrixWorld(true);
  const uberGlb = await new GLTFExporter().parseAsync(wrap, { binary: true, onlyVisible: false });
  fs.writeFileSync(`${outMesh}-uber.glb`, Buffer.from(uberGlb));
  fs.writeFileSync(
    `${outMesh}-parts.json`,
    JSON.stringify(
      {
        mesh: `${path.basename(outMesh)}-uber.glb`,
        // Bit i of a weapon's mask shows part i. Families are the names with
        // their trailing number removed.
        parts: Object.fromEntries(order.map((nm, i) => [nm, i])),
        cutouts: order.filter((nm) => recipe.cutoutSlots.includes(recipe.parts[nm]?.slot)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `  wrote ${path.relative(STUDIO, outMesh)}-uber.glb — ${(uberGlb.byteLength / 1024).toFixed(0)} KB, ` +
      `1 mesh, ${n / 3} triangles, part index in uv1`,
  );
}

// ---------------------------------------------------------------------------
// OBJ: ONE merged object, at Blockbench's scale
// ---------------------------------------------------------------------------
//
// Two things this file has to get right to come back into Blockbench where it
// left:
//
//  1. SCALE. Blockbench writes and reads OBJ at 1/100 of the units its FBX
//     export uses. Measured on a model exported both ways — Male.obj against
//     HumanTest.fbx — the ratio is 100.000 on all three axes with no offset.
//     An OBJ in FBX units re-imports a hundred times too big and a hundred
//     times too far from the origin, which is what "it loses its position"
//     looks like.
//  2. ONE OBJECT. Thirteen `o` records come back as thirteen separate mesh
//     elements, each with an origin of the importer's choosing. Merged, there
//     is a single element and its vertices are absolute, so there is nothing
//     left to re-origin. The two materials still switch inside it.
//
// Everything stays in the SOURCE file's world space (before the GLB's re-
// origining), so the sword lands back exactly where it was modelled.
// V is flipped on the way out: OBJ measures it from the bottom, glTF from the top.
{
  const S = OBJ_SCALE;
  const n = (v) => (v * S).toFixed(6);
  const lines = [
    `# ${recipeName}, unwrapped by tools/unwrap-weapon.mjs`,
    `# One merged object at Blockbench's OBJ scale (x${S} of the source FBX's units).`,
    `mtllib ${path.basename(outMesh)}.mtl`,
    `o ${path.basename(outMesh)}`,
  ];
  // Solid parts first, then the cut-out ones, so the file needs exactly two
  // material switches rather than one per part.
  const order = [...parts.filter((p) => !isCutout(p)), ...parts.filter(isCutout)];
  const at = new Map();
  let base = 1;
  for (const part of order) {
    at.set(part, base);
    base += part.world.length;
  }
  for (const part of order)
    for (const v of part.world) lines.push(`v ${n(v.x)} ${n(v.y)} ${n(v.z)}`);
  for (const part of order)
    for (let i = 0; i < part.uv.length; i += 2)
      lines.push(`vt ${part.uv[i].toFixed(6)} ${(FLIP_V ? part.uv[i + 1] : 1 - part.uv[i + 1]).toFixed(6)}`);
  for (const [mtl, group] of [
    [recipeName, order.filter((p) => !isCutout(p))],
    [`${recipeName}-ornate`, order.filter(isCutout)],
  ]) {
    if (!group.length) continue;
    lines.push(`usemtl ${mtl}`);
    for (const part of group)
      for (let t = 0; t < part.world.length / 3; t++) {
        const a = at.get(part) + t * 3;
        lines.push(`f ${a}/${a} ${a + 1}/${a + 1} ${a + 2}/${a + 2}`);
      }
  }
  fs.writeFileSync(`${outMesh}.obj`, lines.join("\n") + "\n");

  // The same mesh again with the parts kept APART, one object each, for looking
  // through a part at a time. The MERGED file is still the one to re-import:
  // seventeen objects come back as seventeen elements, each re-origined by the
  // importer. Same coordinates and same scale, so the two are interchangeable
  // for looking at and only differ in how they are grouped.
  const apart = [
    `# ${recipeName}, unwrapped by tools/unwrap-weapon.mjs — ONE OBJECT PER PART`,
    `# For viewing. Re-import ${path.basename(outMesh)}.obj instead: it is merged,`,
    "# so nothing can be re-origined on the way in.",
    `mtllib ${path.basename(outMesh)}.mtl`,
  ];
  let base2 = 1;
  for (const part of order) {
    apart.push(`o ${part.name}`);
    for (const v of part.world) apart.push(`v ${n(v.x)} ${n(v.y)} ${n(v.z)}`);
    for (let i = 0; i < part.uv.length; i += 2)
      apart.push(
        `vt ${part.uv[i].toFixed(6)} ${(FLIP_V ? part.uv[i + 1] : 1 - part.uv[i + 1]).toFixed(6)}`,
      );
    apart.push(`usemtl ${isCutout(part) ? `${recipeName}-ornate` : recipeName}`);
    for (let t = 0; t < part.world.length / 3; t++) {
      const a = base2 + t * 3;
      apart.push(`f ${a}/${a} ${a + 1}/${a + 1} ${a + 2}/${a + 2}`);
    }
    base2 += part.world.length;
  }
  fs.writeFileSync(`${outMesh}-parts.obj`, apart.join("\n") + "\n");
  fs.writeFileSync(
    `${outMesh}.mtl`,
    [
      `newmtl ${recipeName}`,
      "Kd 1 1 1",
      `map_Kd ${recipeName}-atlas.png`,
      "",
      `newmtl ${recipeName}-ornate`,
      "Kd 1 1 1",
      `map_Kd ${recipeName}-atlas.png`,
      `map_d ${recipeName}-atlas.png`,
      "",
    ].join("\n"),
  );
  // The .mtl names `<recipe>-atlas.png` beside it, so PUT IT THERE. Without
  // this the OBJ opens untextured in every modeller — the sheet exists, but it
  // is three directories away in the engine checkout under a different name,
  // and a texture an .mtl points at and cannot find is indistinguishable from
  // no unwrap at all to the person who opened the file to check the unwrap.
  let sheetNote = "";
  if (args.atlas) {
    const beside = path.join(path.dirname(outMesh), `${recipeName}-atlas.png`);
    fs.copyFileSync(path.resolve(String(args.atlas)), beside);
    sheetNote = ` + ${path.basename(beside)}`;
  }
  console.log(
    `  wrote ${path.relative(STUDIO, outMesh)}.obj — merged, and -parts.obj — one object each (+ .mtl${sheetNote})`,
  );
}

// ---------------------------------------------------------------------------
// check render
// ---------------------------------------------------------------------------
//
// The key as the texture. Every part must come out ONE flat slot colour: a
// white edge means a UV hanging off its island, a neighbour's colour means the
// layout is wrong. An agent with no browser can look at this.
//
// With --atlas it renders the finished weapon instead, which is the same test
// plus the one only a picture can answer: does it look right.

if (args.check !== false) {
  const { renderStrip } = await import("./_softrender.mjs");
  const { decodePng } = await import("./_png.mjs");
  const combos = (recipe.combos ?? [parts.map((p) => p.name)]).map((names) => names.filter((n) => byName.has(n)));
  let tex = { width: SHEET, height: SHEET, rgba: key };
  if (args.atlas) {
    const img = decodePng(fs.readFileSync(path.resolve(String(args.atlas))));
    tex = { width: img.width, height: img.height, rgba: img.data };
  }
  const frames = combos.map((names) => ({
    tris: names.flatMap((n) => {
      const p = byName.get(n);
      const out = [];
      for (let t = 0; t < p.world.length / 3; t++)
        out.push({
          p: [0, 1, 2].map((k) => p.world[t * 3 + k]),
          uv: [0, 1, 2].map((k) => [p.uvKey[(t * 3 + k) * 2], p.uvKey[(t * 3 + k) * 2 + 1]]),
        });
      return out;
    }),
  }));
  const img = renderStrip(frames, [new THREE.Vector3(1, 0.05, 0.001), new THREE.Vector3(0.7, 0.25, 0.66)], tex, 360);
  fs.writeFileSync(checkPath, encodePng(img.width, img.height, img.rgba));
  console.log(`  wrote ${path.relative(STUDIO, checkPath)}`);
}

if (bad) process.exit(1);
