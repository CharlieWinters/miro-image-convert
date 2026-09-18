// Panel settings, shared with the headless iframe.
//
// The one-click context-menu actions have no UI of their own, so they reuse
// whatever the panel was last set to. index.html and panel.html are served
// from the same origin, so they share localStorage.

const KEY = 'miro-image-convert:prefs';

export const DEFAULTS = {
  format: 'webp',
  quality: 0.85,
  background: '#ffffff',
  maxEdge: 0,
  placement: 'below',
  source: 'selection',
};

export function loadPrefs() {
  try {
    return {...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {})};
  } catch {
    return {...DEFAULTS};
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable in this frame; settings just will not persist */
  }
}

/** Stored settings -> convertItem() options for `format`. */
export function conversionOptions(prefs, format) {
  const quality = parseFloat(prefs.quality);
  const maxEdge = parseInt(prefs.maxEdge, 10);
  return {
    format,
    quality: Number.isFinite(quality) ? quality : DEFAULTS.quality,
    background: prefs.background || DEFAULTS.background,
    maxEdge: Number.isFinite(maxEdge) && maxEdge >= 16 ? maxEdge : 0,
  };
}
