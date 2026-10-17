/**
 * See-through probe: find the holes a player can see through the map.
 *
 * Mesh audits (open edges, DC bake audits) miss gaps that only exist on
 * screen: a single-sided face seen from behind, a seam between two baked
 * groups, a DC sliver on a thin arch or hull, a decimation pinch, a group the
 * culling hid while it was still in sight. This probe looks at the screen
 * instead: it renders the scene with a SENTINEL background (pure magenta; the
 * sky dome, weather particles and sprites hidden, no post chain) into small
 * offscreen targets — a cube of six 90° views from an eye, or any list of
 * views — and every magenta pixel that should have been a surface is a hole.
 *
 * Debug/test only: nothing here runs in normal play. The switch lasts exactly
 * one synchronous block (set, draw every view, restore) so no game frame ever
 * sees the sentinel; fog is left alone (changing it recompiles every material,
 * and fog never paints a surface magenta). The pure parts (face basis, pixel
 * rays, sentinel clusters, the counting rule) are unit-tested without a GPU.
 *
 * docs/see-through.md; the tool is apps/playground/tools/see-through.mts.
 */
import * as THREE from "three/webgpu";
import { ownerOfFace } from "./static-batch.js";
import { ClusteredMesh } from "./clustered-mesh.js";

export type V3 = [number, number, number];

/** The sentinel clear colour (sRGB 255, 0, 255 = linear 1, 0, 1: the same bytes either way). */
export const SENTINEL_HEX = 0xff00ff;

/** A pixel that is the sentinel, tolerant of 8-bit rounding and a faint additive glow over it. */
export function isSentinel(r: number, g: number, b: number): boolean {
  return r >= 200 && b >= 200 && g <= 70 && Math.abs(r - b) <= 50;
}

export interface SeeThroughView {
  name: string;
  /** Unit forward. */
  dir: V3;
  /** Up hint (not parallel to dir). */
  up: V3;
}

/** The six faces of a cube around the eye: four walls, up, down. */
export const CUBE_FACES: readonly SeeThroughView[] = [
  { name: "+x", dir: [1, 0, 0], up: [0, 1, 0] },
  { name: "-x", dir: [-1, 0, 0], up: [0, 1, 0] },
  { name: "+z", dir: [0, 0, 1], up: [0, 1, 0] },
  { name: "-z", dir: [0, 0, -1], up: [0, 1, 0] },
  { name: "up", dir: [0, 1, 0], up: [0, 0, -1] },
  { name: "down", dir: [0, -1, 0], up: [0, 0, 1] },
];

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The camera basis three's lookAt builds for a view: forward, screen right, screen up. */
export function viewBasis(view: Pick<SeeThroughView, "dir" | "up">): { f: V3; r: V3; u: V3 } {
  const f = norm(view.dir);
  const z: V3 = [-f[0], -f[1], -f[2]];
  const r = norm(cross(view.up, z));
  const u = cross(z, r);
  return { f, r, u };
}

/**
 * The world ray through pixel (px, py) of a `size` x `size` view with vertical field `fovDeg`
 * (py = 0 is the TOP row, as the pixels are handed out by sentinelViews).
 */
export function pixelRay(view: Pick<SeeThroughView, "dir" | "up">, size: number, px: number, py: number, fovDeg = 90): V3 {
  const { f, r, u } = viewBasis(view);
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const nx = (((px + 0.5) / size) * 2 - 1) * t;
  const ny = (1 - ((py + 0.5) / size) * 2) * t;
  return norm([f[0] + r[0] * nx + u[0] * ny, f[1] + r[1] * nx + u[1] * ny, f[2] + r[2] * nx + u[2] * ny]);
}

export interface SentinelCluster {
  /** Pixel indices (y * size + x) of the cluster. */
  members: number[];
  minX: number; minY: number; maxX: number; maxY: number;
  /** Centroid, pixels. */
  cx: number; cy: number;
  /** Touches the view's border: sky or open space continuing out of the frame. */
  touchesBorder: boolean;
}

