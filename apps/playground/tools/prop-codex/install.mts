/**
 * Install the Codex-made props of world-kit as the `codex-craft/` collection, the town-craft way:
 * designs (authoring/codex-craft/designs/*.py) -> paint preflight -> Blender build (source/*.glb, geometry.json)
 * -> shared town atlas for generic props or a budgeted painted atlas -> prefabs + catalogue
 * rows + dressing sidecar, registered in authoring/prop-catalogs.json -> review cards from the runtime glTFs.
 * The town-craft models re-emitted by the pack must come out byte-identical (checked; a changed page is an error).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from 'node:os';
import { fileURLToPath } from "node:url";
import { runBlender } from "../../../../tools/blender-lock.mjs";
import { applyOps, createScene, ComponentRegistry, registerCoreComponents, dressingSchema, prefabFromSubtree, mergeVocabulary, type Op } from "@hitreg/core";
import { BLENDER, blenderBuild, gateFaults, type GeometryRecord } from "./check.mts";
import {paintingStatus} from './paint.mts';
import {packBuiltProps, PAINTED_ATLAS} from './pack.mts';
import {assertDesignReuse,readReusePolicy} from '../_prop-reuse.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COLLECTION = "codex-craft";
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
const write = (p: string, x: unknown) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(x, null, 2) + "\n"); };

/** What filled each prop: the request it answers (authoring/codex-craft/requests.json, written when a design lands). */
export interface Origin { request: string; project: string; for: string; culture: string; scale: string; tokens?: number | null; seconds?: number; attempts?: number; at?: string;
  /** the request's landmark height, kept here so the install gate survives the request project being archived */
  landmark?: number }
export const dir = (worldKit: string) => path.join(worldKit, "authoring", COLLECTION);
export function readOrigins(worldKit: string): Record<string, Origin> {
  const f = path.join(dir(worldKit), "requests.json");
  return fs.existsSync(f) ? readJson(f).props ?? {} : {};
}
export function writeOrigin(worldKit: string, name: string, o: Origin): void {
  const all = readOrigins(worldKit); all[name] = o;
  write(path.join(dir(worldKit), "requests.json"), { version: 1, about: "Codex-made props: the prop request each answers (props codex).", props: all });
}

/** The shared calm-pool water a Codex prop's `water` disc draws with (world-kit, written once; the shader is the engine's `water`). */
export const POOL_WATER = `${COLLECTION}/pool-water`;
function ensurePoolWater(worldKit: string): string {
  const f = path.join(worldKit, "assets/materials", POOL_WATER + ".json");
  if (!fs.existsSync(f)) write(f, { shader: "water", color: "#3d4a40", transparent: true, opacity: 0.9, water: { depthFadeDistance: 0.5, foamWidth: 0.06, waveAmplitude: 0.003, waveFrequency: 0.6, edgeFadeStart: 200, edgeFadeEnd: 300 } });
  return f;
}
const USE: Record<string, string> = { storage: "storage", tool: "work", trade: "work", light: "light", furniture: "table", bedding: "bed" };

/** The dressing declaration of a built design. */
export function declaration(g: GeometryRecord, o: Origin) {
  return dressingSchema.parse({
    mount: g.mount, origin: g.mount === "wall" ? "back" : g.mount === "ceiling" ? "top" : "foot", contact: g.mount === "wall" ? "wall" : g.mount === "ceiling" ? "hang" : "base", against: g.against ?? "free",
    size: g.size, scale: o.scale, cultures: [...new Set(g.cultures?.length ? g.cultures : [o.culture])], solid: g.solid, setting: g.setting,
    category: g.category, use: g.use ?? [USE[g.category!] ?? "decor"], rooms: g.rooms ?? [], wealth: ["destitute", "poor", "comfortable"],
    themes: [o.culture], fire: false, ...(g.centrepiece ? { centrepiece: true } : {}),
  });
}

export interface InstallResult { built: GeometryRecord[]; failed: GeometryRecord[]; cards: string[]; sheet?: string; packLog: string }

