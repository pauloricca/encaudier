import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({TextEncoder, TextDecoder});
vm.runInContext(readFileSync(new URL('./visual-codec.js', import.meta.url), 'utf8'), context);
const C = context.VisualCodec;
const payload = Uint8Array.from({length: 1057}, (_, i) => (i * 127 + i % 19) & 255);
const readGrid = grid => { const density = Math.sqrt(grid.length); return C.readPacket((x, y) => grid[Math.floor(y) * density + Math.floor(x)], density); };
// Independent rasterizer: inverse-project each camera pixel into the displayed grid.
function camera(grid, corners = [[70, 35], [555, 55], [530, 540], [45, 510]], {noise = 0, blur = false, mirror = false} = {}) {
  const width = 640, height = 580, density = Math.sqrt(grid.length), edge = density + 3, extent = [[-3, -3], [edge, -3], [edge, edge], [-3, edge]];
  const inverse = C.homography(corners, extent), pixels = new Uint8ClampedArray(width * height * 4);
  let random = 12345;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [u, v] = inverse(mirror ? width - 1 - x : x, y);
    const within = u >= -3 && v >= -3 && u < edge && v < edge;
    const dark = u >= 0 && v >= 0 && u < density && v < density && grid[Math.floor(v) * density + Math.floor(u)];
    random = (1664525 * random + 1013904223) >>> 0;
    const level = (within ? dark ? 22 : 225 : 85) + (random / 0x100000000 - 0.5) * noise + y / height * 12;
    const i = (y * width + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = level; pixels[i + 3] = 255;
  }
  if (blur) {
    const original = pixels.slice();
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      let value = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) value += original[((y + dy) * width + x + dx) * 4];
      const i = (y * width + x) * 4; pixels[i] = pixels[i + 1] = pixels[i + 2] = value / 9;
    }
  }
  return {width, height, data: pixels};
}
test('reassembles out-of-order, duplicated frames, with missed frames on a later loop', () => {
  for (const bytes of [new Uint8Array(), payload]) {
    const sender = C.encode(bytes, '../résumé 🐈.bin', 42), receiver = new C.Receiver();
    for (let i = sender.count - 1; i > 0; i--) {
      assert.equal(receiver.accept(readGrid(sender.frame(i))).received, sender.count - i);
      assert.equal(receiver.accept(readGrid(sender.frame(i))).received, sender.count - i);
    }
    const result = receiver.accept(readGrid(sender.frame(0)));
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(bytes)); assert.equal(result.filename, 'résumé 🐈.bin');
  }
});
test('rejects damaged and torn frames without losing already received chunks', () => {
  const sender = C.encode(payload, 'data.bin', 123), receiver = new C.Receiver();
  receiver.accept(readGrid(sender.frame(0)));
  const corrupt = sender.frame(1); corrupt[20 * 48 + 20] ^= 1;
  assert.equal(readGrid(corrupt), null);
  const torn = sender.frame(1); torn.set(sender.frame(2).slice(24 * 48), 24 * 48);
  assert.equal(readGrid(torn), null);
  for (let i = sender.count - 1; i >= 1; i--) receiver.accept(readGrid(sender.frame(i)));
  assert.deepEqual(Buffer.from(receiver.accept(readGrid(sender.frame(0))).bytes), Buffer.from(payload));
});
const perspectives = [
  ['straight', [[60, 30], [570, 30], [570, 540], [60, 540]]],
  ['perspective', [[145, 65], [570, 125], [505, 535], [45, 480]]],
  ['rotation', [[320, 15], [605, 290], [320, 565], [35, 290]]],
  ['quarter turn', [[570, 30], [570, 540], [60, 540], [60, 30]]],
  ['upside down', [[570, 540], [60, 540], [60, 30], [570, 30]]],
  ['strong perspective', [[195, 85], [510, 150], [600, 530], [30, 495]]],
];
for (const [name, corners] of perspectives) for (const mirror of [false, true]) {
  test(`automatic calibration: ${name}${mirror ? ', mirrored' : ''}, noise and blur`, () => {
    const sender = C.encode(payload, 'camera.bin', 456), image = camera(sender.frame(2), corners, {noise: 22, blur: true, mirror});
    const found = C.decodeImage(image);
    assert.ok(found?.packet, 'Expected a CRC-verified packet after finding four corners');
    assert.equal(found.packet.index, 2); assert.equal(found.packet.session, 456);
    const next = C.decodeImage(camera(sender.frame(3), corners, {mirror}), found.corners);
    assert.ok(next?.packet); assert.equal(next.packet.index, 3);
  });
}
test('screen-to-camera end-to-end preserves filename and file checksum', () => {
  const sender = C.encode(payload, '光学-transfer.bin', 999), receiver = new C.Receiver(); let result, corners = null;
  for (let i = sender.count - 1; i >= 0; i--) {
    const found = C.decodeImage(camera(sender.frame(i), undefined, {noise: 16, blur: true}), corners);
    assert.ok(found?.packet); corners = found.corners; result = receiver.accept(found.packet);
  }
  assert.equal(result.filename, '光学-transfer.bin'); assert.deepEqual(Buffer.from(result.bytes), Buffer.from(payload));
});
test('no false lock on blank input, cropped markers, or random noise', () => {
  const sender = C.encode(payload, 'x.bin', 4);
  const cropped = camera(sender.frame(0)); cropped.data.fill(255, 0, cropped.width * 110 * 4);
  assert.equal(C.decodeImage(cropped)?.packet ?? null, null);
  for (const noise of [false, true]) {
    const image = {width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4)};
    for (let i = 0; i < image.data.length; i++) image.data[i] = noise ? (i * 71 + (i >>> 4)) & 255 : 128;
    assert.equal(C.decodeImage(image), null);
  }
});
test('different transfers cannot overwrite an incomplete file', () => {
  const receiver = new C.Receiver(), first = C.encode(payload, 'first.bin', 1), second = C.encode(payload, 'second.bin', 2);
  receiver.accept(readGrid(first.frame(0)));
  assert.ok(receiver.accept(readGrid(second.frame(1))).otherTransfer);
  let result;
  for (let i = 1; i < first.count; i++) result = receiver.accept(readGrid(first.frame(i)));
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(payload));
});
test('validates file size, UTF-8 filename size and frame bounds before transmission', () => {
  assert.throws(() => C.encode({length: C.MAX_FILE + 1}, 'large', 1), /16 MiB/);
  assert.throws(() => C.encode(new Uint8Array(), 'a'.repeat(1025), 1), /Filename/);
  const sender = C.encode(payload, 'x', 1);
  for (const index of [-1, 0.5, sender.count, NaN]) assert.throws(() => sender.frame(index), /index/);
});

