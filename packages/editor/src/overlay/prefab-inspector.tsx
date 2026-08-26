import { useState } from "react";
import { describePrefab, PROP_KINDS, type AssetLibrary, type PropKind } from "@hitreg/core";
import { buttonStyle } from "./common.js";
import { NumberField, Row, TextField, ValueField } from "./fields.js";
import { PropControl } from "./prop-field.js";

export function PrefabInspector(props: {
  id: string;
  assets: AssetLibrary;
  onSaved: (stored: unknown) => void;
}) {
  const prefab = props.assets.getPrefab(props.id)!;
  const [openMeta, setOpenMeta] = useState<string | null>(null);
  // the same resolved view the instance inspector and the engine spec read,
  // so what a knob looks like here is exactly what everyone else sees
  const resolved = describePrefab(prefab);

  const update = (mutate: (draft: typeof prefab) => void): void => {
    const draft = structuredClone(prefab);
    mutate(draft);
    try {
      const stored = props.assets.updatePrefab(props.id, draft);
      props.onSaved(stored);
    } catch (error) {
      console.warn("[editor] prefab edit rejected:", error);
    }
  };

  const rows: Array<{ localId: string; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const [localId, entity] of Object.entries(prefab.entities)) {
      if (entity.parent === parent) {
        rows.push({ localId, depth });
        walk(localId, depth + 1);
      }
    }
  };
  walk(null, 0);

  return (
    <div>
      <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 8 }}>
        assets/prefabs/{props.id}.json · edits propagate to all instances
      </div>

      <Row label="name">
        <TextField
          value={prefab.name}
          onCommit={(name) => name.length > 0 && update((d) => void (d.name = name))}
        />
      </Row>

      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <strong style={{ color: "#e6edf3", flex: 1 }}>Props</strong>
          <button
            style={buttonStyle}
            title="Declare a new knob on this prefab"
            onClick={() =>
              update((d) => {
                let name = "prop";
                for (let n = 1; name in d.props; n++) name = `prop${n}`;
                d.props[name] = { default: 0, bindings: [] };
              })
            }
          >
            + prop
          </button>
        </div>
        <div style={{ color: "#8b949e", fontSize: 10, marginTop: 2 }}>
          {Object.keys(prefab.props).length === 0
            ? "none — a prop is the tunable surface of this prefab: it renders as a control on every instance and appears in the engine spec agents read."
            : "declared knobs — kind/range/unit here drive both the instance inspector and the AI-facing spec"}
        </div>
        {resolved.props.map((prop) => {
          const name = prop.name;
          const stored = prefab.props[name]!;
          const metaOpen = openMeta === name;
          return (
            <div
              key={name}
              style={{ marginTop: 6, padding: 6, background: "#161b22", borderRadius: 3 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong style={{ color: "#e3b341", flex: 1 }}>{name}</strong>
                <span style={{ color: "#8b949e", fontSize: 10 }}>{prop.kind}</span>
                <span
                  style={{ color: "#8b949e", cursor: "pointer" }}
                  title="Edit this knob's label, group, range and unit"
                  onClick={() => setOpenMeta(metaOpen ? null : name)}
                >
                  ⚙
                </span>
                <span
                  style={{ color: "#8b949e", cursor: "pointer" }}
                  title="Remove prop"
                  onClick={() => update((d) => void delete d.props[name])}
                >
                  ✕
                </span>
              </div>
              <Row label="default">
                <PropControl
                  spec={prop}
                  value={stored.default}
                  assets={props.assets}
                  onCommit={(v) => update((d) => void (d.props[name]!.default = v))}
                />
              </Row>
              <Row label="binds to">
                <TextField
                  value={stored.bindings.join(", ")}
                  onCommit={(text) =>
                    update(
                      (d) =>
                        void (d.props[name]!.bindings = text
                          .split(",")
                          .map((b) => b.trim())
                          .filter(Boolean)),
                    )
                  }
                />
              </Row>
              {metaOpen && (
                <div style={{ borderLeft: "1px solid #30363d", paddingLeft: 8, marginTop: 4 }}>
                  <Row label="label">
                    <TextField
                      value={stored.label ?? ""}
                      onCommit={(v) =>
                        update((d) => void (d.props[name]!.label = v || undefined))
                      }
                    />
                  </Row>
                  <Row label="description">
                    <TextField
                      value={stored.description ?? ""}
                      onCommit={(v) =>
                        update((d) => void (d.props[name]!.description = v || undefined))
                      }
                    />
                  </Row>
                  <Row label="group">
                    <TextField
                      value={stored.group ?? ""}
                      onCommit={(v) =>
                        update((d) => void (d.props[name]!.group = v || undefined))
                      }
                    />
                  </Row>
                  <Row label="kind">
                    <select
                      style={{ ...buttonStyle, width: "100%" }}
                      value={stored.kind ?? ""}
                      onChange={(e) =>
                        update(
                          (d) =>
                            void (d.props[name]!.kind =
                              (e.target.value as PropKind) || undefined),
                        )
                      }
                    >
                      <option value="">auto ({prop.kind})</option>
                      {PROP_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </select>
                  </Row>
                  {prop.kind === "number" && (
                    <>
                      <Row label="min">
                        <OptionalNumber
                          value={stored.min}
                          onCommit={(v) => update((d) => void (d.props[name]!.min = v))}
                        />
                      </Row>
                      <Row label="max">
                        <OptionalNumber
                          value={stored.max}
                          onCommit={(v) => update((d) => void (d.props[name]!.max = v))}
                        />
                      </Row>
                      <Row label="step">
                        <OptionalNumber
                          value={stored.step}
                          onCommit={(v) => update((d) => void (d.props[name]!.step = v))}
                        />
                      </Row>
                    </>
                  )}
                  <Row label="unit">
                    <TextField
                      value={stored.unit ?? ""}
                      onCommit={(v) => update((d) => void (d.props[name]!.unit = v || undefined))}
                    />
                  </Row>
                  <Row label="options">
                    <ValueField
                      value={stored.options ?? []}
                      onCommit={(v) =>
                        update((d) => {
                          const list = Array.isArray(v) ? v : [];
                          d.props[name]!.options = list.length
                            ? (list as [string | number, ...Array<string | number>])
                            : undefined;
                        })
                      }
                    />
                  </Row>
                  <Row label="asset kind">
                    <TextField
                      value={stored.assetKind ?? ""}
                      onCommit={(v) =>
                        update((d) => void (d.props[name]!.assetKind = v || undefined))
                      }
                    />
                  </Row>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12 }}>
        <strong style={{ color: "#e6edf3" }}>Entities</strong>
        {rows.map(({ localId, depth }) => {
          const entity = prefab.entities[localId]!;
          return (
            <div
              key={localId}
              style={{
                marginTop: 6,
                marginLeft: depth * 12,
                padding: 6,
                background: "#161b22",
                borderRadius: 3,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>
                  · {entity.name}
                  {localId === prefab.root && (
                    <span style={{ color: "#8b949e", fontSize: 10 }}> (root)</span>
                  )}
                </span>
                <span style={{ color: "#8b949e", fontSize: 10 }}>{localId}</span>
              </div>
              {Object.entries(entity.components).map(([comp, data]) => (
                <div key={comp} style={{ marginTop: 4 }}>
                  <strong style={{ color: "#d2a8ff", fontSize: 11 }}>{comp}</strong>
                  <ValueField
                    value={data}
                    onCommit={(next) =>
                      update((d) => void (d.entities[localId]!.components[comp] = next))
                    }
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A numeric knob-metadata field that can be cleared back to "unset". */
function OptionalNumber(props: { value?: number; onCommit: (value: number | undefined) => void }) {
  if (props.value === undefined) {
    return (
      <button style={buttonStyle} onClick={() => props.onCommit(0)}>
        set
      </button>
    );
  }
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <NumberField value={props.value} onCommit={props.onCommit} />
      </div>
      <span
        style={{ color: "#8b949e", cursor: "pointer" }}
        title="Clear"
        onClick={() => props.onCommit(undefined)}
      >
        ✕
      </span>
    </div>
  );
}
