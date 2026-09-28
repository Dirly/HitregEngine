import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  APPEARANCE_DATA,
  APPEARANCE_FLOATS,
  applyModelAppearance,
  classifySkin,
  encodeAppearance,
  carveSkinFeatures,
  classifyPageSkin,
  linearToOklab,
  oklabToLinear,
  SKIN_KEEP,
  SKIN_SOFT,
  protectMouth,
  SKIN_LINE,
  SKIN_TONED,
  tonedSkin,
  sheetLightness,
  TONE_FIT,
  skinRegions,
  partTileCode,
  setPartTile,
  skinReference,
  tileCodes,
  tileTableOf,
} from "../src/appearance.js";
import { INSTANCE_APPEARANCE_ATTRIBUTES, InstancedProps } from "../src/instancing.js";

describe("per-part tile table", () => {
  it("packs 36 parts × 8-bit codes exactly into float32 (the shader's decode reads them back)", () => {
    const data = new Float32Array(APPEARANCE_FLOATS);
    const want: number[] = [];
    for (let p = 0; p < 36; p++) {
      const code = (p * 37 + 11) % 256;
      want.push(code);
      setPartTile(data, p, code);
    }
    // overwrite a few: a later group wins a part
    setPartTile(data, 0, 255);
    want[0] = 255;
    setPartTile(data, 35, 0);
    want[35] = 0;
    for (let p = 0; p < 36; p++) expect(partTileCode(data, p)).toBe(want[p]);
    // every packed float is an integer below 2^24: exact in float32, so the GPU sees the same bits
    for (let f = 0; f < 12; f++) {
      expect(Number.isInteger(data[f])).toBe(true);
      expect(data[f]!).toBeLessThan(2 ** 24);
    }
  });

  it("codes tiles 1.. in the model's table order; 0 is the default tile", () => {
    const tiles = { "a.png": [0.1, 0.2, 0.3], "b.png": [0.5, 0.5, 0.25] };
    expect([...tileCodes(tiles)]).toEqual([
      ["a.png", 1],
      ["b.png", 2],
    ]);
    const table = tileTableOf(tiles, [0.01, 0.02, 0.3]);
    expect(table.map((v) => [v.x, v.y, v.z])).toEqual([
      [0.01, 0.02, 0.3],
      [0.1, 0.2, 0.3],
      [0.5, 0.5, 0.25],
    ]);
  });

  it("encodes groups: later groups win, unknown names are reported, the tint is linear", () => {
    const parts = { Chest: 0, Legs: 1, Hands: 2, F_Halo: 31 };
    const codes = tileCodes({ "vanguard.png": [0, 0, 1], "ranger.png": [0, 0, 1], "magus.png": [0, 0, 1] });
    const { data, shown, missingParts, missingTextures } = encodeAppearance(parts, codes, {
      groups: [
        { parts: ["Chest", "Legs", "Hands"], texture: "vanguard.png" },
        { parts: ["Legs"], texture: "ranger.png" },
        { parts: ["Hands", "Nope"], texture: "cleric.png" },
        { parts: ["F_Halo"] },
      ],
      skinTint: "#ffffff",
    });
    expect(partTileCode(data, 0)).toBe(1);
    expect(partTileCode(data, 1)).toBe(2);
    expect(partTileCode(data, 2)).toBe(0); // unknown sheet → the default tile, reported
    expect(partTileCode(data, 31)).toBe(0);
    expect(shown).toEqual([0, 1, 2, 31]);
    expect(missingParts).toEqual(["Nope"]);
    expect(missingTextures).toEqual(["cleric.png"]);
    // the tint travels as OKLab: white is L 1, a = b = 0
    expect(data[12]).toBeCloseTo(1, 4);
    expect(Math.abs(data[13]!) + Math.abs(data[14]!)).toBeLessThan(1e-3);
    expect(data[15]).toBe(1);
    // no tint: the on-flag stays 0
    expect(encodeAppearance(parts, codes, { groups: [] }).data[15]).toBe(0);
  });
});

/** A page: RGBA8, `w`×`h`, filled per texel by `paint(x, y)`. */
function page(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(paint(x, y), (y * w + x) * 4);
  return out;
}

