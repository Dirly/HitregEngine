import { useState } from "react";
import {
  buildTopology,
  polyFromPolygon,
  polyFromPrimitive,
  regenerate,
  shapeSpec,
  validatePolyMesh,
  type AssetLibrary,
  type Op,
  type PolyMesh,
  type SceneStore,
  type ShapeParams,
} from "@hitreg/core";
import type { MeshEditState } from "../state.js";
import { apply, buttonStyle, activeButtonStyle, useObservable } from "./common.js";
import { BooleanField, NumberField, Row, ValueField } from "./fields.js";

type Vec3 = [number, number, number];

interface MeshComponent {
  source: Record<string, unknown> & { kind: string };
  material?: string;
  [k: string]: unknown;
}

/**
 * Inspector view of a `mesh` component. Poly meshes get a real panel (the
 * raw JSON of a few hundred vertices is unreadable): stats, shape settings
 * while the parametric generator is still valid, material slots, and the
 * "edit mesh" entry point. Primitive/polygon sources get a one-click
 * "make editable" conversion. Everything else is the generic value editor.
 */
export function MeshComponentPanel(props: {
  id: string;
  data: unknown;
  store: SceneStore;
  assets: AssetLibrary;
  meshEdit?: MeshEditState;
}) {
  const [raw, setRaw] = useState(false);
  const component = props.data as MeshComponent;
  const source = component?.source;
  const commit = (next: unknown, extra: Op[] = []): void =>
    apply(props.store, [{ op: "set-component", id: props.id, component: "mesh", data: next }, ...extra]);

  if (!source || source.kind !== "poly" || raw) {
    return (
      <div>
        {source?.kind === "poly" && (
          <div style={{ display: "flex", justifyContent: "flex-end", margin: "2px 0" }}>
            <button style={buttonStyle} onClick={() => setRaw(false)}>
              panel
            </button>
          </div>
        )}
        {(source?.kind === "primitive" || source?.kind === "polygon") && (
          <div style={{ margin: "4px 0" }}>
            <button
              style={buttonStyle}
              title="Convert this shape into an editable poly mesh (vertices/edges/faces, UVs, per-face materials)"
              onClick={() => convertToPoly(props.id, component, props.store, props.meshEdit)}
            >
              ✎ make editable mesh
            </button>
          </div>
        )}
        <ValueField value={props.data} onCommit={commit} />
      </div>
    );
  }

  return (
    <PolyPanel
      id={props.id}
      component={component as MeshComponent & { source: PolyMesh }}
      store={props.store}
      assets={props.assets}
      meshEdit={props.meshEdit}
      onRaw={() => setRaw(true)}
      commit={commit}
    />
  );
}

function PolyPanel(props: {
  id: string;
  component: MeshComponent & { source: PolyMesh };
  store: SceneStore;
  assets: AssetLibrary;
  meshEdit?: MeshEditState;
  onRaw: () => void;
  commit: (next: unknown, extra?: Op[]) => void;
}) {
  const mesh = props.component.source;
  const topo = buildTopology(mesh);
  const issues = validatePolyMesh(mesh);
  const editing = useObservable(props.meshEdit?.active ?? nullObservable);
  const editingId = useObservable(props.meshEdit?.entityId ?? nullIdObservable);
  const isThis = editing && editingId === props.id;
  const spec = mesh.generator ? shapeSpec(mesh.generator.shape) : undefined;
  const materials = props.assets.dataAssetsOfType("material");

  const setSource = (next: PolyMesh): void => props.commit({ ...props.component, source: next });
  const setParams = (patch: ShapeParams): void => {
    const next = regenerate(mesh, patch);
    if (next) setSource(next);
  };
  const setSlot = (slot: number, materialId: string): void => {
    const slots = [...mesh.materials];
    while (slots.length <= slot) slots.push("");
    slots[slot] = materialId;
    setSource({ ...mesh, materials: slots });
  };
  const slotCount = Math.max(mesh.materials.length, ...mesh.faces.map((f) => (f.mat ?? 0) + 1));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0" }}>
        <span style={{ color: "#8b949e", fontSize: 11, flex: 1 }}>
          editable mesh · {mesh.vertices.length}v {topo.edges.length}e {mesh.faces.length}f
          {mesh.generator ? ` · ${mesh.generator.shape}` : ""}
        </span>
        {props.meshEdit && (
          <button
            style={isThis ? activeButtonStyle : buttonStyle}
            title="Edit vertices/edges/faces in the viewport (keys 2/3/4)"
            onClick={() => {
              if (isThis) props.meshEdit!.active.set(false);
              else {
                if (props.meshEdit!.mode.get() === "object") props.meshEdit!.mode.set("face");
                props.meshEdit!.active.set(true);
              }
            }}
          >
            {isThis ? "✓ editing" : "✎ edit mesh"}
          </button>
        )}
        <button style={buttonStyle} title="Raw component JSON" onClick={props.onRaw}>
          raw
        </button>
      </div>

      {issues.length > 0 && (
        <div style={{ color: "#f85149", fontSize: 11, margin: "4px 0" }}>
          {issues.slice(0, 3).map((issue) => (
            <div key={issue}>⚠ {issue}</div>
          ))}
        </div>
      )}

      {spec && mesh.generator && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "#8b949e", fontSize: 11 }}>SHAPE SETTINGS · {spec.label}</div>
          {spec.params.map((p) => {
            const value = mesh.generator!.params[p.key] ?? p.default;
            return (
              <Row key={p.key} label={p.label}>
                {p.kind === "boolean" ? (
                  <BooleanField value={Boolean(value)} onCommit={(v) => setParams({ [p.key]: v })} />
                ) : (
                  <NumberField
                    value={Number(value)}
                    onCommit={(v) => {
                      const clamped = Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, p.kind === "int" ? Math.round(v) : v));
                      setParams({ [p.key]: clamped });
                    }}
                  />
                )}
              </Row>
            );
          })}
          <div style={{ color: "#8b949e", fontSize: 10 }}>editing the mesh by hand freezes these settings</div>
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        <div style={{ color: "#8b949e", fontSize: 11 }}>MATERIAL SLOTS · per-face (assign faces in mesh edit)</div>
        {Array.from({ length: slotCount }, (_, slot) => (
          <Row key={slot} label={`slot ${slot}`}>
            <select
              style={{ ...buttonStyle, width: "100%", padding: "2px 4px" }}
              value={mesh.materials[slot] ?? ""}
              onChange={(e) => setSlot(slot, e.target.value)}
            >
              <option value="">{slot === 0 ? "(component material)" : "(component material)"}</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name.split("/").pop()}
                </option>
              ))}
            </select>
          </Row>
        ))}
        <span style={{ color: "#8b949e", fontSize: 10 }}>
          {mesh.faces.filter((f) => f.uv?.mode === "manual").length} face(s) with manual UVs ·{" "}
          {new Set(mesh.faces.map((f) => f.smooth ?? 0)).size} smoothing group(s)
        </span>
      </div>

      <div style={{ marginTop: 6 }}>
        <Row label="material">
          <select
            style={{ ...buttonStyle, width: "100%", padding: "2px 4px" }}
            value={props.component.material ?? ""}
            onChange={(e) => {
              const next = { ...props.component } as Record<string, unknown>;
              if (e.target.value) next["material"] = e.target.value;
              else delete next["material"];
              props.commit(next);
            }}
          >
            <option value="">(engine default)</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name.split("/").pop()}
              </option>
            ))}
          </select>
        </Row>
        {(["castShadow", "receiveShadow", "static"] as const).map((key) => (
          <Row key={key} label={key}>
            <BooleanField
              value={Boolean(props.component[key] ?? (key !== "static"))}
              onCommit={(v) => props.commit({ ...props.component, [key]: v })}
            />
          </Row>
        ))}
      </div>
    </div>
  );
}

