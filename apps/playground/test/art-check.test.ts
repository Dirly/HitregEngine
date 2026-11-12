// art-check rules (tools/_art-check.mts) and the world-projected texel density props measure now counts (QA-C art audit).
import { test } from "node:test";
import { artGroundReference, uvFootprintDetailScale, contrastFindings, groundBandFree } from "../tools/_art-check.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artFaults, artTarget, detailScale, artThresholdsSchema, passageGroundSamples, builtOpPieces, isPortalVeil, isRhythm, mergeJobEntities, unburiedTris, uvRepeatsByMaterial, uvFootprintMean, uvStretchByMaterial, unmeasuredAreas, landmarkTriplanarScale, lstarOf, materialLstar, nearPropInstances, ownedEntityIds, specUnits, textureStats, type ArtInput, type ArtPiece, type ArtMaterial, type FormNode } from "../tools/_art-check.mts";
import { projectedTexels, texelDensity, type PropGeometry, type Tri } from "../tools/_prop-geometry.mts";

const mat = (o: Partial<ArtMaterial> & { id: string }): ArtMaterial => ({ area: 100, texels: 40, projected: false, natural: false, lstar: 35, colours: 64, px: [128, 128], course: null, ...o });
const base = (o: Partial<ArtInput> = {}): ArtInput => ({
  tier: "medium", culture: "human", groundL: 34, terrain: { p: { texels: 32, steep: 25.6, lstar: 34 } }, props: { p: 40 },
  pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "a" }), mat({ id: "b" })] }], openings: [], dungeon: null, portals: [], doors: [], forms: {}, ...o,
});
// Preserve coverage of the legacy numeric gate as an explicit opt-in. Architectural policy has its own regressions.
const legacyThresholds = artThresholdsSchema.parse({ variety: { mode: "counts" } });
const rules = (inp: ArtInput) => artFaults(inp, legacyThresholds).map((f) => `${f.rule}:${f.what}`);

test("a clean place passes; every threshold has a default and a description", () => {
  assert.deepEqual(artFaults(base()), []);
  const t = artThresholdsSchema.parse({});
  assert.equal(t.texel.naturalRatio[1], 1.6);
  assert.equal(t.value.maxDelta, 12);
  for (const [k, s] of Object.entries(artThresholdsSchema.shape)) for (const [kk, f] of Object.entries((s as any).unwrap?.().shape ?? (s as any)._zod?.def?.innerType?.shape ?? {}))
    assert.ok((f as { description?: string }).description, `${k}.${kk} has a description`);
});

test("texel: triplanar rock at 4.5 m/repeat beside a 20 m terrain cliff fails; at the surface's own uvScale it passes", () => {
  const px = 512;
  const bad = base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "rock", natural: true, projected: true, texels: px / 4.5 }), mat({ id: "a" }), mat({ id: "b" })] }] });
  assert.deepEqual(rules(bad), ["texel:rock"]);
  const good = base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "rock", natural: true, projected: true, texels: px / landmarkTriplanarScale({ uvScale: 20 }) }), mat({ id: "a" }), mat({ id: "b" })] }] });
  assert.deepEqual(rules(good), []);
  assert.equal(landmarkTriplanarScale({ uvScale: 20 }, "6"), 6);
  assert.equal(landmarkTriplanarScale(undefined), 4.5);
  // built surfaces: the town standard, and the props around them
  assert.deepEqual(rules(base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "a", texels: 57 }), mat({ id: "b" })] }] })), ["texel:a"]);
  assert.deepEqual(rules(base({ props: { p: 20 }, pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "a", texels: 40 }), mat({ id: "b" })] }] })).filter((r) => r.startsWith("texel")), ["texel:a", "texel:b"]);
});

test("value: near-black leaves and a white quarry fail against the ground band; a lifted dark mask passes", () => {
  const inp = base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "leaf", lstar: 2.2 }), mat({ id: "quarry", lstar: 62 }), mat({ id: "ok", lstar: 40 })] }] });
  assert.deepEqual(rules(inp), ["value:leaf", "value:quarry"]);
  // the material maths: a dark grain mask x a dark tint is black; a light tint + emissive lift (proving boat-tar) is not
  const grain = { width: 2, height: 2, mean: [0.04, 0.035, 0.03] as [number, number, number], colours: 14, periodPx: null, periodicity: 0 };
  assert.ok(materialLstar({ color: "#5a4c40" }, grain, null) < 15);
  assert.ok(materialLstar({ color: "#94806a", emissive: "#6a5a48", emissiveIntensity: 0.75 }, grain, grain) > materialLstar({ color: "#5a4c40" }, grain, null) + 5);
  assert.equal(Math.round(lstarOf(0.18)), 49);
});

test("variety: one tile over a whole place, a recoloured mask, too few materials for the tier", () => {
  const one = base({ tier: "large", pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "quarry", area: 16500, colours: 20 })] }] });
  assert.deepEqual(rules(one), ["variety:distinct materials", "variety:quarry", "variety:quarry"]);
  // house role tiles are low-colour by design: never a recoloured mask
  const house = base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "stone", colours: 23, map: "town-roles/brinehold/LargeStone.png" }), mat({ id: "b" })] }] });
  assert.deepEqual(rules(house), []);
  // trims repeat by nature: a small rope tile repeated 300 times is fine
  assert.deepEqual(rules(base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "rope", area: 400, px: [64, 32] }), mat({ id: "b" })] }] })), []);
});

