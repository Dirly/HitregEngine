import { describe, expect, it } from "vitest";
import { guardUninitializedBindingDisposal } from "../src/binding-lifetime.js";
// @ts-ignore Three's private binding manager has no declaration file.
import Bindings from "three/src/renderers/common/Bindings.js";

describe("render binding ownership", () => {
  it("protects a real Three shared bind group from disposal of an object that never acquired it", () => {
    const run = (guarded: boolean) => {
      let buffers = 0;
      const backend = { createUniformBuffer() { buffers++; }, destroyUniformBuffer() { buffers--; }, createBindings() {}, deleteBindGroupData() {} };
      const info = { createUniformBuffer() {}, destroyUniformBuffer() {} };
      const manager = new Bindings(backend, {}, {}, {}, {}, info);
      if (guarded) guardUninitializedBindingDisposal(manager);
      const groups = [{ bindings: [{ isUniformBuffer: true, release() {} }] }];
      const live = { getBindings: () => groups }, queued = { getBindings: () => groups };
      manager.getForRender(live);
      expect(buffers).toBe(1);
      manager.deleteForRender(queued);
      return { buffers, manager, live };
    };
    expect(run(false).buffers).toBe(0); // upstream releases another object's GPU resource
    const protectedRun = run(true);
    expect(protectedRun.buffers).toBe(1);
    expect(() => protectedRun.manager.deleteForRender(protectedRun.live)).not.toThrow();
  });

  it("does not release a live object's shared GPU buffer when an uninitialized queued object is disposed", () => {
    const live = {}, queued = {};
    const data = new Map<unknown, { initialized?: boolean }>([[live, { initialized: true }], [queued, {}]]);
    let references = 1, bufferAlive = true, released = 0;
    const manager = {
      get: (object: unknown) => data.get(object) ?? {},
      delete: (object: unknown) => data.delete(object),
      deleteForRender(object: unknown) {
        released++;
        if (--references === 0) bufferAlive = false;
        data.delete(object);
      },
    };
    guardUninitializedBindingDisposal(manager);
    manager.deleteForRender(queued);
    expect(data.has(queued)).toBe(false);
    expect(released).toBe(0);
    expect(references).toBe(1);
    expect(bufferAlive).toBe(true);
    manager.deleteForRender(live);
    expect(released).toBe(1);
    expect(references).toBe(0);
    expect(bufferAlive).toBe(false);
  });

  it("ignores duplicate disposal and tolerates unavailable renderer internals", () => {
    const object = {}, data = new Map<unknown, { initialized?: boolean }>([[object, { initialized: true }]]);
    let released = 0;
    const manager = {
      get: (key: unknown) => data.get(key) ?? {},
      delete: (key: unknown) => data.delete(key),
      deleteForRender(key: unknown) { released++; data.delete(key); },
    };
    guardUninitializedBindingDisposal(manager);
    manager.deleteForRender(object); manager.deleteForRender(object);
    expect(released).toBe(1);
    expect(() => guardUninitializedBindingDisposal(undefined)).not.toThrow();
    expect(() => guardUninitializedBindingDisposal({})).not.toThrow();
  });
});
