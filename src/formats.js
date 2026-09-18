// Target format registry + runtime capability probing.
//
// Browsers disagree about which MIME types `canvas.toBlob` can *encode* (as
// opposed to decode). Chrome, for example, decodes AVIF happily but silently
// falls back to PNG when asked to encode it. So every canvas-backed format is
// probed once at startup and only offered if the probe round-trips.

/** Encodes 24-bit BGR bottom-up BMP. Canvas cannot produce BMP itself. */
function encodeBmp(imageData) {
  const {width: w, height: h, data} = imageData;
  const rowSize = (w * 3 + 3) & ~3; // rows are padded to a 4-byte boundary
  const pixelBytes = rowSize * h;
  const fileSize = 54 + pixelBytes;

  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // BITMAPFILEHEADER
  bytes[0] = 0x42; // 'B'
  bytes[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true); // pixel data offset

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true); // header size
  view.setInt32(18, w, true);
  view.setInt32(22, h, true); // positive height => rows stored bottom-up
  view.setUint16(26, 1, true); // colour planes
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(34, pixelBytes, true);
  view.setUint32(38, 2835, true); // ~72 DPI
  view.setUint32(42, 2835, true);

  for (let y = 0; y < h; y++) {
    let out = 54 + y * rowSize;
    let src = (h - 1 - y) * w * 4; // flip: BMP row 0 is the bottom row
    for (let x = 0; x < w; x++, src += 4) {
      bytes[out++] = data[src + 2]; // B
      bytes[out++] = data[src + 1]; // G
      bytes[out++] = data[src]; // R
    }
  }

  return new Blob([buf], {type: 'image/bmp'});
}

const CANDIDATES = [
  {id: 'png', label: 'PNG', mime: 'image/png', ext: 'png', alpha: true, lossy: false},
  {id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', alpha: false, lossy: true},
  {id: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', alpha: true, lossy: true},
  {id: 'avif', label: 'AVIF', mime: 'image/avif', ext: 'avif', alpha: true, lossy: true},
  {
    id: 'bmp',
    label: 'BMP',
    mime: 'image/bmp',
    ext: 'bmp',
    alpha: false,
    lossy: false,
    encode: encodeBmp, // bypasses canvas.toBlob
  },
];

/** True when canvas.toDataURL actually honours `mime` instead of falling back. */
function canEncode(mime) {
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    return probe.toDataURL(mime).startsWith(`data:${mime}`);
  } catch {
    return false;
  }
}

let cached = null;

/** Formats this browser can actually write, in menu order. */
export function supportedFormats() {
  if (!cached) {
    cached = CANDIDATES.filter((f) => f.encode || canEncode(f.mime));
  }
  return cached;
}

export function formatById(id) {
  return supportedFormats().find((f) => f.id === id);
}

/** Human label for a source MIME, e.g. 'image/jpeg' -> 'JPEG'. */
export function labelForMime(mime) {
  if (!mime) return 'unknown';
  const known = CANDIDATES.find((f) => f.mime === mime);
  if (known) return known.label;
  const sub = String(mime).split('/')[1] || mime;
  return sub.replace('+xml', '').toUpperCase();
}
