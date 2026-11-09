import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { PropSheets, SHEET_RECT_ATTRIBUTE, SHEET_TINT_ATTRIBUTE, sheetPageOf } from "../src/prop-sheet.js";
import { batchStaticMeshes, STATIC_BATCH_FLAG } from "../src/static-batch.js";

const drawn: unknown[][] = [];
const fakeCanvas = (width: number, height: number) => ({
  width, height,
  getContext: () => ({ drawImage: (...a: unknown[]) => void drawn.push(a), save() {}, restore() {}, translate() {}, scale() {} }),
});
function page(w: number, h: number, flipY = false): THREE.Texture {
  const t = new THREE.Texture({ width: w, height: h, isSheetTestImage: true } as never);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = flipY;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const matte = (map: THREE.Texture) => new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
function prop(material: THREE.Material, id: string, x: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  mesh.position.x = x;
  mesh.userData["entityId"] = id;
  mesh.userData[STATIC_BATCH_FLAG] = true;
  return mesh;
}

describe("prop sheets (runtime prop atlas)", () => {
  it("accepts a plain matte page and refuses what the sheet cannot reproduce", () => {
    expect(sheetPageOf(matte(page(512, 512)))).not.toBeNull();
    expect(sheetPageOf(new THREE.MeshStandardMaterial({ map: page(64, 64), roughness: 0.3 }))).toBeNull(); // glossy
    expect(sheetPageOf(new THREE.MeshStandardMaterial({ map: page(64, 64), roughness: 1, color: 0xff0000 }))).not.toBeNull(); // tint rides per vertex
    expect(sheetPageOf(new THREE.MeshStandardMaterial({ map: page(64, 64), roughness: 1, transparent: true }))).toBeNull(); // glass
    expect(sheetPageOf(new THREE.MeshStandardMaterial({ map: page(64, 64), roughness: 1, emissive: 0xffffff }))).toBeNull(); // glow
    expect(sheetPageOf(new THREE.MeshStandardMaterial({ map: page(64, 64), roughness: 1, normalMap: page(64, 64) }))).toBeNull();
    expect(sheetPageOf(new THREE.MeshStandardMaterial({ roughness: 1 }))).toBeNull(); // no page
  });

  it("merges props painted on different pages into one draw, each vertex carrying its page's rect", () => {
    drawn.length = 0;
    const sheets = new PropSheets({ size: 2048, gutter: 8, createCanvas: fakeCanvas });
    const scene = new THREE.Scene();
    const crate = matte(page(1024, 1024)), barrel = matte(page(512, 512, true));
    barrel.color.setRGB(0.5, 0.25, 1);
    scene.add(prop(crate, "crate", 0), prop(barrel, "barrel", 4));
    scene.updateMatrixWorld(true);
    const batch = batchStaticMeshes(scene, { sheets })!;
    expect(batch.stats.batches).toBe(1);
    expect(batch.stats.merged).toBe(2);
    expect(sheets.stats).toMatchObject({ sheets: 1, pages: 2 });
    const merged = batch.group.children[0] as THREE.Mesh;
    expect(merged.material).not.toBe(crate);
    const rect = merged.geometry.getAttribute(SHEET_RECT_ATTRIBUTE);
    const first = [rect.getX(0), rect.getY(0), rect.getZ(0), rect.getW(0)];
    const last = [rect.getX(rect.count - 1), rect.getY(rect.count - 1), rect.getZ(rect.count - 1), rect.getW(rect.count - 1)];
    expect(first).toEqual([8, 8, 1024, 1024]);
    expect(last).toEqual([1024 + 24, 8, 512, 512]);
    const tint = merged.geometry.getAttribute(SHEET_TINT_ATTRIBUTE);
    expect([tint.getX(0), tint.getY(0), tint.getZ(0)]).toEqual([1, 1, 1]);
    expect([tint.getX(tint.count - 1), tint.getY(tint.count - 1), tint.getZ(tint.count - 1)]).toEqual([0.5, 0.25, 1]);
    batch.dispose();
    // the sources keep their own materials
    expect((scene.children[0] as THREE.Mesh).material).toBe(crate);
  });

  it("refuses a page that cannot fit and stops at maxSheets", () => {
    const sheets = new PropSheets({ size: 1024, gutter: 8, maxSheets: 1, createCanvas: fakeCanvas });
    expect(sheets.placementFor(matte(page(1024, 1024)))).toBeNull(); // no room for its gutter
    expect(sheets.placementFor(matte(page(1000, 1000)))).not.toBeNull();
    expect(sheets.placementFor(matte(page(512, 512)))).toBeNull(); // the one sheet is full
    expect(sheets.stats.refused).toBe(2);
  });

  it("shares one texture across looks and grows it only as far as its pages need", () => {
    const sheets = new PropSheets({ size: 4096, gutter: 8, createCanvas: fakeCanvas });
    const front = matte(page(512, 512));
    const cutout = matte(page(512, 512));
    cutout.alphaTest = 0.5;
    const a = sheets.placementFor(front)!, b = sheets.placementFor(cutout)!;
    expect(a.material).not.toBe(b.material); // a look is a material...
    expect(sheets.stats.sheets).toBe(1); // ...not a texture
    expect(sheets.usage().sheets[0]).toMatchObject({ width: 4096, height: 1024, materials: 2 });
    const before = (a.material as THREE.MeshStandardNodeMaterial).map;
    // fill the first shelf, then force a taller sheet: rects keep their texels, every material follows the new texture
    for (let i = 0; i < 5; i++) sheets.placementFor(matte(page(512, 512)));
    const c = sheets.placementFor(matte(page(1024, 1024)))!;
    expect(c.rect[1]).toBeGreaterThan(500);
    expect(sheets.usage().sheets[0]!.height).toBe(2048);
    expect(a.rect).toEqual([8, 8, 512, 512]);
    expect((a.material as THREE.MeshStandardNodeMaterial).map).not.toBe(before);
    expect((a.material as THREE.MeshStandardNodeMaterial).map).toBe((b.material as THREE.MeshStandardNodeMaterial).map);
  });

  it("marks a clamp-to-edge page with a negative width", () => {
    const sheets = new PropSheets({ createCanvas: fakeCanvas });
    const p = page(256, 256);
    p.wrapS = p.wrapT = THREE.ClampToEdgeWrapping;
    expect(sheets.placementFor(matte(p))!.rect[2]).toBeLessThan(0);
  });
});
