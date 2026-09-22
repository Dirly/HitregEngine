import { describe, expect, it } from "vitest";
import { passPlan, pipelineSignature, resolvePostFx, POST_PASS_ORDER } from "../src/post.js";

/**
 * The underwater pass is the one effect whose STRENGTH changes every frame (a
 * camera bobbing at the waterline) while its graph must not. These are the
 * rules that keep it that way — a rebuild mid-dive recreates the scene pass,
 * and every material in the scene recompiles behind it.
 */
describe("underwater pass planning", () => {
  it("is built for a scene with water and costs nothing without one", () => {
    const fx = resolvePostFx(null);
    expect(fx.underwater.enabled).toBe(true); // on by default...
    expect(passPlan(fx, {})).not.toContain("underwater"); // ...but only where there is water
    expect(passPlan(fx, { water: false })).not.toContain("underwater");
    expect(passPlan(fx, { water: true })).toContain("underwater");
  });

  it("can be turned off outright by the scene", () => {
    const fx = resolvePostFx({ underwater: { enabled: false } });
    expect(passPlan(fx, { water: true })).not.toContain("underwater");
  });

  it("absorbs the lit scene, before the tone curve", () => {
    // What the water did to the light on its way to the lens, not something
    // the lens did — so it runs on linear scene values, and bloom then blooms
    // whatever is left of a submerged lantern.
    expect(POST_PASS_ORDER.indexOf("underwater")).toBeGreaterThan(POST_PASS_ORDER.indexOf("ao"));
    expect(POST_PASS_ORDER.indexOf("underwater")).toBeLessThan(POST_PASS_ORDER.indexOf("bloom"));
    expect(POST_PASS_ORDER.indexOf("underwater")).toBeLessThan(POST_PASS_ORDER.indexOf("tonemap"));
  });

  it("keeps one signature across every depth, and only the sway is structural", () => {
    const fx = resolvePostFx({ underwater: { wobble: 0.004 } });
    const ctx = { water: true };
    // nothing here says how deep the camera is: submersion is a uniform
    expect(pipelineSignature(fx, ctx)).toBe(pipelineSignature(resolvePostFx({ underwater: { wobble: 0.004 } }), ctx));
    // the sway needs an extra copy of the frame, so wanting it IS structure
    const still = resolvePostFx({ underwater: { wobble: 0 } });
    expect(pipelineSignature(still, ctx)).not.toBe(pipelineSignature(fx, ctx));
    // ...while a murkier or differently coloured water is a uniform write
    const murky = resolvePostFx({ underwater: { wobble: 0.004, density: 0.3, color: "#204030" } });
    expect(pipelineSignature(murky, ctx)).toBe(pipelineSignature(fx, ctx));
  });

  it("retires like any other pass when a backend refuses it", () => {
    const fx = resolvePostFx(null);
    const plan = passPlan(fx, { water: true, disabled: new Set(["underwater" as const]) });
    expect(plan).not.toContain("underwater");
  });
});
