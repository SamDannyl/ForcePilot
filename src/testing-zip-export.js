import { prepareEvidenceImageForExport } from './evidence-image.js';

/*
 * ForcePilot Testing Mode — screenshot ZIP export.
 *
 * Uses the same locally bundled JSZip instance as the DOCX exporter. The ZIP
 * contains only the captured evidence images, with timestamp-based filenames
 * so users can unzip the package and multi-select the images for Confluence.
 */

async function sha256Hex(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this browser.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function getZipCtor() {
  const ctor = globalThis.JSZip;
  if (!ctor) throw new Error('Screenshot ZIP export is unavailable because its local ZIP engine did not load.');
  return ctor;
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
}

function extensionForBlob(blob) {
  return String(blob?.type || '').toLowerCase() === 'image/png' ? 'png' : 'jpg';
}

function timestampFilename(iso, extension) {
  const date = new Date(iso || Date.now());
  const pad = value => String(value).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${ms}.${extension}`;
}

async function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  if (value && typeof value.arrayBuffer === 'function') return value.arrayBuffer();
  throw new Error('Captured evidence image is not a readable binary file.');
}

export async function buildTestingEvidenceZip(session, evidenceBlobs, { onProgress, imageQuality = 0.88 } = {}) {
  const Zip = getZipCtor();
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const evidence = Array.isArray(session?.evidence) ? session.evidence : [];
  if (!evidence.length) throw new Error('Capture at least one screenshot before exporting the ZIP.');

  const map = evidenceBlobs instanceof Map ? evidenceBlobs : new Map(Object.entries(evidenceBlobs || {}));
  const zip = new Zip();
  const usedNames = new Set();
  const compressedByFingerprint = new Map();
  const quality = Math.min(0.95, Math.max(0.70, Number(imageQuality) || 0.88));

  for (let index = 0; index < evidence.length; index += 1) {
    const item = evidence[index];
    const blob = map.get(item.imageBlobKey);
    if (!blob) throw new Error('A captured evidence image is unavailable. Capture it again before exporting.');
    const sourceBuffer = await toArrayBuffer(blob);
    const fingerprint = await sha256Hex(sourceBuffer);
    let optimized = compressedByFingerprint.get(fingerprint);
    if (!optimized) {
      optimized = await prepareEvidenceImageForExport(blob, { quality, maxDimension: 1920 });
      compressedByFingerprint.set(fingerprint, optimized);
    }
    const outputBlob = optimized?.blob || blob;
    const extension = extensionForBlob(outputBlob);
    const baseName = timestampFilename(item.capturedAt, extension).replace(/\.(?:jpg|png)$/i, '');
    let name = `${baseName}.${extension}`;
    if (usedNames.has(name)) {
      const suffix = String(item.id || '').slice(-6) || String(index + 1);
      name = `${baseName}-${suffix}.${extension}`;
    }
    usedNames.add(name);
    const buffer = optimized?.buffer || await toArrayBuffer(outputBlob);
    // The images are already optimized binary formats; STORE avoids spending
    // CPU trying to DEFLATE JPEG/PNG bytes a second time.
    zip.file(name, buffer, { binary: true, compression: 'STORE' });
    progress({ current: index + 1, total: evidence.length });
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/zip',
    compression: 'STORE'
  });
  return { blob, imageCount: evidence.length };
}

export function getTestingZipFilename(session) {
  const raw = sanitizeFilename(String(session?.exportFilename || session?.workProduct || session?.sessionName || '').replace(/\.(?:docx|zip)$/i, ''));
  if (raw) return `${raw}.zip`;
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
  return `ForcePilot-Test-Evidence-${stamp}.zip`;
}

export function downloadTestingZip(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
