// Headless entry point (the app's `sdkUri`). It owns the toolbar icon and the
// right-click actions; the panel owns all visible UI.

import {formatById} from './formats.js';
import {convertItem, runPool} from './convert.js';
import {writeConverted} from './board.js';
import {loadPrefs, conversionOptions} from './prefs.js';
import {baseNameFor, uniqueName} from './util.js';

const PANEL = {url: 'panel.html'};
const CONCURRENCY = 3;

// Miro allows a maximum of 4 custom actions per app, and registering a fifth
// throws. The budget goes on the panel opener plus the three formats people
// convert to most; everything else (BMP, quality, resizing, placement,
// downloads) stays in the panel.
const QUICK_FORMATS = ['png', 'jpeg', 'webp'];

// Valid `ui.icon` values are a fixed Miro set that the docs only publish as a
// rendered HTML block, so the names are not reliably knowable from the text
// reference. Try the plausible ones and fall back to `chat-two`, the value the
// docs use by example, so an action always registers with *some* icon.
const ICON_CANDIDATES = ['image', 'photo', 'picture', 'media', 'chat-two'];
let knownGoodIcon = null;

async function openPanel() {
  try {
    await miro.board.ui.openPanel(PANEL);
  } catch (error) {
    console.error('Could not open the converter panel', error);
    await miro.board.notifications.showError('Could not open the Image Format Converter panel.');
  }
}

miro.board.ui.on('icon:click', openPanel);

/**
 * Convert the right-clicked images with no panel involved, reusing whatever
 * quality/placement the panel was last set to. There is no progress bar out
 * here, so bracket the work with notifications instead.
 */
async function quickConvert(formatId, items) {
  const format = formatById(formatId);
  const images = (items || []).filter((item) => item.type === 'image');

  if (!format) {
    await miro.board.notifications.showError('This browser cannot write that format.');
    return;
  }
  if (images.length === 0) {
    await miro.board.notifications.showInfo('Select one or more images to convert.');
    return;
  }

  const prefs = loadPrefs();
  const options = conversionOptions(prefs, format);

  await miro.board.notifications.showInfo(
    `Converting ${images.length} image${images.length === 1 ? '' : 's'} to ${format.label}…`,
  );

  const converted = await runPool(images, CONCURRENCY, (item) => convertItem(item, options));

  const entries = [];
  const taken = new Set();
  let failed = 0;

  converted.forEach((outcome, index) => {
    if (!outcome?.ok) {
      failed++;
      if (outcome?.error) console.error('Conversion failed', outcome.error);
      return;
    }
    entries.push({
      item: images[index],
      result: outcome.value,
      fileName: uniqueName(`${baseNameFor(images[index], index)}.${format.ext}`, taken),
    });
  });

  if (entries.length === 0) {
    await miro.board.notifications.showError(
      `Could not convert ${failed === 1 ? 'that image' : 'those images'}. Open the app panel to see why.`,
    );
    return;
  }

  const {created, written, failures} = await writeConverted(entries, format, prefs.placement);

  if (created.length > 0) {
    try {
      await miro.board.viewport.zoomTo(created);
    } catch {
      /* zoom is a nicety, not worth failing the action */
    }
  }

  const problems = failed + failures.length;
  const summary = `Added ${written} ${format.label} image${written === 1 ? '' : 's'}.`;
  if (problems > 0) {
    await miro.board.notifications.showError(
      `${summary} ${problems} failed — open the app panel to see why.`,
    );
  } else {
    await miro.board.notifications.showInfo(summary);
  }
}

/** Register one action, resolving a usable icon name by trial. */
async function register(action) {
  for (const icon of knownGoodIcon ? [knownGoodIcon] : ICON_CANDIDATES) {
    try {
      await miro.board.experimental.action.register({...action, ui: {...action.ui, icon}});
      knownGoodIcon = icon;
      return true;
    } catch (error) {
      console.debug(`Custom action "${action.event}" rejected icon "${icon}"`, error);
    }
  }
  return false;
}

// Custom actions are experimental and only available to privately distributed
// apps, so every failure here is non-fatal: the toolbar icon still works.
async function registerActions() {
  // The SDK requires subscribing to the event before registering the action.
  miro.board.ui.on('custom:convert-image-format', openPanel);
  await register({
    event: 'convert-image-format',
    ui: {
      label: 'Convert image format…',
      description: 'Open the converter for the selected images',
    },
    scope: 'local',
    // Evaluated per item: the entry only appears when everything selected is
    // an image.
    predicate: {type: 'image'},
    contexts: {item: {}},
  });

  for (const id of QUICK_FORMATS) {
    const format = formatById(id);
    if (!format) continue; // this browser cannot encode it

    const event = `convert-to-${id}`;
    miro.board.ui.on(`custom:${event}`, (e) => quickConvert(id, e.items));
    await register({
      event,
      ui: {
        label: `Convert to ${format.label}`,
        description: `Add a ${format.label} copy of each selected image`,
      },
      scope: 'local',
      predicate: {type: 'image'},
      contexts: {item: {}},
    });
  }
}

registerActions().catch((error) => {
  console.debug('Custom actions unavailable; use the toolbar icon instead.', error);
});
