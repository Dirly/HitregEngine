import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  CUBE_FACES, castAll, groundExpected, classifyHole, countedPixels, fieldOpeningFilter, gapBetweenDepths, solidAlong, isSentinel, notMapObjects, pixelRay, rayHitsBox, rimPixels, sentinelClusters, surfaceMeshes, viewBasis,
  type SeeThroughView, type V3,
} from "../src/see-through.js";

/** A size x size RGBA view, grey, with sentinel rectangles [x0, y0, x1, y1] (inclusive). */
function view(size: number, rects: Array<[number, number, number, number]>): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) px.set([60, 60, 60, 255], i * 4);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px.set([255, 0, 255, 255], (y * size + x) * 4);
  return px;
}
const face = (name: string): SeeThroughView => CUBE_FACES.find((f) => f.name === name)!;
const close = (a: V3, b: V3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5));

describe("see-through probe", () => {
  it("hides every character from the sentinel draw and the explaining rays, never the map", () => {
    const scene = new THREE.Scene();
    const box = () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const ent = (id: string, ...kids: THREE.Object3D[]) => { const g = new THREE.Group(); g.userData["entityId"] = id; kids.forEach((k) => g.add(k)); return g; };
    const shell = ent("fkb-crown-shell", box());
    // a rigged mob: skinned body + an unskinned held weapon under the same entity
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const weapon = box();
    const mob = ent("fkb-lich-3", ent("fkb-lich-3:rig", skinned, weapon));
    // a placeholder creature body (no skin) and the player's visual
    const placeholder = box();
    const gravelord = ent("fkb-gravelord-12", ent("fkb-gravelord-12:visual", placeholder));
    const pv = box();
    const player = ent("player", ent("player:player-visual", pv));
    // the moving-instance batch every worn head / held weapon is drawn in (moving-instances.ts)
    const heads = box();
    heads.name = "moving:mmo/human-head.glb#0";
    heads.userData["movingBatch"] = true;
    scene.add(shell, mob, gravelord, player, heads);
    const skip = notMapObjects(scene);
    for (const o of [skinned, weapon, placeholder, pv, heads]) expect(skip.has(o)).toBe(true);
    expect(skip.has(shell.children[0]!)).toBe(false);
    expect(surfaceMeshes(scene, skip)).toEqual([shell.children[0]]);
  });

  it("knows the sentinel, tolerant of rounding but not of lit surfaces", () => {
    expect(isSentinel(255, 0, 255)).toBe(true);
    expect(isSentinel(250, 12, 241)).toBe(true);
    expect(isSentinel(200, 80, 200)).toBe(false); // a lilac surface
    expect(isSentinel(255, 0, 120)).toBe(false); // red-pink
  });

  it("builds the same camera basis as three's lookAt, and pixel rays through it", () => {
    for (const f of CUBE_FACES) {
      const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 10);
      cam.up.set(...f.up);
      cam.lookAt(...f.dir);
      cam.updateMatrixWorld(true);
      const { r, u, f: fw } = viewBasis(f);
      const e = cam.matrixWorld.elements;
      close(r, [e[0]!, e[1]!, e[2]!]);
      close(u, [e[4]!, e[5]!, e[6]!]);
      close(fw, [-e[8]!, -e[9]!, -e[10]!]);
      // the top-left pixel ray lands on the top-left of the projected frame
      const d = pixelRay(f, 64, 0, 0);
      const ndc = new THREE.Vector3(...d).add(cam.position).project(cam);
      expect(ndc.x).toBeLessThan(-0.9);
      expect(ndc.y).toBeGreaterThan(0.9);
    }
    close(pixelRay(face("-z"), 2, 0.5, 0.5), [0, 0, -1]);
  });

  it("clusters sentinel pixels, flags the ones that leave the frame, finds the rim", () => {
    const px = view(32, [[10, 10, 12, 13], [0, 20, 3, 25]]);
    const cs = sentinelClusters(px, 32);
    expect(cs).toHaveLength(2);
    const inner = cs.find((c) => !c.touchesBorder)!;
    expect(inner.members).toHaveLength(12);
    expect([inner.minX, inner.minY, inner.maxX, inner.maxY]).toEqual([10, 10, 12, 13]);
    expect(cs.find((c) => c.touchesBorder)!.members).toHaveLength(24);
    const rim = rimPixels(px, 32, inner);
    expect(rim.length).toBe(8);
    for (const [x, y] of rim) expect(isSentinel(px[(y * 32 + x) * 4]!, px[(y * 32 + x) * 4 + 1]!, px[(y * 32 + x) * 4 + 2]!)).toBe(false);
  });

  it("counts every pixel indoors except through a declared opening", () => {
    const px = view(16, [[4, 4, 11, 11]]);
    const [c] = sentinelClusters(px, 16);
    expect(countedPixels({ mode: "indoor" }, [0, 0, 0], face("-z"), 16, 90, c!)).toHaveLength(64);
    const door = { name: "portal", min: [-6, -6, -6] as V3, max: [6, 6, -5] as V3 };
    expect(rayHitsBox([0, 0, 0], [0, 0, -1], door)).toBe(true);
    expect(rayHitsBox([0, 0, 0], [0, 0, 1], door)).toBe(false);
    expect(countedPixels({ mode: "indoor", openings: [door] }, [0, 0, 0], face("-z"), 16, 90, c!)).toHaveLength(0);
  });

  it("outdoors counts sentinel only where ground or a small enclosed slit should be", () => {
    const flat = () => 0;
    // the whole sky above the horizon of a wall view: open sky, not a hole
    const sky = sentinelClusters(view(16, [[0, 0, 15, 7]]), 16)[0]!;
    expect(countedPixels({ mode: "outdoor", ground: flat }, [0, 1.6, 0], face("-z"), 16, 90, sky)).toHaveLength(0);
    // the same pixels below the horizon, with ground 1.6 m under the eye: a hole in the ground
    const low = sentinelClusters(view(16, [[0, 10, 15, 15]]), 16)[0]!;
    expect(countedPixels({ mode: "outdoor", ground: flat, groundReach: 80 }, [0, 1.6, 0], face("-z"), 16, 90, low).length).toBeGreaterThan(0);
    // ... but not past the ground reach (a cliff edge looking out over a valley far below)
    expect(countedPixels({ mode: "outdoor", ground: () => -500, groundReach: 80 }, [0, 1.6, 0], face("-z"), 16, 90, low)).toHaveLength(0);
    // a small enclosed slit above the horizon (light through a wall) counts; a big archway does not
    const slit = sentinelClusters(view(16, [[7, 2, 8, 4]]), 16)[0]!;
    expect(countedPixels({ mode: "outdoor", ground: flat, enclosedMax: 40 }, [0, 1.6, 0], face("-z"), 16, 90, slit)).toHaveLength(6);
    const arch = sentinelClusters(view(16, [[3, 1, 12, 7]]), 16)[0]!;
    expect(countedPixels({ mode: "outdoor", ground: flat, enclosedMax: 40 }, [0, 1.6, 0], face("-z"), 16, 90, arch)).toHaveLength(0);
    // a prop against the sentinel: only enclosed clusters
    expect(countedPixels({ mode: "enclosed" }, [0, 0, 0], face("-z"), 16, 90, sky)).toHaveLength(0);
    expect(countedPixels({ mode: "enclosed" }, [0, 0, 0], face("-z"), 16, 90, arch)).toHaveLength(70);
  });

  it("ground expected: a ray from an eye in a carve (under the height field) counts ground only after it came out above it", () => {
    // a butte 100 m tall for x < 0; the eye stands in a ledge cut into its face at y 50, x -2 (under the field)
    const butte = (x: number) => (x < 0 ? 100 : 0);
    // looking out and a little down over the plain: leaves the butte, never comes down within reach -> no ground
    expect(groundExpected([-2, 50, 0], [0.995, -0.1, 0], butte, 80)).toBeNull();
    // looking out and steeply down: leaves the butte and meets the plain -> ground
    expect(groundExpected([-2, 50, 0], [0.6, -0.8, 0], butte, 80)).not.toBeNull();
    // an eye in the open (above the field) still finds the ground ahead at once
    expect(groundExpected([5, 1.6, 0], [0.9, -0.43, 0], () => 0, 80)).not.toBeNull();
  });

  it("outdoors with the field's solid: sky out of a gallery's open side is not a hole; a hole in the overhang mass is", () => {
    const flat = () => 0;
    // an enclosed sky patch straight ahead (-z), framed by rock pillars of the terrain
    const patch = sentinelClusters(view(16, [[6, 5, 9, 9]]), 16)[0]!;
    const eye: [number, number, number] = [0, 1.6, 0];
    const rimTerrain = ["__chunk:w:-14_32/terrain", "__chunk:w:-14_32/terrain", "poi-path-stone"];
    const air = () => false;                                    // the field is air along the patch: the gallery's open side
    const mass = (_x: number, _y: number, z: number) => z < -3 && z > -6; // a rock mass 3-6 m ahead: a hole through it
    const rule = (solid: (x: number, y: number, z: number) => boolean) => ({ mode: "outdoor" as const, ground: flat, enclosedMax: 40, solid });
    const counted = countedPixels(rule(air), eye, face("-z"), 16, 90, patch);
    expect(counted.length).toBe(20);                            // the enclosed rule alone counts it
    expect(fieldOpeningFilter(rule(air), eye, face("-z"), 16, 90, counted, rimTerrain)).toHaveLength(0);
    expect(fieldOpeningFilter(rule(mass), eye, face("-z"), 16, 90, counted, rimTerrain)).toHaveLength(20);
    // framed by built geometry alone (a hole through a kerb stone): the field does not know it, the enclosed rule stands
    expect(fieldOpeningFilter(rule(air), eye, face("-z"), 16, 90, counted, ["poi-path-stone", "poi-path-stone", "poi-path-stone"])).toHaveLength(20);
    // open on a side (a frame direction meets nothing inside the far plane: sky beside a head stone) or framed by nothing: the field judges it
    expect(fieldOpeningFilter(rule(air), eye, face("-z"), 16, 90, counted, [null, null, null])).toHaveLength(0);
    expect(fieldOpeningFilter(rule(mass), eye, face("-z"), 16, 90, counted, [null, null, null])).toHaveLength(20);
    expect(fieldOpeningFilter(rule(air), eye, face("-z"), 16, 90, counted, ["poi-path-stone", null])).toHaveLength(0);
    // below the horizon the height field (blind to carves) expects ground, but the field is air: not a hole
    const low = sentinelClusters(view(16, [[0, 10, 15, 15]]), 16)[0]!;
    expect(countedPixels({ mode: "outdoor", ground: flat, groundReach: 80, solid: air }, eye, face("-z"), 16, 90, low)).toHaveLength(0);
    expect(countedPixels({ mode: "outdoor", ground: flat, groundReach: 80, solid: (_x, y) => y < 0 }, eye, face("-z"), 16, 90, low).length).toBeGreaterThan(0);
    expect(solidAlong(eye, [0, 0, -1], mass, 80)).toBeCloseTo(3.5);
    // a pocket between a near kerb stone (3 m) and a far spire (110 m) is a gap between things; a frame at one depth is a hole
    expect(gapBetweenDepths([3, 3.2, 110, null])).toBe(true);
    expect(gapBetweenDepths([3, 3.2, 3.4, 2.9])).toBe(false);
    expect(gapBetweenDepths([30, 34, 41])).toBe(false);
    expect(gapBetweenDepths([3, null, null])).toBe(false);
  });

  it("names the cause: single-sided, culled, seam, open mesh", () => {
    const scene = new THREE.Scene();
    const wall = (id: string, z: number, side: THREE.Side, flip = false) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ side }));
      m.position.z = z; if (flip) m.rotation.y = Math.PI; m.userData["entityId"] = id; m.name = id;
      scene.add(m); m.updateMatrixWorld(true); return m;
    };
    // a plane at z=-3 facing away from an eye at the origin looking down -z: its back face, one-sided
    const back = wall("shell-a", -3, THREE.FrontSide, true);
    const hits = castAll([back], [0, 0, 0], [0, 0, -1]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.backFace).toBe(true);
    expect(back.material.side).toBe(THREE.FrontSide); // restored after the cast
    const rimA = castAll([back], [0, 0, 0], [0.2, 0, -1].map((v, i, a) => v / Math.hypot(...a)) as V3)[0]!;
    expect(classifyHole(hits, [rimA]).cause).toBe("single-sided");
    // the same plane facing the eye but hidden by culling
    const hid = wall("room-b", -3, THREE.FrontSide);
    hid.visible = false;
    expect(classifyHole(castAll([hid], [0, 0, 0], [0, 0, -1]), []).cause).toBe("culled");
    // nothing in the hole; the rim is two entities = a seam, one = an open mesh, nothing = void
    const rim = (id: string): ReturnType<typeof castAll>[number] => ({ entity: id, mesh: id, point: [0, 0, -3], distance: 3, backFace: false, singleSided: true, visible: true });
    expect(classifyHole([], [rim("a"), rim("b")]).cause).toBe("seam");
    expect(classifyHole([], [rim("a"), rim("a"), null]).cause).toBe("open-mesh");
    expect(classifyHole([], [null]).cause).toBe("void");
    // a back face far BEHIND the gap (the outside of another room) does not make it single-sided
    const far = { ...hits[0]!, distance: 40 };
    expect(classifyHole([far], [rim("a"), rim("b")]).cause).toBe("seam");
  });
});
