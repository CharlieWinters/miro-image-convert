import 'mirotone/dist/styles.css';
import './assets/style.css';

import {supportedFormats, formatById, labelForMime} from './formats.js';
import {convertItem, runPool} from './convert.js';
import {placeBelowOriginal, placeInFrame} from './board.js';
import {zipBlob, triggerDownload, revokeAll} from './download.js';
import {formatBytes, baseNameFor, uniqueName, escapeHtml} from './util.js';

// Decode + encode is memory hungry, so a handful at a time rather than all at
// once; board writes stay sequential so items land in a predictable order.
const CONCURRENCY = 3;
const MAX_ITEMS = 200;
const PREFS_KEY = 'miro-image-convert:prefs';

const el = {
  format: document.getElementById('format'),
  formatNote: document.getElementById('format-note'),
  quality: document.getElementById('quality'),
  qualityValue: document.getElementById('quality-value'),
  qualityGroup: document.getElementById('quality-group'),
  background: document.getElementById('background'),
  backgroundGroup: document.getElementById('background-group'),
  maxEdge: document.getElementById('max-edge'),
  sourceCount: document.getElementById('source-count'),
  toBoard: document.getElementById('to-board'),
  toDownload: document.getElementById('to-download'),
  progress: document.getElementById('progress'),
  barFill: document.getElementById('bar-fill'),
  progressLabel: document.getElementById('progress-label'),
  cancel: document.getElementById('cancel'),
  downloads: document.getElementById('downloads'),
  results: document.getElementById('results'),
};

let job = null; // { token: { cancelled } } while a run is in flight

const radioValue = (name) => document.querySelector(`input[name="${name}"]:checked`).value;

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        format: el.format.value,
        quality: el.quality.value,
        background: el.background.value,
        maxEdge: el.maxEdge.value,
        placement: radioValue('placement'),
        source: radioValue('source'),
      }),
    );
  } catch {
    /* storage unavailable in this frame; preferences just will not persist */
  }
}

function currentOptions() {
  const format = formatById(el.format.value);
  const maxEdge = parseInt(el.maxEdge.value, 10);
  return {
    format,
    quality: parseFloat(el.quality.value),
    background: el.background.value,
    maxEdge: Number.isFinite(maxEdge) && maxEdge >= 16 ? maxEdge : 0,
  };
}

function syncFormatControls() {
  const format = formatById(el.format.value);
  if (!format) return;
  el.qualityGroup.hidden = !format.lossy;
  el.backgroundGroup.hidden = format.alpha;
  el.formatNote.textContent = format.alpha
    ? 'Keeps transparency.'
    : `${format.label} has no transparency — transparent pixels get the background colour.`;
}

function setBusy(busy) {
  el.toBoard.disabled = busy;
  el.toDownload.disabled = busy;
  el.progress.hidden = !busy;
  if (!busy) return;
  el.barFill.style.width = '0%';
}

function setProgress(done, total, verb) {
  el.barFill.style.width = `${total ? (done / total) * 100 : 0}%`;
  el.progressLabel.textContent = `${verb} ${done} / ${total}`;
}

/** Board images the run should operate on, honouring the source radio. */
async function getSourceItems() {
  const items =
    radioValue('source') === 'board'
      ? await miro.board.get({type: 'image'})
      : await miro.board.getSelection();
  return items.filter((item) => item.type === 'image');
}

async function refreshCount() {
  try {
    const items = await getSourceItems();
    const scope = radioValue('source') === 'board' ? 'on the board' : 'selected';
    el.sourceCount.textContent =
      items.length === 0
        ? `No images ${scope}.`
        : `${items.length} image${items.length === 1 ? '' : 's'} ${scope}.`;
  } catch {
    el.sourceCount.textContent = '';
  }
}

function renderSummary(text) {
  const node = document.createElement('p');
  node.className = 'summary p-small';
  node.textContent = text;
  el.results.appendChild(node);
}

