/*
 * ForcePilot Testing Mode — evidence image export preparation.
 *
 * Evidence stored in the session remains untouched. This module only creates
 * a compressed derivative for Word/ZIP export so previews, copy, delete, and
 * future exports always retain the original evidence pixels.
 */

const DEFAULT_JPEG_QUALITY = 0.88;
const DEFAULT_MAX_DIMENSION = 1920;

function getImageDimensions(image) {
  return {
    width: Math.max(1, Number(image?.width || image?.naturalWidth || 1)),
    height: Math.max(1, Number(image?.height || image?.naturalHeight || 1))
  };
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not encode the screenshot.')), type, quality);
  });
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  }

  const url = URL.createObjectURL(blob);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The screenshot could not be decoded.'));
    img.src = url;
  });
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function prepareEvidenceImageForExport(blob, {
  quality = DEFAULT_JPEG_QUALITY,
  maxDimension = DEFAULT_MAX_DIMENSION
} = {}) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new Error('Evidence image is not readable.');
  }

  const originalBytes = await blob.arrayBuffer();
  const originalSize = originalBytes.byteLength;
  const sourceType = String(blob.type || '').toLowerCase();
  const decoded = await decodeImage(blob);

  try {
    const sourceWidth = Math.max(1, Number(decoded.width || 1));
    const sourceHeight = Math.max(1, Number(decoded.height || 1));
    const limit = Math.max(320, Number(maxDimension) || DEFAULT_MAX_DIMENSION);
    const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    const needsResize = targetWidth !== sourceWidth || targetHeight !== sourceHeight;

    // Always evaluate a JPEG export candidate. This is deliberately done from
    // the original evidence, never from an earlier compressed export, so each
    // export is a single lossy generation at a predictable quality level.
    const canvas = makeCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('The browser could not create an image canvas.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

    const requestedQuality = Math.min(0.92, Math.max(0.68, Number(quality) || DEFAULT_JPEG_QUALITY));
    const candidate = await canvasToBlob(canvas, 'image/jpeg', requestedQuality);
    if (!candidate?.size) throw new Error('The browser could not encode the screenshot.');

    // If the original is already smaller and no resize is needed, keeping the
    // original avoids making a tiny evidence image larger just for conversion.
    const canKeepOriginalFormat = sourceType === 'image/jpeg' || sourceType === 'image/jpg' || sourceType === 'image/png';
    if (!needsResize && canKeepOriginalFormat && candidate.size >= originalSize * 0.98) {
      return {
        blob,
        buffer: originalBytes,
        changed: false,
        sourceWidth,
        sourceHeight,
        targetWidth: sourceWidth,
        targetHeight: sourceHeight,
        compression: sourceType === 'image/jpeg' || sourceType === 'image/jpg' ? 'original-jpeg' : 'original'
      };
    }

    return {
      blob: candidate,
      buffer: await candidate.arrayBuffer(),
      changed: true,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      compression: `jpeg-q${Math.round(requestedQuality * 100)}`
    };
  } finally {
    decoded.close();
  }
}

// Backward-compatible export for the current Word exporter.
export async function prepareEvidenceImageForWord(blob, options = {}) {
  return prepareEvidenceImageForExport(blob, options);
}
