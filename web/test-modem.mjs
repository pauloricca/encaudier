import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(import.meta.dirname, 'modem-worker.js'), 'utf8');
function modem() {
  const messages = [];
  const context = vm.createContext({TextEncoder, TextDecoder, postMessage: message => messages.push(message)});
  vm.runInContext(source, context);
  return {messages, send: data => context.onmessage({data})};
}
function python(script, args) {
  const result = spawnSync('python3', ['-c', script, ...args], {cwd: root, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const filename = 'résumé 🐈.txt';
const payload = Uint8Array.from({length: 256}, (_, i) => i);
for (const [bitrate, frequency] of [[100, 2000], [137, 7321.5], [9600, 12000]]) {
  test(`browser WAV decodes in Python: ${bitrate} bit/s, ${frequency} Hz`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'encaudier-web-'));
    try {
      for (const bytes of [new Uint8Array(), payload]) {
        const worker = modem();
        await worker.send({type: 'encode', bytes, filename, bitrate, frequency});
        assert.equal(worker.messages.find(message => message.type === 'error'), undefined);
        const encoded = worker.messages.find(message => message.type === 'encoded');
        assert.ok(encoded);
        const path = join(folder, 'browser.wav'); writeFileSync(path, Buffer.from(encoded.buffer));
        assert.equal(python('from decoder import decode; import sys; data, name = decode(sys.argv[1], int(sys.argv[2]), frequency=float(sys.argv[3]), with_filename=True); assert name == sys.argv[4]; print(data.hex())',
          [path, String(bitrate), String(frequency), filename]), Buffer.from(bytes).toString('hex'));
        assert.equal(worker.messages.filter(message => message.type === 'encode-progress').at(-1).percent, 100);
      }
    } finally { rmSync(folder, {recursive: true, force: true}); }
  });
  test(`browser microphone decoder receives Python audio: ${bitrate} bit/s, ${frequency} Hz`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'encaudier-web-'));
    try {
      const path = join(folder, 'python.wav');
      python('from encoder import generate; import sys; generate(bytes(range(256)), int(sys.argv[2]), sys.argv[1], float(sys.argv[3]), filename=sys.argv[4])', [path, String(bitrate), String(frequency), filename]);
      const wav = readFileSync(path), pcm = new Float32Array((wav.length - 44) / 2 + 12347 + 9600);
      let random = 42;
      for (let i = 0; i < pcm.length; i++) { random = (1664525 * random + 1013904223) >>> 0; pcm[i] = (random / 0x100000000 - 0.5) * 100 / 32768; }
      for (let i = 0; i < (wav.length - 44) / 2; i++) pcm[i + 12347] += wav.readInt16LE(44 + i * 2) / 65536;
      const worker = modem(); await worker.send({type: 'decode-start', bitrate, frequency, sampleRate: 48000});
      for (let i = 0; i < pcm.length; i += 4093) await worker.send({type: 'audio', samples: pcm.slice(i, i + 4093)});
      assert.equal(worker.messages.find(message => message.type === 'error'), undefined);
      const result = worker.messages.find(message => message.type === 'decoded');
      assert.ok(result, 'Expected a complete CRC-verified file');
      assert.deepEqual(Buffer.from(result.buffer), Buffer.from(payload));
      assert.equal(result.filename, filename);
      assert.ok(worker.messages.some(message => message.type === 'receive-start'));
    } finally { rmSync(folder, {recursive: true, force: true}); }
  });
}
test('rejects corruption, then receives the next valid transmission', async () => {
  const worker = modem();
  const encode = async bytes => {
    const encoder = modem(); await encoder.send({type: 'encode', bytes, bitrate: 100, frequency: 2000});
    const wav = new DataView(encoder.messages.find(message => message.type === 'encoded').buffer);
    return Float32Array.from({length: (wav.byteLength - 44) / 2}, (_, i) => wav.getInt16(44 + i * 2, true) / 32768);
  };
  const bad = await encode(new Uint8Array(10).fill(255));
  const payloadStart = (13 + 10) * 8 * 480;
  bad.fill(0, payloadStart, payloadStart + 480);
  const good = await encode(payload);
  await worker.send({type: 'decode-start', bitrate: 100, frequency: 2000, sampleRate: 48000});
  for (const audio of [bad, new Float32Array(4800), good, new Float32Array(4800)]) {
    for (let i = 0; i < audio.length; i += 4096) await worker.send({type: 'audio', samples: audio.slice(i, i + 4096)});
  }
  const result = worker.messages.find(message => message.type === 'decoded');
  assert.ok(result); assert.equal(result.filename, 'received.bin'); assert.deepEqual(Buffer.from(result.buffer), Buffer.from(payload));
});
test('rejects invalid settings before allocation', async () => {
  for (const [bitrate, frequency] of [[0, 2000], [9601, 2000], [100, 24000], [100, NaN]]) {
    const worker = modem(); await worker.send({type: 'encode', bytes: payload, bitrate, frequency});
    assert.ok(worker.messages.some(message => message.type === 'error'));
    assert.ok(!worker.messages.some(message => message.type === 'encoded'));
  }
});

test('browser file input preserves its name across buffered reception', async () => {
  const bytes = Uint8Array.from({length: 2048}, (_, i) => i & 255);
  const encoder = modem();
  await encoder.send({type: 'encode', file: {name: '../résumé.txt', size: bytes.length,
    arrayBuffer: async () => bytes.buffer}, bitrate: 9600, frequency: 12000});
  const wav = new DataView(encoder.messages.find(message => message.type === 'encoded').buffer);
  const pcm = Float32Array.from({length: (wav.byteLength - 44) / 2 + 4800}, (_, i) =>
    44 + i * 2 < wav.byteLength ? wav.getInt16(44 + i * 2, true) / 32768 : 0);
  const worker = modem();
  await worker.send({type: 'decode-start', bitrate: 9600, frequency: 12000, sampleRate: 48000});
  for (let i = 0; i < pcm.length; i += 4093) await worker.send({type: 'audio', samples: pcm.slice(i, i + 4093)});
  const result = worker.messages.find(message => message.type === 'decoded');
  assert.ok(result);
  assert.equal(result.filename, 'résumé.txt');
  assert.deepEqual(Buffer.from(result.buffer), Buffer.from(bytes));
});
