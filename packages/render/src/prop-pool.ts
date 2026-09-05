import * as THREE from "three/webgpu";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { FoliageLodSystem, InstancedPropBatch } from "./foliage-lod.js";
import { InstancedProps } from "./instancing.js";
import { impostorGeometry, impostorInstanceData, type ImpostorInstanceData } from "./impostor.js";
import {
  buildLodProxyGeometry,
  buildMidTier,
  cachedImpostor,
  cachedInstancedMaterial,
  instancedFarProxyMaterial,
  materialLook,
  submeshBounds,
  type BuildOptions,
  type GltfSubmesh,
} from "./scene-builder.js";

/**
 * World-level instanced batches for streamed props, shared across cells.
 *
 * `buildScene` runs once per streamed cell and builds one instanced batch per
 * (model, submesh, LOD tier) for THAT cell. Draw calls therefore scale with
 * resident cells × species × tiers — on the voxel demo 29 near-ring cells of
 * eight species were ~90 draws at rest, 72 of them shadow cascades of the
 * near tiers, for a few thousand triangles of props. Per-cell batching was
 * the right first step (docs/performance-lessons.md, "streamed chunks were
 * never static-batched"), but the cells are small and the species few, so
 * the batches are tiny and many.
 *
 * A pool keeps one set of tiers per (model, node, shadow/LOD flags) — a
 * PAGE of fixed capacity, more pages when one fills — that every cell adds
 * its instances to and removes them from when it unloads. The page is an
 * ordinary `InstancedPropBatch` to the LOD system, just a `dynamic` one: it
 * is registered once, its logical slots come and go, and the compacted tier
 * buffers only ever hold live instances. Draws per species become tiers ×
 * pages, whatever the cell count.
 *
 * What a page gives up is per-cell frustum culling — a page spans the whole
 * near ring, so it is never off-screen. That is cheap here because the LOD
 * tiers already bound the work: the near tier holds only instances within
 * `lodDistance` of the camera wherever they are, and the far tier is four
 * vertices each. A page's bounding sphere is set once, generously, so
 * raycasts still work without recomputing it per change.
 *
 * Ownership is by token, not by cell key: a cell's batch build lands in a
 * glTF promise continuation that may resolve AFTER the cell was unloaded (a
 * fast fly-through), so `add` for a released owner must be a no-op rather
 * than a leak — and the same cell key loads again later under a new token.
 *
 * Deliberately not pooled: entries carrying a `uvRotation` (WFC kit floors,
 * placed content, not scatter) and any build without an owner token (the
 * base scene, single-entity rebuilds) — those keep their per-build batches.
 */

/** Logical slots per page. A near ring of 49 cells at scatter density
 * rarely exceeds a few hundred of one species; a page is 128 KB of matrices
 * per tier, so overshooting is cheap and a second page is rare. */
const PAGE_CAPACITY = 2048;

interface Page {
  batch: InstancedPropBatch;
  ids: (string | undefined)[];
  free: number[];
  used: number;
  impostor: ImpostorInstanceData | undefined;
  nearLocals: THREE.Matrix4[];
}

interface Group {
  key: string;
  assetId: string;
  node: string | undefined;
  submeshes: GltfSubmesh[];
  gltf: GLTF;
  flags: { castShadow: boolean; receiveShadow: boolean; lod: boolean };
  pages: Page[];
}

export interface PoolEntry {
  id: string;
  /** World matrix of the placed entity (the model root's transform). */
  matrix: THREE.Matrix4;
}

export interface PoolStats {
  groups: number;
  pages: number;
  instances: number;
}

export class InstancedPropPool {
  /** Parent every page's meshes under this; the host adds it to the live scene. */
  readonly group = new THREE.Group();
  private readonly groups = new Map<string, Group>();
  private readonly owners = new Map<object, Array<{ page: Page; index: number }>>();
  private readonly released = new WeakSet<object>();

  constructor(private readonly lod: FoliageLodSystem) {
    this.group.name = "prop-pool";
    // pages never move; nothing under here needs the per-frame matrix walk
    this.group.matrixAutoUpdate = false;
  }

  /** Whether `owner` may still add instances — false once released. */
  isLive(owner: object): boolean {
    return !this.released.has(owner);
  }