export function install(worldKit: string, opts: { cards?: string[]; sheet?: string; sheetLabels?: string[]; log?: (s: string) => void } = {}): InstallResult {
  const log = opts.log ?? (() => {});
  const D = dir(worldKit), designs = path.join(D, "designs"), source = path.join(D, "source");
  const files = fs.readdirSync(designs).filter((f) => f.endsWith(".py")).sort().map((f) => path.join(designs, f));
  if (!files.length) throw Error(`no designs in ${designs}`);
  const reusePolicy=readReusePolicy(worldKit);
  // A planning build measures named UV regions but never publishes placeholder artwork.
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-prop-preflight-'));
  try {
    const plans=blenderBuild(worldKit,files,scratch,path.join(scratch,'geometry.json'),{paintMode:'plan'});
    for(const g of plans){
      if(g.error)throw Error(`${g.name}: ${g.error}`);
      assertDesignReuse(worldKit,path.join(designs,g.name+'.py'),g,reusePolicy);
      if(g.paintPlan?.surfaces.length){const s=paintingStatus(worldKit,g.name,g.paintPlan);if(!s.ready)throw Error(`${g.name}: ${s.faults.join('; ')}. Use props paint plan/gen/import before install.`);}
    }
  } finally {
    const resolved=path.resolve(scratch),temp=path.resolve(os.tmpdir())+path.sep;
    if(!resolved.startsWith(temp)||!path.basename(resolved).startsWith('hitreg-prop-preflight-'))throw Error('Unexpected prop preflight scratch path');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
  // a removed design must not linger as a source the pack re-reads
  if (fs.existsSync(source)) for (const f of fs.readdirSync(source)) if (f.endsWith(".glb") && !files.some((d) => path.basename(d, ".py") === path.basename(f, ".glb"))) fs.rmSync(path.join(source, f));
  log(`build ${files.length} design(s) in Blender`);
  const records = blenderBuild(worldKit, files, source, path.join(D, "geometry.json"));
  const failed = records.filter((r) => r.error), built = records.filter((r) => !r.error);
  if(failed.length)throw Error(failed.map(g=>`${g.name}: ${g.error}`).join('\n'));
  const origins = readOrigins(worldKit);
  const vocabularyFile=path.join(worldKit,'authoring/dressing/vocabulary.json'),scales=mergeVocabulary(fs.existsSync(vocabularyFile)?readJson(vocabularyFile):undefined).scales;
  for(const g of built.filter(g=>g.paint)){
    const origin=origins[g.name],scale=scales.find(s=>s.id===origin?.scale);
    if(!origin||!scale)throw Error(`${g.name}: missing source origin or scale`);
    // a LANDMARK request (request add --landmark <m>) is gated at its full height, as its design run was (L KNUCKLECROWN 2026-10-28: a 24 m finger-pillar designed as a landmark was refused at install as a 20 m giant-scale prop)
    // c-props 2026-10-29: firstshore was archived (HitRegStudios/projects-archive) and its 24 m finger-pillar fell back to the 20 m giant cap, failing EVERY install: the origin carries the height now, the archive is the legacy fallback
    const reqFile=[path.join(worldKit,'..',origin.project),path.resolve(worldKit,'../../../../../projects-archive',origin.project)].map(p=>path.join(p,'authoring/dressing/prop-requests.json')).find(f=>fs.existsSync(f)),reqs=reqFile?readJson(reqFile):[],lm=origin.landmark??(Array.isArray(reqs)?reqs:reqs.requests??[]).find((r:any)=>r?.id===origin.request)?.landmark;
    const faults=gateFaults(g,{name:g.name,culture:origin.culture,scale:{id:scale.id,height:scale.height},worldKit,...(lm?{landmark:lm}:{})},scales);
    if(faults.length)throw Error(`${g.name}: ${faults.join('; ')}`);
  }

  // pack onto the shared town-craft page; the town-craft models it re-emits must not change
  const tcDir = path.join(worldKit, "assets/models/town-craft");
  const before = new Map((fs.existsSync(tcDir)?fs.readdirSync(tcDir):[]).map((f) => [f, sha(path.join(tcDir, f))]));
  const packMessages:string[]=[];
  packBuiltProps(worldKit,built,s=>{packMessages.push(s);log(s);});
  const packLog=packMessages.join('\n');
  const changed = [...before].filter(([f, h]) => sha(path.join(tcDir, f)) !== h).map(([f]) => f);
  if (changed.length) throw Error(`the pack changed ${changed.length} town-craft model(s) (${changed.slice(0, 4).join(", ")}): the shared page moved; restore them from git and investigate`);
  const townLayout=path.join(worldKit, "assets/textures/atlas/town-craft.atlas.json");
  if (fs.existsSync(townLayout)&&readJson(townLayout).pages !== 1) throw Error(`town-craft atlas exceeds its one-page shared-material budget`);

  // prefabs, catalogue, sidecar
  const reg = new ComponentRegistry(); registerCoreComponents(reg);
  const anyWater = built.some((g) => g.water);
  if (anyWater) ensurePoolWater(worldKit);
  const rows: any[] = [], assets: any[] = [], sidecar: any = { version: 1, props: {} };
  for (const g of built) {
    const o = origins[g.name]; if (!o) throw Error(`${g.name}: no request origin in ${COLLECTION}/requests.json`);
    const id = `${COLLECTION}/${g.name}`, model = `${id}.gltf`, d = declaration(g, o);
    const mesh: any = { transform: {}, mesh: { source: { kind: "asset", assetId: model, textureFilter: "nearest" }, castShadow: true, receiveShadow: true, static: true, renderMode: "instanced", lod: false } };
    if (g.solid) mesh.collider = { shape: "trimesh", friction: 0.7 };
    const ops: Op[] = [
      { op: "add-entity", id: "root", entity: { name: g.name, parent: null, tags: [COLLECTION], components: { transform: {}, dressing: d } } },
      { op: "add-entity", id: "art", entity: { name: `${g.name} mesh`, parent: "root", tags: [], components: mesh } },
    ];
    if (g.water) {
      // a flat engine water disc (the authored-water way: a `water` component beside the mesh that draws the surface)
      const w = g.water, dia = +(w.radius * 2).toFixed(3);
      ops.push({ op: "add-entity", id: "water", entity: { name: `${g.name} water`, parent: "root", tags: ["water"], components: {
        transform: { position: [w.centre[0]!, w.centre[1]! - 0.01, w.centre[2]!] },
        mesh: { source: { kind: "primitive", shape: "cylinder", size: [dia, 0.02, dia], segments: [12, 1] }, material: POOL_WATER, castShadow: false, receiveShadow: false },
        water: { depth: w.depth, swim: false },
      } } });
    }
    const scene = applyOps(createScene(g.name), ops, reg), file = path.join(worldKit, "assets/prefabs", `${id}.json`);
    write(file, prefabFromSubtree(scene.doc, "root", id, g.name).prefab);
    sidecar.props[id] = d;
    const runtime = path.join(worldKit, "assets/models", model);
    rows.push({
      id, status: "provisional", model: `assets/models/${model}`, source: `authoring/${COLLECTION}/designs/${g.name}.py`, sourceSha256: sha(path.join(designs, g.name + ".py")),
      recipe: "apps/playground/tools/prop-codex/build.py (town-craft helpers + role sheet)", sourceModel: `authoring/${COLLECTION}/source/${g.name}.glb`, sourceModelSha256: sha(path.join(source, g.name + ".glb")),
      request: o.request, requestProject: o.project, for: o.for, design: g.design, size: g.size,
      frame: `glTF Y-up metres; ${g.mount === "wall" ? "wall-contact rear, vertically centred" : "bottom-centre foot"} root; front +Z`,
      parts: g.parts, textureRoles: [...new Set((g.parts ?? []).map((p) => p.role))].sort(), triangles: g.triangles, materials: 1, atlas: g.paint ? PAINTED_ATLAS : "town-craft", filter: "nearest",
      ...(g.paint?{painting:{guide:`authoring/${COLLECTION}/paint/${g.name}/key.png`,layout:`authoring/${COLLECTION}/paint/${g.name}/layout.json`,art:`authoring/${COLLECTION}/paint/${g.name}/art.png`,receipt:`authoring/${COLLECTION}/paint/${g.name}/receipt.json`,geometrySha256:g.paint.geometrySha256,artSha256:g.paint.artSha256,atlasSha256:g.paint.atlasSha256,surfaces:g.paint.surfaces.map(({name,part,projection,detail,metres,pixels,texel})=>({name,part,projection,detail,metres,pixels,texel}))}}:{}),
      texelsPerMetre: g.texel, alpha: "opaque; openings are actual geometry", instancing: "one body mesh/material, static instancing", lod: "none",
      collision: g.solid ? "exact static trimesh from published model" : "none (soft)", ...(g.water ? { water: `engine water disc r ${g.water.radius} m, depth ${g.water.depth} m (${POOL_WATER})` } : {}), behavior: "Static decoration; no gameplay.", effects: [],
      review: `authoring/${COLLECTION}/reports/prop-${g.name}.png`, madeBy: "Codex design via props codex (tools/prop-codex)", sha256: sha(file),
    });
    assets.push({ id: model, path: `assets/models/${model}`, sha256: sha(runtime), source: `authoring/${COLLECTION}/source/${g.name}.glb` });
  }
  if (anyWater) assets.push({ id: POOL_WATER, path: `assets/materials/${POOL_WATER}.json`, sha256: sha(path.join(worldKit, "assets/materials", POOL_WATER + ".json")), source: "tools/prop-codex/install.mts (engine water shader, calm pool)" });
  if(built.some(g=>g.paint)){
    const layout=readJson(path.join(worldKit,`assets/textures/atlas/${PAINTED_ATLAS}.atlas.json`));
    for(let i=0;i<layout.pages;i++){const p=`assets/textures/atlas/${PAINTED_ATLAS}-${i}.png`;assets.push({id:p,path:p,sha256:sha(path.join(worldKit,p)),source:'tools/prop-codex/pack.mts'});}
  }
  write(path.join(D, "catalog.json"), {
    version: 1, about: "Props from open requests: simple functional geometry, shared material tiles and optional named hand-painted surfaces.",
    source: { builder: "apps/playground/tools/prop-codex/build.py", helpers: "authoring/town-craft/build.py (helper section)", meshHelper: "authoring/crockin-river-culture/mesh.py", roleSheet: "assets/textures/town-craft/materials.png", painting:'apps/playground/tools/prop-codex/surfaces.py + paint.mts; per-prop provenance receipts', restrictions: "Generated geometry; town-craft role art (see town-craft/art-provenance.json); custom art provenance in each painting receipt." },
    props: rows, assets,
  });
  write(path.join(D, "dressing.json"), sidecar);
  const indexFile = path.join(worldKit, "authoring/prop-catalogs.json"), index = readJson(indexFile);
  for (const row of [
    { path: `authoring/${COLLECTION}/catalog.json`, entries: "props", prefabIds: true, dressing: `authoring/${COLLECTION}/dressing.json`, shared: true },
    { path: `authoring/${COLLECTION}/catalog.json`, entries: "assets", pathFields: ["path"], shared: true },
  ]) if (!index.catalogs.some((x: any) => x.path === row.path && x.entries === row.entries)) index.catalogs.push(row);
  write(indexFile, index);

  // review cards (+ the batch sheet) from the runtime models
  const cardNames = (opts.cards ?? built.map((g) => g.name)).filter((n) => built.some((g) => g.name === n));
  const cards: string[] = [];
  if (cardNames.length) {
    const models = cardNames.map((n) => path.join(worldKit, "assets/models", COLLECTION, n + ".gltf"));
    const args = ["--background", "--factory-startup", "--python", path.join(HERE, "render.py"), "--", "--models", models.join(","), "--cards", path.join(D, "reports")];
    const painted=built.filter(g=>g.paint&&cardNames.includes(g.name)).map(g=>g.name);
    if(painted.length)args.push('--painted',painted.join(','));
    const waters = built.filter((g) => g.water && cardNames.includes(g.name)).map((g) => `${g.name}:${[...g.water!.centre, g.water!.radius].join(",")}`);
    if (waters.length) args.push("--water", waters.join(";"));
    if (opts.sheet) args.push("--sheet", opts.sheet, "--labels", (opts.sheetLabels ?? cardNames).join(","));
    log(`render ${cardNames.length} card(s)${opts.sheet ? " + sheet" : ""}`);
    for(const n of cardNames)for(const p of ['prop',...(painted.includes(n)?['clay','unlit']:[])])fs.rmSync(path.join(D,'reports',`${p}-${n}.png`),{force:true});
    const r = runBlender(BLENDER, args, { encoding: "utf8", maxBuffer: 1 << 26 }, "prop-codex render");
    if(painted.length&&(r.status!==0||painted.some(n=>['prop','clay','unlit'].some(p=>!fs.existsSync(path.join(D,'reports',`${p}-${n}.png`))))))throw Error('Painted prop review renders incomplete: '+String(r.stderr).slice(-600));
    for (const n of cardNames) { const c = path.join(D, "reports", `prop-${n}.png`); if (fs.existsSync(c)) cards.push(c); }
    if (cards.length !== cardNames.length) log(`  render: ${cards.length}/${cardNames.length} cards (exit ${r.status}) ${(r.stderr ?? "").slice(-600)}`);
  }
  return { built, failed, cards, sheet: opts.sheet && fs.existsSync(opts.sheet) ? opts.sheet : undefined, packLog };
}
