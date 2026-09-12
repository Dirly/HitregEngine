/**
 * `pnpm -F playground dungeon` — lay out a dungeon as a CSG volume.
 *
 * The output is `assets/volumes/<id>.json`: an ordered list of solid
 * operations that `@hitreg/core`'s dual contourer turns into geometry at load
 * (`packages/core/src/voxel/csg.ts`). Nothing here writes a mesh — the
 * document IS the dungeon, a few kilobytes of it, so a hall can be widened by
 * editing one number and the running scene rebuilds.
 *
 * **Why CSG rather than a room graph feeding a mesh emitter.** CSG composes.
 * "Cut a stair down through the floor of that hall" is one subtract that
 * opens the ceiling below, meets both walls correctly and needs nobody to
 * reason about which polygons to delete. The layout below is written in the
 * order it would be built: rock, then rooms cut out of it, then columns added
 * back, then doorways cut through those.
 *
 * **Why dual contouring specifically.** Everything here is edges — a stair
 * nosing, a column plinth, a door jamb, a crenellation. Marching cubes puts
 * its vertices on lattice edges, so it chamfers every one of them by up to
 * half a voxel and a 0.6 m step turns to mush. A dual contour solves for
 * where the planes actually meet. The other half of that is Hermite data: the
 * contourer is handed this document's exact field rather than a sampling of
 * it, which is what makes the corners square rather than merely sharper.
 *
 * **Proportions are deliberately heroic** — WoW rather than a real castle.
 * Ceilings 12-16 m, columns 3.5 m thick, doorways 7 m tall, a stair 12 m
 * wide. Read at human scale it is absurd; read on screen it is the only thing
 * that makes an interior feel like a set piece rather than a corridor.
 *
 * The run is the genre's standard shape: descend, cross, arrive.
 *   grand stair -> arcade hall -> bridge over a chasm -> boss chamber,
 * with a raw cave breaking into the arcade from one side so a single frame
 * can show hard architecture and organic rock in ONE mesh with ONE material.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

type Vec3 = [number, number, number];
type Surface = { floor: number; wall: number; ceiling: number };

interface Node {
  id: string;
  op?: "add" | "sub" | "intersect";
  shape?: "box" | "sphere" | "ellipsoid" | "cylinder" | "capsule" | "cone" | "torus" | "wedge";
  position?: Vec3;
  rotation?: Vec3;
  size?: Vec3;
  radius?: number;
  height?: number;
  round?: number;
  blend?: number;
  surface?: Surface;
}

// Palette indices, matching the splat layers of assets/materials/dungeon/hold.json.
const HALL: Surface = { floor: 0, wall: 1, ceiling: 2 }; // flagstone / dressed block / vault
const PALE: Surface = { floor: 3, wall: 3, ceiling: 3 }; // carved pale stone: columns, arches, trim
const CAVE: Surface = { floor: 4, wall: 5, ceiling: 5 }; // raw rock
const MOSS: Surface = { floor: 6, wall: 6, ceiling: 6 }; // overgrown ruin
const BONE: Surface = { floor: 7, wall: 7, ceiling: 7 }; // the skull gate

const nodes: Node[] = [];
const add = (n: Node): void => void nodes.push(n);
let seq = 0;
const id = (p: string): string => `${p}-${++seq}`;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Rock around a space: the envelope, added before the space is cut out of it. */
function bedrock(cx: number, cy: number, cz: number, w: number, h: number, d: number): void {
  add({ id: id("rock"), op: "add", shape: "box", position: [cx, cy, cz], size: [w, h, d], surface: CAVE });
}

/**
 * A room: straight walls to `wall` height, then a barrel vault over.
 *
 * The vault is not decoration — a flat ceiling at this scale reads as a
 * warehouse, and the half-round is what makes the columns below look like
 * they are holding something up.
 */
