import * as THREE from "three/webgpu";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
import {
  attribute,
  texture as tslTexture,
  uv,
  positionLocal,
  positionGeometry,
  positionWorld,
  cameraPosition,
  time,
  color as tslColor,
  float,
  mix,
  smoothstep,
  add,
  sub,
  mul,
  sin,
  length,
  vec3,
  uniform,
} from "three/tsl";

/** Validated `grass` component data (schema lives in @hitreg/core). */
export interface GrassData {
  bladeColor: string;
  tipColor: string;
  bladeWidth: number;
  bladeHeight: number;
  /** Billboard texture asset id. Set = textured cross-quads, absent = procedural blades. */
  texture?: string;
  crossQuads: number;
  alphaTest: number;
  /** Terrain surface names this may grow on; the HOST decides what that means. */
  surfaces: string[];
  minSurface: number;
  slopeMax: number;
  density: number;
  radius: number;
  windStrength: number;
  windSpeed: number;
  heightFadeStart: number;
  heightFadeEnd: number;
}

/** World (x, z) -> ground height, or null when nothing is loaded there. */
export type GroundSampler = (x: number, z: number) => number | null;

/**
 * Where a particular cover LAYER may grow: ground height, or null for "not
 * here". The layer's own data comes with it, so the host can answer using that
 * layer's `surfaces`/`minSurface`/`slopeMax` — the render package has no idea
 * what a biome or a splat weight is, and should not.
 */
export type FoliageSampler = (x: number, z: number, data: GrassData) => number | null;

/** Resolve a texture asset id to a URL. */
export type GrassTextureResolver = (assetId: string) => string | undefined;

/**
 * Intersecting textured quads standing on the origin, `crossQuads` of them
 * evenly rotated about Y.
 *
 * Two is the standard cross and nearly always right: one card disappears
 * edge-on as you walk around it, three costs 50% more for a little more volume
 * up close. UVs run v=0 at the base to v=1 at the top, which is also what the
 * sway's bend fraction reads.
 */
export function crossQuadGeometry(width: number, height: number, quads: number): THREE.BufferGeometry {
  const half = width / 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let q = 0; q < quads; q++) {
    const angle = (Math.PI * q) / quads;
    const cx = Math.cos(angle) * half;
    const cz = Math.sin(angle) * half;
    const base = positions.length / 3;
    positions.push(-cx, 0, -cz, cx, 0, cz, cx, height, cz, -cx, height, -cz);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
}

const MAX_BLADES = 65000;
// re-center only after the camera crosses this fraction of the patch radius,
// so terrain resampling is a rare event, not a per-frame cost — the
// "sliding window" that keeps grass around the camera without regenerating
// the whole world's worth of blades. CPU-profiled during sustained flight:
// regenerate()'s full ~63k-instance relayout was a real, if smaller
// (3.7-6.2% of self-time), spike source, firing every ~16 world units at the
// old 0.35 fraction — under a second of flight at typical speed. Widened so
// it fires roughly half as often; still frequent enough that the field
// visibly follows the camera.
const RECENTER_FRACTION = 0.6;

/**
 * Deadband on that grid, as a fraction of a cell PAST the boundary.
 *
 * Snapping alone has no memory, and a camera sitting on a boundary flips
 * between two cells on the smallest wobble — which is exactly what a
 * third-person camera does, because ORBITING moves the camera in a circle
 * several metres wide around a player who is standing still. A CPU profile of
 * the camera merely rotating in place, with no cell streaming at all, still
 * put the world field's `fbm2` at 8.2% of main-thread self time: every
 * boundary flip re-placed the whole field and re-evaluated the terrain noise
 * under every tuft, for a view of the same ground from a slightly different
 * angle.
 *
 * A Schmitt trigger fixes it: the camera has to cross the boundary and keep
 * going by another 0.2 of a cell before the field follows, so a wobble that
 * straddles the line settles on whichever side it reached first. The cost is
 * that the patch centre can trail the camera by 0.7 rather than 0.5 of a cell
 * on each axis; kept small deliberately, since the disc's far edge is what
 * pays for it.
 */
