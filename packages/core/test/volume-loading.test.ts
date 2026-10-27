import { afterEach, expect, it } from "vitest";
import { clearVolumes, getVolume, isVolumeInUse, registerVolumeDoc, registerVolumeLoader, volumeIds } from "../src/index.js";

afterEach(clearVolumes);
const doc = { nodes: [{ op: "add", shape: "box", size: [8, 8, 8] }] };

it("keeps volumes discoverable without decoding them until needed, and decodes once", () => {
  let reads = 0;
  registerVolumeLoader("room", () => { reads++; return doc; });
  expect(volumeIds()).toContain("room");
  expect(isVolumeInUse("room")).toBe(false);
  expect(reads).toBe(0);
  const volume = getVolume("room");
  expect(volume?.density(0, 0, 0)).toBeLessThan(0);
  expect(getVolume("room")).toBe(volume);
  expect(reads).toBe(1);
  registerVolumeDoc("room", { nodes: [] });
  expect(getVolume("room")).not.toBe(volume);
});

it("retries failed lazy data only after a replacement is registered", () => {
  let reads = 0;
  registerVolumeLoader("room", () => { reads++; throw new Error("unreadable"); });
  expect(getVolume("room")).toBeNull();
  expect(getVolume("room")).toBeNull();
  expect(reads).toBe(1);
  registerVolumeLoader("room", () => doc);
  expect(getVolume("room")).not.toBeNull();
});
