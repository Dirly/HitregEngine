import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Resolve the workspace's declared tsx dependency; installed tools are not dependencies.
const require = createRequire(new URL("../../apps/playground/package.json", import.meta.url));
const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
const { volumeDocSchema, createVolume } = await tsImport("../../packages/core/src/voxel/csg.ts", import.meta.url);
const { materialSchema, registerCoreComponents, MAX_SPLAT_LAYERS } = await tsImport("../../packages/core/src/components/core.ts", import.meta.url);
const { ComponentRegistry } = await tsImport("../../packages/core/src/components/registry.ts", import.meta.url);
const { createScene } = await tsImport("../../packages/core/src/scene.ts", import.meta.url);
const { applyOps } = await tsImport("../../packages/core/src/ops.ts", import.meta.url);
const { prefabDocSchema, validatePrefab } = await tsImport("../../packages/core/src/prefab.ts", import.meta.url);
const componentRegistry = new ComponentRegistry();
registerCoreComponents(componentRegistry);

export const MAX_CELLS = 15_000_000;
// Base64 plus the invocation envelope must fit the host's 48 MiB JSON body limit.
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const NAMESPACE = /^[a-z0-9][a-z0-9_-]{0,70}$/;
const ASSET_ID = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function safeAssetId(value, label = "Asset ID") {
  if (typeof value !== "string" || value.length > 160 || !ASSET_ID.test(value) || value.split("/").some(p => RESERVED_SEGMENT.test(p))) {
    throw new Error(`${label} must contain safe lowercase names separated by single forward slashes`);
  }
  return value;
}

function namespace(value) {
  if (typeof value !== "string" || !NAMESPACE.test(value)) {
    throw new Error("Output name must be a lowercase name of 1–71 letters, digits, hyphens or underscores, without folders");
  }
  return safeAssetId(value, "Output name");
}

function meshSlug(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Every mesh group needs a nonempty name");
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 80) throw new Error(`Mesh group ${JSON.stringify(value)} does not produce a safe output name of 1–80 characters`);
  return safeAssetId(slug, `Mesh group ${JSON.stringify(value)}`);
}

function sourcePalette(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SPLAT_LAYERS) {
    throw new Error(`Source palette must contain 1–${MAX_SPLAT_LAYERS} entries`);
  }
  const ids = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim()) throw new Error("Each palette entry needs a nonempty id");
    if (ids.has(entry.id)) throw new Error(`Duplicate palette ID: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(entry.color)) throw new Error(`Palette entry ${entry.id} needs a #rrggbb color`);
    if (entry.roughness !== undefined && (!Number.isFinite(entry.roughness) || entry.roughness < 0 || entry.roughness > 1)) throw new Error(`Palette entry ${entry.id} roughness must be between 0 and 1`);
  }
  // Preserve exporter metadata and role order, including unused palette roles.
  return structuredClone(value);
}

function meshBounds(mesh, voxelSize, maxCells) {
  if (!Array.isArray(mesh.positions) || mesh.positions.length < 12 || mesh.positions.length % 3) throw new Error(`Mesh group ${mesh.name} positions must contain whole XYZ vertices`);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const n = mesh.positions[i], axis = i % 3;
    if (!Number.isFinite(n)) throw new Error(`Mesh group ${mesh.name} contains a nonfinite position`);
    min[axis] = Math.min(min[axis], n);
    max[axis] = Math.max(max[axis], n);
  }
  const first = min.map(n => Math.floor(n / voxelSize) - 3);
  const last = max.map(n => Math.ceil(n / voxelSize) + 3);
  if (![...first, ...last].every(Number.isSafeInteger)) throw new Error(`Mesh group ${mesh.name} coordinates are too large for this voxel size`);
  const bounds = { min: first.map(n => n * voxelSize), max: last.map(n => n * voxelSize) };
  // Match buildVolumeMesh's cell counts exactly, including floating-point ceil.
  const cells = bounds.min.map((n, a) => Math.max(1, Math.ceil((bounds.max[a] - n) / voxelSize)));
  const cellCount = cells.reduce((product, n) => product * n, 1);
  if (!Number.isSafeInteger(cellCount) || cellCount > maxCells) {
    throw new Error(`Mesh group ${mesh.name} needs ${cellCount.toLocaleString("en-US")} cells, exceeding the ${maxCells.toLocaleString("en-US")} limit; split this group or use a larger voxel size`);
  }
  return { bounds, cells, cellCount, sourceBounds: { min, max } };
}

/** Color-only material; palette array order is the mesh's weight-channel order. */
export function paletteMaterial(palette) {
  const layers = palette.map(entry => ({ color: entry.color, roughness: entry.roughness ?? 0.9 }));
  // The splat schema requires >=2 layers. A single-color stamp needs no blend.
  const material = layers.length === 1
    ? { shader: "standard", color: layers[0].color, roughness: layers[0].roughness }
    : { shader: "terrain-splat", splat: { source: "vertex", layers } };
  materialSchema.parse(material);
  return material;
}

/**
 * Convert evaluated, indexed Blender solids to editable native CSG documents.
 * All input coordinates are already engine Y-up, relative to the entrance anchor.
 * This validates/compiles the source solids but does not extract a DC mesh.
 */