const RECENTER_HYSTERESIS = 0.2;

/**
 * How much re-placement work one frame may do, in "sample units".
 *
 * A full re-place walks every grid cell of the disc and asks the host for the
 * ground under each one. On a generated world that question is a procedural
 * noise evaluation, not a lookup, and doing tens of thousands of them between
 * two `requestAnimationFrame`s is where the profiled 80-130ms single-frame
 * spikes came from. So a placement is built into a scratch buffer across as
 * many frames as it needs and swapped in when it is COMPLETE — the field
 * already on screen stays up meanwhile, which is why the seam never shows.
 *
 * The two costs are an order of magnitude apart, so they are charged
 * separately: an uncached ground sample is ~2us, and merely visiting a cell
 * that is already cached (hash, radius test, matrix compose) is ~10x cheaper.
 * A budget of 1000 is therefore about 1000 cold samples OR 10000 warm cells
 * per frame — roughly 2ms either way.
 */
const PLACEMENT_BUDGET = 1000;
const MISS_COST = 1;
const CELL_COST = 0.1;

/**
 * Cached ground samples, keyed by grid cell.
 *
 * `gx` and `gz` are both int32; this packs them into one float64 exactly
 * (well inside 2^53 for any world smaller than ~2^20 cells across) so the
 * cache can be a `Map` on a number rather than on a string built per query.
 */
function cellKey(gx: number, gz: number): number {
  return gx * 4294967296 + (gz >>> 0);
}

/** In-flight placement: the disc being built, and where the walk got to. */
interface PendingPlacement {
  centerX: number;
  centerZ: number;
  gx0: number;
  gx1: number;
  gz0: number;
  gz1: number;
  gzMid: number;
  rows: number;
  /** outward row cursor, and the column cursor inside the row it names */
  n: number;
  gx: number;
  gz: number;
  rowActive: boolean;
  visible: number;
}

/**
  * Deterministic [0, 1) from a GRID CELL, not from an instance index.
  *
  * That distinction is the whole fix for cover that swims: keyed by index, an
  * instance's position is an offset from wherever the patch happens to be
  * centred, so every recenter teleports every tuft. Keyed by cell, a tuft's
  * position, size, yaw, wind phase and tint are all functions of WHERE IT IS,
  * and recentering just changes which cells are in range.
  *
  * Integer mixing (no `Math.sin`) so neighbouring cells decorrelate properly —
  * the sine hash bands visibly on a regular lattice, which is exactly what a
  * grid of foliage is.
  */
