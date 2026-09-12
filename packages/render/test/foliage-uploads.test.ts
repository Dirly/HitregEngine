import { expect, it } from "vitest";
import * as THREE from "three/webgpu";
import Attributes from "three/src/renderers/common/Attributes.js";
import { impostorGeometry, impostorPageGeometry, impostorInstanceData, writeImpostorSlot } from "../src/impostor.js";

it("stationary tree impostors keep GPU buffers resident and LOD slot changes still upload", () => {
  const geometry = impostorGeometry(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 4, 1)), 4);
  const page = impostorPageGeometry(4);
  let writes = 0;
  const attrs = new Attributes({ createAttribute() {}, updateAttribute() { writes++; } }, { createAttribute() {} });
  const buffers = [geometry, page].flatMap((g) => Object.values(g.attributes));
  const draw = () => buffers.forEach((a) => attrs.update(a, 1));
  draw();
  for (let frame = 0; frame < 60; frame++) draw();
  expect(writes).toBe(0);
  const pose = new THREE.Matrix4().makeScale(2, 2, 2);
  writeImpostorSlot({ geometry }, impostorInstanceData([pose]), 0, 0);
  draw(); draw();
  expect(writes).toBe(2);
  expect(geometry.getAttribute("impostorScale").getX(0)).toBe(2);
  geometry.dispose(); page.dispose();
});
