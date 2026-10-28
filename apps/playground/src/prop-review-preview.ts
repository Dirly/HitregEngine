import * as THREE from 'three/webgpu';
import CameraControls from 'camera-controls';
import { AssetLibrary, ComponentRegistry, registerCoreAssetTypes, registerCoreComponents, createScene, applyOps, expandScene } from '@hitreg/core';
import { buildScene, EngineRenderer, loadGltf, waitForMaterialMaps, type MaterialData, type Backend } from '@hitreg/render';
import { getThumb, putThumb } from './thumbnail-cache.js';
import type { ReviewProp } from '@hitreg/editor';
CameraControls.install({ THREE });
type Bundle = {
    id: string;
    hash: string;
    prefabs: Record<string, unknown>;
    materials: Record<string, MaterialData>;
    models: Record<string, string>;
    textures: Record<string, string>;
    warnings: string[];
};
async function subject(project: string, row: ReviewProp) {
    const response = await fetch(`/__hitreg/prop-review/preview?project=${encodeURIComponent(project)}&id=${encodeURIComponent(row.id)}`), bundle = await response.json() as Bundle & {
        error?: string;
    };
    if (!response.ok)
        throw Error(bundle.error ?? 'Model unavailable');
    const assets = new AssetLibrary(), registry = new ComponentRegistry();
    registerCoreComponents(registry);
    registerCoreAssetTypes(assets);
    for (const [id, doc] of Object.entries(bundle.prefabs))
        assets.addPrefab(id, doc);
    for (const [id, data] of Object.entries(bundle.materials))
        assets.addDataAsset({ id, type: 'material', name: id, data });
    await Promise.all(Object.values(bundle.models).map(loadGltf));
    const base = applyOps(createScene('prop preview'), [{ op: 'add-entity', id: 'subject', entity: { name: row.name, parent: null, tags: [], components: { transform: {}, prefab: { prefabId: row.id, props: {}, overrides: [] } } } }], registry).doc;
    const expanded = expandScene(base, assets, registry);
    let count = 0, loaded = 0;
    for (const e of Object.values(expanded.entities)) {
        const mesh = e.components.mesh as {
            source?: {
                kind?: string;
            };
            renderMode?: string;
            moving?: boolean;
            lod?: boolean;
        } | undefined;
        if (mesh) {
            mesh.renderMode = 'auto';
            mesh.moving = true;
            mesh.lod = false;
            if (mesh.source?.kind === 'asset')
                count++;
        }
        delete e.components.light;
        delete e.components.camera;
    }
    let done!: () => void;
    const ready = new Promise<void>(r => { done = r; });
    const built = buildScene(expanded, { resolveMaterial: id => assets.getDataAsset(id)?.data, resolveModel: id => bundle.models[id], resolveTexture: id => bundle.textures[id], onModelLoaded: () => { if (++loaded >= count)
            done(); } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        if (count)
            await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Model preview did not finish loading')), 10000); })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
    // Node materials wire textures into colorNode asynchronously; `.map` may stay null.
    const materials = new Set<THREE.Material>(built.materials.values());
    built.scene.traverse(o => { if (o instanceof THREE.Mesh) for (const mat of Array.isArray(o.material) ? o.material : [o.material]) materials.add(mat); });
    await waitForMaterialMaps(materials);
    built.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(built.scene);
    if (box.isEmpty() || !Number.isFinite(box.min.x))
        throw Error('This prop has no static mesh preview');
    built.scene.background = new THREE.Color('#131921');
    built.scene.add(new THREE.HemisphereLight(0xdde7f5, 0x474235, 2.2));
    const key = new THREE.DirectionalLight(0xffecd5, 3);
    key.position.set(4, 7, 6);
    built.scene.add(key);
    const fill = new THREE.DirectionalLight(0xb9d6ff, 1);
    fill.position.set(-4, 3, -2);
    built.scene.add(fill);
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()), radius = Math.max(size.x, size.y, size.z, .15), camera = new THREE.PerspectiveCamera(38, 1, Math.max(.001, radius / 1000), radius * 30);
    const distance = Math.max(size.length() / 2, .075) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.08;
    camera.position.copy(center).add(new THREE.Vector3(.95, .65, 1.25).normalize().multiplyScalar(distance));
    camera.lookAt(center);
    return { scene: built.scene, camera, center, radius };
}
function dataUrl(canvas: HTMLCanvasElement): Promise<string> { return new Promise((resolve, reject) => canvas.toBlob(blob => { if (!blob) {
    reject(Error('Thumbnail capture failed'));
    return;
} const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(Error('Thumbnail encoding failed')); reader.readAsDataURL(blob); })); }
export class PropPreviewRenderer {
    private renderer: Promise<{
        engine: EngineRenderer;
        backend: Backend;
    }> | undefined;
    private queue: Promise<unknown> = Promise.resolve();
    private jobs = new Map<string, {
        promise: Promise<string>;
        signals: Set<AbortSignal>;
    }>();
    thumbnail(project: string, row: ReviewProp, signal: AbortSignal): Promise<string> {
        if (row.thumbnail)
            return Promise.resolve(row.thumbnail);
        const key = `prop-review:material-ready:${project}:${row.id}:${row.hash}`, existing = this.jobs.get(key);
        if (existing) {
            existing.signals.add(signal);
            return existing.promise;
        }
        const signals = new Set([signal]);
        const job = this.queue.catch(() => { }).then(async () => {
            if ([...signals].every(s => s.aborted))
                throw new DOMException('Preview no longer visible', 'AbortError');
            const cached = await getThumb(key);
            if (cached)
                return cached;
            await new Promise(r => setTimeout(r, 0));
            const { engine, backend } = await (this.renderer ??= this.createRenderer()), { scene, camera } = await subject(project, row), target = new THREE.RenderTarget(256, 256);
            try {
                engine.renderer.setRenderTarget(target);
                engine.renderer.render(scene, camera);
                engine.renderer.setRenderTarget(null);
                const pixels = await engine.renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256) as Uint8Array, canvas = document.createElement('canvas');
                canvas.width = canvas.height = 256;
                const ctx = canvas.getContext('2d', { willReadFrequently: true })!, im = ctx.createImageData(256, 256);
                for (let y = 0; y < 256; y++) {
                    const src = (backend === 'webgl' ? 255 - y : y) * 1024;
                    im.data.set(pixels.subarray(src, src + 1024), y * 1024);
                }
                ctx.putImageData(im, 0, 0);
                const url = await dataUrl(canvas);
                void putThumb(key, url);
                return url;
            }
            finally {
                engine.renderer.setRenderTarget(null);
                target.dispose();
            }
        }).finally(() => { this.jobs.delete(key); });
        this.jobs.set(key, { promise: job, signals });
        this.queue = job;
        return job;
    }
    private async createRenderer() { const engine = new EngineRenderer(document.createElement('canvas')), backend = await engine.init(); engine.renderer.setSize(256, 256, false); engine.renderer.shadowMap.enabled = false; return { engine, backend }; }
    async live(project: string, row: ReviewProp, canvas: HTMLCanvasElement): Promise<() => void> {
        const engine = new EngineRenderer(canvas);
        try {
            await engine.init();
            const { scene, camera, center, radius } = await subject(project, row), controls = new CameraControls(camera, canvas);
            controls.setLookAt(camera.position.x, camera.position.y, camera.position.z, center.x, center.y, center.z, false);
            controls.minDistance = radius * .2;
            controls.maxDistance = radius * 10;
            engine.renderer.shadowMap.enabled = false;
            const resize = () => { const width = canvas.clientWidth || 320, height = canvas.clientHeight || 320; engine.renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
            const observer = new ResizeObserver(resize);
            observer.observe(canvas);
            resize();
            let frame = 0, previous = performance.now(), alive = true;
            const draw = (now: number) => { if (!alive)
                return; controls.update(Math.min(.1, (now - previous) / 1000)); previous = now; engine.renderer.render(scene, camera); frame = requestAnimationFrame(draw); };
            frame = requestAnimationFrame(draw);
            return () => { alive = false; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); engine.dispose(); };
        }
        catch (error) {
            engine.dispose();
            throw error;
        }
    }
}
