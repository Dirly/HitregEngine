import { describe, expect, it } from "vitest";
import { composeModelLook } from "../src/index.js";

describe("composeModelLook", () => {
  const body = "mmo/human-body.glb";
  it("merges every worn item on one model into sheet groups; later items win a shared part", () => {
    const look = composeModelLook(
      [
        { model: body, parts: ["ChestFront", "ChestBack", "ArmOutside"], texture: "vanguard.png" },
        { model: body, parts: ["LegsFront", "Belt"], texture: "ranger.png" },
        { model: "mmo/human-helm.glb", parts: ["Hood"], texture: "ranger-helm.png" },
        null,
        { model: body, parts: ["ArmOutside", "HandFront"], texture: "magus.png" },
      ],
      body,
    );
    expect(look).toEqual({
      parts: ["ChestFront", "ChestBack", "LegsFront", "Belt", "ArmOutside", "HandFront"],
      groups: [
        { parts: ["ChestFront", "ChestBack"], texture: "vanguard.png" },
        { parts: ["LegsFront", "Belt"], texture: "ranger.png" },
        { parts: ["ArmOutside", "HandFront"], texture: "magus.png" },
      ],
    });
  });

  it("is null when nothing is worn on the model, and keeps an untextured piece on the default tile", () => {
    expect(composeModelLook([{ model: "x", parts: ["A"] }], body)).toBeNull();
    expect(composeModelLook([{ model: body, parts: ["A"] }], body)).toEqual({ parts: ["A"], groups: [{ parts: ["A"], texture: null }] });
  });
});
