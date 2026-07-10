import { useEffect, useState } from "react";

const inputStyle: React.CSSProperties = {
  background: "#161b22",
  border: "1px solid #30363d",
  borderRadius: 3,
  color: "#c9d1d9",
  font: "11px ui-monospace, monospace",
  padding: "2px 4px",
  width: "100%",
  boxSizing: "border-box",
};

export function NumberField(props: {
  value: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);

  const commit = () => {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed !== props.value) props.onCommit(parsed);
    else setText(String(props.value));
  };

  return (
    <input
      style={inputStyle}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function TextField(props: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);

  const commit = () => {
    if (text !== props.value) props.onCommit(text);
  };

  return (
    <input
      style={inputStyle}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function BooleanField(props: {
  value: boolean;
  onCommit: (value: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={props.value}
      onChange={(e) => props.onCommit(e.target.checked)}
    />
  );
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const SWATCH_KEY = "hitreg-editor-swatches";

function loadSwatches(): string[] {
  try {
    const raw = localStorage.getItem(SWATCH_KEY);
    if (raw) return (JSON.parse(raw) as string[]).filter((s) => HEX_COLOR.test(s));
  } catch {
    /* corrupted storage: start fresh */
  }
  return [];
}

/** Hex color editor: native picker + hex text + persistent saved swatches. */
export function ColorField(props: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [swatches, setSwatches] = useState<string[]>(loadSwatches);

  const saveSwatches = (next: string[]) => {
    setSwatches(next);
    try {
      localStorage.setItem(SWATCH_KEY, JSON.stringify(next));
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          type="color"
          value={props.value}
          onChange={(e) => props.onCommit(e.target.value)}
          style={{
            width: 26,
            height: 20,
            padding: 0,
            border: "1px solid #30363d",
            borderRadius: 3,
            background: "none",
            cursor: "pointer",
          }}
        />
        <div style={{ flex: 1 }}>
          <TextField value={props.value} onCommit={(v) => HEX_COLOR.test(v) && props.onCommit(v)} />
        </div>
        <button
          title="Save color to swatches"
          onClick={() => !swatches.includes(props.value) && saveSwatches([...swatches, props.value])}
          style={{
            background: "#21262d",
            border: "1px solid #30363d",
            borderRadius: 3,
            color: "#8b949e",
            cursor: "pointer",
            font: "11px ui-monospace, monospace",
            padding: "1px 5px",
          }}
        >
          +
        </button>
      </div>
      {swatches.length > 0 && (
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {swatches.map((color) => (
            <span
              key={color}
              title={`${color} — click to apply, shift+click to remove`}
              onClick={(e) => {
                if (e.shiftKey) saveSwatches(swatches.filter((s) => s !== color));
                else props.onCommit(color);
              }}
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                background: color,
                border: color === props.value ? "1px solid #79c0ff" : "1px solid #30363d",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Slider + numeric readout for bounded numbers (roughness, opacity, ...). */
export function SliderField(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 0.01}
        value={props.value}
        onChange={(e) => props.onCommit(Number(e.target.value))}
        style={{ flex: 1, accentColor: "#79c0ff", height: 14 }}
      />
      <span style={{ width: 44 }}>
        <NumberField value={props.value} onCommit={props.onCommit} />
      </span>
    </div>
  );
}

/** Generic value editor: dispatches on runtime shape of the JSON value. */
export function ValueField(props: {
  value: unknown;
  onCommit: (value: unknown) => void;
  /** Per-key overrides for STRING fields at any depth (e.g. bone-name dropdowns). */
  special?: Record<string, (value: string, onCommit: (v: string) => void) => React.ReactNode>;
}) {
  const { value, onCommit, special } = props;

  if (typeof value === "number") {
    return <NumberField value={value} onCommit={onCommit} />;
  }
  if (typeof value === "boolean") {
    return <BooleanField value={value} onCommit={onCommit} />;
  }
  if (typeof value === "string") {
    if (HEX_COLOR.test(value)) {
      return <ColorField value={value} onCommit={onCommit} />;
    }
    return <TextField value={value} onCommit={onCommit} />;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return (
      <div style={{ display: "flex", gap: 2 }}>
        {(value as number[]).map((v, i) => (
          <NumberField
            key={i}
            value={v}
            onCommit={(next) => {
              const copy = [...(value as number[])];
              copy[i] = next;
              onCommit(copy);
            }}
          />
        ))}
      </div>
    );
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return (
      <div style={{ paddingLeft: 8, borderLeft: "1px solid #30363d" }}>
        {Object.entries(value as Record<string, unknown>).map(([key, v]) => {
          const commitKey = (next: unknown) =>
            onCommit({ ...(value as Record<string, unknown>), [key]: next });
          const override = typeof v === "string" ? special?.[key] : undefined;
          return (
            <Row key={key} label={key}>
              {override ? (
                override(v as string, commitKey)
              ) : (
                <ValueField value={v} special={special} onCommit={commitKey} />
              )}
            </Row>
          );
        })}
      </div>
    );
  }
  // arrays of objects, nulls, etc. — raw JSON editing as the fallback
  return (
    <TextField
      value={JSON.stringify(value)}
      onCommit={(text) => {
        try {
          onCommit(JSON.parse(text));
        } catch {
          /* invalid JSON: field resyncs from the doc */
        }
      }}
    />
  );
}

export function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0" }}>
      <span style={{ minWidth: 80, color: "#8b949e", fontSize: 11 }}>{props.label}</span>
      <div style={{ flex: 1 }}>{props.children}</div>
    </div>
  );
}
