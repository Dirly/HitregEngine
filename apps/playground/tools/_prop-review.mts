import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { propCurationSchema } from '../../../packages/core/src/prop-curation.ts';
import {materialSchema} from '../../../packages/core/src/components/core.ts';
import { propPolicy, curationRevision } from './_prop-curation.mts';
import { writeAtomic } from './_scene-write.mts';
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
function inside(root: string, relative: string) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(s => !s || s === '..'))
        throw Error('Invalid relative path');
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep))
        throw Error('Path escapes project');
    return file;
}
function fingerprinter(policy: ReturnType<typeof propPolicy>) {
    const asset = (relative: string) => { for (const root of policy.roots) {
        const file = inside(path.join(root, 'assets'), relative);
        if (fs.existsSync(file))
            return file;
    } return null; };
    const fingerprintCache = new Map<string, string>();
    function fingerprint(id: string, chain = new Set<string>()): string {
        const cached = fingerprintCache.get(id);
        if (cached)
            return cached;
        if (chain.has(id))
            return 'cycle:' + id;
        const p = policy.prefab(id);
        if (!p)
            return hash('missing:' + id);
        const next = new Set(chain).add(id), parts = [JSON.stringify(p.doc)];
        function dependency(relative: string, parse = false) { const file = asset(relative); if (!file) {
            parts.push('missing:' + relative);
            return;
        } const stat = fs.statSync(file); parts.push(relative + ':' + stat.size + ':' + stat.mtimeMs); if (parse) {
            const d = read(file);
            parts.push(JSON.stringify(d));
            textures(d);
        } }
        function textures(value: unknown) { if (typeof value === 'string' && /\.(png|jpe?g|webp|ktx2)$/i.test(value))
            dependency('textures/' + value);
        else if (value && typeof value === 'object')
            for (const v of Object.values(value))
                textures(v); }
        for (const e of Object.values(p.doc.entities ?? {}) as any[]) {
            const c = e.components ?? {};
            if (c.mesh?.source?.kind === 'asset')
                dependency('models/' + c.mesh.source.assetId);
            if (typeof c.mesh?.material === 'string')
                dependency('materials/' + c.mesh.material + '.json', true);
            if (c.material && typeof c.material === 'object')
                textures(c.material);
        }
        for (const child of policy.children(id))
            parts.push(fingerprint(child, next));
        const result = hash(parts.join('\0'));
        fingerprintCache.set(id, result);
        return result;
    }
    return fingerprint;
}
const catalogCache = new Map<string, any>();
function decorate(catalog: any, policy: ReturnType<typeof propPolicy>, revision: string) {
    return { ...catalog, policy, revision, props: catalog.props.map((row: any) => { const excluded = policy.excluded(row.id); let decision, decisionProject = null; for (const source of policy.decisions) {
            if (source.data.props[row.id]) {
                decision = source.data.props[row.id];
                decisionProject = source.project;
                break;
            }
        } const trashProject=policy.trashed(row.id);return { ...row, excluded: !!excluded, blockedBy: excluded, trashed:!!trashProject,trashProject,decision: decision ?? null, decisionProject, needsReview: !decision || decision.reviewedHash !== row.hash }; }) };
}
function assetKind(declaration:any, exemption:string|null): 'prop'|'module'|'building'|'effect'|'source' {
    const category=declaration.category??'',reason=exemption??'';
    if(category==='building'||/building shell|assembled .*buildings|whole buildings|WFC building shell/i.test(reason))return 'building';
    if(category==='structure'||category==='structural-entrance'||/structural|WFC cells|building (support|roof) modules|construction with the wall pieces/i.test(reason))return 'module';
    if(/shared .*look nested|environment light effect/i.test(reason))return 'effect';
    if(declaration.mount==='part'||/raw models|source surface|not a placeable prop/i.test(reason))return 'source';
    return 'prop';
}
export function propReview(projectsRoot: string, project: string, refresh = true) {
    const policy = propPolicy(projectsRoot, project), ownFile = path.join(projectsRoot, project, 'authoring/prop-curation.json');
    const key = path.resolve(projectsRoot, project), cached = catalogCache.get(key);
    if (cached && !refresh)
        return decorate(cached, policy, curationRevision(ownFile));
    const rows = new Map<string, any>(), warnings: string[] = [];
    const fingerprint = fingerprinter(policy);
    for (const root of policy.roots) {
        const registry = path.join(root, 'authoring/prop-catalogs.json');
        if (!fs.existsSync(registry))
            continue;
        for (const entry of read(registry).catalogs ?? []) {
            try {
                const file = inside(root, entry.path), catalog = read(file), list = catalog[entry.entries];
                if (!Array.isArray(list))
                    continue;
                const sidecar = entry.dressing ? read(inside(root, entry.dressing)).props ?? {} : {};
                for (const row of list) {
                    const ids = entry.prefabIds && typeof row.id === 'string' ? [row.id] : (entry.pathFields ?? []).flatMap((key: string) => typeof row[key] === 'string' && /^assets\/prefabs\/.+\.json$/.test(row[key]) ? [row[key].slice(15, -5)] : []);
                    for (const id of ids) {
                        if (rows.has(id))
                            continue;
                        const p = policy.prefab(id), d = sidecar[id] ?? p?.doc.entities?.[p.doc.root]?.components?.dressing ?? {}, excluded = policy.excluded(id), fingerprintHash = fingerprint(id), local = policy.decisions[0]!.data.props[id];
                        let choice = local, choiceProject = local ? project : undefined;
                        for (const source of policy.decisions.slice(1))
                            if (!choice && source.data.props[id]) {
                                choice = source.data.props[id];
                                choiceProject = source.project;
                            }
                        const exemption=d.exempt??entry.dressingExempt??null,kind=assetKind({...d,category:d.category??row.category},exemption),trashProject=policy.trashed(id);
                        const suffix = id.split('/').pop(), folder = path.posix.dirname(entry.path), candidates = [...(typeof row.review === 'string' && /\.(png|jpe?g|webp)$/i.test(row.review) ? [row.review] : []), `${folder}/reports/prop-${suffix}.png`, `${folder}/reports/${suffix}.png`, `${folder}/renders/${suffix}.png`];
                        const thumbnail = candidates.find(rel => { try {
                            return fs.existsSync(inside(root, rel));
                        }
                        catch {
                            return false;
                        } });
                        rows.set(id, { id, kind,trashed:!!trashProject,trashProject,name: p?.doc.name ?? suffix, collection: id.split('/')[0], sourceProject: p?.project ?? path.basename(root), category: d.category ?? row.category ?? '', rooms: d.rooms ?? [], cultures: d.cultures ?? [], scale: d.scale ?? '', size: d.size ?? row.size ?? [], catalog: entry.path, description: row.design ?? row.description ?? '', available: !!p, exemption, hash: fingerprintHash, excluded: !!excluded, blockedBy: excluded, decision: choice ?? null, decisionProject: choiceProject ?? null, needsReview: !choice || choice.reviewedHash !== fingerprintHash, thumbnail: thumbnail ? `/__hitreg/prop-review/file?project=${encodeURIComponent(path.basename(root))}&path=${encodeURIComponent(thumbnail)}&v=${fingerprintHash}` : null });
                    }
                }
            }
            catch (error) {
                warnings.push(`${entry.path}: ${String(error)}`);
            }
        }
    }
    const result = { project, revision: curationRevision(ownFile), projects: fs.readdirSync(projectsRoot, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(projectsRoot, d.name, 'project.json'))).map(d => d.name).sort(), props: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings };
    catalogCache.set(key, result);
    return { ...result, policy };
}
export function savePropReview(projectsRoot: string, project: string, input: unknown) {
    const request = input as {
        id?: unknown;
        use?: unknown;
        note?: unknown;
        revision?: unknown;
        hash?: unknown;
    };
    if (!request || typeof request.id !== 'string' || !['allow', 'exclude', 'trash', 'reset'].includes(String(request.use)) || typeof request.revision !== 'string' || typeof request.hash !== 'string' || (request.note !== undefined && (typeof request.note !== 'string' || request.note.length > 2000)))
        throw Error('Invalid review choice');
    const catalog = propReview(projectsRoot, project, false), row = catalog.props.find((r: any) => r.id === request.id);
    if (!row)
        throw Error('Unknown catalogued prop');
    const actualHash = fingerprinter(catalog.policy)(request.id);
    if (request.revision !== catalog.revision || request.hash !== row.hash || request.hash !== actualHash) {
        const error = Object.assign(new Error('The catalog changed. Refresh before saving this choice.'), { status: 409 });
        throw error;
    }
    const data = structuredClone(catalog.policy.decisions[0]!.data);
    if (request.use === 'reset')
        delete data.props[request.id];
    else
        data.props[request.id] = { use: request.use as 'allow' | 'exclude' | 'trash', note: String(request.note ?? ''), reviewedHash: row.hash, updatedAt: new Date().toISOString() };
    const validated = propCurationSchema.parse(data), file = path.join(projectsRoot, project, 'authoring/prop-curation.json');
    writeAtomic(file, JSON.stringify(validated, null, 2) + '\n');
    const result = propReview(projectsRoot, project, false);
    return { project: result.project, revision: result.revision, props: result.props, warnings: result.warnings };
}
export function reviewImage(projectsRoot: string, project: string, relative: string) {
    propPolicy(projectsRoot, project);
    if (!relative.startsWith('authoring/') || !/\.(png|jpe?g|webp)$/i.test(relative))
        throw Error('Only authoring review images are served');
    return inside(path.join(projectsRoot, project), relative);
}
/** Only the chosen prefab's dependency graph, using the same scoped asset URLs as the editor. */
export function propPreview(projectsRoot: string, project: string, id: string) {
    const policy = propPolicy(projectsRoot, project), cached = catalogCache.get(path.resolve(projectsRoot, project));
    if (cached && !cached.props.some((p: any) => p.id === id))
        throw Error('Unknown catalogued prop');
    const prefabs: Record<string, any> = {}, materials: Record<string, any> = {}, models: Record<string, string> = {}, textures: Record<string, string> = {}, warnings: string[] = [];
    const assetUrl = (relative: string) => { const stat = fs.statSync(asset(relative)), version = hash(`${relative}:${stat.size}:${stat.mtimeMs}`); return `/__hitreg/asset-file?project=${encodeURIComponent(project)}&file=${encodeURIComponent(relative)}&v=${version}`; };
    const asset = (relative: string) => { for (const root of policy.roots) {
        const file = inside(path.join(root, 'assets'), relative);
        if (fs.existsSync(file)) {
            return file;
        }
    } throw Error('Missing ' + relative); };
    function textureValues(d: unknown) { if (typeof d === 'string' && /\.(png|jpe?g|webp|ktx2)$/i.test(d)) {
        asset('textures/' + d);
        textures[d] = assetUrl('textures/' + d);
    }
    else if (d && typeof d === 'object')
        for (const v of Object.values(d))
            textureValues(v); }
    function visit(pid: string) {
        if (prefabs[pid])
            return;
        const p = policy.prefab(pid);
        if (!p)
            throw Error('Missing prefab ' + pid);
        prefabs[pid] = p.doc;
        for (const e of Object.values(p.doc.entities ?? {}) as any[]) {
            const c = e.components ?? {};
            if (c.mesh?.source?.kind === 'asset') {
                const model = c.mesh.source.assetId;
                asset('models/' + model);
                models[model] = assetUrl('models/' + model);
            }
            if (typeof c.mesh?.material === 'string' && !materials[c.mesh.material]) {
                const mid = c.mesh.material;
                materials[mid] = materialSchema.parse(read(asset('materials/' + mid + '.json')));
                textureValues(materials[mid]);
            }
            if (c.material && typeof c.material === 'object')
                textureValues(c.material);
            if (c.prefab?.prefabId)
                visit(c.prefab.prefabId);
        }
    }
    visit(id);
    return { id, hash: fingerprinter(policy)(id), prefabs, materials, models, textures, warnings };
}
