export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A filesystem-safe base name for an image item, without extension. */
export function baseNameFor(item, index) {
  const raw = (item.title || '').trim();
  const withoutExt = raw.replace(/\.(png|jpe?g|webp|avif|bmp|gif|svg|tiff?)$/i, '');
  const safe = withoutExt
    .replace(/[^a-z0-9._ -]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return safe || `image-${index + 1}`;
}

/** Appends -2, -3 ... so a bulk zip never silently drops a duplicate name. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (taken.has(`${stem}-${n}${ext}`)) n++;
  const result = `${stem}-${n}${ext}`;
  taken.add(result);
  return result;
}

export function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
  );
}