/** 4-connected clusters of sentinel pixels in an RGBA `size` x `size` view (top row first). */
export function sentinelClusters(rgba: ArrayLike<number>, size: number): SentinelCluster[] {
  const n = size * size;
  const seen = new Uint8Array(n);
  const sent = new Uint8Array(n);
  for (let i = 0; i < n; i++) sent[i] = isSentinel(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!) ? 1 : 0;
  const out: SentinelCluster[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!sent[s] || seen[s]) continue;
    const members: number[] = [];
    let minX = size, minY = size, maxX = -1, maxY = -1, sx = 0, sy = 0, border = false;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % size, y = (i - x) / size;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      sx += x; sy += y;
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) border = true;
      if (x > 0 && sent[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < size - 1 && sent[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && sent[i - size] && !seen[i - size]) { seen[i - size] = 1; stack.push(i - size); }
      if (y < size - 1 && sent[i + size] && !seen[i + size]) { seen[i + size] = 1; stack.push(i + size); }
    }
    out.push({ members, minX, minY, maxX, maxY, cx: sx / members.length, cy: sy / members.length, touchesBorder: border });
  }
  return out;
}

/**
 * The rim of a cluster: walking out from its centroid along `n` directions, the first non-sentinel pixel after the
 * cluster — the surfaces that frame the hole. Directions that leave the view first give nothing.
 */
export function rimPixels(rgba: ArrayLike<number>, size: number, c: SentinelCluster, n = 8): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const at = (x: number, y: number) => { const i = (y * size + x) * 4; return isSentinel(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!); };
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
    let inHole = false;
    for (let s = 0; s < size * 1.5; s += 0.5) {
      const x = Math.round(c.cx + dx * s), y = Math.round(c.cy + dy * s);
      if (x < 0 || y < 0 || x >= size || y >= size) break;
      if (at(x, y)) inHole = true;
      else if (inHole) { out.push([x, y]); break; }
    }
  }
  return out;
}

/** An axis-aligned box a ray may pass through without counting (a portal, a cave mouth to the outside, open sky). */
export interface Opening { name: string; min: V3; max: V3 }

