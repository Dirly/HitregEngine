/**
 * A pipeline made for a draw is created synchronously, and that blocks the GPU process: the main thread sits idle while no
 * frame can present (0.7-1.5 s on a walk, up to 18 s at load, none of it in any JS timing). Three already skips a draw
 * until its pipeline is ready and has an async path; it takes it only inside `compileAsync`. This sends the frame's draws
 * down it too, so a mesh meeting a new pipeline appears a few frames late rather than stopping the world.
 *
 * Only while `gate.active` (the frame's render): a one-shot render, such as an impostor bake, must not skip its draw.
 * Fullscreen passes stay synchronous: skipped, the whole frame would be missing.
 */

/** Runtime switch for an A/B (`?asyncPipelines=0`). */
export const asyncPipelines = { enabled: true };

export interface PipelineGate {
  active: boolean;
  /** Pipelines still compiling: a load screen holds for them, or the player enters a town missing walls. */
  pending: number;
  /** Shader code generated this frame (ms); the host's render clears it. */
  buildMs: number;
  /** Past this, a mesh needing a new shader waits for a later frame. Infinity = no cap. */
  budgetMs: number;
}

/**
 * Shader code generation is synchronous, ~95 ms each, and a place coming into view asked for 5-7 in one frame: a 700 ms
 * freeze. Past the budget a mesh with no shader sits out the frame, as it does for an unready pipeline, so that freeze
 * becomes a few ~100 ms frames. A mesh sharing a cached shader costs nothing and always draws.
 */
export const SHADER_BUILD_BUDGET_MS = 8;

interface Internals {
  _objects: { get(...args: unknown[]): unknown };
  _nodes: {
    get(renderObject: unknown): { nodeBuilderState?: unknown };
    getForRender(renderObject: unknown, useAsync?: boolean): unknown;
    getForRenderCacheKey(renderObject: unknown): unknown;
    nodeBuilderCache: Map<unknown, unknown>;
  };
  _pipelines: { isReady(renderObject: unknown): boolean };
  _currentRenderContext: unknown;
  _renderObjectDirect(...args: unknown[]): void;
}

/**
 * A mesh given a new material keeps drawing with the one it last drew with until the new pipeline is ready. A first draw
 * may arrive a few frames late, but something already on screen must never go blank: a creature's tell gives its body a
 * private material, and the body vanished through the wind-up (~40 frames) while that compiled.
 */
export function spreadShaderBuilds(renderer: Partial<Internals>, gate: PipelineGate): void {
  const { _nodes: nodes, _objects: objects, _renderObjectDirect: draw } = renderer;
  if (!nodes || !objects || !draw) return;
  const getForRender = nodes.getForRender;
  nodes.getForRender = function (this: Internals["_nodes"], renderObject, useAsync) {
    if (useAsync || this.get(renderObject).nodeBuilderState !== undefined) return getForRender.call(this, renderObject, useAsync);
    const started = performance.now();
    const state = getForRender.call(this, renderObject, useAsync);
    gate.buildMs += performance.now() - started;
    return state;
  };
  const lastDrawnWith = new WeakMap<object, unknown>();
  renderer._renderObjectDirect = function (this: Internals, ...args: unknown[]) {
    const [object, material, scene, camera, lightsNode, , clippingContext, passId] = args;
    const mesh = object as { isQuadMesh?: boolean; material?: unknown };
    const renderObject = () => this._objects.get(object, material, scene, camera, lightsNode, this._currentRenderContext, clippingContext, passId);
    const standIn = () => {
      const previous = lastDrawnWith.get(mesh);
      if (previous !== undefined) draw.apply(this, [object, previous, ...args.slice(2)]);
    };
    // only the mesh's own material: a shadow pass passes an override, and an array of them has no one previous material
    const own = gate.active && asyncPipelines.enabled && mesh.material === material;
    if (gate.active && gate.buildMs >= gate.budgetMs && asyncPipelines.enabled && !mesh.isQuadMesh) {
      const held = renderObject();
      if (this._nodes.get(held).nodeBuilderState === undefined && !this._nodes.nodeBuilderCache.has(this._nodes.getForRenderCacheKey(held))) {
        if (own) standIn();
        return;
      }
    }
    draw.apply(this, args);
    if (!own || lastDrawnWith.get(mesh) === material) return;
    if (this._pipelines.isReady(renderObject())) lastDrawnWith.set(mesh, material);
    else standIn();
  };
}

interface RenderObjectLike {
  object?: { isQuadMesh?: boolean };
}

interface PipelineUtils {
  createRenderPipeline(renderObject: never, promises: Promise<void>[] | null): void;
}

export function deferDrawPipelines(backend: { pipelineUtils?: PipelineUtils }): PipelineGate {
  const gate: PipelineGate = { active: false, pending: 0, buildMs: 0, budgetMs: Infinity };
  const utils = backend.pipelineUtils;
  if (!utils) return gate;
  const create = utils.createRenderPipeline.bind(utils);
  utils.createRenderPipeline = (renderObject, promises) => {
    const fullscreen = (renderObject as RenderObjectLike).object?.isQuadMesh === true;
    if (promises !== null || !gate.active || !asyncPipelines.enabled || fullscreen) return create(renderObject, promises);
    const started: Promise<void>[] = [];
    create(renderObject, started);
    for (const compiling of started) {
      gate.pending++;
      void compiling.finally(() => gate.pending--);
    }
  };
  return gate;
}
