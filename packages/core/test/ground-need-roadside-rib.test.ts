import { describe, expect, it } from "vitest";
import { groundNeedSchema } from "../src/index.js";

// 2026-10-29 redstrand w9: the live recipe carries a roadside-rib need (dropped-hour's outcrop); every tool parses the
// recipe with worldRecipeSchema, so the kind must stay in the enum.
describe("ground needs: roadside-rib", () => {
  it("parses a solved roadside-rib need as the redstrand recipe writes it", () => {
    const need = groundNeedSchema.parse({
      id: "dropped-hour-rib", kind: "roadside-rib", for: "dropped-hour", near: [992, -285], within: 60, minHeight: 12, width: 40, apron: 7,
      solved: { at: [992, -287], faces: 180, height: 12, patch: "need-dropped-hour-rib", raised: 11.8, ran: "2026-10-30T01:03:39.867Z" },
    });
    expect(need.kind).toBe("roadside-rib");
    expect(groundNeedSchema.safeParse({ id: "x", kind: "no-such-kind", near: [0, 0] }).success).toBe(false);
  });
});
