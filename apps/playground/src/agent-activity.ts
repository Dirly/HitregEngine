/**
 * AGENT WORKING warning — "an active agent working in that scene should cause a warning" (owner, 2026-11-11).
 *
 * Polls GET /__hitreg/agent-activity?scene=<open scene> (tools/_agent-activity.mts: declared heartbeats that lapse by
 * themselves, or a tool holding the scene file's lock) and shows a strip over the viewport while anyone is working in
 * the open scene. A warning only: the owner's edits are never blocked. His edits win over an agent's (the edit record's
 * precedence), so the strip says so. Meaning is carried by the glyph and the words, not by colour.
 */
import type { SceneStore } from "@hitreg/core";
import type { Observable } from "@hitreg/editor";

interface Activity { agent: string; what: string; since: string; source?: "declared" | "lock" }

const T = { canvas: "#0b0e14", border: "#30363d", text: "#c9d1d9", emphasis: "#e6edf3", muted: "#8b949e", warn: "#d29922" };
const FONT = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const POLL_MS = 2000;

const ago = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};

export function mountAgentActivity(opts: {
  store: SceneStore;
  editorVisible: Observable<boolean>;
  isWorkspaceScene?(name: string): boolean;
  dockSizes?: Observable<{ top: number; left: number; right: number; bottom: number }>;
}): { dispose(): void } {
  const root = document.createElement("div");
  root.id = "hg-agent-activity";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  Object.assign(root.style, {
    position: "fixed", left: "50%", top: "8px", transform: "translateX(-50%)", zIndex: "960", display: "none",
    background: T.canvas, border: `1px solid ${T.warn}`, borderLeft: `3px solid ${T.warn}`, borderRadius: "3px",
    color: T.text, font: FONT, padding: "5px 10px", maxWidth: "min(720px, calc(100vw - 32px))", boxSizing: "border-box",
    pointerEvents: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(root);
  const place = (): void => {
    const d = opts.dockSizes?.get();
    root.style.top = `${(d?.top ?? 0) + 8}px`;
    if (d) root.style.left = `${d.left + (window.innerWidth - d.left - d.right) / 2}px`;
  };
  place();
  const unDock = opts.dockSizes?.subscribe(place);

  let active: Activity[] = [];
  let scene = "";
  function render(): void {
    const show = opts.editorVisible.get() && active.length > 0;
    root.style.display = show ? "block" : "none";
    if (!show) return;
    const who = active.map((a) => `${a.agent}${a.what ? ` (${a.what})` : ""}, ${ago(a.since)}`).join(" · ");
    root.replaceChildren();
    const glyph = document.createElement("span");
    glyph.textContent = "⚠ ";
    glyph.setAttribute("aria-hidden", "true");
    glyph.style.color = T.warn;
    const label = document.createElement("strong");
    label.textContent = "AGENT WORKING IN THIS SCENE";
    label.style.color = T.emphasis;
    label.style.fontWeight = "600";
    const rest = document.createElement("span");
    rest.textContent = ` · ${who} · your edits still save and win over the agent's`;
    rest.style.color = T.muted;
    root.append(glyph, label, rest);
    root.title = `Agent working in ${scene}: ${who}. Your edits are not blocked; the edit record keeps yours over an agent's.`;
  }

  let timer = 0, stopped = false;
  async function poll(): Promise<void> {
    if (stopped) return;
    scene = opts.store.doc.name;
    if (document.visibilityState === "visible" && scene && !opts.isWorkspaceScene?.(scene)) {
      try {
        const r = await fetch(`/__hitreg/agent-activity?scene=${encodeURIComponent(scene)}`);
        const j = (await r.json()) as { ok: boolean; active?: Activity[] };
        active = j.ok ? (j.active ?? []) : [];
      } catch {
        active = []; // no dev server (a built game): nothing to warn about
      }
    } else active = [];
    render();
    timer = window.setTimeout(() => void poll(), POLL_MS);
  }
  void poll();
  const unVisible = opts.editorVisible.subscribe(render);
  return {
    dispose(): void {
      stopped = true;
      clearTimeout(timer);
      unVisible();
      unDock?.();
      root.remove();
    },
  };
}
