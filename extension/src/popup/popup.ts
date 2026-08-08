import { LANGS } from "../shared/languages.ts"
import { formatLatencyDebugPanel } from "../shared/latencyDebug.ts"
import {
  TRANSLATION_ENGINE_OPTIONS,
  normalizeTranslationEngine,
} from "../shared/translationEngines.ts"
import {
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  type LatencyMode,
  type SessionState,
  type Settings,
  type StatusPhase,
  type TranslationBackendInfo,
  type TranslationEngineChoice,
} from "../shared/types.ts"

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T

const sourceSelect = $<HTMLSelectElement>("sourceLang")
const targetSelect = $<HTMLSelectElement>("targetLang")
const modelSelect = $<HTMLSelectElement>("model")
const translationEngineSelect = $<HTMLSelectElement>("translationEngine")
const latencyModeSelect = $<HTMLSelectElement>("latencyMode")
const dualCheck = $<HTMLInputElement>("dual")
const speakTranslationCheck = $<HTMLInputElement>("speakTranslation")
const duckOriginalCheck = $<HTMLInputElement>("duckOriginal")
const debugLatencyCheck = $<HTMLInputElement>("debugLatency")
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
const latencyEl = $<HTMLParagraphElement>("latency")
const translationModelEl = $<HTMLParagraphElement>("translationModel")
const runGemmaDiagBtn = $<HTMLButtonElement>("runGemmaDiag")
const resetModelsBtn = $<HTMLButtonElement>("resetModels")
const gemmaDiagStatus = $<HTMLParagraphElement>("gemmaDiagStatus")
const gemmaDiagReport = $<HTMLPreElement>("gemmaDiagReport")

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
  const mode = value?.latencyMode === "quality" ? "quality" : "live"
  const engine = normalizeTranslationEngine(value?.translationEngine, value)
  return {
    ...DEFAULT_SETTINGS,
    ...(value || {}),
    latencyMode: mode as LatencyMode,
    speakTranslation: value?.speakTranslation === true,
    duckOriginal: value?.duckOriginal !== false,
    translationEngine: engine,
    preferTranslateGemma: engine === "auto" || engine === "translategemma",
    translationModelSize:
      engine === "translategemma" || engine === "auto" ? "4b" : "fallback",
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      ...(value?.style || {}),
    },
  }
}

function fillLanguages() {
  sourceSelect.add(new Option("Auto (detectar)", "auto"))
  for (const [code, lang] of Object.entries(LANGS)) {
    sourceSelect.add(new Option(lang.label, code))
  }
  targetSelect.add(new Option("No traducir (solo subtítulos)", "none"))
  for (const [code, lang] of Object.entries(LANGS)) {
    targetSelect.add(new Option(lang.label, code))
  }
}

function fillTranslationEngines() {
  translationEngineSelect.textContent = ""
  for (const opt of TRANSLATION_ENGINE_OPTIONS) {
    translationEngineSelect.add(new Option(opt.label, opt.id))
  }
}

function applySettingsToUi() {
  sourceSelect.value = settings.sourceLang
  targetSelect.value = settings.targetLang
  modelSelect.value = settings.model
  translationEngineSelect.value = settings.translationEngine || "auto"
  latencyModeSelect.value = settings.latencyMode || "live"
  dualCheck.checked = settings.dual
  speakTranslationCheck.checked = settings.speakTranslation
  duckOriginalCheck.checked = settings.duckOriginal !== false
  debugLatencyCheck.checked = settings.debugLatency
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
    settings.sourceLang !== "auto" &&
    settings.targetLang === settings.sourceLang
  ) {
    hint.textContent =
      "El idioma destino es igual al de origen: solo se mostrarán subtítulos."
    hint.hidden = false
  } else if (settings.sourceLang === "auto") {
    hint.textContent =
      "Idioma Auto: Whisper detecta el idioma y se ajusta la traducción."
    hint.hidden = false
  } else if (settings.speakTranslation) {
    hint.textContent =
      "TTS activo: oirás la traducción con la voz del sistema. Activa «Bajar audio original» para un efecto más de doblaje."
    hint.hidden = false
  } else if (settings.latencyMode === "quality") {
    hint.textContent =
      "Modo Quality: frases más largas y más contexto (más latencia)."
    hint.hidden = false
  } else {
    hint.hidden = true
  }
  dualCheck.disabled = settings.targetLang === "none"
  speakTranslationCheck.disabled = settings.targetLang === "none"
  duckOriginalCheck.disabled =
    settings.targetLang === "none" || !speakTranslationCheck.checked
}