function renderResult({name, ok, detail}) {
  const row = document.createElement('div');
  row.className = `result ${ok ? 'ok' : 'err'}`;
  row.innerHTML =
    `<span class="dot">${ok ? '✓' : '✗'}</span>` +
    `<span class="body"><span class="name">${escapeHtml(name)}</span><br />${escapeHtml(detail)}</span>`;
  el.results.appendChild(row);
}

function renderDownloadLink(blob, fileName, label) {
  const {url, auto} = triggerDownload(blob, fileName);

  const link = document.createElement('a');
  link.className = 'dl button button-secondary';
  link.href = url;
  link.download = fileName;
  link.textContent = label;
  el.downloads.appendChild(link);

  const note = document.createElement('p');
  note.className = 'p-small muted';
  note.textContent = auto
    ? 'If your browser did not save it automatically, use the button above.'
    : 'Use the button above to save the file.';
  el.downloads.appendChild(note);
}

/** Convert every source image, reporting progress; never throws per item. */
async function convertAll(items, options, token) {
  setProgress(0, items.length, 'Converting');
  return runPool(items, CONCURRENCY, (item) => convertItem(item, options), {
    token,
    onProgress: (done, total) => setProgress(done, total, 'Converting'),
  });
}

function describe(result) {
  const from = labelForMime(result.sourceMime);
  const delta = `${formatBytes(result.sourceBytes)} → ${formatBytes(result.blob.size)}`;
  const resized =
    result.width !== result.sourceWidth || result.height !== result.sourceHeight
      ? `, resized to ${result.width}×${result.height}`
      : '';
  return `${from} → ${result.blob.type || 'output'}, ${delta}${resized}`;
}

async function run(mode) {
  if (job) return;

  const options = currentOptions();
  if (!options.format) {
    await miro.board.notifications.showError('Pick a target format first.');
    return;
  }

  let items;
  try {
    items = await getSourceItems();
  } catch (error) {
    await miro.board.notifications.showError(`Could not read the board: ${error.message}`);
    return;
  }

  if (items.length === 0) {
    await miro.board.notifications.showInfo(
      radioValue('source') === 'board'
        ? 'This board has no images to convert.'
        : 'Select at least one image on the board.',
    );
    return;
  }

  if (items.length > MAX_ITEMS) {
    await miro.board.notifications.showError(
      `${items.length} images is too many for one run. Please do at most ${MAX_ITEMS} at a time.`,
    );
    return;
  }

  const token = {cancelled: false};
  job = {token};
  revokeAll();
  el.downloads.replaceChildren();
  el.results.replaceChildren();
  setBusy(true);
  savePrefs();

  try {
    const converted = await convertAll(items, options, token);

    if (token.cancelled) {
      renderSummary('Cancelled before anything was written.');
      return;
    }

    const rows = [];
    const succeeded = [];
    const taken = new Set();

    converted.forEach((outcome, index) => {
      const item = items[index];
      const base = baseNameFor(item, index);

      if (!outcome) {
        rows.push({name: base, ok: false, detail: 'Skipped (run cancelled)'});
        return;
      }
      if (!outcome.ok) {
        rows.push({name: base, ok: false, detail: outcome.error.message});
        return;
      }

      const fileName = uniqueName(`${base}.${options.format.ext}`, taken);
      succeeded.push({item, result: outcome.value, fileName, base});
      rows.push({name: fileName, ok: true, detail: describe(outcome.value)});
    });

    if (succeeded.length === 0) {
      renderSummary(`Converted 0 of ${items.length}. Nothing was written.`);
      rows.forEach(renderResult);
      await miro.board.notifications.showError('None of the selected images could be converted.');
      return;
    }

    if (mode === 'board') {
      await writeToBoard(succeeded, options, token, rows);
    } else {
      await offerDownloads(succeeded, options);
    }

    renderSummary(
      `${succeeded.length} of ${items.length} converted to ${options.format.label}.` +
        (succeeded.length === items.length ? '' : ' See failures below.'),
    );
    rows.forEach(renderResult);
  } catch (error) {
    console.error(error);
    renderSummary(`Run failed: ${error.message}`);
    await miro.board.notifications.showError(`Conversion failed: ${error.message}`);
  } finally {
    job = null;
    setBusy(false);
  }
}

