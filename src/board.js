// Writing converted images back onto the board.
//
// Originals are never modified or removed: every mode only creates new items.

import {formatBytes, escapeHtml} from './util.js';
import {labelForMime} from './formats.js';

const GAP = 24;
const CAPTION_H = 40;

// Frame layout (board dp).
const CELL_IMG_W = 360;
const CELL_IMG_H = 300;
const CELL_PAD = 40;
const FRAME_TITLE_H = 48;
const MAX_COLS = 4;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read encoded image'));
    reader.readAsDataURL(blob);
  });
}

/** Caption shown above each converted image. */
function captionHtml(result, format) {
  const from = labelForMime(result.sourceMime);
  const dims = `${result.width}×${result.height}`;
  return (
    `<p><b>${escapeHtml(from)} → ${escapeHtml(format.label)}</b></p>` +
    `<p>${escapeHtml(formatBytes(result.blob.size))} · ${escapeHtml(dims)}</p>`
  );
}

async function createConverted(props, blobSize) {
  try {
    return await miro.board.createImage(props);
  } catch (cause) {
    const hint =
      blobSize > 4 * 1024 * 1024
        ? ' The encoded image may be too large for the board — try a lower quality or set "Resize longest edge".'
        : '';
    throw new Error(`Miro rejected the new image (${cause.message}).${hint}`);
  }
}

/**
 * Place each converted image directly beneath its original, captioned.
 * Board width is copied from the original, so the aspect ratio and on-board
 * footprint match whatever the user already had.
 */
export async function placeBelowOriginal(item, result, format, fileName) {
  const url = await blobToDataUrl(result.blob);
  const width = item.width;
  const height = item.height; // aspect is preserved by the converter
  const top = item.y + item.height / 2 + GAP;

  const image = await createConverted(
    {
      url,
      title: fileName,
      x: item.x,
      y: top + CAPTION_H + GAP / 2 + height / 2,
      width,
    },
    result.blob.size,
  );

  const caption = await miro.board.createText({
    content: captionHtml(result, format),
    x: item.x,
    y: top + CAPTION_H / 2,
    width,
    style: {fontSize: 14, textAlign: 'center', color: '#1a1a1a'},
  });

  return [image, caption];
}

function boundingBox(items) {
  const left = Math.min(...items.map((i) => i.x - i.width / 2));
  const right = Math.max(...items.map((i) => i.x + i.width / 2));
  const top = Math.min(...items.map((i) => i.y - i.height / 2));
  const bottom = Math.max(...items.map((i) => i.y + i.height / 2));
  return {left, right, top, bottom, centerY: (top + bottom) / 2};
}

/** Board size for an image fitted inside one grid cell, aspect preserved. */
function fitCell(result) {
  const aspect = result.width / result.height;
  const width = Math.min(CELL_IMG_W, CELL_IMG_H * aspect);
  return {width, height: width / aspect};
}

/**
 * Collect every converted image into one new frame laid out as a grid, placed
 * clear of the originals. This is the safe choice for bulk runs: output can
 * never land on top of another original.
 */
export async function placeInFrame(entries, format, sourceItems) {
  const cellW = CELL_IMG_W + CELL_PAD;
  const cellH = CAPTION_H + CELL_IMG_H + CELL_PAD;
  const cols = Math.min(MAX_COLS, Math.ceil(Math.sqrt(entries.length)));
  const rows = Math.ceil(entries.length / cols);

  const frameW = cols * cellW + CELL_PAD;
  const frameH = rows * cellH + CELL_PAD + FRAME_TITLE_H;

  const box = boundingBox(sourceItems);
  const frame = await miro.board.createFrame({
    title: `Converted to ${format.label} — ${entries.length} image${entries.length === 1 ? '' : 's'}`,
    x: box.right + 120 + frameW / 2,
    y: box.centerY,
    width: frameW,
    height: frameH,
  });

  const frameLeft = frame.x - frameW / 2;
  const frameTop = frame.y - frameH / 2;
  const created = [frame];

  for (let i = 0; i < entries.length; i++) {
    const {result, fileName} = entries[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    const cellCenterX = frameLeft + CELL_PAD + col * cellW + CELL_IMG_W / 2;
    const cellTop = frameTop + FRAME_TITLE_H + CELL_PAD + row * cellH;
    const fit = fitCell(result);

    const url = await blobToDataUrl(result.blob);
    const image = await createConverted(
      {
        url,
        title: fileName,
        x: cellCenterX,
        y: cellTop + CAPTION_H + fit.height / 2,
        width: fit.width,
      },
      result.blob.size,
    );

    const caption = await miro.board.createText({
      content: captionHtml(result, format),
      x: cellCenterX,
      y: cellTop + CAPTION_H / 2,
      width: CELL_IMG_W,
      style: {fontSize: 14, textAlign: 'center', color: '#1a1a1a'},
    });

    // Items created inside the frame's bounds normally adopt it automatically;
    // this is a belt-and-braces call for SDK versions that do not.
    for (const child of [image, caption]) {
      try {
        await frame.add(child);
      } catch {
        /* already parented */
      }
    }
    created.push(image, caption);
  }

  return {frame, created};
}

/**
 * Write converted images to the board, honouring the placement mode. Shared by
 * the panel and the one-click context-menu actions so both place items the
 * same way. Per-item placement failures are collected rather than thrown, so
 * one rejected image cannot strand the rest of a batch.
 *
 * @param entries [{item, result, fileName}]
 */
export async function writeConverted(entries, format, placement, {onProgress, token} = {}) {
  const created = [];
  const failures = [];
  let written = 0;

  if (placement === 'frame') {
    const {created: items} = await placeInFrame(
      entries.map(({result, fileName}) => ({result, fileName})),
      format,
      entries.map(({item}) => item),
    );
    created.push(...items);
    written = entries.length;
    onProgress?.(written, entries.length);
    return {created, written, failures};
  }

  for (const entry of entries) {
    if (token?.cancelled) break;
    try {
      created.push(
        ...(await placeBelowOriginal(entry.item, entry.result, format, entry.fileName)),
      );
      written++;
    } catch (error) {
      failures.push({fileName: entry.fileName, message: error.message});
    }
    entry.result.blob = null; // let the encoded bytes be collected
    onProgress?.(written, entries.length);
  }

  return {created, written, failures};
}
