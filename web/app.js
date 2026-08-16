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
import { DnaPackExportController } from './export-orchestrator.js';

const $ = (id) => document.getElementById(id);
const state = {
  lab: null, capture: null, source: null, previews: [],
  tab: 'promoted', recorder: null, stream: null, startedAt: 0, timerId: 0,
  curating: false, selected: new Set(),
  openFamilyId: null, playingMaterialId: null, playbackAudio: null,
  pickerSelected: new Set(),
  exploreMode: 'quick', mesaObservations: [],
};

/**
 * One controller for the app session. It is the ONLY place that calls
 * navigator.share, the ONLY place that calls the download anchor, and the
 * ONLY place that decides whether Publish and Share are mutually exclusive —
 * see src/web/export-orchestrator.ts for why this exists.
 */
const exportController = new DnaPackExportController({
  download: (filename, bytes, mime) => downloadBlob(filename, bytes, mime),
  share: async (filename, bytes, mime) => {
    try {
      await navigator.share({ files: [new File([bytes], filename, { type: mime })], title: filename });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      throw err;
    }
  },
  canShareFiles: (filename, bytes, mime) => {
    if (!navigator.share || !navigator.canShare) return false;
    try { return navigator.canShare({ files: [new File([bytes], filename, { type: mime })] }); }
    catch { return false; }
  },
});

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

/**
 * Importing an existing file (WAV, AIFF, M4A…) is a different path from a
 * microphone capture: the bytes are of unknown origin, so decoding is the only
 * gate. A file that cannot be decoded shows a specific error naming the file
 * and leaves the current session untouched — no partial material is created.
 */
async function importFile(file) {
  toast(`Leyendo ${file.name}…`);
  try {
    const material = await state.lab.importFile(await file.arrayBuffer(), file.name);
    selectSource(material);
    await renderMaterials();
    toast('Incorporado al inventario');
  } catch (err) {
    toast(err.message || `No se pudo importar ${file.name}`);
  }
}

// ---- exploration -----------------------------------------------------------

function selectSource(material) {
  state.source = material;
  state.previews = [];
  state.mesaObservations = [];
  $('previews').innerHTML = '';
  $('mesa-results').innerHTML = '';
  $('source').innerHTML = `
    <h3>${escapeHtml(material.attributes.filename || 'Material')}</h3>
    <div class="meta">${describe(material)}</div>`;
  $('explore').disabled = false;
  $('mesa-explore').disabled = false;
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

// ---- Mesa ---------------------------------------------------------------

const MESA_SLIDER_IDS = [
  ['mesa-fragmentar-escala', 'fragmentar', 'escala'],
  ['mesa-fragmentar-desorden', 'fragmentar', 'desorden'],
  ['mesa-acelerar-tiempo', 'acelerar', 'tiempo'],
  ['mesa-acelerar-movimiento', 'acelerar', 'movimiento'],
  ['mesa-microscopio-zoom', 'microscopio', 'zoom'],
  ['mesa-microscopio-persistencia', 'microscopio', 'persistencia'],
  ['mesa-excitar-energia', 'excitar', 'energia'],
  ['mesa-excitar-estabilidad', 'excitar', 'estabilidad'],
];

function initMesaSliders() {
  const defaults = state.lab.defaultMesaState;
  for (const [id, tool, control] of MESA_SLIDER_IDS) {
    const el = $(id);
    if (el) el.value = String(defaults[tool][control]);
  }
}

function readMesaState() {
  const s = { fragmentar: {}, acelerar: {}, microscopio: {}, excitar: {} };
  for (const [id, tool, control] of MESA_SLIDER_IDS) {
    s[tool][control] = Number($(id).value);
  }
  return s;
}

async function runMesaExplorationUI() {
  if (!state.source) return;
  $('mesa-explore').disabled = true;
  $('mesa-explore').textContent = 'Explorando…';
  try {
    const question = $('mesa-intent').value.trim() || 'Exploración libre';
    const mesaState = readMesaState();
    const set = await state.lab.exploreMesa(state.source.id, question, mesaState);
    state.mesaObservations = set.variations;
    renderMesaResults();
    toast(`${set.variations.length} observaciones`);
  } catch (err) {
    toast(`Error: ${err.message}`);
  } finally {
    $('mesa-explore').disabled = false;
    $('mesa-explore').textContent = 'Explorar';
  }
}

function renderMesaResults() {
  const host = $('mesa-results');
  host.innerHTML = '';
  const groups = [
    ['medium', 'Medias'],
    ['unexpected', 'Inesperadas'],
  ];
  for (const [territory, label] of groups) {
    const items = state.mesaObservations
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v.territory === territory);
    if (items.length === 0) continue;
    const group = document.createElement('div');
    group.className = 'territory-group';
    group.innerHTML = `<h3>${label}</h3>`;
    items.forEach(({ v, i }, position) => {
      const playing = state.playingMaterialId === `mesa:${i}`;
      const card = document.createElement('div');
      card.className = 'obs-card';
      card.innerHTML = `
        <button class="play-btn" data-mesa-play="${i}" aria-label="Reproducir">${playing ? '⏸' : '▶'}</button>
        <div class="obs-info">
          <h4>${label.slice(0, -1)} ${position + 1}</h4>
          <div class="meta">${(v.preview.bytes.byteLength / 1024).toFixed(0)} KB</div>
        </div>
        <div class="obs-acts">
          <button class="keep" data-mesa-keep="${i}">Conservar</button>
          <button class="drop" data-mesa-drop="${i}">Descartar</button>
        </div>`;
      group.appendChild(card);
    });
    host.appendChild(group);
  }
}

