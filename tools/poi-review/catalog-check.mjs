import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const slash = value => value.replaceAll('\\', '/');
const MOUNTS = ['floor', 'wall', 'ceiling', 'surface', 'slot', 'part'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Dressing gate for one catalogued prefab: it needs a placement declaration or an exemption, either in a sidecar
 * registered as its collection's `dressing` or as the collection's `dressingExempt` reason, and the prefab root
 * must carry the declaration (`props sync`). Structural checks only; the full schema and geometry checks
 * (size vs measured bounds, origin, sockets) are `apps/playground/tools/props.mts status`.
 */
export function checkDressing({ id, owners, prefabDoc, readSidecar }) {
  const failures = [];
  let found = null;
  for (const { entry } of owners) {
    if (typeof entry.dressingExempt === 'string' && entry.dressingExempt) { found = { exempt: entry.dressingExempt, source: entry.path }; break; }
    if (typeof entry.dressing === 'string') {
      const value = readSidecar(entry.dressing)?.props?.[id];
      if (value) { found = typeof value.exempt === 'string' ? { exempt: value.exempt, source: entry.dressing } : { declaration: value, source: entry.dressing }; break; }
    }
  }
  if (!found) return { status: 'missing', failures: ["No dressing declaration or exemption; declare it in its collection's dressing sidecar (docs/prop-cataloging.md)"] };
  const rootId = prefabDoc?.root ?? Object.keys(prefabDoc?.entities ?? {}).find(k => prefabDoc.entities[k].parent == null);
  const onPrefab = prefabDoc?.entities?.[rootId]?.components?.dressing;
  if (found.exempt) {
    if (onPrefab) failures.push(`Exempt in ${found.source} but the prefab root still carries a dressing component; run props sync`);
    return { status: 'exempt', reason: found.exempt, source: found.source, failures };
  }
  const d = found.declaration;
  if (!MOUNTS.includes(d.mount)) failures.push(`Dressing mount must be one of ${MOUNTS.join('/')}`);
  if (!Array.isArray(d.size) || d.size.length !== 3 || !d.size.every(v => typeof v === 'number' && v > 0)) failures.push('Dressing size must be three positive metres');
  if (d.mount === 'slot' && !d.slotKind) failures.push('A slot-mounted prop must name its slotKind');
  for (const socket of d.provides ?? []) {
    if (socket.kind === 'slot' && !socket.accepts?.length) failures.push(`Slot socket ${socket.id} accepts nothing`);
    if (socket.kind === 'surface' && !(socket.size?.[0] > 0 && socket.size?.[1] > 0)) failures.push(`Surface socket ${socket.id} needs a size`);
  }
  // in sync: every field the sidecar states equals the prefab's (the prefab also holds the schema defaults)
  const subset = (declared, actual) => declared !== null && typeof declared === 'object'
    ? actual !== null && typeof actual === 'object' && Object.entries(declared).every(([k, v]) => subset(v, actual[k]))
    : same(declared, actual);
  if (!onPrefab) failures.push('Prefab root has no dressing component; run props sync');
  else if (!subset(d, onPrefab)) failures.push(`Prefab root dressing differs from ${found.source}; run props sync`);
  return { status: 'declared', mount: d.mount, source: found.source, failures };
}

/** Coverage/dependency check only. Metadata completeness and art acceptance remain review gates. */
export function checkCatalog({ project, assets, index = 'authoring/prop-catalogs.json' }) {
  const root = path.resolve(project), failures = [], results = [];
  function local(relative) {
    if (typeof relative !== 'string' || !relative) throw Error('Expected a project-relative path');
    const file = path.resolve(root, relative), rel = path.relative(root, file);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw Error(`Path leaves project: ${relative}`);
    return file;
  }
  function key(relative) { return slash(path.relative(root, local(relative))).toLowerCase(); }
  const registry = read(local(index));
  if (registry.version !== 1 || !Array.isArray(registry.catalogs) || !registry.catalogs.length) throw Error('Expected version 1 catalog index with nonempty catalogs');
  if (!Array.isArray(assets) || !assets.length) throw Error('Supply at least one changed runtime asset');
  const owners = new Map(), sidecars = new Map();
  const readSidecar = relative => {
    if (!sidecars.has(relative)) { const file = local(relative); sidecars.set(relative, fs.existsSync(file) ? read(file) : null); }
    return sidecars.get(relative);
  };
  for (const entry of registry.catalogs) {
    const doc = read(local(entry.path)), rows = doc[entry.entries];
    if (!Array.isArray(rows)) throw Error(`Missing array ${entry.entries} in ${entry.path}`);
    if (!entry.prefabIds && !entry.pathFields?.length) throw Error(`Catalog needs prefabIds or pathFields: ${entry.path}`);
    for (const row of rows) {
      const paths = (entry.pathFields ?? []).map(field => row[field]).filter(v => typeof v === 'string');
      if (entry.prefabIds && typeof row.id === 'string') paths.push(`assets/prefabs/${row.id}.json`);
      for (const asset of paths) {
        const k = key(asset), list = owners.get(k) ?? [];
        list.push({ catalog: entry.path, collection: entry.entries, id: row.id ?? asset, row, entry }); owners.set(k, list);
      }
    }
  }
  for (const asset of assets) {
    const file = local(asset), k = key(asset), matches = owners.get(k) ?? [];
    const result = { asset: slash(path.relative(root, file)), catalogs: matches.map(({ row, entry, ...owner }) => owner), dependencies: [], effects: [], failures: [] };
    const fail = message => result.failures.push(message);
    if (!k.startsWith('assets/')) fail('Selected file is not a runtime asset under assets/');
    if (!fs.existsSync(file)) fail('Runtime file is missing');
    if (!matches.length) fail('No entry in a registered prop catalog; catalog this asset before installing it');
    for (const { catalog, row } of matches) if (row.sha256 && fs.existsSync(file)) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (row.sha256 !== actual) fail(`Stale asset hash in ${catalog}: ${row.id ?? asset}`);
    }
    const visited = new Set();
    function dependency(relative) {
      const target = local(relative), normalized = slash(path.relative(root, target));
      if (!result.dependencies.includes(normalized)) result.dependencies.push(normalized);
      if (!fs.existsSync(target)) { fail(`Missing dependency: ${normalized}`); return false; }
      return true;
    }
    function prefab(relative) {
      const id = key(relative); if (visited.has(id)) return; visited.add(id);
      const doc = read(local(relative));
      if (!doc.entities || typeof doc.entities !== 'object') { fail(`Invalid prefab document: ${relative}`); return; }
      for (const entity of Object.values(doc.entities)) {
        const c = entity.components ?? {};
        if (c.mesh?.source?.kind === 'asset') dependency(`assets/models/${c.mesh.source.assetId}`);
        if (typeof c.mesh?.material === 'string') dependency(`assets/materials/${c.mesh.material}.json`);
        if (c.vfx?.effect) {
          dependency(`assets/vfx/${c.vfx.effect}.json`);
          result.effects.push(c.vfx.effect);
        }
        if (typeof c.vfx?.material === 'string') dependency(`assets/materials/${c.vfx.material}.json`);
        if (c.prefab?.prefabId) {
          const nested = `assets/prefabs/${c.prefab.prefabId}.json`;
          if (dependency(nested)) prefab(nested);
        }
      }
    }
    if (k.startsWith('assets/prefabs/') && fs.existsSync(file)) {
      prefab(asset);
      if (matches.length) {
        const id = slash(path.relative(path.join(root, 'assets', 'prefabs'), file)).replace(/.json$/i, '');
        const { failures: dressingFailures, ...dressing } = checkDressing({ id, owners: matches, prefabDoc: read(file), readSidecar });
        result.dressing = dressing;
        for (const message of dressingFailures) fail(message);
      }
      result.effects = [...new Set(result.effects)].sort();
      for (const { row } of matches) {
        const expected = [...(Array.isArray(row.effects) ? row.effects : []), ...(row.fire ? [`env/fire-${row.fire}`] : [])];
        for (const effect of expected) if (!result.effects.includes(effect)) fail(`Catalog declares effect absent from prefab: ${effect}`);
      }
    }
    failures.push(...result.failures.map(message => `${result.asset}: ${message}`));
    results.push(result);
  }
  return { version: 1, passed: failures.length === 0, scope: 'Explicitly supplied changed assets: catalog coverage, available hashes, prefab model/material/VFX/nested-prefab dependencies, and a dressing declaration or exemption on every catalogued prefab. Not metadata, visual, collision or performance acceptance; not an editor import interceptor.', results, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), opts = { assets: [] }; let out;
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`);
      if (flag === '--asset') opts.assets.push(value);
      else if (flag === '--project') opts.project = value;
      else if (flag === '--index') opts.index = value;
      else if (flag === '--out') out = value;
      else throw Error(`Unknown option ${flag}`);
    }
    if (!opts.project) throw Error('Usage: node tools/poi-review/catalog-check.mjs --project PROJECT --asset assets/prefabs/example.json [--asset ...] [--out REPORT]');
    const report = checkCatalog(opts);
    if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