describe("skin classifier", () => {
  // colours measured on the MMO sheets
  const SKIN = [167, 109, 75, 255] as [number, number, number, number]; // base body skin mean #A76D4B
  const SKIN_SHADOW = [100, 62, 42, 255] as [number, number, number, number]; // v≈0.39: weak only
  const LEATHER = [72, 46, 30, 255] as [number, number, number, number]; // skin's hue, v≈0.28
  const LIPS = [150, 70, 70, 255] as [number, number, number, number]; // hue 0°
  const CLOTH = [200, 185, 150, 255] as [number, number, number, number]; // linen, s≈0.25
  const EYE = [60, 80, 110, 255] as [number, number, number, number];

  it("takes skin and its shadow, leaves leather, lips, eyes, cloth and cut-outs", () => {
    const w = 16;
    const h = 8;
    const rgba = page(w, h, (x, y) => {
      if (x < 6) return y === 7 ? SKIN_SHADOW : x === 2 && y === 2 ? LIPS : x === 3 && y === 2 ? EYE : SKIN;
      if (x < 8) return [0, 0, 0, 0];
      if (x < 12) return LEATHER;
      return CLOTH;
    });
    const mask = classifySkin(rgba, w, h);
    const at = (x: number, y: number): number => mask[y * w + x]!;
    expect(at(0, 0)).toBe(1);
    expect(at(4, 7)).toBe(1); // a shadow joins through its lit neighbour
    expect(at(2, 2)).toBe(0);
    expect(at(3, 2)).toBe(0);
    expect(at(6, 0)).toBe(0);
    expect(at(9, 3)).toBe(0);
    expect(at(13, 3)).toBe(0);
  });

  it("drops a seed too small to be skin (a leather highlight) and does not grow from it", () => {
    const w = 12;
    const h = 12;
    const rgba = page(w, h, (x, y) => (x >= 5 && x <= 6 && y >= 5 && y <= 6 ? SKIN : SKIN_SHADOW));
    expect(classifySkin(rgba, w, h).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("measures the page's mean skin colour in linear rgb", () => {
    const rgba = page(4, 4, (x) => (x < 2 ? SKIN : CLOTH));
    const loose = { hue: [16, 24], sat: [0.4, 0.7], val: [0.4, 0.9] };
    const mask = classifySkin(rgba, 4, 4, { strong: loose, weak: loose, minSeed: 1 });
    expect(mask.reduce((a, b) => a + b, 0)).toBe(8);
    const ref = skinReference(rgba, mask)!;
    expect(ref[0]).toBeCloseTo(((167 / 255 + 0.055) / 1.055) ** 2.4, 5);
  });

  it("is OPT-IN: only opted-in tiles are judged, and a part-limited sheet only inside those parts' islands", () => {
    // a 16×8 page with two 8×8 tiles, both painted skin all over
    const rgba = page(16, 8, () => SKIN);
    const tiles = { "base.png": [0, 0, 0.5], "armor.png": [0.5, 0, 0.5] };
    // armor sheet opted in for part 1 only: a triangle covering the sheet's top-left half
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 2));
    geometry.setAttribute("uv1", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0], 2));
    const none = classifyPageSkin(rgba, 16, 8, skinRegions(16, 8, tiles, { Hands: 1 }, [], geometry));
    expect(none.reduce((a, b) => a + b, 0)).toBe(0);
    const regions = skinRegions(16, 8, tiles, { Chest: 0, Hands: 1 }, [{ texture: "base.png" }, { texture: "armor.png", parts: ["Hands"] }], geometry);
    const mask = classifyPageSkin(rgba, 16, 8, regions);
    const at = (x: number, y: number): number => mask[y * 16 + x]!;
    expect(at(3, 3)).toBe(1); // the whole base tile
    expect(at(9, 1)).toBe(1); // inside the hand island on the armour tile
    expect(at(15, 7)).toBe(0); // the armour tile outside it
    expect(regions.missingTextures).toEqual([]);
    expect(skinRegions(16, 8, tiles, null, [{ texture: "nope.png" }]).missingTextures).toEqual(["nope.png"]);
  });
});