async function playMesaObservation(index) {
  const obs = state.mesaObservations[index];
  if (!obs) return;
  if (state.playingMaterialId === `mesa:${index}`) { stopPlayback(); renderMesaResults(); return; }
  stopPlayback();
  const url = URL.createObjectURL(new Blob([obs.preview.bytes], { type: 'audio/wav' }));
  const audio = new Audio(url);
  audio.play();
  audio.onended = () => { stopPlayback(); renderMesaResults(); };
  state.playbackAudio = audio;
  state.playingMaterialId = `mesa:${index}`;
}

async function keepMesaObservation(index) {
  const obs = state.mesaObservations[index];
  if (!obs) return;
  try {
    await state.lab.retain(obs.preview);
    state.mesaObservations.splice(index, 1);
    renderMesaResults();
    await renderMaterials();
    toast('Retenido');
  } catch (err) {
    toast(`Error: ${err.message}`);
  }
}

function dropMesaObservation(index) {
  state.mesaObservations.splice(index, 1);
  renderMesaResults();
  toast('Descartado');
}

function setExploreMode(mode) {
  state.exploreMode = mode;
  $('quick-explore-panel').hidden = mode !== 'quick';
  $('mesa-panel').hidden = mode !== 'mesa';
  for (const tab of document.querySelectorAll('#explore-mode-tabs [role=tab]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  }
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
    updateCreateFamilyBar();
    return;
  }
  // Fetch lineage colors in parallel: each is a small bounded ancestors query,
  // never a canonical write, never dependent on lifecycle or Family state.
  const colors = await Promise.all(items.map((m) => state.lab.lineageColor(m.id)));

  host.innerHTML = '';
  const curatingHere = state.curating && state.tab === 'promoted';
  items.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'card' + (state.source?.id === m.id ? ' sel' : '');
    const playing = state.playingMaterialId === m.id;
    // Play is always its own button, outside any <label>, so tapping it can
    // never also toggle the selection checkbox in curating mode.
    const playButton = `<button class="play-btn" data-play="${m.id}" aria-label="Reproducir">${playing ? '⏸' : '▶'}</button>`;
    const dot = `<span class="lineage-dot" style="background:${colors[i]}" aria-hidden="true"></span>`;

    if (curatingHere) {
      const checked = state.selected.has(m.id) ? 'checked' : '';
      card.innerHTML = `
        <div class="pick-row">
          ${playButton}
          <label class="pick">
            <input type="checkbox" data-select="${m.id}" ${checked}>
            <span style="flex:1">
              <h3 style="margin:0">${dot}${escapeHtml(m.attributes.filename || 'Material')}</h3>
              <div class="meta">${describe(m)}</div>
            </span>
          </label>
        </div>`;
      host.appendChild(card);
      return;
    }
    const actions = state.tab === 'retained'
      ? `<button class="keep" data-promote="${m.id}">Promover</button>
         <button class="drop" data-reject="${m.id}">Rechazar</button>`
      : state.tab === 'promoted'
        ? `<button data-use="${m.id}">Explorar</button>
           <button class="drop" data-reject="${m.id}">Rechazar</button>`
        : `<button class="keep" data-promote="${m.id}">Recuperar</button>`;
    card.innerHTML = `
      <div class="pick-row">
        ${playButton}
        <span style="flex:1;min-width:0">
          <h3>${dot}${escapeHtml(m.attributes.filename || 'Material')}</h3>
          <div class="meta">${describe(m)}</div>
        </span>
      </div>
      <div class="acts">${actions}</div>`;
    host.appendChild(card);
  });
  updateCreateFamilyBar();
}

