/**
 * portal-trip --scene <world scene> --portal <portal entity id> --exit <exit anchor id in the destination scene> [--no-cover]
 *
 * Proves one walk-through portal both ways with a real server-side body (PortalHarness): it stands at the portal's
 * return anchor, walks through the portal, must arrive in the portal's destination scene and stay there, walks out
 * through the exit, and must land back within 4 m of the return anchor. Exit 1 on any failure. No quest is involved.
 *
 * First it runs tools/portal-cover.mts on both doors (the portal in the world scene, the exit in the destination): a
 * trip through a box that does not span its opening proves only the line the harness walked. --no-cover skips it.
 */
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1]! : ""; };
const SCENE = arg("--scene"), PORTAL = arg("--portal"), EXIT = arg("--exit");
if (!SCENE || !PORTAL || !EXIT) { console.error("usage: portal-trip --scene <world scene> --portal <portal id> --exit <exit anchor id>"); process.exit(2); }
import { spawnSync } from "node:child_process";
import { loadContent, playgroundRoots, PortalHarness } from "../../../packages/server/src/index.ts";
const content = loadContent(playgroundRoots("."));
const world = content.scenes.get(SCENE)!;
if (!process.argv.includes("--no-cover")) {
  const destScene = (world.entities[PORTAL]!.components["script"] as { params: { scene: string } }).params.scene;
  for (const [scene, id] of [[SCENE, PORTAL], [destScene, EXIT]] as const) {
    const r = spawnSync(process.execPath, ["--import", "tsx", "tools/portal-cover.mts", "--scene", scene, "--portal", id, "--quiet"], { encoding: "utf8", maxBuffer: 1 << 26 });
    const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
    console.log("cover", line);
    if (r.status !== 0) { console.log(`COVER FAILED: ${id} in ${scene} does not cover its opening (npx tsx tools/portal-cover.mts --scene ${scene} --portal ${id}; --fit to resize)`); process.exit(1); }
  }
}
const worldPos = (id: string): [number, number, number] => {
  let p: [number, number, number] = [0, 0, 0], yaw = 0; const chain: string[] = [];
  for (let k: string | null | undefined = id; k; k = world.entities[k]?.parent) chain.unshift(k);
  for (const k of chain) { const t = (world.entities[k]!.components["transform"] ?? {}) as { position?: number[]; rotation?: number[] }; const q = t.position ?? [0, 0, 0], r = t.rotation ?? [0, 0, 0, 1]; const c = Math.cos(yaw), s = Math.sin(yaw); p = [p[0] + q[0]! * c + q[2]! * s, p[1] + q[1]!, p[2] - q[0]! * s + q[2]! * c]; yaw += 2 * Math.atan2(r[1] ?? 0, r[3] ?? 1); }
  return p;
};
const params = (world.entities[PORTAL]!.components["script"] as { params: { scene: string; returnAnchor: string } }).params;
const DEST = params.scene;
const door = worldPos(PORTAL), porch = worldPos(params.returnAnchor);
console.log("door", door.map((v) => v.toFixed(1)).join(", "), "porch", porch.map((v) => v.toFixed(1)).join(", "));
const h = await PortalHarness.start({ content, scene: SCENE, at: [porch[0], porch[1] + 1.2, porch[2]], yaw: 0, projectScripts: false });
const at = (label: string) => { const p = h.positionOf()!; console.log(label, h.scene, p.map((v) => v.toFixed(2)).join(", ")); };
h.step(150); at("porch");
h.walkTo([door[0] + (porch[0] - door[0]) * 0.45, door[1] + 1.2, door[2] + (porch[2] - door[2]) * 0.45], { within: 0.5 }); at("at the door frame");
const inn = await h.walkThrough(PORTAL); at("arrived");
if (!inn || inn.to !== DEST) { console.log("TRIP FAILED:", JSON.stringify(inn), JSON.stringify(h.refusals)); process.exit(1); }
console.log("trip in", JSON.stringify(inn));
h.step(300); at("5 s after arriving");
if (h.scene !== DEST) { console.log("BOUNCED BACK"); process.exit(1); }
const out = await h.walkThrough(EXIT); at("back");
console.log("trip out", JSON.stringify(out));
h.step(300); at("5 s after returning");
const p = h.positionOf()!;
const ok = !!out && out.to === SCENE && h.scene === SCENE && Math.hypot(p[0] - porch[0], p[2] - porch[2]) < 4;
console.log(ok ? "ROUND TRIP OK" : "RETURN FAILED");
process.exit(ok ? 0 : 1);