/** Ray (origin, unit dir) meets the box within `maxT`. */
export function rayHitsBox(o: V3, d: V3, box: Opening, maxT = Infinity): boolean {
  let t0 = 0, t1 = maxT;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]!) < 1e-9) { if (o[a]! < box.min[a]! || o[a]! > box.max[a]!) return false; continue; }
    let ta = (box.min[a]! - o[a]!) / d[a]!, tb = (box.max[a]! - o[a]!) / d[a]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * What counts as a hole.
 * - indoor (dungeons, interiors, a prop's inside views): every sentinel pixel — nothing in there may show the void —
 *   except rays through a declared opening.
 * - outdoor (voxel worlds, POIs): the sky is legitimately the background, so a sentinel pixel counts only where a
 *   surface MUST be: its ray is below the horizon (by `horizonDip`) and the ground field says it meets the ground
 *   within `groundReach` m (a hole in terrain, a cliff edge, a gap under a built piece); or its cluster is ENCLOSED
 *   (touches no border of the view) and small (<= `enclosedMax` pixels) — a slit through a wall, a roof, an arch or an
 *   overhang. Big enclosed sky (an archway, a gap between roofs) does not count.
 * - enclosed (a prop orbited against the sentinel): only enclosed clusters, any size — light through the hull.
 */
export interface SeeThroughRule {
  mode: "indoor" | "outdoor" | "enclosed";
  openings?: readonly Opening[];
  /** How far an opening box is honoured along the ray (m). */
  openingReach?: number;
  ground?: (x: number, z: number) => number;
  groundReach?: number;
  horizonDip?: number;
  enclosedMax?: number;
  /**
   * The world's own solid (voxel density < 0, carves and passages included), when the scene has one. With it, outdoor
   * sky counts only where that solid lies on the ray: a below-horizon pixel must also meet field solid, and a cluster
   * framed by terrain counts only its pixels whose ray crosses field solid (a hole in an overhang mass). Sky out of an
   * open side of a cut ledge or gallery, between rock pillars, is field air and does not count (Kings' Path,
   * 2026-10-13). Clusters framed by built geometry alone (a kerb, a wall) keep the enclosed rule: the field does not
   * know them.
   */
  solid?: (x: number, y: number, z: number) => boolean;
  /** A rim entity that is terrain (the field's own mesh). Default: ids ending in "/terrain". */
  isTerrain?: (entity: string) => boolean;
}

/**
 * Outdoor: a sentinel pocket framed by a near surface and a far one (the far frame >= 3x the near one's depth and
 * >= 20 m behind it) is sky between separate things — over a kerb stone towards a distant spire — not a hole through
 * one surface, whose frame sits at one depth. `rimDepths` are the frame's hit distances (null: nothing in reach).
 */
export function gapBetweenDepths(rimDepths: readonly (number | null)[]): boolean {
  const d = rimDepths.filter((v): v is number => v !== null);
  if (d.length < 2) return false;
  const near = Math.min(...d), far = Math.max(...d);
  return far >= 3 * near && far - near >= 20;
}

/** Distance along the ray to the first field solid within `reach`, or null: the ray crosses only air. */
export function solidAlong(eye: V3, d: V3, solid: (x: number, y: number, z: number) => boolean, reach: number, step = 0.5): number | null {
  for (let t = step; t <= reach; t += step) if (solid(eye[0] + d[0] * t, eye[1] + d[1] * t, eye[2] + d[2] * t)) return t;
  return null;
}

/**
 * Outdoor, with the field's solid: of a cluster framed by terrain, keep only the counted pixels whose rays cross field
 * solid. The rest is sky or far land seen through an opening the world really has (a gallery's open side), not a hole
 * in a surface. `rimEntities` are what frames the cluster (null: nothing within the far plane, an open side); a frame
 * of built geometry all round keeps every counted pixel.
 */
export function fieldOpeningFilter(rule: SeeThroughRule, eye: V3, view: SeeThroughView, size: number, fovDeg: number, counted: number[], rimEntities: readonly (string | null)[]): number[] {
  if (rule.mode !== "outdoor" || !rule.solid) return counted;
  const terrain = rule.isTerrain ?? ((e: string) => /\/terrain$/.test(e));
  // judged by the field: framed by terrain, or OPEN on a side — a frame direction meets nothing inside the far plane (sky
  // or land past `far` beside a head stone, seen from a summit). A hole through a built piece is framed by it all round.
  const openSide = rimEntities.some((e) => e === null);
  if (!openSide && !rimEntities.some((e) => e !== null && terrain(e))) return counted;
  const reach = rule.groundReach ?? 80;
  return counted.filter((i) => { const px = i % size, py = (i - px) / size; return solidAlong(eye, pixelRay(view, size, px, py, fovDeg), rule.solid!, reach) !== null; });
}

/**
 * Ground expected along the ray within `reach`: a coarse march on the analytic height field. The height field does not
 * know carves (a ledge cut into a cliff, a gallery, a cutting), so an eye standing in one starts UNDER it: the ray only
 * counts a hit after it has been above the field once (it came down onto ground), never the field it starts beneath —
 * otherwise every sky pixel seen out of a cut ledge reads as a hole (the King's Table path, 2026-10-13).
 */
export function groundExpected(eye: V3, d: V3, ground: (x: number, z: number) => number, reach: number): number | null {
  const step = 0.75;
  let above = false;
  for (let t = step; t <= reach; t += step) {
    const x = eye[0] + d[0] * t, y = eye[1] + d[1] * t, z = eye[2] + d[2] * t;
    const g = ground(x, z);
    if (!Number.isFinite(g)) continue;
    if (y > g) above = true;
    else if (above) return t;
  }
  return null;
}

/** The pixels of a cluster that count as a hole under the rule (indices into members). */
export function countedPixels(rule: SeeThroughRule, eye: V3, view: SeeThroughView, size: number, fovDeg: number, c: SentinelCluster): number[] {
  const out: number[] = [];
  const openings = rule.openings ?? [];
  const reach = rule.openingReach ?? 60;
  const dip = rule.horizonDip ?? 0.03;
  const enclosedOk = !c.touchesBorder && c.members.length <= (rule.enclosedMax ?? Infinity);
  if (rule.mode === "enclosed" && c.touchesBorder) return out;
  for (const i of c.members) {
    const px = i % size, py = (i - px) / size;
    const d = pixelRay(view, size, px, py, fovDeg);
    if (openings.length && openings.some((b) => rayHitsBox(eye, d, b, reach))) continue;
    if (rule.mode === "outdoor") {
      const below = d[1] < -dip && rule.ground && groundExpected(eye, d, rule.ground, rule.groundReach ?? 80) !== null
        && (!rule.solid || solidAlong(eye, d, rule.solid, rule.groundReach ?? 80) !== null);
      if (!below && !enclosedOk) continue;
    }
    out.push(i);
  }
  return out;
}

// -- GPU side -------------------------------------------------------------------------------------------------------

/** A view to draw: from `eye` along `view`, a square `size` px, vertical field `fov`. */
export interface SentinelShot { eye: V3; view: SeeThroughView; fov?: number }

interface RendererLike { renderer: THREE.WebGPURenderer }

const targets = new Map<number, THREE.RenderTarget[]>();
function targetsFor(size: number, count: number): THREE.RenderTarget[] {
  let list = targets.get(size);
  if (!list) targets.set(size, (list = []));
  while (list.length < count) list.push(new THREE.RenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: true }));
  return list;
}

