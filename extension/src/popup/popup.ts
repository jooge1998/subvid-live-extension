import { LANGS } from "../shared/languages.ts"
import {
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  type SessionState,
  type Settings,
  type StatusPhase,
  type TranslationBackendInfo,
} from "../shared/types.ts"

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

const sourceSelect = $<HTMLSelectElement>("sourceLang")
const targetSelect = $<HTMLSelectElement>("targetLang")
const modelSelect = $<HTMLSelectElement>("model")
const dualCheck = $<HTMLInputElement>("dual")
const showOverlayControlsCheck = $<HTMLInputElement>("showOverlayControls")
const fontScaleInput = $<HTMLInputElement>("fontScale")
const fontScaleValue = $<HTMLElement>("fontScaleValue")
const textColorInput = $<HTMLInputElement>("textColor")
const backgroundColorInput = $<HTMLInputElement>("backgroundColor")
const backgroundOpacityInput = $<HTMLInputElement>("backgroundOpacity")
const backgroundOpacityValue = $<HTMLElement>("backgroundOpacityValue")
const hint = $<HTMLParagraphElement>("hint")
const toggleBtn = $<HTMLButtonElement>("toggle")
const statusBox = $<HTMLElement>("statusBox")
const statusDot = $<HTMLSpanElement>("statusDot")
const statusText = $<HTMLSpanElement>("statusText")
const bar = $<HTMLDivElement>("bar")
const barFill = $<HTMLDivElement>("barFill")
const lastCue = $<HTMLParagraphElement>("lastCue")
const translationModelEl = $<HTMLParagraphElement>("translationModel")

let settings: Settings = { ...DEFAULT_SETTINGS }
let sessionActive = false
let busy = false

const PHASE_LABELS: Record<StatusPhase, string> = {
  idle: "Inactivo",
  starting: "Iniciando…",
  downloading: "Descargando modelos…",
  loading: "Cargando modelos…",
  listening: "Escuchando el video…",
  transcribing: "Transcribiendo…",
  error: "Error",
}

function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(value || {}),
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      ...(value?.style || {}),
    },
  }
}

function fillLanguages() {
  for (const [code, lang] of Object.entries(LANGS)) {
    sourceSelect.add(new Option(lang.label, code))
  }
  targetSelect.add(new Option("No traducir (solo subtítulos)", "none"))
  for (const [code, lang] of Object.entries(LANGS)) {
    targetSelect.add(new Option(lang.label, code))
  }
}

function applySettingsToUi() {
  sourceSelect.value = settings.sourceLang
  targetSelect.value = settings.targetLang
  modelSelect.value = settings.model
  dualCheck.checked = settings.dual
  fontScaleInput.value = String(settings.style.fontScale)
  textColorInput.value = settings.style.textColor
  backgroundColorInput.value = settings.style.backgroundColor
  backgroundOpacityInput.value = String(settings.style.backgroundOpacity)
  renderStyleValues()
  syncHint()
}

function renderStyleValues() {
  fontScaleValue.textContent = `${Math.round(Number(fontScaleInput.value) * 100)}%`
  backgroundOpacityValue.textContent = `${Math.round(
    Number(backgroundOpacityInput.value) * 100,
  )}%`
}

function syncHint() {
  if (
    settings.targetLang !== "none" &&
    settings.targetLang === settings.sourceLang
  ) {
    hint.textContent =
      "El idioma destino es igual al de origen: solo se mostrarán subtítulos."
    hint.hidden = false
  } else {
    hint.hidden = true
  }
  dualCheck.disabled = settings.targetLang === "none"
}

function readSettingsFromUi(): Settings {
  return {
    sourceLang: sourceSelect.value,
    targetLang: targetSelect.value,
    model: modelSelect.value as Settings["model"],
    dual: dualCheck.checked,
    style: {
      fontScale: Number(fontScaleInput.value),
      textColor: textColorInput.value,
      backgroundColor: backgroundColorInput.value,
      backgroundOpacity: Number(backgroundOpacityInput.value),
    },
  }
}

async function saveOverlayControlsVisible(visible: boolean) {
  await chrome.storage.local.set({ overlayControlsVisible: visible })
  await sendToBackground({ type: "set-overlay-controls", visible }).catch(
    () => undefined,
  )
}

async function saveSettings() {
  settings = readSettingsFromUi()
  renderStyleValues()
  syncHint()
  if (settings.targetLang === "none") renderTranslationBackend(null)
  await chrome.storage.local.set({ settings })
  await sendToBackground({ type: "update-settings", settings }).catch(
    () => undefined,
  )
}

function setControlsEnabled(enabled: boolean) {
  for (const el of [sourceSelect, targetSelect, modelSelect]) {
    el.disabled = !enabled
  }
  syncHint()
}

function renderSession() {
  toggleBtn.dataset.state = sessionActive ? "active" : "idle"
  toggleBtn.textContent = sessionActive
    ? "Detener subtítulos"
    : "Activar subtítulos"
  setControlsEnabled(!sessionActive)
  if (!sessionActive) {
    statusBox.hidden = true
    lastCue.hidden = true
    translationModelEl.hidden = true
    bar.hidden = true
  }
}

