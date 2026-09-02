import { useEffect, useMemo, useState } from "react";
import type {
  AssetLibrary,
  ComponentRegistry,
  ToolDefinition,
  ToolFileValue,
  ToolInput,
  ToolResult,
} from "@hitreg/core";
import { buttonStyle } from "./common.js";
import { WfcToolDialog } from "./wfc-tool-dialog.js";

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

function defaults(tool: ToolDefinition): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(tool.inputs)) {
    if ("default" in input) values[name] = input.default;
    else if (input.kind === "string") values[name] = "";
  }
  return values;
}

async function encodeFile(file: File): Promise<ToolFileValue> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error(`could not encode ${file.name}`);
  return {
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    data: dataUrl.slice(comma + 1),
  };
}

function Field(props: {
  name: string;
  input: ToolInput;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const { input } = props;
  let control: React.ReactNode;
  if (input.kind === "file") {
    const file = props.value as ToolFileValue | undefined;
    control = (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <label style={{ ...buttonStyle, padding: "3px 8px", cursor: props.disabled ? "default" : "pointer" }}>
          choose file
          <input
            type="file"
            accept={input.accept?.join(",")}
            disabled={props.disabled}
            style={{ display: "none" }}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) void encodeFile(selected).then(props.onChange);
            }}
          />
        </label>
        <span style={{ color: file ? "#c9d1d9" : "#8b949e", overflow: "hidden", textOverflow: "ellipsis" }}>
          {file?.name ?? "no file selected"}
        </span>
      </div>
    );
  } else if (input.kind === "boolean") {
    control = (
      <input
        type="checkbox"
        checked={Boolean(props.value)}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    );
  } else if (input.kind === "select") {
    control = (
      <select
        style={inputStyle}
        value={String(props.value ?? "")}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {input.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  } else if (input.kind === "number") {
    control = (
      <input
        type="number"
        style={inputStyle}
        value={typeof props.value === "number" ? props.value : ""}
        min={input.min}
        max={input.max}
        step={input.step ?? (input.integer ? 1 : "any")}
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      />
    );
  } else {
    control = (
      <input
        type="text"
        style={inputStyle}
        value={String(props.value ?? "")}
        placeholder={input.placeholder}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    );
  }

  return (
    <label style={{ display: "grid", gridTemplateColumns: "128px 1fr", gap: 8, alignItems: "center" }}>
      <span style={{ color: "#8b949e" }}>
        {input.label}{input.required && !("default" in input) ? " *" : ""}
      </span>
      <span style={{ minWidth: 0 }}>
        {control}
        {input.description && (
          <span style={{ display: "block", color: "#8b949e", fontSize: 10, marginTop: 3, lineHeight: 1.35 }}>
            {input.description}
          </span>
        )}
      </span>
    </label>
  );
}

export function ToolDialog(props: {
  tool: ToolDefinition;
  assets?: AssetLibrary;
  registry?: ComponentRegistry;
  thumbnails?: Record<string, string>;
  onClose: () => void;
  onRun: (id: string, inputs: Record<string, unknown>) => Promise<ToolResult>;
}) {
  if (props.tool.id === "hitreg.wfc-3d" && props.assets && props.registry) {
    return (
      <WfcToolDialog
        tool={props.tool}
        assets={props.assets}
        registry={props.registry}
        thumbnails={props.thumbnails}
        onClose={props.onClose}
        onRun={props.onRun}
      />
    );
  }
  return <GenericToolDialog tool={props.tool} onClose={props.onClose} onRun={props.onRun} />;
}

function GenericToolDialog(props: {
  tool: ToolDefinition;
  onClose: () => void;
  onRun: (id: string, inputs: Record<string, unknown>) => Promise<ToolResult>;
}) {
  const initial = useMemo(() => defaults(props.tool), [props.tool]);
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ToolResult | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, props.onClose]);

  const run = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await props.onRun(props.tool.id, values));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
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
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="hitreg-tool-title"
        style={{
          width: 620,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "#0d1117",
          border: "1px solid #30363d",
          color: "#c9d1d9",
          font: "11px ui-monospace, monospace",
        }}
      >
        <header style={{ padding: "8px 10px", borderBottom: "1px solid #21262d", background: "#161b22" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong id="hitreg-tool-title" style={{ color: "#e6edf3", fontSize: 12, flex: 1 }}>
              {props.tool.name}
            </strong>
            <span style={{ color: "#8b949e", fontSize: 10 }}>{props.tool.category}</span>
            <button style={buttonStyle} disabled={busy} onClick={props.onClose}>close</button>
          </div>
          <div style={{ color: "#8b949e", marginTop: 5, lineHeight: 1.4 }}>{props.tool.description}</div>
        </header>

        <div style={{ padding: 10, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          {Object.entries(props.tool.inputs).map(([name, input]) => (
            <Field
              key={name}
              name={name}
              input={input}
              value={values[name]}
              disabled={busy}
              onChange={(value) => setValues((current) => ({ ...current, [name]: value }))}
            />
          ))}

          {error && (
            <div role="alert" style={{ border: "1px solid #7d3a3a", background: "#271718", color: "#ffb4ab", padding: 7 }}>
              {error}
            </div>
          )}

          {result && (
            <div style={{ borderTop: "1px solid #21262d", paddingTop: 10 }}>
              {result.assets.length > 0 && (
                <div style={{ color: "#c9d1d9", marginBottom: 8 }}>
                  wrote {result.assets.map((asset) => asset.file).join(", ")}
                </div>
              )}
              {result.previews.length > 0 && (
                <div style={{ display: "flex", gap: 8, overflowX: "auto", marginBottom: 8 }}>
                  {result.previews.map((preview) => (
                    <figure key={preview.label} style={{ margin: 0, minWidth: 0 }}>
                      <img
                        src={`data:${preview.mediaType};base64,${preview.data}`}
                        alt={preview.label}
                        style={{ width: 220, maxHeight: 260, objectFit: "contain", background: "#161b22", imageRendering: "pixelated" }}
                      />
                      <figcaption style={{ color: "#8b949e", marginTop: 3 }}>{preview.label}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {result.warnings.length > 0 && (
                <details open>
                  <summary style={{ color: "#e3b341", cursor: "pointer" }}>{result.warnings.length} warning(s)</summary>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 20, color: "#c9d1d9" }}>
                    {result.warnings.map((warning, index) => <li key={index} style={{ marginBottom: 4 }}>{warning}</li>)}
                  </ul>
                </details>
              )}
              {result.report !== undefined && (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ color: "#8b949e", cursor: "pointer" }}>report</summary>
                  <pre style={{ margin: "6px 0 0", padding: 7, overflow: "auto", background: "#161b22", color: "#c9d1d9", fontSize: 10 }}>
                    {JSON.stringify(result.report, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 6, padding: "7px 10px", borderTop: "1px solid #21262d", background: "#161b22" }}>
          <button style={buttonStyle} disabled={busy} onClick={() => void run()}>
            {busy ? "runningâ€¦" : result ? "run again" : "run tool"}
          </button>
        </footer>
      </section>
    </div>
  );
}
