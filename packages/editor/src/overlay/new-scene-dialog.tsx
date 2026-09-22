import { useEffect, useMemo, useRef, useState } from "react";
import type { SceneMenuGroup, SceneMenuProject } from "@hitreg/core";
import type { NewSceneRequest } from "../state.js";
import { buttonStyle } from "./common.js";

const MUTED = "#8b949e";

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#161b22",
  border: "1px solid #30363d",
  borderRadius: 3,
  color: "#c9d1d9",
  font: "11px ui-monospace, monospace",
  padding: "4px 6px",
};

const slug = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const OWN_ENTRY = "";

function Row(props: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "104px 1fr", gap: 8, alignItems: "start" }}>
      <span style={{ color: MUTED, paddingTop: 5 }}>{props.label}</span>
      <span style={{ minWidth: 0 }}>
        {props.children}
        {props.hint && (
          <span style={{ display: "block", color: MUTED, fontSize: 10, marginTop: 3, lineHeight: 1.35 }}>{props.hint}</span>
        )}
      </span>
    </label>
  );
}

/**
 * Create a scene in a project and put it in that project's menu: as its own
 * entry, or as a stage (blockout, undercoat, …) under an existing scene.
 * The host writes the scene file and the project.json entry.
 */
export function NewSceneDialog(props: {
  menu: SceneMenuGroup[];
  current: string;
  onClose: () => void;
  onCreate: (request: NewSceneRequest) => Promise<void>;
}) {
  const projects = useMemo(
    () => props.menu.flatMap((g) => g.projects).filter((p): p is SceneMenuProject & { name: string } => p.name !== null),
    [props.menu],
  );
  const takenIds = useMemo(
    () => new Set(props.menu.flatMap((g) => g.projects.flatMap((p) => [...p.listed, ...p.other].map((s) => s.id)))),
    [props.menu],
  );
  const currentProject = projects.find((p) => [...p.listed, ...p.other].some((s) => s.id === props.current));

  const [project, setProject] = useState(currentProject?.name ?? projects[0]?.name ?? "");
  const [base, setBase] = useState(OWN_ENTRY);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [note, setNote] = useState("");
  const [from, setFrom] = useState<NewSceneRequest["from"]>("empty");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => nameInput.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, props.onClose]);

  const selected = projects.find((p) => p.name === project);
  // a stage hangs under a top-level scene; variants of variants aren't a thing
  const bases = selected ? [...selected.listed.filter((s) => s.depth === 0), ...selected.other] : [];
  const autoId = base ? `${base}-${slug(name)}` : slug(name);
  const finalId = idEdited ? id : autoId;

  const problem = (() => {
    if (!project) return "pick a project";
    if (!slug(name)) return base ? "name the stage, e.g. undercoat" : "name the scene";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(finalId)) return "file id: lowercase letters, digits and dashes";
    if (takenIds.has(finalId)) return `a scene "${finalId}" already exists`;
    return "";
  })();

  const create = async () => {
    if (problem || busy) return;
    setBusy(true);
    setError("");
    try {
      await props.onCreate({
        project,
        id: finalId,
        label: base ? undefined : name.trim(),
        note: base || !note.trim() ? undefined : note.trim(),
        variantOf: base || undefined,
        from,
      });
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) props.onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1400,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(6, 8, 12, 0.72)",
        pointerEvents: "auto",
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="hitreg-new-scene-title"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        style={{
          width: 460,
          maxWidth: "calc(100vw - 32px)",
          display: "flex",
          flexDirection: "column",
          background: "#0d1117",
          border: "1px solid #30363d",
          color: "#c9d1d9",
          font: "11px ui-monospace, monospace",
        }}
      >
        <header style={{ padding: "8px 10px", borderBottom: "1px solid #21262d", background: "#161b22" }}>
          <strong id="hitreg-new-scene-title" style={{ color: "#e6edf3", fontSize: 12 }}>
            New scene
          </strong>
        </header>

        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <Row label="project">
            <select
              style={inputStyle}
              value={project}
              disabled={busy}
              onChange={(e) => {
                setProject(e.target.value);
                setBase(OWN_ENTRY);
              }}
            >
              {props.menu.map((group, index) => {
                const members = group.projects.filter((p) => p.name !== null);
                if (members.length === 0) return null;
                return (
                  <optgroup key={group.title ?? `ungrouped-${index}`} label={group.title ?? "other projects"}>
                    {members.map((p) => (
                      <option key={p.name} value={p.name!}>
                        {p.label}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </Row>

          <Row
            label="in the menu"
            hint={base ? "Listed indented under that scene, like blockout and undercoat." : "Its own row in the scene menu."}
          >
            <select
              style={inputStyle}
              value={base}
              disabled={busy}
              onChange={(e) => {
                setBase(e.target.value);
                if (e.target.value && e.target.value === props.current) setFrom("current");
              }}
            >
              <option value={OWN_ENTRY}>its own entry</option>
              {bases.length > 0 && (
                <optgroup label="a stage of">
                  {bases.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label === s.id ? s.id : `${s.label} (${s.id})`}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Row>

          <Row label={base ? "stage" : "name"}>
            <input
              ref={nameInput}
              style={inputStyle}
              value={name}
              disabled={busy}
              placeholder={base ? "undercoat" : "Boss lab"}
              onChange={(e) => setName(e.target.value)}
            />
          </Row>

          <Row label="file id" hint={project && finalId ? `projects/${project}/assets/scenes/${finalId}.scene.json` : undefined}>
            <input
              style={inputStyle}
              value={finalId}
              disabled={busy}
              spellCheck={false}
              onChange={(e) => {
                setIdEdited(true);
                setId(e.target.value);
              }}
            />
          </Row>

          <Row label="start from">
            <select
              style={inputStyle}
              value={from}
              disabled={busy}
              onChange={(e) => setFrom(e.target.value as NewSceneRequest["from"])}
            >
              <option value="empty">empty starter scene</option>
              <option value="current">copy of {props.current}</option>
            </select>
          </Row>

          {!base && (
            <Row label="note">
              <input
                style={inputStyle}
                value={note}
                disabled={busy}
                placeholder="optional: what it's for (menu tooltip)"
                onChange={(e) => setNote(e.target.value)}
              />
            </Row>
          )}

          {error && (
            <div role="alert" style={{ border: "1px solid #7d3a3a", background: "#271718", color: "#ffb4ab", padding: 7 }}>
              {error}
            </div>
          )}
        </div>

        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 10px",
            borderTop: "1px solid #21262d",
            background: "#161b22",
          }}
        >
          <span role="status" style={{ flex: 1, color: MUTED }}>
            {name ? problem : ""}
          </span>
          <button type="button" style={buttonStyle} disabled={busy} onClick={props.onClose}>
            cancel
          </button>
          <button type="submit" style={buttonStyle} disabled={busy || Boolean(problem)}>
            {busy ? "creating…" : "create"}
          </button>
        </footer>
      </form>
    </div>
  );
}
