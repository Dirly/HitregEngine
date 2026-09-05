/**
 * A tiny synthetic kit — a plank floor and a brick wall as glTF parts plus a
 * 3x2 room built from them as a GLB example — so the pipeline can be run
 * with no art on disk. Used by the self-test and for browser smoke runs.
 */
import fs from "node:fs";
import path from "node:path";
import { GltfBuilder, yawQuaternion } from "./gltf.mjs";
import { encodePng } from "./png.mjs";

export const CELL = [4, 3, 4];

/** Axis-aligned box as 6 quads with per-face planar UVs; `uvTop` overrides the +Y face's UV function. */
export function boxGeometry(min, max, uvTop) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const faces = [
    { c: [[min[0], max[1], max[2]], [max[0], max[1], max[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]]], uv: (p) => (uvTop ? uvTop(p) : [(p[0] - min[0]) / (max[0] - min[0]), (p[2] - min[2]) / (max[2] - min[2])]) },
    { c: [[min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], min[1], max[2]], [min[0], min[1], max[2]]], uv: (p) => [(p[0] - min[0]) / (max[0] - min[0]), (p[2] - min[2]) / (max[2] - min[2])] },
    { c: [[min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]]], uv: (p) => [(p[0] - min[0]) / (max[0] - min[0]), 1 - (p[1] - min[1]) / (max[1] - min[1])] },
    { c: [[max[0], min[1], min[2]], [min[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]]], uv: (p) => [(p[0] - min[0]) / (max[0] - min[0]), 1 - (p[1] - min[1]) / (max[1] - min[1])] },
    { c: [[max[0], min[1], max[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [max[0], max[1], max[2]]], uv: (p) => [(p[2] - min[2]) / (max[2] - min[2]), 1 - (p[1] - min[1]) / (max[1] - min[1])] },
    { c: [[min[0], min[1], min[2]], [min[0], min[1], max[2]], [min[0], max[1], max[2]], [min[0], max[1], min[2]]], uv: (p) => [(p[2] - min[2]) / (max[2] - min[2]), 1 - (p[1] - min[1]) / (max[1] - min[1])] },
  ];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const p of face.c) {
      positions.push(...p);
      uvs.push(...face.uv(p));
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint16Array.from(indices) };
}

/**
 * 4-pixel stripes; `horizontal` = bands run along u. With `arrow`, a white
 * triangle pointing +u is drawn over the middle — an ASYMMETRIC marker, so a
 * top-down screenshot can tell a correct counter-rotation from one that is
 * off by 180° (stripes alone cannot).
 */
export function stripesPng(size, horizontal, a = [200, 150, 90], b = [120, 80, 40], arrow = false) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const band = (horizontal ? y : x) % 4 < 2;
      const i = (y * size + x) * 4;
      let c = band ? a : b;
      if (arrow) {
        // triangle: apex at (0.85, 0.5), base from (0.35, 0.25) to (0.35, 0.75)
        const fx = (x + 0.5) / size;
        const fy = (y + 0.5) / size;
        const t = (fx - 0.35) / 0.5;
        if (t >= 0 && t <= 1 && Math.abs(fy - 0.5) <= 0.25 * (1 - t)) c = [255, 255, 255];
      }
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

export function addMesh(b, geo, materialIndex, name) {
  return b.pushMesh({
    name,
    primitives: [
      {
        attributes: {
          POSITION: b.pushAccessor(geo.positions, "VEC3", { target: 34962, minMax: true }),
          TEXCOORD_0: b.pushAccessor(geo.uvs, "VEC2", { target: 34962 }),
        },
        indices: b.pushAccessor(geo.indices, "SCALAR", { target: 34963 }),
        material: materialIndex,
      },
    ],
  });
}

export function texturedMaterial(b, png, name) {
  const image = b.pushImage(png, name);
  const sampler = b.pushSampler({ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 });
  const texture = b.pushTexture({ sampler, source: image });
  return b.pushMaterial({ name, pbrMetallicRoughness: { baseColorTexture: { index: texture }, metallicFactor: 0, roughnessFactor: 1 } });
}

/** floor: 4x0.2x4 slab on the cell floor; top UVs = the cell's planar projection (u = x, v = z) */
export const floorGeo = boxGeometry([-2, 0, -2], [2, 0.2, 2], (p) => [p[0] / 4 + 0.5, p[2] / 4 + 0.5]);
/** wall: on the +z edge, thickness inside the cell */
export const wallGeo = boxGeometry([-2, 0, 1.7], [2, 3, 2]);
export const plankPng = stripesPng(32, false, [200, 150, 90], [120, 80, 40], true);
export const brickPng = stripesPng(16, true, [150, 60, 50], [90, 40, 35]);

export function partDoc(geo, png, name) {
  const b = new GltfBuilder("synthetic-kit");
  const material = texturedMaterial(b, png, `${name}-tex`);
  const mesh = addMesh(b, geo, material, name);
  b.pushNode({ name, mesh }, true);
  return b.finish();
}

/** The example: a 3x2 room. Floors everywhere; walls on the outer edges only. */
export function exampleDoc() {
  const b = new GltfBuilder("synthetic-kit");
  const floorMat = texturedMaterial(b, plankPng, "floor-tex");
  const wallMat = texturedMaterial(b, brickPng, "wall-tex");
  const floorMesh = addMesh(b, floorGeo, floorMat, "floor");
  const wallMesh = addMesh(b, wallGeo, wallMat, "wall");
  let copies = 0;
  const place = (mesh, name, cell, rotation) => {
    copies += 1;
    b.pushNode(
      {
        // mixed naming on purpose: plain, "name 2", "name.003", and one mangled name matched by geometry
        name: copies === 4 ? "thing" : `${name}${copies % 3 === 0 ? `.00${copies}` : copies % 2 === 0 ? ` ${copies}` : ""}`,
        mesh,
        translation: [cell[0] * CELL[0], cell[1] * CELL[1], cell[2] * CELL[2]],
        rotation: yawQuaternion(rotation),
      },
      true,
    );
  };
  for (let x = 0; x < 3; x++) {
    for (let z = 0; z < 2; z++) {
      place(floorMesh, "floor", [x, 0, z], 0);
      if (z === 0) place(wallMesh, "wall", [x, 0, z], 180); // nz
      if (z === 1) place(wallMesh, "wall", [x, 0, z], 0); // pz
      if (x === 0) place(wallMesh, "wall", [x, 0, z], 270); // nx
      if (x === 2) place(wallMesh, "wall", [x, 0, z], 90); // px
    }
  }
  return b.finish();
}

/** Pack a self-contained .gltf doc as a GLB. */
export function toGlb(doc) {
  const uri = doc.buffers[0].uri;
  const bin = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  const json = Buffer.from(JSON.stringify({ ...doc, buffers: [{ byteLength: bin.length }] }));
  const pad = (buf, fill) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4), fill)]) : buf);
  const jsonChunk = pad(json, 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunk = (type, body) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(body.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, body]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, binChunk)]);
}

/** Write the kit (parts + examples/room.glb) into `kitDir`. */
export function writeSyntheticKit(kitDir) {
  fs.mkdirSync(path.join(kitDir, "examples"), { recursive: true });
  fs.writeFileSync(path.join(kitDir, "floor.gltf"), JSON.stringify(partDoc(floorGeo, plankPng, "floor")));
  fs.writeFileSync(path.join(kitDir, "wall.gltf"), JSON.stringify(partDoc(wallGeo, brickPng, "wall")));
  fs.writeFileSync(path.join(kitDir, "examples", "room.glb"), toGlb(exampleDoc()));
  return kitDir;
}
