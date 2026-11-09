/**
 * concept-site — commands on a place's concept SITE manifest (`<zone>/concept/<id>.site.json`, tools/poi-review/
 * concept-site.mjs: the stamp gate 16 checks a concept frame against).
 *
 *   npx tsx tools/concept-site.mts restamp <manifest.site.json> --ruling "YYYY-MM-DD who: why"
 *
 * restamp rewrites the manifest's ground fingerprint with the CURRENT groundFingerprint, never re-rendering, and logs
 * the ruling with the old and new hashes in the manifest's `restamps`. It is for a change of WHAT COUNTS AS GROUND (L
 * o-gates 2026-10-30: NOT_GROUND gained the plant/paint keys, so every stamp hashed with the old key set refused every
 * painted place), never for a moved ground: it REFUSES unless the place's `bare-renders` stage is ok in world order
 * (its local-ground stamp: the terrain, water and roads under the place did not move since the render).
 */
import fs from "node:fs";
import path from "node:path";
import { restampManifest } from "../../../tools/poi-review/concept-site.mjs";
import { evidenceSha, loadStages, matchPlace, requirePlaceStage, saveStages, stagedWorlds } from "./world-order.mts";

const PLAYGROUND = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/** Re-record the place's bare-renders evidence hash after a restamp (the record's time, by and ground stay; a note logs
 *  the ruling). Returns the stages files written. */
export function restampStageEvidence(manifestFile: string, ruling: string, playground = PLAYGROUND): string[] {
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8")), projectDir = path.join(playground, "projects", m.project), out: string[] = [];
  for (const w of typeof m.world === "string" ? [m.world] : stagedWorlds(projectDir)) {
    const doc = loadStages(projectDir, w), p = doc?.places.find((x) => matchPlace(x, m.poi)), r = p?.stages["bare-renders"];
    if (!doc || !r || !r.evidence || path.resolve(projectDir, r.evidence) !== path.resolve(manifestFile)) continue;
    const sha = evidenceSha(manifestFile)!;
    if (r.evidenceSha === sha) continue;
    r.evidenceSha = sha; r.note = [r.note, `restamped (concept-site restamp): ${ruling}`].filter(Boolean).join("; ");
    saveStages(projectDir, doc); out.push(w);
  }
  return out;
}

/** Refusal text, or null when the manifest may be restamped (the place's bare-renders stage is ok on its local ground). */
export function restampRefusal(manifestFile: string, playground = PLAYGROUND): string | null {
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (typeof m?.project !== "string" || typeof m?.poi !== "string") return `${manifestFile}: no project / poi in the manifest`;
  const projectDir = path.join(playground, "projects", m.project);
  const why = requirePlaceStage(projectDir, m.poi, "bare-renders", "concept-site restamp", typeof m.world === "string" ? m.world : undefined);
  // a manifest this command already restamped, whose bare-renders record still holds the pre-restamp file hash: the
  // evidence moved only by the stamp (world order hashes a site manifest without it since 2026-10-30), so it is repaired
  if (why && Array.isArray(m.restamps) && m.restamps.length && /bare-renders \[STALE: evidence [^\]]* changed since it was recorded\]/.test(why)) return null;
  return why ? `${why}\n  (a restamp is only for a key-set change: the ground under the place must provably not have moved)` : null;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, file] = argv, ri = argv.indexOf("--ruling"), ruling = ri >= 0 ? argv[ri + 1] : undefined;
  if (cmd !== "restamp" || !file) { console.error('usage: npx tsx tools/concept-site.mts restamp <manifest.site.json> --ruling "YYYY-MM-DD who: why"'); return 2; }
  const f = path.resolve(file);
  if (!fs.existsSync(f)) { console.error(`concept-site restamp: no manifest ${file}`); return 2; }
  const refuse = restampRefusal(f);
  if (refuse) { console.error(refuse); return 1; }
  try {
    const r = restampManifest(f, ruling, PLAYGROUND);
    for (const w of restampStageEvidence(f, ruling!)) console.log(`  world order ${w}: bare-renders evidence re-hashed (stamp-free manifest hash), ruling noted`);
    console.log(r.changed ? `restamped ${path.basename(f)}: ${r.old?.slice(0, 10)} -> ${r.new.slice(0, 10)} (ruling logged in restamps)` : `${path.basename(f)}: stamp already current (${r.new.slice(0, 10)}), nothing written`);
    return 0;
  } catch (e) { console.error(`concept-site restamp: ${(e as Error).message}`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) process.exit(await main(process.argv.slice(2)));