/** Hide-for-the-sentinel: the sky dome, particles, sprites, lines (weather, glows) and characters — never the map. */
function backgroundish(o: THREE.Object3D): boolean {
  const any = o as THREE.Object3D & { isPoints?: boolean; isSprite?: boolean; isLine?: boolean; isSkinnedMesh?: boolean };
  // characters and creatures (skinned) are not the map: they move between the draw and the ray, and a hole behind one is still a hole
  return o.userData["skyDome"] === true || !!any.isPoints || !!any.isSprite || !!any.isLine || !!any.isSkinnedMesh || o.userData["isColliderProxy"] === true;
}

/**
 * Everything that is not the map, as a set of objects: the `exclude` subtrees (the player), and every CHARACTER — the
 * whole entity a skinned mesh belongs to (its body, and the unskinned parts riding on it: held weapons, worn pieces,
 * attachments, a merged head), every moving-instance batch (worn/held pieces drawn instanced), every character prefab's visual entity (id "...:visual" / "...-visual"), plus anything flagged `userData.character` / `userData.creature`. Characters and
 * creatures move between the draw and the explaining ray, and a hole behind one is still a hole; both the sentinel
 * draw and the rays that explain a hole skip them (else a hole is blamed on the player standing in the eye: "cutout").
 */
export function notMapObjects(scene: THREE.Object3D, exclude: readonly THREE.Object3D[] = []): Set<THREE.Object3D> {
  const out = new Set<THREE.Object3D>();
  const roots = new Set<THREE.Object3D>(exclude);
  scene.traverse((o) => {
    const any = o as THREE.Object3D & { isSkinnedMesh?: boolean };
    if (o.userData["character"] === true || o.userData["creature"] === true) roots.add(o);
    // a moving-instance batch (moving-instances.ts): every held weapon, worn helm or merged head of every character in
    // one draw, following its holder; the player's own head sits in the eye ("cutout" holes in the Reed Warren, 2026-10-13)
    if (o.userData["movingBatch"] === true) roots.add(o);
    // a character prefab's visual child ("player:player-visual", "<mob>:visual", npc "<id>-visual"): placeholder bodies
    // and statically posed creatures carry no skinned mesh, but they are still not the map
    const id = o.userData["entityId"];
    if (typeof id === "string" && /(^|[:-])visual$/.test(id)) roots.add(o);
    if (!any.isSkinnedMesh) return;
    // the entity the skinned mesh belongs to (nearest ancestor carrying an entity id), else its top-most parent below the scene
    let root: THREE.Object3D = o;
    for (let p: THREE.Object3D | null = o; p && p !== scene; p = p.parent) { root = p; if (typeof p.userData["entityId"] === "string") break; }
    roots.add(root);
  });
  for (const r of roots) r.traverse((o) => out.add(o));
  return out;
}

/**
 * Draw every shot with the sentinel background, synchronously (set, draw all, restore), then read the pixels back.
 * `isolate`: draw only that subtree (a prop seen alone). Returns RGBA per shot, top row first.
 */
