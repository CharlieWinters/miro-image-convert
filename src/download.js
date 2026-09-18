// Getting bytes out of the panel and onto the user's disk.
//
// A Miro panel is a cross-origin iframe, and a programmatic anchor click can be
// blocked there depending on the iframe's sandbox. So every download is also
// surfaced as a real link the user can click, which is the most permissive
// path available. Object URLs are tracked and revoked when the next run starts.

import {zip} from 'fflate';

const liveUrls = new Set();

export function revokeAll() {
  for (const url of liveUrls) URL.revokeObjectURL(url);
  liveUrls.clear();
}

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);
  return url;
}

/**
 * Bundle many files into one archive. Images are already compressed, so
 * entries are stored (level 0) rather than deflated: far faster, same size.
 */
export async function zipBlob(files) {
  const entries = {};
  for (const file of files) {
    entries[file.name] = [new Uint8Array(await file.blob.arrayBuffer()), {level: 0}];
  }

  const archive = await new Promise((resolve, reject) => {
    zip(entries, (err, data) => (err ? reject(err) : resolve(data)));
  });

  // Copy into a fresh buffer so the Blob never aliases fflate's scratch memory.
  return new Blob([new Uint8Array(archive)], {type: 'application/zip'});
}

/**
 * Try to save `blob` immediately and return the URL so the caller can also
 * render a manual link. `auto` reports whether the click was even attempted.
 */
export function triggerDownload(blob, fileName) {
  const url = objectUrl(blob);
  let auto = false;

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    auto = true;
  } catch {
    auto = false;
  }

  return {url, auto};
}
