import type * as THREE from "three/webgpu";
import { clientLog } from "./dev-log.js";

/**
 * `?shadowWatch=1`: a recorder for the 1-2 frame pops Derek sees while walking (docs/shadow-blink-investigation.md).
 * Every frame it notes what the backend actually drew, and keeps a short history of two kinds of event:
 *
 * - `caster-left`: a mesh drawn into a shadow cascade that is now in no cascade's latest pass. "hidden by X" means
 *   something set it (or a parent) invisible, a distance-hidden prop batch, say; "still visible" means the cascade's
 *   own culling dropped it.
 * - `draw-skipped`: a mesh that never frustum-culls (ground cover, world-space instances) and was drawn last frame,
 *   still wants drawing, and was not drawn this frame.
 *
 * Press F8 when a pop happens: the last 3 s of events, with the camera position, go to the dev server's
 * `.hitreg/client-log.json` (POST /__hitreg/log). Frames with nothing to report cost a few Set operations.
 */

interface DrawnObject {
  object: THREE.Object3D & { isQuadMesh?: boolean; isMesh?: boolean; count?: number };
  camera?: THREE.Camera & { isOrthographicCamera?: boolean; isPerspectiveCamera?: boolean };
}
interface Backend {
  draw(renderObject: DrawnObject, info: unknown): unknown;
}

const HISTORY_MS = 3000;
const MAX_EVENTS = 400;

function label(object: THREE.Object3D): string {
  const parts: string[] = [];
  for (let node: THREE.Object3D | null = object; node && parts.length < 4; node = node.parent) parts.push(node.name || node.type);
  return parts.join(" < ");
}

function hiddenBy(object: THREE.Object3D): string | null {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return node.name || node.type;
  return null;
}

export function installShadowWatch(backend: Backend, camera: () => THREE.Camera): void {
  let frame = 0;
  // per cascade camera: what its latest pass drew
  const cascades = new Map<THREE.Camera, Set<THREE.Object3D>>();
  let cascadeNow = new Map<THREE.Camera, Set<THREE.Object3D>>();
  let mainNow = new Set<THREE.Object3D>();
  let mainLast = new Set<THREE.Object3D>();
  const events: { t: number; frame: number; kind: string; what: string; why: string; at: number[] }[] = [];

  const draw = backend.draw.bind(backend);
  backend.draw = (renderObject, info) => {
    const { object, camera: drawCamera } = renderObject;
    if (object && !object.isQuadMesh && drawCamera) {
      if (drawCamera.isOrthographicCamera) {
        let drawn = cascadeNow.get(drawCamera);
        if (!drawn) cascadeNow.set(drawCamera, (drawn = new Set()));
        drawn.add(object);
      } else if (drawCamera.isPerspectiveCamera && object.frustumCulled === false) {
        mainNow.add(object);
      }
    }
    return draw(renderObject, info);
  };

  const push = (kind: string, object: THREE.Object3D, why: string) => {
    // merged meshes sit at the origin with world-space vertices: their bounds' centre is where they are
    const geometry = (object as THREE.Mesh).geometry;
    if (geometry && !geometry.boundingSphere) geometry.computeBoundingSphere();
    const centre = geometry?.boundingSphere ? geometry.boundingSphere.center.clone().applyMatrix4(object.matrixWorld) : object.getWorldPosition(object.position.clone());
    const at = centre.toArray().map((n) => Math.round(n * 10) / 10);
    events.push({ t: performance.now(), frame, kind, what: label(object), why, at });
    if (events.length > MAX_EVENTS) events.shift();
  };

  const tick = () => {
    frame++;
    for (const [cascade, now] of cascadeNow) {
      const before = cascades.get(cascade);
      cascades.set(cascade, now);
      if (!before) continue;
      for (const object of before) {
        if (now.has(object) || !object.parent) continue;
        let elsewhere = false;
        for (const [other, drawn] of cascades) if (other !== cascade && drawn.has(object)) { elsewhere = true; break; }
        if (elsewhere) continue;
        const hidden = hiddenBy(object);
        push("caster-left", object, hidden ? `hidden by ${hidden}` : object.castShadow ? "still visible" : "castShadow off");
      }
    }
    for (const object of mainLast) {
      const wants = object.parent && !hiddenBy(object) && ((object as DrawnObject["object"]).count ?? 1) > 0;
      if (wants && !mainNow.has(object)) push("draw-skipped", object, "visible, never frustum-culled, not drawn");
    }
    mainLast = mainNow;
    mainNow = new Set();
    cascadeNow = new Map();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.addEventListener("keydown", (e) => {
    if (e.code !== "F8") return;
    e.preventDefault();
    const now = performance.now();
    const recent = events.filter((ev) => now - ev.t <= HISTORY_MS).map((ev) => ({ ...ev, msAgo: Math.round(now - ev.t), t: undefined }));
    const at = camera().position.toArray().map((n) => Math.round(n * 10) / 10);
    clientLog(`shadow-watch F8 at camera ${JSON.stringify(at)} frame ${frame}: ${recent.length} events ${JSON.stringify(recent).slice(0, 15000)}`);
    console.info("[shadow-watch] sent", recent.length, "events");
  });
  console.info("[shadow-watch] on: press F8 right after a pop");
}