export async function sentinelViews(engine: RendererLike, scene: THREE.Scene, shots: readonly SentinelShot[], size: number,
  opts: { near?: number; far?: number; isolate?: THREE.Object3D | null; exclude?: readonly THREE.Object3D[]; layers?: number; lodHeight?: number } = {}): Promise<Uint8Array[]> {
  const renderer = engine.renderer;
  const rts = targetsFor(size, shots.length);
  const cam = new THREE.PerspectiveCamera(90, 1, opts.near ?? 0.05, opts.far ?? 600);
  // the play camera's layers: a culling system may park objects on a layer it does not draw
  if (opts.layers !== undefined) cam.layers.mask = opts.layers;
  const hidden: THREE.Object3D[] = [];
  const keepBg = scene.background, keepBgNode = (scene as unknown as { backgroundNode: unknown }).backgroundNode;
  const keepTarget = renderer.getRenderTarget();
  const keepClear = renderer.getClearColor(new THREE.Color()), keepAlpha = renderer.getClearAlpha();
  const inIsolate = new Set<THREE.Object3D>();
  if (opts.isolate) opts.isolate.traverse((o) => inIsolate.add(o));
  const excluded = notMapObjects(scene, opts.exclude ?? []);
  try {
    scene.traverse((o) => {
      if (!o.visible || o === scene) return;
      const hideIt = backgroundish(o) || excluded.has(o) || (opts.isolate && (o as THREE.Mesh).isMesh && !inIsolate.has(o));
      if (hideIt) { o.visible = false; hidden.push(o); }
    });
    scene.background = new THREE.Color(SENTINEL_HEX);
    (scene as unknown as { backgroundNode: unknown }).backgroundNode = null;
    renderer.setClearColor(SENTINEL_HEX, 1);
    shots.forEach((s, k) => {
      cam.fov = s.fov ?? 90;
      cam.updateProjectionMatrix();
      cam.position.set(s.eye[0], s.eye[1], s.eye[2]);
      cam.up.set(s.view.up[0], s.view.up[1], s.view.up[2]);
      cam.lookAt(s.eye[0] + s.view.dir[0], s.eye[1] + s.view.dir[1], s.eye[2] + s.view.dir[2]);
      cam.updateMatrixWorld(true);
      clusterCutFor(scene, cam, opts.lodHeight ?? 1080);
      renderer.setRenderTarget(rts[k]!);
      renderer.clear();
      renderer.render(scene, cam);
    });
  } finally {
    for (const o of hidden) o.visible = true;
    scene.background = keepBg;
    (scene as unknown as { backgroundNode: unknown }).backgroundNode = keepBgNode;
    renderer.setRenderTarget(keepTarget);
    renderer.setClearColor(keepClear, keepAlpha);
  }
  const webgl = (renderer as unknown as { backend?: { isWebGLBackend?: boolean } }).backend?.isWebGLBackend === true;
  const out: Uint8Array[] = [];
  for (let k = 0; k < shots.length; k++) {
    const px = new Uint8Array((await renderer.readRenderTargetPixelsAsync(rts[k]!, 0, 0, size, size)) as Uint8Array);
    if (webgl) { // WebGL reads bottom row first
      const row = size * 4, tmp = new Uint8Array(row);
      for (let y = 0; y < size / 2; y++) { const a = y * row, b = (size - 1 - y) * row; tmp.set(px.subarray(a, a + row)); px.copyWithin(a, b, b + row); px.set(tmp, b); }
    }
    out.push(px);
  }
  return out;
}

/**
 * Cluster-LOD meshes hold the cut (and the per-cluster frustum cull) of the PLAY camera: re-select it for this camera,
 * or a view looking elsewhere draws — and raycasts — clusters culled for the play view as holes. The next game frame
 * re-selects for the play camera by itself. `lodHeight` = the play viewport height, so the detail matches play.
 */
export function clusterCutFor(scene: THREE.Object3D, camera: THREE.PerspectiveCamera, lodHeight: number): void {
  scene.traverse((o) => { if (o instanceof ClusteredMesh && o.visible) o.update(camera, lodHeight); });
}

