import { encode as encodeMozjpeg } from '@jsquash/jpeg';
import { optimise as optimisePng } from '@jsquash/oxipng';
import { ImagequantImage, Imagequant } from 'imagequant';
import JSZip from 'jszip';
import { track } from './analytics.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const grid = document.getElementById('grid');
const resultsPanel = document.getElementById('resultsPanel');
const undoBar = document.getElementById('undoBar');
const qualitySlider = document.getElementById('qualitySlider');
const qualityLabel = document.getElementById('qualityLabel');
const compressBtn = document.getElementById('compressBtn');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const clearBtn = document.getElementById('clearBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const summary = document.getElementById('summary');
const statCount = document.getElementById('statCount');
const statOriginal = document.getElementById('statOriginal');
const statCompressed = document.getElementById('statCompressed');
const statSaved = document.getElementById('statSaved');

let items = []; // {id, file, originalUrl, originalSize, status, compressedBlob, compressedSize, cardEl}
let idSeq = 0;
// updateButtons() runs after every finished item, so it has to know a run is
// still going — otherwise it re-enables Compress mid-batch.
let isCompressing = false;

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// MozJPEG quality is already 0-100, matches the slider directly.
function jpegQuality(q) {
  return Math.min(95, Math.max(5, q));
}
// libimagequant quality is 0-100 like JPEG; give it a target + a slightly
// lower floor so it can drop a little further when that saves real bytes.
function pngQualityRange(q) {
  const target = Math.min(100, Math.max(1, q));
  const min = Math.max(0, target - 20);
  return [min, target];
}
// Higher slider quality -> lighter (faster) oxipng pass, since a large palette
// already keeps most detail and we don't need to fight as hard for extra bytes.
function oxipngLevel(q) {
  return q >= 95 ? 2 : 4;
}

function updateSliderFill() {
  const min = Number(qualitySlider.min) || 0;
  const max = Number(qualitySlider.max) || 100;
  const pct = ((qualitySlider.value - min) / (max - min)) * 100;
  qualitySlider.style.setProperty('--range-progress', pct + '%');
}

qualitySlider.addEventListener('input', () => {
  qualityLabel.textContent = qualitySlider.value;
  updateSliderFill();
  updateButtons();
});
updateSliderFill();

dropzone.addEventListener('click', () => fileInput.click());
// The dropzone is a div with role="button", so it has to handle activation
// keys itself — a native button would do this for free, but it cannot contain
// the file input. fileInput stays display:none; .click() works regardless.
dropzone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    fileInput.click();
  }
});
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop', e => {
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = '';
});

const skippedEl = document.getElementById('skipped');

// A canvas past the browser's limits does not throw: it is created, hands back
// a context, accepts draw calls and then reads back as empty pixels. Left
// unchecked that produces a blank image reported as "Done". These caps are the
// lowest ceilings among current desktop engines, so an image under them should
// decode anywhere; compressOne() still probes the canvas it actually got, which
// is what catches the tighter limits on phones.
const MAX_SIDE = 32767;
const MAX_PIXELS = 100e6; // also stated in index.html's subtitle — change both

// naturalWidth/Height without touching a canvas.
function probeSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
    img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => done(null);
    img.src = url;
  });
}

function fmtPixels(w, h) {
  return `${w}\u00d7${h}, ${(w * h / 1e6).toFixed(0)} MP`;
}

function clearSkipped() {
  if (!skippedEl) return;
  skippedEl.classList.remove('show');
  skippedEl.textContent = '';
}

function reportSkipped({ wrongType, tooBig, unreadable }) {
  if (!skippedEl) return;
  const lines = [];
  if (wrongType.length) {
    lines.push(`${wrongType.length} file${wrongType.length === 1 ? '' : 's'} skipped — only JPG and PNG are supported.` +
      `<br><span class="files">${escapeHtml(wrongType.map(f => f.name).join(', '))}</span>`);
  }
  if (tooBig.length) {
    lines.push(`${tooBig.length} image${tooBig.length === 1 ? '' : 's'} skipped — too large to decode in the browser` +
      ` (limit ${MAX_SIDE} px per side, ${MAX_PIXELS / 1e6} MP total).` +
      `<br><span class="files">${escapeHtml(tooBig.map(t => `${t.file.name} (${fmtPixels(t.w, t.h)})`).join(', '))}</span>`);
  }
  if (unreadable.length) {
    lines.push(`${unreadable.length} file${unreadable.length === 1 ? '' : 's'} skipped — could not be read as an image.` +
      `<br><span class="files">${escapeHtml(unreadable.map(f => f.name).join(', '))}</span>`);
  }
  if (!lines.length) {
    clearSkipped();
    return;
  }
  skippedEl.innerHTML = lines.join('<br><br>');
  skippedEl.classList.add('show');
}

