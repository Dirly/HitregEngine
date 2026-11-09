import { test } from "node:test";
import assert from "node:assert/strict";
import { isGrey } from "../tools/town-grey.mts";
import { regrade } from "../tools/prop-regrade.mts";

test("town-grey calls colourless mid-value and cold blue-grey stone grey, red rubble / lime render / dark wood / glass not", () => {
    assert.equal(isGrey(120, 120, 122), true); // kit grey
    assert.equal(isGrey(92, 100, 118), true); // blue-grey course (the tree ring)
    assert.equal(isGrey(107, 65, 42), false); // Redstrand Stone tile mean
    assert.equal(isGrey(225, 203, 173), false); // lime render
    assert.equal(isGrey(66, 54, 46), false); // wood grain
    assert.equal(isGrey(109, 129, 119), false); // window glass (green leading)
    assert.equal(isGrey(20, 20, 22), false); // black iron / shadow
  });
test("prop-regrade keeps each grey texel's luminance in the palette's hue and leaves tinted texels alone", () => {
    const src = { width: 2, height: 1, data: new Uint8Array([120, 120, 120, 255, 107, 65, 42, 255]) };
    const pal = { width: 1, height: 1, data: new Uint8Array([140, 70, 40, 255]) };
    const { data, changed } = regrade(src, pal);
    assert.equal(changed, 1);
    const l = (i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    assert.ok(Math.abs(l(0) - 120) < 2);
    assert.equal(data[0]! > data[2]!, true); // now warm
    assert.deepEqual([...data.slice(4, 8)], [107, 65, 42, 255]);
  });
