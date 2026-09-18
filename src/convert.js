// Decode a board image, re-encode it into the target format.

// Canvas has hard limits: exceeding them yields a blank or throwing canvas
// rather than an error, so clamp before drawing.
const MAX_EDGE = 16384;
const MAX_PIXELS = 50_000_000;

function parseMimeFromDataUrl(url) {
  const match = /^data:([^;,]+)/.exec(url);
  return match ? match[1] : '';
}

/**
 * Board image -> something drawable, plus what we know about the original.
 * `getDataUrl()` normally hands back a data: URL; the fetch path also copes if
 * a build of the SDK returns an http(s) URL instead.
 */
async function loadSource(item) {
  const raw = await item.getDataUrl();
  if (typeof raw !== 'string' || !raw) {
    throw new Error('Miro returned no image data for this item');
  }

  let blob;
  try {
    blob = await (await fetch(raw)).blob();
  } catch (cause) {
    throw new Error(`Could not read the image bytes (${cause.message})`);
  }

  const mime = blob.type || parseMimeFromDataUrl(raw);
  const bytes = blob.size;

  // createImageBitmap is faster but refuses SVG in Chromium, so fall back to
  // an <img>, which drawImage accepts just the same.
  try {
    const bitmap = await createImageBitmap(blob);
    return {
      drawable: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      mime,
      bytes,
      release: () => bitmap.close(),
    };
  } catch {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = objectUrl;
      await img.decode();
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) {
        throw new Error('Image has no intrinsic size (vector without dimensions?)');
      }
      return {
        drawable: img,
        width,
        height,
        mime,
        bytes,
        release: () => URL.revokeObjectURL(objectUrl),
      };
    } catch (cause) {
      URL.revokeObjectURL(objectUrl);
      throw new Error(`Could not decode this image (${cause.message})`);
    }
  }
}

/** Target pixel size after the optional user cap and the canvas safety limits. */
function targetSize(width, height, maxEdge) {
  let scale = 1;
  const longest = Math.max(width, height);

  if (maxEdge && longest > maxEdge) scale = maxEdge / longest;
  if (longest * scale > MAX_EDGE) scale = MAX_EDGE / longest;

  const pixels = width * scale * (height * scale);
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    clamped: scale < 1,
  };
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`Browser refused to encode ${mime}`))),
      mime,
      quality,
    );
  });
}

/**
 * Convert one board image. Returns the encoded blob plus before/after facts
 * for the caption, the results list and the download filename.
 */
export async function convertItem(item, options) {
  const {format, quality, background, maxEdge} = options;
  const source = await loadSource(item);

  try {
    const size = targetSize(source.width, source.height, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;

    const ctx = canvas.getContext('2d', {alpha: format.alpha});
    if (!ctx) throw new Error('Could not get a 2D canvas context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Formats without an alpha channel would otherwise render transparency as
    // black, so paint the chosen backdrop first.
    if (!format.alpha) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.drawImage(source.drawable, 0, 0, size.width, size.height);

    const blob = format.encode
      ? format.encode(ctx.getImageData(0, 0, size.width, size.height))
      : await canvasToBlob(canvas, format.mime, format.lossy ? quality : undefined);

    return {
      blob,
      sourceMime: source.mime,
      sourceBytes: source.bytes,
      sourceWidth: source.width,
      sourceHeight: source.height,
      width: size.width,
      height: size.height,
      downscaled: size.clamped,
    };
  } finally {
    source.release();
  }
}

/**
 * Run `worker` over `items` with bounded concurrency. Never rejects: each slot
 * reports `{ok}` so one bad image cannot abandon the rest of a bulk run.
 */
export async function runPool(items, limit, worker, {onProgress, token} = {}) {
  const results = new Array(items.length);
  let cursor = 0;
  let finished = 0;

  async function runner() {
    while (true) {
      if (token?.cancelled) return;
      const index = cursor++;
      if (index >= items.length) return;

      try {
        results[index] = {ok: true, value: await worker(items[index], index)};
      } catch (error) {
        results[index] = {ok: false, error};
      }

      finished++;
      onProgress?.(finished, items.length);
    }
  }

  const runners = Array.from({length: Math.max(1, Math.min(limit, items.length))}, runner);
  await Promise.all(runners);
  return results;
}