describe("facial features and dark tones", () => {
  it("carves dark lines (the darker of painted/toned) and colour features (kept) out of a face, not its highlights", () => {
    const w = 11;
    const h = 11;
    const SKIN = [167, 109, 75, 255];
    const rgba = page(w, h, (x, y) => {
      if (y === 3 && x >= 3 && x <= 7) return [60, 38, 26, 255]; // a lash line: skin's hue, much darker
      if (y === 7 && x === 5) return [170, 90, 80, 255]; // a lip texel: toward red
      if (y === 5 && x === 5) return [190, 128, 90, 255]; // a nose highlight: lighter, on skin's hue
      return SKIN as [number, number, number, number];
    });
    const mask = new Uint8Array(w * h).fill(SKIN_TONED);
    carveSkinFeatures(rgba, w, h, mask);
    expect(mask[3 * w + 5]).toBe(SKIN_LINE);
    expect(mask[7 * w + 5]).toBe(SKIN_KEEP);
    expect(mask[5 * w + 5]).toBe(SKIN_TONED);
    expect(mask[0]).toBe(SKIN_TONED);
  });

  it("carries the painted shading onto any tone in perceptual lightness: dark tones keep highlights and readable shadows", () => {
    const tone = (hex: string) => linearToOklab(...(new THREE.Color(hex).toArray() as [number, number, number]));
    const pageL = 0.55;
    for (const hex of ["#f0d2bc", "#a2704a", "#482c20"]) {
      const t = tone(hex);
      const hi = tonedSkin(0.7, pageL, t);
      const mid = tonedSkin(pageL, pageL, t);
      const lo = tonedSkin(0.35, pageL, t);
      expect(mid[0]).toBeCloseTo(t[0], 6); // the mean skin becomes exactly the tone
      expect(hi[0]).toBeGreaterThan(mid[0] + 0.03); // a visible highlight…
      expect(hi[0]).toBeLessThan(1); // …that never clips
      expect(lo[0]).toBeLessThan(mid[0] - 0.05); // a readable shadow…
      expect(lo[0]).toBeGreaterThan(0.08); // …that never collapses to black
      // hue from the tone: warm (a, b > 0) all the way, never grey
      for (const c of [hi, mid, lo]) {
        expect(c[1]).toBeGreaterThan(0);
        expect(c[2]).toBeGreaterThan(0);
        expect(Math.min(...oklabToLinear(...c))).toBeGreaterThanOrEqual(-1e-6);
      }
    }
  });
});

describe("whole-sheet tint (hair)", () => {
  it("measures the sheet's mean lightness and spread from every opaque texel", () => {
    const rgba = page(10, 10, (x, y) => (y === 9 ? [0, 0, 0, 0] : x % 2 ? [200, 170, 120, 255] : [120, 95, 60, 255]));
    const stats = sheetLightness(rgba)!;
    expect(stats.up).toBeGreaterThan(0.05);
    expect(stats.down).toBeGreaterThan(0.05);
    expect(sheetLightness(page(2, 2, () => [0, 0, 0, 0]))).toBeNull();
  });

  it("carries strand contrast 1:1 where the colour has room, and compresses only against black/white", () => {
    const tone = (hex: string) => linearToOklab(...(new THREE.Color(hex).toArray() as [number, number, number]));
    const fit = { up: 0.165, down: 0.178 }; // the MMO hair sheet
    for (const hex of ["#c4a674", "#9c978f", "#1f1b19", "#7c3b22"]) {
      const t = tone(hex);
      const hi = tonedSkin(0.707 + 0.1, 0.707, t, fit)[0];
      const lo = tonedSkin(0.707 - 0.1, 0.707, t, fit)[0];
      expect(hi - lo).toBeGreaterThan(0.12); // blond, grey and black all keep strands
      expect(hi).toBeLessThanOrEqual(TONE_FIT.ceiling + 1e-6);
      expect(lo).toBeGreaterThanOrEqual(TONE_FIT.floor - 1e-6);
    }
    // blond has the room: exactly the painted step
    const blond = tone("#c4a674");
    expect(tonedSkin(0.807, 0.707, blond, fit)[0] - blond[0]).toBeCloseTo(0.1, 6);
  });

  it("tints the whole hair sheet through one shared material", () => {
    const a = uberModel();
    const b = a.clone(true);
    applyModelAppearance(a, { groups: [], skinTint: "#1f1b19" }, { tintWhole: true });
    applyModelAppearance(b, { groups: [], skinTint: "#c4a674" }, { tintWhole: true });
    const ma = a.children[0] as THREE.Mesh;
    const mb = b.children[0] as THREE.Mesh;
    expect(ma.material).toBe(mb.material);
    expect((ma.userData[APPEARANCE_DATA] as Float32Array)[15]).toBe(1);
  });
});

