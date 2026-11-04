(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const MAX_WAV = 512 * 1024 * 1024;
  let selectedFile = null, encoder = null, wavURL = null, receivedURL = null;
  let mic = null, micGeneration = 0;
  const formatSize = size => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MiB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${size} B`;
  const formatTime = seconds => seconds >= 60 ? `${Math.floor(Math.round(seconds) / 60)}:${String(Math.round(seconds) % 60).padStart(2, '0')}` : `${seconds.toFixed(2)} s`;
  function status(mode, message, kind = '') {
    const element = $(`${mode}-status`); element.textContent = message; element.className = `status ${kind}`;
  }
  function settings(mode, rate = 48000) {
    const bitrate = Number($(`${mode}-bitrate`).value), frequency = Number($(`${mode}-frequency`).value);
    if (!Number.isInteger(bitrate) || bitrate < 1 || bitrate > 9600) throw Error('Choose a whole-number bitrate from 1 to 9,600.');
    if (!Number.isFinite(frequency) || frequency <= 0 || frequency >= rate / 2) throw Error(`Choose a carrier above 0 and below ${rate / 2} Hz.`);
    return {bitrate, frequency};
  }
  function progress(mode, percent) {
    $(`${mode}-progress-area`).hidden = false;
    $(`${mode}-progress`).value = percent; $(`${mode}-percent`).textContent = `${percent}%`;
  }
  function worker(handler, errorHandler) {
    const url = URL.createObjectURL(new Blob([$('worker-source').textContent], {type: 'text/javascript'}));
    let instance;
    try { instance = new Worker(url); } catch (error) { URL.revokeObjectURL(url); throw error; }
    instance.onmessage = ({data}) => handler(data);
    instance.onerror = event => errorHandler(event.message || 'The audio worker could not run.');
    return {instance, close() { instance.terminate(); URL.revokeObjectURL(url); }};
  }
  function canvasBase(canvas) {
    const ctx = canvas.getContext('2d'), {width, height} = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = '#39433a'; ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += width / 12) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = height / 4; y < height; y += height / 4) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    return ctx;
  }
  function idleWave(canvas) {
    const ctx = canvasBase(canvas); ctx.strokeStyle = '#879678'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
  }
  function wavWave(buffer) {
    const canvas = $('encode-wave'), ctx = canvasBase(canvas), view = new DataView(buffer);
    const count = (buffer.byteLength - 44) / 2, columns = 200;
    ctx.strokeStyle = '#c4ccba'; ctx.lineWidth = 2;
    for (let x = 0; x < columns; x++) {
      let peak = 0;
      for (let k = 0; k < 32; k++) {
        const sample = Math.min(count - 1, Math.floor((x + k / 32) * count / columns));
        peak = Math.max(peak, Math.abs(view.getInt16(44 + sample * 2, true)) / 32768);
      }
      const height = Math.max(1, peak * canvas.height * 0.8);
      ctx.beginPath(); ctx.moveTo(x * canvas.width / columns, canvas.height / 2 - height);
      ctx.lineTo(x * canvas.width / columns, canvas.height / 2 + height); ctx.stroke();
    }
  }
  function liveWave(samples) {
    const canvas = $('decode-wave'), ctx = canvasBase(canvas); ctx.strokeStyle = '#c4ccba'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < canvas.width; x++) {
      const value = samples[Math.floor(x * samples.length / canvas.width)];
      const y = canvas.height / 2 - value * canvas.height * 0.45;
      if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  function clearWav() {
    $('encode-output').hidden = true;
    $('player').pause(); $('player').removeAttribute('src'); $('player').load(); $('player').hidden = true;
    $('wav-download').hidden = true; $('wav-download').removeAttribute('href');
    $('encode-empty').hidden = false;
    $('wav-duration').textContent = $('wav-size').textContent = $('wave-end').textContent = '—';
    if (wavURL) URL.revokeObjectURL(wavURL); wavURL = null;
    idleWave($('encode-wave'));
  }
  function lock(mode, locked) {
    $(`${mode}-bitrate`).disabled = $(`${mode}-frequency`).disabled = $(`${mode}-preset`).disabled = locked;
  }
  function estimate() {
    $('generate').disabled = !selectedFile || !!encoder;
    if (!selectedFile) return;
    try {
      const {bitrate} = settings('encode');
      const seconds = (Math.max(8, Math.ceil(bitrate / 8)) + selectedFile.size + new TextEncoder().encode(selectedFile.name).length + 14) * 8 / bitrate;
      const size = 44 + Math.round(seconds * 48000) * 2;
      $('encode-estimate').textContent = `${formatTime(seconds)} · ${formatSize(size)}`;
      if (size > MAX_WAV) throw Error('WAV exceeds 512 MiB. Increase the bitrate or use a smaller file.');
      if (!encoder) status('encode', '');
    } catch (error) { $('generate').disabled = true; status('encode', error.message, 'error'); }
  }
  function stopEncoding() {
    if (encoder) encoder.close(); encoder = null; lock('encode', false);
    $('cancel-encode').hidden = true; $('generate').textContent = '→'; estimate();
  }
  function chooseFile(file) {
    if (!file) return;
    if (encoder) stopEncoding(); clearWav(); selectedFile = file;
    $('file-name').textContent = file.name; $('file-detail').textContent = formatSize(file.size);
    $('choose-label').textContent = 'choose a different file'; $('encode-progress-area').hidden = true; estimate();
  }
  $('file-input').addEventListener('change', event => chooseFile(event.target.files[0]));
  $('dropzone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file-input').click(); } });
  $('dropzone').addEventListener('dragover', event => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
  $('dropzone').addEventListener('dragleave', event => { if (!$('dropzone').contains(event.relatedTarget)) $('dropzone').classList.remove('dragover'); });
  $('dropzone').addEventListener('drop', event => {
    event.preventDefault(); $('dropzone').classList.remove('dragover');
    if (event.dataTransfer.files.length !== 1) { status('encode', 'Choose one file at a time.', 'error'); return; }
    chooseFile(event.dataTransfer.files[0]);
  });
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());
  for (const mode of ['encode', 'decode']) {
    for (const field of ['bitrate', 'frequency']) $(`${mode}-${field}`).addEventListener('input', () => {
      if (mode === 'encode') { clearWav(); $('encode-progress-area').hidden = true; estimate(); }
    });
    $(`${mode}-preset`).addEventListener('click', () => {
      $(`${mode}-bitrate`).value = 9600; $(`${mode}-frequency`).value = 12000;
      if (mode === 'encode') { clearWav(); $('encode-progress-area').hidden = true; estimate(); }
    });
  }
  $('generate').addEventListener('click', () => {
    if (!selectedFile || encoder) return;
    try {
      const config = settings('encode'); clearWav(); lock('encode', true);
      $('generate').disabled = true; $('generate').textContent = '…'; $('cancel-encode').hidden = false;
      progress('encode', 0); status('encode', '');
      encoder = worker(message => {
        if (message.type === 'encode-progress') progress('encode', Math.min(99, message.percent));
        else if (message.type === 'error') { stopEncoding(); status('encode', message.message, 'error'); }
        else if (message.type === 'encoded') {
          $('encode-output').hidden = false;
          wavWave(message.buffer);
          wavURL = URL.createObjectURL(new Blob([message.buffer], {type: 'audio/wav'}));
          $('player').src = wavURL; $('player').hidden = false; $('encode-empty').hidden = true;
          $('wav-download').href = wavURL; $('wav-download').download = `${selectedFile.name}.wav`; $('wav-download').hidden = false;
          $('wav-duration').textContent = formatTime(message.duration); $('wave-end').textContent = formatTime(message.duration);
          $('wav-size').textContent = formatSize(message.buffer.byteLength);
          stopEncoding(); progress('encode', 100); status('encode', '', 'success');
        }
      }, message => { stopEncoding(); status('encode', message, 'error'); });
      encoder.instance.postMessage({type: 'encode', file: selectedFile, ...config});
    } catch (error) { stopEncoding(); status('encode', error.message, 'error'); }
  });
  $('cancel-encode').addEventListener('click', () => { stopEncoding(); $('encode-progress-area').hidden = true; status('encode', 'cancelled'); });
  function stopMic() {
    micGeneration++;
    const current = mic; mic = null;
    if (current) {
      current.stream?.getTracks().forEach(track => track.stop());
      current.node?.disconnect(); current.source?.disconnect(); current.worker?.close();
      current.context?.close().catch(() => {});
    }
    lock('decode', false); $('start-listening').disabled = false; $('stop-listening').hidden = true;
    $('mic-state').classList.remove('live'); $('mic-label').textContent = 'Microphone off'; $('receive-tag').textContent = 'MIC OFF';
  }
  function micError(message) { stopMic(); status('decode', message, 'error'); }
  const workletSource = `class Capture extends AudioWorkletProcessor {
    constructor() { super(); this.buffer = new Float32Array(4096); this.used = 0; }
    process(inputs, outputs) {
      for (const output of outputs) for (const channel of output) channel.fill(0);
      const channel = inputs[0]?.[0];
      if (channel) for (const sample of channel) {
        this.buffer[this.used++] = sample;
        if (this.used === this.buffer.length) { this.port.postMessage(this.buffer, [this.buffer.buffer]); this.buffer = new Float32Array(4096); this.used = 0; }
      }
      return true;
    }
  } registerProcessor('encaudier-capture', Capture);`;
  $('start-listening').addEventListener('click', async () => {
    if (mic) return;
    const generation = ++micGeneration;
    try {
      const config = settings('decode');
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.isSecureContext) throw Error('Microphone access needs localhost or HTTPS and a browser with Web Audio support.');
      $('player').pause();
      mic = {context: new AudioContext({sampleRate: 48000}), pending: 0};
      const current = mic;
      lock('decode', true); $('start-listening').disabled = true; $('stop-listening').hidden = false;
      $('decode-output').hidden = true;
      $('decode-progress-area').hidden = true; $('received-size').textContent = '—'; $('received-crc').textContent = '—';
      $('file-download').hidden = true; $('decode-empty').hidden = false;
      if (receivedURL) URL.revokeObjectURL(receivedURL); receivedURL = null;
      status('decode', 'allow microphone access…');
      await current.context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
      if (generation !== micGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream = stream;
      settings('decode', current.context.sampleRate);
      if (!current.context.audioWorklet) throw Error('This browser does not support audio worklets. Try a current Chrome, Edge, Firefox, or Safari.');
      const moduleURL = URL.createObjectURL(new Blob([workletSource], {type: 'text/javascript'}));
      try { await current.context.audioWorklet.addModule(moduleURL); } finally { URL.revokeObjectURL(moduleURL); }
      if (generation !== micGeneration) return;
      current.worker = worker(message => {
        if (generation !== micGeneration) return;
        if (message.type === 'audio-ack') current.pending = Math.max(0, current.pending - 1);
        else if (message.type === 'error') micError(message.message);
        else if (message.type === 'listening') status('decode', 'listening…');
        else if (message.type === 'receive-start') { $('receive-tag').textContent = 'SIGNAL'; status('decode', 'receiving…'); }
        else if (message.type === 'receive-header') { $('received-size').textContent = formatSize(message.size); $('received-crc').textContent = '…'; progress('decode', 0); status('decode', `receiving ${formatSize(message.size)}…`); }
        else if (message.type === 'receive-progress') progress('decode', message.percent);
        else if (message.type === 'receive-reset') { $('decode-progress-area').hidden = true; $('received-size').textContent = '—'; $('received-crc').textContent = '—'; $('receive-tag').textContent = 'LIVE'; status('decode', message.message); }
        else if (message.type === 'decoded') {
          receivedURL = URL.createObjectURL(new Blob([message.buffer], {type: 'application/octet-stream'}));
          $('file-download').download = message.filename || 'received.bin';
          $('file-download').href = receivedURL; $('file-download').hidden = false; $('decode-empty').hidden = true;
          $('received-size').textContent = formatSize(message.size); $('received-crc').textContent = '✓';
          stopMic(); $('receive-tag').textContent = 'RECEIVED'; progress('decode', 100);
          status('decode', 'received', 'success');
        }
      }, micError);
      current.worker.instance.postMessage({type: 'decode-start', ...config, sampleRate: current.context.sampleRate});
      current.node = new AudioWorkletNode(current.context, 'encaudier-capture', {numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]});
      current.node.port.onmessage = ({data: samples}) => {
        if (generation !== micGeneration) return;
        if (++current.pending > 32) { micError('Audio processing fell behind. Try again with a lower bitrate.'); return; }
        liveWave(samples); current.worker.instance.postMessage({type: 'audio', samples}, [samples.buffer]);
      };
      current.source = current.context.createMediaStreamSource(stream); current.source.connect(current.node); current.node.connect(current.context.destination);
      stream.getTracks().forEach(track => { track.onended = () => { if (generation === micGeneration) micError('Microphone disconnected. Choose an available input and try again.'); }; });
      $('decode-output').hidden = false;
      $('mic-state').classList.add('live'); $('mic-label').textContent = 'Microphone listening'; $('receive-tag').textContent = 'LIVE'; $('input-rate').textContent = `${current.context.sampleRate / 1000} kHz`;
    } catch (error) {
      if (generation !== micGeneration) return;
      const messages = {NotAllowedError: 'Microphone permission was denied. Allow access in your browser settings and try again.', NotFoundError: 'No microphone was found. Connect an input device and try again.', NotReadableError: 'The microphone is unavailable. Check whether another app is using it.'};
      micError(messages[error.name] || error.message || 'Unable to start the microphone.');
    }
  });
  $('stop-listening').addEventListener('click', () => { stopMic(); status('decode', 'stopped'); });
  function activateTab(mode) {
    for (const name of ['encode', 'decode']) {
      const selected = name === mode; $(`${name}-tab`).setAttribute('aria-selected', String(selected)); $(`${name}-tab`).tabIndex = selected ? 0 : -1; $(`${name}-panel`).hidden = !selected;
    }
    $('player').pause();
    if (mode === 'encode' && mic) { stopMic(); status('decode', ''); }
  }
  for (const mode of ['encode', 'decode']) {
    $(`${mode}-tab`).addEventListener('click', () => activateTab(mode));
    $(`${mode}-tab`).addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 'encode' : event.key === 'End' ? 'decode' : mode === 'encode' ? 'decode' : 'encode';
        activateTab(next); $(`${next}-tab`).focus();
      }
    });
  }
  window.addEventListener('pagehide', () => { stopMic(); encoder?.close(); if (wavURL) URL.revokeObjectURL(wavURL); if (receivedURL) URL.revokeObjectURL(receivedURL); });
  idleWave($('encode-wave')); idleWave($('decode-wave'));
})();
