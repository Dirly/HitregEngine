import { describe, expect, it, vi } from "vitest";
import { NetStateStore, cooldownKey, registerCooldownNetState } from "../src/index.js";

describe("cooldown netState", () => {
  it("validates cooldown/<body>.<ability> as a non-negative sim time, without the no-schema warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new NetStateStore();
    store.setAuthority(true);
    registerCooldownNetState(store);
    expect(store.set(cooldownKey("body-1", "strike"), 12.5)).toBe(true);
    expect(store.get("cooldown/body-1.strike")).toBe(12.5);
    expect(store.set(cooldownKey("body-1", "strike"), 0)).toBe(true);
    expect(store.set(cooldownKey("body-1", "strike"), -1)).toBe(false);
    expect(store.set(cooldownKey("body-1", "strike"), "soon")).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('"cooldown" has no schema'))).toBe(false);
    warn.mockRestore();
  });
});
