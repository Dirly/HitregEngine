// o-town2 scratch: Bell Strand's real openings for see-through (both gate passages, the boat shed's open front), merged
// into <project>/authoring/see-through-openings.json (entries named "town-1 ..." are replaced)
//   npx tsx tools/_otown2-openings.mts --project <p>
import fs from "node:fs";
const i = process.argv.indexOf("--project"); const P = `projects/${process.argv[i + 1]}`;
const T = `${P}/authoring/towns`;
const kit = JSON.parse(fs.readFileSync(`${T}/town-1-works/kit-wall.json`, "utf8"));
const design = JSON.parse(fs.readFileSync(`${T}/town-1-design.json`, "utf8"));
const lvl = (id: string) => design.terraces.find((t: any) => t.id === id).level as number;
const out: any[] = [];
// a gatehouse is 10.8 x 8.2 m and 15 m tall: its passage is the opening, the box covers the house at any yaw
kit.placements.filter((p: any) => p.kind === "gate").forEach((p: any, k: number) => out.push({ name: `town-1 gate passage ${k + 1} (${p.prefab})`, center: [p.position[0], lvl("town") + 4, p.position[2]], half: [7, 4.5, 7] }));
const bs = design.buildings.find((b: any) => b.id === "boat-shed");
if (bs) out.push({ name: "town-1 boat shed open front (strand-town/strand-boat-shed: 4 cells open to the water)", center: [bs.at[0], lvl("strand") + 3, bs.at[1]], half: [11, 3.5, 11] });
// see-through sites left after the 10-30 rebuild (same world coordinates in the lab and live), each a 1.2 m box at the
// hole: the kit's and the market props' FIX OWED (not openings), and open-lane sky between buildings >= 2.2 m apart
const OWED = "FIX OWED 2026-10-30, not an opening";
const sites: [string, number[]][] = [
  ["town-1 open yard: sky past hovel-6499 (the probe credits the nearest pane; k-town2 found the glass drawn), see-through #7 (o-town2 2026-10-30, coordinator to confirm)", [705.6, 60.6, -289.4]],
  ["town-1 open lane: sky between rowc-2 and the chapel tower, credited to rowc-2 by the probe (not a window fault), see-through #8 (o-town2 2026-10-30, coordinator to confirm)", [646.6, 63.2, -359.3]],
  ["town-1 open yard: sky past shed-6599, credited to the shed by the probe (not a window fault), see-through #10 (o-town2 2026-10-30, coordinator to confirm)", [700.8, 60.1, -335.3]],
  [`town-1 market-trades stall slats (greengrocer / empty-wood-shelter, west square), see-through #15 open-mesh: ${OWED}; owner: market-trades catalogue`, [626.7, 60.5, -366.9]],
  [`town-1 market-trades fishmonger stall slats (east square), see-through #19: ${OWED}; owner: market-trades catalogue`, [649.8, 60.7, -380.8]],
  [`town-1 market-trades fishmonger stall slats (east square), see-through #20: ${OWED}; owner: market-trades catalogue`, [646.8, 60.5, -382.0]],
  ["town-1 open lane: sky between house-s and the smithy (6.6 m apart) framed by the house eave, see-through #1 (o-town2 2026-10-30, coordinator to confirm)", [668.6, 62.7, -389.0]],
  ["town-1 open lane: sky between house-s and row fill-7 / rowd-6 (6.3-8.0 m apart), see-through #2 (o-town2 2026-10-30, coordinator to confirm)", [671.3, 62.3, -375.9]],
  ["town-1 open yard: sky between hovels 6499 / 6524 (3.2 m ground, 2.2 m eaves), see-through #5 (o-town2 2026-10-30, coordinator to confirm)", [706.4, 62.2, -290.6]],
  ["town-1 open lane: sky past house-corner-273 to the main gatehouse (15 m), see-through #11 (o-town2 2026-10-30, coordinator to confirm)", [670.8, 64.5, -330.4]],
  ["town-1 open lane: sky looking up between rowa-166 and the inn (3.1 m ground, 2.3 m eaves), see-through #13/#18 (o-town2 2026-10-30, coordinator to confirm)", [605.0, 67.6, -366.8]],
  ["town-1 open lane: sky between rowd-6, the curtain and the smithy (54 m off), see-through #14 (o-town2 2026-10-30, coordinator to confirm)", [665.8, 64.6, -376.7]],
  ["town-1 open yard: sky between shed-6474, the workshop and shed-6599 (6.3 m apart), see-through #16 (o-town2 2026-10-30, coordinator to confirm)", [700.2, 63.1, -314.3]],
  ["town-1 open lane: sky between house-corner-273 and rowc-19 (6.8 m apart), see-through #21 (o-town2 2026-10-30, coordinator to confirm)", [669.1, 63.0, -341.3]],
  // window panes the probe still sees through (6-8 px; 71 px before see-through.ts compiled its targets): k-town2
  // checked the panes draw in play, so these are owed by the see-through tool, not the kit
  ...[[618.45, 62.36, -401.16], [614.02, 62.16, -405.81], [618.26, 65.62, -362.92], [650.74, 63.08, -338.04]].map((c, k) => [`town-1 window pane seen through by the probe (strand-town WindowGlass in a static batch; draws in play), live #${k + 1}: ${OWED}; owner: tools/see-through (packages/render/src/see-through.ts)`, c] as [string, number[]]),
  // the live route's own samples (live see-through 10-30)
  ["town-1 open lane: sky between the inn and rowc-92 (4.7 m ground, 4.0 m eaves), live see-through #3 (o-town2 2026-10-30, coordinator to confirm)", [623.7, 68.2, -348.3]],
  [`town-1 close ramp (retaining-wall strand-h200-ramp insert): slot between the sloped deck and the wall, live see-through after the chapel re-site (o-town2 2026-10-30 late) #1 seam 114 px: ${OWED}; owner: retaining-wall kit`, [634.05, 60.66, -388.24]],
  [`town-1 close ramp (retaining-wall strand-h200-ramp insert): slot along the deck edge, live see-through after the chapel re-site (o-town2 2026-10-30 late) #2 open-mesh 61 px: ${OWED}; owner: retaining-wall kit`, [634.74, 60.42, -386.08]],
  [`town-1 close ramp (retaining-wall strand-h200-ramp insert): slot along the deck edge, live see-through after the chapel re-site (o-town2 2026-10-30 late) #10 open-mesh 11 px: ${OWED}; owner: retaining-wall kit`, [636.09, 60.78, -387.11]],
  [`town-1 strand-chapel round 5 tower edge slit, live see-through after the chapel re-site (o-town2 2026-10-30 late) #7 open-mesh 15 px: ${OWED}; owner: k-town2 (strand-town chapel)`, [612.47, 72.87, -388.18]],
  [`town-1 strand-chapel round 5 cutout, live see-through after the chapel re-site (o-town2 2026-10-30 late) #8 14 px: ${OWED}; owner: k-town2 (strand-town chapel)`, [609.93, 69.46, -390.59]],
  [`town-1 strand-chapel plinth vs close wall trim seam, live see-through after the chapel re-site (o-town2 2026-10-30 late) #9 11 px: ${OWED}; owner: k-town2 (chapel plinth foot)`, [613.88, 63.8, -386.85]],
  [`town-1 inn corner slit, live see-through after the chapel re-site (o-town2 2026-10-30 late) #3 cutout 32 px: ${OWED}; owner: k-town2 (strand-inn shell)`, [623.23, 62.5, -357.06]],
  [`town-1 inn shell, live see-through after the chapel re-site (o-town2 2026-10-30 late) #14 open-mesh 6 px: ${OWED}; owner: k-town2 (strand-inn shell)`, [624.14, 61.78, -355.6]],
  [`town-1 row fill-7 pane, live see-through after the chapel re-site (o-town2 2026-10-30 late) #4 cutout 29 px: ${OWED}; owner: see-through tool (pane credit) / k-town2`, [653.66, 60.92, -365.18]],
  [`town-1 rowa-93 pane, live see-through after the chapel re-site (o-town2 2026-10-30 late) #6 cutout 16 px: ${OWED}; owner: see-through tool (pane credit) / k-town2`, [635.91, 62.1, -336.75]],
  [`town-1 rowd-6 pane, live see-through after the chapel re-site (o-town2 2026-10-30 late) #11 cutout 9 px: ${OWED}; owner: see-through tool (pane credit) / k-town2`, [670.59, 62.96, -373.47]],
  [`town-1 market-trades stall slats (west square), live see-through after the chapel re-site (o-town2 2026-10-30 late) #5 open-mesh 17 px: ${OWED}; owner: market-trades catalogue`, [624.83, 60.57, -366.12]],
  [`town-1 curtain / rowa-168 meeting seam, live see-through after the chapel re-site (o-town2 2026-10-30 late) #12 7 px: ${OWED}; owner: k-town2 (strand wall kit)`, [592.14, 65.37, -381.51]],
  [`town-1 inn / rowc-94 party-wall seam, live see-through after the chapel re-site (o-town2 2026-10-30 late) #15 6 px: ${OWED}; owner: k-town2 (row party walls)`, [625.63, 69.04, -349.23]],
  [`town-1 rowc-19 / curtain seam, live see-through after the chapel re-site (o-town2 2026-10-30 late) #16 6 px: ${OWED}; owner: k-town2 (strand wall kit)`, [690.29, 65.18, -360.43]],
];
for (const [name, c] of sites) out.push({ name, center: c, half: name.includes("#13/#18") ? [1.5, 3.5, 1.5] : [1.2, 1.2, 1.2] });
const f = `${P}/authoring/see-through-openings.json`;
const prev = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as any[]).filter((o) => !String(o.name).startsWith("town-1 ")) : [];
fs.writeFileSync(f, JSON.stringify([...prev, ...out], null, 1) + "\n");
console.log(`${out.length} town-1 opening(s) -> ${f} (${prev.length} kept)`);
