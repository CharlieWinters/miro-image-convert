// Headless entry point (the app's `sdkUri`). It owns the toolbar icon and the
// optional right-click action; all UI lives in panel.html.

const PANEL = {url: 'panel.html'};

async function openPanel() {
  try {
    await miro.board.ui.openPanel(PANEL);
  } catch (error) {
    console.error('Could not open the converter panel', error);
    await miro.board.notifications.showError('Could not open the Image Format Converter panel.');
  }
}

miro.board.ui.on('icon:click', openPanel);

// A right-click entry on images is a convenience, not a requirement: the API is
// experimental and unavailable to Marketplace apps, so failure is non-fatal.
// Icon names are a fixed Miro set, so fall back if the first choice is rejected.
async function registerImageAction() {
  miro.board.ui.on('custom:convert-image-format', openPanel);

  for (const icon of ['image', 'photo', 'chat-two']) {
    try {
      await miro.board.experimental.action.register({
        event: 'convert-image-format',
        ui: {
          label: 'Convert image format',
          icon,
          description: 'Re-encode the selected images as PNG, JPEG, WebP or BMP',
        },
        scope: 'local',
        predicate: {type: 'image'},
        contexts: {item: {}},
      });
      return;
    } catch (error) {
      console.debug(`Custom action icon "${icon}" rejected`, error);
    }
  }
  console.debug('Custom action unavailable; use the toolbar icon instead.');
}

registerImageAction();
