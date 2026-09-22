import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SceneMenuGroup, SceneMenuItem, SceneMenuProject } from "@hitreg/core";
import { buttonStyle } from "./common.js";

const MUTED = "#8b949e";
const TEXT = "#c9d1d9";
const EMPHASIS = "#e6edf3";
const ACTIVE_BG = "#1f2630";
const EXPANDED_KEY = "hitreg-editor-scene-menu-expanded";
const PANEL_WIDTH = 360;

/** Project names are kebab-case, so this can never collide with one. */
const LOOSE_PROJECT = "(loose)";
const projectKey = (project: SceneMenuProject) => project.name ?? LOOSE_PROJECT;

type Row =
  | { kind: "group"; key: string; title: string }
  | { kind: "project"; key: string; project: SceneMenuProject; count: number; expanded: boolean }
  | { kind: "other"; key: string }
  | { kind: "scene"; key: string; project: string; item: SceneMenuItem };

const focusable = (row: Row): row is Extract<Row, { kind: "project" | "scene" }> =>
  row.kind === "project" || row.kind === "scene";

function readExpanded(): Set<string> | null {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function writeExpanded(expanded: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    /* storage disabled: the tree just starts collapsed next time */
  }
}

/**
 * The visible rows for a query. With no query, collapsed projects show only
 * their header. With one, every project holding a match opens and shows just
 * the matches (a project whose own name matches shows all of its scenes), and
 * a matching stage brings its base scene along so it isn't orphaned.
 */
function buildRows(menu: SceneMenuGroup[], query: string, expanded: Set<string>): Row[] {
  const q = query.trim().toLowerCase();
  const hit = (...texts: Array<string | null | undefined>) => texts.some((t) => t?.toLowerCase().includes(q));
  const rows: Row[] = [];
  for (const [index, group] of menu.entries()) {
    const groupRows: Row[] = [];
    for (const project of group.projects) {
      const key = projectKey(project);
      let listed = project.listed;
      let other = project.other;
      // a project matches by its name only: descriptions mention too much
      // ("…ability combat…") and would flood the list
      if (q && !hit(project.label, project.name)) {
        const keep = new Set<number>();
        listed.forEach((item, i) => {
          if (!hit(item.label, item.id, item.note)) return;
          keep.add(i);
          if (item.depth === 1) {
            let base = i;
            while (base > 0 && listed[base]!.depth === 1) base--;
            keep.add(base);
          }
        });
        listed = listed.filter((_, i) => keep.has(i));
        other = other.filter((item) => hit(item.label, item.id));
        if (listed.length === 0 && other.length === 0) continue;
      }
      const open = q ? true : expanded.has(key);
      groupRows.push({
        kind: "project",
        key: `p:${key}`,
        project,
        count: project.listed.length + project.other.length,
        expanded: open,
      });
      if (!open) continue;
      for (const item of listed) groupRows.push({ kind: "scene", key: `s:${item.id}`, project: key, item });
      if (other.length > 0) {
        if (project.listed.length > 0) groupRows.push({ kind: "other", key: `o:${key}` });
        for (const item of other) groupRows.push({ kind: "scene", key: `s:${item.id}`, project: key, item });
      }
    }
    if (groupRows.length === 0) continue;
    rows.push({ kind: "group", key: `g:${index}`, title: group.title ?? "other projects" });
    rows.push(...groupRows);
  }
  return rows;
}