/** The camera of a shot (for clusterCutFor before explaining that view's holes). */
export function shotCamera(s: SentinelShot, near = 0.05, far = 600): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(s.fov ?? 90, 1, near, far);
  cam.position.set(s.eye[0], s.eye[1], s.eye[2]);
  cam.up.set(s.view.up[0], s.view.up[1], s.view.up[2]);
  cam.lookAt(s.eye[0] + s.view.dir[0], s.eye[1] + s.view.dir[1], s.eye[2] + s.view.dir[2]);
  cam.updateMatrixWorld(true);
  return cam;
}

// -- what the hole is ------------------------------------------------------------------------------------------------

export interface RayHit { entity: string | null; mesh: string; point: V3; distance: number; backFace: boolean; singleSided: boolean; visible: boolean }

function visibleChain(o: THREE.Object3D): boolean { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; }
function entityOf(o: THREE.Object3D, faceIndex: number | undefined): string | null {
  const own = ownerOfFace(o, faceIndex);
  if (own) return own;
  for (let p: THREE.Object3D | null = o; p; p = p.parent) { const id = p.userData["entityId"]; if (typeof id === "string") return id; }
  return null;
}

/**
 * The surfaces a probe may hit: meshes that are not sky, particles or collider proxies (hidden ones included), and
 * not in `skip` (notMapObjects: the player, characters and creatures).
 */
export function surfaceMeshes(root: THREE.Object3D, skip?: ReadonlySet<THREE.Object3D>): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !backgroundish(o) && !skip?.has(o)) out.push(o as THREE.Mesh); });
  return out;
}

/**
 * Every surface along a ray, nearest first: both faces of every mesh (single-sided materials are tested double-sided
 * for the moment of the cast and restored), hidden meshes too, each hit saying whether the renderer would have drawn it
 * (visible, and not a back face of a single-sided material).
 */
export function castAll(meshes: readonly THREE.Mesh[], eye: V3, d: V3, far = 600, layers?: number): RayHit[] {
  const ray = new THREE.Raycaster(new THREE.Vector3(...eye), new THREE.Vector3(...d), 0.02, far);
  const hits: RayHit[] = [];
  const n = new THREE.Vector3();
  for (const m of meshes) {
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[];
    const sides = mats.map((mt) => mt.side);
    for (const mt of mats) mt.side = THREE.DoubleSide;
    const local: THREE.Intersection[] = [];
    try { m.raycast(ray, local); } catch { /* exotic geometry */ } finally { mats.forEach((mt, k) => (mt.side = sides[k]!)); }
    for (const h of local) {
      let back = false;
      if (h.face) { n.copy(h.face.normal).transformDirection(m.matrixWorld); back = n.x * d[0] + n.y * d[1] + n.z * d[2] > 0; }
      const mat = (Array.isArray(m.material) ? m.material[h.face?.materialIndex ?? 0] : m.material) as THREE.Material | undefined;
      const side = mat?.side ?? THREE.FrontSide;
      const singleSided = side !== THREE.DoubleSide;
      hits.push({ entity: entityOf(m, h.faceIndex ?? undefined), mesh: m.name || m.type, point: [h.point.x, h.point.y, h.point.z], distance: h.distance,
        backFace: side === THREE.BackSide ? !back : back, singleSided, visible: visibleChain(m) && (layers === undefined || (m.layers.mask & layers) !== 0) });
    }
  }
  return hits.sort((a, b) => a.distance - b.distance);
}

export type HoleCause = "single-sided" | "culled" | "seam" | "open-mesh" | "void" | "cutout";

/**
 * Why a hole shows the sentinel, from the scene itself: the first surface on the centre ray tells single-sided (a back
 * face of a one-sided material), culled (a surface that was hidden while in sight) or cutout (drawn front face: alpha
 * test / shader discard); no surface at all is a true gap, and the rim (what frames the hole) tells a seam between
 * two entities from a hole inside one mesh (open-mesh: DC sliver, decimate pinch); nothing anywhere is void.
 */
