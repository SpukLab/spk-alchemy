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
  curating: false, selected: new Set(),
  openFamilyId: null, playingMaterialId: null, playbackAudio: null,
  pickerSelected: new Set(),
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
    updateCreateFamilyBar();
    return;
  }
  host.innerHTML = '';
  const curatingHere = state.curating && state.tab === 'promoted';
  for (const m of items) {
    const card = document.createElement('div');
    card.className = 'card' + (state.source?.id === m.id ? ' sel' : '');
    let actions;
    if (curatingHere) {
      const checked = state.selected.has(m.id) ? 'checked' : '';
      card.innerHTML = `
        <label class="pick" style="display:flex;align-items:center;gap:10px">
          <input type="checkbox" data-select="${m.id}" ${checked}>
          <span style="flex:1">
            <h3 style="margin:0">${escapeHtml(m.attributes.filename || 'Material')}</h3>
            <div class="meta">${describe(m)}</div>
          </span>
        </label>`;
      host.appendChild(card);
      continue;
    }
    actions = state.tab === 'retained'
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
  $('family-detail').hidden = false;
  await renderFamilyDetail();
}

function closeFamily() {
  stopPlayback();
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
  host.innerHTML = '';
  members.forEach((member, index) => {
    const material = materials[index];
    const row = document.createElement('div');
    row.className = 'member' + (state.playingMaterialId === member.materialId ? ' playing' : '');
    row.innerHTML = `
      <div class="info">
        <h3>${escapeHtml(material?.attributes.filename || 'Material')}</h3>
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

async function playMember(materialId) {
  if (state.playingMaterialId === materialId) { stopPlayback(); await renderFamilyDetail(); return; }
  stopPlayback();
  const bytes = await state.lab.audioFor(await state.lab.material(materialId));
  if (!bytes) { toast('No se pudo reproducir'); return; }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const audio = new Audio(url);
  audio.play();
  audio.onended = async () => { stopPlayback(); await renderFamilyDetail(); };
  state.playbackAudio = audio;
  state.playingMaterialId = materialId;
  await renderFamilyDetail();
}

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
  toast('Publicando…');
  try {
    const { filename, zip } = await state.lab.publishFamily(state.openFamilyId);
    downloadBlob(filename, zip, 'application/zip');
    if (navigator.share && navigator.canShare) {
      const file = new File([zip], filename, { type: 'application/zip' });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); }
        catch { /* user cancelled share; the download already happened */ }
      }
    }
    await renderFamilies();
    toast('DNA Pack publicado');
  } catch (err) {
    toast(`No se pudo publicar: ${err.message}`);
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