function hashCell(x: number, z: number, salt: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * One grass field: an InstancedMesh of single-triangle blades, camera-relative
 * and re-centered in a coarse grid as the camera moves (the technique from
 * "Making Grass With Triangles In GLSL Using Three.js"). Positions are baked
 * per-instance in WORLD space and the mesh's own local matrix is pinned to
 * the inverse of its parent's world matrix every frame — same trick the
 * particle system's "world space" mode uses — so the field renders correctly
 * regardless of which entity's transform it's attached to.
 */
class GrassPatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly count: number;
  private readonly heightFadeUniform;
  private readonly spacing: number;
  /**
   * Per-instance (wind phase, tint) — an ATTRIBUTE, not `hash(instanceIndex)`.
   *
   * Same reason as the placement: keyed by index, a tuft's sway phase and
   * brightness change the moment the patch recenters and the indices shuffle,
   * so the whole field twitches and re-shades at once. Keyed by cell and
   * uploaded per instance, they belong to the tuft.
   */
  private readonly instanceRandom: THREE.InstancedBufferAttribute;
  private mapTexture: THREE.Texture | null = null;
  private center = new THREE.Vector2(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);

  /**
   * Ground heights already sampled, keyed by grid CELL (NaN = "no cover here").
   *
   * The placement grid is anchored to the world, so a re-placed disc asks
   * about mostly the same points as the one before it — the overlap between
   * two adjacent centres is the large majority of both. `sampleGrassy` is a
   * pure function of (x, z) for a given world, so those repeats are free once
   * answered, which is what turns a re-place from "re-evaluate the terrain
   * noise field tens of thousands of times" into a buffer walk.
   *
   * Bounded, and dropped wholesale by `invalidateGround()` when the ground
   * itself can have changed (a recipe live-edit, a world or scene swap) —
   * a cache of terrain that no longer exists is worse than no cache.
   */
  private readonly samples = new Map<number, number>();
  private readonly sampleLimit: number;
  /** Placement being built across frames; see PLACEMENT_BUDGET. */
  private pending: PendingPlacement | null = null;
  /**
   * Scratch the pending placement writes into, so the committed field on
   * screen is never half-overwritten. Same size as the instance buffer it
   * eventually replaces, allocated on the first placement.
   */
  private scratchMatrix: Float32Array | null = null;
  private scratchRandom: Float32Array | null = null;
  /** false until one placement has COMPLETED — the first one is not budgeted. */
  private placed = false;
  /** the ground moved under a field already on screen; re-place in place */
  private stale = false;

  private readonly tmpMat = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpCamPos = new THREE.Vector3();
  private readonly Y_AXIS = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly group: THREE.Object3D,
    private readonly data: GrassData,
    resolveTexture?: GrassTextureResolver,
  ) {
    // 15% headroom: the jittered grid lands a variable number of points
    // inside the disc, and a buffer sized to the exact mean clips the field's
    // far edge on the rounds that come out heavy
    this.count = Math.min(
      MAX_BLADES,
      Math.max(1, Math.ceil(Math.PI * data.radius * data.radius * data.density * 1.15)),
    );
    this.spacing = 1 / Math.sqrt(Math.max(1e-4, data.density));
    // ~2.5 discs' worth of cells: enough that the disc before last is still
    // warm when the camera turns around, hard-capped so a huge dense layer
    // cannot quietly grow a cache bigger than the mesh it feeds
    this.sampleLimit = Math.min(120_000, Math.max(4096, Math.ceil(this.count * 2.5)));
    const textured = Boolean(data.texture);

    let geometry: THREE.BufferGeometry;
    if (textured) {
      geometry = crossQuadGeometry(data.bladeWidth, data.bladeHeight, Math.max(1, Math.round(data.crossQuads)));
    } else {
      const w = data.bladeWidth / 2;
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array([-w, 0, 0, w, 0, 0, 0, data.bladeHeight, 0]), 3),
      );
      geometry.setIndex([0, 1, 2]);
    }

    // MeshStandardNodeMaterial, not MeshBasicNodeMaterial: grass sits right
    // next to lit, shadowed terrain/trees — an unlit blade stays at full
    // brightness in a shadow and reads as a different, disconnected shade of
    // green from the ground around it. Standard + receiveShadow lets the same
    // sun/shadow map that darkens the terrain darken the grass too.
    this.material = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      // NOT `transparent: true`. Cutout, not blending: a textured tuft is
      // mostly empty, and alpha blending a hundred thousand overlapping quads
      // means sorting them, which is both expensive and wrong. alphaTest
      // discards the empty fragments outright, so depth still writes and the
      // layer needs no sort order.
      //
      // Setting `transparent` anyway does not make the cutout any softer — it
      // just moves an OPAQUE field into the transparent queue, where it draws
      // after everything else with blending on and, crucially, with no early-Z
      // rejection. A ground-level camera sees this field edge-on through its
      // whole depth: every blade behind another one still shades. A play-mode
      // profile measured GPU time nearly tripling (3.1 -> 9.2ms/frame) when
      // the grass layer came on, on a scene drawing only 179 calls.
      transparent: false,
      depthWrite: true,
      roughness: 0.95,
      metalness: 0,
    });
    if (textured) this.material.alphaTest = data.alphaTest;

    // bend factor: 0 at the base, 1 at the tip — eased so the base stays put.
    // Must read positionGeometry (the raw, untransformed vertex position), NOT
    // positionLocal — the instancing pass reassigns positionLocal in place to
    // the post-instance-matrix (world-scale) position before this node runs,
    // which would blow the [0,1] fraction up to the blade's actual world
    // height and send both the wind sway and the color mix wildly out of range.
    this.instanceRandom = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 2), 2);
    this.instanceRandom.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("instanceRandom", this.instanceRandom);
    const perInstance: N = attribute("instanceRandom", "vec2");
    const bend = positionGeometry.y.div(float(Math.max(0.001, data.bladeHeight)));
    const bendEased = mul(bend, bend);
    const phase = mul(perInstance.x, float(Math.PI * 2));
    const sway = mul(sin(add(mul(time, float(data.windSpeed)), phase)), float(data.windStrength));
    this.material.positionNode = add(
      positionLocal,
      vec3(mul(sway, bendEased), 0, mul(mul(sway, bendEased), float(0.3))),
    );
    // fake "mostly up" normal (no real geometry normal — a thin blade's true
    // face normal points sideways, not up) — reads as soft, ground-matching
    // diffuse shading regardless of the blade's random yaw, the standard trick
    // for cheap foliage lighting; no instance-rotation transform needed since
    // there's no geometry "normal" attribute for the instancing pass to touch.
    this.material.normalNode = vec3(0, 1, 0);

    // per-instance brightness jitter, so a field is not one flat sheet of one
    // colour — the cheapest thing that stops instancing looking instanced
    const tint = add(float(0.85), mul(perInstance.y, float(0.3)));

    this.heightFadeUniform = uniform(1, "float");
    const camDist = length(sub(cameraPosition, positionWorld));
    const edgeFade = sub(
      float(1),
      smoothstep(float(data.radius * 0.7), float(data.radius), camDist),
    );
    const fade = mul(edgeFade, float(this.heightFadeUniform));

    if (textured) {
      // Colour and cutout both come from the billboard. bladeColor still
      // multiplies through as a grading handle — leave it white for the
      // texture untouched.
      const map = new THREE.Texture();
      this.mapTexture = map;
      // method form, not the free functions: TSL's overloads resolve the free
      // `mul(colorNode, colorNode)` to the mat4 signature and fail to typecheck
      const sampled = tslTexture(map, uv());
      this.material.colorNode = sampled.xyz.mul(tslColor(data.bladeColor)).mul(tint);
      // the texture's own alpha times the fades, so the fades dissolve the
      // layer through the same alphaTest instead of needing a sorted blend
      this.material.opacityNode = sampled.w.mul(fade);
      this.loadTexture(resolveTexture);
    } else {
      this.material.colorNode = mul(mix(tslColor(data.bladeColor), tslColor(data.tipColor), bend), tint);
      this.material.opacityNode = fade;
    }

    this.mesh = new THREE.InstancedMesh(geometry, this.material, this.count);
    this.mesh.count = 0; // populated on the first recenter, once ground heights are known
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false; // world-space instances; see class doc
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.receiveShadow = true;
    this.mesh.raycast = () => {}; // blades are never click-selectable
    group.add(this.mesh);
  }

  /**
   * Start placing the disc centred on (centerX, centerZ). Nothing on screen
   * changes until `stepPlacement` finishes the walk and commits.
   */
  private beginPlacement(centerX: number, centerZ: number): void {
    const radius = this.data.radius;
    const spacing = this.spacing;
    const gx0 = Math.floor((centerX - radius) / spacing);
    const gx1 = Math.ceil((centerX + radius) / spacing);
    const gz0 = Math.floor((centerZ - radius) / spacing);
    const gz1 = Math.ceil((centerZ + radius) / spacing);
    this.scratchMatrix ??= new Float32Array(this.count * 16);
    this.scratchRandom ??= new Float32Array(this.count * 2);
    this.pending = {
      centerX,
      centerZ,
      gx0,
      gx1,
      gz0,
      gz1,
      // Rows walked OUTWARD from the centre, not top to bottom. The buffer can
      // legitimately fill before the disc is covered (a dense layer clamped at
      // MAX_BLADES), and filling it in raster order leaves the far half of the
      // patch empty behind a straight edge across the middle of the view.
      // Outward order puts any shortfall at the rim, where the distance fade
      // is already dissolving it.
      gzMid: Math.round((gz0 + gz1) / 2),
      rows: gz1 - gz0 + 1,
      n: 0,
      gx: gx0,
      gz: gz0,
      rowActive: false,
      visible: 0,
    };
  }

  /**
   * Walk up to `budget` sample-units of the pending placement, committing it
   * if it finishes. Returns what it spent.
   *
   * A jittered grid ANCHORED TO THE WORLD, walked over the cells the disc
   * covers. Every property of a tuft is a function of its cell, so recentering
   * changes which tufts exist and never where the surviving ones are: the
   * field stops swimming when you turn on the spot. `sampleGrassy` returns
   * null both for unloaded ground AND for ground that isn't the terrain's
   * grassy band — either way, no blade there.
   */
  private stepPlacement(sampleGrassy: FoliageSampler, budget: number): number {
    const p = this.pending;
    if (!p) return 0;
    const spacing = this.spacing;
    const radiusSq = this.data.radius * this.data.radius;
    const matrices = this.scratchMatrix!;
    const random = this.scratchRandom!;
    let spent = 0;
    while (p.n < p.rows && p.visible < this.count) {
      if (!p.rowActive) {
        const gz = p.gzMid + (p.n % 2 === 0 ? p.n / 2 : -((p.n + 1) / 2));
        if (gz < p.gz0 || gz > p.gz1) {
          p.n++;
          continue;
        }
        p.gz = gz;
        p.gx = p.gx0;
        p.rowActive = true;
      }
      const gz = p.gz;
      while (p.gx <= p.gx1 && p.visible < this.count) {
        // checked BEFORE the cell is consumed, so the cursor always points at
        // work not yet done and resuming next frame repeats nothing
        if (spent >= budget) return spent;
        const gx = p.gx++;
        spent += CELL_COST;
        const worldX = (gx + hashCell(gx, gz, 1)) * spacing;
        const worldZ = (gz + hashCell(gx, gz, 2)) * spacing;
        const dx = worldX - p.centerX;
        const dz = worldZ - p.centerZ;
        if (dx * dx + dz * dz > radiusSq) continue;
        const key = cellKey(gx, gz);
        let ground = this.samples.get(key);
        if (ground === undefined) {
          spent += MISS_COST;
          const sampled = sampleGrassy(worldX, worldZ, this.data);
          ground = sampled == null ? NaN : sampled;
          this.remember(key, ground);
        }
        if (Number.isNaN(ground)) continue;
        const scale = 0.7 + 0.6 * hashCell(gx, gz, 3);
        this.tmpPos.set(worldX, ground, worldZ);
        this.tmpQuat.setFromAxisAngle(this.Y_AXIS, hashCell(gx, gz, 4) * Math.PI * 2);
        this.tmpScale.set(scale, scale, scale);
        this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
        this.tmpMat.toArray(matrices, p.visible * 16);
        random[p.visible * 2] = hashCell(gx, gz, 5);
        random[p.visible * 2 + 1] = hashCell(gx, gz, 6);
        p.visible++;
      }
      p.rowActive = false;
      p.n++;
    }
    this.commit(p);
    return spent;
  }

  /** Swap a finished placement onto the mesh — one memcpy, atomic to the eye. */
  private commit(p: PendingPlacement): void {
    (this.mesh.instanceMatrix.array as Float32Array).set(this.scratchMatrix!.subarray(0, p.visible * 16));
    (this.instanceRandom.array as Float32Array).set(this.scratchRandom!.subarray(0, p.visible * 2));
    this.mesh.count = p.visible;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.instanceRandom.needsUpdate = true;
    this.center.set(p.centerX, p.centerZ);
    this.pending = null;
    this.placed = true;
    this.stale = false;
  }

  /** Remember one ground sample, evicting the oldest quarter when full. */
  private remember(key: number, ground: number): void {
    if (this.samples.size >= this.sampleLimit) {
      // Map iterates in insertion order and the working set is the disc around
      // the camera, so the oldest keys are the ground furthest behind it —
      // close enough to LRU for a cache whose misses only cost a resample.
      let drop = Math.max(1, this.sampleLimit >> 2);
      for (const stale of this.samples.keys()) {
        this.samples.delete(stale);
        if (--drop <= 0) break;
      }
    }
    this.samples.set(key, ground);
  }

  /**
   * One axis of the recenter grid, with the deadband from RECENTER_HYSTERESIS.
   *
   * Crossing the boundary is not enough; the camera has to be past it by the
   * margin before the centre jumps, and then it jumps straight to the
   * camera's own cell rather than walking one cell per frame, so a teleport
   * still lands in one step.
   */
  private recenterAxis(value: number, current: number, cell: number): number {
    if (!Number.isFinite(current)) return Math.round(value / cell) * cell;
    if (Math.abs(value - current) <= cell * (0.5 + RECENTER_HYSTERESIS)) return current;
    return Math.round(value / cell) * cell;
  }

  /** Drop cached ground; the terrain under this field may have changed. */
  invalidateGround(): void {
    this.samples.clear();
    // an in-flight placement is now half-sampled from the OLD terrain, and a
    // field already on screen is entirely from it — both have to be redone
    if (this.pending) this.beginPlacement(this.pending.centerX, this.pending.centerZ);
    else if (this.placed) this.stale = true;
  }

  /** `sampleGround` = plain terrain height (any ground, for the camera
   * height-above-ground fade). `sampleGrassy` = terrain height gated to the
   * grassy band only (for blade placement) — see stepPlacement(). */
  update(
    camera: THREE.Camera,
    sampleGround: GroundSampler,
    sampleGrassy: FoliageSampler,
    budget = Number.POSITIVE_INFINITY,
  ): number {
    this.group.updateWorldMatrix(true, false);
    this.mesh.matrix.copy(this.group.matrixWorld).invert();

    camera.getWorldPosition(this.tmpCamPos);
    // While a placement is in flight the centre is NOT reconsidered: letting a
    // moving camera restart the walk every few frames is how an amortised
    // build starves and the field stops following at all. Finish, commit,
    // then re-decide — worst case the field is one build behind.
    if (!this.pending) {
      const cell = Math.max(1, this.data.radius * RECENTER_FRACTION);
      const nextX = this.recenterAxis(this.tmpCamPos.x, this.center.x, cell);
      const nextZ = this.recenterAxis(this.tmpCamPos.z, this.center.y, cell);
      if (nextX !== this.center.x || nextZ !== this.center.y) this.beginPlacement(nextX, nextZ);
      else if (this.stale) this.beginPlacement(this.center.x, this.center.y);
    }
    let spent = 0;
    // The FIRST placement runs to completion regardless of the budget: there
    // is no field on screen to preserve, and an empty world for half a second
    // is worse than one hitch during the load everything else is hitching in.
    if (this.pending) spent = this.stepPlacement(sampleGrassy, this.placed ? budget : Infinity);

    const ground = sampleGround(this.tmpCamPos.x, this.tmpCamPos.z);
    const camHeight = ground == null ? this.data.heightFadeEnd : this.tmpCamPos.y - ground;
    const span = Math.max(0.001, this.data.heightFadeEnd - this.data.heightFadeStart);
    const t = Math.min(1, Math.max(0, (camHeight - this.data.heightFadeStart) / span));
    this.heightFadeUniform.value = 1 - t;
    return spent;
  }

  /**
   * Load the billboard and swap it into the already-wired node graph.
   *
   * The material is built against an empty THREE.Texture up front and the
   * image copied into it on arrival, rather than rewiring colorNode when it
   * lands: a node material recompiles its whole pipeline on any graph change,
   * and doing that per layer mid-frame is a visible hitch.
   */
  private loadTexture(resolve: GrassTextureResolver | undefined): void {
    const assetId = this.data.texture;
    const map = this.mapTexture;
    if (!assetId || !map) return;
    const url = resolve?.(assetId);
    if (!url) {
      console.warn(`[grass] no texture asset "${assetId}" — layer renders untextured`);
      return;
    }
    new THREE.TextureLoader().load(
      url,
      (loaded) => {
        map.image = loaded.image;
        map.colorSpace = THREE.SRGBColorSpace;
        // Pixel art: NEAREST magnification, mipmapped minification. A tuft is
        // a handful of texels on screen past a few metres, and un-mipmapped
        // nearest on a hundred thousand of them is a field of crawling static.
        map.magFilter = THREE.NearestFilter;
        map.minFilter = THREE.NearestMipmapLinearFilter;
        map.generateMipmaps = true;
        map.wrapS = THREE.ClampToEdgeWrapping;
        map.wrapT = THREE.ClampToEdgeWrapping;
        map.needsUpdate = true;
        loaded.dispose();
      },
      undefined,
      (error) => console.warn(`[grass] texture failed to load: ${url}`, error),
    );
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.material.dispose();
    this.mapTexture?.dispose();
    this.samples.clear();
    this.pending = null;
    this.scratchMatrix = null;
    this.scratchRandom = null;
  }
}