  /**
   * Place `entries` of one model into the pool on behalf of `owner`. Called
   * by scene-builder in place of building per-build batches. Silently drops
   * entries for an owner already released (a load that outlived its cell).
   */
  add(
    assetId: string,
    node: string | undefined,
    gltf: GLTF,
    submeshes: GltfSubmesh[],
    flags: { castShadow: boolean; receiveShadow: boolean; lod: boolean },
    entries: readonly PoolEntry[],
    owner: object,
    options: BuildOptions,
  ): void {
    if (this.released.has(owner) || entries.length === 0) return;
    const key = `${assetId}#${node ?? ""}#${flags.castShadow ? "s" : "-"}${flags.lod ? "l" : "-"}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { key, assetId, node, submeshes, gltf, flags, pages: [] };
      this.groups.set(key, group);
    }
    let owned = this.owners.get(owner);
    if (!owned) {
      owned = [];
      this.owners.set(owner, owned);
    }
    for (const entry of entries) {
      const page = this.pageWithRoom(group, options);
      const index = page.free.length > 0 ? page.free.pop()! : page.used++;
      const batch = page.batch;
      batch.matrices[index]!.copy(entry.matrix);
      batch.positions[index]!.setFromMatrixPosition(entry.matrix);
      if (page.impostor) {
        const one = impostorInstanceData([entry.matrix]);
        page.impostor.rotations.set(one.rotations, index * 4);
        page.impostor.scales[index] = one.scales[0]!;
      }
      page.ids[index] = entry.id;
      this.lod.addInstance(batch, index);
      owned.push({ page, index });
    }
  }

  /** Free every instance `owner` placed; later `add`s for it are ignored. */
  release(owner: object): void {
    this.released.add(owner);
    const owned = this.owners.get(owner);
    if (!owned) return;
    this.owners.delete(owner);
    for (const { page, index } of owned) {
      this.lod.removeInstance(page.batch, index);
      page.ids[index] = undefined;
      page.free.push(index);
    }
  }

  /** The entity behind a raycast hit on a pool mesh, from the hit's `instanceId` (a compacted tier slot). */
  entityAt(mesh: THREE.Object3D, slot: number): string | undefined {
    const batch = mesh.userData["foliageLodBatch"] as InstancedPropBatch | undefined;
    if (!batch) return undefined;
    for (const group of this.groups.values()) {
      for (const page of group.pages) {
        if (page.batch !== batch) continue;
        const index = this.lod.logicalIndexAt(batch, mesh as InstancedProps, slot);
        return index === undefined ? undefined : page.ids[index];
      }
    }
    return undefined;
  }

  stats(): PoolStats {
    let pages = 0;
    let instances = 0;
    for (const group of this.groups.values()) {
      pages += group.pages.length;
      for (const page of group.pages) instances += page.used - page.free.length;
    }
    return { groups: this.groups.size, pages, instances };
  }

  /** Drop every page (a scene teardown). Owners are all released. */
  dispose(): void {
    for (const group of this.groups.values()) {
      for (const page of group.pages) {
        this.lod.unregister(page.batch);
        for (const mesh of page.batch.near) mesh.dispose();
        if (page.batch.mid) for (const mesh of page.batch.mid) mesh.dispose();
        page.batch.far.dispose();
      }
    }
    this.groups.clear();
    for (const owner of this.owners.keys()) this.released.add(owner);
    this.owners.clear();
    this.group.clear();
  }

  private pageWithRoom(group: Group, options: BuildOptions): Page {
    for (const page of group.pages) {
      if (page.free.length > 0 || page.used < PAGE_CAPACITY) return page;
    }
    const page = this.createPage(group, options);
    group.pages.push(page);
    return page;
  }

  /**
   * One page: the same near/mid/far tiers `instanceGltfInto` builds for a
   * per-build batch (same material, mid-tier and impostor caches, so a page
   * and a base-scene batch of the same model share every shader), sized to
   * PAGE_CAPACITY with no instances placed.
   */
  private createPage(group: Group, options: BuildOptions): Page {
    const { assetId, node, submeshes, gltf, flags } = group;
    const capacity = PAGE_CAPACITY;
    const matrices: THREE.Matrix4[] = [];
    const positions: THREE.Vector3[] = [];
    for (let i = 0; i < capacity; i++) {
      matrices.push(new THREE.Matrix4());
      positions.push(new THREE.Vector3());
    }
    const nearLocals = submeshes.map((sub) => sub.localMatrix);
    const anyLocal = nearLocals.some((m) => !m.equals(IDENTITY));
    const near: InstancedProps[] = submeshes.map((sub, index) => {
      const mesh = new InstancedProps(
        sub.geometry,
        cachedInstancedMaterial(`${assetId}#${node ?? ""}#${index}`, sub.material),
        capacity,
      );
      mesh.castShadow = flags.castShadow;
      mesh.receiveShadow = flags.receiveShadow;
      return mesh;
    });

    let mid: InstancedProps[] | undefined;
    let midError: number | undefined;
    let far: InstancedProps;
    let impostor: ImpostorInstanceData | undefined;
    if (flags.lod) {
      const midTiers = submeshes.map((sub, index) => buildMidTier(`${assetId}#${node ?? ""}#${index}`, sub.geometry));
      if (midTiers.some((t) => t !== null)) {
        mid = submeshes.map((sub, index) => {
          const mesh = new InstancedProps(
            midTiers[index]?.geometry ?? sub.geometry,
            cachedInstancedMaterial(`${assetId}#${node ?? ""}#${index}`, sub.material),
            capacity,
          );
          mesh.castShadow = false;
          mesh.receiveShadow = flags.receiveShadow;
          return mesh;
        });
        midError = submeshes.reduce((worst, sub, index) => {
          const tier = midTiers[index];
          return tier ? Math.max(worst, tier.error * sub.localMatrix.getMaxScaleOnAxis()) : worst;
        }, 0);
      }
      const bounds = submeshBounds(submeshes);
      const source: THREE.Object3D = node ? (gltf.scene.getObjectByName(node) ?? gltf.scene) : gltf.scene;
      const baked = cachedImpostor(assetId, node, source, bounds, options);
      if (baked) {
        far = new InstancedProps(impostorGeometry(bounds, capacity), baked.material, capacity);
        impostor = { rotations: new Float32Array(capacity * 4), scales: new Float32Array(capacity) };
      } else {
        const { geometry, isTall } = buildLodProxyGeometry(submeshes);
        const dominant = submeshes.reduce((a, b) =>
          b.geometry.attributes["position"]!.count > a.geometry.attributes["position"]!.count ? b : a,
        );
        far = new InstancedProps(geometry, instancedFarProxyMaterial(isTall, materialLook(dominant.material)), capacity);
      }
    } else {
      // `lod: false`: no proxy is ever drawn, but the batch shape wants a far
      // mesh — a zero-capacity stand-in that is never added to the scene
      far = new InstancedProps(near[0]!.geometry, near[0]!.material, 1);
    }
    far.castShadow = false;
    far.receiveShadow = flags.receiveShadow;

    const batch: InstancedPropBatch = {
      near,
      ...(mid ? { mid } : {}),
      far,
      positions,
      matrices,
      dynamic: true,
      ...(flags.lod ? {} : { alwaysNear: true }),
      ...(anyLocal ? { localMatrices: nearLocals } : {}),
      ...(midError !== undefined ? { midError } : {}),
      ...(impostor ? { impostor } : {}),
    };
    const meshes = [...near, ...(mid ?? []), ...(flags.lod ? [far] : [])];
    for (const mesh of meshes) {
      mesh.instanceCount = 0;
      mesh.userData["foliageLodBatch"] = batch;
      mesh.userData["propPoolPage"] = true;
      // a page is wherever its instances are: never cull it as a unit, and
      // give raycasts a sphere that always passes
      mesh.frustumCulled = false;
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), POOL_SPHERE_RADIUS);
      this.group.add(mesh);
    }
    this.lod.register(batch);
    return { batch, ids: new Array<string | undefined>(capacity), free: [], used: 0, impostor, nearLocals };
  }
}

const IDENTITY = new THREE.Matrix4();
/** Beyond any world's streamed radius; only the per-instance test after it does work. */
const POOL_SPHERE_RADIUS = 1e6;
