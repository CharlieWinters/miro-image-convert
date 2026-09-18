# Miro Image Format Converter

A Miro Web SDK app that re-encodes board images into another format. It can
either **write the converted image back onto the board** (keeping the original,
with a text caption naming the format) or **hand you the file to download**.
Both paths work on a whole selection at once.

Everything happens in the browser — decode and encode use `<canvas>`, so no
image ever leaves the user's machine and no API key or backend is needed.

## What it does

**Two output modes**, from the same conversion run:

| Mode | Behaviour |
|---|---|
| **Add to board** | Creates a new image item per source image. The original is never modified or removed. Each new image gets a text caption above it reading e.g. `PNG → WebP` / `240 KB · 1920×1080`, and the item title becomes the filename (`photo.webp`). |
| **Download** | One image downloads directly. Several download as a single `.zip` (entries are stored, not re-compressed — images are already compressed). |

**Two placement strategies** when adding to the board:

- **Below each original** — the converted copy sits directly beneath its
  source, at the same board width, so the aspect ratio and on-board footprint
  match what was already there.
- **Together in a new frame** — every converted image is laid out as a grid
  inside one new frame, positioned clear of the originals. This is the safer
  choice for bulk runs: output can never land on top of another image.

## Formats

Target formats are **probed at runtime**, because browsers disagree about what
`canvas` can *encode* (as opposed to decode). Chrome, for example, decodes AVIF
but silently falls back to PNG when asked to encode it, so AVIF is only offered
where it genuinely works.

- **PNG** — lossless, keeps transparency.
- **JPEG** — lossy, quality slider, no transparency.
- **WebP** — lossy, quality slider, keeps transparency.
- **BMP** — 24-bit uncompressed, written by a small encoder in
  `src/formats.js` since `canvas` cannot produce BMP itself.
- **AVIF** — listed only if the browser can encode it.

Sources can be anything the browser decodes (PNG, JPEG, WebP, GIF, AVIF, BMP…).

When the target has no alpha channel, transparent pixels would otherwise render
black, so they are flattened onto a configurable background colour (white by
default).

## Bulk behaviour

Robustness matters more than raw speed here, so:

- Images are converted with **bounded concurrency** (3 at a time) rather than
  all at once, which keeps peak memory sane on large selections.
- **One bad image cannot sink the batch.** Every image is converted and written
  independently; failures are collected and listed per-file with the reason,
  and everything else still completes.
- A **progress bar and Cancel** cover long runs. Cancelling before the write
  phase leaves the board untouched.
- **Duplicate filenames are de-duplicated** (`same.png`, `same-2.png`), so a
  zip never silently drops an entry.
- Canvas has hard size limits that produce a blank image rather than an error,
  so oversized sources are **clamped automatically** (max edge 16384 px, max
  50 MP) and the result list says so.
- An optional **"Resize longest edge"** cap reduces pixel dimensions while
  leaving the on-board size unchanged — useful when a board write is rejected
  for being too large.
- Runs are capped at 200 images to keep one click from locking up the tab.

## Hosted build

The app is deployed to GitHub Pages from `main`:

<https://charliewinters.github.io/miro-image-convert/>

That URL is the **App URL / `sdkUri`** to register in the Developer Dashboard
(with scopes `boards:read` and `boards:write`). Pages is fine for hosting a
Miro app; only Marketplace submission requires somewhere else.

## Install on a Miro team

Installation URL (Developer Dashboard → **Share app**):

```
https://miro.com/app-install/?response_type=code&client_id=3458764684173420605&redirect_uri=%2Fapp-install%2Fconfirm%2F
```

Open it while signed in to Miro, choose the team to install onto, and confirm.
The app icon then appears in that team's board toolbar. The `client_id` in that
URL is the app's public client ID — it is not the client secret, which never
leaves the Developer Dashboard.

To install on another team, open the same link again and pick a different team.

## App icons

Two SVGs in `public/`, served from the Pages deployment alongside the app:

| File | Used for | Notes |
|---|---|---|
| `icon-outline.svg` | Board toolbar | 24x24, monochrome (`#050038`), no gradients — Miro recolours it to indigo |
| `icon-color.svg` | Panel header and Marketplace | 32x32, full colour |

Both follow [Miro's icon guidelines](https://developers.miro.com/docs/add-a-logo-to-your-app#check-the-app-icon-guidelines):
SVG, square, non-empty and under 5000 bytes (these are ~450 and ~630 bytes),
and the monochrome one uses exactly one colour with no gradients.

They share one glyph — a picture tile with an arrow leaving it — so the toolbar
and panel read as the same app. The colour version deliberately repeats that
composition rather than showing a richer source-to-target scene: it is rendered
at around 32px in the panel, where extra detail turns to mush.

## Install (development)

1. `npm install`
2. `npm start` — serves on <http://localhost:3000>
3. In the [Developer Dashboard](https://miro.com/app/settings/user-profile/apps),
   create an app on your dev team and apply `app-manifest.yaml`:
   - `sdkUri: http://localhost:3000`
   - scopes: `boards:read`, `boards:write`
4. Click **Install app and get OAuth token** to put it on a dev team board.
5. Open a board, select some images, click the app icon in the left toolbar.

The app also registers a right-click **"Convert image format"** action on
images. That API is experimental and private-app-only, so it degrades silently
to the toolbar icon if unavailable.

## Deploy

`npm run build` emits `dist/`. Asset paths are relative and filenames are
unhashed, so it can be served from any static host including a GitHub Pages
subpath. The included workflow (`.github/workflows/deploy.yml`) deploys `dist/`
to Pages on push to `main`, and fails the build if an entry point or its bundle
is missing rather than publishing a version that boards cannot load.

After deploying, **update `sdkUri` in the Developer Dashboard** to the deployed
HTTPS URL, or the board will keep loading localhost. The dashboard is
authoritative — editing `app-manifest.yaml` alone changes nothing.

## Layout

```
index.html      headless entry (sdkUri): toolbar icon + right-click action
panel.html      the panel UI
src/index.js    icon:click -> openPanel, custom action registration
src/panel.js    UI wiring, run orchestration, progress and results
src/convert.js  decode -> resize -> flatten -> encode, plus the worker pool
src/formats.js  format registry, capability probe, BMP encoder
src/board.js    board writes: below-original and in-frame placement
src/download.js single-file save and zip bundling
src/util.js     byte formatting, filename derivation and de-duplication
```

## Notes on the SDK

- Board image bytes come from `image.getDataUrl()`; converted images go back
  via `miro.board.createImage({url: <data URL>})`, which accepts base64 data
  URLs.
- A panel is a cross-origin iframe, where a scripted anchor click can be
  blocked by the iframe sandbox. So a download is attempted automatically *and*
  always rendered as a real link the user can click, which is the most
  permissive path available.