function vaultedRoom(cx: number, floor: number, cz: number, len: number, width: number, wall: number, s: Surface): void {
  add({ id: id("room"), op: "sub", shape: "box", position: [cx, floor + wall / 2, cz], size: [len, wall, width], surface: s });
  add({
    id: id("vault"),
    op: "sub",
    shape: "cylinder",
    position: [cx, floor + wall, cz],
    rotation: [0, 0, Math.PI / 2],
    radius: width / 2,
    height: len,
    surface: s,
  });
}

/** A round-headed opening through a wall: jamb plus arch, cut all the way through. */
function archway(x: number, floor: number, z: number, yaw: number, width: number, height: number, depth = 14): void {
  const base = id("arch");
  add({ id: `${base}-jamb`, op: "sub", shape: "box", position: [x, floor + height / 2, z], rotation: [0, yaw, 0], size: [width, height, depth], surface: HALL });
  add({
    id: `${base}-head`,
    op: "sub",
    shape: "cylinder",
    position: [x, floor + height, z],
    rotation: [Math.PI / 2, 0, yaw],
    radius: width / 2,
    height: depth,
    surface: HALL,
  });
}

/**
 * A column: stepped plinth, shaft, chamfered capital, and the stub of vault
 * it carries. Four pieces because a bare cylinder reads as a pipe — the
 * stepped base and the overhanging capital are the whole silhouette.
 */
function column(x: number, floor: number, z: number, radius: number, height: number): void {
  const base = id("col");
  const w = radius * 2;
  add({ id: `${base}-step`, op: "add", shape: "box", position: [x, floor + 0.5, z], size: [w * 1.7, 1.0, w * 1.7], surface: PALE });
  add({ id: `${base}-plinth`, op: "add", shape: "box", position: [x, floor + 1.7, z], size: [w * 1.35, 1.4, w * 1.35], surface: PALE });
  add({ id: `${base}-shaft`, op: "add", shape: "cylinder", position: [x, floor + 2.4 + height / 2, z], radius, height, surface: PALE });
  add({ id: `${base}-neck`, op: "add", shape: "cone", position: [x, floor + 2.4 + height + 0.7, z], radius: w * 0.95, height: 1.4, rotation: [Math.PI, 0, 0], surface: PALE });
  add({ id: `${base}-capital`, op: "add", shape: "box", position: [x, floor + 2.4 + height + 2.1, z], size: [w * 1.8, 1.4, w * 1.8], surface: PALE });
}

/** A flight of steps, each tread a solid block added back into a cut shaft. */
function stair(x0: number, topY: number, z: number, steps: number, rise: number, run: number, width: number, s: Surface): number {
  for (let i = 0; i < steps; i++) {
    add({
      id: id("tread"),
      op: "add",
      shape: "box",
      position: [x0 + i * run, topY - i * rise - 6, z],
      size: [run, 12, width],
      surface: s,
    });
  }
  return topY - steps * rise;
}

/**
 * A colossal skull carved into the wall, whose open jaws ARE the doorway.
 *
 * This is the thing a modular kit cannot do and CSG does for free. There is no
 * skull mesh anywhere — a cranium, a brow, two sockets and a jaw are unioned
 * into the wall, then the mouth is subtracted straight through it, and the
 * boundary between "skull" and "wall" simply does not exist to have a seam at.
 * The teeth are added back INTO the cut, so they overhang the opening; in a
 * kit that is a separate prop that has to be positioned not to poke through
 * anything.
 *
 * Built facing -X (you approach from -X and walk in through the mouth).
 */