export function classifyHole(centre: RayHit[], rim: Array<RayHit | null>): { cause: HoleCause; entities: string[]; at: V3 | null; depth: number | null } {
  const rimHits = rim.filter((h): h is RayHit => !!h);
  const rimEntities = [...new Set(rimHits.map((h) => h.entity ?? h.mesh))];
  const mean = (pts: V3[]): V3 | null => (pts.length ? [0, 1, 2].map((a) => pts.reduce((s, p) => s + p[a]!, 0) / pts.length) as V3 : null);
  // only a surface IN the hole counts for it: something far behind a gap (the outside of another room) does not
  const rimD = rimHits.map((h) => h.distance).sort((a, b) => a - b);
  const reach = rimD.length ? rimD[rimD.length >> 1]! * 1.3 + 1 : Infinity;
  const first = centre.find((h) => h.distance <= reach);
  if (first) {
    const who = [first.entity ?? first.mesh];
    if (!first.visible) return { cause: "culled", entities: who, at: first.point, depth: first.distance };
    if (first.backFace && first.singleSided) return { cause: "single-sided", entities: who, at: first.point, depth: first.distance };
    return { cause: "cutout", entities: who, at: first.point, depth: first.distance };
  }
  const at = mean(rimHits.map((h) => h.point));
  const depth = rimHits.length ? rimHits.reduce((s, h) => s + h.distance, 0) / rimHits.length : null;
  if (!rimHits.length) return { cause: "void", entities: [], at, depth };
  return { cause: rimEntities.length >= 2 ? "seam" : "open-mesh", entities: rimEntities, at, depth };
}

// -- one probe: draw, find, explain ----------------------------------------------------------------------------------

export interface ProbeOptions {
  rule: SeeThroughRule;
  /** Pixels per view side (default 128). */
  size?: number;
  /** A cluster counts as a hole from this many counted pixels (default 6). */
  minPixels?: number;
  near?: number;
  far?: number;
  isolate?: THREE.Object3D | null;
  exclude?: readonly THREE.Object3D[];
  /** Surfaces to explain holes against (default: every surface mesh under `isolate` or the scene). */
  meshes?: readonly THREE.Mesh[];
  /** A cropped picture of each hole (data URL). */
  crop?: boolean;
  /** The play camera's layer mask (drawn and explained with it). */
  layers?: number;
  /** The play viewport height (cluster LOD detail; default 1080). */
  lodHeight?: number;
}

export interface ProbeHole {
  view: string;
  eye: V3;
  /** Unit ray through the hole's centre. */
  dir: V3;
  /** Counted (hole) pixels, and the whole sentinel cluster they belong to. */
  pixels: number;
  clusterPixels: number;
  bbox: [number, number, number, number];
  size: number;
  cause: HoleCause;
  entities: string[];
  /** World estimate of the hole: the surface in it (single-sided, culled, cutout) or the mean of its rim. */
  at: V3 | null;
  depth: number | null;
  crop?: string;
}

function cropOf(rgba: Uint8Array, size: number, c: SentinelCluster): string | undefined {
  if (typeof document === "undefined") return undefined;
  const cv = document.createElement("canvas");
  cv.width = size; cv.height = size;
  const g = cv.getContext("2d");
  if (!g) return undefined;
  const lit = new Uint8ClampedArray(size * size * 4);
  lit.set(rgba.subarray(0, size * size * 4));
  // the target is linear and unexposed (dungeons read near-black): gamma + auto-level the surfaces so the hole's frame reads
  const lum: number[] = [];
  for (let i = 0; i < lit.length; i += 4) if (!isSentinel(lit[i]!, lit[i + 1]!, lit[i + 2]!)) lum.push(Math.max(lit[i]!, lit[i + 1]!, lit[i + 2]!));
  lum.sort((a, b) => a - b);
  const top = Math.max(1, lum[Math.floor(lum.length * 0.97)] ?? 255) / 255;
  for (let i = 0; i < lit.length; i += 4) {
    if (isSentinel(lit[i]!, lit[i + 1]!, lit[i + 2]!)) continue;
    for (let c = 0; c < 3; c++) lit[i + c] = 255 * Math.min(1, Math.pow(Math.min(1, lit[i + c]! / 255 / top), 1 / 2.2) * 0.9);
  }
  g.putImageData(new ImageData(lit, size, size), 0, 0);
  const pad = 14;
  const x0 = Math.max(0, c.minX - pad), y0 = Math.max(0, c.minY - pad), x1 = Math.min(size, c.maxX + 1 + pad), y1 = Math.min(size, c.maxY + 1 + pad);
  const S = 3, out = document.createElement("canvas");
  out.width = (x1 - x0) * S; out.height = (y1 - y0) * S;
  const o = out.getContext("2d")!;
  o.imageSmoothingEnabled = false;
  o.drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, out.width, out.height);
  o.strokeStyle = "#ffe600"; o.lineWidth = 2;
  o.strokeRect((c.minX - x0) * S - 2, (c.minY - y0) * S - 2, (c.maxX - c.minX + 1) * S + 4, (c.maxY - c.minY + 1) * S + 4);
  return out.toDataURL("image/png");
}

