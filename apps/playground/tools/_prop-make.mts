/**
 * Reuse-first prop making for `props.mts`: three ways to get a NEW catalogued prop out of what the project
 * already has, none of which edits a shared prefab, model or texture.
 *
 *   wrap     a thin prefab that nests an existing prop at a scale / yaw / tilt, re-seated so its foot is the
 *            origin (the owner's tent at 1.5, a rack turned to face +Z, a column laid on its side).
 *   variant  the SAME model(s) with another material or new art (a hide over a lean-to frame, a silk pile from
 *            the bone pile). Costs no geometry: only a material and, with --art, a texture.
 *   compose  one prefab assembled by a small recipe from existing props, existing models, engine primitives
 *            with a material (eggs) and flat alpha cards (webs, a stretched hide, a banner).
 *
 * Each writes its prefab under assets/prefabs/<collection>/, a row in authoring/<collection>/catalog.json that
 * records the SOURCE (wraps / variantOf / composedFrom), a draft declaration in authoring/<collection>/dressing.json
 * (kept if one exists), and registers the collection in authoring/prop-catalogs.json. `props.mts` then syncs and
 * the result is checked by `props status` like any other prop.
 */
import fs from "node:fs";
import path from "node:path";
import { prefabGeometry, measure, readJson, locate, prefabFile, type V3 } from "./_prop-geometry.mts";

export interface MakeCtx { project: string; assets: string; registryFile: string }