async function handleFiles(fileList) {
  const all = Array.from(fileList);
  const wrongType = all.filter(f => !/^image\/(jpeg|png)$/.test(f.type));
  const candidates = all.filter(f => /^image\/(jpeg|png)$/.test(f.type));

  const sizes = await Promise.all(candidates.map(probeSize));
  const tooBig = [];
  const unreadable = [];
  const accepted = [];
  candidates.forEach((file, i) => {
    const size = sizes[i];
    if (!size || !size.w || !size.h) { unreadable.push(file); return; }
    if (size.w > MAX_SIDE || size.h > MAX_SIDE || size.w * size.h > MAX_PIXELS) {
      tooBig.push({ file, ...size });
      return;
    }
    accepted.push(file);
  });

  // Silently dropping files left users counting thumbnails to work out what
  // happened, so say which ones were ignored and why.
  reportSkipped({ wrongType, tooBig, unreadable });
  if (!accepted.length) return;
  accepted.forEach(addItem);
  updateButtons();
  updateEmptyState();
}

// `restore` carries a snapshot taken before a removal, so undo brings the card
// back finished rather than making the user compress it again.
function addItem(file, restore) {
  const id = 'img_' + (idSeq++);
  const url = URL.createObjectURL(file);
  const item = {
    id, file, originalUrl: url, originalSize: file.size,
    status: 'pending', compressedBlob: null, compressedSize: 0,
    // Which slider value produced compressedBlob; null until compressed.
    compressedQuality: null,
    ...(restore || {})
  };
  item.id = id;
  item.originalUrl = url;
  items.push(item);

  const card = document.createElement('div');
  card.className = 'card';
  card.id = id;
  card.innerHTML = `
    <img class="thumb checker" src="${url}" alt="">
    <div class="info">
      <div class="name">${escapeHtml(file.name)}</div>
      <div class="meta">
        <span>Original ${fmtBytes(file.size)}</span>
        <span class="result"></span>
      </div>
    </div>
    <span class="status">Pending</span>
    <div class="row-actions">
      <button class="icon-btn dl" title="Download" disabled>⬇</button>
      <button class="icon-btn rm" title="Remove">✕</button>
    </div>
  `;
  grid.appendChild(card);
  item.cardEl = card;

  card.querySelector('.rm').addEventListener('click', () => removeItem(id));
  card.querySelector('.dl').addEventListener('click', () => downloadItem(id));

  if (item.status === 'done') renderResult(item);
  return item;
}

// Paints a finished item's figures onto its card. compressOne() and undo both
// need this, so it lives in one place.
function renderResult(item) {
  const card = item.cardEl;
  const savedPct = (1 - item.compressedSize / item.originalSize) * 100;
  card.querySelector('.result').innerHTML =
    `\u2192 ${fmtBytes(item.compressedSize)} <span class="save ${savedPct < 20 ? 'low' : ''}">(-${savedPct.toFixed(0)}%)</span>`;
  const statusEl = card.querySelector('.status');
  statusEl.textContent = 'Done';
  statusEl.className = 'status done';
  card.querySelector('.dl').disabled = false;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let undoTimer = null;

function snapshotOf(item) {
  return {
    file: item.file,
    status: item.status,
    compressedBlob: item.compressedBlob,
    compressedSize: item.compressedSize,
    compressedQuality: item.compressedQuality
  };
}

function hideUndo() {
  clearTimeout(undoTimer);
  undoBar.classList.remove('show');
  undoBar.innerHTML = '';
}

// Undo rather than a confirmation dialog: removing is cheap and frequent, and
// a prompt in front of every removal costs more than the mistake it prevents.
function offerUndo(snapshots, label) {
  if (!undoBar || !snapshots.length) return;
  clearTimeout(undoTimer);
  undoBar.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'undo-btn';
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => {
    hideUndo();
    snapshots.forEach(sn => addItem(sn.file, {
      status: sn.status,
      compressedBlob: sn.compressedBlob,
      compressedSize: sn.compressedSize,
      compressedQuality: sn.compressedQuality
    }));
    updateButtons();
    updateEmptyState();
    updateSummary();
  });
  undoBar.appendChild(btn);
  undoBar.classList.add('show');
  undoTimer = setTimeout(hideUndo, 8000);
}