function readSettingsFromUi(): Settings {
  const engine = normalizeTranslationEngine(
    translationEngineSelect.value as TranslationEngineChoice,
  )
  return {
    sourceLang: sourceSelect.value,
    targetLang: targetSelect.value,
    model: modelSelect.value as Settings["model"],
    dual: dualCheck.checked,
    debugLatency: debugLatencyCheck.checked,
    speakTranslation: speakTranslationCheck.checked,
    duckOriginal: duckOriginalCheck.checked,
    translationEngine: engine,
    preferTranslateGemma: engine === "auto" || engine === "translategemma",
    translationModelSize:
      engine === "translategemma" || engine === "auto" ? "4b" : "fallback",
    latencyMode:
      latencyModeSelect.value === "quality" ? "quality" : "live",
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
  for (const el of [sourceSelect, targetSelect, modelSelect, latencyModeSelect]) {
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
    latencyEl.hidden = true
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
  if (s.targetLang === "none") return
  // Con auto no conocemos el origen: precargamos en→destino (par frecuente).
  const sourceLanguage = s.sourceLang === "auto" ? "en" : s.sourceLang
  if (s.targetLang === sourceLanguage) return
  try {
    const availability = await Translator.availability({
      sourceLanguage,
      targetLanguage: s.targetLang,
    })
    if (availability === "unavailable" || availability === "available") return

    renderStatus("downloading", "Descargando traductor de Chrome…", 0)
    const translator = await Translator.create({
      sourceLanguage,
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

async function resetModels() {
  if (
    !confirm(
      "¿Borrar modelos en caché y memoria?\nTendrás que volver a descargarlos la próxima vez.",
    )
  ) {
    return
  }
  resetModelsBtn.disabled = true
  gemmaDiagStatus.hidden = false
  gemmaDiagStatus.textContent = "Borrando modelos y caché…"
  try {
    const response = await sendToBackground({ type: "reset-models" })
    if (!response?.ok) {
      gemmaDiagStatus.textContent = `Reset FAIL: ${response?.error || "error"}`
      return
    }
    gemmaDiagStatus.textContent = `Reset OK (caches borradas: ${response.deleted ?? "?"}). Al activar se descargarán de nuevo.`
  } catch (error: any) {
    gemmaDiagStatus.textContent = `Reset FAIL: ${String(error?.message || error)}`
  } finally {
    resetModelsBtn.disabled = false
  }
}

async function runTranslateGemmaDiagnostic() {
  runGemmaDiagBtn.disabled = true
  gemmaDiagStatus.hidden = false
  gemmaDiagReport.hidden = true
  gemmaDiagStatus.textContent =
    "Diagnóstico sin cascade. 1ª carga puede tardar 10–20 min (~2.9 GB)…"
  try {
    const response = await sendToBackground({
      type: "run-translategemma-diagnostic",
    })
    if (!response?.ok) {
      gemmaDiagStatus.textContent = `FAIL: ${response?.error || "error desconocido"}`
      if (response?.report?.textReport) {
        gemmaDiagReport.textContent = response.report.textReport
        gemmaDiagReport.hidden = false
      }
      return
    }
    const report = response.report
    gemmaDiagStatus.textContent = report?.conclusion || "Diagnóstico terminado"
    gemmaDiagReport.textContent =
      report?.textReport || JSON.stringify(report, null, 2)
    gemmaDiagReport.hidden = false
  } catch (error: any) {
    gemmaDiagStatus.textContent = `FAIL: ${String(error?.message || error)}`
  } finally {
    runGemmaDiagBtn.disabled = false
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
    if (settings.debugLatency && message.metrics) {
      latencyEl.textContent = formatLatencyDebugPanel(message.metrics)
      latencyEl.hidden = !latencyEl.textContent
    } else {
      latencyEl.hidden = true
    }
  }
  if (message.type === "translation-backend") {
    renderTranslationBackend(message.backend)
  }
  if (message.type === "translategemma-diagnostic-progress") {
    gemmaDiagStatus.hidden = false
    const pct =
      typeof message.progress === "number"
        ? ` ${Math.round(message.progress * 100)}%`
        : ""
    gemmaDiagStatus.textContent = `${message.phase || "diag"}: ${message.detail || ""}${pct}`
  }
  if (message.type === "translategemma-diagnostic-result" && message.report) {
    gemmaDiagStatus.hidden = false
    gemmaDiagStatus.textContent =
      message.report.conclusion || "Diagnóstico terminado"
    gemmaDiagReport.textContent =
      message.report.textReport || JSON.stringify(message.report, null, 2)
    gemmaDiagReport.hidden = false
    runGemmaDiagBtn.disabled = false
  }
})

async function init() {
  fillLanguages()
  fillTranslationEngines()
  await getActiveTab()

  const stored = await chrome.storage.local.get(["settings", "overlayControlsVisible"])
  settings = normalizeSettings(stored.settings)
  showOverlayControlsCheck.checked = stored.overlayControlsVisible !== false
  applySettingsToUi()

  for (const el of [
    sourceSelect,
    targetSelect,
    modelSelect,
    translationEngineSelect,
    latencyModeSelect,
    dualCheck,
    speakTranslationCheck,
    duckOriginalCheck,
    debugLatencyCheck,
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
  runGemmaDiagBtn.addEventListener("click", () => void runTranslateGemmaDiagnostic())
  resetModelsBtn.addEventListener("click", () => void resetModels())

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
