import { describe, expect, it } from "vitest";
import { pixelateRatio, resolvePostFx } from "../src/post.js";

/**
 * `postfx.pixelate` is the fake-PSX look: render at a fixed line count and let
 * the canvas scale it up. It is a backing-store size, not a pass, so the two
 * things worth pinning are the ratio maths and that it never enters the
 * pipeline plan.
 */
describe("postfx.pixelate", () => {
  it("resolves to off by default with PSX-ish defaults", () => {
    const fx = resolvePostFx(null);
    expect(fx.pixelate).toEqual({ enabled: false, height: 240, filter: "nearest" });
    expect(pixelateRatio(fx, 720, 1)).toBe(1);
  });

  it("scales the ratio so the frame is `height` lines tall", () => {
    const fx = resolvePostFx({ pixelate: { enabled: true, height: 240 } });
    expect(pixelateRatio(fx, 720, 1)).toBeCloseTo(1 / 3, 6);
    expect(pixelateRatio(fx, 1080, 2)).toBeCloseTo(240 / 1080, 6);
  });

  it("never upscales past the host's own ratio, and survives a degenerate viewport", () => {
    const fx = resolvePostFx({ pixelate: { enabled: true, height: 240 } });
    expect(pixelateRatio(fx, 200, 1)).toBe(1);
    expect(pixelateRatio(fx, 0, 1)).toBe(1);
    const tiny = resolvePostFx({ pixelate: { enabled: true, height: 1 } });
    expect(pixelateRatio(tiny, 720, 1)).toBeCloseTo(8 / 720, 6);
  });

  it("only knows the two filters", () => {
    expect(resolvePostFx({ pixelate: { filter: "linear" } }).pixelate.filter).toBe("linear");
    expect(resolvePostFx({ pixelate: { filter: "bogus" as never } }).pixelate.filter).toBe("nearest");
  });
});