/**
 * Draw `shots` (default: the six cube faces around `eye`) with the sentinel, keep the clusters the rule counts, and
 * explain each hole from the scene (classifyHole). Debug/test only.
 */
export async function probeSeeThrough(engine: RendererLike, scene: THREE.Scene, eye: V3, opts: ProbeOptions, shots?: readonly SentinelShot[]): Promise<ProbeHole[]> {
  const size = opts.size ?? 128, minPx = opts.minPixels ?? 6;
  const list: readonly SentinelShot[] = shots ?? CUBE_FACES.map((view) => ({ eye, view }));
  const pixels = await sentinelViews(engine, scene, list, size, { near: opts.near, far: opts.far, isolate: opts.isolate, exclude: opts.exclude, layers: opts.layers, lodHeight: opts.lodHeight });
  const holes: ProbeHole[] = [];
  let meshes = opts.meshes ?? null;
  for (let k = 0; k < list.length; k++) {
    const shot = list[k]!, rgba = pixels[k]!, fov = shot.fov ?? 90;
    let cutDone = false;
    for (const c of sentinelClusters(rgba, size)) {
      if (c.members.length < minPx) continue;
      let counted = countedPixels(opts.rule, shot.eye, shot.view, size, fov, c);
      if (counted.length < minPx) continue;
      meshes ??= surfaceMeshes(opts.isolate ?? scene, notMapObjects(scene, opts.exclude ?? []));
      if (!cutDone) { clusterCutFor(scene, shotCamera(shot, opts.near, opts.far), opts.lodHeight ?? 1080); cutDone = true; }
      // the counted pixel nearest the cluster's centroid: inside the hole even when the cluster is a ring
      let best = counted[0]!, bd = Infinity;
      for (const i of counted) { const x = i % size, y = (i - x) / size, d = (x - c.cx) ** 2 + (y - c.cy) ** 2; if (d < bd) { bd = d; best = i; } }
      const bx = best % size, by = (best - bx) / size;
      const dir = pixelRay(shot.view, size, bx, by, fov);
      const centre = castAll(meshes, shot.eye, dir, opts.far ?? 600, opts.layers);
      const drawn = (h: RayHit) => h.visible && !(h.backFace && h.singleSided);
      const rim = rimPixels(rgba, size, { ...c, cx: bx, cy: by }).map(([x, y]) => castAll(meshes!, shot.eye, pixelRay(shot.view, size, x, y, fov), opts.far ?? 600, opts.layers).find(drawn) ?? null);
      if (opts.rule.mode === "outdoor" && opts.rule.solid) {
        counted = fieldOpeningFilter(opts.rule, shot.eye, shot.view, size, fov, counted, rim.map((h) => (h ? h.entity ?? h.mesh : null)));
        if (counted.length < minPx) continue;
      }
      if (opts.rule.mode === "outdoor" && gapBetweenDepths(rim.map((h) => (h ? h.distance : null)))) continue;
      const why = classifyHole(centre, rim);
      holes.push({ view: shot.view.name, eye: shot.eye, dir, pixels: counted.length, clusterPixels: c.members.length, bbox: [c.minX, c.minY, c.maxX, c.maxY], size,
        ...why, ...(opts.crop !== false ? { crop: cropOf(rgba, size, c) } : {}) });
    }
  }
  return holes;
}
