import { defineManifest } from "@crxjs/vite-plugin"

export default defineManifest({
  manifest_version: 3,
  name: "SubVid Live — Subtítulos en tiempo real",
  description:
    "Subtítulos y traducción en tiempo real para videos de YouTube, X, Facebook, Instagram y más. 100% local, sin APIs ni backend.",
  version: "1.0.0",
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  minimum_chrome_version: "116",
  permissions: [
    "tabCapture",
    "offscreen",
    "storage",
    "activeTab",
    "contextMenus",
    "scripting",
    "tts",
  ],
  commands: {
    "toggle-subtitles": {
      suggested_key: {
        default: "Ctrl+Shift+Y",
        mac: "Command+Shift+Y",
        windows: "Ctrl+Shift+Y",
        linux: "Ctrl+Shift+Y",
      },
      description: "Activar / detener subtítulos en la pestaña actual",
    },
  },
  host_permissions: [
    "https://huggingface.co/*",
    "https://*.huggingface.co/*",
    "https://*.hf.co/*",
  ],
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/popup.html",
    default_title: "SubVid Live",
    default_icon: {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/content.ts"],
      run_at: "document_idle",
      all_frames: true,
    },
  ],
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  },
})