async function writeToBoard(succeeded, options, token, rows) {
  const placement = radioValue('placement');
  const created = [];
  let written = 0;
  setProgress(0, succeeded.length, 'Adding to board');

  if (placement === 'frame') {
    const {created: frameItems} = await placeInFrame(
      succeeded.map(({result, fileName}) => ({result, fileName})),
      options.format,
      succeeded.map(({item}) => item),
    );
    created.push(...frameItems);
    written = succeeded.length;
    setProgress(written, succeeded.length, 'Adding to board');
  } else {
    for (const entry of succeeded) {
      if (token.cancelled) break;
      try {
        created.push(...(await placeBelowOriginal(entry.item, entry.result, options.format, entry.fileName)));
        written++;
      } catch (error) {
        const row = rows.find((r) => r.name === entry.fileName);
        if (row) {
          row.ok = false;
          row.detail = error.message;
        }
      }
      entry.result.blob = null; // let the encoded bytes be collected
      setProgress(written, succeeded.length, 'Adding to board');
    }
  }

  if (created.length > 0) {
    try {
      await miro.board.viewport.zoomTo(created);
    } catch {
      /* zoom is a nicety, not worth failing the run */
    }
    await miro.board.notifications.showInfo(
      `Added ${written} ${options.format.label} image${written === 1 ? '' : 's'} to the board.`,
    );
  }
}

async function offerDownloads(succeeded, options) {
  if (succeeded.length === 1) {
    const {result, fileName} = succeeded[0];
    renderDownloadLink(result.blob, fileName, `Save ${fileName}`);
    return;
  }

  el.progressLabel.textContent = `Packing ${succeeded.length} files…`;
  const archive = await zipBlob(
    succeeded.map(({result, fileName}) => ({name: fileName, blob: result.blob})),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  renderDownloadLink(
    archive,
    `miro-images-${options.format.ext}-${stamp}.zip`,
    `Save ${succeeded.length} files (${formatBytes(archive.size)} .zip)`,
  );
}

function init() {
  const formats = supportedFormats();
  const prefs = loadPrefs();

  for (const format of formats) {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = format.label;
    el.format.appendChild(option);
  }
  el.format.value = formats.some((f) => f.id === prefs.format)
    ? prefs.format
    : formats.some((f) => f.id === 'webp')
      ? 'webp'
      : formats[0].id;

  if (prefs.quality) el.quality.value = prefs.quality;
  if (prefs.background) el.background.value = prefs.background;
  if (prefs.maxEdge) el.maxEdge.value = prefs.maxEdge;
  for (const name of ['placement', 'source']) {
    const saved = prefs[name];
    const input = saved && document.querySelector(`input[name="${name}"][value="${saved}"]`);
    if (input) input.checked = true;
  }

  el.qualityValue.textContent = el.quality.value;
  syncFormatControls();

  el.format.addEventListener('change', () => {
    syncFormatControls();
    savePrefs();
  });
  el.quality.addEventListener('input', () => {
    el.qualityValue.textContent = el.quality.value;
  });
  el.quality.addEventListener('change', savePrefs);
  el.background.addEventListener('change', savePrefs);
  el.maxEdge.addEventListener('change', savePrefs);

  for (const input of document.querySelectorAll('input[name="source"]')) {
    input.addEventListener('change', () => {
      savePrefs();
      refreshCount();
    });
  }
  for (const input of document.querySelectorAll('input[name="placement"]')) {
    input.addEventListener('change', savePrefs);
  }

  el.toBoard.addEventListener('click', () => run('board'));
  el.toDownload.addEventListener('click', () => run('download'));
  el.cancel.addEventListener('click', () => {
    if (job) {
      job.token.cancelled = true;
      el.progressLabel.textContent = 'Cancelling…';
    }
  });

  miro.board.ui.on('selection:update', () => {
    if (radioValue('source') === 'selection') refreshCount();
  });

  refreshCount();
}

init();
