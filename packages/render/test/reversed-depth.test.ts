import { describe, expect, it } from "vitest";
import { flipDepthBiasForReversedDepth, keepRenderOrderUnderReversedDepth } from "../src/depth.js";

type Item = { groupOrder: number; renderOrder: number; z: number; id: number };
type Sort = (a: Item, b: Item) => number;

/** What three 0.185's RenderList.sort does with a reversed-depth camera: sort, then reverse the whole list. */
function threeSort(list: Item[], sort: Sort): Item[] {
  return list.slice().sort(sort).reverse();
}

function install(): { opaque: Sort; transparent: Sort } {
  const got: { opaque?: Sort; transparent?: Sort } = {};
  keepRenderOrderUnderReversedDepth({
    setOpaqueSort: (s) => (got.opaque = s as Sort),
    setTransparentSort: (s) => (got.transparent = s as Sort),
  });
  return got as { opaque: Sort; transparent: Sort };
}

describe("reversed depth render order", () => {
  // reversed z: larger is nearer
  const dome = { groupOrder: 0, renderOrder: -1000, z: 0.00001, id: 1 };
  const near = { groupOrder: 0, renderOrder: 0, z: 0.5, id: 2 };
  const far = { groupOrder: 0, renderOrder: 0, z: 0.01, id: 3 };
  const overlay = { groupOrder: 0, renderOrder: 4, z: 0.9, id: 4 };

  it("keeps renderOrder ascending and draws opaque front to back", () => {
    const { opaque } = install();
    expect(threeSort([overlay, far, dome, near], opaque).map((i) => i.id)).toEqual([1, 2, 3, 4]);
  });

  it("keeps renderOrder ascending and draws transparent back to front", () => {
    const { transparent } = install();
    expect(threeSort([overlay, near, dome, far], transparent).map((i) => i.id)).toEqual([1, 3, 2, 4]);
  });
});

describe("reversed depth polygon offset", () => {
  it("flips a material's offset only while its pipeline is described", () => {
    const seen: number[] = [];
    const utils = {
      createRenderPipeline(ro: { material: { polygonOffsetFactor: number; polygonOffsetUnits: number } }) {
        seen.push(ro.material.polygonOffsetFactor, ro.material.polygonOffsetUnits);
      },
    };
    flipDepthBiasForReversedDepth({ pipelineUtils: utils as never });
    const material = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -2 };
    utils.createRenderPipeline({ material });
    expect(seen).toEqual([4, 2]);
    expect(material.polygonOffsetFactor).toBe(-4);
    expect(material.polygonOffsetUnits).toBe(-2);
  });
});
