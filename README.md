<div align="center">

# SubVid Live Extension

**Real-time local subtitles and translation for web videos.**

No uploads. No backend. No API keys.

[Original project](https://github.com/midudev/subvid.app) ·
[This fork](https://github.com/jooge1998/subvid-live-extension)

</div>

## About This Fork

This repository is a fork of [midudev/subvid.app](https://github.com/midudev/subvid.app).

The original project is a browser-based subtitle editor for uploaded videos. This fork keeps the original project structure, but adds a new `extension/` package: a Chrome extension prototype that brings the same local-first idea to videos already playing on websites such as YouTube, X, Facebook, Instagram, and similar pages.

The extension captures the active tab audio, transcribes it locally with Whisper, translates it locally when needed, and renders subtitles directly over the video player.

## Extension Features

- Real-time subtitle overlay on web videos.
- Local speech recognition with Whisper via transformers.js.
- Selectable speech model size: `tiny`, `base`, or `small`.
- Local translation with Chrome's built-in Translator API when available.
- Local model fallback for translation when the browser translator is unavailable.
- Original + translated subtitle display.
- Floating `Subvid` button over detected video players.
- Popup controls for:
  - source language
  - target language
  - speech model size
  - original text visibility
  - overlay button visibility
  - subtitle size
  - text color
  - background color
  - background opacity
- Custom extension icon in the toolbar and context menu.

## Screenshots

### Settings panel

Choose source/target language, speech model, subtitle style, and whether to show
overlay controls over the video.

![SubVid Live settings panel](extension/docs/images/popup-settings.png)

### Context menu

Right-click anywhere on the page → **Activar / detener subtítulos**. This also
grants the `activeTab` permission required for audio capture. The menu shows
the SubVid logo.

![SubVid Live context menu](extension/docs/images/context-menu.png)

### Subtitles on video

Dual-line subtitles (original + translation) rendered over the player. The
floating **Subvid** button toggles subtitles without opening the popup.

![SubVid Live subtitles on Facebook](extension/docs/images/subtitles-overlay.png)

More details (in Spanish) in [`extension/README.md`](extension/README.md).

## Privacy

The extension is local-first:

- Video files are not uploaded.
- Audio is captured from the active tab and processed locally in the browser.
- AI models run in browser workers with WASM/WebGPU where available.
- No backend or API keys are required.

Model files are downloaded on first use and cached by the browser.

## Install Locally

```sh
cd extension
npm install
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `extension/dist`.

## Usage

1. Open a page with a video.
2. Click the SubVid Live extension icon.
3. Choose the source language, target language, and model size.
4. Click **Activate subtitles**.
5. Subtitles will appear over the detected video player.

You can also use the floating `Subvid` button over the video after the extension has been invoked on the current tab.

> Chrome requires an extension invocation before tab audio can be captured. Use the extension icon, context menu, or keyboard shortcut first; after that, the floating button can toggle subtitles directly.

## Extension Structure

```text
extension/
├── manifest.config.ts
├── src/
│   ├── background.ts
│   ├── content/
│   │   ├── content.ts
│   │   └── content.css
│   ├── offscreen/
│   │   ├── offscreen.ts
│   │   ├── asr.worker.ts
│   │   └── translation.worker.ts
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   └── shared/
│       ├── languages.ts
│       └── types.ts
└── vite.config.ts
```

## Tech Notes

- `chrome.tabCapture` captures active tab audio.
- `chrome.offscreen` hosts the audio pipeline and model workers.
- The content script renders subtitles over the visible video player.
- The popup manages language, model, and style preferences.
- The extension is built with Vite and Manifest V3.

## Credits

This work is based on [midudev/subvid.app](https://github.com/midudev/subvid.app), which provides the original local-first subtitle generation and editing app.

## License

See the original repository license for details.