// ------------------------------------------------------------------ math ----
type Q = [number, number, number, number];
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisQ = (ax: 0 | 1 | 2, deg: number): Q => { const h = (deg * Math.PI) / 360, q: Q = [0, 0, 0, Math.cos(h)]; q[ax] = Math.sin(h); return q; };
/** yaw (about Y) after pitch (about X) after roll (about Z): a tilt is applied in the prop's own frame, then it is turned. */
export const rotQ = (yaw = 0, pitch = 0, roll = 0): Q => qmul(axisQ(1, yaw), qmul(axisQ(0, pitch), axisQ(2, roll))).map((v) => +v.toFixed(6)) as Q;
const rotate = (q: Q, v: V3): V3 => {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const IDENT = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

// ----------------------------------------------------------- collection ----
const collOf = (id: string) => { const k = id.lastIndexOf("/"); if (k < 1) throw Error(`--id must be <collection>/<name>, got "${id}"`); return { coll: id.slice(0, k), name: id.slice(k + 1) }; };
const writeJson = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n"); };

/** authoring/<collection>/{catalog,dressing}.json, registered in prop-catalogs.json (shared: a reusable collection). */
export function ensureCollection(ctx: MakeCtx, coll: string, about: string): { catalog: string; dressing: string } {
  const catalog = `authoring/${coll}/catalog.json`, dressing = `authoring/${coll}/dressing.json`;
  const cf = path.join(ctx.project, catalog), df = path.join(ctx.project, dressing);
  if (!fs.existsSync(cf)) writeJson(cf, { version: 1, about, props: [] });
  if (!fs.existsSync(df)) writeJson(df, { version: 1, collection: `${catalog}#props`, about: "Dressing declarations (compiled onto prefab roots by `props sync`).", props: {} });
  const reg = readJson(ctx.registryFile);
  if (!reg.catalogs.some((c: any) => c.path === catalog)) {
    reg.catalogs.push({ path: catalog, entries: "props", prefabIds: true, dressing, shared: true });
    writeJson(ctx.registryFile, reg);
  }
  return { catalog, dressing };
}
function upsertRow(ctx: MakeCtx, catalog: string, row: Record<string, unknown>) {
  const file = path.join(ctx.project, catalog), doc = readJson(file);
  const k = doc.props.findIndex((r: any) => r.id === row.id);
  if (k >= 0) doc.props[k] = row; else doc.props.push(row);
  doc.props.sort((a: any, b: any) => a.id.localeCompare(b.id));
  writeJson(file, doc);
}
function declare(ctx: MakeCtx, dressing: string, id: string, decl: Record<string, unknown>, force: boolean): "kept" | "written" {
  const file = path.join(ctx.project, dressing), doc = readJson(file);
  if (typeof decl.exempt === "string") decl = { exempt: decl.exempt }; // --decl '{"exempt":"..."}': catalogued, not offered
  const had = doc.props[id];
  if (had && !force) {
    // keep the author's judgment, but the measured size always follows the geometry
    if (!had.exempt && decl.size) { had.size = decl.size; writeJson(file, doc); }
    return "kept";
  }
  doc.props[id] = decl;
  writeJson(file, doc);
  return "written";
}
function sourceDecl(ctx: MakeCtx, src: string): any | null {
  const reg = readJson(ctx.registryFile);
  for (const c of reg.catalogs) {
    if (!c.dressing || !fs.existsSync(path.join(ctx.project, c.dressing))) continue;
    const v = readJson(path.join(ctx.project, c.dressing)).props?.[src];
    if (v && !v.exempt) return JSON.parse(JSON.stringify(v));
  }
  return null;
}
function writePrefab(ctx: MakeCtx, id: string, entities: Record<string, any>, tags: string[]) {
  const name = collOf(id).name;
  const root = { name, parent: null, tags, components: { transform: structuredClone(IDENT) } };
  writeJson(prefabFile(ctx.assets, id), { version: 1, name, root: "root", entities: { root, ...entities }, props: {} });
}
/** Measured foot-centring offset for a prefab's content (so the origin is the bottom centre of its bounds). */
function footOffset(ctx: MakeCtx, id: string): V3 {
  const g = prefabGeometry(ctx.assets, id);
  if (!g.tris.length) throw Error(`${id}: nothing to measure`);
  return [-(g.min[0] + g.max[0]) / 2, -g.min[1], -(g.min[2] + g.max[2]) / 2];
}
/** Shift every child of the root by `d` (keeps their own rotation/scale). */
function shiftChildren(ctx: MakeCtx, id: string, d: V3) {
  const file = prefabFile(ctx.assets, id), doc = readJson(file);
  for (const [k, e] of Object.entries<any>(doc.entities)) {
    if (k === doc.root || e.parent !== doc.root) continue;
    const t = (e.components.transform ??= structuredClone(IDENT));
    t.position = (t.position ?? [0, 0, 0]).map((v: number, i: number) => r3(v + d[i]!));
  }
  writeJson(file, doc);
}
const sizeOf = (ctx: MakeCtx, id: string): V3 => measure(prefabGeometry(ctx.assets, id)).size.map(r3) as V3;

// ------------------------------------------------------------------ wrap ----
export interface WrapOpts { scale?: number; yaw?: number; pitch?: number; roll?: number; decl?: any; force?: boolean; note?: string }
export function wrap(ctx: MakeCtx, src: string, id: string, o: WrapOpts) {
  if (!fs.existsSync(prefabFile(ctx.assets, src))) throw Error(`no prefab ${src}`);
  const { coll } = collOf(id);
  const { catalog, dressing } = ensureCollection(ctx, coll, "Sized and posed WRAPPERS: each nests an existing prop unchanged at the scale/facing it is placed at (props wrap). The source prefab is never edited.");
  const s = o.scale ?? 1, q = rotQ(o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0);
  writePrefab(ctx, id, { art: { name: src.split("/").pop(), parent: "root", tags: [], components: { transform: { position: [0, 0, 0], rotation: q, scale: [s, s, s] }, prefab: { prefabId: src, props: {}, overrides: [] } } } }, ["prop-wrapper"]);
  const off = footOffset(ctx, id);
  shiftChildren(ctx, id, off);
  const size = sizeOf(ctx, id);
  // declaration: the source's own (scaled, its sockets carried through the pose) when it has one
  const base = sourceDecl(ctx, src);
  let decl: any = { mount: "floor", size, against: "free" };
  if (base) {
    decl = { ...base, size };
    const tilted = Math.abs(o.pitch ?? 0) > 1e-6 || Math.abs(o.roll ?? 0) > 1e-6;
    decl.provides = tilted ? [] : (base.provides ?? []).map((sk: any) => {
      const p = rotate(q, sk.position.map((v: number) => v * s) as V3);
      const turned = Math.round(((((o.yaw ?? 0) % 180) + 180) % 180) / 90) === 1;
      return { ...sk, position: [r3(p[0] + off[0]), r3(p[1] + off[1]), r3(p[2] + off[2])], ...(sk.size ? { size: turned ? [r3(sk.size[1] * s), r3(sk.size[0] * s)] : sk.size.map((v: number) => r3(v * s)) } : {}), ...(sk.clearHeight != null && sk.clearHeight < 10 ? { clearHeight: r3(sk.clearHeight * s) } : {}) };
    });
    if (!decl.provides.length) delete decl.provides;
  }
  Object.assign(decl, o.decl ?? {});
  const how = declare(ctx, dressing, id, decl, !!o.force);
  upsertRow(ctx, catalog, { id, status: "draft", role: "wrapper", wraps: src, ...(s !== 1 ? { scale: s } : {}), ...(o.yaw ? { yaw: o.yaw } : {}), ...(o.pitch ? { pitch: o.pitch } : {}), ...(o.roll ? { roll: o.roll } : {}), seat: off.map(r3), size, ...(o.note ? { note: o.note } : {}) });
  return { id, size, offset: off.map(r3), declaration: how };
}

// --------------------------------------------------------------- variant ----
const pngHasAlpha = (file: string) => { const b = fs.readFileSync(file); return b.readUInt8(25) === 6 || b.readUInt8(25) === 4; };
const pngSize = (file: string) => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
/** Install a PNG under textures/<coll>/ (unless it is already there) and return its texture path. */
function installArt(ctx: MakeCtx, coll: string, png: string): string {
  const abs = path.resolve(png), texRoot = path.join(ctx.assets, "textures");
  if (!fs.existsSync(abs)) throw Error(`no art ${png}`);
  if (abs.startsWith(texRoot + path.sep)) return path.relative(texRoot, abs).replaceAll("\\", "/");
  const rel = `${coll}/${path.basename(abs)}`;
  fs.mkdirSync(path.join(texRoot, coll), { recursive: true });
  fs.copyFileSync(abs, path.join(texRoot, rel));
  return rel;
}
/** A material for new art: the replaced part's own settings (emissive lift, roughness) with its maps swapped. */
function artMaterial(ctx: MakeCtx, matId: string, tex: string, baseId: string | undefined, triplanar?: number): void {
  const bf = baseId && locate(ctx.assets, "materials", `${baseId}.json`);
  const base = bf && fs.existsSync(bf) ? readJson(bf) : { shader: "standard", color: "#ffffff", roughness: 1, metalness: 0 };
  const m: any = { ...base, map: tex, filter: "nearest" };
  for (const k of ["normalMap", "roughnessMap", "aoMap", "metalnessMap", "splat", "overlay"]) delete m[k];
  if (base.emissiveMap) m.emissiveMap = tex;
  if (pngHasAlpha(locate(ctx.assets, "textures", tex))) { m.alphaTest = 0.5; m.side = "double"; }
  if (triplanar) { m.triplanar = true; m.triplanarScale = triplanar; m.repeat = [1, 1]; }
  writeJson(path.join(ctx.assets, "materials", `${matId}.json`), m);
}
export interface VariantOpts { material?: string; art?: string; part?: string[]; triplanar?: number; decl?: any; force?: boolean; note?: string }
export function variant(ctx: MakeCtx, src: string, id: string, o: VariantOpts) {
  if (!o.material === !o.art) throw Error("variant needs exactly one of --material <id> | --art <png>");
  const sf = prefabFile(ctx.assets, src);
  if (!fs.existsSync(sf)) throw Error(`no prefab ${src}`);
  const { coll, name } = collOf(id);
  const { catalog, dressing } = ensureCollection(ctx, coll, "VARIANTS: the same model(s) as a catalogued prop with another material or new art (props variant). No new geometry.");
  const doc = readJson(sf), ents: Record<string, any> = structuredClone(doc.entities);
  const rootId = doc.root ?? Object.keys(ents).find((k) => ents[k].parent == null)!;
  const hits = Object.entries(ents).filter(([k, e]) => e.components?.mesh && (!o.part?.length || o.part.includes(k) || o.part.includes(e.name)));
  if (!hits.length) throw Error(`${src}: no mesh entity${o.part ? ` named ${o.part.join("/")}` : ""} to re-skin (a wrapper nests its art: variant the inner prefab, then wrap it)`);
  const oldMats = [...new Set(hits.map(([, e]) => e.components.mesh.material).filter(Boolean))];
  let matId: string, texel: string | undefined;
  if (o.art) {
    const tex = installArt(ctx, coll, o.art);
    matId = `${coll}/${name}`;
    artMaterial(ctx, matId, tex, oldMats[0], o.triplanar);
    const [w] = pngSize(locate(ctx.assets, "textures", tex));
    if (o.triplanar) texel = `${(w! / o.triplanar).toFixed(1)} texels/m (triplanar ${o.triplanar} m per tile)`;
  } else if (o.triplanar) {
    // a tiling material over a model whose UVs are an atlas layout: project it in metres instead
    matId = `${coll}/${name}`;
    const base = readJson(locate(ctx.assets, "materials", `${o.material}.json`));
    writeJson(path.join(ctx.assets, "materials", `${matId}.json`), { ...base, triplanar: true, triplanarScale: o.triplanar, repeat: [1, 1] });
    const t = base.map && locate(ctx.assets, "textures", base.map);
    if (t && fs.existsSync(t)) texel = `${(pngSize(t)[0]! / o.triplanar).toFixed(1)} texels/m (triplanar ${o.triplanar} m per tile)`;
  } else matId = o.material!;
  for (const [, e] of hits) e.components.mesh.material = matId;
  const root = ents[rootId];
  delete root.components.dressing;
  root.name = name;
  root.tags = [...new Set([...(root.tags ?? []), "prop-variant"])];
  writeJson(prefabFile(ctx.assets, id), { ...doc, name, root: rootId, entities: ents });
  const size = sizeOf(ctx, id);
  const base = sourceDecl(ctx, src);
  const decl = { ...(base ?? { mount: "floor", against: "free" }), size, ...(o.decl ?? {}) };
  const how = declare(ctx, dressing, id, decl, !!o.force);
  upsertRow(ctx, catalog, { id, status: "draft", role: "variant", variantOf: src, parts: hits.map(([k]) => k), material: matId, replaces: oldMats, ...(o.art ? { art: o.art.replaceAll("\\", "/") } : {}), ...(o.triplanar ? { triplanar: o.triplanar } : {}), size, ...(o.note ? { note: o.note } : {}) });
  return { id, material: matId, parts: hits.map(([k]) => k), replaces: oldMats, texel, declaration: how };
}

// --------------------------------------------------------------- compose ----
/**
 * Recipe (JSON): { "id": "<collection>/<name>", "name"?, "note"?, "fit"?: true, "declare"?: {dressing fields},
 *   "parts": [ { "prefab": "<prop id>" | "model": "<model asset id>" | "primitive": "<shape>" | "card": "<png or material id>",
 *               "at": [x, y, z],            // foot of the part (primitives and cards sit ON it)
 *               "yaw"?, "pitch"?, "roll"?,   // degrees; a card is upright facing +Z at pitch 0, flat at pitch -90
 *               "scale"?: n | [x, y, z],
 *               "size"?: [x, y, z] (primitive) | [w, h] (card), "material"?: id, "segments"?, "shading"?, "uv"?,
 *               "collider"?: "box" | "trimesh" | "convex" | "none", "name"? } ] }
 */
export function compose(ctx: MakeCtx, recipeFile: string, o: { force?: boolean } = {}) {
  const r = readJson(path.resolve(recipeFile));
  const id: string = r.id, { coll, name } = collOf(id);
  const { catalog, dressing } = ensureCollection(ctx, coll, "COMPOSITES: one prefab built by a recipe (props compose) from existing props and models, engine primitives with a material, and flat alpha cards.");
  const ents: Record<string, any> = {}, from: string[] = [];
  r.parts.forEach((p: any, k: number) => {
    const q = rotQ(p.yaw ?? 0, p.pitch ?? 0, p.roll ?? 0);
    const sc = Array.isArray(p.scale) ? p.scale : [p.scale ?? 1, p.scale ?? 1, p.scale ?? 1];
    const at: V3 = p.at ?? [0, 0, 0];
    const eid = `p${String(k).padStart(2, "0")}-${(p.name ?? p.prefab ?? p.model ?? p.primitive ?? "card").split("/").pop().replace(/\.[a-z]+$/i, "")}`;
    let comps: any;
    if (p.prefab) {
      if (!fs.existsSync(prefabFile(ctx.assets, p.prefab))) throw Error(`part ${k}: no prefab ${p.prefab}`);
      comps = { transform: { position: at, rotation: q, scale: sc }, prefab: { prefabId: p.prefab, props: {}, overrides: [] } };
      from.push(`prefab ${p.prefab}`);
    } else if (p.model) {
      if (!fs.existsSync(locate(ctx.assets, "models", p.model))) throw Error(`part ${k}: no model ${p.model}`);
      comps = { transform: { position: at, rotation: q, scale: sc }, mesh: { source: { kind: "asset", assetId: p.model }, ...(p.material ? { material: p.material } : {}), castShadow: true, receiveShadow: true } };
      if ((p.collider ?? "trimesh") !== "none") comps.collider = { shape: p.collider ?? "trimesh" };
      from.push(`model ${p.model}${p.material ? ` + ${p.material}` : ""}`);
    } else if (p.primitive) {
      const size: V3 = p.size ?? [1, 1, 1];
      // the part sits ON `at`: lift the centre by its (rotated) half height
      const pos: V3 = [at[0], at[1] + (size[1] * sc[1]) / 2, at[2]];
      comps = { transform: { position: pos.map(r3), rotation: q, scale: sc }, mesh: { source: { kind: "primitive", shape: p.primitive, size, ...(p.segments ? { segments: p.segments } : {}), ...(p.shading ? { shading: p.shading } : {}), ...(p.uv ? { uv: p.uv } : {}) }, material: p.material, castShadow: true, receiveShadow: true } };
      if ((p.collider ?? "none") !== "none") comps.collider = { shape: p.collider, size: size.map((v, i) => r3(v * sc[i])) };
      from.push(`primitive ${p.primitive} ${size.join("x")} + ${p.material}`);
    } else if (p.card) {
      const [w, h] = p.size ?? [1, 1];
      let mat: string = p.material;
      if (!mat) {
        if (/\.png$/i.test(p.card)) {
          const tex = installArt(ctx, coll, p.card);
          mat = tex.replace(/\.png$/i, "");
          if (!fs.existsSync(locate(ctx.assets, "materials", `${mat}.json`))) writeJson(path.join(ctx.assets, "materials", `${mat}.json`), { shader: "standard", color: "#ffffff", map: tex, filter: "nearest", roughness: 1, metalness: 0, side: "double", alphaTest: 0.5 });
        } else mat = p.card;
      }
      // a plane is laid flat by the renderer; +90 about X stands it up facing +Z with the art's top up. `at` = bottom centre.
      const cq = rotQ(p.yaw ?? 0, 90 + (p.pitch ?? 0), p.roll ?? 0);
      const up = rotate(cq, [0, 0, -h / 2]); // the card's own -Z (texture top) half-extent
      comps = { transform: { position: [r3(at[0] + up[0]), r3(at[1] + up[1]), r3(at[2] + up[2])], rotation: cq, scale: [1, 1, 1] }, mesh: { source: { kind: "primitive", shape: "plane", size: [w, 0, h] }, material: mat, castShadow: true, receiveShadow: true } };
      from.push(`card ${w}x${h} + ${mat}`);
    } else throw Error(`part ${k}: needs prefab | model | primitive | card`);
    ents[eid] = { name: p.name ?? eid, parent: "root", tags: [], components: comps };
  });
  writePrefab(ctx, id, ents, ["prop-composite"]);
  let off: V3 = [0, 0, 0];
  if (r.fit !== false) { off = footOffset(ctx, id); shiftChildren(ctx, id, off); }
  const size = sizeOf(ctx, id);
  const decl = { mount: "floor", against: "free", ...(r.declare ?? {}), size };
  const how = declare(ctx, dressing, id, decl, !!o.force);
  upsertRow(ctx, catalog, { id, status: "draft", role: "composite", composedFrom: from, recipe: path.relative(ctx.project, path.resolve(recipeFile)).replaceAll("\\", "/"), size, ...(r.note ? { note: r.note } : {}) });
  return { id, size, parts: from.length, offset: off.map(r3), declaration: how };
}
