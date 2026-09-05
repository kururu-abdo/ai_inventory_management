import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { LocalInvoiceImageOptimizer } from "../src/index.js";

test("grayscales and constrains a local invoice image", async () => {
  const source = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "red" } })
    .png().toBuffer();
  const output = await new LocalInvoiceImageOptimizer().optimize(source);
  assert.match(output.dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(output.width, 1200);
  assert.equal(output.height, 800);
  const decoded = await sharp(Buffer.from(output.dataUrl.split(",")[1]!, "base64"))
    .raw().toBuffer({ resolveWithObject: true });
  // JPEG may report sRGB metadata while still containing grayscale pixels.
  assert.equal(decoded.data[0], decoded.data[1]);
  assert.equal(decoded.data[1], decoded.data[2]);
});