function removeItem(id) {
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return;
  const snapshot = snapshotOf(items[idx]);
  const name = items[idx].file.name;
  URL.revokeObjectURL(items[idx].originalUrl);
  items[idx].cardEl.remove();
  items.splice(idx, 1);
  if (items.length === 0) clearSkipped();
  offerUndo([snapshot], `Removed ${name}`);
  updateButtons();
  updateEmptyState();
  updateSummary();
}

clearBtn.addEventListener('click', () => {
  const snapshots = items.map(snapshotOf);
  const count = items.length;
  items.forEach(i => URL.revokeObjectURL(i.originalUrl));
  items = [];
  grid.innerHTML = '';
  // The notice describes the drop that is being cleared away, so it goes too.
  clearSkipped();
  updateButtons();
  updateEmptyState();
  summary.style.display = 'none';
  offerUndo(snapshots, `Cleared ${count} image${count === 1 ? '' : 's'}`);
});

// The dropzone above is already the empty state; a second card saying the list
// is empty added nothing, so the whole results panel goes away instead.
function updateEmptyState() {
  resultsPanel.style.display = items.length === 0 ? 'none' : '';
}

// An item needs work if it was never compressed, or was compressed at a
// quality the slider no longer shows. This is what makes changing the quality
// and pressing the button actually re-run, instead of silently doing nothing.
function itemsNeedingWork() {
  const quality = parseInt(qualitySlider.value, 10);
  return items.filter(i => i.status !== 'done' || i.compressedQuality !== quality);
}

function updateButtons() {
  const hasItems = items.length > 0;
  const todo = itemsNeedingWork();
  const allDone = hasItems && todo.length === 0;

  // Never leave the button clickable with nothing to do — pressing it used to
  // produce no feedback whatsoever.
  compressBtn.disabled = isCompressing || !hasItems || allDone;
  if (isCompressing) {
    compressBtn.textContent = 'Compressing…';
  } else if (!hasItems) {
    compressBtn.textContent = 'Compress';
  } else if (allDone) {
    compressBtn.textContent = `Compressed (${items.length})`;
  } else {
    const redo = items.some(i => i.status === 'done');
    compressBtn.textContent = `${redo ? 'Re-compress' : 'Compress'} (${todo.length})`;
  }

  clearBtn.disabled = isCompressing || !hasItems;
  downloadAllBtn.disabled = isCompressing || !items.some(i => i.status === 'done');
}