function skullGate(cx: number, floor: number, cz: number, s = 1): void {
  const g = id("skull");
  const P = (lx: number, ly: number, lz: number): Vec3 => [cx + lx * s, floor + ly * s, cz + lz * s];
  const S = (a: number, b: number, c: number): Vec3 => [a * s, b * s, c * s];

  // The wall the gate is set into, with buttresses either side.
  add({ id: `${g}-wall`, op: "add", shape: "box", position: P(0, 13, 0), size: S(5, 30, 46), surface: HALL });
  for (const z of [-11, 11]) {
    add({ id: id("buttress"), op: "add", shape: "box", position: P(-1.6, 8, z), size: S(4, 16, 4.5), surface: PALE });
    add({ id: id("buttress-cap"), op: "add", shape: "cone", position: P(-1.6, 17, z), radius: 2.9 * s, height: 3.4 * s, surface: PALE });
  }

  // Cranium. An ellipsoid rather than a sphere is the whole reason the
  // primitive exists — a spherical skull reads as a ball with holes in it.
  add({ id: `${g}-cranium`, op: "add", shape: "ellipsoid", position: P(-2.4, 11.6, 0), size: S(9.8, 12.6, 10.2), blend: 1.2, surface: BONE });
  // Occipital swell at the back, so it is a head and not a mask.
  add({ id: `${g}-back`, op: "add", shape: "ellipsoid", position: P(1.4, 11.2, 0), size: S(7.2, 10.6, 9.6), blend: 2, surface: BONE });
  // Brow ridge.
  add({ id: `${g}-brow`, op: "add", shape: "ellipsoid", position: P(-6.1, 13.2, 0), size: S(3.4, 2.5, 9.8), blend: 1.0, surface: BONE });
  // Temples pinched in, which is what makes the brow read as a ridge.
  for (const z of [-4.9, 4.9]) {
    add({ id: id("temple"), op: "sub", shape: "ellipsoid", position: P(-5.2, 15.0, z), size: S(5.6, 4.6, 3.6), blend: 1.6, surface: BONE });
  }

  // Eye sockets — cut ALL THE WAY THROUGH, so the boss room's light comes at
  // you through them on the approach.
  for (const z of [-2.9, 2.9]) {
    add({ id: id("socket"), op: "sub", shape: "ellipsoid", position: P(-5.4, 12.2, z), size: S(6.4, 5.2, 5.0), blend: 0.5, surface: BONE });
    add({ id: id("eye-bore"), op: "sub", shape: "cylinder", position: P(0, 12.0, z), rotation: [0, 0, Math.PI / 2], radius: 1.05 * s, height: 18 * s, surface: BONE });
  }
  // Nasal aperture: an inverted triangle, which is the single most
  // skull-identifying feature after the sockets.
  add({ id: `${g}-nose`, op: "sub", shape: "cone", position: P(-5.6, 9.6, 0), radius: 1.5 * s, height: 3.2 * s, surface: BONE });
  add({ id: `${g}-nose-bore`, op: "sub", shape: "box", position: P(-2, 9.9, 0), size: S(6, 2, 1.6), surface: BONE });

  // Cheekbones sweeping back from the sockets.
  for (const z of [-4.6, 4.6]) {
    add({
      id: id("zygo"),
      op: "add",
      shape: "capsule",
      position: P(-4.2, 9.6, z),
      rotation: [Math.PI / 2, 0, 0.35],
      radius: 0.95 * s,
      height: 5.5 * s,
      blend: 0.9,
      surface: BONE,
    });
  }

  // THE DOORWAY: the mouth, cut clean through the wall. Round-headed so it
  // is an opening you walk through rather than a rectangle.
  add({ id: `${g}-maw`, op: "sub", shape: "box", position: P(0, 3.4, 0), size: S(20, 6.8, 8.2), surface: HALL });
  add({ id: `${g}-maw-head`, op: "sub", shape: "cylinder", position: P(0, 6.8, 0), rotation: [0, 0, Math.PI / 2], radius: 4.1 * s, height: 20 * s, surface: HALL });

  // Upper teeth, hanging into the opening from the maxilla.
  for (let i = 0; i < 9; i++) {
    const z = -3.4 + i * 0.85;
    const fang = i === 0 || i === 8 || i === 2 || i === 6;
    const len = fang ? 2.6 : 1.5;
    add({
      id: id("tooth-u"),
      op: "add",
      shape: fang ? "cone" : "box",
      position: P(-3.6, 8.0 - len / 2, z),
      rotation: fang ? [Math.PI, 0, 0] : [0, 0, 0],
      size: S(1.5, len, 0.62),
      radius: 0.38 * s,
      height: len * s,
      surface: BONE,
    });
  }
  // Lower jaw: a U of capsules under the opening, and teeth rising off it.
  add({ id: `${g}-jaw`, op: "add", shape: "capsule", position: P(-5.2, 1.4, 0), rotation: [Math.PI / 2, 0, 0], radius: 1.15 * s, height: 6.4 * s, blend: 0.8, surface: BONE });
  for (const z of [-3.8, 3.8]) {
    add({
      id: id("ramus"),
      op: "add",
      shape: "capsule",
      position: P(-2.6, 2.2, z),
      rotation: [Math.PI / 2 - 0.5, Math.sign(z) * 0.55, 0],
      radius: 1.05 * s,
      height: 6.5 * s,
      blend: 1,
      surface: BONE,
    });
  }
  for (let i = 0; i < 7; i++) {
    const z = -2.7 + i * 0.9;
    const fang = i === 0 || i === 6;
    const len = fang ? 2.2 : 1.3;
    add({
      id: id("tooth-l"),
      op: "add",
      shape: fang ? "cone" : "box",
      position: P(-4.9, 2.3 + len / 2, z),
      size: S(1.4, len, 0.6),
      radius: 0.36 * s,
      height: len * s,
      surface: BONE,
    });
  }

  // Horns off the temples. Not anatomy — signage. You can see from across the
  // chasm that this is the door you do not open casually.
  for (const z of [-3.4, 3.4]) {
    add({
      id: id("horn"),
      op: "add",
      shape: "cone",
      position: P(-0.6, 20.6, z),
      rotation: [Math.sign(z) * 0.34, 0, 0.5],
      radius: 1.5 * s,
      height: 9 * s,
      blend: 0.8,
      surface: BONE,
    });
  }

  brazier(cx - 7 * s, floor, cz - 8.5 * s, 1.4);
  brazier(cx - 7 * s, floor, cz + 8.5 * s, 1.4);
}

