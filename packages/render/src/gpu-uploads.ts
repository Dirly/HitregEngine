/** Queue-level measurements: count actual writes, including each partial range. */
export interface UploadBucket { calls: number; bytes: number }
export interface UploadSnapshot {
  frames: number;
  callsPerFrame: number;
  bytesPerFrame: number;
  maxCalls: number;
  sources: Record<string, UploadBucket>;
}

interface QueueLike {
  writeBuffer(buffer: unknown, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset?: number, size?: number): void;
}
interface UploadSource {
  name?: string;
  isInterleavedBufferAttribute?: boolean;
  data?: UploadSource;
  isInstancedInterleavedBuffer?: boolean;
  isInstancedBufferAttribute?: boolean;
}
interface UploadBackend {
  isWebGPUBackend?: boolean;
  device?: { queue: QueueLike };
  updateAttribute?: (attribute: UploadSource) => void;
  updateBinding?: (binding: UploadSource) => void;
}

export class GpuUploadProbe {
  private source = "other";
  private buckets: Record<string, UploadBucket> = {};
  private frames = 0;
  private calls = 0;
  private bytes = 0;
  private frameCalls = 0;
  private frameBytes = 0;
  private maxCalls = 0;
  private bucketCount = 0;
  readonly lastFrame = { calls: 0, bytes: 0 };

  constructor(backend: UploadBackend) {
    const queue = backend.device?.queue;
    if (!backend.isWebGPUBackend || !queue) return;
    const write = queue.writeBuffer.bind(queue);
    queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size) => {
      // WebGPU interprets typed-array offsets/sizes in elements, DataView and
      // ArrayBuffer in bytes. Observe only; preserve the original arguments.
      const stride = (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
      const bytes = size === undefined ? data.byteLength - dataOffset * stride : size * stride;
      write(buffer, offset, data, dataOffset, size);
      const key = this.buckets[this.source] || this.bucketCount < 128 ? this.source : "other";
      if (!this.buckets[key]) { this.buckets[key] = { calls: 0, bytes: 0 }; this.bucketCount++; }
      const bucket = this.buckets[key]!;
      bucket.calls++;
      bucket.bytes += bytes;
      this.calls++;
      this.frameCalls++;
      this.frameBytes += bytes;
      this.bytes += bytes;
    };
    for (const method of ["updateAttribute", "updateBinding"] as const) {
      const original = backend[method];
      if (!original) continue;
      backend[method] = (input) => {
        const previous = this.source;
        const source = input.isInterleavedBufferAttribute ? input.data ?? input : input;
        const kind = method === "updateBinding" ? "uniform" :
          source.isInstancedInterleavedBuffer || source.isInstancedBufferAttribute ? "instance" : "attribute";
        this.source = `${kind}:${source.name || "unnamed"}`;
        try { original.call(backend, input); } finally { this.source = previous; }
      };
    }
  }

  endFrame(): void {
    this.frames++;
    this.maxCalls = Math.max(this.maxCalls, this.frameCalls);
    this.lastFrame.calls = this.frameCalls;
    this.lastFrame.bytes = this.frameBytes;
    this.frameCalls = 0;
    this.frameBytes = 0;
  }

  snapshot(): UploadSnapshot {
    const frames = Math.max(1, this.frames);
    return {
      frames: this.frames, callsPerFrame: this.calls / frames,
      bytesPerFrame: this.bytes / frames, maxCalls: this.maxCalls,
      sources: Object.fromEntries(Object.entries(this.buckets).map(([name, b]) =>
        [name, { calls: b.calls / frames, bytes: b.bytes / frames }])),
    };
  }

  reset(): void {
    this.frames = this.calls = this.bytes = this.frameCalls = this.frameBytes = this.maxCalls = this.bucketCount = 0;
    this.lastFrame.calls = this.lastFrame.bytes = 0;
    this.buckets = {};
  }
}
