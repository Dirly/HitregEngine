/**
 * The town design PLAN PICTURE (town-design propose / check / render; also the tests and scratch renders of fixture
 * designs): terraces with levels, bank / wall / stepped edges, streets, squares, stairs and ramps with grades,
 * footprints and doors, the gate and the landmark sightline, the check's verdict. Pure but for the PNG rasteriser.
 */
import fs from "node:fs";
import path from "node:path";
import { encodePng } from "./_png.mjs";
import { densify, lineLength, type DesignReport, type V2 } from "./town-design-check.mts";
import { DESIGN_RULE, type TownDesign } from "./town-design-schema.mts";

export interface PictureSite {
  /** natural ground (the gate's level for a connection from the gate) */
  height: (x: number, z: number) => number;
  /** what the picture shades: the designed ground, or the cut ground with `built` */
  ground: (x: number, z: number) => number;
  sea: number;
  built?: boolean;
}

/** The plan picture as an SVG document (width x height px). */
export async function designPictureSvg(design: TownDesign, report: DesignReport, site: PictureSite): Promise<{ svg: string; width: number; height: number }> {
  const { ground, sea } = site;
  const built = !!site.built;
  // the frame: every terrace, street, connection, the gate + 30 m
  const pts: V2[] = [...design.terraces.flatMap((t) => t.polygon), ...design.streets.flatMap((t) => t.points), ...design.connections.flatMap((c) => c.points), design.gate.at, ...(design.harbour ? [design.harbour] : [])] as V2[];
  const pad = 30;
  const x0 = Math.floor(Math.min(...pts.map((p) => p[0])) - pad), z0 = Math.floor(Math.min(...pts.map((p) => p[1])) - pad);
  const x1 = Math.ceil(Math.max(...pts.map((p) => p[0])) + pad), z1 = Math.ceil(Math.max(...pts.map((p) => p[1])) + pad);
  const mpp = Math.max(0.25, Math.max(x1 - x0, z1 - z0) / 1100);
  const W = Math.ceil((x1 - x0) / mpp), H = Math.ceil((z1 - z0) / mpp);
  const hs = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) hs[i + j * W] = ground(x0 + i * mpp, z0 + j * mpp);
  let lo = Infinity, hi = -Infinity;
  for (const v of hs) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const rgba = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = i + j * W, h = hs[k]!;
      const gx = (hs[Math.min(W - 1, i + 1) + j * W]! - hs[Math.max(0, i - 1) + j * W]!) / (2 * mpp);
      const gz = (hs[i + Math.min(H - 1, j + 1) * W]! - hs[i + Math.max(0, j - 1) * W]!) / (2 * mpp);
      const shade = Math.max(0.35, Math.min(1.15, 0.85 + (-gx * 0.6 - gz * 0.6) * 0.5));
      const t = (h - lo) / Math.max(1, hi - lo);
      let rgb = h < sea ? [70, 110, 150] : [120 + 90 * t, 140 + 60 * t, 95 + 50 * t];
      const contour = Math.floor(h / 2) !== Math.floor(hs[Math.min(W - 1, i + 1) + j * W]! / 2) || Math.floor(h / 2) !== Math.floor(hs[i + Math.min(H - 1, j + 1) * W]! / 2);
      if (contour && h >= sea) rgb = rgb.map((v) => v * 0.78);
      rgba.set([...rgb.map((v) => Math.max(0, Math.min(255, v * (h < sea ? 1 : shade)))), 255], k * 4);
    }
  const png = Buffer.from(encodePng(W, H, rgba)).toString("base64");
  const S = 1 / mpp;
  const P = (p: readonly number[]) => `${((p[0]! - x0) * S).toFixed(1)},${((p[1]! - z0) * S).toFixed(1)}`;
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const levels = design.terraces.map((t) => t.level);
  const lmin = Math.min(...levels), lmax = Math.max(...levels);
  const levelColour = (l: number) => { const t = (l - lmin) / Math.max(1, lmax - lmin); return `rgb(${Math.round(250 - 30 * t)},${Math.round(232 - 110 * t)},${Math.round(150 - 90 * t)})`; };
  const out: string[] = [];
  const panel = 430;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W + panel}" height="${Math.max(H, 700)}" font-family="ui-monospace,Consolas,monospace">`);
  out.push(`<rect width="${W + panel}" height="${Math.max(H, 700)}" fill="#14161a"/>`);
  out.push(`<image href="data:image/png;base64,${png}" width="${W}" height="${H}"/>`);
  // terraces
  for (const t of design.terraces) out.push(`<polygon points="${t.polygon.map(P).join(" ")}" fill="${levelColour(t.level)}" fill-opacity="${built ? 0.25 : 0.55}" stroke="#222" stroke-width="1"/>`);
  for (const tr of (await import("./worldgen-terrace-from-plan.mts")).treadsOf(design, report.edges)) out.push(`<polygon points="${tr.polygon.map(P).join(" ")}" fill="#b08a5a" fill-opacity="0.5" stroke="#5a3d1e" stroke-width="1"/>`);
  // edges
  for (const e of report.edges) {
    if (e.kind === "drop" && e.treatment === "bank") {
      const run = e.drop * DESIGN_RULE.bankRun;
      const q = [e.a, e.b, [e.b[0] + e.normal[0] * run, e.b[1] + e.normal[1] * run], [e.a[0] + e.normal[0] * run, e.a[1] + e.normal[1] * run]];
      out.push(`<polygon points="${q.map(P).join(" ")}" fill="#3d7a3a" fill-opacity="0.35" stroke="none"/>`);
      out.push(`<line x1="${P(e.a).split(",")[0]}" y1="${P(e.a).split(",")[1]}" x2="${P(e.b).split(",")[0]}" y2="${P(e.b).split(",")[1]}" stroke="#2f6b2c" stroke-width="2.5" stroke-dasharray="6 3"/>`);
    } else if (e.kind === "drop") {
      const [ax, ay] = P(e.a).split(","), [bx, by] = P(e.b).split(",");
      out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#5a2f12" stroke-width="${e.treatment === "stepped" ? 7 : 5}"/>`);
      if (e.treatment === "stepped") out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#d9b38c" stroke-width="2"/>`);
    }
    if (e.kind === "drop") {
      const m: V2 = [(e.a[0] + e.b[0]) / 2 + e.normal[0] * 2.5, (e.a[1] + e.b[1]) / 2 + e.normal[1] * 2.5];
      const [mx, my] = P(m).split(",");
      out.push(`<text x="${mx}" y="${my}" font-size="10" fill="#fff" stroke="#000" stroke-width="2.5" paint-order="stroke" text-anchor="middle">${e.treatment === "bank" ? "bank" : e.treatment === "wall" ? "wall" : `${e.tiers}x wall`} ${e.drop}m</text>`);
    }
  }
  // squares, streets, connections
  for (const sq of design.squares) out.push(`<polygon points="${sq.polygon.map(P).join(" ")}" fill="#c9c1b0" fill-opacity="0.7" stroke="#6d665a" stroke-width="1.5" stroke-dasharray="3 2"/>`);
  for (const st of design.streets) {
    out.push(`<polyline points="${st.points.map(P).join(" ")}" fill="none" stroke="#7d7465" stroke-width="${(st.width * S).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.85"/>`);
    out.push(`<polyline points="${st.points.map(P).join(" ")}" fill="none" stroke="#efe6d2" stroke-width="1" stroke-dasharray="4 4"/>`);
    const mid = densify(st.points, 1)[Math.floor(densify(st.points, 1).length / 2)]!;
    const [tx, ty] = P(mid).split(",");
    out.push(`<text x="${tx}" y="${Number(ty) - 4}" font-size="11" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke" text-anchor="middle">${esc(st.name)}</text>`);
  }
  for (const c of design.connections) {
    const lvl = (idv: string) => (idv === "gate" ? site.height(design.gate.at[0], design.gate.at[1]) : design.terraces.find((t) => t.id === idv)?.level ?? 0);
    const rise = lvl(c.to) - lvl(c.from), run = lineLength(c.points);
    out.push(`<polyline points="${c.points.map(P).join(" ")}" fill="none" stroke="${c.kind === "stair" ? "#ffcc33" : "#66e0ff"}" stroke-width="${(c.width * S).toFixed(1)}" stroke-opacity="0.8" stroke-linecap="butt"/>`);
    const e = c.points[c.points.length - 1]!, [ex, ey] = P(e).split(",");
    out.push(`<circle cx="${ex}" cy="${ey}" r="4" fill="#fff" stroke="#000"/>`);
    const m = densify(c.points, 1)[Math.floor(densify(c.points, 1).length / 2)]!, [mx, my] = P(m).split(",");
    out.push(`<text x="${mx}" y="${my}" font-size="10" fill="#000" stroke="#fff" stroke-width="3" paint-order="stroke" text-anchor="middle">${c.kind} ${rise.toFixed(1)}m ${run > 0 ? ((Math.abs(rise) / run) * 100).toFixed(0) : "?"}%</text>`);
  }
  // buildings
  const lm = design.landmark.building;
  for (const b of design.buildings) {
    const f = report.prints.get(b.id);
    if (!f) continue;
    const bad = report.faults.some((x) => x.includes(`${b.id}:`) || x.includes(` ${b.id} `));
    out.push(`<polygon points="${f.ground.map(P).join(" ")}" fill="none" stroke="#ff9f1c" stroke-width="1" stroke-dasharray="3 2"/>`);
    out.push(`<polygon points="${f.corners.map(P).join(" ")}" fill="${b.id === lm ? "#8e6bbf" : "#e8d8b8"}" stroke="${bad ? "#ff2d55" : "#111"}" stroke-width="${bad ? 3 : 1.4}"/>`);
    const [dx, dy] = P(f.front).split(",");
    out.push(`<circle cx="${dx}" cy="${dy}" r="3.2" fill="#fff" stroke="#111" stroke-width="1.2"/>`);
    const [cx, cy] = P(f.centre).split(",");
    out.push(`<text x="${cx}" y="${cy}" font-size="10" fill="#111" text-anchor="middle" dominant-baseline="middle" font-weight="700">${esc(b.name.length > 18 ? b.name.slice(0, 17) + "." : b.name)}</text>`);
  }
  // terrace labels on top
  for (const t of design.terraces) {
    const cx = t.polygon.reduce((a, p) => a + p[0], 0) / t.polygon.length, cz = t.polygon.reduce((a, p) => a + p[1], 0) / t.polygon.length;
    const near = design.buildings.some((b) => Math.hypot(b.at[0] - cx, b.at[1] - cz) < 8);
    const [tx, ty] = P([cx, near ? cz + 10 : cz]).split(",");
    out.push(`<text x="${tx}" y="${ty}" font-size="13" fill="#1a1a1a" stroke="#fff" stroke-width="3" paint-order="stroke" text-anchor="middle" font-weight="700">${esc(t.id)} ${t.level} m</text>`);
  }
  // gate + sightline
  const g = design.gate;
  const [gx, gy] = P(g.at).split(",");
  if (report.landmark) {
    const [lx, ly] = P([report.landmark.top[0], report.landmark.top[2]]).split(",");
    out.push(`<line x1="${gx}" y1="${gy}" x2="${lx}" y2="${ly}" stroke="${report.landmark.visible ? "#35e06b" : "#ff2d55"}" stroke-width="2" stroke-dasharray="8 4"/>`);
    out.push(`<text x="${lx}" y="${Number(ly) - 14}" font-size="16" fill="#ffd54a" stroke="#000" stroke-width="3" paint-order="stroke" text-anchor="middle">&#9733;</text>`);
  }
  const fl = Math.hypot(g.facing[0], g.facing[1]) || 1;
  const tip: V2 = [g.at[0] + (g.facing[0] / fl) * 10, g.at[1] + (g.facing[1] / fl) * 10];
  const [qx, qy] = P(tip).split(",");
  out.push(`<line x1="${gx}" y1="${gy}" x2="${qx}" y2="${qy}" stroke="#ff2d55" stroke-width="3"/><rect x="${Number(gx) - 7}" y="${Number(gy) - 7}" width="14" height="14" fill="#ff2d55" stroke="#fff" stroke-width="2"/>`);
  out.push(`<text x="${Number(gx) + 10}" y="${Number(gy) - 10}" font-size="12" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">GATE</text>`);
  if (design.harbour) { const [hx, hy] = P(design.harbour).split(","); out.push(`<circle cx="${hx}" cy="${hy}" r="7" fill="none" stroke="#66e0ff" stroke-width="3"/><text x="${Number(hx) + 10}" y="${hy}" font-size="12" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">HARBOUR</text>`); }
  // scale bar
  out.push(`<rect x="12" y="${H - 28}" width="${(20 * S).toFixed(1)}" height="6" fill="#fff" stroke="#000"/><text x="12" y="${H - 34}" font-size="11" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">20 m   (x right, z down)</text>`);
  // the panel
  let y = 26;
  const line = (t: string, colour = "#d8dde6", size = 12) => { out.push(`<text x="${W + 14}" y="${y}" font-size="${size}" fill="${colour}">${esc(t)}</text>`); y += size + 5; };
  const wrap = (t: string, colour: string) => { const words = t.split(" "); let cur = ""; for (const w of words) { if ((cur + " " + w).length > 60) { line(cur, colour, 11); cur = "  " + w; } else cur = cur ? cur + " " + w : w; } if (cur) line(cur, colour, 11); };
  line(`${design.title ?? design.name} — ${design.status.toUpperCase()}${built ? " (built ground)" : ""}`, "#ffffff", 16);
  if (design.idea) wrap(design.idea, "#b8c0cc");
  line(`check: ${report.ok ? "OK" : `${report.faults.length} FAULT(S)`}, ${report.warnings.length} warning(s)`, report.ok ? "#35e06b" : "#ff6b6b", 14);
  for (const f of report.faults.slice(0, 14)) wrap(`x ${f}`, "#ff9b9b");
  if (report.faults.length > 14) line(`... ${report.faults.length - 14} more (town-design check)`, "#ff9b9b", 11);
  for (const w of report.warnings.slice(0, 6)) wrap(`! ${w}`, "#ffd27a");
  y += 6;
  for (const f of report.facts.filter((x) => /^(landmark|risers|bearings|kit-fit)/.test(x))) wrap(f, "#9fb3c8");
  y += 8;
  line("legend", "#ffffff", 13);
  const key = (c: string, t: string) => { out.push(`<rect x="${W + 14}" y="${y - 10}" width="16" height="10" fill="${c}"/>`); out.push(`<text x="${W + 36}" y="${y}" font-size="11" fill="#d8dde6">${esc(t)}</text>`); y += 16; };
  key(levelColour(lmin), `terrace (pale low ${lmin} m .. dark high ${lmax} m)`);
  key("#2f6b2c", "bank 1:2 (its run shaded)");
  key("#5a2f12", "retaining wall / stepped (with treads)");
  key("#ffcc33", "stair");
  key("#66e0ff", "ramp");
  key("#7d7465", "street (drawn at its width)");
  key("#e8d8b8", "building; white dot = door; orange dashes = envelope");
  key("#8e6bbf", "landmark; green dashes = sightline from the gate");
  out.push(`</svg>`);
  return { svg: out.join("\n"), width: W + panel, height: Math.max(H, 700) };
}

/** Rasterise the picture to `file` (.png) through headless Chrome; the SVG next to it when no browser runs. Returns the file written. */
export async function writeDesignPicture(pic: { svg: string; width: number; height: number }, file: string): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // @ts-expect-error plain JS module
    const { chromium } = await (await import("./_playwright.mjs")).loadPlaywright();
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: pic.width, height: pic.height } });
    await page.setContent(`<body style="margin:0;background:#14161a">${pic.svg}</body>`);
    await page.screenshot({ path: file });
    await browser.close();
    return file;
  } catch {
    const svgFile = file.replace(/\.png$/, ".svg");
    fs.writeFileSync(svgFile, pic.svg);
    return svgFile;
  }
}
