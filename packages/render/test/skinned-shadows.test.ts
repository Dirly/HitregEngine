import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { beginSkinnedShadowFrame, endSkinnedShadowFrame, enableSkinnedShadowRange } from "../src/skinned-shadows.js";

const meshAt = (x: number, cast = true): THREE.Mesh => {
  const m = new THREE.Mesh();
  m.castShadow = cast;
  m.position.set(x, 0, 0);
  m.updateMatrixWorld(true);
  enableSkinnedShadowRange(m);
  return m;
};
const origin = new THREE.Vector3();

describe("skinned shadow range", () => {
  it("casts within the distance and not beyond it, only inside a render frame", () => {
    const near = meshAt(10), far = meshAt(60);
    expect(far.castShadow).toBe(true); // outside a frame: authored
    const prev = beginSkinnedShadowFrame(origin, 40);
    expect(near.castShadow).toBe(true);
    expect(far.castShadow).toBe(false);
    endSkinnedShadowFrame(prev);
    expect(far.castShadow).toBe(true);
  });

  it("never turns on a shadow the author turned off, and writes set the authored value", () => {
    const m = meshAt(5, false);
    let prev = beginSkinnedShadowFrame(origin, 40);
    expect(m.castShadow).toBe(false);
    endSkinnedShadowFrame(prev);
    m.castShadow = true;
    prev = beginSkinnedShadowFrame(origin, 40);
    expect(m.castShadow).toBe(true);
    endSkinnedShadowFrame(prev);
    expect(new THREE.Mesh().copy(m).castShadow).toBe(true);
  });

  it("holds its state inside the hysteresis band so the boundary does not flicker", () => {
    const m = meshAt(41); // just past 40 while casting: kept
    let prev = beginSkinnedShadowFrame(origin, 40);
    expect(m.castShadow).toBe(true);
    endSkinnedShadowFrame(prev);
    m.position.x = 43; m.updateMatrixWorld(true); // past the band: off
    prev = beginSkinnedShadowFrame(origin, 40);
    expect(m.castShadow).toBe(false);
    endSkinnedShadowFrame(prev);
    m.position.x = 41; m.updateMatrixWorld(true); // back inside the band but beyond 40: stays off
    prev = beginSkinnedShadowFrame(origin, 40);
    expect(m.castShadow).toBe(false);
    endSkinnedShadowFrame(prev);
    m.position.x = 39; m.updateMatrixWorld(true);
    prev = beginSkinnedShadowFrame(origin, 40);
    expect(m.castShadow).toBe(true);
    endSkinnedShadowFrame(prev);
  });

  it("is one decision per frame, and 0 / Infinity disable the limit", () => {
    const m = meshAt(60);
    let prev = beginSkinnedShadowFrame(origin, 0);
    expect(m.castShadow).toBe(true);
    endSkinnedShadowFrame(prev);
    prev = beginSkinnedShadowFrame(origin, Infinity);
    expect(m.castShadow).toBe(true);
    endSkinnedShadowFrame(prev);
    prev = beginSkinnedShadowFrame(origin, 40);
    expect(m.castShadow).toBe(false);
    m.position.x = 1; m.updateMatrixWorld(true); // moved mid-frame: the frame's decision stands
    expect(m.castShadow).toBe(false);
    endSkinnedShadowFrame(prev);
  });
});