test("variety counts area per PICTURE: several material ids over one texture are one tile; distinct pictures split it", () => {
  // four tints of one Stone.png at 950 m2 each: no id passes 2500, the picture covers 3,800 m2
  const tints = ["coping", "old", "rubble", "slate"].map((id) => mat({ id, area: 950, map: "town-roles/brinehold/Stone.png", mapHash: "aa11" }));
  const one = base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: tints }, { id: "q", kind: "landmark", at: [0, 0], materials: [mat({ id: "b" })] }] });
  assert.deepEqual(rules(one), ["variety:coping+old+rubble+slate"]);
  assert.match(artFaults(one, legacyThresholds)[0]!.detail, /picture \(town-roles\/brinehold\/Stone\.png\) under 4 material ids over 3800 m2/);
  // the same file copied under another path is still one picture (same hash)
  const copied = base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "x", area: 1500, map: "a/Stone.png", mapHash: "aa11" }), mat({ id: "y", area: 1500, map: "b/copy.png", mapHash: "aa11" }), mat({ id: "b" })] }] });
  assert.deepEqual(rules(copied), ["variety:x+y"]);
  // the same areas over four distinct pictures pass, and count as four distinct materials
  const four = base({ tier: "large", pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: tints.map((m, k) => ({ ...m, map: `weep/face-${k}.png`, mapHash: `h${k}` })) }] });
  assert.deepEqual(rules(four), []);
  // and two ids over one picture count once toward the distinct-materials need
  assert.deepEqual(rules(base({ tier: "large", pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [...tints.slice(0, 3), mat({ id: "z", map: "town-roles/brinehold/Stone.png", mapHash: "aa11" })] }] })), ["variety:distinct materials", "variety:coping+old+rubble+z"]);
});

test("portal: a deep opening needs a portal with a veil and a travel target, or a sealed declaration (and then no cut)", () => {
  const opening = { landmark: "door", name: "wicket", at: [10, 10] as [number, number], width: 3.2, depth: 3 };
  assert.deepEqual(rules(base({ openings: [opening] })), ["portal:door/wicket"]);
  assert.deepEqual(rules(base({ openings: [opening], portals: [{ id: "pt", at: [12, 9], scene: "ironspur-hall", veil: true }] })), []);
  assert.match(artFaults(base({ openings: [opening], portals: [{ id: "pt", at: [12, 9], scene: null, veil: true }] }))[0]!.detail, /no travel target/);
  assert.match(artFaults(base({ openings: [opening], doors: [{ name: "door/wicket", sealed: true }] }))[0]!.detail, /declared sealed but an opening is cut/);
  // the zone brief's dungeon door: zero portals is a fault, a sealed declaration is not
  const dungeon = { name: "The Ironspur Hall", at: [0, 0] as [number, number] };
  assert.deepEqual(rules(base({ dungeon })), ["portal:dungeon"]);
  assert.deepEqual(rules(base({ dungeon, doors: [{ name: "dungeon", sealed: true, why: "no dungeon yet" }] })), []);
  assert.deepEqual(rules(base({ dungeon, portals: [{ id: "pt", at: [20, 0], scene: "hall", veil: true }] })), []);
});

const box = (name: string, x: number, o: Partial<FormNode> = {}): FormNode => ({ name, role: "quarry", natural: false, op: "add", shape: "box", dims: [10, 30, 30], min: [x - 5, 0, -15], max: [x + 5, 30, 15], bevel: 0, area: 2 * (300 + 300 + 900), ...o });
test("form: butted raw-box chains, an all-raw-box landmark, copies — bevels and rhythms pass", () => {
  const chain = Array.from({ length: 7 }, (_, i) => box(`panel-${i}`, i * 10));
  assert.deepEqual(rules(base({ forms: { shelf: chain } })), ["form:7 butted boxes", "form:unbevelled boxes"]);
  assert.deepEqual(rules(base({ forms: { shelf: chain.map((b) => ({ ...b, bevel: 0.2 })) } })), []);
  // copies: four near-identical hull slabs fail, seven evenly spaced vault ribs are a rhythm
  const hull = (n: number, h: number, x: number, z: number) => ({ name: `hull-${n}`, shape: "extrude", role: "hull", h: 1.6, polygon: [[-2.5, 0], [2.5, 0], [2.5, h], [0, h + 5], [-2.5, h]], at: [x, 0, z] });
  const sizeOf = (p: Record<string, unknown>) => [5, 1.6, (p.polygon as number[][])[3]![1]!];
  const hulls = specUnits([hull(1, 14, -10, 6), hull(2, 15.7, 10, 6), hull(3, 10, -16, 4), hull(4, 14, 16, 1)], sizeOf);
  assert.deepEqual(rules(base({ forms: { weir: [] }, units: { weir: hulls } })), ["form:1 repeated set(s)"]);
  const ribs = specUnits(Array.from({ length: 7 }, (_, i) => ({ name: `rib-${i}`, shape: "arch", role: "timber", span: 12, rise: 6, at: [0, 0, i * 3.5] })), () => [13, 13, 1]);
  assert.equal(isRhythm(ribs, 0.15), true);
  assert.deepEqual(rules(base({ forms: { warren: [] }, units: { warren: ribs } })), []);
});

test("scale: 80 cm courses on giant work fail, the same tile on human work passes; bales are not stone", () => {
  const q = mat({ id: "ironspur/quarry-face", course: 0.82 });
  assert.deepEqual(rules(base({ culture: "giant", pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [q, mat({ id: "b" })] }] })), ["scale:ironspur/quarry-face"]);
  assert.deepEqual(rules(base({ culture: "human", pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [q, mat({ id: "b" })] }] })), []);
  assert.deepEqual(rules(base({ culture: "human", pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "gullet/bale", course: 1.6 }), mat({ id: "b" })] }] })), []);
  // the course is measured: horizontal mortar lines every 32 px of a 128 px tile
  const w = 16, h = 128, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = y % 32 < 3 ? 40 : 170; data.set([v, v, v, 255], (y * w + x) * 4); }
  const st = textureStats({ width: w, height: h, data });
  assert.equal(st.periodPx, 32);
  assert.ok(st.periodicity > 0.9);
  // two huge smooth blocks (a light and a dark half, softly shaded): neighbouring rows look alike, which is no 3 px course
  const big = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.round(110 + 50 * Math.sin((2 * Math.PI * y) / h) + ((y * 7) % 5)); big.set([v, v, v, 255], (y * w + x) * 4); }
  const sb = textureStats({ width: w, height: h, data: big });
  assert.ok(sb.periodPx == null || sb.periodPx >= 40, `smooth blocks read as ${sb.periodPx} px courses`);
});

