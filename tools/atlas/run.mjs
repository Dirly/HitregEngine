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
  let custom;
  if(sheet==='prop'){
    if(!inputs.manifest?.data)throw new Error('Custom prop UV guides require the manifest.json produced by props paint plan');
    custom=JSON.parse(Buffer.from(inputs.manifest.data,'base64').toString('utf8'));
    if(![256,512,1024].includes(custom.size)||!Number.isInteger(custom.bleed)||custom.bleed<0||custom.bleed>8||!custom.slots||typeof custom.slots!=='object'||Array.isArray(custom.slots)||Object.keys(custom.slots).length<1||Object.keys(custom.slots).length>32)throw new Error('Invalid custom prop UV manifest: expected a measured square page, bleed and 1–32 named islands');
    for(const [color,slot] of Object.entries(custom.slots))if(!/^#[a-f0-9]{6}$/i.test(color)||!slot||typeof slot.name!=='string'||!slot.name||slot.transparency!==false||slot.cut!==false)throw new Error('Custom prop islands must be named, opaque surfaces with cut:false');
  }
  const preset = custom?{size:custom.size,bleed:custom.bleed,filter:'nearest'}:PRESETS[sheet] ?? PRESETS.armor;
  const keyPath = path.join(context.runDir, "key.png");
  const artPath = path.join(context.runDir, "art.png");
  const outputDir = path.join(context.runDir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(keyPath, pngBytes(inputs.key));
  fs.writeFileSync(artPath, pngBytes(inputs.art));
  const manifestPath=custom?path.join(context.runDir,'manifest.json'):path.join(here, MANIFESTS[sheet] ?? MANIFESTS.armor);
  if(custom)fs.writeFileSync(manifestPath,JSON.stringify(custom));

  const args = [
    path.join(here, "import-atlas.mjs"),
    "--key",
    keyPath,
    "--art",
    artPath,
    "--manifest",
    manifestPath,
    "--out",
    outputDir,
    "--size",
    String(custom?preset.size:inputs.size ?? preset.size),
    "--bleed",
    String(custom?preset.bleed:inputs.bleed ?? preset.bleed),
    "--filter",
    String(custom?preset.filter:inputs.filter ?? preset.filter),
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
