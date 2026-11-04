/* Runs entirely in a local Web Worker. No network APIs are used. */
const RATE = 48000, AMPLITUDE = 16000, OVERSAMPLE = 8;
const SYNC = [0xd3, 0x91, 0xc5, 0xa8];
const FILTER_WEIGHTS = [1, 2, 3, 4, 5, 5, 5, 5, 4, 3, 2, 1];
const MAX_WAV = 512 * 1024 * 1024, MAX_RECEIVE = 64 * 1024 * 1024;
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function validate(bitrate, frequency, rate = RATE) {
  if (!Number.isInteger(bitrate) || bitrate < 1 || bitrate > 9600) throw Error('Bitrate must be an integer from 1 to 9,600.');
  if (!Number.isFinite(frequency) || frequency <= 0 || frequency >= rate / 2) throw Error(`Carrier must be above 0 and below ${rate / 2} Hz.`);
  if (bitrate > rate) throw Error('Bitrate exceeds the microphone sample rate.');
}
function roundEven(x) {
  const floor = Math.floor(x);
  return x - floor === 0.5 ? floor + (floor % 2) : Math.round(x);
}
function safeFilename(name, fallback = 'received.bin') {
  name = name.replace(/\\/g, '/').split('/').pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().replace(/[. ]+$/g, '');
  return name && name !== '.' && name !== '..' ? name : fallback;
}
async function encode(message) {
  const {bitrate, frequency} = message;
  validate(bitrate, frequency);
  const size = message.bytes ? message.bytes.length : message.file.size;
  const name = new TextEncoder().encode(safeFilename(message.filename ?? message.file?.name ?? '', ''));
  if (name.length > 65535) throw Error('Filename exceeds 65535 UTF-8 bytes.');
  const preamble = Math.max(8, Math.ceil(bitrate / 8));
  const samplesPerBit = RATE / bitrate;
  const total = roundEven((preamble + size + name.length + 14) * 8 * samplesPerBit);
  if (44 + total * 2 > MAX_WAV) throw Error('The WAV would exceed the 512 MiB browser limit. Increase the bitrate or choose a smaller file.');
  const data = message.bytes || new Uint8Array(await message.file.arrayBuffer());
  const frame = new Uint8Array(preamble + data.length + name.length + 14);
  const frameView = new DataView(frame.buffer);
  frame.fill(0xaa, 0, preamble);
  frame.set(SYNC, preamble);
  frameView.setUint32(preamble + 4, data.length);
  frameView.setUint16(preamble + 8, name.length);
  frame.set(name, preamble + 10);
  frame.set(data, preamble + 10 + name.length);
  frameView.setUint32(frame.length - 4, crc32(frame, preamble + 4, frame.length - 4));
  const buffer = new ArrayBuffer(44 + total * 2), wav = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, i) => wav.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); wav.setUint32(4, 36 + total * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
  wav.setUint32(24, RATE, true); wav.setUint32(28, RATE * 2, true);
  wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); text(36, 'data'); wav.setUint32(40, total * 2, true);
  let last = -1;
  for (let start = 0; start < total; start += 65536) {
    const end = Math.min(start + 65536, total);
    for (let n = start; n < end; n++) {
      const bit = Math.min(Math.floor(n / samplesPerBit), frame.length * 8 - 1);
      const on = (frame[bit >>> 3] >>> (7 - bit % 8)) & 1;
      wav.setInt16(44 + n * 2, on ? Math.trunc(AMPLITUDE * Math.sin(2 * Math.PI * frequency * n / RATE)) : 0, true);
    }
    const percent = Math.floor(100 * end / total);
    if (percent !== last) { postMessage({type: 'encode-progress', percent}); last = percent; }
  }
  postMessage({type: 'encoded', buffer, duration: total / RATE}, [buffer]);
}
const marker = [...Array(8).fill(0xaa), ...SYNC].flatMap(byte => Array.from({length: 8}, (_, i) => (byte >> (7 - i)) & 1));
const markerMean = marker.reduce((a, b) => a + b, 0) / marker.length;
const pattern = marker.map(bit => bit - markerMean);
const patternEnergy = pattern.reduce((sum, bit) => sum + bit * bit, 0);
function median(values) {
  values.sort((a, b) => a - b);
  const i = Math.floor(values.length / 2);
  return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
}
class Packet {
  constructor(start, threshold) {
    this.start = this.next = start; this.threshold = threshold;
    this.bits = this.byte = this.length = 0; this.bytes = new Uint8Array(1024); this.size = null; this.nameSize = null; this.filename = null; this.error = null;
  }
  feed(level, index) {
    if (index !== this.next) return null;
    this.next += OVERSAMPLE;
    this.byte = (this.byte << 1) | (level > this.threshold ? 1 : 0);
    if (++this.bits < 8) return null;
    if (this.length === this.bytes.length) {
      const expanded = new Uint8Array(Math.min(this.bytes.length * 2, (this.size ?? MAX_RECEIVE) + (this.nameSize ?? 65535) + 10));
      expanded.set(this.bytes); this.bytes = expanded;
    }
    this.bytes[this.length++] = this.byte; this.bits = this.byte = 0;
    if (this.length === 6) {
      this.size = ((this.bytes[0] * 0x1000000) + (this.bytes[1] << 16) + (this.bytes[2] << 8) + this.bytes[3]) >>> 0;
      this.nameSize = (this.bytes[4] << 8) | this.bytes[5];
      if (this.size > MAX_RECEIVE) this.error = 'File length exceeds the 64 MiB receive limit.';
    }
    if (!this.error && this.size !== null && this.length === this.size + this.nameSize + 10) {
      const packet = this.bytes.subarray(0, this.length);
      const view = new DataView(packet.buffer);
      if (crc32(packet, 0, packet.length - 4) === view.getUint32(packet.length - 4)) {
        try {
          this.filename = safeFilename(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(packet.subarray(6, 6 + this.nameSize)));
        } catch { this.error = 'Invalid UTF-8 filename.'; return null; }
        return packet.slice(6 + this.nameSize, -4);
      }
      this.error = 'Checksum failed.';
    }
    return null;
  }
}
class Receiver {
  constructor(bitrate, frequency, rate) {
    validate(bitrate, frequency, rate);
    this.bitrate = bitrate; this.frequency = frequency; this.rate = rate;
    this.samplesPerBit = rate / bitrate; this.ratio = OVERSAMPLE / this.samplesPerBit;
    this.n = this.bin = this.i = this.q = 0;
    this.ringI = new Float64Array(12); this.ringQ = new Float64Array(12);
    this.phases = Array.from({length: 8}, () => ({values: new Float64Array(marker.length), count: 0, sum: 0, squares: 0}));
    this.active = []; this.lastStart = this.lastHeader = -1000; this.lastProgress = -1;
    this.done = false;
  }
  feed(samples) {
    for (const sample of samples) {
      if (this.done) break;
      const angle = 2 * Math.PI * this.frequency * this.n / this.rate;
      this.i += sample * 32768 * Math.cos(angle);
      this.q -= sample * 32768 * Math.sin(angle);
      const nextBin = Math.floor(++this.n * this.ratio);
      while (this.bin < nextBin) {
        this.finishBin(); this.bin++; this.i = this.q = 0;
        if (this.done) break;
      }
    }
  }
  finishBin() {
    this.ringI[this.bin % 12] = this.i; this.ringQ[this.bin % 12] = this.q;
    if (this.bin < 9) return;
    let i = 0, q = 0;
    for (let k = 0; k < 12; k++) {
      const bin = this.bin - 11 + k;
      if (bin >= 0) { i += this.ringI[bin % 12] * FILTER_WEIGHTS[k]; q += this.ringQ[bin % 12] * FILTER_WEIGHTS[k]; }
    }
    this.level(2 * Math.hypot(i, q) / (5 * this.samplesPerBit), this.bin - 9);
  }
  level(level, index) {
    const survivors = []; let error = null;
    for (const packet of this.active) {
      const hadHeader = packet.size !== null;
      const payload = packet.feed(level, index);
      if (payload !== null) {
        this.done = true;
        postMessage({type: 'decoded', buffer: payload.buffer, size: payload.length, filename: packet.filename}, [payload.buffer]);
        return;
      }
      if (packet.error) { error = packet.error; continue; }
      if (!hadHeader && packet.size !== null && packet.start > this.lastHeader + 16) {
        this.lastHeader = packet.start;
        postMessage({type: 'receive-header', size: packet.size});
      }
      if (packet.size !== null) {
        const percent = Math.min(99, Math.floor(100 * Math.max(0, packet.length - 6) / Math.max(1, packet.size + packet.nameSize + 4)));
        if (percent > this.lastProgress) { this.lastProgress = percent; postMessage({type: 'receive-progress', percent}); }
      }
      survivors.push(packet);
    }
    this.active = survivors;
    if (error && !this.active.length) {
      this.lastProgress = -1;
      postMessage({type: 'receive-reset', message: `${error} Listening for another transmission…`});
    }
    const phase = this.phases[index % 8], slot = phase.count % marker.length;
    const old = phase.values[slot]; phase.values[slot] = level;
    phase.sum += level - old; phase.squares += level * level - old * old; phase.count++;
    if (phase.count < marker.length) return;
    const start = phase.count % marker.length;
    const variance = Math.max(0, phase.squares - phase.sum * phase.sum / marker.length);
    const scale = Math.sqrt(variance * patternEnergy);
    if (scale < 1e-6) return;
    let correlation = 0;
    for (let k = 0; k < marker.length; k++) correlation += phase.values[(start + k) % marker.length] * pattern[k];
    if (correlation / scale < 0.85) return;
    const lowValues = [], highValues = [];
    for (let k = 0; k < marker.length; k++) (marker[k] ? highValues : lowValues).push(phase.values[(start + k) % marker.length]);
    const low = median(lowValues), high = median(highValues);
    if (high - low < 20) return;
    if (this.active.length >= 16) this.active.shift();
    this.active.push(new Packet(index + 8, (low + high) / 2));
    if (index > this.lastStart + 16) {
      this.lastStart = index;
      postMessage({type: 'receive-start'});
    }
  }
}
let receiver = null;
onmessage = async ({data}) => {
  try {
    if (data.type === 'encode') await encode(data);
    else if (data.type === 'decode-start') {
      receiver = new Receiver(data.bitrate, data.frequency, data.sampleRate);
      postMessage({type: 'listening'});
    } else if (data.type === 'audio' && receiver && !receiver.done) {
      receiver.feed(data.samples); postMessage({type: 'audio-ack'});
    }
  } catch (error) { postMessage({type: 'error', message: error.message || String(error)}); }
};
