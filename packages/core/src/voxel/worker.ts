/** Generation-only entry: browser workers do not load the editor/game/authoring export graph. */
export { createWorldField, type WorldField } from "./field.js";
export { buildVoxelMesh, type VoxelMesh, type VoxelMeshSource } from "./mesh.js";
export { mergeVoxelMeshes } from "./merge.js";
export { voxelChunkDoc, type VoxelChunkOptions } from "./chunk.js";
export type { ChunkDoc } from "../chunks.js";
export type { WorldRecipe } from "./recipe.js";
