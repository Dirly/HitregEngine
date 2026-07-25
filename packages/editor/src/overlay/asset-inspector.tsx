import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AssetLibrary, SpritesheetDoc } from "@hitreg/core";
import type { Observable } from "../state.js";
import { activeButtonStyle, buttonStyle } from "./common.js";
import { ColorField, Row, SliderField, ValueField } from "./fields.js";
import { SpritesheetInspector } from "./spritesheet-inspector.js";
import { PrefabInspector } from "./prefab-inspector.js";

export function AssetInspector(props: {
  selection: { kind: "material" | "prefab" | "model" | "texture" | "spritesheet"; id: string };
  assets: AssetLibrary;
  assetsVersion: Observable<number>;
  saveAsset?: (file: string, content: string) => void;
  thumbnails: Record<string, string>;
  onEditPrefab?: (id: string) => void;
}) {
  const bump = () => props.assetsVersion.set(props.assetsVersion.get() + 1);
  const { kind, id } = props.selection;

  if (kind === "material") {
    const asset = props.assets.getDataAsset(id);
    if (!asset) return <div style={{ color: "#8b949e" }}>Missing material {id}</div>;
    const data = asset.data as {
      shader: string;
      color: string;
      roughness: number;
      metalness: number;
      emissive: string;
      emissiveIntensity: number;
      emissiveMap?: string;
      opacity: number;
      transparent: boolean;
    };
    const commit = (patch: Record<string, unknown>) => {
      try {
        const stored = props.assets.updateDataAsset({ ...asset, data: { ...data, ...patch } });
        props.saveAsset?.(`materials/${id}.json`, JSON.stringify(stored.data, null, 2));
        bump();
      } catch (error) {
        console.warn("[editor] material update rejected:", error);
      }
    };
    return (
      <div>
        <AssetPreview key={`material:${id}`} material={data} assets={props.assets} />
        <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 8 }}>
          assets/materials/{id}.json — edits apply live to every mesh using it (preview refreshes on save)
        </div>
        <Row label="shader">
          <select
            style={{ ...buttonStyle, width: "100%" }}
            value={data.shader}
            onChange={(e) => commit({ shader: e.target.value })}
          >
            {["standard", "unlit", "toon", "wireframe", "terrain-splat", "water"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Row>
        {(data.shader === "terrain-splat" || data.shader === "water") && (
          <div style={{ color: "#8b949e", fontSize: 10, marginBottom: 8 }}>
            {data.shader === "terrain-splat"
              ? "Height/slope layers (splat.layers, splat.slopeRock) aren't editable here yet — author them in assets/materials/{id}.json."
              : "Wave/fresnel params (water.*) aren't editable here yet — author them in assets/materials/{id}.json."}
          </div>
        )}
        <Row label="color">
          <ColorField value={data.color} onCommit={(v) => commit({ color: v })} />
        </Row>
        <Row label="texture">
          <select
            style={{ ...buttonStyle, width: "100%" }}
            value={(data as { map?: string }).map ?? ""}
            onChange={(e) => commit({ map: e.target.value || undefined })}
          >
            <option value="">(none)</option>
            {props.assets.textureIds().map((tid) => (
              <option key={tid} value={tid}>
                {tid}
              </option>
            ))}
          </select>
        </Row>
        {(data as { map?: string }).map && (
          <Row label="tiling">
            <ValueField
              value={(data as { repeat?: [number, number] }).repeat ?? [1, 1]}
              onCommit={(v) => commit({ repeat: v })}
            />
          </Row>
        )}
        {data.shader === "standard" && (
          <>
            <Row label="roughness">
              <SliderField value={data.roughness} min={0} max={1} onCommit={(v) => commit({ roughness: v })} />
            </Row>
            <Row label="metalness">
              <SliderField value={data.metalness} min={0} max={1} onCommit={(v) => commit({ metalness: v })} />
            </Row>
          </>
        )}
        {(data.shader === "standard" || data.shader === "toon" || data.shader === "unlit") && (
          <>
            <Row label="emissive">
              <ColorField value={data.emissive} onCommit={(v) => commit({ emissive: v })} />
            </Row>
            <Row label="glow">
              <SliderField
                value={data.emissiveIntensity}
                min={0}
                max={10}
                step={0.1}
                onCommit={(v) => commit({ emissiveIntensity: v })}
              />
            </Row>
          </>
        )}
        {(data.shader === "standard" || data.shader === "toon") && (
          <Row label="emissive mask">
            <select
              style={{ ...buttonStyle, width: "100%" }}
              value={data.emissiveMap ?? ""}
              onChange={(e) => commit({ emissiveMap: e.target.value || undefined })}
              title="White areas of this texture glow at full emissive/glow strength regardless of lighting — lit + unlit in one material (e.g. glowing eyes/screens on an otherwise lit mesh)."
            >
              <option value="">(none)</option>
              {props.assets.textureIds().map((tid) => (
                <option key={tid} value={tid}>
                  {tid}
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row label="opacity">
          <SliderField value={data.opacity} min={0} max={1} onCommit={(v) => commit({ opacity: v })} />
        </Row>
        <Row label="transparent">
          <input
            type="checkbox"
            checked={data.transparent}
            onChange={(e) => commit({ transparent: e.target.checked })}
          />
        </Row>
      </div>
    );
  }

  if (kind === "spritesheet") {
    const asset = props.assets.getDataAsset(id);
    if (!asset) return <div style={{ color: "#8b949e" }}>Missing spritesheet {id}</div>;
    const data = asset.data as SpritesheetDoc;
    const commit = (patch: Partial<SpritesheetDoc>) => {
      try {
        const stored = props.assets.updateDataAsset({ ...asset, data: { ...data, ...patch } });
        props.saveAsset?.(`spritesheets/${id}.json`, JSON.stringify(stored.data, null, 2));
        bump();
      } catch (error) {
        console.warn("[editor] spritesheet update rejected:", error);
      }
    };
    return (
      <SpritesheetInspector
        id={id}
        data={data}
        assets={props.assets}
        onCommit={commit}
      />
    );
  }

  if (kind === "prefab") {
    const prefab = props.assets.getPrefab(id);
    if (!prefab) return <div style={{ color: "#8b949e" }}>Missing prefab {id}</div>;
    return (
      <div>
        {props.onEditPrefab && (
          <button
            style={{ ...activeButtonStyle, width: "100%", marginBottom: 8 }}
            title="Open this prefab alone in the viewport — full toolset; saving propagates to all instances"
            onClick={() => props.onEditPrefab?.(id)}
          >
            ✎ edit in viewport
          </button>
        )}
        <PrefabInspector
          id={id}
          assets={props.assets}
          onSaved={(stored) => {
            props.saveAsset?.(`prefabs/${id}.json`, JSON.stringify(stored, null, 2));
            bump();
          }}
        />
      </div>
    );
  }

  if (kind === "texture") {
    const texture = props.assets.getTexture(id);
    if (!texture) return <div style={{ color: "#8b949e" }}>Missing texture {id}</div>;
    return (
      <div>
        <img
          src={texture.url}
          alt={texture.name}
          style={{ width: "100%", borderRadius: 3, background: "#0b0e14" }}
        />
        <Row label="id">
          <span style={{ color: "#8b949e", fontSize: 10 }}>{id}</span>
        </Row>
        <div style={{ color: "#8b949e", fontSize: 10, marginTop: 6 }}>
          assets/textures/ — assign via a material's texture dropdown
        </div>
      </div>
    );
  }

  const model = props.assets.getModel(id);
  if (!model) return <div style={{ color: "#8b949e" }}>Missing model {id}</div>;
  return (
    <div>
      <AssetPreview key={`model:${id}`} modelUrl={model.url} assets={props.assets} />
      <Row label="name">
        <span>{model.name}</span>
      </Row>
      <Row label="url">
        <span style={{ color: "#8b949e", fontSize: 10, wordBreak: "break-all" }}>{model.url}</span>
      </Row>
      <div style={{ color: "#8b949e", fontSize: 10, marginTop: 6 }}>
        glTF/GLB from assets/models/
      </div>
    </div>
  );
}

/**
 * A small, real renderer for the asset inspector. Thumbnails are useful for
 * scanning, but this view is deliberately interactive: drag to orbit and
 * wheel to zoom the selected model or material preview.
 */
function AssetPreview(props: {
  assets: AssetLibrary;
  modelUrl?: string;
  material?: {
    shader: string;
    color: string;
    map?: string;
    repeat?: [number, number];
    roughness: number;
    metalness: number;
    emissive: string;
    emissiveIntensity: number;
    emissiveMap?: string;
    opacity: number;
    transparent: boolean;
  };
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x1b2432, 2.2));
    const key = new THREE.DirectionalLight(0xfff1dc, 3);
    key.position.set(4, 6, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8ab8ff, 1.5);
    rim.position.set(-4, 2, -4);
    scene.add(rim);

    const subject = new THREE.Group();
    scene.add(subject);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    let azimuth = 0.7;
    let elevation = 0.35;
    let distance = 3;
    const target = new THREE.Vector3();
    const spherical = new THREE.Spherical();
    let dragging: { x: number; y: number } | null = null;
    let disposed = false;
    let previewTexture: THREE.Texture | null = null;
    let previewEmissiveTexture: THREE.Texture | null = null;

    const render = () => {
      if (disposed) return;
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      spherical.set(distance, Math.PI / 2 - elevation, azimuth);
      camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
      camera.lookAt(target);
      renderer.render(scene, camera);
    };

    const frameSubject = () => {
      const bounds = new THREE.Box3().setFromObject(subject);
      if (bounds.isEmpty()) return;
      const size = bounds.getSize(new THREE.Vector3()).length() || 1;
      bounds.getCenter(target);
      distance = Math.max(size * 1.35, 1.5);
      camera.near = Math.max(size / 1000, 0.01);
      camera.far = Math.max(size * 100, 100);
      render();
    };

    if (props.material) {
      const data = props.material;
      const common = {
        color: data.color || "#9aa0a8",
        transparent: data.transparent,
        opacity: data.opacity,
      };
      let material: THREE.Material & { map?: THREE.Texture | null; emissiveMap?: THREE.Texture | null };
      switch (data.shader) {
        case "unlit":
          material = new THREE.MeshBasicMaterial(common);
          break;
        case "toon":
          material = new THREE.MeshToonMaterial({
            ...common,
            emissive: data.emissive,
            emissiveIntensity: data.emissiveIntensity,
          });
          break;
        case "wireframe":
          material = new THREE.MeshBasicMaterial({ ...common, wireframe: true });
          break;
        default:
          material = new THREE.MeshStandardMaterial({
            ...common,
            roughness: data.roughness,
            metalness: data.metalness,
            emissive: data.emissive,
            emissiveIntensity: data.emissiveIntensity,
          });
      }
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), material);
      subject.add(sphere);
      const textureUrl = data.map ? props.assets.getTexture(data.map)?.url : undefined;
      if (textureUrl && data.shader !== "wireframe") {
        new THREE.TextureLoader().load(textureUrl, (texture) => {
          if (disposed) {
            texture.dispose();
            return;
          }
          previewTexture = texture;
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          const [x, y] = data.repeat ?? [1, 1];
          texture.repeat.set(x, y);
          material.map = texture;
          material.needsUpdate = true;
          render();
        });
      }
      const emissiveMapUrl =
        data.emissiveMap && (data.shader === "standard" || data.shader === "toon")
          ? props.assets.getTexture(data.emissiveMap)?.url
          : undefined;
      if (emissiveMapUrl) {
        new THREE.TextureLoader().load(emissiveMapUrl, (texture) => {
          if (disposed) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          const [x, y] = data.repeat ?? [1, 1];
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(x, y);
          previewEmissiveTexture = texture;
          material.emissiveMap = texture;
          material.needsUpdate = true;
          render();
        });
      }
      frameSubject();
    } else if (props.modelUrl) {
      new GLTFLoader().load(
        props.modelUrl,
        (gltf) => {
          if (disposed) return;
          subject.add(gltf.scene);
          frameSubject();
        },
        undefined,
        (error) => console.warn("[editor] asset preview failed to load:", error),
      );
    }

    const onPointerDown = (event: PointerEvent) => {
      dragging = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      azimuth -= (event.clientX - dragging.x) * 0.012;
      elevation = Math.max(-1.45, Math.min(1.45, elevation + (event.clientY - dragging.y) * 0.012));
      dragging = { x: event.clientX, y: event.clientY };
      render();
    };
    const onPointerUp = () => (dragging = null);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      distance = Math.max(0.3, Math.min(100, distance * Math.exp(event.deltaY * 0.001)));
      render();
    };
    const resize = new ResizeObserver(render);
    resize.observe(canvas);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    render();

    return () => {
      disposed = true;
      resize.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      previewTexture?.dispose();
      previewEmissiveTexture?.dispose();
      subject.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.filter(Boolean).forEach((material) => material.dispose());
      });
      renderer.dispose();
    };
  }, [props.assets, props.material, props.modelUrl]);

  return (
    <div style={{ marginBottom: 8 }}>
      <canvas
        ref={canvasRef}
        title="Drag to orbit · scroll to zoom"
        style={{ width: "100%", height: 220, display: "block", borderRadius: 3, cursor: "grab" }}
      />
      <div style={{ color: "#8b949e", fontSize: 10, marginTop: 4 }}>drag to orbit · scroll to zoom</div>
    </div>
  );
}