/** A brazier: stepped base, bowl, and the fire's light comes from the scene. */
function brazier(x: number, floor: number, z: number, scale = 1): void {
  const base = id("brazier");
  add({ id: `${base}-foot`, op: "add", shape: "box", position: [x, floor + 0.35 * scale, z], size: [3.2 * scale, 0.7 * scale, 3.2 * scale], surface: PALE });
  add({ id: `${base}-stem`, op: "add", shape: "cylinder", position: [x, floor + 1.6 * scale, z], radius: 0.55 * scale, height: 2.2 * scale, surface: PALE });
  add({ id: `${base}-bowl`, op: "add", shape: "cone", position: [x, floor + 3.2 * scale, z], radius: 1.7 * scale, height: 1.6 * scale, surface: PALE });
  add({ id: `${base}-fire`, op: "sub", shape: "cone", position: [x, floor + 3.5 * scale, z], radius: 1.35 * scale, height: 1.4 * scale, surface: PALE });
}

// ---------------------------------------------------------------------------
// 1. Grand stair — the descent in, under a coffered barrel
// ---------------------------------------------------------------------------

const ENTRY_Y = 6;
const STAIR_X0 = -54;
const STAIR_STEPS = 26;
const STAIR_RISE = 0.62;
const STAIR_RUN = 1.35;
const STAIR_W = 13;

bedrock(-38, -6, 0, 48, 44, 30);
// the shaft the stair runs down, generous enough for the vault over it
add({ id: "stair-shaft", op: "sub", shape: "box", position: [-36, ENTRY_Y - 4, 0], size: [42, 26, STAIR_W], surface: HALL });
add({
  id: "stair-vault",
  op: "sub",
  shape: "cylinder",
  position: [-36, ENTRY_Y + 9, 0],
  rotation: [0, 0, Math.PI / 2],
  radius: STAIR_W / 2,
  height: 42,
  surface: HALL,
});
const HALL_Y = stair(STAIR_X0, ENTRY_Y, 0, STAIR_STEPS, STAIR_RISE, STAIR_RUN, STAIR_W, HALL);