describe("the mouth on a face sheet", () => {
  it("keeps the lips (lines and what lies between them) as painted, with a half-toned ring, and ignores nostrils and chin marks", () => {
    const w = 20;
    const mask = new Uint8Array(w * w).fill(SKIN_TONED);
    const set = (x: number, y: number, v: number) => (mask[y * w + x] = v);
    for (let x = 8; x <= 11; x++) set(x, 9, SKIN_LINE); // nostrils, above
    for (let x = 7; x <= 12; x++) set(x, 12, SKIN_LINE); // upper lip line
    set(7, 13, SKIN_KEEP);
    set(12, 13, SKIN_KEEP);
    for (let x = 8; x <= 11; x++) set(x, 14, SKIN_LINE); // lower lip
    set(9, 17, SKIN_LINE); // a chin mark: too narrow to be a mouth
    const box = protectMouth(mask, w, { x0: 0, y0: 0, x1: w, y1: w });
    expect(box).toEqual({ x0: 7, y0: 12, x1: 12, y1: 14 });
    expect(mask[13 * w + 9]).toBe(SKIN_KEEP); // between the lip lines
    expect(mask[12 * w + 6]).toBe(SKIN_SOFT); // the ring
    expect(mask[11 * w + 9]).toBe(SKIN_SOFT);
    expect(mask[9 * w + 9]).toBe(SKIN_LINE); // nostrils untouched
    expect(mask[17 * w + 9]).toBe(SKIN_LINE);
    expect(protectMouth(new Uint8Array(w * w).fill(SKIN_TONED), w, { x0: 0, y0: 0, x1: w, y1: w })).toBeNull();
  });
});

function uberModel(): THREE.Group {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  geometry.setAttribute("uv1", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0], 2));
  const map = new THREE.Texture();
  map.offset.set(0.01, 0.01);
  map.repeat.set(0.3, 0.3);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map }));
  mesh.userData["parts"] = { Chest: 0, Legs: 1 };
  mesh.userData["tiles"] = { "vanguard.png": [0.01, 0.01, 0.3], "ranger.png": [0.34, 0.01, 0.3] };
  const root = new THREE.Group();
  root.add(mesh);
  return root;
}

describe("appearance on non-instanced models", () => {
  it("shares ONE material across every character; the look rides on the mesh", () => {
    const model = uberModel();
    const a = model.clone(true);
    const b = model.clone(true);
    const lookA = applyModelAppearance(a, { groups: [{ parts: ["Chest"], texture: "vanguard.png" }, { parts: ["Legs"], texture: "ranger.png" }] });
    applyModelAppearance(b, { groups: [{ parts: ["Chest", "Legs"], texture: "ranger.png" }], skinTint: "#482c20" });
    const meshA = a.children[0] as THREE.Mesh;
    const meshB = b.children[0] as THREE.Mesh;
    expect(lookA.meshes).toBe(1);
    expect(meshA.material).toBe(meshB.material);
    expect((meshA.material as THREE.Material).userData["isAppearanceMaterial"]).toBe(true);
    const dataA = meshA.userData[APPEARANCE_DATA] as Float32Array;
    const dataB = meshB.userData[APPEARANCE_DATA] as Float32Array;
    expect([partTileCode(dataA, 0), partTileCode(dataA, 1)]).toEqual([1, 2]);
    expect([partTileCode(dataB, 0), partTileCode(dataB, 1)]).toEqual([2, 2]);
    expect(dataB[15]).toBe(1);
    // re-dressing never stacks materials
    applyModelAppearance(a, { groups: [] });
    expect(meshA.material).toBe(meshB.material);
  });
});

describe("appearance on instanced batches", () => {
  it("adds ONE interleaved per-instance buffer carrying the 16 floats", () => {
    const base = new THREE.BufferGeometry();
    base.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const props = new InstancedProps(base, new THREE.MeshStandardNodeMaterial(), 4);
    props.enableAppearance();
    const attrs = INSTANCE_APPEARANCE_ATTRIBUTES.map((n) => props.geometry.getAttribute(n) as unknown as THREE.InterleavedBufferAttribute);
    expect(new Set(attrs.map((a) => a.data)).size).toBe(1);
    const data = new Float32Array(APPEARANCE_FLOATS).map((_, i) => i + 1);
    props.setAppearanceAt(2, data);
    expect(Array.from((attrs[0]!.data.array as Float32Array).slice(32, 48))).toEqual(Array.from(data));
    expect(attrs[3]!.getX(2)).toBe(13);
  });
});
