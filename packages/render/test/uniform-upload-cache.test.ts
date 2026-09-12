import { describe, expect, it, vi } from "vitest";
import { cacheUniformUploads } from "../src/uniform-upload-cache.js";

function fixture() {
  let gpu = { usage: 64 };
  const upload = vi.fn();
  const backend = { isWebGPUBackend: true, get: () => ({ buffer: gpu }), updateBinding: upload };
  const stats = cacheUniformUploads(backend);
  const binding = { isNodeUniformBuffer: true, buffer: new Float32Array([1, 2]), updateRanges: [] as { start: number; count: number }[] };
  return { backend, binding, upload, stats, replace: () => { gpu = { usage: 64 }; }, gpu: () => gpu };
}

describe("uniform upload reuse", () => {
  it("coalesces scattered uniform changes without losing range bookkeeping", () => {
    const ranges = [{ start: 12, count: 4 }, { start: 0, count: 2 }, { start: 7, count: 1 }];
    // Match Three's getter-only API, not a writable plain-object property.
    const binding = { isUniformsGroup: true, buffer: new Float32Array(16), get updateRanges() { return ranges; } };
    const upload = vi.fn((b: typeof binding) => {
      expect(b.updateRanges).toEqual([{ start: 0, count: 16 }]);
    });
    const backend = { isWebGPUBackend: true, get: () => ({ buffer: { usage: 64 } }), updateBinding: upload };
    cacheUniformUploads(backend);
    backend.updateBinding(binding);
    expect(binding.updateRanges).toBe(ranges);
    expect(ranges).toEqual([{ start: 12, count: 4 }, { start: 0, count: 2 }, { start: 7, count: 1 }]);
    upload.mockImplementationOnce(() => { throw new Error("write failed"); });
    expect(() => backend.updateBinding(binding)).toThrow("write failed");
    expect(binding.updateRanges).toBe(ranges);
  });
  it("uploads one pose across repeated passes, then uploads a changed pose", () => {
    const f = fixture();
    for (let pass = 0; pass < 7; pass++) f.backend.updateBinding(f.binding);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.stats.skipped).toBe(6);
    f.binding.buffer[1] = 3;
    f.backend.updateBinding(f.binding);
    expect(f.upload).toHaveBeenCalledTimes(2);
    f.binding.buffer[1] = 2;
    f.backend.updateBinding(f.binding);
    expect(f.upload).toHaveBeenCalledTimes(3);
  });

  it("does not reuse a pose after buffer recreation or a partial write", () => {
    const f = fixture();
    f.backend.updateBinding(f.binding);
    f.replace();
    f.backend.updateBinding(f.binding);
    f.binding.updateRanges.push({ start: 0, count: 1 });
    f.backend.updateBinding(f.binding);
    f.binding.updateRanges.length = 0;
    f.backend.updateBinding(f.binding);
    expect(f.upload).toHaveBeenCalledTimes(4);
  });

  it("respects view offsets and compares exact bits including signed zero", () => {
    const f = fixture();
    f.binding.buffer = new Float32Array([99, 0, 2]).subarray(1);
    f.backend.updateBinding(f.binding);
    f.binding.buffer[0] = -0;
    f.backend.updateBinding(f.binding);
    expect(f.upload).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed writes or GPU-writable buffers", () => {
    const f = fixture();
    f.upload.mockImplementationOnce(() => { throw new Error("upload"); });
    expect(() => f.backend.updateBinding(f.binding)).toThrow("upload");
    f.backend.updateBinding(f.binding);
    expect(f.stats.skipped).toBe(0);
    f.gpu().usage |= 128;
    f.backend.updateBinding(f.binding);
    f.backend.updateBinding(f.binding);
    expect(f.upload).toHaveBeenCalledTimes(4);
  });
});
