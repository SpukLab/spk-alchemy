/**
 * Alchemy — iPhone capture & exploration.
 *
 * The phone surface is a recorder, not an administrative tool. It shows
 * capture, exploration and materials. It deliberately does NOT show the
 * Knowledge Graph, Agents, full genealogy, DSP parameters or hashes: the
 * architecture records all of it, the interface just doesn't put it in the way.
 *
 * Everything runs locally. No server, no sync, no account.
 */
import { openLab } from './lab.js';

const $ = (id) => document.getElementById(id);
const state = {
  lab: null, capture: null, source: null, previews: [],
  tab: 'promoted', recorder: null, stream: null, startedAt: 0, timerId: 0,
};

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.id);
  toast.id = setTimeout(() => el.classList.remove('show'), 2200);
}

const mmss = (ms) => {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// ---- capture ---------------------------------------------------------------

async function startRecording() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    toast('Sin acceso al micrófono');
    return;
  }
  const { mimeType } = state.lab.recorderCapability;
  state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  state.recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  state.recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: state.recorder.mimeType || 'audio/mp4' });
    state.capture = { blob, url: URL.createObjectURL(blob) };
    $('capture-audio').src = state.capture.url;
    $('capture-review').hidden = false;
    for (const track of state.stream.getTracks()) track.stop();
  };
  state.recorder.start();
  state.startedAt = Date.now();
  $('record').textContent = 'Detener';
  $('record').classList.add('on');
  $('capture-review').hidden = true;
  meter(state.stream);
  state.timerId = setInterval(() => {
    $('timer').textContent = mmss(Date.now() - state.startedAt);
  }, 200);
}

function stopRecording() {
  state.recorder?.stop();
  clearInterval(state.timerId);
  cancelAnimationFrame(meter.raf);
  $('level').style.width = '0%';
  $('record').textContent = 'Grabar';
  $('record').classList.remove('on');
}

/** Simple level display so you can see the mic is alive. */
function meter(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
    $('level').style.width = `${Math.min(100, peak * 140)}%`;
    meter.raf = requestAnimationFrame(tick);
  };
  tick();
}

async function ingestCapture(blob, filename) {
  toast('Normalizando…');
  try {
    const material = await state.lab.ingest(await blob.arrayBuffer(), filename);
    state.capture = null;
    $('capture-review').hidden = true;
    $('timer').textContent = '0:00';
    selectSource(material);
    await renderMaterials();
    toast('Incorporado al inventario');
  } catch (err) {
    toast(`No se pudo incorporar: ${err.message}`);
  }
}

// ---- exploration -----------------------------------------------------------

function selectSource(material) {
  state.source = material;
  state.previews = [];
  $('previews').innerHTML = '';
  $('source').innerHTML = `
    <h3>${escapeHtml(material.attributes.filename || 'Material')}</h3>
    <div class="meta">${describe(material)}</div>`;
  $('explore').disabled = false;
}

async function runExploration() {
  if (!state.source) return;
  $('explore').disabled = true;
  $('explore').textContent = 'Explorando…';
  try {
    const question = $('intent').value.trim() || 'Exploración libre';
    const set = await state.lab.explore(state.source.id, question, 8);
    state.previews = set.variations;
    renderPreviews();
    toast(`${set.variations.length} variaciones`);
  } catch (err) {
    toast(`Error: ${err.message}`);
  } finally {
    $('explore').disabled = false;
    $('explore').textContent = 'Explorar';
  }
}