/** Replace a primitive/polygon source with an equivalent poly mesh (keeping world placement) and open it for editing. */
export function convertToPoly(id: string, component: MeshComponent, store: SceneStore, meshEdit?: MeshEditState): void {
  const source = component.source;
  let mesh: PolyMesh;
  let offset: Vec3 = [0, 0, 0];
  if (source.kind === "primitive") {
    const r = polyFromPrimitive(source as unknown as Parameters<typeof polyFromPrimitive>[0]);
    mesh = r.mesh;
    offset = r.offset;
  } else if (source.kind === "polygon") {
    mesh = polyFromPolygon(source as unknown as Parameters<typeof polyFromPolygon>[0]);
  } else {
    return;
  }
  const entity = store.doc.entities[id];
  if (!entity) return;
  const ops: Op[] = [{ op: "set-component", id, component: "mesh", data: { ...component, source: mesh } }];
  if (offset[0] !== 0 || offset[1] !== 0 || offset[2] !== 0) {
    const transform = (entity.components["transform"] ?? {}) as {
      position?: Vec3;
      rotation?: [number, number, number, number];
      scale?: Vec3;
    };
    const p = transform.position ?? [0, 0, 0];
    const s = transform.scale ?? [1, 1, 1];
    const q = transform.rotation ?? [0, 0, 0, 1];
    const rotated = rotate([offset[0] * s[0], offset[1] * s[1], offset[2] * s[2]], q);
    ops.push({
      op: "set-component",
      id,
      component: "transform",
      data: { ...transform, position: [p[0] + rotated[0], p[1] + rotated[1], p[2] + rotated[2]] },
    });
  }
  const collider = entity.components["collider"] as { shape?: string; offset?: Vec3 } | undefined;
  if (collider && collider.shape === "box") {
    // the primitive's box collider was centered on the origin; the poly mesh stands on y=0
    const o = collider.offset ?? [0, 0, 0];
    ops.push({
      op: "set-component",
      id,
      component: "collider",
      data: { ...collider, offset: [o[0] - offset[0], o[1] - offset[1], o[2] - offset[2]] },
    });
  } else if (collider && (collider.shape === "sphere" || collider.shape === "cylinder" || collider.shape === "capsule")) {
    ops.push({ op: "set-component", id, component: "collider", data: { ...collider, shape: "convex" } });
  }
  apply(store, ops);
  if (meshEdit) {
    if (meshEdit.mode.get() === "object") meshEdit.mode.set("face");
    meshEdit.active.set(true);
  }
}

function rotate(v: Vec3, q: [number, number, number, number]): Vec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
}

const nullObservable = { get: () => false, set: () => undefined, subscribe: () => () => undefined };
const nullIdObservable = { get: () => null as string | null, set: () => undefined, subscribe: () => () => undefined };
