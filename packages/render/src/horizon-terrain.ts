import * as THREE from "three/webgpu";
import type { VoxelMesh } from "@hitreg/core";
import { voxelGeometryFromMesh } from "./voxel-geometry.js";

/**
 * The tier past the streamed rings: the whole island as one heightfield mesh, one draw, drawn with the terrain's own
 * material so far land matches near land. It is what lets the world be seen across instead of ending where the far
 * ring ends, and what lets that ring stay small: every streamed cell costs load time, the horizon costs one mesh.
 *
 * Its grid is far coarser than a cell's, so its triangles bridge valleys. Inside the streamed ring it would stand
 * above the real ground, so the vertices there are pushed far below it, on the CPU, when the focus crosses a cell:
 * no material change, so this shares the terrain's shader instead of adding one. Past the ring it sits a few metres
 * low, so the real far cells cover it where they overlap.
 */

/** Grid spacing in metres. */
export const HORIZON_STEP = 32;
/** How far below the true surface it sits everywhere: the far ring's coarse ground must win where they overlap. */
const HORIZON_SINK = 6;
/** Inside the hole, how far down the vertices go. */
const HOLE_DEPTH = 400;
/** The hole stops this many cells short of the ring's edge, so ring cells lagging a moving player leave no gap. */
const HOLE_MARGIN_CELLS = 3;

/** Metres a vertex at `distance` from the focus is lowered, given the hole's radius and the grid spacing. */
export function horizonDrop(distance: number, hole: number, step: number): number {
  if (distance >= hole) return HORIZON_SINK;
  if (distance <= hole - 2 * step) return HOLE_DEPTH;
  const t = (hole - distance) / (2 * step);
  return HORIZON_SINK + (HOLE_DEPTH - HORIZON_SINK) * t;
}

export class HorizonTerrain {
  readonly root = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private surface: Float32Array | null = null;
  private hole: number;
  private lastCell = "";

  /** `ringMetres`: how far the streamed terrain reaches. `cellSize`: the focus is tracked to a cell. */
  constructor(ringMetres: number, private readonly cellSize: number) {
    this.root.name = "horizon";
    this.root.userData["editorOverlay"] = false;
    this.hole = Math.max(0, ringMetres - HOLE_MARGIN_CELLS * cellSize);
  }

  /** The streamed terrain's reach changed (the player's draw distance): the hole follows on the next `update`. */
  setRing(ringMetres: number): void {
    this.hole = Math.max(0, ringMetres - HOLE_MARGIN_CELLS * this.cellSize);
    this.lastCell = "";
  }

  setMesh(data: VoxelMesh, material: THREE.Material): void {
    const geometry = voxelGeometryFromMesh(data);
    if (!geometry) return;
    this.surface = (geometry.getAttribute("position").array as Float32Array).slice();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "horizon-terrain";
    mesh.castShadow = false;
    // cloud shadows ride the sun's shadow term (cloud-shadow.ts): past the cascades it is fully lit, so receiving costs a depth test and keeps the clouds' shade from stopping at a ring around the player
    mesh.receiveShadow = true;
    // one mesh spanning the world: there is no view of it to cull, and its bounds move with the hole
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.mesh = mesh;
    this.root.add(mesh);
    this.lastCell = "";
  }

  /** Follow the focus; does work only when it enters a new cell. */
  update(x: number, z: number): void {
    const mesh = this.mesh, surface = this.surface;
    if (!mesh || !surface) return;
    const cx = Math.round(x / this.cellSize), cz = Math.round(z / this.cellSize);
    const cell = `${cx}_${cz}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    const fx = cx * this.cellSize, fz = cz * this.cellSize;
    const attribute = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const positions = attribute.array as Float32Array;
    for (let i = 0; i < surface.length; i += 3) {
      const dx = surface[i]! - fx, dz = surface[i + 2]! - fz;
      positions[i + 1] = surface[i + 1]! - horizonDrop(Math.sqrt(dx * dx + dz * dz), this.hole, HORIZON_STEP);
    }
    attribute.needsUpdate = true;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.root.removeFromParent();
    this.mesh = null;
    this.surface = null;
  }
}