test("props measure counts triplanar and splat surfaces at their own scale (no longer 84% skipped)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-tex-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(path.join(assets, "materials"), { recursive: true }); fs.mkdirSync(path.join(assets, "textures"), { recursive: true });
  const png = Buffer.alloc(32); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(512, 16); png.writeUInt32BE(512, 20);
  fs.writeFileSync(path.join(assets, "textures", "cliff.png"), png);
  fs.writeFileSync(path.join(assets, "materials", "rock.json"), JSON.stringify({ map: "cliff.png", triplanar: true, triplanarScale: 4.5 }));
  fs.writeFileSync(path.join(assets, "materials", "splat.json"), JSON.stringify({ shader: "terrain-splat", splat: { layers: [{ map: "cliff.png", uvScale: 20 }, { map: "cliff.png", uvScale: 4 }] } }));
  const quad = (x: number, material: string, extra: Partial<Tri> = {}): Tri[] => [
    { a: [x, 0, 0], b: [x + 10, 0, 0], c: [x + 10, 10, 0], material, ...extra }, { a: [x, 0, 0], b: [x + 10, 10, 0], c: [x, 10, 0], material, ...extra }];
  const geo: PropGeometry = { tris: [...quad(0, "rock"), ...quad(20, "splat", { splat: 0 }), ...quad(40, "splat", { splat: 1 })], min: [0, 0, 0], max: [50, 10, 0], effects: [], lights: 0, nested: [], warnings: [] } as PropGeometry;
  const d = texelDensity(geo, { projected: projectedTexels(assets) });
  assert.equal(d.texturedArea, 300);
  assert.equal(d.projectedArea, 300);
  assert.ok(Math.abs(d.byMaterial!["rock"]!.median - 512 / 4.5) < 1e-6);
  assert.ok([512 / 20, 512 / 4].some((v) => Math.abs(d.byMaterial!["splat"]!.median - v) < 1e-6)); // each triangle at its own layer
  assert.ok(Math.abs(d.byMaterial!["splat"]!.area - 200) < 1e-6);
  // without the hook those triangles were not textured at all
  assert.equal(texelDensity(geo).texturedArea, 0);
});

test("measure: nothing measured is a fault, never an ok (art-check passed 11 POIs over 0 pieces)", () => {
  assert.deepEqual(rules(base({ pieces: [] })), ["measure:nothing measured"]);
  // a landmark the recipe never baked (no materials) measures nothing either
  assert.deepEqual(rules(base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [] }] })), ["measure:nothing measured"]);
  assert.ok(artFaults(base({ pieces: [] }))[0]!.detail.includes("poi:<id>"));
});

test("owned scene structures are judged as built work; catalogued props skip the built texel target", () => {
  const built = base({ pieces: [{ id: "lamp-merged", kind: "mesh", at: [0, 0], materials: [mat({ id: "tarred", texels: 57 }), mat({ id: "b" })] }], terrain: { "lamp-merged": { texels: 32, steep: null, lstar: 34 } }, props: {} });
  assert.deepEqual(rules(built), ["texel:tarred"]);
  const prop = base({ pieces: [{ id: "prop:x", kind: "prop", at: [0, 0], materials: [mat({ id: "lantern", texels: 57 })] }], terrain: { "prop:x": { texels: 32, steep: null, lstar: 34 } }, props: {} });
  assert.deepEqual(rules(prop), []);
  // ...but a prop is still held to the value band
  assert.deepEqual(rules({ ...prop, pieces: [{ ...prop.pieces[0]!, materials: [mat({ id: "lantern", lstar: 5 })] }] }), ["value:lantern"]);
  // owned meshes count toward variety: one built material on a large place fails
  assert.deepEqual(rules(base({ tier: "large", pieces: [{ id: "m", kind: "mesh", at: [0, 0], materials: [mat({ id: "timber" })] }], terrain: { m: { texels: 32, steep: null, lstar: 34 } }, props: {} })), ["variety:distinct materials"]);
});

test("ownedEntityIds: job ops, poi:<id> tags and every descendant (untagged children included)", () => {
  const ents = {
    root: { parent: null, tags: ["poi", "poi:crone-beads"] }, child: { parent: "root" }, grand: { parent: "child", tags: [] },
    dressing: { parent: null, tags: ["dressing", "poi:crone-beads"] }, other: { parent: null, tags: ["poi:elsewhere"] }, otherKid: { parent: "other" },
    jobOnly: { parent: null }, jobKid: { parent: "jobOnly" },
  };
  assert.deepEqual([...ownedEntityIds(ents, "crone-beads", ["jobOnly"])].sort(), ["child", "dressing", "grand", "jobKid", "jobOnly", "root"]);
  assert.equal(ownedEntityIds(ents, "nobody").size, 0);
});

test("measure: an owned mesh naming a material the project closure lacks is a fault", () => {
  const inp = base({ pieces: [{ id: "pier", kind: "mesh", at: [0, 0], materials: [mat({ id: "hagsheer-weep/ashlar", missing: true, texels: NaN, lstar: null }), mat({ id: "a" }), mat({ id: "b" })] }], terrain: { pier: { texels: 32, steep: null, lstar: 34 } }, props: {} });
  assert.deepEqual(rules(inp), ["measure:hagsheer-weep/ashlar"]);
});

