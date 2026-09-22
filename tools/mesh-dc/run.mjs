import fs from "node:fs/promises";
import path from "node:path";
import { convertMeshStamp, MAX_SOURCE_BYTES } from "./convert.mjs";

function decodeSource(file) {
  if (!file || typeof file.data !== "string") throw new Error("Choose a valid Blender mesh export JSON file");
  if (file.data.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4) throw new Error("Source export exceeds the 32 MiB limit");
  if (!file.data.length || file.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data)) throw new Error("Choose a valid Blender mesh export JSON file");
  const bytes = Buffer.from(file.data, "base64");
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("Source export exceeds the 32 MiB limit");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Source export is not valid JSON"); }
}

/**
 * Registered host entry. New assets only; all validation and collisions precede writes.
 * The Vite host's writeAsset is synchronous; awaiting also supports async plugin hosts.
 */
export async function run(context, inputs) {
  if (typeof context.assetExists !== "function" || typeof context.writeAsset !== "function") throw new Error("The asset host must provide existence checks and an asset writer");
  const source = decodeSource(inputs.source);
  const options = {
    name: inputs.name, voxelSize: inputs.voxelSize, maxCells: inputs.maxCells,
    materialId: inputs.materialId,
    ...(inputs.group ? { meshNames: [inputs.group] } : {}),
  };
  const result = convertMeshStamp(source, options);
  const outputs = [
    ...result.volumes.map(v => ({ kind: "volume", id: v.id, file: `volumes/${v.id}.json`, doc: v.doc })),
    { kind: "material", id: result.material.id, file: `materials/${result.material.id}.json`, doc: result.material.doc },
    { kind: "prefab", id: `${result.report.name}/stamp`, file: `prefabs/${result.report.name}/stamp.json`, doc: result.prefab },
  ];
  const collisions = outputs.filter(output => context.assetExists(output.file));
  if (collisions.length) throw new Error(`Output already exists: ${collisions.map(o => o.file).join(", ")}. Choose a new output name or material ID.`);
  const encoded = outputs.map(output => ({ ...output, bytes: Buffer.from(JSON.stringify(output.doc, null, 2) + "\n", "utf8") }));
  const compositions = result.volumes.map(volume => ({
    group: volume.name,
    file: path.join(context.runDir, "dc-compositions", volume.id.slice(result.report.name.length + 1) + ".json"),
    materialId: result.material.id,
    recipe: {
      version: 1, name: volume.name, voxelSize: volume.doc.voxelSize, palette: volume.doc.palette,
      instances: [{ id: "structure", volume: volume.doc, position: [0, 0, 0], yaw: 0 }],
      connections: [],
    },
  }));
  const report = { ...result.report, outputs: outputs.map(({ doc, ...asset }) => asset),
    compositions: compositions.map(({ recipe, ...entry }) => entry) };
  await fs.mkdir(context.runDir, { recursive: true });
  await fs.writeFile(path.join(context.runDir, "recipe.json"), JSON.stringify({ version: 1, source, options }, null, 2) + "\n", { flag: "wx" });
  await fs.mkdir(path.join(context.runDir, "dc-compositions"), { recursive: true });
  for (const composition of compositions) {
    await fs.writeFile(composition.file, JSON.stringify(composition.recipe, null, 2) + "\n", { flag: "wx" });
  }
  await fs.writeFile(path.join(context.runDir, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  for (const output of encoded) await context.writeAsset(output.file, output.bytes);
  return {
    assets: report.outputs, previews: [], warnings: report.warnings, report,
    log: `Created ${result.volumes.length} editable volumes and prefab ${result.report.name}/stamp. DC composition recipes are saved in the run's dc-compositions folder. Source solids validated; extraction is pending.`,
  };
}
