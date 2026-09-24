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

/**
 * Texels per metre every HELD or WORN item is authored to, so a sword and the
 * shield in the other hand show the same pixel size. The longsword set it:
 * 2.07 texels per model unit at 128, and it is placed at 0.019 m per unit.
 * Docs: docs/weapon-atlas.md -> "Texel density".
 */
const HELD_GEAR_TEXELS_PER_M = 109;

const RECIPES = {
  longsword: {
    // Blockbench is where this model is actually edited, so the OBJ it exports
    // is the source of record. It is written at 1/100 of the FBX's units.
    source: "MMO/3d/Weapons/LongSword.obj",
    sourceScale: 100,
    outMesh: "MMO/3d/Weapons/LongSword-unwrapped",
    // placed in the hand at 0.019 m per unit (player-sword.mts) — the set that
    // DEFINES the held-gear density
    metresPerUnit: 0.019,
    texelsPerMetre: HELD_GEAR_TEXELS_PER_M,
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
  // A shield is three alternative bodies (round, heater, tower) and two
  // alternative deflectors (the boss on the face); an instance is ONE body and
  // AT MOST one deflector — a shield whose face carries an emblem goes bare, so
  // the emblem owns the centre. Every face of all five
  // parts points along X, so each piece is a straight projection: the FRONT
  // (+X, the side the deflector sits on) and the BACK (-X, the side the arm is
  // on) are two islands, never a fold. A shield's front and back are different
  // things — a device on the face, straps and planking behind — so painting one
  // onto the other is wrong here in a way it is right for a blade. The
  // deflectors have no back faces at all; each is one front island.
  //
  // Both views read the way you would SEE that side: the front looked at from
  // +X, the back from -X, so u runs opposite ways and neither island is
  // mirrored.
  shield: {
    source: "MMO/3d/Weapons/Shield.obj",
    sourceScale: 100,
    outMesh: "MMO/3d/Weapons/Shield-unwrapped",
    metresPerUnit: 0.019, // player-shield.mts, the same scale as the sword
    texelsPerMetre: HELD_GEAR_TEXELS_PER_M,
    sheet: 1254,
    gutter: 60,
    margin: 22,
    // Sized to MATCH THE LONGSWORD'S TEXEL DENSITY, so a shield held beside a
    // sword has the same pixel size: the sword is 2.07 texels per model unit at
    // 128, this layout is 2.46 at 256, so 256 x 2.07 / 2.46 = 216 (2.08). At 256
    // the shield read visibly finer-grained than the blade next to it. Not a
    // power of two, which WebGPU and WebGL2 both mip fine; a 4096 page holds
    // 17x17 = 289 looks. Re-derive this whenever the layout changes. 60 sheet
    // px = 10 texels at 216, room for a bleed of 3 each side.
    atlas: { size: 216, bleed: 3, bgLum: 228 },
    slots: {
      "shield1-front": { color: "#1f00ff", fit: "contain" },
      "shield1-back": { color: "#00a2ff", fit: "contain" },
      "shield2-front": { color: "#ff0000", fit: "contain" },
      "shield2-back": { color: "#ff7d00", fit: "contain" },
      "shield3-front": { color: "#a900ff", fit: "contain" },
      "shield3-back": { color: "#e0a0ff", fit: "contain" },
      deflector1: { color: "#3cff00", fit: "contain" },
      deflector2: { color: "#0f3e00", fit: "contain" },
    },
    parts: {
      Shield1: {
        slot: "shield1-front", method: "plane", u: "-z", v: "-y",
        split: [{ slot: "shield1-back", facing: "-x", above: 0.25, u: "+z", v: "-y" }],
      },
      Shield2: {
        slot: "shield2-front", method: "plane", u: "-z", v: "-y",
        split: [{ slot: "shield2-back", facing: "-x", above: 0.25, u: "+z", v: "-y" }],
      },
      // the tower: the heater's build, 44 units tall to its 39
      Shield3: {
        slot: "shield3-front", method: "plane", u: "-z", v: "-y",
        split: [{ slot: "shield3-back", facing: "-x", above: 0.25, u: "+z", v: "-y" }],
      },
      Deflector1: { slot: "deflector1", method: "plane", u: "-z", v: "-y" },
      Deflector2: { slot: "deflector2", method: "plane", u: "-z", v: "-y" },
    },
    // Tower and heater fronts in the left column, their backs in the middle,
    // each back level with its own front; the round shield's front and back
    // and the two small deflectors down the right. Densest of seven layouts
    // tried when the tower went in (2.46 texels/unit at 256; the rest 1.73-2.45).
    layout: { row: [{ col: ["shield3-front", "shield2-front"] }, { col: ["shield3-back", "shield2-back"] }, { col: ["shield1-front", "shield1-back", { row: ["deflector1", "deflector2"] }] }] },
    cutoutSlots: [],
    // Every shield the game can build: one body, and a deflector or none.
    combos: [
      ["Shield1", "Deflector1"],
      ["Shield1", "Deflector2"],
      ["Shield1"],
      ["Shield2", "Deflector1"],
      ["Shield2", "Deflector2"],
      ["Shield2"],
      ["Shield3", "Deflector1"],
      ["Shield3", "Deflector2"],
      ["Shield3"],
    ],
  },
  // A two-handed, double-bitted axe. Three heads, three collars where the
  // handle meets the haft, two pommels, two sleeves (the langets up through the
  // head) and two finials that cap them, and three cut-out plates: one above
  // the head, one under it, one hanging off the pommel. Rod and Handle are the
  // haft and the grip; every axe wears both.
  //
  // The file names all three heads `AxeHead` — `repeats` tells them apart.
  greataxe: {
    source: "MMO/3d/Weapons/GreatAxe.obj",
    sourceScale: 100,
    outMesh: "MMO/3d/Weapons/GreatAxe-unwrapped",
    repeats: { AxeHead: ["AxeHead1", "AxeHead2", "AxeHead3"] },
    metresPerUnit: 0.019, // the longsword's socket scale: 78 units is a 1.5 m axe
    texelsPerMetre: HELD_GEAR_TEXELS_PER_M,
    sheet: 1254,
    gutter: 60,
    margin: 22,
    // Sized to the held-gear density: 15.76 px/unit on the sheet, so 164 puts
    // it at the sword's 2.07 texels/unit (the greatsword ships at 164 too).
    // Mirroring the double heads halved them; the first cut needed 202.
    // 60 sheet px = 7.8 texels at 164, room for a bleed of 3.
    atlas: { size: 164, bleed: 3, bgLum: 228 },
    slots: {
      axehead1: { color: "#1f00ff", fit: "contain" },
      axehead2: { color: "#a900ff", fit: "contain" },
      axehead3: { color: "#00a2ff", fit: "contain" },
      guard1: { color: "#ff0000", fit: "contain" },
      guard2: { color: "#a80000", fit: "contain" },
      guard3: { color: "#ff7d00", fit: "contain" },
      shoulder1: { color: "#00c08b", fit: "contain" },
      shoulder2: { color: "#007a5a", fit: "contain" },
      top1: { color: "#7ae0c0", fit: "contain" },
      top2: { color: "#b35300", fit: "contain" },
      pommel3: { color: "#3cff00", fit: "contain" },
      pommel4: { color: "#0f3e00", fit: "contain" },
      haft: { color: "#11008a", fit: "contain" },
      grip: { color: "#6b1511", fit: "contain" },
      // The cut-outs: the top plate grows up out of the head, the other two
      // hang down. No `anchor`: it pins the art to the island's edge, which on
      // these plates is the hidden part.
      //
      // Unlike the swords' plates, these stand INSIDE the head: most of each
      // plate is behind the head, the sleeve or the haft. `hiddenBy` shades that
      // on the labelled key, and `fit: "none"` registers the art exactly where it
      // was drawn: a contain fit would stretch a design drawn only in the open
      // part back over the hidden part, and the nudge search slid one 156 px there.
      // For the double heads: the bearded head's spike side leaves more open.
      "ornate-top": {
        color: "#ff8b8b", transparency: true, cut: true, openEnclosed: true,
        fitPadding: 0, sizeScale: 1.3, label: "top ornament", fit: "none",
        hiddenBy: [["AxeHead1", "AxeHead2"], ["Shoulder1", "Shoulder2"], ["Top1", "Top2"], ["Rod"]],
      },
      "ornate-under": {
        color: "#ffc76b", transparency: true, cut: true, openEnclosed: true,
        fitPadding: 0, sizeScale: 1.3, label: "under ornament", fit: "none",
        hiddenBy: [["AxeHead1", "AxeHead2"], ["Shoulder1", "Shoulder2"], ["Rod"]],
      },
      "ornate-bottom": {
        color: "#ff6bd0", transparency: true, cut: true, openEnclosed: true,
        fitPadding: 0, sizeScale: 1.3, label: "pommel ornament", fit: "none",
        hiddenBy: [["Handle"], ["Pummel3", "Pummel4"]],
      },
    },
    parts: {
      // 95-97% of every head faces X: a straight projection off X, so front and
      // back share one painting. The double heads are ALSO mirrored about the
      // haft (z = -43.755): each island is ONE bit, painted once and worn four
      // times, the eye block the haft runs through left whole at its left edge.
      // The first cut gave the generator both bits in one island, and it painted
      // them as two different halves (Derek: "the axeheads don't look good").
      AxeHead1: { slot: "axehead1", method: "plane", u: "+z", v: "-y", mirror: "z", mirrorAt: -43.755, straddle: "keep" },
      AxeHead2: { slot: "axehead2", method: "plane", u: "+z", v: "-y", mirror: "z", mirrorAt: -43.755, straddle: "keep" },
      // The bearded head is NOT symmetric (a bit on one side, a spike on the
      // other), so it keeps its whole silhouette — seen from -X so its bit is
      // on the right like the others'.
      AxeHead3: { slot: "axehead3", method: "plane", u: "-z", v: "-y" },
      // Collars on the haft: a hexagon (2, with two spikes) and a square turned
      // 45 degrees (1). No face looks along X squarely; peeled around the haft.
      CrossGuard1: { slot: "guard1", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      CrossGuard2: { slot: "guard2", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      CrossGuard3: { slot: "guard3", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      // Sleeves up the haft into the head: a box and a diamond with a point.
      Shoulder1: { slot: "shoulder1", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      Shoulder2: { slot: "shoulder2", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      // Finials on the sleeves: a pointed box and a pointed hexagon.
      Top1: { slot: "top1", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      Top2: { slot: "top2", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      // A tall square bipyramid, every facet equally slanted: seen from above
      // its eight facets tile one square, as the longsword's Pummel2.
      Pummel3: { slot: "pommel3", method: "plane", u: "+z", v: "+x" },
      // A hexagonal disc on edge: its two faces plus a rim.
      Pummel4: { slot: "pommel4", method: "plane", u: "+z", v: "-y", rim: true },
      // Six-sided haft and grip, unrolled, seam at the back of the hand.
      Rod: { slot: "haft", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      Handle: { slot: "grip", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      OrnateAxeHeadTop: { slot: "ornate-top", method: "plane", u: "+z", v: "-y" },
      OrnateAxeHeadBottom: { slot: "ornate-under", method: "plane", u: "+z", v: "-y" },
      OrnateBottom: { slot: "ornate-bottom", method: "plane", u: "+z", v: "-y" },
    },
    // The three heads across the top, the peeled strips under them, and the
    // plates with the small collars and caps on the right. Densest of nine
    // layouts tried after the double heads were mirrored (8.1-15.3 px/unit
    // against this one's 15.8).
    layout: {
      col: [
        { row: ["axehead3", "axehead2", "axehead1"] },
        {
          row: [
            "haft", "shoulder2", "grip",
            { col: ["shoulder1", "ornate-bottom"] },
            {
              col: [
                { row: ["ornate-top", "ornate-under"] },
                { row: [{ col: ["guard1", "guard2", "guard3"] }, { col: ["pommel3", "pommel4"] }, { col: ["top1", "top2"] }] },
              ],
            },
          ],
        },
      ],
    },
    cutoutSlots: ["ornate-top", "ornate-under", "ornate-bottom"],
    combos: [
      ["AxeHead1", "Rod", "Handle", "CrossGuard1", "Pummel3", "Shoulder1", "Top1", "OrnateAxeHeadTop", "OrnateAxeHeadBottom", "OrnateBottom"],
      ["AxeHead2", "Rod", "Handle", "CrossGuard2", "Pummel4", "Shoulder2", "Top2"],
      ["AxeHead3", "Rod", "Handle", "CrossGuard3", "Pummel3", "Shoulder2", "Top1"],
      ["AxeHead2", "Rod", "Handle", "CrossGuard2", "Pummel4", "Shoulder1", "Top2", "OrnateAxeHeadTop", "OrnateBottom"],
    ],
  },
  // The longsword's build at two-handed length: four blades (60 units against
  // the grip's 13), four crossguards, two collars, three pommels, a grip and
  // the two cut-out plates. Blockbench exported two guards as `CrossGuard4`;
  // the first is a short bar run ACROSS the blade's flat (quillons out of both
  // faces, 6 units along X), the second the long swept guard — `repeats` names
  // the first CrossGuard2.
  greatsword: {
    source: "MMO/3d/Weapons/GreatSword.obj",
    sourceScale: 100,
    outMesh: "MMO/3d/Weapons/GreatSword-unwrapped",
    repeats: { CrossGuard4: ["CrossGuard2", "CrossGuard4"] },
    metresPerUnit: 0.019, // the longsword's socket scale: 76.5 units is a 1.45 m sword
    texelsPerMetre: HELD_GEAR_TEXELS_PER_M,
    sheet: 1254,
    gutter: 60,
    margin: 22,
    // Sized to the held-gear density: this layout is 2.42 texels/unit at 192,
    // the sword 2.07, so 192 x 2.07 / 2.42 = 164. 60 sheet px = 7.8 texels at
    // 164, room for a bleed of 3.
    atlas: { size: 164, bleed: 3, bgLum: 228 },
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
      pommel1: { color: "#3cff00", fit: "contain" },
      pommel2: { color: "#0f3e00", fit: "contain" },
      pommel3: { color: "#9dffa8", fit: "contain" },
      grip: { color: "#6b1511", fit: "contain" },
      ornate: {
        color: "#ff8b8b", transparency: true, cut: true, openEnclosed: true,
        fit: "contain", anchor: "bottom", fitPadding: 0, sizeScale: 1.3,
      },
      "ornate-bottom": {
        color: "#ffc76b", transparency: true, cut: true, openEnclosed: true,
        fit: "contain", anchor: "top", fitPadding: 0, sizeScale: 1.3,
      },
    },
    parts: {
      // 98-100% of every blade faces X: a straight silhouette.
      Blade1: { slot: "blade1", method: "plane", u: "+z", v: "-y" },
      Blade2: { slot: "blade2", method: "plane", u: "+z", v: "-y" },
      Blade3: { slot: "blade3", method: "plane", u: "+z", v: "-y" },
      Blade4: { slot: "blade4", method: "plane", u: "+z", v: "-y" },
      // Bars along Z, peeled around their length as on the longsword.
      CrossGuard1: { slot: "guard1", method: "unroll", axis: "z", seam: "+y", u: "+z", v: "arc", fold: "x" },
      CrossGuard3: { slot: "guard3", method: "unroll", axis: "z", seam: "+y", u: "+z", v: "arc", fold: "x" },
      CrossGuard4: { slot: "guard4", method: "unroll", axis: "z", seam: "+y", u: "+z", v: "arc", fold: "x" },
      // The bar across the flat runs along X, so it is peeled around X.
      CrossGuard2: { slot: "guard2", method: "unroll", axis: "x", seam: "+y", u: "+x", v: "arc" },
      CrossFlavor1: { slot: "flavor1", method: "plane", u: "+z", v: "-y", rim: true },
      // A tall collar up the ricasso, square-sided (54% X, 46% Z): peeled round.
      CrossFlavor2: { slot: "flavor2", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      Pummel1: { slot: "pommel1", method: "plane", u: "+z", v: "-y", rim: true },
      // a bipyramid, seen from above as the longsword's
      Pummel2: { slot: "pommel2", method: "plane", u: "+z", v: "+x" },
      Pummel3: { slot: "pommel3", method: "plane", u: "+z", v: "-y", rim: true },
      Handle: { slot: "grip", method: "unroll", axis: "y", seam: "-z", u: "arc", v: "-y" },
      Ornate: { slot: "ornate", method: "plane", u: "+z", v: "-y" },
      OrnateBottom: { slot: "ornate-bottom", method: "plane", u: "+z", v: "-y" },
    },
    // Blades across the left at full sheet height, the rest in a column beside
    // them. Densest of eight arrangements tried (15.8 px/unit; the rest 9.2-15.1).
    layout: {
      row: [
        { row: ["blade1", "blade2", "blade3", "blade4"] },
        {
          col: [
            { row: ["ornate", { col: ["guard1", "guard3", "guard4"] }] },
            { row: ["ornate-bottom", "guard2", "flavor1"] },
            { row: ["flavor2", "grip"] },
            { row: ["pommel1", "pommel2", "pommel3"] },
          ],
        },
      ],
    },
    cutoutSlots: ["ornate", "ornate-bottom"],
    combos: [
      ["Blade1", "CrossGuard1", "CrossFlavor1", "Pummel1", "Handle", "Ornate", "OrnateBottom"],
      ["Blade2", "CrossGuard2", "CrossFlavor2", "Pummel2", "Handle"],
      ["Blade3", "CrossGuard3", "CrossFlavor1", "Pummel3", "Handle"],
      ["Blade4", "CrossGuard4", "CrossFlavor2", "Pummel1", "Handle", "Ornate", "OrnateBottom"],
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
  // The ratkin, unwrapped BY HAND in Blockbench and brought back with its UVs
  // intact — so this recipe projects nothing. `uvSource: "file"` takes the
  // islands exactly as the modeller laid them out and leaves this tool the jobs
  // only it does: one slot colour per part, the `keyStroke` margin, the
  // verification that every triangle samples its own island, the manifest the
  // atlas importer registers against, and the seam blend at bake time.
  //
  // There are no `method`, `u`, `v`, `flare`, `split` or `layout` entries below
  // and there must not be: every one of them answers "how should this part be
  // flattened", and the file answers that already.
  //
  // TWENTY-THREE slots. The ears are their own islands now, which is what fixed
  // them: an ear is a flat flap standing UP off the skull, so in the head's side
  // profile it was nearly edge-on and the pink ear-interior paint smeared down
  // over the cheek instead of landing on the ear. Also new since the projected
  // version: a belt and buckle, a crown strip each for the head and the hood, a
  // second shoulder lame, and a front and back tasset.
  //
  // `RatKin_Foot` appears TWICE in the file — the two feet, mirrored, sharing
  // one island. The loader keeps the first and says so; the other side is the
  // same mesh mirrored and wears the same paint by construction.
  ratkin: {
    source: "MMO/3d/Mobs/RatKin.obj",
    sourceScale: 100,
    outMesh: "MMO/3d/Mobs/RatKin-unwrapped",
    uvSource: "file",
    sheet: 1254,
    keyStroke: 8,
    // A body is not a set of facets. 48 keeps the jaw, the brow, the belt edge,
    // the tasset edges and the rim of the shoulder pads as creases and smooths
    // the rest; the head and its crown run wider — see `smooth` on those.
    smooth: 48,
    margin: 22,
    gutter: 48, // unused while the file brings its own layout
    atlas: {
      size: 256,
      // 2, not 3. This unwrap is packed by hand and tight — the closest real
      // neighbours sit about 10px apart, where 3 would want 29. The pads still
      // meet cleanly: padNearest gives each texel to the NEAREST island, so two
      // bleeds that run into each other stop early rather than corrupting.
      bleed: 2,
      // Nothing needs pure white, so the ground bar sits high and teeth, claws
      // and bare metal stay safe as warm cream or light grey.
      bgLum: 236,
    },
    // ONE SLOT PER PART. Colours are LABELS: white is the ground and cyan
    // #00ffff is the cut colour, so neither may be a slot. Twelve hues at two
    // brightnesses, grouped by body area so the check render reads at a glance
    // — reds the head, pinks the ears, magentas the hood, oranges the torso,
    // yellows the robe and belt, greens the tassets and legs, teals the foot and
    // tail, blues the shoulders and arm, purples the hands.
    //
    // `matchTo` only joins pieces that cannot be two materials: a crown is the
    // same skull as the face under it, the two halves of an ear are one ear, the
    // two tassets one garment, the second shoulder lame the same plate as the
    // first, an inner arm the same arm. Everything else is deliberately left
    // unmatched — the hood, the tail, the foot, the hands, the belt and the
    // buckle are each free to be a different material from what they touch, and
    // matching them clamps and drags one toward the other.
    slots: {
      head: { color: "#ff0000", fit: "contain" },
      // matchColor, not matchTo: a crown strip is not a neighbouring piece whose
      // brightness drifted, it is the SAME skull and the SAME cowl cut in two by
      // the unwrap. Luminance-only matching left them the wrong material — the
      // hood crown came back a shoulder plate in one layout and flesh-pink in
      // another, following whatever island it happened to sit beside.
      "head-crown": { color: "#8c0000", fit: "contain", matchColor: "head" },
      "ear-front": { color: "#ff0080", fit: "contain" },
      "ear-back": { color: "#8c0046", fit: "contain", matchTo: "ear-front" },
      hood: { color: "#ff00ff", fit: "contain" },
      "hood-crown": { color: "#8c008c", fit: "contain", matchColor: "hood" },
      "body-front": { color: "#ff8000", fit: "contain" },
      "body-back": { color: "#8c4600", fit: "contain" },
      // The robe and the two tassets are the only alpha on the sheet.
      // `cut: "bottom"` opens an island only where an unpainted run reaches its
      // BOTTOM edge — a frayed hem and nothing else — so the cloth between the
      // robe's two front panels, the connector that holds the garment together
      // on the model, can never be punched out. `anchor: "top"` pins the waist,
      // the edge that is actually attached, so the contain fit cannot slide the
      // piece down and eat the hem it was asked for.
      // `hem` cuts the fray procedurally at import instead of hoping the
      // generator leaves white below the cloth — measured across four sheets it
      // does not, and the hem came out dead straight every time. See the hem
      // pass in import-atlas.mjs. The robe is the biggest of the three so it
      // gets the deepest bite and the widest teeth.
      robes: { color: "#ffff00", fit: "contain", transparency: true, cut: "bottom", anchor: "top", fitPadding: 0, hem: { depth: 2, jag: 5, wave: 4 } },
      belt: { color: "#8c8c00", fit: "contain" },
      buckle: { color: "#80ff00", fit: "contain" },
      "tasset-front": { color: "#468c00", fit: "contain", transparency: true, cut: "bottom", anchor: "top", fitPadding: 0, hem: { depth: 2, jag: 4, wave: 3 } },
      "tasset-back": {
        color: "#008c8c",
        fit: "contain",
        transparency: true,
        cut: "bottom",
        anchor: "top",
        fitPadding: 0,
        hem: { depth: 2, jag: 4, wave: 3 },
        matchTo: "tasset-front",
      },
      "legs-front": { color: "#00ff00", fit: "contain" },
      "legs-back": { color: "#008c00", fit: "contain" },
      foot: { color: "#00ff80", fit: "contain" },
      tail: { color: "#008c46", fit: "contain" },
      shoulder: { color: "#0080ff", fit: "contain" },
      "shoulder-2": { color: "#00468c", fit: "contain", matchTo: "shoulder" },
      "arm-top": { color: "#0000ff", fit: "contain" },
      "arm-under": { color: "#00008c", fit: "contain", matchTo: "arm-top" },
      "hand-top": { color: "#8000ff", fit: "contain" },
      "hand-palm": { color: "#46008c", fit: "contain" },
    },
    // The model's own spelling is load-bearing: this file mixes `Ratkin_`,
    // `RatKin_` and bare lower case. The recipe matches the FILE, not English.
    parts: {
      // 60 degrees against the body's 48: the head and its crown strip meet
      // along the whole length of the skull, and at 48 part of that join stayed
      // a hard edge, which the engine draws as a line over the head whatever the
      // texture does. Normal accumulation stays global, so the two still shade
      // as one surface where they meet.
      Ratkin_Head: { slot: "head", smooth: 60 },
      Ratkin_HeadCrown: { slot: "head-crown", smooth: 60 },
      Ratkin_EarFront: { slot: "ear-front" },
      Ratkin_EarBack: { slot: "ear-back" },
      hood: { slot: "hood" },
      // Slid from x892..990 y822..984 — where the file put it, wedged between
      // the two shoulder lames and 898px from the hood — to x240..338 y214..376,
      // in the gap between the chest blocks under the head. 255px from the hood
      // and with no shoulder near it. It kept coming back painted as a third
      // shoulder plate, and nothing in the prompt shifted it; its neighbours did.
      HoodCrown: { slot: "hood-crown", move: [-652, -608] },
      Ratkin_BodyFront: { slot: "body-front" },
      Ratkin_BodyBack: { slot: "body-back" },
      Robes: { slot: "robes" },
      Belt: { slot: "belt" },
      Buckle: { slot: "buckle" },
      Tasset_Front: { slot: "tasset-front" },
      Tasset: { slot: "tasset-back" },
      RatKin_LegsFront: { slot: "legs-front" },
      RatKin_LegsBack: { slot: "legs-back" },
      RatKin_Foot: { slot: "foot" },
      RatKin_Tail: { slot: "tail" },
      ShoulderPad: { slot: "shoulder" },
      ShoulderPad_2: { slot: "shoulder-2" },
      Ratkin_ArmTop: { slot: "arm-top" },
      Ratkin_ArmUnder: { slot: "arm-under" },
      Ratkin_HandTop: { slot: "hand-top" },
      Ratkin_HandPalm: { slot: "hand-palm" },
    },
    // The robe and the two tassets cut, and only along their hems.
    cutoutSlots: ["robes", "tasset-front", "tasset-back"],
    combos: [
      [
        "Ratkin_Head",
        "Ratkin_HeadCrown",
        "Ratkin_EarFront",
        "Ratkin_EarBack",
        "hood",
        "HoodCrown",
        "Ratkin_BodyFront",
        "Ratkin_BodyBack",
        "Robes",
        "Belt",
        "Buckle",
        "Tasset_Front",
        "Tasset",
        "RatKin_LegsFront",
        "RatKin_LegsBack",
        "RatKin_Foot",
        "RatKin_Tail",
        "ShoulderPad",
        "ShoulderPad_2",
        "Ratkin_ArmTop",
        "Ratkin_ArmUnder",
        "Ratkin_HandTop",
        "Ratkin_HandPalm",
      ],
    ],
  },
  // The lich ghoul. PROJECTED, not authored: the Blockbench file's UVs were
  // unfinished (both ribs still on default whole-sheet UVs, the hip top and
  // chest-cavity floor collapsed into a corner, strays on five other parts), so
  // this tool unwraps every part itself — one connected island per part, flare
  // opening the edges out so they do not warp. The ogre's process, with the
  // ratkin's worn-kit settings: the robe halves and both tassets cut at the hem.
  //
  // Front is +X, like the ogre. One arm, one hand and one foot (on +Z) and one
  // half of the ribcage (on -Z); the other side is the same mesh mirrored.
  ghoul: {
    source: "MMO/3d/Mobs/LitchGhoul.obj",
    sourceScale: 100,
    outMesh: "MMO/3d/Mobs/LitchGhoul-unwrapped",
    sheet: 1254,
    keyStroke: 8,
    smooth: 48,
    margin: 22,
    gutter: 48,
    atlas: { size: 256, bleed: 2, bgLum: 236 },
    // Reds the head, magentas the hood, oranges the torso, pinks the skeleton,
    // yellows the robe and belt, greens the tassets and legs, blues the
    // shoulders and arm, purples the hands. White and cyan stay reserved.
    slots: {
      // 1.3x the body's density (the face sector 2x on top, see `face`) — against the "one density" rule, on purpose.
      // At 1x the face is ~7 texels wide on a 256 sheet, and the generator
      // could not place it: tiny on the cinder sheet, off to the side on the
      // frost one. The crown gets the same scale so the two still match.
      head: { color: "#ff0000", fit: "contain", sizeScale: 1.3, labelMax: 2 },
      // The painted skin from the top band of the head strip, borrowed and
      // lightly evened (import-atlas `borrow`): left to the generator it drew a
      // second little face here, and a flat fill did not match the head.
      "head-crown": { color: "#8c0000", fit: "contain", sizeScale: 1.3, solidFrom: "head:top", borrow: true, even: { detail: 1, shade: 0.7, radius: 12 } },
      // `flush` (import-atlas): the generator draws the cowl's black opening
      // into this flat profile on every sheet, which reads as a dark band round
      // the rim; the importer cuts it out and stretches the cloth to the edge.
      hood: { color: "#ff00ff", fit: "contain", flush: true },
      // Borrowed from the top band of the hood block (import-atlas `borrow`), like
      // the head crown: painted on its own it came back a different fabric from
      // the hood (plague sheet).
      "hood-crown": { color: "#8c008c", fit: "contain", solidFrom: "hood:top", borrow: true, even: { detail: 1, shade: 0.7, radius: 12 } },
      "chest-front": { color: "#ff8000", fit: "contain" },
      "chest-back": { color: "#8c4600", fit: "contain", matchTo: "chest-front" },
      "chest-bottom": { color: "#c86400", fit: "contain", matchTo: "chest-front" },
      // The ornate iron, treated exactly as the human armour sheet's ornament:
      // a mostly-EMPTY block with one thin wrought-iron silhouette drawn on it,
      // everything unpainted cut away — enclosed holes too (`openEnclosed`),
      // because generators draw closed rings and a ring's hole never reaches
      // the island edge.
      ornament: { color: "#ffc080", fit: "contain", transparency: true, cut: true, openEnclosed: true, anchor: "bottom", fitPadding: 0, clearPaper: { edge: 10 } },
      // Every bone ONE material: the spine and both ribs are recentred on the
      // bone painted into the chest's ribcage and the back's spine (import-atlas
      // `boneFrom`). The spine keeps nearly all its painted detail.
      spine: { color: "#ff0080", fit: "contain", label: "spine bone", even: { detail: 0.95, shade: 0.8 }, solidBand: [0.6, 0.95], boneFrom: ["chest-front", "chest-back"], boneBand: [0.9, 0.99] },
      // `even` (import-atlas): the painted bone texture kept, its big light/dark
      // swings flattened toward one bone colour. Left alone the ribs came back
      // banded like the spine; a flat solid fill looked like plastic. The lower
      // rib centres on the upper rib's colour so the pair match, and borrows its
      // artwork if the generator leaves it blank.
      "rib-upper": { color: "#8c0046", fit: "contain", label: "rib-upper bone", even: { detail: 0.3, shade: 0.3, streak: "x" }, solidBand: [0.6, 0.95], boneFrom: ["chest-front", "chest-back"], boneBand: [0.9, 0.99] },
      "rib-lower": { color: "#ff80c0", fit: "contain", label: "rib-lower bone", even: { detail: 0.3, shade: 0.3, streak: "x" }, solidFrom: "rib-upper", solidBand: [0.6, 0.95], boneFrom: ["chest-front", "chest-back"], boneBand: [0.9, 0.99] },
      // The robe halves and the two tassets are the only alpha on the sheet —
      // the same hem settings the ratkin's robe and tassets ship with.
      "robes-front": { color: "#ffff00", fit: "contain", transparency: true, cut: "bottom", anchor: "top", fitPadding: 0, hem: { depth: 2, jag: 5, wave: 4 } },
      "robes-back": { color: "#8c8c00", fit: "contain", transparency: true, cut: "bottom", anchor: "top", fitPadding: 0, hem: { depth: 2, jag: 5, wave: 4 }, matchTo: "robes-front" },
      belt: { color: "#c0c060", fit: "contain" },
      buckle: { color: "#80ff00", fit: "contain" },
      "tasset-front": { color: "#468c00", fit: "contain", transparency: true, cut: "bottom", anchor: "top", fitPadding: 0, hem: { depth: 2, jag: 4, wave: 3 } },
      "tasset-back": { color: "#008c8c", fit: "contain", transparency: true, cut: "bottom", anchor: "top", fitPadding: 0, hem: { depth: 2, jag: 4, wave: 3 }, matchTo: "tasset-front" },
      "legs-front": { color: "#00ff00", fit: "contain", label: "bare legs-front" },
      "legs-back": { color: "#008c00", fit: "contain", label: "bare legs-back" },
      "legs-top": { color: "#00ff80", fit: "contain" },
      foot: { color: "#008c46", fit: "contain" },
      shoulder: { color: "#0080ff", fit: "contain" },
      "shoulder-2": { color: "#00468c", fit: "contain", matchTo: "shoulder" },
      "arm-outside": { color: "#0000ff", fit: "contain" },
      "arm-inside": { color: "#00008c", fit: "contain", matchTo: "arm-outside" },
      "arm-back": { color: "#4040c0", fit: "contain", matchTo: "arm-outside" },
      "hand-outside": { color: "#8000ff", fit: "contain" },
      "hand-palm": { color: "#46008c", fit: "contain" },
    },
    // Spelling matches the FILE: `Goul_RibLower` is the modeller's typo.
    parts: {
      // Profiles down Z, folded left onto right: one eye painted, two seen.
      // The skull as ONE strip wrapped round it — face in the middle, the back
      // of the head split across both ends — and the crown mapped with the
      // head's own centre into the SAME slot, so it is the strip's top rows and
      // joins the head edge to edge. Both earlier cuts failed Derek's eye: a
      // front view put the face on the back of the skull, and a front + back
      // split and a top-down crown never matched at their joins.
      Ghoul_Head: { slot: "head", method: "sphere", front: "+x", v: "height", face: { half: 40, scale: 2, blend: 25 }, smooth: 60 },
      // The crown on its OWN island above the head strip (Derek: mapped into the
      // strip it wrecked the generator's stretching of the face). From above,
      // FRONT at the BOTTOM so it sits over the face, left and right the same way
      // round as the strip below it.
      Ghoul_HeadCrown: { slot: "head-crown", method: "plane", u: "-z", v: "+x", flare: 0.15, smooth: 60 },
      // A flat profile, all of it. The crown island is ONLY the modeller's
      // hoodCrown mesh — the hood's own top faces stay here.
      hood: { slot: "hood", method: "plane", u: "+x", v: "-y", flare: 0.3 },
      // Crown strips from ABOVE, face to the right. Not mirrored.
      hoodCrown: { slot: "hood-crown", method: "plane", u: "+x", v: "+z", flare: 0.15, mirror: "z" },
      // Body shells seen squarely from the front / back.
      Ghoul_ChestFront: { slot: "chest-front", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      Ghoul_ChestBack: { slot: "chest-back", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      Ghoul_LegsFront: { slot: "legs-front", method: "plane", u: "+z", v: "-y", flare: 0.28 },
      Ghoul_LegsBack: { slot: "legs-back", method: "plane", u: "+z", v: "-y", flare: 0.2 },
      RobesFront: { slot: "robes-front", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      RobesBack: { slot: "robes-back", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      Tasset: { slot: "tasset-front", method: "plane", u: "+z", v: "-y", flare: 0.1 },
      Tasset_Back: { slot: "tasset-back", method: "plane", u: "+z", v: "-y", flare: 0.1 },
      BeltBuckle: { slot: "buckle", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      // The open chest cavity: its floor under the pecs and the top of the hips,
      // both seen from above, front of the body at the bottom of the island.
      Ghoul_ChestBottom: { slot: "chest-bottom", method: "plane", u: "+z", v: "+x", flare: 0.2 },
      Ghoul_LegsTop: { slot: "legs-top", method: "plane", u: "+z", v: "+x", flare: 0.2 },
      // Inside the cavity: the spine in profile, the two ribs straightened.
      Ghoul_spine: { slot: "spine", method: "plane", u: "+x", v: "-y", flare: 0.4 },
      Ghoul_RibUpper: { slot: "rib-upper", method: "tube", seam: "+z", u: "along" },
      Goul_RibLower: { slot: "rib-lower", method: "tube", seam: "+z", u: "along" },
      // A tilted disc behind the shoulders: looked at down its own normal.
      ChestHalo: { slot: "ornament", method: "plane", view: [0.89, 0.46, 0], flare: 0.2 },
      // The belt is one closed strip round the waist — an outer face and a top
      // face — so it straightens like a tube: seam at the back, round the
      // waist across the island, its two faces as two rows.
      Belt: { slot: "belt", method: "tube", seam: "-x" },
      // Shoulder lames: domes with no good axis, viewed down their own normals.
      ShoulderPad1: { slot: "shoulder", method: "plane", view: [0.2, 0.49, 0.85], flare: 0.2 },
      ShoulderPad2: { slot: "shoulder-2", method: "plane", view: [0.95, 0.3, 0.05], flare: 0.2 },
      // Arm, hand and foot as the ogre's: seen from outside the body.
      Ghoul_ArmOutside: { slot: "arm-outside", method: "plane", view: [0.65, 0.1, 0.75], flare: 0.5 },
      // The inner arm turns a corner: 9 faces point back (-X, normals ~-0.95),
      // 7 point in at the body (-Z). One view makes the back-of-shoulder pair
      // a tall sliver that overlaps and warps, so the back faces get their own
      // island seen from behind — the ogre's arm-front fix, from the other side.
      Ghoul_ArmInside: {
        slot: "arm-inside", method: "plane", u: "+x", v: "-y", flare: 0.35,
        split: [{ slot: "arm-back", facing: "-x", above: 0.6, u: "+z", v: "-y", flare: 0.2 }],
      },
      Ghoul_HandOutside: { slot: "hand-outside", method: "plane", view: [0.6, 0.2, 0.77], flare: 0.05 },
      Ghoul_HandPalm: { slot: "hand-palm", method: "plane", view: [-0.3, 0.1, -0.95], flare: 0.1 },
      Ghoul_Foot: { slot: "foot", method: "plane", u: "+x", v: "+z", flare: 0.45 },
    },
    layout: {
      col: [
        { row: [
          { col: ["hood", "chest-front", "chest-back", "ornament"] },
          { col: ["legs-front", "legs-back", "chest-bottom"] },
          { col: ["robes-front", "robes-back", "legs-top", { row: ["hood-crown", "buckle"] }, "foot",
            // The crown centred over the head strip, as it sits on the skull.
            { col: ["head-crown", "head"], align: "center" }] },
          { col: [
            // The hands beside the arm they belong to: parked beside SPINE BONE and
            // the ribs, the cinder sheet painted them as coiled bone.
            { row: ["arm-outside", "arm-inside"] },
            { row: ["arm-back", "hand-outside", "hand-palm"] },
            { row: ["tasset-front", "tasset-back", "shoulder"] },
            // The ribs beside the spine, away from the belt: two thin strips next
            // to a belt came back painted as more belt on every sheet.
            { row: ["shoulder-2", "spine", { col: ["rib-upper", "rib-lower"] }] },
          ] },
        ] },
        // The head strip is wide and short, so it rides the bottom row with the
        // belt instead of widening a column.
        "belt",
      ],
    },
    // Face landmarks drawn into key-labelled.png, from the model's own face:
    // brow ring y 87.6, cheekbone ring 83.05, chin 78.1, face ±2.1 wide at x ~5.
    // Percentages alone were not enough — one sheet drew the face tiny, one
    // put it off to the side.
    marks: [
      { slot: "head", at: [6, 85.6, 1.15], shape: "eye", size: 5 },
      { slot: "head", at: [6, 85.6, -1.15], shape: "eye", size: 5 },
      { slot: "head", at: [6, 83.3, 0], shape: "dot", size: 5 },
      { slot: "head", from: [6, 80.3, -1.0], to: [6, 80.3, 1.0], shape: "line" },
    ],
    cutoutSlots: ["robes-front", "robes-back", "tasset-front", "tasset-back", "ornament"],
    combos: [
      [
        "Ghoul_Head", "Ghoul_HeadCrown", "hood", "hoodCrown",
        "Ghoul_ChestFront", "Ghoul_ChestBack", "Ghoul_ChestBottom", "ChestHalo",
        "Ghoul_spine", "Ghoul_RibUpper", "Goul_RibLower",
        "RobesFront", "RobesBack", "Belt", "BeltBuckle", "Tasset", "Tasset_Back",
        "Ghoul_LegsFront", "Ghoul_LegsBack", "Ghoul_LegsTop", "Ghoul_Foot",
        "ShoulderPad1", "ShoulderPad2",
        "Ghoul_ArmOutside", "Ghoul_ArmInside", "Ghoul_HandOutside", "Ghoul_HandPalm",
      ],
    ],
  },

  // The anansi: a hooded humanoid torso on a spider body. PROJECTED like the
  // ghoul: the Blockbench file carries default whole-sheet UVs only. Its kit is
  // the ghoul's (hood + crown, belt + buckle, a front tasset); below the waist
  // it is one spider body shell and three legs.
  //
  // Front is +X. One arm, one hand, one half of the spider body and the three
  // legs of ONE side (all on -Z); the other side is the same meshes mirrored.
  anansi: {
    source: "MMO/3d/Mobs/Anansi.obj",
    sourceScale: 100,
    outMesh: "MMO/3d/Mobs/Anansi-unwrapped",
    sheet: 1254,
    keyStroke: 8,
    smooth: 48,
    margin: 22,
    gutter: 48,
    atlas: { size: 256, bleed: 2, bgLum: 236 },
    // Reds the head, magentas the hood, oranges the torso, yellows the belt,
    // greens the spider body and legs, blues the arm, purples the hand.
    slots: {
      head: { color: "#ff0000", fit: "contain", sizeScale: 1.3, labelMax: 2 },
      // The generator's OWN painted crown, not the ghoul's borrow of the head
      // strip's top band: here that band was forehead skin between two sides
      // of hair, and borrowed it put a bald stripe over the crown. Asked for
      // hair from above, the anansi sheets paint it well.
      "head-crown": { color: "#8c0000", fit: "contain", sizeScale: 1.3 },
      "head-under": { color: "#c05050", fit: "contain", sizeScale: 1.3, label: "under jaw", matchTo: "head" },
      hood: { color: "#ff00ff", fit: "contain", flush: true },
      "hood-crown": { color: "#8c008c", fit: "contain", solidFrom: "hood:top", borrow: true, even: { detail: 1, shade: 0.7, radius: 12 } },
      "chest-front": { color: "#ff8000", fit: "contain" },
      "chest-back": { color: "#8c4600", fit: "contain", matchTo: "chest-front" },
      belt: { color: "#c0c060", fit: "contain" },
      buckle: { color: "#ffff00", fit: "contain" },
      "tasset-front": { color: "#8c8c00", fit: "contain", transparency: true, cut: "bottom", anchor: "top", fitPadding: 0, hem: { depth: 2, jag: 4, wave: 3 } },
      "spider-body": { color: "#00ff00", fit: "contain" },
      "leg-front": { color: "#008c00", fit: "contain", label: "spider leg-front" },
      "leg-middle": { color: "#00ff80", fit: "contain", label: "spider leg-middle", matchTo: "leg-front" },
      "leg-back": { color: "#008c46", fit: "contain", label: "spider leg-back", matchTo: "leg-front" },
      "arm-outside": { color: "#0000ff", fit: "contain" },
      "arm-inside": { color: "#00008c", fit: "contain", matchTo: "arm-outside" },
      "hand-outside": { color: "#8000ff", fit: "contain" },
      "hand-palm": { color: "#46008c", fit: "contain" },
    },
    parts: {
      // The ghoul's head cut: one strip round the skull, face widened, crown
      // on its own island centred above it. The underside of the jaw is a flat
      // cap fanned from the chin to the back of the skull; left in the strip it
      // crushed to a sliver running out across half the island, so it is split
      // off and seen from below, chin at the TOP to sit under the face.
      Anansi_Head: {
        slot: "head", method: "sphere", front: "+x", v: "height", face: { half: 40, scale: 2, blend: 25 }, smooth: 60,
        split: [{ slot: "head-under", facing: "-y", above: 0.6, u: "+z", v: "-x", flare: 0.15 }],
      },
      Anansi_HeadCrown: { slot: "head-crown", method: "plane", u: "-z", v: "+x", flare: 0.15, smooth: 60 },
      hood: { slot: "hood", method: "plane", u: "+x", v: "-y", flare: 0.3 },
      hoodCrown: { slot: "hood-crown", method: "plane", u: "+x", v: "+z", flare: 0.15, mirror: "z" },
      Anansi_ChestFront: { slot: "chest-front", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      Anansi_ChestBack: { slot: "chest-back", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      Belt: { slot: "belt", method: "tube", seam: "-x" },
      buckle: { slot: "buckle", method: "plane", u: "+z", v: "-y", flare: 0.3 },
      TassetFront: { slot: "tasset-front", method: "plane", u: "+z", v: "-y", flare: 0.1 },
      // Half the spider body, open on the centre plane: seen from its side it
      // is one height field, head of the spider to the right.
      Anansi_Abdomen: { slot: "spider-body", method: "plane", u: "+x", v: "-y", flare: 0.4 },
      // Bent tubes, straightened like the ghoul's ribs, each ring at its own
      // width so the island narrows to the tip the way the leg does.
      Anansi_SpiderLegFront: { slot: "leg-front", method: "tube", seam: "-y", u: "along", taper: true },
      Anansi_SpiderLegMiddle: { slot: "leg-middle", method: "tube", seam: "-y", u: "along", taper: true },
      Anansi_SpiderLegBack: { slot: "leg-back", method: "tube", seam: "-y", u: "along", taper: true },
      // Arm and hand seen down their own mean normals, as the ghoul's.
      Anansi_ArmFront: { slot: "arm-outside", method: "plane", view: [0.49, 0.31, -0.81], flare: 0.5 },
      Anansi_ArmBack: { slot: "arm-inside", method: "plane", view: [-0.66, -0.35, 0.67], flare: 0.35 },
      Anansi_HandOutside: { slot: "hand-outside", method: "plane", view: [0.62, 0.1, -0.78], flare: 0.05 },
      Anansi_HandPalm: { slot: "hand-palm", method: "plane", view: [-0.6, -0.2, 0.77], flare: 0.1 },
    },
    layout: {
      row: [
        // The spider half: its body and legs together, one material.
        { col: ["spider-body", "leg-front", "leg-middle", "leg-back", { row: ["belt", "buckle", "tasset-front"] }] },
        { col: [
          // The crown centred over the head strip, the jaw underside under it —
          // and the hood at the far end of the column, away from the head,
          // which a generator otherwise paints as one hooded face across both.
          { col: ["head-crown", "head", "head-under"], align: "center" },
          { row: ["chest-front", "chest-back"] },
          // The hand beside the arm it belongs to.
          { row: ["arm-outside", "arm-inside", { col: ["hand-outside", "hand-palm"] }] },
          { row: ["hood", "hood-crown"] },
        ] },
      ],
    },
    // Face landmarks drawn into key-labelled.png, the ghoul's proportions on
    // this head's rings: brow y 53.1, cheekbones 48.5, chin 43.6, face ±2.1
    // wide at x ~10.5.
    marks: [
      { slot: "head", at: [11, 51.1, 1.2], shape: "eye", size: 5 },
      { slot: "head", at: [11, 51.1, -1.2], shape: "eye", size: 5 },
      { slot: "head", at: [11, 48.8, 0], shape: "dot", size: 5 },
      { slot: "head", from: [11, 45.8, -1.0], to: [11, 45.8, 1.0], shape: "line" },
    ],
    cutoutSlots: ["tasset-front"],
    combos: [
      [
        "Anansi_Head", "Anansi_HeadCrown", "hood", "hoodCrown",
        "Anansi_ChestFront", "Anansi_ChestBack", "Belt", "buckle", "TassetFront",
        "Anansi_Abdomen", "Anansi_SpiderLegFront", "Anansi_SpiderLegMiddle", "Anansi_SpiderLegBack",
        "Anansi_ArmFront", "Anansi_ArmBack", "Anansi_HandOutside", "Anansi_HandPalm",
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

// `uvSource: "file"` takes the unwrap from the mesh instead of projecting one,
// which needs the sheet size before the unwrap runs rather than after it.
const AUTHORED = recipe?.uvSource === "file";
const SHEET_PX = Number(args.sheet ?? recipe?.sheet ?? 1254);
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
  if (Array.isArray(spec)) {
    return { axis: null, sign: 1, vec: new THREE.Vector3(...spec).normalize() };
  }
  const sign = spec[0] === "-" ? -1 : 1;
  const axis = AXIS[spec[spec.length - 1]];
  const vec = new THREE.Vector3();
  vec.setComponent(axis, sign);
  return { axis, sign, vec };
}

/**
 * The two in-plane directions of a plane projection, and the direction it
 * looks down.
 *
 * `u`/`v` name world axes and the third axis is dropped, which is everything
 * an axis-aligned SHELL needs. A DOME has no best axis: measured, the ratkin’s
 * shoulder pad faces (0.24, 0.51, 0.83) on average, and a flat view keeps 57%
 * of its area looked at down Z, 42% down Y and 66% down its own mean normal —
 * so down either axis a third of it is edge-on and warps. `view: [x, y, z]`
 * projects down an arbitrary direction instead and derives u and v from it, u
 * across the sheet and v down it, so the pad lands square-on.
 *
 * For an axis-aligned spec the dropped direction is the POSITIVE unit axis,
 * which is exactly what `getComponent(axis)` meant before, so no existing recipe
 * moves by a texel.
 */
function basisOf(spec) {
  if (spec.view) {
    const f = new THREE.Vector3(...spec.view).normalize();
    const up = Math.abs(f.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(up, f).normalize();
    const v = new THREE.Vector3().crossVectors(f, u).normalize();
    if (v.y > 0) v.negate(); // V runs DOWN the sheet, the way "-y" does
    return {
      du: { axis: null, sign: 1, vec: u },
      dv: { axis: null, sign: 1, vec: v },
      drop: f,
      axis: null,
    };
  }
  const du = dir(spec.u);
  const dv = dir(spec.v);
  const axis = [0, 1, 2].find((a) => a !== du.axis && a !== dv.axis);
  const drop = new THREE.Vector3();
  drop.setComponent(axis, 1);
  return { du, dv, drop, axis };
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
      // The file may already carry a real unwrap — see `uvSource: "file"`.
      const uvAttr = geo.attributes.uv;
      const srcUv = uvAttr ? Array.from({ length: uvAttr.count }, (_, i) => [uvAttr.getX(i), uvAttr.getY(i)]) : null;
      out.push({ name: o.name, world, srcUv });
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

// Blockbench lets several objects share ONE name: the great axe's three heads
// are all `AxeHead`, copies of each other never renamed. `repeats` names them
// by order of appearance (`{ AxeHead: ["AxeHead1", "AxeHead2", "AxeHead3"] }`)
// so each gets its own slot and a family, and the unwrapped OBJ carries the new
// names back to the modeller. Without it the later copies are "ignored".
for (const [name, names] of Object.entries(recipe?.repeats ?? {})) {
  const hits = found.filter((p) => p.name === name);
  if (hits.length !== names.length)
    console.warn(`! repeats: the file has ${hits.length} "${name}", the recipe names ${names.length}`);
  hits.forEach((p, i) => {
    if (names[i]) p.name = names[i];
  });
}

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
function flareOf(part, spec, drop, normals) {
  const flare = Number(spec.flare ?? 0);
  if (!flare) return null;
  let plus = 0;
  let minus = 0;
  for (let t = 0; t < part.world.length / 3; t++) {
    const { n, area } = normals.faces.get(part.name)[t];
    const c = n.dot(drop);
    if (c > 0) plus += area * c;
    else minus += area * -c;
  }
  const vals = part.world.map((v) => v.dot(drop));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const mid = (lo + hi) / 2;
  const half = (hi - lo) / 2 || 1e-6;
  const twoSided = Math.min(plus, minus) / (plus + minus || 1) > 0.15;
  const depth = twoSided
    ? (v) => half - Math.abs(v.dot(drop) - mid)
    : plus >= minus
      ? (v) => hi - v.dot(drop)
      : (v) => v.dot(drop) - lo;
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
/**
 * Take the unwrap the FILE already has, instead of projecting one.
 *
 * Every other method here answers "how should this part be flattened". Once a
 * modeller has answered that by hand in Blockbench there is nothing to solve:
 * the islands are laid out, packed and oriented the way they wanted, and the
 * job left is the one only this tool does — give each part its own slot colour,
 * grow the islands by `keyStroke`, verify that every triangle samples its own
 * island, and write the key and the manifest the atlas importer registers
 * against.
 *
 * The UVs are converted straight to SHEET PIXELS, and V is flipped: OBJ counts
 * V from the bottom and a sheet counts rows from the top. After that the
 * layout solver is skipped and every island sits exactly where the file put it.
 */
function authoredUnwrap(part, spec) {
  if (!part.srcUv) {
    console.error(`! ${part.name}: uvSource "file" but the mesh carries no UVs`);
    process.exit(1);
  }
  // A mesh OBJECT and a slot are usually the same thing, but not always: a
  // modeller may leave a handful of faces in one object whose UVs they have
  // laid into ANOTHER part-s island, which is correct for the art and wrong
  // for the colour key — the faces would be painted their object-s slot
  // colour on top of the island they are sitting in, and the two parts then
  // share texels. Measured on the ratkin: 4 crown facets of 0.3 square units,
  // normals straight up, still in `Ratkin_Head` but UV-parked in the crown
  // strip where they belong.
  //
  // `regions` says so explicitly: any face whose UV centroid falls inside the
  // box goes to the named slot instead. Boxes are in SHEET PIXELS, read off
  // `--islands`, and are tested in order.
  const regions = (spec.regions ?? []).map((r) => ({ slot: slots.get(r.slot), name: r.slot, box: r.box }));
  const home = slots.get(spec.slot);
  const moved = new Map();
  // `move: [dx, dy]` slides this part-s island across the sheet, in sheet
  // pixels, after reading it from the file.
  //
  // WHERE AN ISLAND SITS IS PART OF WHAT IT SAYS. A generator paints a sheet as
  // a picture, so an island reads partly from its NEIGHBOURS — and the ratkin-s
  // hood crown sat 898px from the hood, wedged between the two shoulder lames,
  // and came back painted as a third shoulder plate every time. Labelling it did
  // not fix that; being next to the hood does.
  //
  // This diverges the shipped mesh from the modeller-s file by that offset, so
  // it is for a layout fault worth fixing without a round trip. Say it out loud
  // when it happens, and fold it back into the source when convenient.
  const shift = spec.move ?? [0, 0];
  for (let t = 0; t < part.world.length / 3; t++) {
    const idx = [0, 1, 2].map((k) => t * 3 + k);
    const uv = idx.map((i) => [part.srcUv[i][0] * SHEET_PX + shift[0], (1 - part.srcUv[i][1]) * SHEET_PX + shift[1]]);
    const cx = (uv[0][0] + uv[1][0] + uv[2][0]) / 3;
    const cy = (uv[0][1] + uv[1][1] + uv[2][1]) / 3;
    const r = regions.find((q) => cx >= q.box[0] && cx <= q.box[2] && cy >= q.box[1] && cy <= q.box[3]);
    (r ? r.slot : home).tris.push({ part: part.name, idx, uv, p: idx.map((i) => part.world[i]) });
    if (r) moved.set(r.name, (moved.get(r.name) ?? 0) + 1);
  }
  for (const [to, n] of moved) console.log(`  ${part.name}: ${n} faces moved into ${to} by their UVs`);
  if (shift[0] || shift[1])
    console.log(`  ${part.name}: island slid ${shift[0]},${shift[1]}px from where the file put it`);
}

/**
 * One projection group of a part: its own view, flare and slot. The base group
 * (`g` = {}) is the part's own projection; the others are its `split` entries,
 * each taking the faces that point along `facing`.
 */
function projectionGroup(part, spec, g, base) {
  const view = g.view ?? (g.u || g.v ? null : spec.view);
  const { du, dv, drop, axis } = basisOf(
    view ? { view } : { u: g.u ?? spec.u, v: g.v ?? spec.v },
  );
  const flare = flareOf(part, { flare: g.flare ?? spec.flare }, drop, NORMALS);
  const want = base ? null : dir(g.facing);
  // `mirror: "z"` folds the part about the body's centre plane (world z = 0)
  // before projecting, so its two halves share ONE half-island — painted once
  // and worn on both sides, the way a profile is. For a strip that runs over
  // the top of a mirrored piece: the ghoul's hood crown held both sides at once
  // under a hood profile painted once for both, so the two never lined up.
  //
  // `mirrorAt` moves that plane off zero: the great axe's heads are modelled
  // around the haft at z = -43.755, and each double head keeps ONE bit's island
  // (both bits and both faces share it). With `straddle: "keep"` a face that
  // CROSSES the plane (the eye block the haft runs through) is not folded:
  // folded corner by corner it collapses onto the plane, so it keeps its own
  // shape at the island's edge. Opt-in, so the hood crowns cut before it stay
  // exactly as they are.
  const fold = AXIS[g.mirror ?? (base ? spec.mirror : undefined)];
  const at = g.mirrorAt ?? (base ? spec.mirrorAt ?? 0 : 0);
  const keepStraddling = (g.straddle ?? (base ? spec.straddle : undefined)) === "keep";
  const folded = (v) => {
    if (fold === undefined || v.getComponent(fold) >= at) return v;
    const w = v.clone();
    w.setComponent(fold, 2 * at - w.getComponent(fold));
    return w;
  };
  const straddles = (p) => {
    if (fold === undefined || !keepStraddling) return false;
    const c = p.map((v) => v.getComponent(fold) - at);
    return Math.min(...c) < -1e-3 && Math.max(...c) > 1e-3;
  };
  return {
    base,
    slot: slots.get(g.slot ?? spec.slot),
    name: g.slot ?? spec.slot,
    du,
    dv,
    drop,
    dropped: axis,
    takes: (n) => base || n.dot(want.vec) > (g.above ?? 0.25),
    straddles,
    project: (v0, unfolded = false) => {
      const v = unfolded ? v0 : folded(v0);
      const iu = v.dot(du.vec);
      const iv = v.dot(dv.vec);
      if (!flare) return [iu, iv];
      const n = NORMALS.at(v0).clone();
      // the far half's normal flips with it
      if (fold !== undefined && !unfolded && v0.getComponent(fold) < at) n.setComponent(fold, -n.getComponent(fold));
      const nu = n.dot(du.vec);
      const nv = n.dot(dv.vec);
      const len = Math.hypot(nu, nv);
      if (len < 1e-3) return [iu, iv]; // square-on to the view: nowhere to unfold to
      const d = flare.flare * flare.depth(v);
      return [iu + (nu / len) * d, iv + (nv / len) * d];
    },
  };
}

function planeUnwrap(part, spec) {
  /** Base group last: it is the fallback, and it owns the rim. */
  const groups = [...(spec.split ?? []), {}].map((g, i, all) => projectionGroup(part, spec, g, i === all.length - 1));
  const home = groups[groups.length - 1];
  const dropped = home.dropped;
  const drop = home.drop;
  // `rim` hangs a bar under the silhouette, and edgeBand walks it along a
  // world axis. There is no axis to walk when the view is oblique.
  if (spec.rim && dropped === undefined) {
    console.warn(`! ${part.name}: rim is not available on an oblique view; no bar written`);
  }
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
    if (spec.rim && dropped !== undefined && Math.abs(n.dot(drop)) < (spec.rimBelow ?? 0.7)) {
      rimTris.push({ t, p });
      continue;
    }
    const g = groups.find((x) => x.takes(n));
    const tri = {
      part: part.name,
      idx: [0, 1, 2].map((k) => t * 3 + k),
      uv: p.map((v) => g.project(v, g.straddles(p))),
      front: n.dot(g.drop) > 0,
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

/**
 * Straighten a BENT open tube — a rib, a tentacle, a curled horn — into one
 * rectangle: across the island goes around the tube, down it goes along it.
 *
 * `unroll` peels around ONE straight world axis, which is the wrong question
 * for a rib: it curves half way round the chest, so no axis runs along it. A
 * tube built as rings (every quad-strip cylinder a modeller extrudes) carries
 * its own axis in its topology, so this walks that instead:
 *
 *  - the two open ends are the mesh's two boundary loops;
 *  - a vertex's RING is its hop distance from one end, which is exact for a
 *    strip whether or not its quads were triangulated;
 *  - each ring is ordered by following the edges that join it to the one
 *    before, so the columns run straight down the whole tube;
 *  - arc length around each ring, normalised to the MEAN perimeter, gives
 *    across; the mean distance from each vertex to its match on the ring
 *    before gives along — the centreline length on a bent tube, and the only
 *    right answer for a BAND (a belt: top face and outer face as two rows of
 *    one closed strip), whose rings share a centre.
 *
 * Nothing here can overlap and every face is connected to its neighbours, so
 * it needs no flare. The seam is cut at the vertex furthest along `seam` on
 * the first ring — the side of the bone nobody looks at.
 */
/**
 * A head as ONE strip wrapped round the skull: across the island is the way
 * round the head (face in the middle, the back of the skull split across both
 * ends), down it is top to bottom — latitude and longitude about the head's own
 * centre, the globe's equirectangular map.
 *
 * Why not a plane: a front view folds the face onto the back of the skull, a
 * profile squeezes the face to a sliver, and a front + back split puts a seam
 * down each cheek. Why not `unroll`: it walks the outline's hull, which on a
 * lumpy low-poly skull comes out ragged, with loose triangles off one end.
 *
 * `centerOf: "<part>"` measures the centre and radius from another part, so a
 * crown strip mapped with the SAME numbers lands on the strip's top rows and
 * joins the head edge to edge — give both the same slot. The poles stretch,
 * which is where a skull is plainest.
 */
function sphereUnwrap(part, spec) {
  const ref = spec.centerOf ? parts.find((p) => p.name === spec.centerOf) : part;
  if (!ref) throw new Error(`${part.name}: centerOf ${spec.centerOf} is not a part`);
  const box = new THREE.Box3();
  for (const v of ref.world) box.expandByPoint(v);
  const c = box.getCenter(new THREE.Vector3());
  const R = ref.world.reduce((a, v) => a + v.distanceTo(c), 0) / ref.world.length;
  const f = dir(spec.front ?? "+x");
  const right = new THREE.Vector3().crossVectors(f.vec.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize();
  // `v: "height"` — the CYLINDER variant, and the one that paints well: down is
  // plain height and across is true arc length round the head's own oval, so
  // every vertical surface — the face, the temples, the back of the skull — is
  // laid out at its real size. Latitude (the default) stretches toward the
  // poles, and the ghoul's face came back visibly warped with it. Faces that
  // point straight up or down compress; the crown belongs on its own island.
  const height = spec.v === "height";
  const size = box.getSize(new THREE.Vector3());
  const semiF = Math.abs(size.dot(f.vec)) / 2 || 1;
  const semiR = Math.abs(size.dot(right)) / 2 || 1;
  const ARC = 1440;
  const arcTable = new Float64Array(ARC + 1);
  // `face: { half, scale, blend }` widens the FRONT of the strip: within `half`
  // degrees of the front, arc counts `scale` times, easing back to 1 over
  // `blend` degrees. The face then has `scale`x the texels and the sides and
  // back stay at true size. Measured on the ghoul: told where the eyes go with
  // marks on the key, the generator still painted every face about twice the
  // real width, so its eyes wrapped round onto the sides of the head. Giving
  // the face the room the generator wants is the fix that holds.
  const faceW = spec.face;
  const weight = (t) => {
    if (!faceW) return 1;
    const d = (Math.min(t, 2 * Math.PI - t) * 180) / Math.PI;
    const half = faceW.half ?? 45;
    const blend = faceW.blend ?? 20;
    if (d <= half) return faceW.scale ?? 2;
    if (d >= half + blend) return 1;
    const k = (d - half) / blend;
    const sm = k * k * (3 - 2 * k);
    return (faceW.scale ?? 2) * (1 - sm) + sm;
  };
  for (let k = 1; k <= ARC; k++) {
    const t0 = ((k - 1) / ARC) * 2 * Math.PI;
    const t1 = (k / ARC) * 2 * Math.PI;
    arcTable[k] =
      arcTable[k - 1] +
      weight((t0 + t1) / 2) * Math.hypot(semiF * (Math.cos(t1) - Math.cos(t0)), semiR * (Math.sin(t1) - Math.sin(t0)));
  }
  const arcAt = (t) => {
    const sgn = t < 0 ? -1 : 1;
    const x = (Math.abs(t) / (2 * Math.PI)) * ARC;
    const k = Math.min(ARC - 1, Math.floor(x));
    return sgn * (arcTable[k] + (arcTable[k + 1] - arcTable[k]) * (x - k));
  };
  const target = slots.get(spec.slot);
  // `split` works as on a plane: a face pointing along a group's `facing` is
  // projected flat into that group's slot. For the underside of a jaw, a flat
  // cap the height strip can only crush into a sliver — on the anansi one
  // such triangle ran out across half the strip.
  const groups = (spec.split ?? []).map((g) => projectionGroup(part, spec, g, false));
  const moved = new Map();
  for (let t = 0; t < part.world.length / 3; t++) {
    const idx = [0, 1, 2].map((k) => t * 3 + k);
    const p = idx.map((i) => part.world[i]);
    if (groups.length) {
      const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).normalize();
      const g = groups.find((x) => x.takes(n));
      if (g) {
        g.slot.tris.push({ part: part.name, idx, uv: p.map(g.project), front: n.dot(g.drop) > 0, p });
        moved.set(g.name, (moved.get(g.name) ?? 0) + 1);
        continue;
      }
    }
    const polar = p.map((v) => {
      const d = new THREE.Vector3().subVectors(v, c);
      const len = d.length() || 1;
      const horiz = Math.hypot(d.dot(f.vec), d.dot(right));
      return {
        az: height ? Math.atan2(d.dot(right) / semiR, d.dot(f.vec) / semiF) : Math.atan2(d.dot(right), d.dot(f.vec)),
        lat: height ? box.max.y - v.y : Math.acos(Math.max(-1, Math.min(1, d.y / len))) * R,
        pole: horiz < 1e-3 * R,
      };
    });
    // Straddling the seam at the back: bring the far side round.
    const live = polar.filter((q) => !q.pole);
    if (live.length && Math.max(...live.map((q) => q.az)) - Math.min(...live.map((q) => q.az)) > Math.PI)
      for (const q of live) if (q.az < 0) q.az += 2 * Math.PI;
    const mean = live.length ? live.reduce((a, q) => a + q.az, 0) / live.length : 0;
    target.tris.push({
      part: part.name,
      idx,
      p,
      uv: polar.map((q) => {
        const az = q.pole ? mean : q.az;
        return [height ? arcAt(az) : az * R, q.lat];
      }),
    });
  }
  for (const [to, n] of moved) console.log(`  ${part.name}: ${n} faces split into ${to}`);
}

function tubeUnwrap(part, spec) {
  const key = (v) => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
  const ids = new Map();
  const pos = [];
  const tris = [];
  for (let t = 0; t < part.world.length / 3; t++) {
    tris.push(
      [0, 1, 2].map((k) => {
        const v = part.world[t * 3 + k];
        const kk = key(v);
        if (!ids.has(kk)) {
          ids.set(kk, pos.length);
          pos.push(v);
        }
        return ids.get(kk);
      }),
    );
  }
  const edgeUse = new Map();
  const nbr = pos.map(() => new Set());
  for (const tri of tris)
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      if (a === b) continue;
      nbr[a].add(b);
      nbr[b].add(a);
      const e = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeUse.set(e, (edgeUse.get(e) ?? 0) + 1);
    }
  // Boundary loops: edges used by one face, chained.
  const bnbr = new Map();
  for (const [e, n] of edgeUse) {
    if (n !== 1) continue;
    const [a, b] = e.split("_").map(Number);
    if (!bnbr.has(a)) bnbr.set(a, []);
    if (!bnbr.has(b)) bnbr.set(b, []);
    bnbr.get(a).push(b);
    bnbr.get(b).push(a);
  }
  const loops = [];
  const seen = new Set();
  for (const start of bnbr.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    let prev = -1;
    let cur = start;
    for (;;) {
      const next = bnbr.get(cur).find((x) => x !== prev && !seen.has(x));
      if (next === undefined) break;
      loop.push(next);
      seen.add(next);
      prev = cur;
      cur = next;
    }
    loops.push(loop);
  }
  const fail = (why) => {
    console.error(`! ${part.name}: tube unwrap needs an open tube built from rings — ${why}`);
    process.exit(1);
  };
  // One open end is a tube CLOSED to a point at the other — the belt, whose
  // inside is a fan up to one vertex. That apex is its last ring, handled below.
  if (loops.length !== 2 && loops.length !== 1) fail(`found ${loops.length} open ends`);
  const n = loops[0].length;
  // Hop distance from the first end is the ring index.
  const ring = new Array(pos.length).fill(-1);
  let frontier = loops[0];
  for (const v of frontier) ring[v] = 0;
  for (let r = 1; frontier.length; r++) {
    const next = [];
    for (const v of frontier)
      for (const w of nbr[v])
        if (ring[w] < 0) {
          ring[w] = r;
          next.push(w);
        }
    frontier = next;
  }
  let R = Math.max(...ring) + 1;
  const rings = Array.from({ length: R }, () => []);
  for (let v = 0; v < pos.length; v++) rings[ring[v]].push(v);
  // A closed end: its apex sits on the last row's edge, at zero height, so the
  // fan collapses and the rescue pass patches it from the row beside it. It is
  // the INSIDE of the thing — the lid of a belt, under the body.
  let apex = -1;
  if (loops.length === 1 && rings[R - 1].length === 1) {
    apex = rings[R - 1][0];
    R -= 1;
    rings.pop();
  }
  if (rings.some((r) => r.length !== n)) fail(`rings of ${rings.map((r) => r.length).join("/")} vertices`);
  const centre = (r) => r.reduce((a, v) => a.add(pos[v]), new THREE.Vector3()).divideScalar(r.length);
  // Ring 0 in loop order, starting at the seam side.
  const sd = dir(spec.seam ?? "-y");
  const c0 = centre(rings[0]);
  const lp = loops[0];
  const s0 = lp.reduce((best, v, i) => (axisValue(new THREE.Vector3().subVectors(pos[v], c0), sd) > axisValue(new THREE.Vector3().subVectors(pos[lp[best]], c0), sd) ? i : best), 0);
  const ordered = [lp.slice(s0).concat(lp.slice(0, s0))];
  const centres = [c0];
  for (let r = 1; r < R; r++) {
    const c = centre(rings[r]);
    centres.push(c);
    const prevC = centres[r - 1];
    ordered.push(
      ordered[r - 1].map((pv) => {
        const want = new THREE.Vector3().subVectors(pos[pv], prevC).normalize();
        let best = -1;
        let score = -Infinity;
        for (const w of rings[r]) {
          if (!nbr[pv].has(w)) continue;
          const s = new THREE.Vector3().subVectors(pos[w], c).normalize().dot(want);
          if (s > score) {
            score = s;
            best = w;
          }
        }
        return best;
      }),
    );
    if (new Set(ordered[r]).size !== n) fail(`ring ${r} does not follow ring ${r - 1} one-to-one`);
  }
  const perims = ordered.map((o) => o.map((v, i) => pos[v].distanceTo(pos[o[(i + 1) % n]])));
  const meanP = perims.reduce((a, p) => a + p.reduce((x, y) => x + y, 0), 0) / R;
  // `taper: true` lays each ring out at its OWN perimeter, centred on the
  // strip, so a tube that narrows comes out the shape it is. Without it every
  // ring is stretched to the mean, which is right for a belt and wrong for a
  // spider leg: its thin tip was magnified to the full strip width, the
  // generator painted a pointed leg into that rectangle anyway, and the empty
  // corners smeared over the tip on the model.
  const taper = spec.taper === true;
  const across = new Map();
  const ord = new Map();
  const wrapAt = new Map(); // where the seam vertex sits at the FAR end of its ring
  for (let r = 0; r < R; r++) {
    const total = perims[r].reduce((x, y) => x + y, 0);
    let acc = 0;
    ordered[r].forEach((v, i) => {
      across.set(v, taper ? meanP / 2 + acc - total / 2 : (acc / total) * meanP);
      wrapAt.set(v, taper ? meanP / 2 + total / 2 : meanP);
      ord.set(v, i);
      acc += perims[r][i];
    });
  }
  const along = [0];
  for (let r = 1; r < R; r++)
    along.push(along[r - 1] + ordered[r].reduce((a, v, i) => a + pos[v].distanceTo(pos[ordered[r - 1][i]]), 0) / n);
  // A tapered tube's apex is a real TIP beyond its last ring, not a lid folded
  // onto it: give it its true distance so the fan is a point, not a needle.
  const apexAlong =
    taper && apex >= 0
      ? along[R - 1] + pos[apex].distanceTo(centres[R - 1])
      : along[R - 1];
  const target = slots.get(spec.slot);
  const horizontal = spec.u === "along";
  for (const [t, tri] of tris.entries()) {
    const wraps = tri.some((v) => ord.get(v) === n - 1) && tri.some((v) => ord.get(v) === 0);
    const rim = tri.filter((v) => v !== apex);
    const uv = tri.map((v) => {
      if (v === apex) {
        const a = rim.map((w) => (wraps && ord.get(w) === 0 ? wrapAt.get(w) : across.get(w)));
        const l = apexAlong;
        // Tapered: ONE tip on the centre line for every face of the fan. Each
        // at its own rim's midpoint split the tip into a comb of prongs.
        const m = taper ? meanP / 2 : a.reduce((x, y) => x + y, 0) / a.length;
        return horizontal ? [l, m] : [m, l];
      }
      const a = wraps && ord.get(v) === 0 ? wrapAt.get(v) : across.get(v);
      const l = along[ring[v]];
      return horizontal ? [l, a] : [a, l];
    });
    const idx = [0, 1, 2].map((k) => t * 3 + k);
    target.tris.push({ part: part.name, idx, uv, p: idx.map((i) => part.world[i]) });
  }
  console.log(`  ${part.name}: tube of ${R} rings x ${n}${apex >= 0 ? ", closed at one end" : ""}, ${meanP.toFixed(1)} around, ${along[R - 1].toFixed(1)} long`);
}

for (const part of parts) {
  const spec = recipe.parts[part.name];
  if (!spec) continue;
  if (AUTHORED) authoredUnwrap(part, spec);
  else if (spec.method === "tube") tubeUnwrap(part, spec);
  else if (spec.method === "sphere") sphereUnwrap(part, spec);
  else if (spec.method === "plane") planeUnwrap(part, spec);
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
    : { w: Math.max(...kids.map((k) => k.w)), h: kids.reduce((a, k) => a + k.h, 0) + gaps, kids, row: false, center: node.align === "center" };
}

function place(m, x, y, out) {
  if (m.node) {
    out.set(m.node, { x, y, w: m.w, h: m.h });
    return;
  }
  let cx = x;
  let cy = y;
  for (const k of m.kids) {
    // `align: "center"` on a col centres each child across it — a crown
    // island over the middle of the head strip it caps.
    place(k, m.center ? cx + (m.w - k.w) / 2 : cx, cy, out);
    if (m.row) cx += k.w + GUT;
    else cy += k.h + GUT;
  }
}

// Solve the largest scale that still fits the sheet — the blades are 50 units
// long and set the ceiling, everything else follows at the same texel density.
// Unless the file brought its own unwrap, in which case the islands are
// already in sheet pixels exactly where the modeller put them and there is
// nothing to solve: `boxes` are their extents, so each island is "placed" at
// its own box and the remap below is the identity.
let SCALE;
/** Sheet px per model unit, from the solved layout or the authored UVs: the density report reads it. */
let PX_PER_UNIT = 0;
const placed = new Map();
if (AUTHORED) {
  SCALE = 1;
  let ink = 0;
  for (const [name, b] of boxes) {
    placed.set(name, { x: b.x0, y: b.y0, w: b.w, h: b.h });
    ink += b.w * b.h;
  }
  const density = [...slots.values()]
    .flatMap((sl) => sl.tris)
    .reduce((acc, t) => {
      const [a, b2, c] = t.p ?? [];
      if (!c) return acc;
      const wa = new THREE.Vector3().subVectors(b2, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
      const ua = Math.abs((t.uv[1][0] - t.uv[0][0]) * (t.uv[2][1] - t.uv[0][1]) - (t.uv[2][0] - t.uv[0][0]) * (t.uv[1][1] - t.uv[0][1])) / 2;
      return { u: acc.u + ua, w: acc.w + wa };
    }, { u: 0, w: 0 });
  const px = Math.sqrt(density.u / (density.w || 1));
  PX_PER_UNIT = px;
  console.log(
    `  authored UVs from the file: ${placed.size} islands, ` +
      `${((ink / (SHEET * SHEET)) * 100).toFixed(0)}% of the sheet in island boxes, ` +
      `${px.toFixed(2)} px/unit (${(px * (recipe.atlas.size / SHEET)).toFixed(2)} texels/unit at ${recipe.atlas.size})`,
  );
} else {
  let lo = 0.1;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const m = measure(recipe.layout, mid);
    if (m.w <= SHEET - 2 * MAR && m.h <= SHEET - 2 * MAR) lo = mid;
    else hi = mid;
  }
  SCALE = lo;
  PX_PER_UNIT = SCALE;
  const measured = measure(recipe.layout, SCALE);
  place(measured, MAR, MAR, placed);
  console.log(
    `  layout ${measured.w.toFixed(0)}x${measured.h.toFixed(0)} of ${SHEET} at ${SCALE.toFixed(2)} px/unit ` +
      `(${(SCALE * (recipe.atlas.size / SHEET)).toFixed(2)} texels/unit at ${recipe.atlas.size})`,
  );
}

// TEXEL DENSITY — texels per METRE in the world, the number that decides
// whether two things seen side by side have the same pixel size. A shield at
// 1.5x the sword's density read visibly finer-grained in the same hand. A
// recipe that declares `metresPerUnit` (its model units -> metres, as placed
// in the game) gets its density printed; one that also declares
// `texelsPerMetre` (the target of its class, e.g. HELD_GEAR_TEXELS_PER_M) is
// checked against it and told the atlas size that would hit it. See
// docs/weapon-atlas.md -> "Texel density".
if (recipe.metresPerUnit) {
  const perUnit = PX_PER_UNIT * (recipe.atlas.size / SHEET_PX);
  const perMetre = perUnit / recipe.metresPerUnit;
  const target = recipe.texelsPerMetre;
  if (!target) console.log(`  density ${perMetre.toFixed(0)} texels/m (no texelsPerMetre target declared)`);
  else {
    const ratio = perMetre / target;
    const fit = Math.round((recipe.atlas.size / ratio) / 2) * 2;
    if (Math.abs(ratio - 1) <= 0.08) console.log(`  density ${perMetre.toFixed(0)} texels/m — target ${target} ok`);
    else
      console.warn(
        `! density ${perMetre.toFixed(0)} texels/m is ${ratio.toFixed(2)}x the ${target} target — atlas.size ${fit} would match ` +
          `(or change the layout); things beside it in the game will show a different pixel size`,
      );
  }
}

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
const rescuedBy = {};
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
    rescuedBy[name] = (rescuedBy[name] ?? 0) + 1;
  }
}
if (rescued) {
  const by = Object.entries(rescuedBy).map(([n, c]) => `${n} ${c}`).join(", ");
  console.log(`  ${rescued} edge-on triangles given a patch cut out of a neighbour (${by})`);
}

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
      // No projection to reason from when the file brought the unwrap: a doubled
      // island is then the modeller mirroring a part on purpose — a head, a
      // tail, a foot whose sole is never seen — and the tool has no basis to
      // call it a fault. Checked BEFORE the method test, because an authored
      // part declares no method at all.
      if (AUTHORED) {
        mirrored = true;
        break;
      }
      if (ps.method !== "plane") {
        mirrored = !!ps.fold;
        break;
      }
      // `mirror` folds the two halves onto one another on purpose.
      if (ps.mirror) {
        mirrored = true;
        break;
      }
      const { drop } = basisOf(ps.view ? { view: ps.view } : { u: ps.u, v: ps.v });
      let plus = 0;
      let minus = 0;
      for (const { n, area } of NORMALS.faces.get(t.part)) {
        const c = n.dot(drop);
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
      ? (AUTHORED
          ? `    ${name}: ${pct.toFixed(0)}% doubled — the file-s own unwrap; mirroring here is the modeller-s call`
          : `    ${name}: ${pct.toFixed(0)}% doubled — mirrored, which is what this projection is for`)
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
      if (owner[at] >= 0 && owner[at] !== id) {
        const k = `${slotIds[owner[at]]} / ${slotIds[id]}`;
        clash.set(k, (clash.get(k) ?? 0) + 1);
      }
      owner[at] = id;
      key[at * 4] = rgb[0];
      key[at * 4 + 1] = rgb[1];
      key[at * 4 + 2] = rgb[2];
      key[at * 4 + 3] = 255;
    }
}

const clash = new Map();
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
// TWO ISLANDS SHARING TEXELS is fatal for a solved layout — the packer should
// never do it, so it means a bug, and whichever part loses the texels wears
// the other one-s paint. For an AUTHORED layout it is the modeller-s file and
// a few texels where two islands graze in a corner are not worth refusing the
// whole cut over. So: always say how big it is, and fail only when it is big
// enough to see. Measured on the ratkin, hood-crown and arm-top graze over 28
// texels, which is 1.2 texels of the finished 256 atlas.
if (clash.size) {
  const total = [...clash.values()].reduce((a, b) => a + b, 0);
  const worst = Math.max(...clash.values());
  const detail = [...clash].map(([k, n]) => `${k} (${n}px)`).join(", ");
  const atlasTexels = total * (recipe.atlas.size / SHEET) ** 2;
  if (!AUTHORED || atlasTexels > 8) {
    console.error(`! islands overlap: ${detail}`);
    process.exit(1);
  }
  console.warn(
    `! islands graze: ${detail} — ${total} sheet px, about ${atlasTexels.toFixed(1)} texels at ` +
      `${recipe.atlas.size}. The file authored this layout, so it is left alone; nudge them apart ` +
      "in the modeller if it shows.",
  );
}

fs.mkdirSync(setDir, { recursive: true });
fs.writeFileSync(keyPath, encodePng(SHEET, SHEET, key));
console.log(`  wrote ${path.relative(STUDIO, keyPath)}`);

// ---------------------------------------------------------------------------
// the LABELLED key: the one a generator is actually shown
// ---------------------------------------------------------------------------
//
// A generator reads a colour key as SHAPES and matches them against whatever
// the prompt describes, so any block that happens to look like a distinctive
// thing attracts that thing-s description. Measured on the ratkin: an EAR was
// painted onto the top-of-hood block (a pointed pentagon) and onto the lower
// shoulder lame (a rounded teardrop); the robe picked up the shoulder-s
// material; the chest back picked up the shoulder-s bone. Every fix was another
// paragraph of prose, and across five rounds the prompt grew from 19k to 27k
// characters while the per-block assignments got LESS reliable, because the
// instructions that mattered drowned in the warnings.
//
// Writing the slot name inside its island ends the argument: the block says
// what it is, and the prompt no longer has to describe a shape at all. This is
// the file to hand the generator. `key.png` stays flat and is what the importer
// registers against, so the lettering never reaches the atlas.
{
  const { drawText, textWidth, GLYPH_H } = await import("./_font.mjs");
  const label = Uint8Array.from(key);
  const named = [];
  // `hiddenBy` — on a cut-out plate that stands INSIDE another part, shade the
  // stretch the part in front hides. The great axe's ornament plates run up
  // through the head: the first sheet drew them the sword's way, growing out of
  // the attach point, and nearly all of it ended up behind the head. The shaded
  // area tells the generator where the ornament cannot be seen.
  //   hiddenBy: [["AxeHead1", "AxeHead2"], ["Shoulder1", "Shoulder2"]]
  // Each inner list is a FAMILY — one of them is always on the weapon — and a
  // texel is hidden when EVERY member of some family covers it, so a design
  // kept out of the shade shows whichever head is fitted.
  const hiddenPx = new Uint8Array(SHEET * SHEET);
  const worldOf = new Map(parts.map((p) => [p.name, p.world]));
  for (const [si, name] of slotIds.entries()) {
    const groups = recipe.slots[name].hiddenBy;
    if (!groups) continue;
    const ref = slots.get(name).tris.find((t) => t.p && t.px);
    if (!ref) continue;
    // world -> sheet px across the whole plane of the plate, not just its
    // triangle: barycentrics extrapolate
    const plate = new THREE.Triangle(...ref.p);
    const nrm = plate.getNormal(new THREE.Vector3());
    const bary = new THREE.Vector3();
    const toPx = (w) => {
      const q = w.clone().addScaledVector(nrm, -nrm.dot(w.clone().sub(ref.p[0])));
      plate.getBarycoord(q, bary);
      return [
        bary.x * ref.px[0][0] + bary.y * ref.px[1][0] + bary.z * ref.px[2][0],
        bary.x * ref.px[0][1] + bary.y * ref.px[1][1] + bary.z * ref.px[2][1],
      ];
    };
    let x0 = SHEET, y0 = SHEET, x1 = 0, y1 = 0;
    for (let y = 0; y < SHEET; y++)
      for (let x = 0; x < SHEET; x++)
        if (owner[y * SHEET + x] === si) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x);
          y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const hidden = new Uint8Array(w * h);
    for (const family of groups) {
      const count = new Uint8Array(w * h);
      for (const member of family) {
        const world = worldOf.get(member);
        if (!world) throw new Error(`hiddenBy: slot ${name} names "${member}", which is not in the recipe`);
        const cover = new Uint8Array(w * h);
        for (let t = 0; t < world.length; t += 3) {
          const [a, b, c] = [world[t], world[t + 1], world[t + 2]].map(toPx);
          const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
          if (Math.abs(area) < 1e-6) continue;
          const lx = Math.max(x0, Math.floor(Math.min(a[0], b[0], c[0])));
          const hx = Math.min(x1, Math.ceil(Math.max(a[0], b[0], c[0])));
          const ly = Math.max(y0, Math.floor(Math.min(a[1], b[1], c[1])));
          const hy = Math.min(y1, Math.ceil(Math.max(a[1], b[1], c[1])));
          for (let y = ly; y <= hy; y++)
            for (let x = lx; x <= hx; x++) {
              const px = x + 0.5, py = y + 0.5;
              const e0 = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) / area;
              const e1 = ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])) / area;
              const e2 = ((a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0])) / area;
              if (e0 >= 0 && e1 >= 0 && e2 >= 0) cover[(y - y0) * w + (x - x0)] = 1;
            }
        }
        for (let i = 0; i < cover.length; i++) count[i] += cover[i];
      }
      for (let i = 0; i < count.length; i++) if (count[i] === family.length) hidden[i] = 1;
    }
    // shaded grey with dark diagonal hatching: reads as "something in front"
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (owner[y * SHEET + x] !== si || !hidden[(y - y0) * w + (x - x0)]) continue;
        n++;
        hiddenPx[y * SHEET + x] = 1;
        const d = (y * SHEET + x) * 4;
        const ink = (x + y) % 14 < 3 ? 70 : 150;
        label[d] = ink;
        label[d + 1] = ink;
        label[d + 2] = ink;
      }
    const island = [...owner].filter((o) => o === si).length;
    console.log(`  ${name}: ${((n / island) * 100).toFixed(0)}% hidden behind ${groups.map((g) => g.join("/")).join(" + ")} (shaded on the labelled key)`);
  }
  for (const [i, name] of slotIds.entries()) {
    const at = placed.get(name);
    if (!at) continue;
    const rgb = rgbOf(recipe.slots[name].color);
    // dark lettering on a light slot and the other way round, so it always reads
    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    const ink = lum > 140 ? [0, 0, 0] : [255, 255, 255];
    const on = (x, y) =>
      x >= 0 && y >= 0 && x < SHEET && y < SHEET && owner[y * SHEET + x] === i && !hiddenPx[y * SHEET + x];
    // biggest scale whose whole word sits on this island, tried around its middle.
    // A tall narrow island — a tasset, a hand, a spine — gets its word turned on
    // end, read bottom to top: measured on the ghoul, the five blocks too narrow
    // for a horizontal word were exactly the five the generator got wrong (the
    // tassets painted as hands, the hands as sleeves). Vertical wins whenever it
    // fits at a larger scale and horizontal would be under scale 3.
    // `label` on a slot overrides the word lettered into it — for a word that is
    // an INSTRUCTION, not just a name: the ghoul's ribs came back as cloth on
    // every sheet while lettered RIB-UPPER, and its legs as trousers.
    const word = (recipe.slots[name].label ?? name).toUpperCase();
    const plotAt = (put, fn) =>
      drawText(word, 0, 0, put.scale, (x, y) =>
        put.vertical ? fn(put.ox + y, put.oy + put.w - 1 - x) : fn(put.ox + x, put.oy + y),
      );
    // `labelMax` caps the lettering, so a word keeps clear of the `marks`
    // drawn on the same island (the ghoul's HEAD ran into its left eye).
    const fit = (vertical) => {
      for (let scale = Math.min(6, recipe.slots[name].labelMax ?? 6); scale >= 1; scale--) {
        const w = textWidth(word, scale);
        const h = GLYPH_H * scale;
        const bw = vertical ? h : w;
        const bh = vertical ? w : h;
        if (bw > at.w || bh > at.h) continue;
        for (let ry = 0; ry <= 10; ry++)
          for (let rx = 0; rx <= 10; rx++) {
            const cand = {
              ox: Math.round(at.x + (at.w - bw) * (rx / 10)),
              oy: Math.round(at.y + (at.h - bh) * (ry / 10)),
              scale,
              vertical,
              w,
            };
            let ok = true;
            // every inked pixel, plus a one-pixel halo, must land on the island
            plotAt(cand, (x, y) => {
              if (!ok) return;
              for (let dy = -1; dy <= 1 && ok; dy++)
                for (let dx = -1; dx <= 1 && ok; dx++) if (!on(x + dx, y + dy)) ok = false;
            });
            if (ok) return cand;
          }
      }
      return null;
    };
    // Horizontal reads best, so it wins unless it would be tiny.
    const across = fit(false);
    const upright = across && across.scale >= 3 ? null : fit(true);
    const put = upright && (!across || upright.scale > across.scale) ? upright : across;
    if (!put) {
      named.push(`${name}?`);
      continue;
    }
    plotAt(put, (x, y) => {
      const d = (y * SHEET + x) * 4;
      label[d] = ink[0];
      label[d + 1] = ink[1];
      label[d + 2] = ink[2];
    });
    named.push(name);
  }
  // `marks` — landmarks drawn into the LABELLED key only (key.png stays flat
  // for the importer). Percentages in a prompt were not enough for the ghoul's
  // face: one sheet drew it tiny, one drew it off to the side. So each mark is
  // a point in WORLD space on the model — the eyes, the nose, the ends of the
  // mouth — found on the part's surface and drawn where it actually lands:
  //   { slot, at: [x, y, z], shape: "eye" | "dot" }  or
  //   { slot, from: [x, y, z], to: [x, y, z], shape: "line" }
  // An eye is a black disc ringed white, so it reads on any slot colour.
  const markPx = (slotName, p) => {
    const slot = slots.get(slotName);
    const q = new THREE.Vector3(...p);
    let best = null;
    const tri = new THREE.Triangle();
    const on = new THREE.Vector3();
    const bary = new THREE.Vector3();
    for (const t of slot?.tris ?? []) {
      if (!t.p || !t.px) continue;
      tri.set(t.p[0], t.p[1], t.p[2]);
      tri.closestPointToPoint(q, on);
      const d = on.distanceToSquared(q);
      if (best && d >= best.d) continue;
      tri.getBarycoord(on, bary);
      best = {
        d,
        x: bary.x * t.px[0][0] + bary.y * t.px[1][0] + bary.z * t.px[2][0],
        y: bary.x * t.px[0][1] + bary.y * t.px[1][1] + bary.z * t.px[2][1],
      };
    }
    if (!best) throw new Error(`marks: slot ${slotName} has no geometry`);
    return best;
  };
  const plot = (x, y, rgb) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= SHEET || y >= SHEET) return;
    const d = (y * SHEET + x) * 4;
    label[d] = rgb[0];
    label[d + 1] = rgb[1];
    label[d + 2] = rgb[2];
  };
  const disc = (cx, cy, r, rgb) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) plot(cx + x, cy + y, rgb);
  };
  for (const m of recipe.marks ?? []) {
    const size = m.size ?? 7;
    if (m.shape === "line") {
      const a = markPx(m.slot, m.from);
      const b = markPx(m.slot, m.to);
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
      for (let k = 0; k <= n; k++) disc(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, 4, [255, 255, 255]);
      for (let k = 0; k <= n; k++) disc(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, 2, [0, 0, 0]);
      console.log(`  mark ${m.slot}: line ${a.x.toFixed(0)},${a.y.toFixed(0)} -> ${b.x.toFixed(0)},${b.y.toFixed(0)}`);
      continue;
    }
    const at = markPx(m.slot, m.at);
    disc(at.x, at.y, size + 3, [255, 255, 255]);
    disc(at.x, at.y, m.shape === "dot" ? Math.max(2, size - 3) : size, [0, 0, 0]);
    console.log(`  mark ${m.slot}: ${m.shape ?? "eye"} at ${at.x.toFixed(0)},${at.y.toFixed(0)} (${Math.sqrt(at.d).toFixed(2)} off the surface)`);
  }
  const labelPath = path.join(setDir, "key-labelled.png");
  fs.writeFileSync(labelPath, encodePng(SHEET, SHEET, label));
  const missed = named.filter((n) => n.endsWith("?"));
  console.log(
    `  wrote ${path.relative(STUDIO, labelPath)} — every island named` +
      (missed.length ? `, except ${missed.map((n) => n.slice(0, -1)).join(", ")} (too small to letter)` : ""),
  );
}

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
  const { color, sizeScale, label, labelMax, ...rest } = cfg;
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
// ---------------------------------------------------------------------------
// seam blend: reconcile the two sides of a split
// ---------------------------------------------------------------------------
//
// `split` cuts one continuous surface into two islands so each can be looked at
// down its own axis. The generator then paints them as two separate drawings,
// and where they rejoin on the model there is a hard line: measured on the
// ratkin's crown, only 6% apart in MEAN value — which `matchTo` would have
// nearly fixed — but visibly stepped at the border, because a flat gain moves
// an island's level and cannot make its EDGE agree with the edge it meets.
//
// So find the edges that are adjacent in 3D but far apart in UV, and average
// the two sides across them, feathering inward over a few texels. At the seam
// itself both sides become the same colour, so there is nothing left to see.
//
// Only edges WITHIN one part are blended. That is exactly the set of splits,
// and it is the only set where the two sides are guaranteed to be one surface
// and one material — blending across two different meshes would smear a robe
// into the body under it.
async function blendSplitSeams(file, radius) {
  const { decodePng } = await import("./_png.mjs");
  const img = decodePng(fs.readFileSync(file));
  const { width: W, height: H } = img;
  const src = img.data;
  const out = Uint8Array.from(src);

  const at = (x, y) => (Math.min(H - 1, Math.max(0, y | 0)) * W + Math.min(W - 1, Math.max(0, x | 0))) * 4;
  const seams = [];
  for (const part of parts) {
    const n = part.world.length;
    // Weld by position: a split's two sides still share their border vertices
    // in 3D, which is what makes them findable at all.
    const wid = new Map();
    const vid = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const v = part.world[i];
      const k = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      if (!wid.has(k)) wid.set(k, wid.size);
      vid[i] = wid.get(k);
    }
    const uvOf = (i) => [part.uvKey[i * 2] * W, part.uvKey[i * 2 + 1] * H];
    const edges = new Map();
    for (let t = 0; t < n / 3; t++)
      for (let e = 0; e < 3; e++) {
        const i0 = t * 3 + e, i1 = t * 3 + ((e + 1) % 3), i2 = t * 3 + ((e + 2) % 3);
        const k = vid[i0] < vid[i1] ? `${vid[i0]}:${vid[i1]}` : `${vid[i1]}:${vid[i0]}`;
        if (!edges.has(k)) edges.set(k, []);
        edges.get(k).push({ i0, i1, i2 });
      }
    for (const sides of edges.values()) {
      if (sides.length !== 2) continue; // a border of the part, or non-manifold
      const [A, B] = sides;
      const a0 = uvOf(A.i0), a1 = uvOf(A.i1);
      // B may walk the edge the other way round; match by welded id, not order.
      const same = vid[B.i0] === vid[A.i0];
      const b0 = uvOf(same ? B.i0 : B.i1), b1 = uvOf(same ? B.i1 : B.i0);
      const apart = Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) + Math.hypot(a1[0] - b1[0], a1[1] - b1[1]);
      // Under a texel apart is the same place: a continuous unwrap, or the fold
      // of a mirrored part where both halves legitimately share their texels.
      if (apart < 1.5) continue;
      seams.push({ a0, a1, b0, b1, aIn: uvOf(A.i2), bIn: uvOf(B.i2) });
    }
  }
  if (!seams.length) return { file, seams: 0 };

  const unit = (from, to) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  for (const s of seams) {
    // Inward is toward the triangle's third corner, so a sample never steps
    // over the edge into whatever is painted on the other side of it.
    const ia = unit([(s.a0[0] + s.a1[0]) / 2, (s.a0[1] + s.a1[1]) / 2], s.aIn);
    const ib = unit([(s.b0[0] + s.b1[0]) / 2, (s.b0[1] + s.b1[1]) / 2], s.bIn);
    const len = Math.max(Math.hypot(s.a1[0] - s.a0[0], s.a1[1] - s.a0[1]), Math.hypot(s.b1[0] - s.b0[0], s.b1[1] - s.b0[1]));
    const steps = Math.max(2, Math.ceil(len * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const pa = [s.a0[0] + (s.a1[0] - s.a0[0]) * t, s.a0[1] + (s.a1[1] - s.a0[1]) * t];
      const pb = [s.b0[0] + (s.b1[0] - s.b0[0]) * t, s.b0[1] + (s.b1[1] - s.b0[1]) * t];
      for (let d = 0; d <= radius; d++) {
        // Full mix at the seam, nothing at the far end of the feather.
        const w = 0.5 * (1 - d / (radius + 1));
        const oa = at(pa[0] + ia[0] * (d + 0.5), pa[1] + ia[1] * (d + 0.5));
        const ob = at(pb[0] + ib[0] * (d + 0.5), pb[1] + ib[1] * (d + 0.5));
        // A cut hem is alpha 0 by design; averaging into it would drag the
        // background through the seam.
        if (src[oa + 3] < 128 || src[ob + 3] < 128) continue;
        for (let c = 0; c < 3; c++) {
          const ca = src[oa + c], cb = src[ob + c];
          out[oa + c] = Math.round(ca * (1 - w) + cb * w);
          out[ob + c] = Math.round(cb * (1 - w) + ca * w);
        }
      }
    }
  }
  const dest = path.join(path.dirname(file), `${path.basename(file, ".png")}-seamblend.png`);
  fs.writeFileSync(dest, encodePng(W, H, out));
  return { file: dest, seams: seams.length };
}

let atlasTex = null;
/** The atlas actually used, which is the seam-blended one when there was one. */
let atlasUsed = null;
if (args.atlas) {
  let atlasFile = path.resolve(String(args.atlas));
  if (!fs.existsSync(atlasFile)) {
    console.error(`! --atlas ${atlasFile} does not exist`);
    process.exit(1);
  }
  // A few texels is enough: at 256 the ratkin is 2 texels per model unit, so a
  // radius of 2 feathers the join over about a centimetre of skull.
  const SEAM = Number(args["seam-blend"] ?? recipe.seamBlend ?? 2);
  if (SEAM > 0 && args["seam-blend"] !== false) {
    const blended = await blendSplitSeams(atlasFile, SEAM);
    if (blended.seams) {
      console.log(`  blended ${blended.seams} split seam(s) over ${SEAM} texels -> ${path.basename(blended.file)}`);
      atlasFile = blended.file;
    }
  }
  atlasUsed = atlasFile;
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
  // The threshold may be raised for ONE part. Accumulation stays global — every
  // contribution at a shared position is still collected, which is what keeps
  // the chest and the back from shading differently where they meet — but how
  // wide a crease a part is willing to smooth over is its own business.
  // Measured on the ratkin: at 48 degrees, 8 of the 34 edges where the crown
  // island rejoins the profile stayed HARD, so the engine drew a lighting line
  // along a quarter of the top of the skull whatever the texture did there. At
  // 60 that is 2 of 34, and the jaw, the ear and the brow are still creases.
  const cosOf = (part) => Math.cos(((part.smooth ?? degrees) * Math.PI) / 180);
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
    const partCos = cosOf(part);
    for (let t = 0; t < part.world.length / 3; t++) {
      const f = faceOf.get(part.name)[t].n;
      for (let k = 0; k < 3; k++) {
        const acc = new THREE.Vector3();
        for (const c of at.get(key(part.world[t * 3 + k])) ?? [])
          if (c.n.dot(f) >= partCos) acc.addScaledVector(c.n, c.area);
        (acc.lengthSq() > 1e-12 ? acc.normalize() : f).toArray(out, (t * 3 + k) * 3);
      }
    }
    part.normal = out;
  }
}
if (recipe.smooth) {
  for (const part of parts) {
    const spec = recipe.parts[part.name];
    if (spec?.smooth !== undefined) part.smooth = Number(spec.smooth);
  }
  creasedNormals(parts, Number(recipe.smooth));
}

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
  // the part table rides in the glTF (node extras → userData.parts on load), so
  // an item's `appearance` can name parts and ctx.setModelLook resolves them
  // against the model it is actually drawing — never a mask gone stale
  mesh.userData.parts = Object.fromEntries(order.map((nm, i) => [nm, i]));
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
    fs.copyFileSync(atlasUsed ?? path.resolve(String(args.atlas)), beside);
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
    const img = decodePng(fs.readFileSync(atlasUsed ?? path.resolve(String(args.atlas))));
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