test("builtOpPieces: wall ops (retaining, ramp) are built pieces like landmarks; paints are not; at from op, bake or points", () => {
  const lms = [{ id: "op:qw:landmark", prefab: "landmarks/qw-1", position: [50, 0, -10], radius: 60 }];
  const b = builtOpPieces([
    { id: "shelf", op: "landmark", at: [1, 2] },
    { id: "qw", op: "wall", variant: "retaining", points: [[0, 0], [100, 0]] },
    { id: "ramp", op: "wall", variant: "ramp", points: [[0, 0], [10, 20]] },
    { id: "dust", op: "paint", polygon: [[0, 0], [1, 0], [1, 1]] },
    { id: "qw", polygon: [[0, 0], [1, 0], [1, 1]], owner: "x" }, // a clearing named like its operator is not a piece
  ], lms);
  assert.deepEqual(b.map((x) => [x.op.id, x.at, x.piece?.prefab ?? null]), [["shelf", [1, 2], null], ["qw", [50, -10], "landmarks/qw-1"], ["ramp", [5, 10], null]]);
});

test("artTarget: the job's own project world by default, the preview lab when named", () => {
  const job = "D:/x/apps/playground/projects/fixture-world/authoring/zonegen/fixture-world/zones/east/pois/ironspur-delf";
  assert.deepEqual(artTarget(job), { project: "fixture-world", world: "fixture-world" });
  assert.deepEqual(artTarget(job, { project: "ispur-lab", world: "ispurlab" }), { project: "ispur-lab", world: "ispurlab" });
  assert.deepEqual(artTarget(job.replaceAll("/", "\\")), { project: "fixture-world", world: "fixture-world" }, "a resolved Windows path");
  assert.throws(() => artTarget("D:/x/somewhere"));
});

test("isPortalVeil: <portal>-veil beside a portal script is the veil; a plain -veil mesh is not", () => {
  const ents = { door: { components: { script: { name: "portal" } } }, "door-veil": { components: { mesh: {} } }, "bride-veil": { components: { mesh: {} } } };
  assert.equal(isPortalVeil("door-veil", ents), true);
  assert.equal(isPortalVeil("bride-veil", ents), false);
  assert.equal(isPortalVeil("door", ents), false);
});

test("mergeJobEntities: an installed job's scene copy wins, so a portal script added after install still marks its veil", () => {
  const scene = { door: { components: { portalAnchor: {}, script: { name: "portal" } } }, "door-veil": { components: { mesh: {} } } };
  const job = { door: { components: { portalAnchor: {} } } };
  assert.equal(isPortalVeil("door-veil", mergeJobEntities(scene, job, true)), true);
  assert.equal(isPortalVeil("door-veil", mergeJobEntities(scene, job, false)), false, "a not-yet-installed job reads its own ops");
  assert.ok(mergeJobEntities({}, job, true).door, "a job entity the scene lacks is kept");
});

test("variety: a catalogued prop's own atlas is judged by its UV repeats, not by the tiled-area limit", () => {
  // one non-repeating atlas over a 25,000 m2 hero prop: 1 repeat, passes; a tiled wall material of the same area fails
  const atlasTris = [
    { a: [0, 0, 0], uv: [[0, 0], [1, 0], [1, 1]] as [number, number][], material: "door.gltf#image0" },
    { a: [0, 0, 0], uv: [[0, 0], [1, 1], [0, 1]] as [number, number][], material: "door.gltf#image0" },
    { a: [0, 0, 0], uv: [[0, 0], [8, 0], [8, 8]] as [number, number][], material: "tiled", tex: { key: "t", repeat: [2, 2] as [number, number] } },
    { a: [0, 0, 0], material: "flat" },
  ];
  const rep = uvRepeatsByMaterial(atlasTris);
  assert.equal(rep["door.gltf#image0"], 1);
  assert.equal(rep.tiled, 128); // 32 UV units x the material's own 2 x 2 repeat
  assert.equal(rep.flat, undefined);
  const door = mat({ id: "door.gltf#image0", area: 25765, uvRepeats: 1 });
  const piece = (m: ArtMaterial) => base({ pieces: [{ id: "p", kind: "mesh", at: [0, 0], materials: [m, mat({ id: "a" }), mat({ id: "b" })] }] });
  assert.deepEqual(rules(piece(door)), []);
  assert.deepEqual(rules(piece({ ...door, uvRepeats: undefined })), ["variety:door.gltf#image0"]);
  assert.deepEqual(rules(piece({ ...door, uvRepeats: 400 })), ["variety:door.gltf#image0"]);
});

test("a landmark's props around it never include the job's own instances (its lanterns are part of it)", () => {
  const pos: Record<string, number[]> = { lantern: [2, 5, 1], crate: [3, 0, -2], far: [60, 0, 0] };
  const inst: [string, string][] = [["lantern", "town-lights/hanging-lantern-lit"], ["crate", "crates/a"], ["far", "crates/b"]];
  const ids = (owned: string[]) => nearPropInstances(inst, new Set(owned), [0, 0], 20, (id) => pos[id]!).map(([id]) => id);
  assert.deepEqual(ids([]), ["lantern", "crate"]);
  assert.deepEqual(ids(["lantern"]), ["crate"]); // the stair's own lantern was a 0.35x texel fault against itself
  assert.deepEqual(nearPropInstances(inst, new Set(), [0, 0], 70, (id) => pos[id]!).length, 3);
});