function renderTranslationBackend(backend: TranslationBackendInfo | null | undefined) {
  if (!backend || settings.targetLang === "none") {
    translationModelEl.hidden = true
    translationModelEl.removeAttribute("data-backend")
    return
  }
  translationModelEl.hidden = false
  translationModelEl.dataset.backend = backend.id
  const modelPart = backend.model ? ` (${backend.model})` : ""
  translationModelEl.textContent = `Traducción: ${backend.label}${modelPart}`
}

function renderStatus(phase: StatusPhase, detail?: string, progress?: number) {
  statusBox.hidden = false
  statusDot.dataset.phase = phase
  statusText.textContent = detail || PHASE_LABELS[phase] || phase
  if (typeof progress === "number") {
    bar.hidden = false
    barFill.style.width = `${Math.round(progress * 100)}%`
  } else {
    bar.hidden = true
  }
}

async function sendToBackground(message: Record<string, unknown>) {
  return chrome.runtime.sendMessage({ target: "background", ...message })
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

// El traductor integrado de Chrome (mejor calidad que Marian/NLLB) exige un
// gesto de usuario para descargar su modelo. El clic en "Activar" lo es, así
// que aprovechamos para descargarlo aquí; después el offscreen lo encuentra
// disponible y lo usa en lugar de los modelos locales.
async function predownloadChromeTranslator(s: Settings) {
  const Translator = (self as any).Translator
  if (!Translator) return
  if (s.targetLang === "none" || s.targetLang === s.sourceLang) return
  try {
    const availability = await Translator.availability({
      sourceLanguage: s.sourceLang,
      targetLanguage: s.targetLang,
    })
    if (availability === "unavailable" || availability === "available") return

    renderStatus("downloading", "Descargando traductor de Chrome…", 0)
    const translator = await Translator.create({
      sourceLanguage: s.sourceLang,
      targetLanguage: s.targetLang,
      monitor(m: any) {
        m.addEventListener("downloadprogress", (e: any) => {
          if (typeof e?.loaded === "number") {
            renderStatus(
              "downloading",
              "Descargando traductor de Chrome…",
              Math.min(1, e.loaded),
            )
          }
        })
      },
    })
    translator?.destroy?.()
  } catch {
    // Sin soporte o sin permiso: el offscreen usará Marian/NLLB locales.
  }
}

async function toggle() {
  if (busy) return
  busy = true
  toggleBtn.disabled = true
  statusBox.hidden = false
  renderStatus("starting", "Preparando SubVid…")
  try {
    if (sessionActive) {
      await sendToBackground({ type: "stop" })
      sessionActive = false
      renderSession()
      return
    }

    const tab = await getActiveTab()
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      renderStatus("error", "Abre una página con video (YouTube, X, etc.)")
      statusBox.hidden = false
      return
    }

    await saveSettings()
    await predownloadChromeTranslator(settings)
    const response = await sendToBackground({
      type: "start",
      tabId: tab.id,
      settings,
    })
    if (response?.ok) {
      sessionActive = true
      renderSession()
      renderStatus("starting", "Iniciando captura de audio…")
    } else {
      renderStatus("error", response?.error || "No se pudo iniciar la captura")
    }
  } catch (error: any) {
    renderStatus("error", String(error?.message || error))
  } finally {
    busy = false
    toggleBtn.disabled = false
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== "popup") return
  if (message.type === "status") {
    if (message.phase === "idle") {
      sessionActive = false
      renderSession()
      return
    }
    renderStatus(message.phase, message.detail, message.progress)
  }
  if (message.type === "cue" && sessionActive) {
    lastCue.textContent = message.translated
      ? `“${message.original}” → “${message.translated}”`
      : `“${message.original}”`
    lastCue.hidden = false
    if (message.translationBackend) {
      renderTranslationBackend(message.translationBackend)
    }
  }
  if (message.type === "translation-backend") {
    renderTranslationBackend(message.backend)
  }
})

async function init() {
  fillLanguages()
  await getActiveTab()

  const stored = await chrome.storage.local.get(["settings", "overlayControlsVisible"])
  settings = normalizeSettings(stored.settings)
  showOverlayControlsCheck.checked = stored.overlayControlsVisible !== false
  applySettingsToUi()

  for (const el of [
    sourceSelect,
    targetSelect,
    modelSelect,
    dualCheck,
    fontScaleInput,
    textColorInput,
    backgroundColorInput,
    backgroundOpacityInput,
  ]) {
    el.addEventListener("change", () => void saveSettings())
    el.addEventListener("input", () => void saveSettings())
  }
  showOverlayControlsCheck.addEventListener("change", () => {
    void saveOverlayControlsVisible(showOverlayControlsCheck.checked)
  })
  toggleBtn.addEventListener("click", () => void toggle())

  try {
    const response = await sendToBackground({ type: "get-state" })
    const state: SessionState | undefined = response?.state
    if (state?.active) {
      sessionActive = true
      if (state.settings) {
        settings = normalizeSettings(state.settings)
        applySettingsToUi()
      }
      renderSession()
      if (state.status) {
        renderStatus(state.status.phase, state.status.detail, state.status.progress)
      }
      renderTranslationBackend(state.translationBackend)
    } else {
      renderSession()
    }
  } catch {
    renderSession()
  }
}

void init()
