import { encode as encodeMozjpeg } from '@jsquash/jpeg';
import { optimise as optimisePng } from '@jsquash/oxipng';
import { ImagequantImage, Imagequant } from 'imagequant';
import JSZip from 'jszip';
import { track } from './analytics.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const grid = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
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
});
updateSliderFill();

dropzone.addEventListener('click', () => fileInput.click());
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

function handleFiles(fileList) {
  const valid = Array.from(fileList).filter(f => /^image\/(jpeg|png)$/.test(f.type));
  if (!valid.length) return;
  valid.forEach(addItem);
  updateButtons();
  updateEmptyState();
}

function addItem(file) {
  const id = 'img_' + (idSeq++);
  const url = URL.createObjectURL(file);
  const item = {
    id, file, originalUrl: url, originalSize: file.size,
    status: 'pending', compressedBlob: null, compressedSize: 0
  };
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
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function removeItem(id) {
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return;
  URL.revokeObjectURL(items[idx].originalUrl);
  items[idx].cardEl.remove();
  items.splice(idx, 1);
  updateButtons();
  updateEmptyState();
  updateSummary();
}

clearBtn.addEventListener('click', () => {
  items.forEach(i => URL.revokeObjectURL(i.originalUrl));
  items = [];
  grid.innerHTML = '';
  updateButtons();
  updateEmptyState();
  summary.style.display = 'none';
});

function updateEmptyState() {
  if (items.length === 0) {
    if (!grid.contains(emptyState)) grid.appendChild(emptyState);
    emptyState.style.display = 'block';
  } else if (grid.contains(emptyState)) {
    emptyState.remove();
  }
}

function updateButtons() {
  const hasItems = items.length > 0;
  compressBtn.disabled = !hasItems;
  compressBtn.textContent = hasItems ? `Compress (${items.length})` : 'Compress';
  clearBtn.disabled = !hasItems;
  const hasCompressed = items.some(i => i.status === 'done');
  downloadAllBtn.disabled = !hasCompressed;
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

  try {
    const img = await loadImage(item.file);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
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
    item.status = 'done';

    const savedPct = ((1 - blob.size / item.originalSize) * 100);
    const resultEl = card.querySelector('.result');
    resultEl.innerHTML = `→ ${fmtBytes(blob.size)} <span class="save ${savedPct < 20 ? 'low' : ''}">(-${savedPct.toFixed(0)}%)</span>`;
    statusEl.textContent = 'Done';
    statusEl.className = 'status done';
    card.querySelector('.dl').disabled = false;
  } catch (err) {
    console.error(err);
    item.status = 'error';
    statusEl.textContent = 'Failed';
    statusEl.className = 'status err';
    track('compress_fail', { error: err?.message || String(err) });
  }
}

compressBtn.addEventListener('click', async () => {
  const quality = parseInt(qualitySlider.value, 10);
  const pending = items.filter(i => i.status !== 'done');
  if (pending.length === 0) return;

  compressBtn.disabled = true;
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

  compressBtn.disabled = false;
  qualitySlider.disabled = false;
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
backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
updateBackToTop();
