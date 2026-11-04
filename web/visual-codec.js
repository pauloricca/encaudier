/* Browser-only optical transport. The same codec runs in the synthetic camera tests. */
(() => {
  'use strict';
  const GRID = 48, QUIET = 3, MAX_FILE = 16 * 1024 * 1024, HEADER = 28;
  const unitSquare = [[0, 0], [1, 0], [1, 1], [0, 1]], layouts = new Map();
  function layout(density = GRID) {
    if (!Number.isInteger(density) || density < 32 || density > 96) throw Error('Density must be a whole number from 32 to 96 boxes per side.');
    if (layouts.has(density)) return layouts.get(density);
    const cells = [], band = [], half = Math.floor(density / 2);
    const bandStart = density / 2 - (density - 9) / 4, bandWidth = (density - 9) / 2;
    for (let y = 0; y < density; y++) for (let x = 0; x < density; x++) {
      if ((x < 9 || x >= density - 9) && (y < 9 || y >= density - 9)) continue;
      if (Math.abs(y - half) <= 1 && x + 0.5 >= bandStart && x + 0.5 < bandStart + bandWidth) {
        band.push([x, y, Math.floor((x + 0.5 - bandStart) / bandWidth * 8)]);
      } else cells.push([x, y]);
    }
    const packetSize = Math.floor(cells.length / 8), chunkSize = packetSize - HEADER - 4;
    const centers = [[4.5, 4.5], [density - 4.5, 4.5], [density - 4.5, density - 4.5], [4.5, density - 4.5]];
    const value = {density, cells, band, packetSize, chunkSize, centers}; layouts.set(density, value); return value;
  }
  const table = Uint32Array.from({length: 256}, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes, end = bytes.length) {
    let crc = 0xffffffff;
    for (let i = 0; i < end; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function safeName(name) {
    return name.replace(/\\/g, '/').split('/').pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().replace(/[. ]+$/g, '') || 'received.bin';
  }
  function encode(bytes, filename, session, density = GRID) {
    const config = layout(density), {packetSize, chunkSize} = config;
    if (bytes.length > MAX_FILE) throw Error('Visual transfers are limited to 16 MiB. Choose a smaller file.');
    const name = new TextEncoder().encode(safeName(filename));
    if (name.length > 1024) throw Error('Filename is too long (maximum 1,024 UTF-8 bytes).');
    const data = new Uint8Array(2 + name.length + bytes.length);
    new DataView(data.buffer).setUint16(0, name.length); data.set(name, 2); data.set(bytes, 2 + name.length);
    const checksum = crc32(data), count = Math.ceil(data.length / chunkSize);
    return {count, density, chunkSize, size: bytes.length, frame(index) {
      if (!Number.isInteger(index) || index < 0 || index >= count) throw Error('Invalid visual frame index.');
      const packet = new Uint8Array(packetSize), view = new DataView(packet.buffer);
      packet.set([69, 86, 48, 49]); view.setUint32(4, session); view.setUint32(8, data.length);
      view.setUint32(12, checksum); view.setUint32(16, index); view.setUint32(20, count);
      const chunk = data.subarray(index * chunkSize, (index + 1) * chunkSize);
      view.setUint16(24, chunk.length); view.setUint16(26, density); packet.set(chunk, HEADER);
      view.setUint32(packetSize - 4, crc32(packet, packetSize - 4));
      return toGrid(packet, config);
    }};
  }
  function toGrid(packet, {density, centers, cells, band}) {
    const grid = new Uint8Array(density * density);
    for (const [x, y, bit] of band) grid[y * density + x] = (density >>> (7 - bit)) & 1;
    for (const [cx, cy] of centers) {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        grid[(cy - 3.5 + y) * density + cx - 3.5 + x] = +(x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
      }
    }
    for (let bit = 0; bit < packet.length * 8; bit++) {
      const [x, y] = cells[bit]; grid[y * density + x] = (packet[bit >>> 3] >>> (7 - bit % 8)) & 1;
    }
    return grid;
  }
  function readPacket(readCell, density = GRID) {
    const {cells, packetSize, chunkSize} = layout(density);
    const bytes = new Uint8Array(packetSize);
    for (let bit = 0; bit < bytes.length * 8; bit++) {
      const [x, y] = cells[bit]; bytes[bit >>> 3] |= readCell(x + 0.5, y + 0.5) << (7 - bit % 8);
      if (bit === 31 && (bytes[0] !== 69 || bytes[1] !== 86 || bytes[2] !== 48 || bytes[3] !== 49)) return null;
    }
    const view = new DataView(bytes.buffer);
    if (view.getUint32(packetSize - 4) !== crc32(bytes, packetSize - 4)) return null;
    const size = view.getUint32(8), index = view.getUint32(16), count = view.getUint32(20), length = view.getUint16(24);
    if (size < 3 || size > MAX_FILE + 1026 || count !== Math.ceil(size / chunkSize) || index >= count ||
        length !== Math.min(chunkSize, size - index * chunkSize) || view.getUint16(26) !== density) return null;
    return {density, chunkSize, session: view.getUint32(4), checksum: view.getUint32(12), size, index, count, chunk: bytes.slice(HEADER, HEADER + length)};
  }
  class Receiver {
    constructor() { this.transfer = null; }
    accept(packet) {
      if (!packet) return null;
      const key = `${packet.session}:${packet.checksum}:${packet.size}:${packet.density}`;
      if (!this.transfer) this.transfer = {key, bytes: new Uint8Array(packet.size), seen: new Uint8Array(packet.count), received: 0, count: packet.count};
      const current = this.transfer;
      if (current.key !== key) return {otherTransfer: true};
      if (!current.seen[packet.index]) {
        current.bytes.set(packet.chunk, packet.index * packet.chunkSize); current.seen[packet.index] = 1; current.received++;
      }
      const result = {received: current.received, count: current.count};
      if (current.received === current.count) {
        if (crc32(current.bytes) !== packet.checksum) { this.transfer = null; throw Error('File checksum failed. Waiting for a fresh loop.'); }
        const nameSize = new DataView(current.bytes.buffer).getUint16(0);
        if (!nameSize || nameSize > 1024 || nameSize + 2 > current.bytes.length) { this.transfer = null; throw Error('Invalid visual file header.'); }
        result.filename = safeName(new TextDecoder('utf-8', {fatal: true}).decode(current.bytes.subarray(2, 2 + nameSize)));
        result.bytes = current.bytes.slice(2 + nameSize);
      }
      return result;
    }
  }
  // Projective mapping from grid coordinates to camera pixels, solved from four finder centers.
  function homography(from, to) {
    const a = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let col = 0; col < 8; col++) {
      let pivot = col;
      for (let row = col + 1; row < 8; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const divisor = a[col][col]; if (Math.abs(divisor) < 1e-9) return null;
      for (let k = col; k <= 8; k++) a[col][k] /= divisor;
      for (let row = 0; row < 8; row++) if (row !== col) {
        const scale = a[row][col];
        for (let k = col; k <= 8; k++) a[row][k] -= scale * a[col][k];
      }
    }
    const h = a.map(row => row[8]);
    return (x, y) => {
      const d = h[6] * x + h[7] * y + 1;
      return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
    };
  }
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function grayscale(image) {
    const gray = new Uint8Array(image.width * image.height), histogram = new Uint32Array(256);
    let sum = 0;
    for (let i = 0; i < gray.length; i++) {
      const j = i * 4, value = (image.data[j] * 77 + image.data[j + 1] * 150 + image.data[j + 2] * 29) >>> 8;
      gray[i] = value; histogram[value]++; sum += value;
    }
    let weight = 0, left = 0, best = 0, threshold = 127;
    for (let i = 0; i < 255; i++) {
      weight += histogram[i]; left += i * histogram[i];
      if (!weight || weight === gray.length) continue;
      const delta = left / weight - (sum - left) / (gray.length - weight);
      const variance = weight * (gray.length - weight) * delta * delta;
      if (variance > best) { best = variance; threshold = i; }
    }
    return {gray, threshold};
  }
  function finders(gray, width, height, threshold) {
    const black = (x, y) => x >= 0 && y >= 0 && x < width && y < height && gray[y * width + x] <= threshold;
    const ratio = runs => {
      const unit = runs.reduce((a, b) => a + b, 0) / 7;
      return unit >= 1.5 && runs.every((n, i) => Math.abs(n - (i === 2 ? 3 : 1) * unit) < unit * (i === 2 ? 1.25 : 0.8));
    };
    function cross(x, y, dx, dy) {
      x = Math.round(x); y = Math.round(y);
      if (!black(x, y)) return null;
      const runs = [0, 0, 1, 0, 0];
      const limit = Math.min(width, height) / 3;
      for (const direction of [-1, 1]) {
        let step = 1, section = 2;
        while (step < limit) {
          const px = x + dx * step * direction, py = y + dy * step * direction;
          if (px < 0 || py < 0 || px >= width || py >= height) return null;
          const value = black(px, py);
          if (value !== (section % 2 === 0)) section += direction;
          if (section < 0 || section > 4) break;
          runs[section]++; step++;
        }
        if (section !== (direction < 0 ? -1 : 5)) return null;
      }
      if (!ratio(runs)) return null;
      // Center of the central black run (pixel centers, not pixel edges).
      let negative = 0;
      while (black(x - dx * (negative + 1), y - dy * (negative + 1))) negative++;
      const offset = (runs[2] - 1) / 2 - negative;
      return {x: x + dx * offset, y: y + dy * offset, unit: runs.reduce((a, b) => a + b, 0) / 7};
    }
    const found = [];
    for (let y = 0; y < height; y += 2) {
      const runs = [], starts = []; let previous = false, length = 0, start = 0;
      for (let x = 0; x <= width; x++) {
        const value = x < width && black(x, y);
        if (x === 0 || value === previous) { length++; previous = value; continue; }
        runs.push(length); starts.push(start);
        if (runs.length > 5) { runs.shift(); starts.shift(); }
        if (previous && runs.length === 5 && ratio(runs)) {
          const cx = starts[2] + (runs[2] - 1) / 2;
          const vertical = cross(cx, y, 0, 1);
          const horizontal = vertical && cross(cx, vertical.y, 1, 0);
          if (horizontal && Math.abs(horizontal.unit - vertical.unit) < Math.max(horizontal.unit, vertical.unit) * 0.6) {
            const point = [horizontal.x, vertical.y], unit = (horizontal.unit + vertical.unit) / 2;
            const match = found.find(item => distance(item.point, point) < unit * 2);
            if (match) { const n = ++match.hits; match.point = match.point.map((v, i) => v + (point[i] - v) / n); }
            else found.push({point, unit, hits: 1});
          }
        }
        start = x; length = 1; previous = value;
      }
    }
    return found.filter(item => item.hits >= 2).sort((a, b) => b.hits - a.hits).slice(0, 10);
  }
  function decodeImage(image, previous = null) {
    const {width, height} = image, {gray, threshold} = grayscale(image);
    const sample = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      return x < 0 || y < 0 || x >= width || y >= height ? 255 : gray[y * width + x];
    };
    function attempt(points) {
      const normalized = homography(unitSquare, points); if (!normalized) return null;
      // A stationary center stripe advertises the density in normalized finder coordinates.
      let density = 0;
      for (let bit = 0; bit < 8; bit++) density = (density << 1) | +(sample(...normalized(0.25 + (bit + 0.5) / 16, 0.5)) <= threshold);
      if (density < 32 || density > 96) return null;
      const {centers} = layout(density);
      const project = homography(centers, points); if (!project) return null;
      let dark = 0, light = 0;
      for (const [x, y] of centers) {
        dark += sample(...project(x, y)); light += sample(...project(x - 2, y));
      }
      dark /= 4; light /= 4;
      if (light - dark < 35) return null;
      const split = (dark + light) / 2;
      const read = (x, y) => {
        let value = sample(...project(x, y)) * 2;
        value += sample(...project(x - 0.16, y - 0.16)) + sample(...project(x + 0.16, y + 0.16));
        return +(value / 4 < split);
      };
      let errors = 0;
      for (const [cx, cy] of centers) for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
        const expected = +(Math.abs(x) === 3 || Math.abs(y) === 3 || (Math.abs(x) <= 1 && Math.abs(y) <= 1));
        if (read(cx + x, cy + y) !== expected) errors++;
      }
      if (errors > 12) return null;
      return {packet: readPacket(read, density), density, corners: points, outline: [[0, 0], [density, 0], [density, density], [0, density]].map(([x, y]) => project(x, y))};
    }
    if (previous) { const result = attempt(previous); if (result?.packet) return result; }
    const candidates = finders(gray, width, height, threshold);
    let calibrated = null;
    for (let a = 0; a < candidates.length - 3; a++) for (let b = a + 1; b < candidates.length - 2; b++)
      for (let c = b + 1; c < candidates.length - 1; c++) for (let d = c + 1; d < candidates.length; d++) {
        const group = [a, b, c, d].map(i => candidates[i]), points = group.map(item => item.point);
        const middle = points.reduce((p, q) => [p[0] + q[0] / 4, p[1] + q[1] / 4], [0, 0]);
        points.sort((p, q) => Math.atan2(p[1] - middle[1], p[0] - middle[0]) - Math.atan2(q[1] - middle[1], q[0] - middle[0]));
        const sides = points.map((p, i) => distance(p, points[(i + 1) % 4]));
        if (Math.min(...sides) < 15 * Math.min(...group.map(item => item.unit)) || Math.max(...sides) / Math.min(...sides) > 3) continue;
        const turns = points.map((p, i) => {
          const q = points[(i + 1) % 4], r = points[(i + 2) % 4];
          return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
        });
        if (!turns.every(value => value > 0)) continue;
        // Try rotations and mirrored camera feeds. The packet magic fixes orientation.
        for (const direction of [1, -1]) for (let rotation = 0; rotation < 4; rotation++) {
          const ordered = points.map((_, i) => points[(rotation + direction * i + 4) % 4]);
          const result = attempt(ordered);
          if (result?.packet) return result;
          if (result) calibrated = result;
        }
      }
    return calibrated;
  }
  globalThis.VisualCodec = {GRID, QUIET, MAX_FILE, layout, encode, Receiver, decodeImage, homography, readPacket};
})();
