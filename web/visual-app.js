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
  function draw(grid, density) {
    const canvas = $('visual-grid'), ctx = canvas.getContext('2d');
    const extent = density + codec.QUIET * 2;
    if (canvas.width !== extent * 12) canvas.width = canvas.height = extent * 12;
    const unit = canvas.width / extent;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
    for (let y = 0; y < density; y++) for (let x = 0; x < density; x++) {
      if (grid[y * density + x]) ctx.fillRect((x + codec.QUIET) * unit, (y + codec.QUIET) * unit, unit, unit);
    }
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
    draw(transmission.frame(frameIndex), transmission.density);
    const fps = Number($('visual-speed').value);
    $('show-meta').textContent = `frame ${frameIndex + 1} / ${transmission.count} · loop ${loops + 1} · ~${size(transmission.chunkSize * fps)}/s`;
    if (++frameIndex === transmission.count) { frameIndex = 0; loops++; }
    timer = setTimeout(nextFrame, 1000 / fps);
  }
  $('start-show').addEventListener('click', async () => {
    if (!file || transmission) return;
    const generation = ++showGeneration, selected = file;
    $('start-show').disabled = true; $('start-show').textContent = 'preparing…'; $('stop-show').hidden = false; $('visual-file').disabled = true;
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
    const density = Number($('visual-density').value), fps = Number($('visual-speed').value);
    codec.layout(density);
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw Error('Frame rate must be a whole number from 1 to 30 fps.');
    return {density, fps};
  }
  function estimate() {
    try {
      const {density, fps} = settings(), bytes = codec.layout(density).chunkSize;
      $('visual-estimate').textContent = `${density} × ${density} boxes · ${fps} fps · ~${size(bytes * fps)}/s before retries`;
      if (!transmission) { $('start-show').disabled = !file; status('show', ''); }
    } catch (error) { if (transmission) stopShow(); $('start-show').disabled = true; $('visual-estimate').textContent = ''; status('show', error.message, 'error'); }
  }
  for (const id of ['visual-density', 'visual-speed']) $(id).addEventListener('input', estimate);
  $('visual-preset').addEventListener('click', () => {
    if (transmission) stopShow('Settings reset. Click show file to restart.');
    $('visual-density').value = 48; $('visual-speed').value = 15; estimate();
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
      status('scan', 'Looking for four corner markers. Fill most of the preview with the sending screen.'); keepAwake();
      const canvas = $('camera-preview'), ctx = canvas.getContext('2d', {willReadFrequently: true});
      const receiver = new codec.Receiver();
      let previous = null, lastTime = 0, lastValid = 0, lastVideoTime = -1;
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
          const found = codec.decodeImage(ctx.getImageData(0, 0, width, height), previous);
          if (found) {
            previous = found.corners;
            ctx.strokeStyle = found.packet ? '#8de486' : '#eed67b'; ctx.lineWidth = 3; ctx.beginPath();
            found.outline.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke();
          } else previous = null;
          if (found?.packet) {
            lastValid = now;
            const result = receiver.accept(found.packet);
            if (result.otherTransfer) { status('scan', 'A different file is visible. Stop and start the camera to receive it.'); return; }
            const percent = Math.floor(result.received / result.count * 100);
            $('scan-progress-area').hidden = false; $('scan-progress').value = percent; $('scan-percent').textContent = `${percent}%`;
            $('scan-meta').textContent = `${result.received} / ${result.count} unique frames · ${found.density} × ${found.density} · corners locked`;
            status('scan', 'Receiving… keep the screen in view. Missed frames arrive on the next loop.');
            if (result.bytes) {
              downloadURL = URL.createObjectURL(new Blob([result.bytes], {type: 'application/octet-stream'}));
              $('visual-download').href = downloadURL; $('visual-download').download = result.filename; $('visual-download').hidden = false;
              stopScan(); $('scan-meta').textContent = `${result.filename} · ${size(result.bytes.length)} · checksum verified`;
              status('scan', 'received', 'success');
            }
          } else if (now - lastValid > 1800) {
            status('scan', found ? 'Corners found. Hold steady, move closer, or lower the sender’s frame rate.' : 'Looking for four corner markers. Keep the whole grid visible, move closer, and avoid glare.');
          }
        } catch (error) { status('scan', error.message, 'error'); }
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
  window.addEventListener('pagehide', () => { stopShow(); stopScan(); if (downloadURL) URL.revokeObjectURL(downloadURL); });
})();
