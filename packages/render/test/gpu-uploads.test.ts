import { expect, it, vi } from "vitest";
import { GpuUploadProbe } from "../src/gpu-uploads.js";

it("counts actual partial writes in bytes without changing arguments", () => {
  const write = vi.fn();
  const queue = { writeBuffer: write };
  const data = new Float32Array(10);
  const backend = { isWebGPUBackend: true, device: { queue }, updateAttribute: (_input: unknown) => {
    queue.writeBuffer({}, 0, data, 2, 3);
    queue.writeBuffer({}, 12, new DataView(data.buffer), 4, 8);
  } };
  const probe = new GpuUploadProbe(backend);
  backend.updateAttribute({ name: "grass", isInstancedBufferAttribute: true });
  probe.endFrame();
  expect(probe.snapshot()).toMatchObject({ frames: 1, callsPerFrame: 2, bytesPerFrame: 20,
    sources: { "instance:grass": { calls: 2, bytes: 20 } } });
  expect(write.mock.calls[0]!.slice(1)).toEqual([0, data, 2, 3]);
  probe.reset();
  expect(probe.snapshot().callsPerFrame).toBe(0);
});
