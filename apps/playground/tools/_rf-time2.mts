/* scratch: meshing time of the written rock-formation volume per node-class removal and voxel size */
import fs from "node:fs";
import { createVolume, buildVolumeMesh } from "@hitreg/core";
const doc = JSON.parse(fs.readFileSync("projects/voxel-demo/assets/volumes/rock-site-river-15-21.json", "utf8"));
const run = (label: string, d: any) => { const v = createVolume(d); const t = performance.now(); const m = buildVolumeMesh(v); console.log(label.padEnd(14), m.triangleCount, (performance.now() - t).toFixed(0), "ms"); };
run("as written", doc);
run("no trim", { ...doc, nodes: doc.nodes.filter((n: any) => n.id !== "trim-buried") });
run("no beds", { ...doc, nodes: doc.nodes.filter((n: any) => !n.id.includes("-bed")) });
run("no sats", { ...doc, nodes: doc.nodes.filter((n: any) => !n.id.includes("-sat")) });
run("no noise", { ...doc, nodes: doc.nodes.map((n: any) => ({ ...n, noise: undefined })) });
run("voxel 1.0", { ...doc, voxelSize: 1 });