/**
 * Data-driven grass host, shaped like ParticleSystem: entities register during
 * buildScene (via BuildOptions.onGrass), the app ticks update() once per frame
 * before renderer.render, passing the camera the frame will be drawn with and
 * a ground-height sampler over whatever terrain is currently loaded.
 */
export class GrassSystem {
  private readonly patches = new Map<string, GrassPatch>();
  /** iteration order for update(), kept beside the map so the hot loop
   * neither allocates nor re-derives it every frame */
  private order: GrassPatch[] = [];
  /** rotating start index, so one patch mid-placement cannot starve the rest */
  private turn = 0;

  register(
    entityId: string,
    group: THREE.Object3D,
    data: GrassData,
    resolveTexture?: GrassTextureResolver,
  ): void {
    this.patches.get(entityId)?.dispose();
    this.patches.set(entityId, new GrassPatch(group, data, resolveTexture));
    this.order = [...this.patches.values()];
  }

  update(camera: THREE.Camera, sampleGround: GroundSampler, sampleGrassy: FoliageSampler): void {
    const patches = this.order;
    if (patches.length === 0) return;
    // ONE budget for the frame, shared: two layers re-placing at once must
    // cost what one does, or a scene with a grass and a fern layer spikes
    // exactly where a single layer was tuned not to
    let left = PLACEMENT_BUDGET;
    this.turn = (this.turn + 1) % patches.length;
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[(this.turn + i) % patches.length]!;
      left -= patch.update(camera, sampleGround, sampleGrassy, Math.max(0, left));
    }
  }

  /**
   * Drop every cached ground sample — the terrain itself has changed.
   *
   * The host owns this call because only the host knows what the samples
   * meant: a world recipe live-edit, a heightmap asset edit, or a swap to a
   * different world/scene all replace the ground under the same (x, z).
   * Cheap and idempotent; the fields on screen re-place themselves.
   */
  invalidateGround(): void {
    for (const patch of this.order) patch.invalidateGround();
  }

  unregister(entityId: string): void {
    this.patches.get(entityId)?.dispose();
    this.patches.delete(entityId);
    this.order = [...this.patches.values()];
  }

  clear(): void {
    for (const patch of this.patches.values()) patch.dispose();
    this.patches.clear();
    this.order = [];
  }
}
