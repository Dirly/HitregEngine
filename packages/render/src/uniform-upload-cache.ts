/**
 * Three r185 NodeUniformBuffer.update() requests uploads even when the array
 * is unchanged. Skeleton buffers can be visited once per submesh/shadow pass.
 * Cache the bytes last sent to each actual GPU buffer, not to a binding name.
 * Only CPU-owned uniform buffers qualify: GPU-writable storage must never be
 * compared against a stale CPU mirror.
 */
interface Binding {
  isNodeUniformBuffer?: boolean;
  isUniformsGroup?: boolean;
  buffer?: ArrayBufferView;
  updateRanges?: Array<{ start: number; count: number }>;
}
interface BufferLike { usage: number }
interface Backend {
  isWebGPUBackend?: boolean;
  get?: (binding: Binding) => { buffer?: BufferLike };
  updateBinding?: (binding: Binding) => void;
}

export function cacheUniformUploads(backend: Backend) {
  const stats = { checked: 0, skipped: 0, skippedBytes: 0, coalescedGroups: 0 };
  const original = backend.updateBinding;
  const get = backend.get;
  if (!backend.isWebGPUBackend || !original || !get) return stats;
  const cache = new WeakMap<BufferLike, Uint8Array>();
  const mergedRanges = new WeakMap<Binding, { merged: { start: number; count: number }; saved: Array<{ start: number; count: number }> }>();
  backend.updateBinding = (binding) => {
    const buffer = get.call(backend, binding).buffer;
    const data = binding.buffer;
    const ranges = binding.updateRanges;
    // Camera/light groups can change many small, separated uniforms. Three
    // emits a writeBuffer for each non-adjacent range; on Firefox every write
    // creates a staging allocation. Sending their enclosing span includes a
    // little unchanged padding but needs only one upload. Preserve the cached
    // range objects and the group's _addedIndices bookkeeping for its caller.
    if (binding.isUniformsGroup && data && data.byteLength <= 65536 && ranges && ranges.length > 1) {
      let start = Infinity, end = 0;
      for (const range of ranges) {
        start = Math.min(start, range.start);
        end = Math.max(end, range.start + range.count);
      }
      let merged = mergedRanges.get(binding);
      if (!merged) { merged = { merged: { start: 0, count: 0 }, saved: [] }; mergedRanges.set(binding, merged); }
      merged.merged.start = start;
      merged.merged.count = end - start;
      merged.saved.length = 0;
      for (const range of ranges) merged.saved.push(range);
      if (buffer) cache.delete(buffer);
      // Three exposes this array through a getter without a setter.
      ranges.length = 0;
      ranges.push(merged.merged);
      try {
        original.call(backend, binding);
        stats.coalescedGroups++;
      } finally {
        ranges.length = 0;
        for (const range of merged.saved) ranges.push(range);
        merged.saved.length = 0;
      }
      return;
    }
    // UNIFORM=64, STORAGE=128 in WebGPU. Bound per-buffer mirror size; large
    // uploads and unknown future binding shapes retain Three's original path.
    if (!buffer || !(buffer.usage & 64) || (buffer.usage & 128) ||
        !binding.isNodeUniformBuffer || !data || data.byteLength > 65536 ||
        (binding.updateRanges?.length ?? 0) > 0) {
      if (buffer) cache.delete(buffer);
      original.call(backend, binding);
      return;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const previous = cache.get(buffer);
    stats.checked++;
    if (previous && previous.length === bytes.length) {
      let same = true;
      for (let i = 0; i < bytes.length; i++) {
        if (previous[i] !== bytes[i]) { same = false; break; }
      }
      if (same) {
        stats.skipped++;
        stats.skippedBytes += bytes.length;
        return;
      }
    }
    original.call(backend, binding);
    // Commit only after a successful upload. Never retain the caller's mutable
    // view; it is reused and overwritten during the next animation update.
    if (previous?.length === bytes.length) previous.set(bytes);
    else cache.set(buffer, bytes.slice());
  };
  return stats;
}