function updateSummary() {
  const done = items.filter(i => i.status === 'done');
  if (done.length === 0) { summary.style.display = 'none'; return; }
  summary.style.display = 'flex';
  const origTotal = done.reduce((s, i) => s + i.originalSize, 0);
  const compTotal = done.reduce((s, i) => s + i.compressedSize, 0);
  statCount.textContent = done.length;
  statOriginal.textContent = fmtBytes(origTotal);
  statCompressed.textContent = fmtBytes(compTotal);
  const savedPct = origTotal > 0 ? ((1 - compTotal / origTotal) * 100) : 0;
  statSaved.textContent = savedPct.toFixed(1) + '%';
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function compressJpeg(imageData, quality) {
  const arrayBuffer = await encodeMozjpeg(imageData, { quality: jpegQuality(quality) });
  return new Blob([arrayBuffer], { type: 'image/jpeg' });
}

async function compressPng(imageData, canvasWidth, canvasHeight, quality, originalFile) {
  try {
    const uint8Array = new Uint8Array(imageData.data.buffer);
    const image = new ImagequantImage(uint8Array, canvasWidth, canvasHeight, 0);
    const instance = new Imagequant();
    const [minQ, maxQ] = pngQualityRange(quality);
    instance.set_quality(minQ, maxQ);
    const quantized = instance.process(image);
    // .slice() copies into a right-sized buffer, avoiding any leftover WASM
    // memory-view offset/length quirks before handing bytes to oxipng.
    const optimised = await optimisePng(quantized.slice().buffer, { level: oxipngLevel(quality) });
    return new Blob([optimised], { type: 'image/png' });
  } catch (err) {
    // libimagequant throws on some small/low-color icon PNGs (e.g.
    // "QUALITY_TOO_LOW" or palette-conversion errors) — fall back to a
    // lossless oxipng-only pass on the original bytes instead of failing.
    console.warn('PNG quantization failed, falling back to lossless-only compression:', err);
    const originalBuffer = await originalFile.arrayBuffer();
    const optimised = await optimisePng(originalBuffer, { level: oxipngLevel(quality) });
    return new Blob([optimised], { type: 'image/png' });
  }
}

async function compressOne(item, quality) {
  const card = item.cardEl;
  const statusEl = card.querySelector('.status');
  statusEl.textContent = 'Processing';
  statusEl.className = 'status';
  // Clear the previous run's figures so a re-compress does not show a stale
  // result while the new one is still being produced.
  card.querySelector('.result').innerHTML = '';
  card.querySelector('.dl').disabled = true;
  item.status = 'pending';

  try {
    const img = await loadImage(item.file);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D context for this image');

    // Write one opaque pixel at the far corner and read it back. On a canvas
    // the browser silently refused to back with memory this comes back empty,
    // which is the only reliable signal before we draw the real image: the
    // limits differ per engine and device, and nothing above throws.
    ctx.fillStyle = '#fff';
    ctx.fillRect(canvas.width - 1, canvas.height - 1, 1, 1);
    if (ctx.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data[3] === 0) {
      throw new Error(`Image too large for this device (${canvas.width}\u00d7${canvas.height})`);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    let blob = item.file.type === 'image/jpeg'
      ? await compressJpeg(imageData, quality)
      : await compressPng(imageData, canvas.width, canvas.height, quality, item.file);

    // Fallback: if the "compressed" result is somehow larger, keep original
    if (blob.size >= item.originalSize) {
      blob = item.file;
    }

    item.compressedBlob = blob;
    item.compressedSize = blob.size;
    item.compressedQuality = quality;
    item.status = 'done';

    renderResult(item);
  } catch (err) {
    console.error(err);
    item.status = 'error';
    statusEl.textContent = 'Failed';
    statusEl.className = 'status err';
    // "Failed" on its own is a dead end; say why, since the reason is often
    // actionable (an image past this device's decoding limits, say).
    const reason = err?.message || String(err);
    card.querySelector('.result').innerHTML = `<span class="save low">${escapeHtml(reason)}</span>`;
    track('compress_fail', { error: reason });
  }
}

compressBtn.addEventListener('click', async () => {
  const quality = parseInt(qualitySlider.value, 10);
  const pending = itemsNeedingWork();
  if (pending.length === 0) return;

  isCompressing = true;
  updateButtons();
  qualitySlider.disabled = true;
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  const concurrency = 3;
  let completed = 0;
  let idx = 0;

  async function worker() {
    while (idx < pending.length) {
      const myIdx = idx++;
      await compressOne(pending[myIdx], quality);
      completed++;
      progressBar.style.width = (completed / pending.length * 100) + '%';
      updateSummary();
      updateButtons();
    }
  }

  const startedAt = Date.now();
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, worker);
  await Promise.all(workers);

  const done = pending.filter(i => i.status === 'done');
  if (done.length > 0) {
    const formats = {};
    for (const i of done) {
      const fmt = i.file.type === 'image/jpeg' ? 'jpeg' : 'png';
      formats[fmt] = (formats[fmt] || 0) + 1;
    }
    track('compress_complete', {
      count: done.length,
      originalBytes: done.reduce((s, i) => s + i.originalSize, 0),
      compressedBytes: done.reduce((s, i) => s + i.compressedSize, 0),
      durationMs: Date.now() - startedAt,
      formats,
      quality,
    });
  }

  isCompressing = false;
  qualitySlider.disabled = false;
  updateButtons();
  setTimeout(() => { progressWrap.style.display = 'none'; }, 500);
});

function downloadItem(id) {
  const item = items.find(i => i.id === id);
  if (!item || !item.compressedBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(item.compressedBlob);
  a.download = item.file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

downloadAllBtn.addEventListener('click', async () => {
  const done = items.filter(i => i.status === 'done');
  if (done.length === 0) return;
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = 'Zipping...';

  const zip = new JSZip();
  done.forEach(item => {
    zip.file(item.file.name, item.compressedBlob);
  });
  const content = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(content);
  a.download = 'compressed_images.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();

  downloadAllBtn.disabled = false;
  downloadAllBtn.textContent = 'Download All (ZIP)';
});

const backToTop = document.getElementById('backToTop');
function updateBackToTop() {
  backToTop.classList.toggle('visible', window.scrollY > 400);
}
window.addEventListener('scroll', updateBackToTop, { passive: true });
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
backToTop.addEventListener('click', () => window.scrollTo({
  top: 0,
  behavior: reducedMotion.matches ? 'auto' : 'smooth'
}));
updateBackToTop();