// Heavy balustrades either side, stepping down with the flight.
for (const z of [-STAIR_W / 2 + 0.9, STAIR_W / 2 - 0.9]) {
  for (let i = 0; i < STAIR_STEPS; i += 2) {
    add({
      id: id("baluster"),
      op: "add",
      shape: "box",
      position: [STAIR_X0 + i * STAIR_RUN + STAIR_RUN / 2, ENTRY_Y - i * STAIR_RISE + 1.1, z],
      size: [STAIR_RUN * 2, 2.6, 1.8],
      surface: PALE,
    });
  }
}
// The mouth: a great arch at the top of the stair, open to the sky.
add({ id: "portal-cut", op: "sub", shape: "box", position: [-58, ENTRY_Y + 4.6, 0], size: [14, 9.2, 9], surface: HALL });
add({ id: "portal-head", op: "sub", shape: "cylinder", position: [-58, ENTRY_Y + 9.2, 0], rotation: [Math.PI / 2, 0, 0], radius: 4.5, height: 14, surface: HALL });

// ---------------------------------------------------------------------------
// 2. Arcade hall — the long room, bays down both sides
// ---------------------------------------------------------------------------

const HALL_LEN = 62;
const HALL_W = 26;
const HALL_WALL = 11;
const HALL_CX = 5;

bedrock(HALL_CX, HALL_Y + 8, 0, HALL_LEN + 18, 46, HALL_W + 26);
vaultedRoom(HALL_CX, HALL_Y, 0, HALL_LEN, HALL_W, HALL_WALL, HALL);
archway(-26, HALL_Y, 0, 0, 9, 9);

// Side bays: shallow arched recesses, one per structural bay, which is what
// stops 62 m of wall from reading as a tunnel.
for (let i = 0; i < 6; i++) {
  const x = HALL_CX - 25 + i * 10;
  for (const sign of [-1, 1]) {
    add({
      id: id("bay"),
      op: "sub",
      shape: "box",
      position: [x, HALL_Y + 3.6, sign * (HALL_W / 2 + 2.2)],
      size: [6.4, 7.2, 7],
      surface: HALL,
    });
    add({
      id: id("bay-head"),
      op: "sub",
      shape: "cylinder",
      position: [x, HALL_Y + 7.2, sign * (HALL_W / 2 + 2.2)],
      rotation: [Math.PI / 2, 0, 0],
      radius: 3.2,
      height: 7,
      surface: HALL,
    });
    brazier(x, HALL_Y, sign * (HALL_W / 2 - 1.4), 1.1);
  }
}

// Two rows of columns carrying transverse ribs across the vault.
for (let i = 0; i < 6; i++) {
  const x = HALL_CX - 25 + i * 10;
  for (const z of [-7.5, 7.5]) column(x, HALL_Y, z, 1.75, 8);
  // the rib itself, springing from capital to capital over the nave
  add({ id: id("rib"), op: "add", shape: "torus", position: [x, HALL_Y + HALL_WALL, 0], rotation: [0, Math.PI / 2, 0], radius: HALL_W / 2 - 0.6, height: 0.85, surface: PALE });
}

// ---------------------------------------------------------------------------
// 3. The chasm, and the bridge across it
// ---------------------------------------------------------------------------

