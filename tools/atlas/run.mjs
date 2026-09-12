/**
 * Host adapter for the registered Armor Atlas tool. The established CLI stays
 * the single importer implementation; this adapter only translates validated
 * tool inputs into files/arguments and translates its artifacts back into the
 * common ToolResult contract.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

const pngBytes = (file) => Buffer.from(file.data, "base64");
const asBase64 = (file) => fs.readFileSync(file).toString("base64");

/**
 * One slot table per key. `manifest-layered` is the armor sheet's — the one
 * where an empty area on the body actually cuts a hole; plain `manifest.json`
 * silently fills every skin cutout. The weapon sheet's is generated beside the
 * key it belongs to, by apps/playground/tools/unwrap-weapon.mjs.
 */
const MANIFESTS = {
  armor: "manifest-layered.json",
  longsword: "manifest-longsword.json",
};

const PRESETS = {
  armor: { size: 256, bleed: 8, filter: "box" },
  longsword: { size: 128, bleed: 3, filter: "box" },
};

/**
 * @param {{ runDir: string, writeAsset(file: string, data: Buffer): string }} context
 * @param {Record<string, any>} inputs
 */
export async function run(context, inputs) {
  const sheet = inputs.sheet ?? "armor";
  const preset = PRESETS[sheet] ?? PRESETS.armor;
  const keyPath = path.join(context.runDir, "key.png");
  const artPath = path.join(context.runDir, "art.png");
  const outputDir = path.join(context.runDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(keyPath, pngBytes(inputs.key));
  fs.writeFileSync(artPath, pngBytes(inputs.art));

  const args = [
    path.join(here, "import-atlas.mjs"),
    "--key",
    keyPath,
    "--art",
    artPath,
    "--manifest",
    path.join(here, MANIFESTS[sheet] ?? MANIFESTS.armor),
    "--out",
    outputDir,
    "--size",
    String(inputs.size ?? preset.size),
    "--bleed",
    String(inputs.bleed ?? preset.bleed),
    "--filter",
    String(inputs.filter ?? preset.filter),
  ];
  if (inputs.slices) args.push("--slices");
  if (inputs.artMargin) args.push("--art-margin");
  if (inputs.skip) args.push("--skip", String(inputs.skip));

  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: here,
    maxBuffer: 4 * 1024 * 1024,
  });

  const requested = String(inputs.name).replace(/\\/g, "/").replace(/\.png$/i, "");
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(requested) || requested.includes("..")) {
    throw new Error("output name must be a safe path below assets/textures");
  }
  const id = `${requested}.png`;
  const assetFile = `textures/${id}`;
  context.writeAsset(assetFile, fs.readFileSync(path.join(outputDir, "atlas.png")));

  const report = JSON.parse(fs.readFileSync(path.join(outputDir, "report.json"), "utf8"));
  return {
    assets: [{ kind: "texture", id, file: assetFile }],
    previews: [
      {
        label: "atlas preview",
        mediaType: "image/png",
        data: asBase64(path.join(outputDir, "atlas-preview.png")),
      },
      {
        label: "atlas",
        mediaType: "image/png",
        data: asBase64(path.join(outputDir, "atlas.png")),
      },
    ],
    warnings: Array.isArray(report.warnings) ? report.warnings.map(String) : [],
    report,
    log: [stdout, stderr].filter(Boolean).join("\n"),
  };
}