test("a landmark's buried faces are not measured: only triangles above the ground count (visibleTris)", async () => {
  const { visibleTris } = await import("../tools/_art-check.mts");
  // a 10 m wall face from y -6 to +4 at the origin, as two quads (4 tris), ground at y 0 (placed at y 0)
  const quad = (y0: number, y1: number): Tri[] => [
    { a: [0, y0, 0], b: [10, y0, 0], c: [10, y1, 0], material: "ashlar" },
    { a: [0, y0, 0], b: [10, y1, 0], c: [0, y1, 0], material: "ashlar" },
  ];
  const tris = [...quad(-6, 0), ...quad(0, 4)];
  const vis = visibleTris(tris, [0, 0, 0], () => 0);
  assert.equal(vis.length, 2);
  const area = (t: Tri[]) => t.reduce((s, q) => { const u = [0, 1, 2].map((k) => q.b[k]! - q.a[k]!), v = [0, 1, 2].map((k) => q.c[k]! - q.a[k]!); return s + Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2; }, 0);
  assert.equal(Math.round(area(tris)), 100);
  assert.equal(Math.round(area(vis)), 40); // the 60 m2 band buried in the bank is not seen (the upper stair's 4578 m2 counted it)
  // the origin offsets the piece: the same wall placed 10 m up is all above a ground at y 0
  assert.equal(visibleTris(tris, [0, 10, 0], () => 0).length, 4);
  // ground rising under the right half (x > 5 at y 3) buries the upper quad's lower-right triangle too
  assert.equal(visibleTris(tris, [0, 0, 0], (x) => (x > 5 ? 3 : 0)).length, 1);
});

test("unburiedTris: faces buried inside another solid of the same bake are not seen (a tread in the next tread, a block's base on another)", () => {
  // closed outward box [x0,x1]x[y0,y1]x[z0,z1] as 12 triangles
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    const v = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    const q = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]; // outward CCW quads
    return q.flatMap(([a, b, c, d]) => [{ a: v(a!), b: v(b!), c: v(c!) }, { a: v(a!), b: v(c!), c: v(d!) }]);
  };
  const area = (ts: { a: number[]; b: number[]; c: number[] }[]) => ts.reduce((s, t) => { const u = t.b.map((x, k) => x - t.a[k]!), w = t.c.map((x, k) => x - t.a[k]!); return s + Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2; }, 0);
  const one = box(0, 4, 0, 2, 0, 4);
  assert.ok(Math.abs(area(unburiedTris(one, one)) - area(one)) < 1e-6, "a lone box is all seen");
  // two boxes overlapping by 1 m in x: each loses the part of its faces inside the other
  const a = box(0, 4, 0, 2, 0, 4), b = box(3, 7, 0, 2, 0, 4), all = [...a, ...b];
  const seen = area(unburiedTris(all, all));
  // (the two inner end faces, 8 m2 each, are buried; the coplanar strips of the overlap stay: one plane, zfight's business)
  assert.ok(Math.abs(seen - (128 - 16)) < 0.5, `overlap seen ${seen.toFixed(1)} (expected 112)`);
  // a block standing on another: the shared plane is hidden from both (opposite faces) only where covered
  const c = box(0, 4, 2, 4, 0, 4);
  const stack = [...a, ...c];
  assert.ok(area(unburiedTris(stack, stack)) < area(stack) - 31, "the two 16 m2 faces on the joint are buried");
});

test("passageGroundSamples: a roofed carve keeps its walls and ceiling, an open cut drops the points in the air over the lip", () => {
  const box = { start: [0, 100, 0], axis: "x", direction: 1, length: 10, width: 6, height: 8 };
  // roofed: the ground's top is 30 m over the floor
  const roofed = passageGroundSamples(box, () => 130);
  assert.equal(roofed.length, 3);
  assert.deepEqual(roofed.map((p) => p.ny), [0, 0, -1]);
  assert.equal(roofed[2]!.y, 108);
  // open: the cut runs up through a surface at 105 (the walls' mid height 104 is rock, the ceiling at 108 is sky)
  const open = passageGroundSamples(box, () => 105);
  assert.deepEqual(open.map((p) => p.ny), [0, 0]);
  // entirely over the ground (a carve's box standing above the lip): nothing
  assert.equal(passageGroundSamples(box, () => 99).length, 0);
});