function Caret(props: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width={10}
      height={10}
      viewBox="0 0 10 10"
      style={{ flexShrink: 0, transform: props.open ? "rotate(90deg)" : undefined, transition: "transform 80ms" }}
    >
      <path d="M3.5 2 L7 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One toolbar button showing "project / scene" that opens the scene browser:
 * a search box over collapsible projects. Arrow keys move, Enter opens a scene
 * or toggles a project, Right/Left expand/collapse, Escape closes. Which
 * projects are expanded is remembered per browser.
 */
export function ScenePicker(props: {
  menu: SceneMenuGroup[];
  current: string;
  onSwitchScene?: (name: string) => void;
}) {
  const projects = useMemo(() => props.menu.flatMap((g) => g.projects), [props.menu]);
  const currentProject = projects.find((p) => [...p.listed, ...p.other].some((s) => s.id === props.current)) ?? null;
  const currentItem = currentProject
    ? [...currentProject.listed, ...currentProject.other].find((s) => s.id === props.current)
    : undefined;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => readExpanded() ?? new Set(currentProject ? [projectKey(currentProject)] : []),
  );
  const [active, setActive] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const rows = useMemo(() => buildRows(props.menu, query, expanded), [props.menu, query, expanded]);
  const targets = rows.filter(focusable);

  const setExpandedPersist = (next: Set<string>) => {
    setExpanded(next);
    writeExpanded(next);
  };
  const toggle = (key: string, to?: boolean) => {
    const next = new Set(expanded);
    const want = to ?? !next.has(key);
    if (want) next.add(key);
    else next.delete(key);
    setExpandedPersist(next);
  };

  const openPanel = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        left: Math.max(4, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 4)),
        top: rect.bottom + 4,
      });
    }
    // the scene you're in is always reachable when the browser opens
    if (currentProject && !expanded.has(projectKey(currentProject))) toggle(projectKey(currentProject), true);
    setQuery("");
    setActive(`s:${props.current}`);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (id: string) => {
    setOpen(false);
    if (id !== props.current) props.onSwitchScene?.(id);
  };

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // typing puts the keyboard row on the best match, so Enter opens what you
  // searched for: a scene whose own label/id matches, else the first scene
  useEffect(() => {
    if (!open || !query.trim()) return;
    const q = query.trim().toLowerCase();
    const scenes = targets.filter((r): r is Extract<Row, { kind: "scene" }> => r.kind === "scene");
    const direct =
      scenes.find((r) => r.item.label.toLowerCase().startsWith(q) || r.item.id.startsWith(q)) ??
      scenes.find((r) => r.item.label.toLowerCase().includes(q) || r.item.id.includes(q));
    setActive((direct ?? scenes[0] ?? targets[0])?.key ?? null);
  }, [open, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // otherwise just keep the keyboard row on something still visible
  useEffect(() => {
    if (!open) return;
    if (active && targets.some((r) => r.key === active)) return;
    setActive(targets.find((r) => r.kind === "scene")?.key ?? targets[0]?.key ?? null);
  }, [open, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (open && active) rowRefs.current.get(active)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = targets.findIndex((r) => r.key === active);
    const row = targets[at];
    const move = (delta: number) => {
      if (targets.length === 0) return;
      const next = targets[(Math.max(at, 0) + delta + targets.length) % targets.length]!;
      setActive(next.key);
    };
    let handled = true;
    if (event.key === "ArrowDown") move(at < 0 ? 0 : 1);
    else if (event.key === "ArrowUp") move(at < 0 ? 0 : -1);
    else if (event.key === "Escape") close();
    else if (event.key === "Enter" && row) {
      if (row.kind === "scene") choose(row.item.id);
      else if (!query) toggle(projectKey(row.project));
    } else if (event.key === "ArrowRight" && row?.kind === "project" && !query) {
      toggle(projectKey(row.project), true);
    } else if (event.key === "ArrowLeft" && row && !query) {
      // Left/Right only drive the tree while the search box is empty, so they
      // still move the text cursor once you've typed something
      if (row.kind === "project") toggle(projectKey(row.project), false);
      else setActive(`p:${row.project}`);
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const anyCollapsed = projects.some((p) => !expanded.has(projectKey(p)));
  const rowBase: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    boxSizing: "border-box",
    border: 0,
    textAlign: "left",
    cursor: "pointer",
    font: "11px ui-monospace, monospace",
    minHeight: 24,
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Scene browser (saved automatically on switch)"
        onClick={() => (open ? setOpen(false) : openPanel())}
        style={{
          ...buttonStyle,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 24,
          padding: "3px 8px",
          borderRadius: 4,
          maxWidth: 320,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: MUTED, overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1, minWidth: 0 }}>
          {currentProject?.label ?? "unsaved"}
        </span>
        <span aria-hidden="true" style={{ color: MUTED }}>/</span>
        <span style={{ color: EMPHASIS, overflow: "hidden", textOverflow: "ellipsis", flexShrink: 2, minWidth: 0 }}>
          {currentItem?.label ?? props.current}
        </span>
        <Caret open={open} />
      </button>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Scene browser"
          onKeyDown={onKeyDown}
          style={{
            position: "fixed",
            left: position.left,
            top: position.top,
            zIndex: 1200,
            width: PANEL_WIDTH,
            maxHeight: `min(70vh, ${Math.max(200, window.innerHeight - position.top - 12)}px)`,
            display: "flex",
            flexDirection: "column",
            background: "#161b22",
            border: "1px solid #30363d",
            color: TEXT,
            font: "11px ui-monospace, monospace",
            pointerEvents: "auto",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          <div style={{ display: "flex", gap: 6, padding: 6, borderBottom: "1px solid #21262d" }}>
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="search scenes and projects"
              aria-label="search scenes"
              aria-controls="hitreg-scene-browser-list"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                flex: 1,
                minWidth: 0,
                background: "#0d1117",
                border: "1px solid #30363d",
                borderRadius: 3,
                color: TEXT,
                font: "11px ui-monospace, monospace",
                padding: "4px 6px",
              }}
            />
            <button
              type="button"
              style={{ ...buttonStyle, padding: "3px 7px", whiteSpace: "nowrap" }}
              disabled={Boolean(query)}
              title={query ? "clear the search to expand or collapse" : undefined}
              onClick={() =>
                setExpandedPersist(anyCollapsed ? new Set(projects.map(projectKey)) : new Set())
              }
            >
              {anyCollapsed ? "expand all" : "collapse all"}
            </button>
          </div>

          <div id="hitreg-scene-browser-list" role="tree" aria-label="projects and scenes" style={{ overflowY: "auto", padding: "2px 0 4px" }}>
            {rows.length === 0 && <div style={{ padding: "10px 12px", color: MUTED }}>no scene matches "{query}"</div>}
            {rows.map((row) => {
              if (row.kind === "group") {
                return (
                  <div
                    key={row.key}
                    role="presentation"
                    style={{ padding: "8px 10px 3px", color: MUTED, fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase" }}
                  >
                    {row.title}
                  </div>
                );
              }
              if (row.kind === "other") {
                return (
                  <div key={row.key} role="presentation" style={{ padding: "4px 10px 2px 30px", color: MUTED, fontSize: 10 }}>
                    other
                  </div>
                );
              }
              const isActive = row.key === active;
              const register = (el: HTMLElement | null) => {
                if (el) rowRefs.current.set(row.key, el);
                else rowRefs.current.delete(row.key);
              };
              if (row.kind === "project") {
                const holdsCurrent = currentProject !== null && projectKey(currentProject) === projectKey(row.project);
                return (
                  <button
                    key={row.key}
                    ref={register}
                    type="button"
                    role="treeitem"
                    aria-expanded={row.expanded}
                    title={row.project.description}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(row.key)}
                    onClick={() => {
                      if (!query) toggle(projectKey(row.project));
                    }}
                    style={{
                      ...rowBase,
                      padding: "3px 10px",
                      background: isActive ? ACTIVE_BG : "transparent",
                      color: holdsCurrent ? EMPHASIS : TEXT,
                      fontWeight: holdsCurrent ? 600 : 400,
                    }}
                  >
                    <span style={{ color: MUTED, display: "inline-flex" }}>
                      <Caret open={row.expanded} />
                    </span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.project.label}
                    </span>
                    <span style={{ color: MUTED, fontWeight: 400 }}>{row.count}</span>
                  </button>
                );
              }
              const isCurrent = row.item.id === props.current;
              return (
                <button
                  key={row.key}
                  ref={register}
                  type="button"
                  role="treeitem"
                  aria-current={isCurrent ? "true" : undefined}
                  title={row.item.note ?? row.item.id}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(row.key)}
                  onClick={() => choose(row.item.id)}
                  style={{
                    ...rowBase,
                    padding: `3px 10px 3px ${row.item.depth === 1 ? 44 : 30}px`,
                    background: isActive ? ACTIVE_BG : "transparent",
                    color: isCurrent ? EMPHASIS : TEXT,
                    fontWeight: isCurrent ? 600 : 400,
                    boxShadow: isCurrent ? "inset 2px 0 0 #58a6ff" : undefined,
                  }}
                >
                  {row.item.depth === 1 && <span aria-hidden="true" style={{ color: MUTED }}>{"↳"}</span>}
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.item.label}
                  </span>
                  {isCurrent ? (
                    <span style={{ color: MUTED, fontWeight: 400 }}>open</span>
                  ) : (
                    row.item.depth === 0 &&
                    row.item.label !== row.item.id && (
                      <span style={{ color: MUTED, fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130, whiteSpace: "nowrap" }}>
                        {row.item.id}
                      </span>
                    )
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