for (const density of Array.from({length: 65}, (_, i) => i + 32)) {
  test(`auto-detects density ${density} and reassembles with its packet capacity`, () => {
    const sender = C.encode(payload, 'density.bin', 17, density), receiver = new C.Receiver();
    const found = C.decodeImage(camera(sender.frame(0), undefined, {noise: 10, blur: true}));
    assert.equal(found?.packet?.density, density);
    assert.equal(found.packet.chunkSize, sender.chunkSize);
    receiver.accept(found.packet); let result;
    for (let i = 1; i < sender.count; i++) result = receiver.accept(readGrid(sender.frame(i)));
    result ||= receiver.accept(found.packet);
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(payload));
  });
}
test('rejects invalid density before allocating file contents', () => {
  for (const density of [0, 31, 97, 48.5, NaN, Infinity]) assert.throws(() => C.encode(payload, 'x', 1, density), /Density/);
});

test('recalibrates after the camera moves and after the sender changes density', () => {
  const first = C.encode(payload, 'move.bin', 81, 48);
  const original = C.decodeImage(camera(first.frame(0)));
  assert.ok(original?.packet);
  const moved = C.decodeImage(camera(first.frame(1), perspectives[2][1]), original.corners);
  assert.ok(moved?.packet); assert.equal(moved.packet.index, 1);
  const second = C.encode(payload, 'dense.bin', 82, 80);
  const changed = C.decodeImage(camera(second.frame(0)), original.corners);
  assert.equal(changed?.packet?.density, 80);
});
