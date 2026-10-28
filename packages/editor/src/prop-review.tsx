import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {filterReviewProps} from './prop-review-filter.js';
export interface ReviewProp {
    id: string;
    name: string;
    collection: string;
    kind: 'prop' | 'module' | 'building' | 'effect' | 'source';
    trashed: boolean;
    trashProject: string | null;
    sourceProject: string;
    category: string;
    rooms: string[];
    cultures: string[];
    scale: string;
    size: number[];
    description: string;
    hash: string;
    available: boolean;
    exemption: string | null;
    excluded: boolean;
    blockedBy: {
        id: string;
        project: string;
        note: string;
    } | null;
    decision: {
        use: 'allow' | 'exclude' | 'trash';
        note: string;
        reviewedHash: string;
        updatedAt: string;
    } | null;
    decisionProject: string | null;
    needsReview: boolean;
    thumbnail: string | null;
}
export interface ReviewCatalog {
    project: string;
    revision: string;
    projects: string[];
    props: ReviewProp[];
    warnings: string[];
}
export interface PropReviewHost {
    initialProject: string;
    load(project: string): Promise<ReviewCatalog>;
    save(project: string, row: ReviewProp, use: 'allow' | 'exclude' | 'trash' | 'reset', note: string, revision: string): Promise<Omit<ReviewCatalog, 'projects'>>;
    thumbnail(project: string, row: ReviewProp, signal: AbortSignal): Promise<string>;
    preview(project: string, row: ReviewProp, canvas: HTMLCanvasElement): Promise<() => void>;
}
function Thumbnail({ row, project, host }: {
    row: ReviewProp;
    project: string;
    host: PropReviewHost;
}) {
    const [url, setUrl] = useState(row.thumbnail ?? ''), [error, setError] = useState(''), ref = useRef<HTMLDivElement>(null);
    useEffect(() => { let active = true; const controller = new AbortController(); setError(''); setUrl(row.thumbnail ?? ''); if (row.thumbnail)
        return; const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) {
        observer.disconnect();
        void host.thumbnail(project, row, controller.signal).then(url => { if (active)
            setUrl(url); }).catch(e => { if (active)
            setError(String(e)); });
    } }, { rootMargin: '120px' }); if (ref.current)
        observer.observe(ref.current); return () => { active = false; controller.abort(); observer.disconnect(); }; }, [row.id, row.hash, row.thumbnail, project, host]);
    return <div className="pr-image" ref={ref}>{url ? <img src={url} alt={row.name} loading="lazy" onError={() => { setUrl(''); setError('Review image unavailable'); }}/> : <span className={error ? 'pr-preview-error' : 'pr-loading'}>{error ? 'Preview unavailable' : 'Loading preview…'}</span>}</div>;
}
function LivePreview({ row, project, host }: {
    row: ReviewProp;
    project: string;
    host: PropReviewHost;
}) {
    const ref = useRef<HTMLCanvasElement>(null), [error, setError] = useState(''), [ready, setReady] = useState(false);
    useEffect(() => { let active = true, dispose: (() => void) | undefined; setError(''); setReady(false); void host.preview(project, row, ref.current!).then(fn => { if (active) {
        dispose = fn;
        setReady(true);
    }
    else
        fn(); }).catch(e => { if (active)
        setError(String(e)); }); return () => { active = false; dispose?.(); }; }, [host, row.id, row.hash, project]);
    return <div className="pr-live"><canvas ref={ref} aria-label={`3D preview of ${row.name}`}/>{!ready && <span className="pr-live-status">{error || 'Loading 3D model…'}</span>}{ready && <span className="pr-orbit-hint">Drag to orbit · scroll to zoom</span>}</div>;
}
function PropReview({ host }: {
    host: PropReviewHost;
}) {
    const [project, setProject] = useState(host.initialProject), [catalog, setCatalog] = useState<ReviewCatalog | null>(null), [query, setQuery] = useState(''), [collection, setCollection] = useState(''), [state, setState] = useState('all'), [category, setCategory] = useState(''), [culture, setCulture] = useState(''), [page, setPage] = useState(0), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [note, setNote] = useState(''), [orbit, setOrbit] = useState(false);
    const [undo, setUndo] = useState<{
        id: string;
        decision: ReviewProp['decision'];
    } | null>(null), [advance, setAdvance] = useState(true);
    const selectedRef = useRef<HTMLButtonElement>(null), gridRef = useRef<HTMLDivElement>(null);
    useEffect(() => { let active = true; setError(''); setCatalog(null); setSelected(''); setPage(0); setUndo(null); setOrbit(false); void host.load(project).then(data => { if (active) {
        setCatalog(data);
        const url = new URL(location.href);
        url.searchParams.set('project', project);
        history.replaceState(null, '', url);
    } }).catch(e => { if (active)
        setError(String(e)); }); return () => { active = false; }; }, [host, project]);
    const all = catalog?.props ?? [];
    const [kind,setKind]=useState('prop');
    const filterRows = (rows: ReviewProp[]) => filterReviewProps(rows,{query,kind,collection,category,culture,state});
    const filtered = useMemo(() => filterRows(all), [all, query, kind,collection, category, culture, state]);
    const pages = Math.max(1, Math.ceil(filtered.length / 30)), currentPage = Math.min(page, pages - 1), visible = filtered.slice(currentPage * 30, (currentPage + 1) * 30), row = all.find(p => p.id === selected), selectedIndex = filtered.findIndex(p => p.id === selected);
    useEffect(() => { setPage(0); }, [query,kind,collection,state,category,culture]);
    useEffect(() => { setNote(row?.decision?.note ?? ''); }, [selected, row?.decision?.note]);
    useEffect(() => { setOrbit(false); }, [selected, row?.hash]);
    const choose = (id: string) => { setSelected(id); setNotice(''); };
    const navigate = (delta: number) => { if (!filtered.length)
        return; const index = Math.max(0, Math.min(filtered.length - 1, (selectedIndex < 0 ? (delta > 0 ? -1 : filtered.length) : selectedIndex) + delta)); setSelected(filtered[index]!.id); setPage(Math.floor(index / 30)); };
    async function save(use: 'allow' | 'exclude' | 'trash' | 'reset', target = row, restoreNote = note, remember = true) {
        if (!target || !catalog || busy || use==='allow'&&target.trashed&&target.trashProject!==project)
            return false;
        setBusy(true);
        setError('');
        const targetIndex = filtered.findIndex(p => p.id === target.id), candidates = [...filtered.slice(targetIndex + 1), ...filtered.slice(0, targetIndex).reverse()];
        try {
            const result = await host.save(project, target, use, restoreNote, catalog.revision);
            setCatalog({ ...catalog, ...result });
            if (remember)
                setUndo({ id: target.id, decision: target.decisionProject === project ? target.decision : null });
            setNotice(`${use==='trash'?'Moved to Trash':use==='exclude'?'Excluded':use==='allow'?(target.trashed?'Restored':'Kept'):'Reset'} ${target.id} · saved`);
            if (remember && advance) {
                const updated = filterRows(result.props), next = candidates.find(p => updated.some(v => v.id === p.id));
                if (next) {
                    setSelected(next.id);
                    setPage(Math.floor(updated.findIndex(p => p.id === next.id) / 30));
                }
                else if(!updated.some(p=>p.id===target.id))setSelected('');
            }
            return true;
        }
        catch (e) {
            setError(String(e));
            return false;
        }
        finally {
            setBusy(false);
        }
    }
    async function undoLast() { if (!undo || busy)
        return; const target = all.find(p => p.id === undo.id); if (!target)
        return; if (await save(undo.decision?.use ?? 'reset', target, undo.decision?.note ?? '', false)) setUndo(null); }
    useEffect(() => { const key = (event: KeyboardEvent) => { const el = event.target as HTMLElement; if (el.closest('input,textarea,select') || event.metaKey || event.ctrlKey || event.altKey)
        return; if (event.key === 'ArrowRight' || event.key === 'j') {
        event.preventDefault();
        navigate(1);
    }
    else if (event.key === 'ArrowLeft' || event.key === 'k') {
        event.preventDefault();
        navigate(-1);
    }
    else if (event.key.toLowerCase() === 'x'&&!row?.trashed) {
        event.preventDefault();
        void save('exclude');
    }
    else if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        void save('allow');
    }
    else if(event.key==='Delete'&&row&&!row.trashed){event.preventDefault();void save('trash');}
    else if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void undoLast();
    }
    else if (event.key === 'Escape') {
        setSelected('');
        setOrbit(false);
    } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); });
    const options = (key: 'collection' | 'category' | 'cultures') => [...new Set(all.flatMap(p => key === 'cultures' ? p.cultures : [p[key]]).filter(Boolean))].sort();
    const excludedCount = all.filter(p => p.excluded&&!p.trashed).length, reviewed = all.filter(p => !p.needsReview&&!p.trashed).length,trashCount=all.filter(p=>p.trashed).length,moduleCount=all.filter(p=>p.kind==='module'||p.kind==='building').length;
    return <div className="pr-app"><header className="pr-header"><div><a className="pr-back" href="/">HitReg</a><h1>Prop library</h1><span className="pr-subtitle">Choose what your builders can use</span></div><label>Library <select aria-label="Project library" value={project} disabled={busy} onChange={e => { setProject(e.target.value); setCollection(''); setCategory(''); setCulture(''); }}>{[...new Set([project, ...(catalog?.projects ?? [])])].map(p => <option key={p}>{p}</option>)}</select></label></header>
 <section className="pr-toolbar" aria-label="Catalog filters"><select aria-label="Asset type" value={state==='trash'?'all':kind} disabled={state==='trash'} onChange={e=>{setKind(e.target.value);setCollection('');setCategory('');setSelected('');}}><option value="prop">Standalone props</option><option value="module">Building / WFC modules</option><option value="building">Whole buildings</option><option value="effect">Effect helpers</option><option value="source">Source parts</option><option value="all">All asset types</option></select><input className="pr-search" type="search" placeholder="Search names, uses, rooms or cultures…" aria-label="Search props" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="Collection" value={collection} onChange={e => setCollection(e.target.value)}><option value="">All collections</option>{options('collection').map(v => <option key={v}>{v}</option>)}</select><select aria-label="Category" value={category} onChange={e => setCategory(e.target.value)}><option value="">All categories</option>{options('category').map(v => <option key={v}>{v}</option>)}</select><select aria-label="Culture" value={culture} onChange={e => setCulture(e.target.value)}><option value="">All cultures</option>{options('cultures').map(v => <option key={v}>{v}</option>)}</select><select aria-label="Review status" value={state} onChange={e => setState(e.target.value)}><option value="all">All active</option><option value="review">Needs review</option><option value="allowed">Available to builders</option><option value="kept">Reviewed · kept</option><option value="excluded">Excluded</option><option value="trash">Trash</option></select></section>
 <div className="pr-summary"><span>{catalog ? `${filtered.length} shown · ${all.length} total · ${reviewed} reviewed · ${excludedCount} excluded · ${moduleCount} building pieces` : 'Loading catalog…'}</span><div><button className={state==='trash'?'is-active':''} onClick={()=>{setState(state==='trash'?'all':'trash');setCollection('');setCategory('');setCulture('');setQuery('');setSelected('');}}>Trash ({trashCount})</button> <button disabled={busy || !catalog} onClick={() => { setBusy(true); setError(''); void host.load(project).then(setCatalog).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>Refresh</button> <button disabled={!undo || busy} onClick={() => void undoLast()}>Undo last choice <kbd>Z</kbd></button></div></div>
 {error && <div className="pr-error" role="alert">{error}<button onClick={() => { setError(''); void host.load(project).then(setCatalog).catch(e => setError(String(e))); }}>Refresh catalog</button></div>}
 {catalog?.warnings.length ? <details className="pr-warnings"><summary>{catalog.warnings.length} catalog warning(s)</summary>{catalog.warnings.map(w => <p key={w}>{w}</p>)}</details> : null}
 <main className={row ? 'pr-layout has-detail' : 'pr-layout'}><section className="pr-browser" aria-label="Props"><div ref={gridRef} className="pr-grid">{visible.map(p => <article key={p.id} className={`pr-card ${p.excluded ? 'is-excluded' : ''} ${selected === p.id ? 'is-selected' : ''}`}><button ref={selected === p.id ? selectedRef : undefined} className="pr-select" aria-label={`Inspect ${p.id}`} aria-pressed={selected === p.id} onClick={() => choose(p.id)}><Thumbnail host={host} project={project} row={p}/><div className="pr-card-name">{p.id.split('/').pop()!.replaceAll('-', ' ')}</div><div className="pr-card-meta">{p.collection} · {p.size.map(v => v.toFixed(1)).join(' × ')} m</div></button><div className="pr-card-footer"><span className="pr-state">{p.trashed?'In Trash':p.excluded ? '× Excluded' : p.needsReview ? '○ Needs review' : '✓ Kept'}</span><div className="pr-card-actions">{p.trashed?<button disabled={busy||p.trashProject!==project} onClick={()=>void save('allow',p,p.decision?.note??'')} aria-label={`Restore ${p.id}`}>Restore</button>:<><button disabled={busy} className="pr-toggle" onClick={()=>{setSelected(p.id);void save(p.excluded?'allow':'exclude',p,p.decision?.note??'');}} aria-label={`${p.excluded?'Keep':'Exclude'} ${p.id}`}>{p.excluded?'Keep':'Exclude'}</button><button className="pr-trash" disabled={busy} title="Move to Trash; recoverable" onClick={()=>void save('trash',p,p.decision?.note??'')} aria-label={`Delete ${p.id}`}>Delete</button></>}</div></div></article>)}</div>{catalog && !filtered.length && <div className="pr-empty"><h2>No matching props</h2><p>Try another search or clear the filters.</p><button onClick={() => { setQuery(''); setCollection(''); setCategory(''); setCulture(''); setState('all');setKind('prop'); }}>Clear filters</button></div>}<nav className="pr-pages" aria-label="Prop pages"><button disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); gridRef.current?.scrollIntoView(); }}>← Previous</button><span>Page {currentPage + 1} of {pages}</span><button disabled={currentPage >= pages - 1} onClick={() => { setPage(currentPage + 1); gridRef.current?.scrollIntoView(); }}>Next →</button></nav></section>
 {row && <aside className="pr-detail" aria-label="Selected prop"><div className="pr-detail-top"><span>{selectedIndex >= 0 ? `${selectedIndex + 1} / ${filtered.length}` : 'Selected prop'}</span><button aria-label="Close prop details" onClick={() => setSelected('')}>×</button></div><h2>{row.name.replaceAll('-', ' ')}</h2><code>{row.id}</code>{orbit ? <LivePreview row={row} project={project} host={host}/> : <button className="pr-enlarge" onClick={() => setOrbit(true)}><Thumbnail row={row} project={project} host={host}/><span>Open 3D view ↗</span></button>}<p>{row.description || 'Catalogued prop'}</p><dl><dt>Dimensions</dt><dd>{row.size.map(v => v.toFixed(2)).join(' × ')} m</dd><dt>Asset type</dt><dd>{row.kind==='prop'?'Standalone prop':row.kind==='module'?'Building module':row.kind}</dd><dt>Category</dt><dd>{row.category || '—'}</dd><dt>Culture / scale</dt><dd>{row.cultures.join(', ') || '—'} / {row.scale || '—'}</dd><dt>Source</dt><dd>{row.sourceProject}</dd><dt>Review</dt><dd>{row.needsReview ? 'Needs review' : `Reviewed in ${row.decisionProject}`}</dd></dl>{row.exemption && <p className="pr-muted">Catalog restriction: {row.exemption}</p>}{row.blockedBy && <p className="pr-exclusion">Excluded by {row.blockedBy.project}: {row.blockedBy.id}{row.blockedBy.note && <><br />{row.blockedBy.note}</>}</p>}{row.blockedBy && (row.blockedBy.id !== row.id || row.blockedBy.project !== project) && <p className="pr-muted">Keeping this item cannot override that exclusion. Review the named prop in its project to restore it.</p>}{row.trashed&&<p className="pr-exclusion">In Trash in {row.trashProject}. Shared files and existing placements are retained for recovery.{row.trashProject!==project&&<button onClick={()=>setProject(row.trashProject!)}>Open {row.trashProject} to restore</button>}</p>}<label className="pr-note">Review note<textarea value={note} maxLength={2000} placeholder="Optional: what needs changing?" onChange={e => setNote(e.target.value)}/></label><div className="pr-actions"><button disabled={busy || !row.available || row.trashed&&row.trashProject!==project} onClick={() => void save('allow')}>{row.trashed?'Restore':'✓ Keep'} <kbd>A</kbd></button>{!row.trashed&&<button className="pr-exclude-button" disabled={busy} onClick={() => void save('exclude')}>× Exclude <kbd>X</kbd></button>}</div>{!row.trashed&&<button className="pr-delete" disabled={busy} onClick={()=>void save('trash')}>Delete from library <kbd>Del</kbd></button>}<label className="pr-advance"><input type="checkbox" checked={advance} onChange={e => setAdvance(e.target.checked)}/>Advance after a choice</label><div className="pr-review-nav"><button disabled={selectedIndex <= 0} onClick={() => navigate(-1)}>← Previous</button><button disabled={selectedIndex < 0 || selectedIndex >= filtered.length - 1} onClick={() => navigate(1)}>Next →</button></div><button className="pr-reset" disabled={busy || row.decisionProject !== project} onClick={() => void save('reset')}>Reset this project's choice</button></aside>}</main>
 <footer className="pr-footer"><span role="status">{busy ? 'Saving…' : notice || 'Choices apply to future builds. Existing placements and assets stay intact.'}</span><span><kbd>←</kbd><kbd>→</kbd> browse · <kbd>A</kbd> keep · <kbd>X</kbd> exclude · <kbd>Del</kbd> trash · <kbd>Z</kbd> undo</span></footer></div>;
}
export function mountPropReview(element: HTMLElement, host: PropReviewHost) { const root = createRoot(element); root.render(<PropReview host={host}/>); return () => root.unmount(); }
