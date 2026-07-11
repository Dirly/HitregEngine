import { describe, expect, it } from "vitest";
import {
  frameToUv,
  gridFrameRect,
  nearestFrameName,
  resolveSpriteFrame,
  resolveSpriteFrames,
  spritesheetSchema,
} from "../src/index.js";

const sheet = spritesheetSchema.parse({
  texture: "hud/icons.png",
  grid: { cols: 4, rows: 2, frameWidth: 32, frameHeight: 32, margin: 2, spacing: 2 },
  frames: {
    heart: { index: 0 },
    coin: { index: 5 },
    banner: { x: 0, y: 96, w: 128, h: 32 },
    ghost: { index: 99 }, // out of grid range — must stay unresolvable
  },
});

describe("spritesheet", () => {
  it("auto-splices the grid row-major with margin and spacing", () => {
    expect(gridFrameRect(sheet.grid!, 0)).toEqual({ x: 2, y: 2, w: 32, h: 32 });
    expect(gridFrameRect(sheet.grid!, 1)).toEqual({ x: 36, y: 2, w: 32, h: 32 });
    expect(gridFrameRect(sheet.grid!, 4)).toEqual({ x: 2, y: 36, w: 32, h: 32 }); // row 2
    expect(gridFrameRect(sheet.grid!, 8)).toBeNull();
  });

  it("resolves auto frames, named aliases, and explicit rects", () => {
    const frames = resolveSpriteFrames(sheet);
    expect(Object.keys(frames)).toHaveLength(8 + 3); // f0..f7 + heart/coin/banner
    expect(frames["heart"]).toEqual(frames["f0"]);
    expect(frames["coin"]).toEqual(frames["f5"]);
    expect(frames["banner"]).toEqual({ x: 0, y: 96, w: 128, h: 32 });
    expect(frames["ghost"]).toBeUndefined(); // out-of-range index = missing
  });

  it("missing frames resolve to null and suggest near names", () => {
    expect(resolveSpriteFrame(sheet, "heart")).not.toBeNull();
    expect(resolveSpriteFrame(sheet, "hart")).toBeNull();
    expect(nearestFrameName(sheet, "hart")).toBe("heart");
    expect(nearestFrameName(sheet, "completely-unrelated-name")).toBeNull();
  });

  it("computes Y-flipped UV windows", () => {
    // 128x64 sheet, frame at top-left 32x32: offset is its BOTTOM-left in UV space
    const uv = frameToUv({ x: 0, y: 0, w: 32, h: 32 }, 128, 64);
    expect(uv).toEqual({ offsetX: 0, offsetY: 0.5, repeatX: 0.25, repeatY: 0.5 });
  });

  it("schema rejects malformed sheets", () => {
    expect(spritesheetSchema.safeParse({}).success).toBe(false); // texture required
    expect(
      spritesheetSchema.safeParse({ texture: "t.png", frames: { bad: { x: -1, y: 0, w: 1, h: 1 } } })
        .success,
    ).toBe(false);
    // grid-less sheets with explicit rects are fine
    expect(
      spritesheetSchema.safeParse({ texture: "t.png", frames: { a: { x: 0, y: 0, w: 8, h: 8 } } })
        .success,
    ).toBe(true);
  });
});
