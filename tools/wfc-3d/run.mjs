import path from "node:path";
import { collapseTileset, collapsedPrefab, previewSvg } from "./wfc.mjs";

const NAME_RE = /^[a-z0-9][a-z0-9/_-]*$/;

/**
 * @param {{ runDir: string, writeAsset(file: string, data: Buffer): string, assetExists?(file: string): boolean }} context
 * @param {Record<string, any>} inputs
 */
export async function run(context, inputs) {
  const requested = String(inputs.name).replace(/\\/g, "/").replace(/\.json$/i, "");
  if (!NAME_RE.test(requested) || requested.includes("..")) {
    throw new Error("output name must be a safe path below assets/prefabs");
  }

  let rawTileset;
  try {
    rawTileset = JSON.parse(Buffer.from(inputs.tileset.data, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`tileset is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = collapseTileset(rawTileset, {
    width: inputs.width,
    height: inputs.height,
    depth: inputs.depth,
    seed: inputs.seed,
    attempts: inputs.attempts,
  });
  const sourcePrefabIds = [...new Set(
    result.tileset.tiles.map((tile) => tile.prefabId).filter(Boolean),
  )];
  if (sourcePrefabIds.includes(requested)) {
    throw new Error(`output prefab "${requested}" cannot also be one of its WFC source tiles`);
  }
  if (context.assetExists) {
    const missing = sourcePrefabIds.filter((id) => !context.assetExists(`prefabs/${id}.json`));
    if (missing.length > 0) {
      throw new Error(`missing source prefab asset(s): ${missing.join(", ")}`);
    }
  }
  const prefab = collapsedPrefab(result, path.posix.basename(requested), inputs.origin);
  const file = `prefabs/${requested}.json`;
  context.writeAsset(file, Buffer.from(JSON.stringify(prefab, null, 2) + "\n", "utf8"));

  const counts = {};
  for (const cell of result.cells) counts[cell.tileId] = (counts[cell.tileId] ?? 0) + 1;
  const occupied = result.cells.filter((cell) => cell.prefabId).length;
  const svg = previewSvg(result);

  return {
    assets: [{ kind: "prefab", id: requested, file }],
    previews: [{ label: "top layer", mediaType: "image/svg+xml", data: Buffer.from(svg).toString("base64") }],
    warnings: occupied === 0 ? ["the collapse contains only empty tiles; the output prefab has no tile children"] : [],
    report: {
      tileset: result.tileset.name,
      grid: [result.width, result.height, result.depth],
      cellSize: result.tileset.cellSize,
      seed: result.seed,
      solvedOnAttempt: result.attempt,
      variants: result.variants.length,
      occupied,
      empty: result.cells.length - occupied,
      counts,
      output: file,
    },
    log: `collapsed ${result.cells.length} cells (${occupied} prefab instances) on attempt ${result.attempt}; wrote ${file}`,
  };
}