export function convertMeshStamp(source, options = {}) {
  const name = namespace(options.name ?? "mesh-import");
  const materialId = safeAssetId(options.materialId ?? `${name}/dc-palette`, "Material ID");
  const voxelSize = options.voxelSize ?? 0.12;
  const maxCells = options.maxCells ?? MAX_CELLS;
  if (!Number.isFinite(voxelSize) || voxelSize <= 0) throw new Error("Voxel size must be a finite positive number");
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > MAX_CELLS) throw new Error(`Cell limit must be an integer between 1 and ${MAX_CELLS}`);
  if (!source || typeof source !== "object" || source.version !== 1) throw new Error("Source must be a version 1 Blender mesh export");
  if (typeof source.name !== "string" || !source.name.trim()) throw new Error("Source needs a nonempty name");
  if (!Array.isArray(source.meshes) || !source.meshes.length) throw new Error("Source must contain at least one mesh group");
  const palette = sourcePalette(source.palette);
  const requested = options.meshNames;
  if (requested !== undefined && (!Array.isArray(requested) || !requested.length || requested.some(n => typeof n !== "string" || !n.trim()) || new Set(requested).size !== requested.length)) {
    throw new Error("Selected mesh names must be a nonempty list of distinct group names");
  }
  const allIds = new Set();
  const groups = source.meshes.map(mesh => {
    if (!mesh || typeof mesh !== "object") throw new Error("Every source mesh group must be an object");
    const id = `${name}/${meshSlug(mesh.name)}`;
    if (allIds.has(id)) throw new Error(`Duplicate output ID ${id}; give mesh groups distinct names`);
    allIds.add(id);
    return { mesh, id };
  });
  for (const wanted of requested ?? []) {
    if (!groups.some(({ mesh }) => mesh.name === wanted)) throw new Error(`Selected mesh group does not exist: ${wanted}`);
  }
  const selected = groups.filter(({ mesh }) => !requested || requested.includes(mesh.name));
  const reports = [];
  const volumes = selected.map(({ mesh, id }) => {
    const measurement = meshBounds(mesh, voxelSize, maxCells);
    if (!Array.isArray(mesh.indices) || !mesh.indices.length || mesh.indices.length % 3) throw new Error(`Mesh group ${mesh.name} indices must contain whole triangles`);
    const triangles = mesh.indices.length / 3;
    if (mesh.triangleMaterials !== undefined && (!Array.isArray(mesh.triangleMaterials) || mesh.triangleMaterials.length !== triangles || mesh.triangleMaterials.some(n => !Number.isInteger(n) || n < 0 || n >= palette.length))) {
      throw new Error(`Mesh group ${mesh.name} triangleMaterials must contain one valid palette index per triangle`);
    }
    const meshData = { positions: [...mesh.positions], indices: [...mesh.indices] };
    if (mesh.solidTriangleCounts !== undefined) meshData.solidTriangleCounts = structuredClone(mesh.solidTriangleCounts);
    if (mesh.triangleMaterials !== undefined) meshData.triangleMaterials = [...mesh.triangleMaterials];
    const doc = {
      name: mesh.name, voxelSize, bounds: measurement.bounds, palette: palette.map(p => p.id),
      nodes: [{ id: "imported-mesh", op: "add", shape: "mesh", position: [0, 0, 0], mesh: meshData }],
    };
    // The engine owns solid/index/winding validation, including overlapping solids.
    // Compile the distance field now; extraction is explicitly a separate stage.
    try {
      volumeDocSchema.parse(doc);
      createVolume(doc);
    } catch (error) {
      throw new Error(`Mesh group ${mesh.name} is not a valid closed solid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    reports.push({ id, name: mesh.name, sourceVertices: mesh.positions.length / 3, sourceTriangles: triangles,
      declaredSolids: mesh.solidTriangleCounts?.length ?? null, ...measurement, sourceValidation: "passed", extraction: "pending" });
    return { id, name: mesh.name, doc, bounds: measurement.bounds, cellCount: measurement.cellCount };
  });
  const ops = [{
    op: "add-entity", id: "root",
    entity: { name: source.name, parent: null, tags: ["mesh-dc"], components: { transform: { position: [0, 0, 0] } } },
  }];
  for (const volume of volumes) {
    const components = {
      transform: { position: [0, 0, 0] },
      mesh: { source: { kind: "csg", volume: volume.id }, material: materialId, castShadow: true, receiveShadow: true },
      collider: { shape: "trimesh" },
    };
    ops.push({
      op: "add-entity", id: `volume-${volume.id.slice(name.length + 1)}`,
      entity: { name: volume.name, parent: "root", tags: ["mesh-dc-volume"], components },
    });
  }
  // Author the complete subtree through the engine's atomic, validated mutation path.
  const { doc: prefabScene } = applyOps(createScene(source.name), ops, componentRegistry);
  const prefab = prefabDocSchema.parse({ ...prefabScene, root: "root", props: {} });
  validatePrefab(prefab);
  const material = { id: materialId, doc: paletteMaterial(palette) };
  const report = {
    version: 1, source: source.name, name, voxelSize, maxCells, materialId,
    anchor: [0, 0, 0], coordinates: "engine-y-up", palette: palette.map(p => p.id),
    sourceGroups: groups.length, selectedGroups: selected.length,
    totalCells: volumes.reduce((sum, v) => sum + v.cellCount, 0),
    volumes: reports, extraction: "pending",
    warnings: ["The first load extracts editable volume geometry and may take time. Check the extracted result before placing gameplay."],
  };
  return { volumes, prefab, palette, material, report };
}
