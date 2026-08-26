import { useState } from "react";
import type { AssetLibrary, PrefabPropSpec, PrefabSpec } from "@hitreg/core";
import { buttonStyle } from "./common.js";
import {
  BooleanField,
  ColorField,
  NumberField,
  SliderField,
  TextField,
  ValueField,
} from "./fields.js";

/**
 * The human half of the knob contract. A prefab declares what may be tuned
 * (kind, range, unit, group); this renders the matching control, so nobody
 * hand-writes an inspector for AI-generated content — the generator's own
 * declaration is the UI. Everything an agent can read in the engine spec, a
 * person can turn here, and vice versa.
 */

const labelStyle: React.CSSProperties = { color: "#8b949e", fontSize: 11 };

/** One control, chosen by the prop's resolved kind. */
export function PropControl(props: {
  spec: PrefabPropSpec;
  value: unknown;
  assets?: AssetLibrary;
  onCommit: (value: unknown) => void;
}) {
  const { spec, value, onCommit } = props;

  switch (spec.kind) {
    case "number": {
      const current = typeof value === "number" ? value : Number(spec.default) || 0;
      if (spec.min !== undefined && spec.max !== undefined) {
        return (
          <SliderField
            value={current}
            min={spec.min}
            max={spec.max}
            step={spec.step ?? (spec.max - spec.min) / 100}
            onCommit={onCommit}
          />
        );
      }
      return <NumberField value={current} onCommit={onCommit} />;
    }
    case "boolean":
      return <BooleanField value={value === true} onCommit={onCommit} />;
    case "color":
      return (
        <ColorField value={typeof value === "string" ? value : "#ffffff"} onCommit={onCommit} />
      );
    case "enum": {
      const options = spec.options ?? [];
      const current = String(value ?? spec.default ?? "");
      return (
        <select
          style={{ ...buttonStyle, width: "100%" }}
          value={current}
          onChange={(e) => {
            const picked = options.find((o) => String(o) === e.target.value);
            onCommit(picked ?? e.target.value);
          }}
        >
          {!options.some((o) => String(o) === current) && (
            <option value={current}>{current || "(unset)"} (not an option)</option>
          )}
          {options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      );
    }
    case "asset": {
      const ids = assetIds(props.assets, spec.assetKind);
      const current = typeof value === "string" ? value : "";
      if (ids.length === 0) return <TextField value={current} onCommit={onCommit} />;
      return (
        <select
          style={{ ...buttonStyle, width: "100%" }}
          value={current}
          onChange={(e) => onCommit(e.target.value)}
        >
          <option value="">(none)</option>
          {!ids.includes(current) && current !== "" && (
            <option value={current}>{current} (missing)</option>
          )}
          {ids.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      );
    }
    case "vec3": {
      const vec = Array.isArray(value) && value.length === 3 ? (value as number[]) : [0, 0, 0];
      return (
        <div style={{ display: "flex", gap: 2 }}>
          {vec.map((v, i) => (
            <NumberField
              key={i}
              value={v}
              onCommit={(next) => {
                const copy = [...vec];
                copy[i] = next;
                onCommit(copy);
              }}
            />
          ))}
        </div>
      );
    }
    case "string":
      return <TextField value={typeof value === "string" ? value : ""} onCommit={onCommit} />;
    default:
      return <ValueField value={value} onCommit={onCommit} />;
  }
}

function assetIds(assets: AssetLibrary | undefined, kind: string | undefined): string[] {
  if (!assets || !kind) return [];
  switch (kind) {
    case "prefab":
      return assets.prefabIds();
    case "model":
      return assets.modelIds();
    case "texture":
      return assets.textureIds();
    case "audio":
    case "sound":
      return assets.soundIds();
    default:
      // any registered data-asset type: "material", "spritesheet", ...
      return assets.dataAssetsOfType(kind).map((a) => a.id);
  }
}

/**
 * A prefab instance's knob panel: every declared prop, grouped, with the ones
 * this instance has changed marked and individually revertible. Unset knobs
 * render their definition default dimmed — the difference between "the prefab
 * says 600 rpm" and "this particular rifle says 900" stays visible, which is
 * the whole point of an override stack.
 */
export function PrefabKnobs(props: {
  spec: PrefabSpec;
  /** Values explicitly set on this instance (absent key = using the default). */
  values: Record<string, unknown>;
  assets?: AssetLibrary;
  onSet: (name: string, value: unknown) => void;
  onReset: (name: string) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const visible = props.spec.props.filter((p) => showAdvanced || !p.advanced);
  const hiddenCount = props.spec.props.length - visible.length;

  if (props.spec.props.length === 0) {
    return (
      <div style={{ ...labelStyle, marginTop: 4 }}>
        This prefab declares no props — nothing is tunable per instance yet. Add props to its
        definition to expose knobs here (and to the engine spec agents read).
      </div>
    );
  }

  return (
    <div>
      {props.spec.groups.map((group) => {
        const inGroup = visible.filter((p) => (p.group ?? "") === group);
        if (inGroup.length === 0) return null;
        return (
          <div key={group || "_"} style={{ marginTop: group ? 10 : 4 }}>
            {group && (
              <div style={{ ...labelStyle, textTransform: "uppercase", letterSpacing: 0.4 }}>
                {group}
              </div>
            )}
            {inGroup.map((prop) => (
              <Knob
                key={prop.name}
                spec={prop}
                overridden={prop.name in props.values}
                value={prop.name in props.values ? props.values[prop.name] : prop.default}
                assets={props.assets}
                onCommit={(v) => props.onSet(prop.name, v)}
                onReset={() => props.onReset(prop.name)}
              />
            ))}
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <button style={{ ...buttonStyle, marginTop: 8 }} onClick={() => setShowAdvanced(true)}>
          show {hiddenCount} advanced...
        </button>
      )}
      {showAdvanced && (
        <button style={{ ...buttonStyle, marginTop: 8 }} onClick={() => setShowAdvanced(false)}>
          hide advanced
        </button>
      )}
    </div>
  );
}

function Knob(props: {
  spec: PrefabPropSpec;
  value: unknown;
  overridden: boolean;
  assets?: AssetLibrary;
  onCommit: (value: unknown) => void;
  onReset: () => void;
}) {
  const { spec } = props;
  return (
    <div style={{ margin: "4px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            minWidth: 92,
            fontSize: 11,
            // an overridden knob reads as bold + bulleted, never by color alone
            color: props.overridden ? "#e6edf3" : "#8b949e",
            fontWeight: props.overridden ? 600 : 400,
          }}
          title={spec.description ?? spec.name}
        >
          {props.overridden ? "• " : ""}
          {spec.label}
          {spec.unit ? <span style={labelStyle}> ({spec.unit})</span> : null}
        </span>
        <div style={{ flex: 1 }}>
          <PropControl
            spec={spec}
            value={props.value}
            assets={props.assets}
            onCommit={props.onCommit}
          />
        </div>
        <span
          title={props.overridden ? "Revert to the prefab's default" : "Matches the prefab default"}
          onClick={() => props.overridden && props.onReset()}
          style={{
            width: 12,
            textAlign: "center",
            color: props.overridden ? "#8b949e" : "#30363d",
            cursor: props.overridden ? "pointer" : "default",
          }}
        >
          {"↺"}
        </span>
      </div>
      {spec.description && (
        <div style={{ ...labelStyle, marginLeft: 98, fontSize: 10 }}>{spec.description}</div>
      )}
    </div>
  );
}