function renderPreviews() {
  const host = $('previews');
  host.innerHTML = '';
  state.previews.forEach((v, i) => {
    const url = URL.createObjectURL(new Blob([v.preview.bytes], { type: 'audio/wav' }));
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3>Variación ${i + 1}</h3>
      <div class="meta">${(v.preview.bytes.byteLength / 1024).toFixed(0)} KB</div>
      <audio controls playsinline preload="none" src="${url}"></audio>
      <div class="acts">
        <button class="keep" data-keep="${i}">Conservar</button>
        <button class="drop" data-drop="${i}">Descartar</button>
      </div>`;
    host.appendChild(card);
  });
}

async function keepPreview(index) {
  const v = state.previews[index];
  if (!v) return;
  try {
    const material = await state.lab.retain(v.preview);
    state.previews.splice(index, 1);   // siblings are untouched runtime state
    renderPreviews();
    await renderMaterials();
    toast('Retenido');
    return material;
  } catch (err) {
    toast(`Error: ${err.message}`);
  }
}

function dropPreview(index) {
  // Discard: runtime state simply disappears. Nothing canonical is written.
  state.previews.splice(index, 1);
  renderPreviews();
  toast('Descartado');
}

// ---- materials -------------------------------------------------------------

function describe(material) {
  const a = material.attributes || {};
  if (a.origin === 'exploration') return `variación · seed ${a.seed}`;
  const seconds = a.durationSeconds ? `${Number(a.durationSeconds).toFixed(1)}s · ` : '';
  return `${seconds}captura`;
}

async function renderMaterials() {
  const host = $('materials');
  const items = await state.lab.materials(state.tab);
  if (items.length === 0) {
    host.innerHTML = `<div class="empty">Nada aquí todavía</div>`;
    return;
  }
  host.innerHTML = '';
  for (const m of items) {
    const card = document.createElement('div');
    card.className = 'card' + (state.source?.id === m.id ? ' sel' : '');
    const actions = state.tab === 'retained'
      ? `<button class="keep" data-promote="${m.id}">Promover</button>
         <button class="drop" data-reject="${m.id}">Rechazar</button>`
      : state.tab === 'promoted'
        ? `<button data-use="${m.id}">Explorar</button>
           <button class="drop" data-reject="${m.id}">Rechazar</button>`
        : `<button class="keep" data-promote="${m.id}">Recuperar</button>`;
    card.innerHTML = `
      <h3>${escapeHtml(m.attributes.filename || 'Material')}</h3>
      <div class="meta">${describe(m)}</div>
      <div class="acts">${actions}</div>`;
    host.appendChild(card);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- wiring ----------------------------------------------------------------

function wire() {
  $('record').onclick = () => (state.recorder?.state === 'recording'
    ? stopRecording() : startRecording());
  $('retake').onclick = () => {
    state.capture = null;
    $('capture-review').hidden = true;
    $('timer').textContent = '0:00';
  };
  $('ingest').onclick = () => state.capture
    && ingestCapture(state.capture.blob, `captura-${new Date().toISOString().slice(0, 19)}.wav`);
  $('import').onclick = () => $('file').click();
  $('file').onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) ingestCapture(file, file.name);
    e.target.value = '';
  };
  $('explore').onclick = runExploration;

  $('previews').onclick = (e) => {
    const keep = e.target.dataset?.keep;
    const drop = e.target.dataset?.drop;
    if (keep !== undefined) keepPreview(Number(keep));
    if (drop !== undefined) dropPreview(Number(drop));
  };

  $('materials').onclick = async (e) => {
    const d = e.target.dataset || {};
    if (d.promote) { await state.lab.promote(d.promote); toast('Promovido'); }
    if (d.reject) { await state.lab.reject(d.reject); toast('Rechazado'); }
    if (d.use) {
      const m = await state.lab.material(d.use);
      if (m) { selectSource(m); $('explore-section').scrollIntoView({ behavior: 'smooth' }); }
    }
    await renderMaterials();
  };

  for (const tab of document.querySelectorAll('[role=tab]')) {
    tab.onclick = async () => {
      for (const t of document.querySelectorAll('[role=tab]')) {
        t.setAttribute('aria-selected', String(t === tab));
      }
      state.tab = tab.dataset.tab;
      await renderMaterials();
    };
  }
}

async function boot() {
  try {
    state.lab = await openLab();
    const { mimeType, lossless } = state.lab.recorderCapability;
    $('capability').textContent = mimeType
      ? `Grabación: ${mimeType}${lossless ? ' · sin pérdida' : ''}`
      : 'Grabación: formato por defecto del dispositivo';
    $('status').textContent = 'local · offline';
    wire();
    await renderMaterials();
  } catch (err) {
    $('status').textContent = 'error';
    toast(`No se pudo abrir el laboratorio: ${err.message}`);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}

boot();
