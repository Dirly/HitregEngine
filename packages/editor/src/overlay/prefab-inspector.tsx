import type { AssetLibrary } from "@hitreg/core";
import { Row, TextField, ValueField } from "./fields.js";

export function PrefabInspector(props: {
  id: string;
  assets: AssetLibrary;
  onSaved: (stored: unknown) => void;
}) {
  const prefab = props.assets.getPrefab(props.id)!;

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
        <strong style={{ color: "#e6edf3" }}>Props</strong>
        {Object.keys(prefab.props).length === 0 && (
          <div style={{ color: "#8b949e", fontSize: 11, marginTop: 2 }}>
            none — props expose tunable values (see prefab-streetlight.json for the shape)
          </div>
        )}
        {Object.entries(prefab.props).map(([name, spec]) => (
          <div key={name} style={{ marginTop: 6, padding: 6, background: "#161b22", borderRadius: 3 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <strong style={{ color: "#e3b341" }}>{name}</strong>
              <span
                style={{ color: "#8b949e", cursor: "pointer" }}
                title="Remove prop"
                onClick={() => update((d) => void delete d.props[name])}
              >
                ✕
              </span>
            </div>
            <Row label="default">
              <ValueField
                value={spec.default}
                onCommit={(v) => update((d) => void (d.props[name]!.default = v))}
              />
            </Row>
            <div style={{ color: "#8b949e", fontSize: 10 }}>
              → {spec.bindings.join(", ") || "(no bindings)"}
            </div>
          </div>
        ))}
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