const CHASM_X = 46;
bedrock(CHASM_X, HALL_Y - 4, 0, 26, 60, 34);
add({ id: "chasm-room", op: "sub", shape: "box", position: [CHASM_X, HALL_Y + 9, 0], size: [24, 22, 28], surface: HALL });
add({ id: "chasm", op: "sub", shape: "box", position: [CHASM_X, HALL_Y - 20, 0], size: [21, 44, 26], round: 1.5, surface: CAVE });
// rough the pit walls up so it reads as a fissure the hold was built over
for (let i = 0; i < 7; i++) {
  const a = (i / 7) * Math.PI * 2;
  add({
    id: id("fissure"),
    op: "sub",
    shape: "capsule",
    position: [CHASM_X + Math.cos(a) * 9, HALL_Y - 16 - (i % 3) * 6, Math.sin(a) * 11],
    rotation: [0.25, a, 0],
    radius: 4.2 + (i % 3),
    height: 16,
    blend: 3.2,
    surface: CAVE,
  });
}
// The bridge: a slab on three arched piers, no parapet, which is the point.
add({ id: "bridge-deck", op: "add", shape: "box", position: [CHASM_X, HALL_Y - 0.5, 0], size: [26, 1.1, 7.5], surface: PALE });
for (const z of [-3.4, 3.4]) {
  add({ id: id("bridge-kerb"), op: "add", shape: "box", position: [CHASM_X, HALL_Y + 0.4, z], size: [26, 0.9, 0.8], surface: PALE });
}
for (const x of [CHASM_X - 7, CHASM_X, CHASM_X + 7]) {
  add({ id: id("pier"), op: "add", shape: "box", position: [x, HALL_Y - 4.5, 0], size: [2.4, 9, 7.5], surface: PALE });
  add({ id: id("pier-arch"), op: "sub", shape: "cylinder", position: [x + 3.5, HALL_Y - 1.4, 0], rotation: [Math.PI / 2, 0, 0], radius: 2.6, height: 9, surface: PALE });
}
archway(CHASM_X - 12, HALL_Y, 0, 0, 9, 9);
archway(CHASM_X + 12, HALL_Y, 0, 0, 9, 9);

// ---------------------------------------------------------------------------
// 4. Boss chamber — the set piece at the end
// ---------------------------------------------------------------------------

const BOSS_X = 84;
const BOSS_R = 21;
const BOSS_WALL = 13;

bedrock(BOSS_X, HALL_Y + 12, 0, BOSS_R * 2 + 20, 54, BOSS_R * 2 + 20);
add({ id: "boss-room", op: "sub", shape: "cylinder", position: [BOSS_X, HALL_Y + BOSS_WALL / 2, 0], radius: BOSS_R, height: BOSS_WALL, surface: HALL });
// a dome over it rather than a barrel — this room is the destination
add({ id: "boss-dome", op: "sub", shape: "sphere", position: [BOSS_X, HALL_Y + BOSS_WALL, 0], radius: BOSS_R, surface: HALL });

// A ring of eight massive columns, and eight alcoves behind them.
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
  column(BOSS_X + Math.cos(a) * (BOSS_R - 5.5), HALL_Y, Math.sin(a) * (BOSS_R - 5.5), 2.4, 10);
  const ax = BOSS_X + Math.cos(a) * (BOSS_R + 1.5);
  const az = Math.sin(a) * (BOSS_R + 1.5);
  add({ id: id("alcove"), op: "sub", shape: "box", position: [ax, HALL_Y + 4, az], rotation: [0, -a, 0], size: [8, 8, 7], surface: HALL });
  add({ id: id("alcove-head"), op: "sub", shape: "cylinder", position: [ax, HALL_Y + 8, az], rotation: [Math.PI / 2, 0, -a], radius: 3.5, height: 8, surface: HALL });
}

// The dais: three broad steps up to a platform, with a ring of standing stones.
for (let i = 0; i < 3; i++) {
  add({ id: id("dais"), op: "add", shape: "cylinder", position: [BOSS_X, HALL_Y + 0.45 + i * 0.9, 0], radius: 11 - i * 2.4, height: 0.9 + i * 0.9, surface: PALE });
}
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  add({
    id: id("stone"),
    op: "add",
    shape: "box",
    position: [BOSS_X + Math.cos(a) * 5.4, HALL_Y + 5.4, Math.sin(a) * 5.4],
    rotation: [0, -a, i === 2 ? 0.28 : 0],
    size: [1.8, 6, 1.2],
    surface: MOSS,
  });
}
brazier(BOSS_X - 8.5, HALL_Y + 2.7, 0, 1.5);
brazier(BOSS_X + 8.5, HALL_Y + 2.7, 0, 1.5);

