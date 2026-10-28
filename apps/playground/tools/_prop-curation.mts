/** Shared authoring policy. Read fresh per command/request; never modify source prefabs. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { propCurationSchema, excludedProp, type PropCuration } from '../../../packages/core/src/prop-curation.ts';
import { projectClosure } from './_asset-resolve.mts';
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const safeId = (id: string) => typeof id === 'string' && !path.isAbsolute(id) && !/[\\:\0]/.test(id) && !id.split('/').some(s => !s || s === '..');
export function propPolicy(projectsRoot: string, project: string) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(project) || !fs.existsSync(path.join(projectsRoot, project, 'project.json')))
        throw Error('Unknown project');
    const closure = projectClosure(projectsRoot, project);
    if (!closure)
        throw Error('Unknown project');
    const roots = closure.map(p => path.join(projectsRoot, p));
    const decisions = roots.map(root => { const file = path.join(root, 'authoring/prop-curation.json'); return { project: path.basename(root), data: fs.existsSync(file) ? propCurationSchema.parse(read(file)) : { version: 1, props: {} } as PropCuration }; });
    const prefabCache = new Map<string, {
        file: string;
        doc: any;
        project: string;
    } | null>();
    const prefab = (id: string) => { if (!safeId(id))
        throw Error('Invalid prefab id'); if (prefabCache.has(id))
        return prefabCache.get(id)!; for (const root of roots) {
        const file = path.join(root, 'assets/prefabs', id + '.json');
        if (fs.existsSync(file)) {
            const p = { file, doc: read(file), project: path.basename(root) };
            prefabCache.set(id, p);
            return p;
        }
    } prefabCache.set(id, null); return null; };
    const cache = new Map<string, string[]>();
    const children = (id: string) => { let found = cache.get(id); if (!found) {
        const p = prefab(id);
        found = p ? Object.values(p.doc.entities ?? {}).flatMap((e: any) => e.components?.prefab?.prefabId ? [e.components.prefab.prefabId] : []) : [];
        cache.set(id, found);
    } return found; };
    const hasExclusions = decisions.some(source => Object.values(source.data.props).some(p => p.use === 'exclude' || p.use === 'trash'));
    const trashed = (id: string) => decisions.find(source => source.data.props[id]?.use === 'trash')?.project ?? null;
    const excluded = (id: string) => hasExclusions ? excludedProp(id, decisions, children) : null;
    const assertAllowed = (id: string) => { const why = excluded(id); if (why)
        throw Error(`${id}: excluded from builders by ${why.project} (${why.id})${why.note ? ': ' + why.note : ''}`); };
    return { roots, decisions, prefab, children, excluded, assertAllowed, trashed };
}
export function filterPropIndex<T extends {
    props: any[];
    sets?: any[];
}>(index: T, policy: ReturnType<typeof propPolicy>): T {
    const props = index.props.filter(p => !policy.excluded(p.id)), allowed = new Set(props.map(p => p.id));
    return { ...index, props, sets: (index.sets ?? []).filter(s => (s.props ?? [s.anchor]).every((id: string) => allowed.has(id))) };
}
export function curationRevision(file: string) { return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'none'; }
