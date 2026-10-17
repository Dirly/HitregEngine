import { describe, expect, it } from "vitest";
import { fallSiteSchema } from "../src/voxel/fall-sites";

describe("fall site formations.clear (keep-clear discs)", () => {
  it("accepts keep-clear discs and rejects a bad radius", () => {
    const base = { id: "s", at: [0, 0], template: "cascade", tiers: [{ share: 1, pool: 16 }] };
    const ok = fallSiteSchema.parse({ ...base, formations: { clear: [{ at: [-2437, -1060], radius: 19 }] } });
    expect(ok.formations?.clear?.[0]?.radius).toBe(19);
    expect(() => fallSiteSchema.parse({ ...base, formations: { clear: [{ at: [0, 0], radius: 0 }] } })).toThrow();
  });
});