function updateCreateFamilyBar() {
  const bar = $('create-family-bar');
  if (!state.curating || state.tab !== 'promoted' || state.selected.size === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.textContent = `Crear Family (${state.selected.size})`;
}

// ---- Families ---------------------------------------------------------------

async function renderFamilies() {
  const host = $('families');
  const items = await state.lab.listFamilies();
  if (items.length === 0) {
    host.innerHTML = `<div class="empty">Todavía no hay families</div>`;
    return;
  }
  host.innerHTML = '';
  for (const f of items) {
    const members = await state.lab.familyMembers(f.id);
    const packCount = await state.lab.familyPackCount(f.id);
    const card = document.createElement('div');
    card.className = 'fam-card';
    card.innerHTML = `
      <div class="info">
        <h3>${escapeHtml(f.attributes.name)}</h3>
        <div class="meta">${members.length} miembro${members.length === 1 ? '' : 's'}` +
          `${packCount > 0 ? ` · ${packCount} pack${packCount === 1 ? '' : 's'}` : ''}</div>
      </div>
      <button data-open-family="${f.id}">Abrir</button>`;
    host.appendChild(card);
  }
}

async function openFamily(familyId) {
  state.openFamilyId = familyId;
  stopPlayback();
  exportController.reset(); // no stale shareable artifact from a previous Family
  $('family-share-row').hidden = true;
  $('family-detail').hidden = false;
  await renderFamilyDetail();
}

function closeFamily() {
  stopPlayback();
  exportController.reset();
  $('family-share-row').hidden = true;
  state.openFamilyId = null;
  $('family-detail').hidden = true;
}

async function renderFamilyDetail() {
  const family = await state.lab.listFamilies().then((fs) => fs.find((f) => f.id === state.openFamilyId));
  if (!family) { closeFamily(); return; }
  $('family-detail-name').textContent = family.attributes.name;
  const members = await state.lab.familyMembers(family.id);
  $('family-detail-meta').textContent =
    `${members.length} miembro${members.length === 1 ? '' : 's'}` +
    (family.attributes.note ? ` · ${family.attributes.note}` : '');

  const host = $('family-members');
  if (members.length === 0) {
    host.innerHTML = `<div class="empty">Sin miembros — agregá materiales</div>`;
    return;
  }
  const materials = await Promise.all(members.map((m) => state.lab.material(m.materialId)));
  const colors = await Promise.all(members.map((m) => state.lab.lineageColor(m.materialId)));
  host.innerHTML = '';
  members.forEach((member, index) => {
    const material = materials[index];
    const row = document.createElement('div');
    row.className = 'member' + (state.playingMaterialId === member.materialId ? ' playing' : '');
    row.innerHTML = `
      <div class="info">
        <h3><span class="lineage-dot" style="background:${colors[index]}" aria-hidden="true"></span>${escapeHtml(material?.attributes.filename || 'Material')}</h3>
      </div>
      <div class="ctl">
        <button data-play-member="${member.materialId}">${state.playingMaterialId === member.materialId ? '⏸' : '▶'}</button>
        <button data-up="${member.materialId}" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button data-down="${member.materialId}" ${index === members.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-remove-member="${member.materialId}">✕</button>
      </div>`;
    host.appendChild(row);
  });
}

function stopPlayback() {
  state.playbackAudio?.pause();
  state.playbackAudio = null;
  state.playingMaterialId = null;
}

/** Re-renders whichever playback-aware view is currently visible. */
async function refreshPlaybackViews() {
  if (!$('family-detail').hidden) await renderFamilyDetail();
  else await renderMaterials();
}

/**
 * One shared player for both the Materials list and the Family screen — see
 * "reuse existing audio playback infrastructure" in the brief. Only one
 * Material plays at a time: starting B always stops A first.
 */
async function togglePlayMaterial(materialId) {
  if (state.playingMaterialId === materialId) { stopPlayback(); await refreshPlaybackViews(); return; }
  stopPlayback();
  const material = await state.lab.material(materialId);
  const bytes = material && await state.lab.audioFor(material);
  if (!bytes) { toast('No se pudo reproducir'); return; }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const audio = new Audio(url);
  audio.play();
  audio.onended = async () => { stopPlayback(); await refreshPlaybackViews(); };
  state.playbackAudio = audio;
  state.playingMaterialId = materialId;
  await refreshPlaybackViews();
}
// Kept as an alias so the Family-screen call sites read naturally.
const playMember = togglePlayMaterial;

async function moveMember(materialId, direction) {
  const members = await state.lab.familyMembers(state.openFamilyId);
  const ids = members.map((m) => m.materialId);
  const i = ids.indexOf(materialId);
  const j = i + direction;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await state.lab.reorderFamily(state.openFamilyId, ids);
  await renderFamilyDetail();
}

async function removeMember(materialId) {
  await state.lab.removeFamilyMember(state.openFamilyId, materialId);
  stopPlayback();
  await renderFamilyDetail();
  await renderFamilies();
}

async function openMaterialPicker() {
  state.pickerSelected = new Set();
  $('material-picker').hidden = false;
  await renderPicker();
}

async function renderPicker() {
  const host = $('picker-list');
  const existing = new Set((await state.lab.familyMembers(state.openFamilyId)).map((m) => m.materialId));
  const promoted = await state.lab.materials('promoted');
  const candidates = promoted.filter((m) => !existing.has(m.id));
  if (candidates.length === 0) {
    host.innerHTML = `<div class="empty">No hay materiales promovidos disponibles</div>`;
    return;
  }
  host.innerHTML = '';
  for (const m of candidates) {
    const card = document.createElement('div');
    card.className = 'card pick';
    const checked = state.pickerSelected.has(m.id) ? 'checked' : '';
    card.innerHTML = `
      <label class="pick" style="display:flex;align-items:center;gap:10px;width:100%">
        <input type="checkbox" data-pick="${m.id}" ${checked}>
        <span style="flex:1">
          <h3 style="margin:0">${escapeHtml(m.attributes.filename || 'Material')}</h3>
          <div class="meta">${describe(m)}</div>
        </span>
      </label>`;
    host.appendChild(card);
  }
}

async function publishFamily() {
  // Single-flight guard: a duplicate tap while the first press is still in
  // flight is ignored outright, not queued — see export-orchestrator.ts.
  if (exportController.isPublishing()) return;
  $('family-publish').disabled = true;
  toast('Publicando…');
  try {
    const familyId = state.openFamilyId;
    // publishAndDownload calls the canonical publish action exactly once and
    // performs exactly one download. It never calls navigator.share.
    const artifact = await exportController.publishAndDownload(
      familyId, () => state.lab.publishFamily(familyId));
    if (!artifact) return; // a publish was already in flight; nothing to do
    await renderFamilies();
    updateShareAvailability();
    toast(`DNA Pack v${artifact.manifest.packVersion} descargado`);
  } catch (err) {
    toast(`No se pudo publicar: ${err.message}`);
  } finally {
    $('family-publish').disabled = false;
  }
}

function updateShareAvailability() {
  const row = $('family-share-row');
  row.hidden = !exportController.canShareLast(state.openFamilyId);
}

async function shareLastPack() {
  if (exportController.isSharing()) return; // independent single-flight guard
  $('family-share').disabled = true;
  try {
    // Reuses the bytes from the last publish for this Family. Never
    // re-publishes (no new Published Artifact) and never downloads,
    // regardless of whether the share succeeds, is cancelled, or fails.
    const outcome = await exportController.shareLast(state.openFamilyId);
    if (outcome === 'shared') toast('Compartido');
    else if (outcome === 'cancelled') { /* user cancelled the native sheet; do nothing */ }
    else if (outcome === 'unavailable') toast('Nada para compartir todavía');
  } catch (err) {
    toast(`No se pudo compartir: ${err.message}`);
  } finally {
    $('family-share').disabled = false;
  }
}

function downloadBlob(filename, bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


// ---- device diagnostics ----------------------------------------------------

/**
 * What Safari on this particular device actually supports. This exists so the
 * artist can report precisely what worked, rather than guessing from version
 * numbers. It reports capabilities only — no architecture, no Knowledge Graph
 * administration, no telemetry: nothing here leaves the device.
 */
const RECORDING_TYPES = [
  'audio/wav', 'audio/mp4; codecs=alac', 'audio/mp4', 'audio/webm; codecs=opus',
  'audio/webm', 'audio/ogg; codecs=opus', 'audio/mpeg',
];

async function collectDiagnostics() {
  const rows = [];
  const yes = (v) => ({ value: v ? 'sí' : 'no', ok: !!v });

  rows.push(['Contexto seguro (HTTPS)', yes(window.isSecureContext)]);
  rows.push(['IndexedDB', yes('indexedDB' in window)]);
  rows.push(['navigator.mediaDevices', yes(!!navigator.mediaDevices)]);
  rows.push(['getUserMedia', yes(!!navigator.mediaDevices?.getUserMedia)]);
  rows.push(['MediaRecorder', yes(typeof window.MediaRecorder !== 'undefined')]);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  rows.push(['Decodificación de audio', yes(!!AudioCtx?.prototype?.decodeAudioData)]);

  const supported = typeof window.MediaRecorder !== 'undefined'
    && typeof MediaRecorder.isTypeSupported === 'function'
      ? RECORDING_TYPES.filter((t) => MediaRecorder.isTypeSupported(t))
      : [];
  rows.push(['Formatos de grabación',
    { value: supported.length ? supported.join(', ') : 'ninguno detectado', ok: supported.length > 0 }]);

  const chosen = state.lab?.recorderCapability;
  rows.push(['Formato elegido', {
    value: chosen?.mimeType ? `${chosen.mimeType}${chosen.lossless ? ' (sin pérdida)' : ''}`
                            : 'por defecto del dispositivo',
    ok: !!chosen?.mimeType }]);

  const cfg = state.lab?.explorationConfiguration;
  rows.push(['Configuración de exploración', {
    value: cfg ? `${cfg.id}@${cfg.version}` : 'no iniciada', ok: !!cfg }]);
  rows.push(['Almacenamiento', { value: state.lab ? 'IndexedDB (local)' : 'no iniciado', ok: !!state.lab }]);
  rows.push(['Modo standalone', yes(window.navigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches)]);

  if (navigator.storage?.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      rows.push(['Espacio usado', {
        value: `${(usage / 1048576).toFixed(1)} MB de ${(quota / 1048576).toFixed(0)} MB`, ok: true }]);
    } catch { /* estimate is best-effort */ }
  }

  let version = 'desconocida';
  try {
    const info = await (await fetch('./build-info.json', { cache: 'no-store' })).json();
    version = `${info.version} · ${info.builtAt.slice(0, 16).replace('T', ' ')}`;
  } catch { /* offline or not deployed */ }
  rows.push(['Build', { value: version, ok: true }]);

  return rows;
}

async function renderDiagnostics() {
  const host = $('diag');
  const rows = await collectDiagnostics();
  const items = rows.map(([label, { value, ok }]) =>
    `<div><dt>${escapeHtml(label)}</dt><dd class="${ok ? 'yes' : 'no'}">${escapeHtml(value)}</dd></div>`
  ).join('');
  host.innerHTML = `<div class="diag"><dl>${items}</dl></div>`;
  host.hidden = false;
}

/** If capture cannot work, say why in plain language instead of failing silently. */
function captureAvailability() {
  if (!window.isSecureContext) {
    return 'La grabación necesita una conexión segura (HTTPS). Abrí esta página por https:// y volvé a intentar.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Este navegador no expone el micrófono a las páginas web. Podés importar audio desde Archivos.';
  }
  if (typeof window.MediaRecorder === 'undefined') {
    return 'Este navegador no permite grabar desde la web. Podés importar audio desde Archivos.';
  }
  return null;
}

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
    if (file) importFile(file);
    e.target.value = '';
  };
  $('explore').onclick = runExploration;
  $('mesa-explore').onclick = runMesaExplorationUI;

  for (const tab of document.querySelectorAll('#explore-mode-tabs [role=tab]')) {
    tab.onclick = () => setExploreMode(tab.dataset.mode);
  }

  $('mesa-results').onclick = async (e) => {
    const d = e.target.dataset || {};
    if (d.mesaPlay !== undefined) { await playMesaObservation(Number(d.mesaPlay)); renderMesaResults(); }
    if (d.mesaKeep !== undefined) await keepMesaObservation(Number(d.mesaKeep));
    if (d.mesaDrop !== undefined) dropMesaObservation(Number(d.mesaDrop));
  };
  $('diag-toggle').onclick = async () => {
    const host = $('diag');
    if (!host.hidden) { host.hidden = true; $('diag-toggle').textContent = 'Ver compatibilidad'; return; }
    await renderDiagnostics();
    $('diag-toggle').textContent = 'Ocultar compatibilidad';
  };

  $('previews').onclick = (e) => {
    const keep = e.target.dataset?.keep;
    const drop = e.target.dataset?.drop;
    if (keep !== undefined) keepPreview(Number(keep));
    if (drop !== undefined) dropPreview(Number(drop));
  };

  $('materials').onclick = async (e) => {
    const d = e.target.dataset || {};
    if (d.play) { await togglePlayMaterial(d.play); return; } // separate hit target: never touches selection
    if (d.promote) { await state.lab.promote(d.promote); toast('Promovido'); }
    if (d.reject) { await state.lab.reject(d.reject); toast('Rechazado'); }
    if (d.use) {
      const m = await state.lab.material(d.use);
      if (m) { selectSource(m); $('explore-section').scrollIntoView({ behavior: 'smooth' }); }
    }
    if (d.promote || d.reject) await renderMaterials();
  };
  $('materials').addEventListener('change', (e) => {
    const id = e.target.dataset?.select;
    if (id === undefined) return;
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    updateCreateFamilyBar();
  });

  $('curate-toggle').onclick = async () => {
    state.curating = !state.curating;
    state.selected.clear();
    $('curate-toggle').textContent = state.curating ? 'Cancelar selección' : 'Seleccionar para Family';
    if (state.curating && state.tab !== 'promoted') {
      // Promoted Materials are the only eligible candidates, so selection
      // mode opens straight onto them instead of making the artist switch
      // tabs manually first.
      state.tab = 'promoted';
      for (const t of document.querySelectorAll('[role=tab]')) {
        t.setAttribute('aria-selected', String(t.dataset.tab === 'promoted'));
      }
    }
    await renderMaterials();
  };

  $('create-family-bar').onclick = async () => {
    const name = (prompt('Nombre de la Family:') || '').trim();
    if (!name) return;
    try {
      await state.lab.createFamily(name, [...state.selected]);
      state.curating = false; state.selected.clear();
      $('curate-toggle').textContent = 'Seleccionar para Family';
      await renderMaterials();
      await renderFamilies();
      toast('Family creada');
    } catch (err) {
      toast(`No se pudo crear: ${err.message}`);
    }
  };

  $('families').onclick = async (e) => {
    const id = e.target.dataset?.openFamily;
    if (id) await openFamily(id);
  };

  $('family-back').onclick = closeFamily;
  $('family-add-members').onclick = openMaterialPicker;
  $('family-publish').onclick = publishFamily;
  $('family-share').onclick = shareLastPack;

  $('family-members').onclick = async (e) => {
    const d = e.target.dataset || {};
    if (d.playMember) await playMember(d.playMember);
    if (d.up) await moveMember(d.up, -1);
    if (d.down) await moveMember(d.down, 1);
    if (d.removeMember) await removeMember(d.removeMember);
  };

  $('picker-back').onclick = () => { $('material-picker').hidden = true; };
  $('picker-done').onclick = async () => {
    for (const materialId of state.pickerSelected) {
      try { await state.lab.addFamilyMember(state.openFamilyId, materialId); }
      catch (err) { toast(`No se pudo agregar: ${err.message}`); }
    }
    $('material-picker').hidden = true;
    await renderFamilyDetail();
    await renderFamilies();
  };
  $('picker-list').addEventListener('change', (e) => {
    const id = e.target.dataset?.pick;
    if (id === undefined) return;
    if (e.target.checked) state.pickerSelected.add(id); else state.pickerSelected.delete(id);
  });

  for (const tab of document.querySelectorAll('[role=tab]')) {
    tab.onclick = async () => {
      for (const t of document.querySelectorAll('[role=tab]')) {
        t.setAttribute('aria-selected', String(t === tab));
      }
      state.tab = tab.dataset.tab;
      stopPlayback(); // never carry audio across a tab switch
      await renderMaterials();
    };
  }
}