// FIX-HAG8: the job's OWN terrain (patch tops, passage walls) is judged against the built work beside it AS SEEN
const noise = (w: number, cell: number, seed = 7) => { // w x w RGBA of random grey marks `cell` px wide
  const d = new Uint8Array(w * w * 4); let h = seed;
  const at = new Map<number, number>();
  const v = (cx: number, cy: number) => { const k = cy * 4096 + cx; if (!at.has(k)) { h = (h * 1103515245 + 12345) & 0x7fffffff; at.set(k, 40 + (h % 160)); } return at.get(k)!; };
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) { const g = v(Math.floor(x / cell), Math.floor(y / cell)), i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255; }
  return { width: w, height: w, data: d };
};
test("detailScale: per-pixel noise reads at ~1-2 px; the same marks drawn 4 px wide read at ~4 px (a 512 px tile that looks like 128 px)", () => {
  const fine = detailScale(noise(128, 1)), coarse = detailScale(noise(512, 4));
  assert.ok(fine >= 1 && fine < 2, `fine ${fine}`);
  assert.ok(coarse > 3 && coarse < 8 && coarse > 2.5 * fine, `coarse ${coarse} vs fine ${fine}`);
});
test("UV detail measures used atlas roles without interpreting their different base colours as coarse pixels", () => {
  const atlas = noise(128, 1);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const i = (y * 128 + x) * 4, g = (x < 64 ? 16 : 208) + atlas.data[i]! % 24;
    atlas.data[i] = atlas.data[i + 1] = atlas.data[i + 2] = g;
  }
  const quad = (lo: number, hi: number) => [
    { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], uv: [[lo, 0], [hi, 0], [hi, 1]] as [number, number][] },
    { a: [0, 0, 0], b: [1, 1, 0], c: [0, 1, 0], uv: [[lo, 0], [hi, 1], [lo, 1]] as [number, number][] },
  ];
  assert.equal(detailScale(atlas), 16, "whole-page contrast is dominated by separate atlas roles");
  const fine = uvFootprintDetailScale([...quad(0, .5), ...quad(.5, 1)], atlas)!;
  assert.ok(fine >= 1 && fine < 2, `actual fine detail ${fine}`);
  const coarse = noise(128, 4), coarseScale = uvFootprintDetailScale(quad(0, .5), coarse)!;
  assert.ok(coarseScale > 3 && coarseScale < 8, `coarse paint still reads coarse: ${coarseScale}`);
  assert.equal(uvFootprintDetailScale([{ a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0] }], atlas), null);
  const repeated = uvFootprintDetailScale(quad(-3, 3), coarse)!;
  assert.ok(Math.abs(repeated - detailScale(coarse)) < 1e-9, "repeated whole pictures retain their measured detail");
});
test("ground reference removes authored paint features while retaining inherited uses of the same palette surface", () => {
  const surfaces = [{ name: "dirt" }, { name: "grass" }];
  const recipe = { surfaces, features: { groundPaints: [
    { id: "existing", surface: "dirt" }, { id: "op:yard:paint", surface: "dirt" }, { id: "compiled-cut", surface: "dirt" },
  ], heightPatches: [{ id: "footing" }] } };
  const reference = artGroundReference(recipe, [
    { op: "paint", id: "yard" }, { edit: "add-feature", kind: "groundPaints", feature: { id: "compiled-cut" } },
  ]);
  assert.deepEqual(reference.features.groundPaints, [{ id: "existing", surface: "dirt" }]);
  assert.equal(reference.surfaces, surfaces);
  assert.equal(reference.features.heightPatches, recipe.features.heightPatches);
  assert.equal(recipe.features.groundPaints.length, 3, "input world remains untouched");
  assert.equal(artGroundReference(recipe, []), recipe);
});
test("ground: a stair's rock walls 2-3x coarser (as seen) than the timber lining beside them fail; painted at the town standard they pass", () => {
  const ground = (seen: number, texels = 28.4) => base({ built: { "ground:passages": 21 }, pieces: [
    { id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "a" }), mat({ id: "b" })] },
    { id: "ground:passages", kind: "ground", at: [0, 0], materials: [mat({ id: "surface:cliff", natural: true, projected: true, lstar: null, texels, seen, area: 6000 })] }] });
  assert.deepEqual(rules(ground(7)), ["texel:surface:cliff"]);      // the zone cliff tile: 512 px over 18 m, marks 4 px wide
  assert.deepEqual(rules(ground(10.5)), ["texel:surface:cliff"]);   // 2x coarse
  assert.deepEqual(rules(ground(23.9, 40)), []);                    // cut-stone: 128 px over 3.2 m
  // ground alone (no built work beside it) is not judged and never counts as "measured"
  assert.deepEqual(rules(base({ pieces: [{ id: "ground:x", kind: "ground", at: [0, 0], materials: [mat({ id: "surface:cliff", natural: true, seen: 7 })] }] })), ["measure:nothing measured"]);
});

// r-found 2026-10-31 (coordinator ruling; Derek: built masonry matches the surrounding ROCK): the Sun-ruins kit reads 13.9
// tx/m as seen, every ground surface of the zone ~24, so a raised pad wearing the zone's own paint failed 1.7x beside it
// although the untouched land around it is the same paint. Only the area the JOB painted is judged against the built work.
test("ground: a raised pad wearing the zone's own paint is not judged against the kit; the job's own paint is", () => {
  const pad = (painted: number | undefined) => base({ built: { "ground:pb-x-seat-h6": 14 }, pieces: [
    { id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "a" }), mat({ id: "b" })] },
    { id: "ground:pb-x-seat-h6", kind: "ground", at: [0, 0], materials: [mat({ id: "surface:redstrand-ground", natural: true, projected: true, lstar: null, texels: 40, seen: 24.8, area: 167, ...(painted === undefined ? {} : { painted }) })] }] });
  assert.deepEqual(rules(pad(0)), []);                                       // all the zone's own paint
  assert.deepEqual(rules(pad(167)), ["texel:surface:redstrand-ground"]);     // the job painted it: judged, 1.8x
  assert.deepEqual(rules(pad(undefined)), ["texel:surface:redstrand-ground"]); // a passage wall (no zone-paint split): the whole area
});

test("every part of a bake is measured: a mapped material on UV-less, non-projected triangles is a texel fault (REV-WS2 ledge lips)", () => {
  const tri = (material: string, uv?: [number, number][]) => ({ a: [0, 0, 0], b: [2, 0, 0], c: [0, 2, 0], material, ...(uv ? { uv } : {}) });
  // texelDensity measured only the triplanar rock; the lip role (no UVs, not triplanar) must still come back with its area
  const left = unmeasuredAreas([tri("rock"), tri("lip"), tri("lip")], { rock: {} });
  assert.deepEqual([...left], [["lip", 4]]);
  const lip = (o: Partial<ArtMaterial>) => base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [mat({ id: "a" }), mat({ id: "b" }), mat({ id: "lip", texels: NaN, ...o })] }] });
  assert.deepEqual(rules(lip({ noUv: true })), ["texel:lip"]);
  assert.deepEqual(rules(lip({ noUv: true, area: 0.5 })), []); // under minArea
  assert.deepEqual(rules(lip({ noUv: true, px: null })), []); // a flat colour has no picture to lose
  assert.deepEqual(rules(lip({})), []);
});

