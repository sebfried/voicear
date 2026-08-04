import assert from "node:assert/strict";
import { blobToDataUrl, clampCameraOpacity, fitFrameSize } from "./camera.ts";

assert.equal(clampCameraOpacity(-1), 0);
assert.equal(clampCameraOpacity(42.5), 42.5);
assert.equal(clampCameraOpacity(101), 100);
assert.equal(clampCameraOpacity(Number.NaN), 100);

assert.deepEqual(fitFrameSize(4_032, 3_024, 1_280), { width: 1_280, height: 960 });
assert.deepEqual(fitFrameSize(3_024, 4_032, 1_280), { width: 960, height: 1_280 });
assert.deepEqual(fitFrameSize(640, 480, 1_280), { width: 640, height: 480 });
assert.deepEqual(fitFrameSize(100, 1, 1), { width: 1, height: 1 });
assert.throws(() => fitFrameSize(0, 480, 1_280), RangeError);
assert.throws(() => fitFrameSize(640, 480, Number.NaN), RangeError);

const bytes = new Blob([Uint8Array.of(0, 1, 254, 255)], { type: "application/octet-stream" });
assert.equal(await blobToDataUrl(bytes), "data:application/octet-stream;base64,AAH+/w==");
assert.equal(await blobToDataUrl(new Blob([])), "data:application/octet-stream;base64,");

console.log("camera checks passed");