/** Escape hatch: drop every cache and reload from the network. */
function wireReset() {
  const button = $('hard-reset');
  if (!button) return;
  button.onclick = async () => {
    toast('Limpiando caché…');
    try {
      for (const key of await caches.keys()) await caches.delete(key);
      const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
      for (const reg of regs) await reg.unregister();
    } catch { /* best effort */ }
    location.reload();
  };
}

async function boot() {
  try {
    state.lab = await openLab();
    const { mimeType, lossless } = state.lab.recorderCapability;
    $('capability').textContent = mimeType
      ? `Grabación: ${mimeType}${lossless ? ' · sin pérdida' : ''}`
      : 'Grabación: formato por defecto del dispositivo';
    try {
      const info = await (await fetch('./build-info.json', { cache: 'no-store' })).json();
      $('status').textContent = `local · ${info.version}`;
    } catch { $('status').textContent = 'local · offline'; }
    wire();
    initMesaSliders();

    // Capture may be impossible on this device or over http://. Explain it up
    // front rather than letting the record button fail silently.
    const blocked = captureAvailability();
    if (blocked) {
      $('record').disabled = true;
      const warn = document.createElement('div');
      warn.className = 'warn';
      warn.textContent = blocked;
      $('capture-section').appendChild(warn);
      await renderDiagnostics();
      $('diag-toggle').textContent = 'Ocultar compatibilidad';
    }
    await renderMaterials();
    await renderFamilies();
  } catch (err) {
    $('status').textContent = 'error';
    toast(`No se pudo abrir el laboratorio: ${err.message}`);
    // A failed boot is exactly when a stale cached build must be escapable.
    await renderDiagnostics();
    $('diag-toggle').textContent = 'Ocultar compatibilidad';
  }
  wireReset();
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./service-worker.js');
      // Always check for a newer worker: a stale one must not pin an old build.
      reg.update().catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data === 'cache-cleared') location.reload();
      });
    } catch { /* the app works without a service worker */ }
  }
}

boot();
