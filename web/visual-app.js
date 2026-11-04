(() => {
  'use strict';
  const $ = id => document.getElementById(id), codec = VisualCodec;
  const size = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
  const status = (mode, message, kind = '') => { $(`${mode}-status`).textContent = message; $(`${mode}-status`).className = `status ${kind}`; };
  let file = null, showGeneration = 0, timer = null, transmission = null, frameIndex = 0, loops = 0;
  let stream = null, scanGeneration = 0, animation = null, downloadURL = null, wakeLock = null, wakePending = false;
  async function keepAwake() {
    if (!navigator.wakeLock || wakeLock || wakePending) return;
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!transmission && !stream) { await lock.release(); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch { /* Optional on browsers without wake locks. */ }
    finally { wakePending = false; }
  }
  function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = null; }
  function draw(indices, density) {
    const canvas = $('visual-grid'), ctx = canvas.getContext('2d');
    const columns = Math.ceil(Math.sqrt(indices.length)), rows = Math.ceil(indices.length / columns);
    const extent = density + codec.QUIET * 2, unit = Math.min(12, Math.floor(1920 / (extent * columns)));
    const width = extent * unit * columns, height = extent * unit * rows;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    canvas.style.aspectRatio = `${columns} / ${rows}`;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#000';
    indices.forEach((index, slot) => {
      const grid = transmission.frame(index), left = (slot % columns) * extent, top = Math.floor(slot / columns) * extent;
      for (let y = 0; y < density; y++) for (let x = 0; x < density; x++) {
        if (grid[y * density + x]) ctx.fillRect((left + x + codec.QUIET) * unit, (top + y + codec.QUIET) * unit, unit, unit);
      }
    });
  }
  function stopShow(message = '') {
    const wasActive = !!transmission || $('visual-file').disabled;
    showGeneration++; clearTimeout(timer); timer = null; transmission = null;
    $('start-show').disabled = !file; $('start-show').textContent = 'show file'; $('stop-show').hidden = true;
    $('visual-file').disabled = false; $('visual-density').disabled = false; $('visual-idle').hidden = false; $('visual-idle').textContent = 'the grid appears here';
    const canvas = $('visual-grid'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    $('show-meta').textContent = '';
    if (!stream) releaseWakeLock(); if (message || wasActive) status('show', message || 'stopped');
  }
  function chooseFile(next) {
    if (!next) return; stopShow(); file = null; $('start-show').disabled = true; $('show-meta').textContent = '';
    $('visual-filename').textContent = next.name; $('visual-filesize').textContent = size(next.size);
    if (next.size > codec.MAX_FILE) { status('show', 'Visual transfers are limited to 16 MiB. Choose a smaller file.', 'error'); return; }
    file = next; estimate();
  }
  $('visual-file').addEventListener('change', event => chooseFile(event.target.files[0]));
  $('visual-dropzone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('visual-file').click(); } });
  $('visual-dropzone').addEventListener('dragover', event => { event.preventDefault(); $('visual-dropzone').classList.add('dragover'); });
  $('visual-dropzone').addEventListener('dragleave', event => { if (!$('visual-dropzone').contains(event.relatedTarget)) $('visual-dropzone').classList.remove('dragover'); });
  $('visual-dropzone').addEventListener('drop', event => {
    event.preventDefault(); $('visual-dropzone').classList.remove('dragover');
    if (event.dataTransfer.files.length !== 1) { status('show', 'Choose one file at a time.', 'error'); return; }
    chooseFile(event.dataTransfer.files[0]);
  });
  function nextFrame() {
    if (!transmission) return;
    const codes = Number($('visual-codes').value), indices = codec.frameIndices(frameIndex, transmission.count, codes);
    draw(indices, transmission.density);
    const fps = Number($('visual-speed').value);
    $('show-meta').textContent = `packets ${indices.map(index => index + 1).join(", ")} / ${transmission.count} · loop ${loops + 1} · ~${size(transmission.chunkSize * fps * Math.min(codes, transmission.count))}/s`;
    if (++frameIndex === transmission.count) { frameIndex = 0; loops++; }
    timer = setTimeout(nextFrame, 1000 / fps);
  }
  $('start-show').addEventListener('click', async () => {
    if (!file || transmission) return;
    const generation = ++showGeneration, selected = file;
    $('start-show').disabled = true; $('start-show').textContent = 'preparing…'; $('stop-show').hidden = false; $('visual-file').disabled = true; $('visual-density').disabled = true;
    try {
      const {density} = settings();
      const bytes = new Uint8Array(await selected.arrayBuffer());
      if (generation !== showGeneration) return;
      const session = crypto.getRandomValues(new Uint32Array(1))[0];
      transmission = codec.encode(bytes, selected.name, session, density); frameIndex = loops = 0;
      $('visual-density').disabled = true; $('visual-idle').hidden = true; $('start-show').textContent = 'showing';
      status('show', 'Looping until you stop. The receiver collects missed frames on later loops.');
      keepAwake(); nextFrame();
    } catch (error) { if (generation === showGeneration) { stopShow(); status('show', error.message, 'error'); } }
  });
  function settings() {
    const density = Number($('visual-density').value), fps = Number($('visual-speed').value), codes = Number($('visual-codes').value);
    codec.layout(density);
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw Error('Frame rate must be a whole number from 1 to 30 fps.');
    codec.frameIndices(0, 1, codes);
    return {density, fps, codes};
  }
  function estimate() {
    try {
      const {density, fps, codes} = settings(), bytes = codec.layout(density).chunkSize;
      $('visual-estimate').textContent = `${density} × ${density} boxes · ${fps} fps · ${codes} ${codes === 1 ? "code" : "codes"} · ~${size(bytes * fps * codes)}/s before retries`;
      if (!transmission) { $('start-show').disabled = !file; status('show', ''); }
    } catch (error) { if (transmission) stopShow(); $('start-show').disabled = true; $('visual-estimate').textContent = ''; status('show', error.message, 'error'); }
  }
  for (const id of ['visual-density', 'visual-speed', 'visual-codes']) $(id).addEventListener('input', estimate);
  $('visual-preset').addEventListener('click', () => {
    if (transmission) stopShow('Settings reset. Click show file to restart.');
    $('visual-density').value = 48; $('visual-speed').value = 15; $('visual-codes').value = 1; estimate();
  });
  estimate();
  $('stop-show').addEventListener('click', () => stopShow('stopped'));
  $('visual-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('visual-stage').requestFullscreen) await $('visual-stage').requestFullscreen();
      else status('show', 'Fullscreen is unavailable. Enlarge the browser window or zoom in.');
    } catch { status('show', 'Could not enter fullscreen. Enlarge the browser window or zoom in.'); }
  });
  document.addEventListener('fullscreenchange', () => { $('visual-fullscreen').textContent = document.fullscreenElement ? 'shrink' : 'expand'; });
  let packetState = null;
  function drawPacketMap() {
    if (!packetState) return;
    const strip = $('packet-strip'), canvas = $('packet-map'), width = strip.clientWidth;
    if (!width) return;
    const zoom = Number($('packet-zoom').value), scale = zoom || width / packetState.count;
    $('packet-spacer').style.width = `${Math.max(width, packetState.count * scale)}px`;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(28 * ratio); canvas.style.width = `${width}px`;
    const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    ctx.fillStyle = '#eeefe7'; ctx.fillRect(0, 0, width, 28);
    const offset = strip.scrollLeft, start = Math.max(0, Math.floor(offset / scale));
    const end = Math.min(packetState.count, Math.ceil((offset + width) / scale));
    if (scale < 1) {
      for (let x = 0; x < width; x++) {
        const lo = Math.floor((offset + x) / scale), hi = Math.min(packetState.count, Math.max(lo + 1, Math.floor((offset + x + 1) / scale)));
        let received = 0; for (let i = lo; i < hi; i++) received += packetState.seen[i];
        ctx.fillStyle = `rgba(83,114,68,${received / (hi - lo)})`; ctx.fillRect(x, 5, 1, 18);
      }
    } else {
      ctx.setLineDash([2, 2]); ctx.strokeStyle = '#b2baa8'; ctx.fillStyle = '#738866';
      const gap = scale >= 3 ? 1 : 0;
      for (let i = start; i < end; i++) {
        const x = i * scale - offset;
        if (packetState.seen[i]) ctx.fillRect(x, 5, scale - gap, 18);
        else if (scale >= 3) ctx.strokeRect(x + 0.5, 5.5, scale - gap - 1, 17);
      }
    }
    $('packet-range').textContent = `${start + 1}–${end} / ${packetState.count}`;
    canvas.setAttribute('aria-label', `${packetState.received} of ${packetState.count} packets received. Positions run left to right in file order; gaps are missing packets.`);
  }
  $('packet-strip').addEventListener('scroll', drawPacketMap);
  $('packet-strip').addEventListener('keydown', event => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      $('packet-strip').scrollLeft = event.key === 'Home' ? 0 : $('packet-strip').scrollWidth;
    }
  });
  $('packet-zoom').addEventListener('change', () => { $('packet-strip').scrollLeft = 0; drawPacketMap(); });
  window.addEventListener('resize', drawPacketMap);
  $('packet-map').addEventListener('mousemove', event => {
    if (!packetState) return;
    const strip = $('packet-strip'), scale = Number($('packet-zoom').value) || strip.clientWidth / packetState.count;
    const index = Math.min(packetState.count - 1, Math.floor((event.clientX - strip.getBoundingClientRect().left + strip.scrollLeft) / scale));
    $('packet-map').title = `Packet ${index + 1} / ${packetState.count}: ${packetState.seen[index] ? 'received' : 'missing'}`;
  });
  function stopScan(message = '') {
    const wasActive = !!stream || $('start-scan').disabled;
    scanGeneration++; cancelAnimationFrame(animation); animation = null;
    if (stream) stream.getTracks().forEach(track => track.stop()); stream = null;
    $('camera-video').srcObject = null;
    $('start-scan').disabled = false; $('stop-scan').hidden = true; $('camera-select').disabled = false;
    $('camera-idle').hidden = false; $('camera-idle').textContent = 'camera off'; $('camera-preview').hidden = true;
    if (!transmission) releaseWakeLock(); if (message || wasActive) status('scan', message || 'stopped');
  }
  async function cameras(currentId) {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      $('camera-select').replaceChildren(new Option('default camera', ''));
      devices.forEach((device, index) => $('camera-select').add(new Option(device.label || `camera ${index + 1}`, device.deviceId)));
      if (devices.some(device => device.deviceId === currentId)) $('camera-select').value = currentId;
    } catch { /* Capture still works if enumeration is unavailable. */ }
  }
  $('start-scan').addEventListener('click', async () => {
    if ($('start-scan').disabled) return;
    const generation = ++scanGeneration;
    $('start-scan').disabled = true; $('stop-scan').hidden = false; $('camera-select').disabled = true;
    $('visual-download').hidden = true; $('scan-progress-area').hidden = true; $('scan-meta').textContent = '';
    packetState = null; $('packet-strip').scrollLeft = 0;
    ReceivedPreview.clear('scan-image');
    if (downloadURL) URL.revokeObjectURL(downloadURL); downloadURL = null;
    status('scan', 'allow camera access…');
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('Camera access needs localhost or HTTPS and a browser with camera support.');
      const deviceId = $('camera-select').value;
      const capture = await navigator.mediaDevices.getUserMedia({audio: false, video: {
        ...(deviceId ? {deviceId: {exact: deviceId}} : {facingMode: {ideal: 'environment'}}),
        width: {ideal: 1280}, height: {ideal: 960}, frameRate: {ideal: 30}
      }});
      if (generation !== scanGeneration) { capture.getTracks().forEach(track => track.stop()); return; }
      stream = capture;
      const video = $('camera-video'); video.srcObject = stream; await video.play();
      if (generation !== scanGeneration) return;
      cameras(stream.getVideoTracks()[0].getSettings().deviceId);
      stream.getVideoTracks().forEach(track => { track.onended = () => { if (generation === scanGeneration) stopScan('Camera disconnected. Start again with an available camera.'); }; });
      $('camera-preview').hidden = false; $('camera-idle').hidden = true;
      status('scan', 'Looking for codes. Keep each code’s four corner markers visible.'); keepAwake();
      const canvas = $('camera-preview'), ctx = canvas.getContext('2d', {willReadFrequently: true});
      const receiver = new codec.Receiver();
      let previous = [], lastTime = 0, lastValid = 0, lastVideoTime = -1, lastSearch = -Infinity;
      function scan(now) {
        if (generation !== scanGeneration) return;
        animation = requestAnimationFrame(scan);
        if (now - lastTime < 28 || video.readyState < 2 || video.currentTime === lastVideoTime || document.hidden) return;
        lastTime = now; lastVideoTime = video.currentTime;
        const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
        if (!width || !height) return;
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        ctx.drawImage(video, 0, 0, width, height);
        try {
          const discover = now - lastSearch > 500;
          if (discover) lastSearch = now;
          const found = codec.decodeImages(ctx.getImageData(0, 0, width, height), previous, discover);
          previous = found.map(item => item.corners);
          for (const item of found) {
            ctx.strokeStyle = item.packet ? '#8de486' : '#eed67b'; ctx.lineWidth = 3; ctx.beginPath();
            item.outline.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke();
          }
          let updated = false, completed = null, otherTransfer = false;
          for (const item of found) {
            if (!item.packet) continue;
            const result = receiver.accept(item.packet);
            if (result.otherTransfer) { otherTransfer = true; continue; }
            lastValid = now; packetState = result; updated = true;
            if (result.bytes) { completed = result; break; }
          }
          if (updated) {
            const percent = Math.floor(packetState.received / packetState.count * 100);
            $('scan-progress-area').hidden = false; $('scan-percent').textContent = `${packetState.received} / ${packetState.count} packets · ${percent}%`;
            drawPacketMap();
            const visible = found.filter(item => item.packet).length;
            $('scan-meta').textContent = `${visible} ${visible === 1 ? 'code' : 'codes'} visible · corners locked`;
            status('scan', 'Receiving… filled marks are verified packets; gaps arrive on later loops.');
          } else if (otherTransfer) {
            status('scan', 'A different file is visible. Stop and start the camera to receive it.');
          } else if (now - lastValid > 1800) {
            status('scan', found.length ? 'Corners found. Hold steady, move closer, or lower the sender’s frame rate.' : 'Looking for corner markers. Keep the codes visible, move closer, and avoid glare.');
          }
          if (completed) {
            const blob = ReceivedPreview.blob(completed.bytes, completed.filename);
            downloadURL = URL.createObjectURL(blob);
            ReceivedPreview.show('scan-image', downloadURL, completed.filename, blob.type);
            $('visual-download').href = downloadURL; $('visual-download').download = completed.filename; $('visual-download').hidden = false;
            stopScan(); $('scan-meta').textContent = `${completed.filename} · ${size(completed.bytes.length)} · checksum verified`;
            status('scan', 'received', 'success');
          }
        } catch (error) {
          if (!receiver.transfer) { packetState = null; $('scan-progress-area').hidden = true; $('scan-meta').textContent = ''; }
          status('scan', error.message, 'error');
        }
      }
      animation = requestAnimationFrame(scan);
    } catch (error) {
      if (generation !== scanGeneration) return;
      stopScan();
      const messages = {NotAllowedError: 'Camera permission was denied. Allow access in browser settings and try again.', NotFoundError: 'No camera was found. Connect a camera and try again.', NotReadableError: 'The camera is unavailable. Check whether another app is using it.', OverconstrainedError: 'That camera is unavailable. Choose another camera and try again.'};
      status('scan', messages[error.name] || error.message || 'Unable to start the camera.', 'error');
    }
  });
  $('stop-scan').addEventListener('click', () => stopScan('stopped'));
  window.addEventListener('encaudier-tab', ({detail}) => {
    if (detail !== 'show') stopShow();
    if (detail !== 'scan') stopScan();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (transmission || $('visual-file').disabled)) stopShow('Paused because this page was hidden. Click show file to restart.');
    if (!document.hidden && (stream || transmission)) keepAwake();
  });
  window.addEventListener('pagehide', () => { ReceivedPreview.clear('scan-image'); stopShow(); stopScan(); if (downloadURL) URL.revokeObjectURL(downloadURL); });
})();
