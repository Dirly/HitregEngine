// A self-contained stand-in for a world project, for the rock-skins / rock-audit tests: `fixture-world` with a slate
// zone (`fixture-slate`), a rust zone (`fixture-rust`), a rock-cap material with its small/large twins, rock-kit
// models and prefabs. Everything is GENERATED into the OS temp dir (solid-colour PNGs of the right header width,
// minimal GLBs of the right size), so nothing but this builder is committed and the tests need no live game project.
// The tests point the closure at it with `HITREG_PROJECTS_ROOT` (see tools/_closure.mjs `projectsRoot`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodePng } from "../../../tools/_png.mjs";

export const FIXTURE_PROJECT = "fixture-world";
export const SLATE = "zones/fixture-slate";
export const RUST = "zones/fixture-rust";

/** [texture id, width px, colour]. Slate zone tiles share the slate tone; granite/sandstone are brown, far from it by tone. */
const TEXTURES: [string, number, string][] = [
  ["rock-kit/granite.png", 64, "#5e5346"],
  [`${RUST}/sandstone.png`, 64, "#705143"],
  [`${RUST}/cliff.png`, 64, "#6b4439"],
  [`${RUST}/rock-small.png`, 64, "#6b4439"],
  [`${RUST}/rock-large.png`, 64, "#6b4439"],
  ["mmo/Clif.png", 512, "#64625d"],
  ["mmo/RockGrey.png", 256, "#525a5f"],
  ["mmo/RedRock.png", 64, "#6b4439"],
  ["mmo/Moss.png", 64, "#4a6a3a"],
  [`${SLATE}/cliff.png`, 512, "#525a5f"],
  [`${SLATE}/accent.png`, 128, "#525a5f"],
  [`${SLATE}/rock-small.png`, 256, "#525a5f"],
  [`${SLATE}/rock-large.png`, 512, "#525a5f"],
  [`${SLATE}/gorge-cliff.png`, 256, "#525a5f"],
  [`${SLATE}/gorge-rock-small.png`, 256, "#525a5f"],
  [`${SLATE}/gorge-rock-large.png`, 256, "#525a5f"],
  ["zones/fixture-fen/cliff.png", 64, "#4f5a4a"],
  ["zones/fixture-fen/rock-small.png", 64, "#4f5a4a"],
  ["zones/fixture-fen/rock-large.png", 64, "#4f5a4a"],
  ["fixture-keep/masonry.png", 64, "#8a8f8c"],
];

/** Model name (under rock-kit/) -> [x, y, z] size in metres, matching the real kit pieces the tests lean on. */
const MODELS: Record<string, [number, number, number]> = {
  "boulder-s-1": [0.73, 0.47, 0.78],
  "boulder-s-2": [1.21, 0.58, 0.71],
  "boulder-xl-1": [4.9, 3.93, 4.23],
  "boulder-xl-2": [4.9, 3.93, 4.23],
  "crag-1": [4.97, 5.77, 3.31],
};

const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const;

function solidPng(width: number, color: string): Buffer {
  const [r, g, b] = hex(color);
  const px = new Uint8Array(width * width * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
  return encodePng(width, width, px);
}

/** A GLB holding one box mesh of `size` (base on y 0, centred on x/z) whose first material carries the kit's `rockKit` extras. */
function boxGlb(size: [number, number, number]): Buffer {
  const [sx, sy, sz] = size;
  const v = new Float32Array([
    -sx / 2, 0, -sz / 2, sx / 2, 0, -sz / 2, sx / 2, 0, sz / 2, -sx / 2, 0, sz / 2,
    -sx / 2, sy, -sz / 2, sx / 2, sy, -sz / 2, sx / 2, sy, sz / 2, -sx / 2, sy, sz / 2,
  ]);
  const bin = Buffer.from(v.buffer);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ extras: { rockKit: { baseTileMetres: 6.4, bases: ["rock-kit/granite.png", `${RUST}/sandstone.png`] } } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-sx / 2, 0, -sz / 2], max: [sx / 2, sy, sz / 2] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let j = Buffer.from(JSON.stringify(json), "utf8");
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const ch = (type: number, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, body]); };
  return Buffer.concat([head, ch(0x4e4f534a, j), ch(0x004e4942, bin)]);
}