test("gate 15: a job's own materials/ (and textures) resolve before the project closure (KS-7 pre-copied them)", async () => {
  const { locate, materialTex, preferJobAssets } = await import("../tools/_prop-geometry.mts");
  const fsm = fs, osm = os, pathm = path;
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "art-job-"));
  const assets = pathm.join(dir, "proj", "assets"), job = pathm.join(dir, "job");
  fsm.mkdirSync(pathm.join(assets, "materials", "z"), { recursive: true });
  fsm.mkdirSync(pathm.join(job, "materials", "z"), { recursive: true });
  fsm.mkdirSync(pathm.join(job, "materials", "textures", "z"), { recursive: true });
  fsm.writeFileSync(pathm.join(assets, "materials", "z", "old.json"), JSON.stringify({ map: "z/old.png" }));
  fsm.writeFileSync(pathm.join(job, "materials", "z", "face.json"), JSON.stringify({ map: "z/face.png" }));
  fsm.writeFileSync(pathm.join(assets, "materials", "z", "shared.json"), JSON.stringify({ map: "z/a.png" }));
  fsm.writeFileSync(pathm.join(job, "materials", "z", "shared.json"), JSON.stringify({ map: "z/face.png" }));
  // a 4x2 PNG header is all imageSize reads
  const png = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.write("IHDR", 12); png.writeUInt32BE(4, 16); png.writeUInt32BE(2, 20);
  fsm.writeFileSync(pathm.join(job, "materials", "textures", "z", "face.png"), png);
  assert.equal(fsm.existsSync(locate(assets, "materials", "z/face.json")), false, "before: the job's material is unknown");
  preferJobAssets(assets, job);
  assert.equal(locate(assets, "materials", "z/face.json"), pathm.join(job, "materials", "z", "face.json"));
  assert.equal(locate(assets, "materials", "z/shared.json"), pathm.join(job, "materials", "z", "shared.json"), "the job's copy wins");
  assert.equal(locate(assets, "materials", "z/old.json"), pathm.join(assets, "materials", "z", "old.json"), "the rest still from the project");
  assert.deepEqual(materialTex(assets, "z/face")?.size, [4, 2], "its texture from the job's materials/textures");
});

test("texel: a stretched coping fails though its median texels/m is on the standard (owner walk kirk-knowe 2026-10-21)", () => {
  // a 1 x 1 m top laid square, and the same top sheared 6:1 (u = s - 6 n: what a ring wall's developed UVs did to its last leg)
  const quad = (uv: (x: number, z: number) => [number, number], material: string) => [
    { a: [0, 0, 0], b: [1, 0, 0], c: [1, 0, 1], uv: [uv(0, 0), uv(1, 0), uv(1, 1)], material },
    { a: [0, 0, 0], b: [1, 0, 1], c: [0, 0, 1], uv: [uv(0, 0), uv(1, 1), uv(0, 1)], material },
  ];
  const st = uvStretchByMaterial([...quad((x, z) => [x / 3.2, z / 3.2], "square"), ...quad((x, z) => [(x - 6 * z) / 3.2, z / 3.2], "sheared")]);
  assert.ok(st.square!.share === 0 && st.square!.worst < 1.01);
  assert.equal(st.sheared!.share, 1);
  assert.ok(st.sheared!.worst > 6);
  // the gate: a built landmark material over 5% stretched is a texel fault; a prop's atlas is not judged
  const cap = mat({ id: "cap", stretch: { share: 0.3, worst: 6.2 } });
  assert.deepEqual(rules(base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [cap, mat({ id: "b" })] }] })), ["texel:cap"]);
  assert.deepEqual(rules(base({ pieces: [{ id: "p", kind: "landmark", at: [0, 0], materials: [{ ...cap, stretch: { share: 0.01, worst: 1.4 } }, mat({ id: "b" })] }] })), []);
  // a non-square picture laid once at its own aspect (a 512 x 128 crown panel on a 4 x 1 m face) is square in TEXELS:
  // judged in UV units it read 4:1 stretched (rustgut-entrance 2026-11-09); with the texture's pixel size it is clean
  const panel = quad((x, z) => [x, z * 4], "panel");
  assert.ok(uvStretchByMaterial(panel).panel!.worst > 3.9);
  const px = uvStretchByMaterial(panel, 1.3, (id) => (id === "panel" ? [512, 128] : undefined)).panel!;
  assert.ok(px.share === 0 && px.worst < 1.01);
});

test("value judges a UV-laid atlas by the texels a piece samples, not the whole page (PLACES-FIX: every poi-props piece read 46.1)", () => {
  // a 2x1 page: left half black, right half white; a quad on the right half samples only white
  const img = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) };
  const quad = (u0: number, u1: number) => [
    { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], uv: [[u0, 0], [u1, 0], [u1, 1]] as [number, number][] },
    { a: [0, 0, 0], b: [1, 1, 0], c: [0, 1, 0], uv: [[u0, 0], [u1, 1], [u0, 1]] as [number, number][] },
  ];
  assert.ok(uvFootprintMean(quad(0.55, 0.95), img)![1] > 0.99);
  assert.ok(uvFootprintMean(quad(0.05, 0.45), img)![1] < 0.01);
  const whole = textureStats(img).mean[1];
  assert.ok(whole > 0.4 && whole < 0.6, String(whole));
  // a transparent texel is not sampled; no UVs -> null
  assert.equal(uvFootprintMean([{ a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0] }], img), null);
});

test("value samples a town-atlas triangle inside its page rectangle, however often its UVs repeat (fort-keep: a part-filled page read as white)", () => {
  // a 2x1 page: left half black (the tile), right half white (blank page); UVs repeat 9 times across the tile
  const img = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) };
  const rect: [number, number, number, number] = [0, 0, 0.5, 1];
  const raw: [number, number][] = [[0, 0], [9, 0], [9, 9]];
  const tri = { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], uv: raw.map(([u, v]): [number, number] => [rect[0] + u * rect[2], rect[1] + v * rect[3]]), atlas: { rect, uv: raw } };
  assert.ok(uvFootprintMean([tri], img, false)![1] < 0.01);
  assert.ok(uvFootprintMean([{ ...tri, atlas: undefined }], img, false)![1] > 0.2);   // the old read: the blank page counted
});