// Four light shafts to the surface, on the diagonals, so the room is lit by
// daylight as well as fire — the classic WoW "something holy happened here".
for (let i = 0; i < 4; i++) {
  const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
  add({
    id: id("shaft"),
    op: "sub",
    shape: "cylinder",
    position: [BOSS_X + Math.cos(a) * 13, HALL_Y + 26, Math.sin(a) * 13],
    radius: 2.6,
    height: 40,
    surface: HALL,
  });
}
// The way in is not an arch. It is a skull.
skullGate(BOSS_X - BOSS_R - 4, HALL_Y, 0, 1.2);

// ---------------------------------------------------------------------------
// 5. The cave — raw rock breaking into the arcade's north wall
// ---------------------------------------------------------------------------

function passage(points: Vec3[], radius: number, blend = 3): void {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    // a capsule points along local Y, so aim it with a pitch and a yaw
    add({
      id: id("cave"),
      op: "sub",
      shape: "capsule",
      position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      rotation: [Math.acos(Math.max(-1, Math.min(1, dy / (len || 1)))), Math.atan2(dx, dz), 0],
      radius: radius * (0.8 + 0.4 * ((i * 7) % 5) / 5),
      height: len,
      blend,
      surface: CAVE,
    });
  }
}

bedrock(2, HALL_Y + 2, -34, 60, 34, 30);
passage(
  [
    [-16, HALL_Y + 2, -46],
    [-6, HALL_Y + 1, -40],
    [4, HALL_Y - 1, -35],
    [14, HALL_Y, -30],
    [20, HALL_Y + 1, -22],
    [18, HALL_Y + 2, -15],
  ],
  6.5,
);
add({ id: "cavern", op: "sub", shape: "sphere", position: [6, HALL_Y + 2, -34], radius: 12, blend: 5, surface: CAVE });

// The breach: the cave has eaten one bay, so you stand in dressed stone and
// look into raw rock through the same hole. This is the frame that shows a
// dual contour holding a square edge and a smooth blend at once.
add({ id: "breach", op: "sub", shape: "sphere", position: [18, HALL_Y + 3.5, -13.5], radius: 7.5, blend: 4, surface: CAVE });
// masonry the collapse left behind
for (let i = 0; i < 5; i++) {
  add({
    id: id("rubble"),
    op: "add",
    shape: "box",
    position: [15 + i * 1.9, HALL_Y + 0.6 + (i % 2) * 0.5, -17 + (i % 3) * 2.2],
    rotation: [0.2 * i, 0.7 * i, 0.15 * i],
    size: [2.6, 1.3, 2],
    surface: MOSS,
  });
}
// a fallen column across the breach
add({ id: "fallen", op: "add", shape: "cylinder", position: [21, HALL_Y + 1.4, -18], rotation: [Math.PI / 2 - 0.1, 0.5, 0], radius: 1.6, height: 11, surface: MOSS });

// ---------------------------------------------------------------------------
// Write it out
// ---------------------------------------------------------------------------

const doc = {
  name: "Dungeon",
  voxelSize: 0.3,
  palette: ["floor", "wall", "vault", "pale-stone", "cave-floor", "cave-rock", "moss", "bone"],
  surface: HALL,
  bounds: {
    // Clipped tight to the built spaces on purpose. Meshing the outside of a
    // rock mass nobody can reach cost more triangles than the whole dungeon;
    // the solid simply runs off the lattice there and is not emitted.
    min: [-64, -26, -52] as Vec3,
    max: [112, 30, 40] as Vec3,
  },
  nodes,
};

const target = process.argv[2] ?? "voxel-demo";
const out = path.join(ROOT, "projects", target, "assets", "volumes");
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, "dwarven-hold.json");
fs.writeFileSync(file, JSON.stringify(doc, null, 2));
console.log(
  `wrote ${path.relative(ROOT, file)} — ${nodes.length} nodes, voxel ${doc.voxelSize} m, hall floor y=${HALL_Y.toFixed(1)}`,
);