type Base = { map: string; metres: number; color?: string };
const rockCapMaterial = (bases: Base[]) => ({
  shader: "rock-cap", color: "#ffffff", roughness: 0.95, metalness: 0, filter: "nearest",
  rockCap: { bases, extraLayers: [{ name: "moss", map: "mmo/Moss.png", uvScale: 3.2, color: "#86d05a", roughness: 1 }], start: 0.72, thicken: 0.55, softness: 0.06, noise: 0.04, noiseMetres: 0.25, crevice: 0.7, occlusion: 0.35 },
});

const write = (file: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

/** The eight rock-cap slots of the real world's layout: granite, sandstone, Clif, slate gorge, slate cliff, fen, red rock, rust. */
function slots(kind: "main" | "small" | "large"): Base[] {
  const [slate, fen, rust] = kind === "main" ? [`${SLATE}/cliff.png`, "zones/fixture-fen/cliff.png", `${RUST}/cliff.png`] : [`${SLATE}/rock-${kind}.png`, `zones/fixture-fen/rock-${kind}.png`, `${RUST}/rock-${kind}.png`];
  const m = kind === "small" ? 6.4 : kind === "large" ? 12.8 : undefined;
  return [
    { map: "rock-kit/granite.png", metres: 6.4 },
    { map: `${RUST}/sandstone.png`, metres: 6.4 },
    { map: "mmo/Clif.png", metres: kind === "main" ? 20 : 12.8, color: "#ffffff" },
    { map: kind === "main" ? `${SLATE}/gorge-cliff.png` : `${SLATE}/gorge-rock-${kind}.png`, metres: 6.4 },
    { map: slate, metres: m ?? 12.8 },
    { map: fen, metres: m ?? 12.8 },
    { map: "mmo/RedRock.png", metres: 6.4 },
    { map: rust, metres: m ?? 6.4 },
  ];
}

/** Generate the fixture project tree under `root` (a folder of project folders). */
export function buildRockSkinsFixture(root: string): void {
  const proj = path.join(root, FIXTURE_PROJECT);
  const a = (rel: string) => path.join(proj, "assets", rel);
  write(path.join(proj, "project.json"), JSON.stringify({ version: 1, name: FIXTURE_PROJECT, title: "Fixture world", dependsOn: [] }, null, 2));
  for (const [id, width, color] of TEXTURES) write(a(`textures/${id}`), solidPng(width, color));
  for (const kind of ["main", "small", "large"] as const)
    write(a(`materials/terrain/fixture-world-rock${kind === "main" ? "" : `-${kind}`}.json`), JSON.stringify(rockCapMaterial(slots(kind)), null, 2));
  write(a("materials/fixture-keep/face.json"), JSON.stringify({ shader: "standard", map: "fixture-keep/masonry.png", color: "#e1ede7", filter: "nearest", roughness: 0.95, metalness: 0 }, null, 2));
  for (const [name, size] of Object.entries(MODELS)) write(a(`models/rock-kit/${name}.glb`), boxGlb(size));
  for (const name of ["boulder-s-2", "boulder-xl-2"]) {
    write(a(`prefabs/rock-kit/${name}.json`), JSON.stringify({
      version: 1, name, root: "rock",
      entities: { rock: { name, parent: null, tags: ["rock-kit"], components: { transform: {}, mesh: { source: { kind: "asset", assetId: `rock-kit/${name}.glb` }, renderMode: "instanced", static: true } } } },
    }, null, 2));
  }
}

/** Build the fixture in a fresh OS temp dir and point the closure at it (`HITREG_PROJECTS_ROOT`). Returns the cleanup function. */
export function useRockSkinsFixture(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rock-skins-fixture-"));
  buildRockSkinsFixture(root);
  const prev = process.env.HITREG_PROJECTS_ROOT;
  process.env.HITREG_PROJECTS_ROOT = root;
  return () => {
    if (prev === undefined) delete process.env.HITREG_PROJECTS_ROOT; else process.env.HITREG_PROJECTS_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  };
}
