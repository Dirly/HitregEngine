import { useState } from "react";
import type { AssetLibrary, ComponentRegistry, SceneDoc, SceneStore } from "@hitreg/core";
import type { AssetSelection, Observable, Selection } from "../state.js";
import { apply, buttonStyle, DockHeader, useObservable, useStoreDoc } from "./common.js";
import { Row, TextField, ValueField } from "./fields.js";
import { AssetInspector } from "./asset-inspector.js";

/** Minimal valid data for components whose schemas have required fields. */
const componentSeeds: Record<string, unknown> = {
  light: { kind: "point" },
  mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } },
  prefab: { prefabId: "" },
  rigidbody: {},
  collider: {},
  joint: { kind: "hinge", target: "SET-TARGET-ENTITY-ID" },
  script: { name: "spinner", params: {} },
  sky: {},
  animator: {},
  audio: { src: "chime.wav" },
};

const EMPTY_BONES: Record<string, string[]> = {};
const emptyBonesObservable: Observable<Record<string, string[]>> = {
  get: () => EMPTY_BONES,
  set: () => undefined,
  subscribe: () => () => undefined,
};

export function InspectorDock(props: {
  store: SceneStore;
  registry: ComponentRegistry;
  selection: Selection;
  assets: AssetLibrary;
  assetSelection: AssetSelection;
  assetsVersion: Observable<number>;
  modelBones?: Observable<Record<string, string[]>>;
  saveAsset?: (file: string, content: string) => void;
  thumbnails: Observable<Record<string, string>>;
  onEditPrefab?: (id: string) => void;
}) {
  const doc = useStoreDoc(props.store);
  const selected = useObservable(props.selection);
  const selectedAsset = useObservable(props.assetSelection);
  const thumbnails = useObservable(props.thumbnails);
  useObservable(props.assetsVersion);
  const entity = selected ? doc.entities[selected] : undefined;

  const title =
    selected && entity
      ? `Inspector — ${entity.name}`
      : selectedAsset
        ? `Inspector — ${selectedAsset.kind}: ${selectedAsset.id}`
        : "Inspector";

  return (
    <>
      <DockHeader title={title} />
      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {selected && entity ? (
          <Inspector
            id={selected}
            doc={doc}
            store={props.store}
            registry={props.registry}
            modelBones={props.modelBones}
          />
        ) : selectedAsset ? (
          <AssetInspector
            selection={selectedAsset}
            assets={props.assets}
            assetsVersion={props.assetsVersion}
            saveAsset={props.saveAsset}
            thumbnails={thumbnails}
            onEditPrefab={props.onEditPrefab}
          />
        ) : (
          <div style={{ color: "#8b949e" }}>
            Select an entity (viewport/hierarchy) or an asset (assets panel)
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Bone-name picker: a dropdown of the model's actual bones with a free-text
 * escape hatch (rigs the host hasn't loaded yet, unconventional names).
 */
const BONE_CUSTOM = "custom";
function BoneField(props: { value: string; bones: string[]; onCommit: (v: string) => void }) {
  const [mode, setMode] = useState<"list" | "text" | null>(null);
  const known = props.bones.includes(props.value);
  const showList = mode ? mode === "list" : known;

  if (!showList) {
    return (
      <div style={{ display: "flex", gap: 4 }}>
        <div style={{ flex: 1 }}>
          <TextField value={props.value} onCommit={props.onCommit} />
        </div>
        <button
          style={buttonStyle}
          title="Pick from the model's bones"
          onClick={() => setMode("list")}
        >
          ▾
        </button>
      </div>
    );
  }
  return (
    <select
      style={{ ...buttonStyle, width: "100%" }}
      value={props.value}
      onChange={(e) => {
        if (e.target.value === BONE_CUSTOM) setMode("text");
        else props.onCommit(e.target.value);
      }}
    >
      {!known && <option value={props.value}>{props.value} (not in rig)</option>}
      {props.bones.map((bone) => (
        <option key={bone} value={bone}>
          {bone}
        </option>
      ))}
      <option value={BONE_CUSTOM}>type a name…</option>
    </select>
  );
}

function Inspector(props: {
  id: string;
  doc: SceneDoc;
  store: SceneStore;
  registry: ComponentRegistry;
  modelBones?: Observable<Record<string, string[]>>;
}) {
  const entity = props.doc.entities[props.id]!;
  const [addChoice, setAddChoice] = useState("");
  const available = props.registry.names().filter((name) => !(name in entity.components));
  // bone-socket looks bones up on the PARENT's model, so prefer the parent's
  // rig and fall back to this entity's own (script directly on the model)
  const boneMap = useObservable(props.modelBones ?? emptyBonesObservable);
  const bones =
    (entity.parent ? boneMap[entity.parent] : undefined) ?? boneMap[props.id] ?? [];

  return (
    <div>
      <Row label="name">
        <TextField
          value={entity.name}
          onCommit={(name) =>
            name.length > 0 && apply(props.store, [{ op: "rename", id: props.id, name }])
          }
        />
      </Row>
      <Row label="id">
        <span style={{ color: "#8b949e", fontSize: 10 }}>{props.id}</span>
      </Row>
      <Row label="tags">
        <TextField
          value={entity.tags.join(", ")}
          onCommit={(text) =>
            apply(props.store, [
              {
                op: "set-tags",
                id: props.id,
                tags: text.split(",").map((t) => t.trim()).filter(Boolean),
              },
            ])
          }
        />
      </Row>

      {Object.entries(entity.components).map(([name, data]) => (
        <div key={name} style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong style={{ color: "#d2a8ff" }}>{name}</strong>
            <span
              style={{ color: "#8b949e", cursor: "pointer" }}
              title="Remove component"
              onClick={() =>
                apply(props.store, [{ op: "remove-component", id: props.id, component: name }])
              }
            >
              ✕
            </span>
          </div>
          <ValueField
            value={data}
            special={
              name === "script" && bones.length > 0
                ? {
                    bone: (v, commit) => <BoneField value={v} bones={bones} onCommit={commit} />,
                  }
                : undefined
            }
            onCommit={(next) =>
              apply(props.store, [
                { op: "set-component", id: props.id, component: name, data: next },
              ])
            }
          />
        </div>
      ))}

      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        <select
          style={{ ...buttonStyle, flex: 1 }}
          value={addChoice}
          onChange={(e) => setAddChoice(e.target.value)}
        >
          <option value="">add component…</option>
          {available.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          style={buttonStyle}
          disabled={addChoice === ""}
          onClick={() => {
            apply(props.store, [
              {
                op: "set-component",
                id: props.id,
                component: addChoice,
                data: componentSeeds[addChoice] ?? {},
              },
            ]);
            setAddChoice("");
          }}
        >
          add
        </button>
      </div>
    </div>
  );
}