test("value: an accent (palette builtStone.accent) may stand up to accentExtra over the band on <= accentShare of the piece", () => {
  // The Lych Span: pale arch rings at L* 44 over local ground 28.8 (delta 15.2 > maxDelta 12)
  const piece = (ringArea: number) => ({ id: "p", kind: "landmark" as const, at: [0, 0] as [number, number], materials: [mat({ id: "ring", lstar: 44, area: ringArea }), mat({ id: "a", lstar: 33, area: 900 - ringArea }), mat({ id: "b", lstar: 34, area: 100 })] });
  const inp = (ringArea: number, accent: string[] = ["ring"]) => base({ groundL: 28.8, terrain: { p: { texels: 32, steep: 25.6, lstar: 28.8 } }, accent, pieces: [piece(ringArea)] });
  assert.deepEqual(rules(inp(100)), []); // 10 %: an accent passes
  assert.deepEqual(rules(inp(300)), ["value:ring"]); // 30 %: too much of the piece
  assert.match(artFaults(inp(300)).find((f) => f.what === "ring")!.detail, /covers 30% .* <= 15%/);
  assert.deepEqual(rules(inp(100, [])), ["value:ring"]); // not declared an accent: the plain band applies
  // brighter than band + accentExtra (12 + 20) fails even as a small accent
  assert.deepEqual(rules(base({ groundL: 28.8, terrain: { p: { texels: 32, steep: 25.6, lstar: 28.8 } }, accent: ["ring"], pieces: [{ ...piece(100), materials: [mat({ id: "ring", lstar: 62, area: 100 }), mat({ id: "a", lstar: 33, area: 800 }), mat({ id: "b", lstar: 34, area: 100 })] }] })), ["value:ring"]);
});

test("texel: a piece SET INTO a cliff may not be finer than the stone round it; contrast over it is a finding (o-gates 2026-10-30)", () => {
  // the stone round it at 20 tx/m (steep): a 40 tx/m set-in front fails, the same front standing free passes the town standard
  const inp = (setIn: boolean) => base({ terrain: { p: { texels: 20, steep: 20, lstar: 34, steepSd: 7 } }, props: {}, pieces: [{ id: "p", kind: "mesh", at: [0, 0], ...(setIn ? { setIn: true } : {}), materials: [mat({ id: "a", lumaSd: 30 }), mat({ id: "b", lumaSd: 8 })] }] });
  assert.ok(rules(inp(true)).includes("texel:a"));
  assert.ok(!rules(inp(false)).includes("texel:a"));
  const notes = contrastFindings(inp(true), legacyThresholds);
  assert.equal(notes.length, 1); assert.match(notes[0]!, /p a: picture contrast/);
});

test("value band judges rock-matched work only: ships, boats, shelters and loose props stand out on purpose (careening-strand 2026-10-31)", () => {
  // a tarred cutter hauled out on pale sand, a hide tent on the same sand: dark against a light ground, meant to be
  const sand = (id: string, kind: ArtPiece["kind"], lstar: number, bandFree?: boolean) => base({ groundL: 50.7, terrain: { [id]: { texels: 40, steep: null, lstar: 50.7 } }, props: {},
    pieces: [{ id, kind, at: [0, 0], materials: [mat({ id: "hull", lstar }), mat({ id: "b", lstar: 50 })], ...(bandFree ? { bandFree } : {}) }] });
  assert.deepEqual(rules(sand("mesh:seagoing-ships/sailing-cutter-furled", "mesh", 26.1, true)), []);
  assert.deepEqual(rules(sand("mesh:sun-ruins/city-watch-tower-b", "mesh", 26.1)), ["value:hull"]); // masonry is still held to the band
  // the near-black floor still judges every piece, band-free or not
  assert.deepEqual(rules(sand("mesh:seagoing-ships/sailing-cutter-furled", "mesh", 5, true)), ["value:hull"]);
  // who is band-free: by kind, by prefab id (ships, boats, hulls, wrecks), by the catalogue shelter flag
  assert.equal(groundBandFree("prop", "house-furniture/barrel-a", null), true);
  assert.equal(groundBandFree("mesh", "seagoing-ships/sailing-cutter-furled", null), true);
  assert.equal(groundBandFree("mesh", "codex-craft/beached-rowing-boat", null), true);
  assert.equal(groundBandFree("mesh", "seagoing-ships/merchant-barque-wreck-bow", null), true);
  assert.equal(groundBandFree("mesh", "camp-props/tent", { shelter: true }), true);
  assert.equal(groundBandFree("mesh", "sun-ruins/city-watch-tower-b", {}), false);
  assert.equal(groundBandFree("mesh", "ruin-props/broad-pier", null), false);
  assert.equal(groundBandFree("landmark", null, null), false);
  assert.equal(groundBandFree("ground", null, null), false);
});

test("props around a built piece: landmarks, creatures and characters are not props (a lab-spawned player failed a compound's stone 3.4x)", async () => {
  const { NOT_PROPS_RE } = await import("../tools/_art-check.mts");
  for (const id of ["characters/player", "mobs/ghost-knight", "landmarks/red-dial-ring"]) assert.ok(NOT_PROPS_RE.test(id), id);
  for (const id of ["sun-ruins/city-wall", "composite-props/bonfire-logs", "wall-props/banners"]) assert.ok(!NOT_PROPS_RE.test(id), id);
});
