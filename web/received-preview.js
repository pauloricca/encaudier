/* Shared by audio and camera reception; previews use the same local blob as downloads. */
(() => {
  'use strict';
  const types = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/vnd.microsoft.icon',
    svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif'};
  function blob(data, filename) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const starts = signature => signature.every((value, i) => bytes[i] === value);
    let type = '';
    if (starts([137, 80, 78, 71, 13, 10, 26, 10])) type = 'image/png';
    else if (starts([255, 216, 255])) type = 'image/jpeg';
    else if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97])) type = 'image/gif';
    else if (starts([82, 73, 70, 70]) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) type = 'image/webp';
    else if (starts([66, 77])) type = 'image/bmp';
    else if (starts([0, 0, 1, 0])) type = 'image/vnd.microsoft.icon';
    else type = types[filename.split('.').pop().toLowerCase()] || 'application/octet-stream';
    return new Blob([data], {type});
  }
  function clear(id) {
    const image = document.getElementById(id);
    image.onload = image.onerror = null; image.hidden = true;
    image.removeAttribute('src'); image.alt = '';
  }
  function show(id, url, filename, type) {
    clear(id);
    if (!type.startsWith('image/')) return;
    const image = document.getElementById(id);
    image.alt = `Received image: ${filename}`;
    image.onload = () => { if (image.getAttribute('src') === url) image.hidden = false; };
    // Unsupported or invalid images still have a normal download, without a broken preview.
    image.onerror = () => { if (image.getAttribute('src') === url) clear(id); };
    image.src = url;
  }
  globalThis.ReceivedPreview = {blob, clear, show};
})();
