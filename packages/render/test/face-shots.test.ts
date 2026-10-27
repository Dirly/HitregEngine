import { afterEach, expect, it, vi } from "vitest";
import { toDataUrl } from "../src/face-shots.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(fail = false) {
  let written: Uint8ClampedArray | undefined;
  let encode: ((blob: Blob | null) => void) | undefined;
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: { data: Uint8ClampedArray }) => { written = image.data; },
  };
  const getContext = vi.fn(() => context);
  const canvas = { width: 0, height: 0, getContext,
    toDataURL: () => { throw new Error("synchronous PNG encoding blocks world entry"); },
    toBlob: (callback: (blob: Blob | null) => void) => { encode = callback; },
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  vi.stubGlobal("FileReader", class {
    result = "data:image/png;base64,portrait";
    onload?: () => void;
    onerror?: () => void;
    readAsDataURL() { queueMicrotask(() => fail ? this.onerror?.() : this.onload?.()); }
  });
  return { getContext, written: () => written, finish: (blob: Blob | null) => encode!(blob) };
}

it("encodes portraits asynchronously on a CPU canvas, preserving row order, colour and alpha", async () => {
  const f = fixture();
  let done = false;
  const result = toDataUrl(new Uint8Array([
    128, 0, 0, 128, 0, 255, 0, 255,
    0, 0, 255, 255, 100, 100, 100, 0,
  ]), 2, true).then((value) => { done = true; return value; });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(f.getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
  expect(Array.from(f.written()!)).toEqual([
    0, 0, 255, 255, 0, 0, 0, 0,
    255, 0, 0, 128, 0, 255, 0, 255,
  ]);
  f.finish(new Blob());
  await expect(result).resolves.toBe("data:image/png;base64,portrait");
});

it("returns no portrait if the browser cannot encode or read it", async () => {
  const f = fixture();
  const result = toDataUrl(new Uint8Array(4), 1, false);
  f.finish(null);
  await expect(result).resolves.toBeNull();
  const failedReader = fixture(true);
  const read = toDataUrl(new Uint8Array(4), 1, false);
  failedReader.finish(new Blob());
  await expect(read).resolves.toBeNull();
});
