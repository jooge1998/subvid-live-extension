// Content script: dibuja los subtítulos generados en tiempo real encima del
// video más grande visible (YouTube, X, Facebook, Instagram…) y muestra un
// botón flotante para activar/detener los subtítulos sin abrir el popup.

import "./content.css"
import { LANGS } from "../shared/languages.ts"
import {
  DEFAULT_SUBTITLE_STYLE,
  type Settings,
  type SubtitleStyle,
} from "../shared/types.ts"

type Phase =
  | "idle"
  | "starting"
  | "downloading"
  | "loading"
  | "listening"
  | "transcribing"
  | "error"

let sessionActive = false
let dual = false
let subtitleStyle: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE }
let gotFirstCue = false
let fabBusy = false

let overlay: HTMLDivElement | null = null
let cueEl: HTMLDivElement | null = null
let originalEl: HTMLDivElement | null = null
let textEl: HTMLDivElement | null = null
let statusEl: HTMLDivElement | null = null
let fabEl: HTMLButtonElement | null = null
let toastEl: HTMLDivElement | null = null
let transcriptToggleEl: HTMLButtonElement | null = null
let transcriptPanelEl: HTMLDivElement | null = null
let transcriptListEl: HTMLDivElement | null = null
let transcriptModeEl: HTMLSelectElement | null = null
let transcriptExpandEl: HTMLButtonElement | null = null
let transcriptCloseEl: HTMLButtonElement | null = null
let downloadVideoEl: HTMLButtonElement | null = null

let trackedVideo: HTMLElement | null = null
let looping = false
let rafId = 0
let frameCount = 0
let hideTimer: ReturnType<typeof setTimeout> | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined
let transcriptEntries = 0
let currentSettings: Partial<Settings> | undefined

// Posición del subtítulo (en % del reproductor), ajustable arrastrando y
// persistida entre sesiones.
let cueLeftPct = 50
let cueBottomPct = 6

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

function ensureOverlay() {
  if (overlay) return
  overlay = document.createElement("div")
  overlay.className = "subvid-overlay"

  statusEl = document.createElement("div")
  statusEl.className = "subvid-status"

  cueEl = document.createElement("div")
  cueEl.className = "subvid-cue"
  originalEl = document.createElement("div")
  originalEl.className = "subvid-cue-original"
  textEl = document.createElement("div")
  textEl.className = "subvid-cue-text"
  cueEl.append(originalEl, textEl)
  cueEl.title = "Arrastra para mover los subtítulos"
  wireCueDrag()

  fabEl = document.createElement("button")
  fabEl.className = "subvid-fab"
  fabEl.type = "button"
  fabEl.textContent = "Subvid"
  fabEl.title = "SubVid: activar/detener subtítulos"
  fabEl.addEventListener("click", onFabClick)

  transcriptToggleEl = document.createElement("button")
  transcriptToggleEl.className = "subvid-transcript-toggle"
  transcriptToggleEl.type = "button"
  transcriptToggleEl.textContent = "Texto"
  transcriptToggleEl.title = "Mostrar / ocultar historial de subtítulos"
  transcriptToggleEl.addEventListener("click", toggleTranscriptPanel)

  downloadVideoEl = document.createElement("button")
  downloadVideoEl.className = "subvid-download-video"
  downloadVideoEl.type = "button"
  downloadVideoEl.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>'
  downloadVideoEl.title = "Descargar video detectado"
  downloadVideoEl.addEventListener("click", downloadCurrentVideo)

  transcriptPanelEl = document.createElement("div")
  transcriptPanelEl.className = "subvid-transcript-panel"
  transcriptPanelEl.dataset.on = "false"
  transcriptPanelEl.dataset.view = "translated"

  const transcriptHeader = document.createElement("div")
  transcriptHeader.className = "subvid-transcript-header"

  transcriptModeEl = document.createElement("select")
  transcriptModeEl.className = "subvid-transcript-mode"
  transcriptModeEl.title = "Cambiar vista del historial"
  transcriptModeEl.addEventListener("change", () => {
    if (transcriptPanelEl && transcriptModeEl) {
      transcriptPanelEl.dataset.view = transcriptModeEl.value
    }
  })

  const transcriptTitle = document.createElement("div")
  transcriptTitle.className = "subvid-transcript-title"
  transcriptTitle.textContent = "Subtitulado instantáneo"

  const transcriptActions = document.createElement("div")
  transcriptActions.className = "subvid-transcript-actions"

  transcriptExpandEl = document.createElement("button")
  transcriptExpandEl.className = "subvid-transcript-action"
  transcriptExpandEl.type = "button"
  transcriptExpandEl.textContent = "□"
  transcriptExpandEl.title = "Agrandar / reducir"
  transcriptExpandEl.addEventListener("click", toggleTranscriptExpanded)

  transcriptCloseEl = document.createElement("button")
  transcriptCloseEl.className = "subvid-transcript-action"
  transcriptCloseEl.type = "button"
  transcriptCloseEl.textContent = "×"
  transcriptCloseEl.title = "Cerrar historial"
  transcriptCloseEl.addEventListener("click", closeTranscriptPanel)

  transcriptActions.append(transcriptExpandEl, transcriptCloseEl)
  transcriptHeader.append(transcriptModeEl, transcriptTitle, transcriptActions)

  transcriptListEl = document.createElement("div")
  transcriptListEl.className = "subvid-transcript-list"
  transcriptPanelEl.append(transcriptHeader, transcriptListEl)

  toastEl = document.createElement("div")
  toastEl.className = "subvid-toast"

  overlay.append(
    statusEl,
    cueEl,
    fabEl,
    transcriptToggleEl,
    downloadVideoEl,
    transcriptPanelEl,
    toastEl,
  )
  applySubtitleStyle()
  syncTranscriptModeOptions()
  applyCuePosition()
  mountOverlay()
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "")
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return "255, 255, 255"
  const value = Number.parseInt(normalized, 16)
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`
}

function normalizeStyle(style?: Partial<SubtitleStyle>): SubtitleStyle {
  return {
    ...DEFAULT_SUBTITLE_STYLE,
    ...(style || {}),
  }
}

function applySubtitleStyle() {
  if (!overlay) return
  overlay.style.setProperty("--subvid-text-color", subtitleStyle.textColor)
  overlay.style.setProperty(
    "--subvid-bg-rgb",
    hexToRgb(subtitleStyle.backgroundColor),
  )
  overlay.style.setProperty(
    "--subvid-bg-opacity",
    String(subtitleStyle.backgroundOpacity),
  )
}

function applySettings(settings?: Partial<Settings>) {
  currentSettings = settings
  dual = !!settings?.dual
  subtitleStyle = normalizeStyle(settings?.style)
  applySubtitleStyle()
  syncTranscriptModeOptions()
  positionOverlay()
}

function languageLabel(code: string | undefined, fallback: string) {
  if (!code || code === "none") return fallback
  return LANGS[code]?.label || code
}

function syncTranscriptModeOptions() {
  if (!transcriptModeEl) return
  const previous = transcriptModeEl.value || "translated"
  const sourceLabel = languageLabel(currentSettings?.sourceLang, "Original")
  const targetLabel = languageLabel(currentSettings?.targetLang, "Traducción")

  transcriptModeEl.textContent = ""
  transcriptModeEl.add(new Option(targetLabel, "translated"))
  transcriptModeEl.add(new Option(sourceLabel, "original"))
  transcriptModeEl.add(new Option("Ambos", "both"))
  transcriptModeEl.value = ["translated", "original", "both"].includes(previous)
    ? previous
    : "translated"
  if (transcriptPanelEl) transcriptPanelEl.dataset.view = transcriptModeEl.value
}

function mountOverlay() {
  if (!overlay) return
  // Montamos en la página completa, no dentro del reproductor. Así los
  // subtítulos y el historial pueden moverse fuera del video sin quedar
  // recortados por overflow:hidden de YouTube/X/Facebook.
  const host = document.fullscreenElement || document.body || document.documentElement
  overlay.dataset.mount = "fixed"
  if (overlay.parentElement !== host) host.appendChild(overlay)
}

function isVisibleRect(rect: DOMRect) {
  return rect.width >= 180 && rect.height >= 100 && rect.bottom > 0 && rect.right > 0
}

function scoreRect(rect: DOMRect) {
  const viewportW = Math.max(1, window.innerWidth)
  const viewportH = Math.max(1, window.innerHeight)
  const visibleW = Math.max(0, Math.min(rect.right, viewportW) - Math.max(rect.left, 0))
  const visibleH = Math.max(0, Math.min(rect.bottom, viewportH) - Math.max(rect.top, 0))
  return visibleW * visibleH
}

function findVideoHost(video: HTMLVideoElement): HTMLElement {
  const videoRect = video.getBoundingClientRect()
  let host: HTMLElement = video
  let parent = video.parentElement
  let depth = 0
  while (parent && parent !== document.body && depth < 8) {
    const rect = parent.getBoundingClientRect()
    const similarSize =
      rect.width >= videoRect.width * 0.95 &&
      rect.height >= videoRect.height * 0.95 &&
      rect.width <= videoRect.width * 1.35 &&
      rect.height <= videoRect.height * 1.55
    if (similarSize) host = parent
    parent = parent.parentElement
    depth++
  }
  return host === video ? video.parentElement || video : host
}

function pickVideo(): HTMLElement | null {
  let bestVideo: HTMLVideoElement | null = null
  let bestArea = 0
  for (const video of document.querySelectorAll("video")) {
    const rect = video.getBoundingClientRect()
    const area = scoreRect(rect)
    if (isVisibleRect(rect) && area > bestArea) {
      bestVideo = video
      bestArea = area
    }
  }
  if (bestVideo) return findVideoHost(bestVideo)

  // X/Facebook/Instagram pueden exponer el reproductor visible como div/button
  // aunque el video real esté oculto o sea reemplazado temporalmente.
  const selectors = [
    '[data-testid*="video" i]',
    '[aria-label*="video" i]',
    '[aria-label*="reproducir" i]',
    '[aria-label*="play" i]',
    '[role="button"]',
  ].join(",")
  let bestContainer: HTMLElement | null = null
  bestArea = 0
  for (const el of document.querySelectorAll<HTMLElement>(selectors)) {
    const rect = el.getBoundingClientRect()
    const area = scoreRect(rect)
    if (isVisibleRect(rect) && area > bestArea) {
      bestContainer = el
      bestArea = area
    }
  }
  return bestContainer
}

function positionOverlay() {
  if (!overlay) return
  if (!trackedVideo?.isConnected) {
    overlay.dataset.visible = "false"
    return
  }
  if (!overlay.isConnected) mountOverlay()
  const rect = trackedVideo.getBoundingClientRect()
  if (rect.width < 100 || rect.height < 60) {
    overlay.dataset.visible = "false"
    return
  }
  overlay.dataset.visible = "true"
  overlay.style.left = `${rect.left}px`
  overlay.style.top = `${rect.top}px`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
  const fontSize =
    Math.max(13, Math.min(30, rect.width * 0.022)) * subtitleStyle.fontScale
  overlay.style.fontSize = `${fontSize}px`
}

function startLoop() {
  if (looping) return
  looping = true
  rafId = requestAnimationFrame(loop)
}

function stopLoop() {
  looping = false
  cancelAnimationFrame(rafId)
}

function loop() {
  if (!looping) return
  frameCount++
  if (frameCount % 30 === 0 || !trackedVideo || !trackedVideo.isConnected) {
    // Algunas SPAs (X, FB) reconstruyen el DOM y pueden llevarse el overlay:
    // si quedó desconectado, lo re-montamos.
    if (!overlay?.isConnected) mountOverlay()
    trackedVideo = pickVideo()
    if (!trackedVideo) {
      if (overlay) overlay.dataset.visible = "false"
      // En X el nodo <video> puede reemplazarse temporalmente. No detenemos el
      // loop para que el botón/subtítulos reaparezcan apenas vuelva el video.
      rafId = requestAnimationFrame(loop)
      return
    }
    mountOverlay()
  }
  positionOverlay()
  rafId = requestAnimationFrame(loop)
}

// Busca videos periódicamente (SPA, lazy-load) y mantiene el botón visible.
let scanTimer: ReturnType<typeof setInterval> | undefined

function scanTick() {
  // Si la extensión se recargó, este script queda huérfano: nos retiramos
  // para no duplicar overlays con el script nuevo que se inyecte.
  if (!chrome.runtime?.id) {
    teardown()
    return
  }
  if (looping) return
  const video = pickVideo()
  if (!video) return
  trackedVideo = video
  ensureOverlay()
  startLoop()
}

function teardown() {
  if (scanTimer) clearInterval(scanTimer)
  scanTimer = undefined
  stopLoop()
  clearTimeout(hideTimer)
  clearTimeout(toastTimer)
  overlay?.remove()
  overlay = null
}

// ---------------------------------------------------------------------------
// Botón flotante
// ---------------------------------------------------------------------------

function setFabState(state: "idle" | "busy" | "active") {
  if (!fabEl) return
  fabEl.dataset.state = state
  fabEl.title =
    state === "active"
      ? "SubVid: detener subtítulos"
      : "SubVid: activar subtítulos"
}

async function onFabClick(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  if (fabBusy) return
  fabBusy = true
  setFabState("busy")
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "toggle-from-page",
    })
    if (!response?.ok) {
      const error = String(response?.error || "")
      if (/invoked|activeTab/i.test(error)) {
        showToast(
          "Primera vez en esta pestaña: haz clic derecho → «Activar / detener subtítulos», pulsa Ctrl+Shift+S o el icono de la extensión. Después este botón funcionará directo.",
          7000,
        )
      } else {
        showToast(error || "No se pudo iniciar la captura")
      }
      setFabState(sessionActive ? "active" : "idle")
    }
    // El estado definitivo llega por session-started / session-stopped.
  } catch {
    setFabState(sessionActive ? "active" : "idle")
  } finally {
    fabBusy = false
  }
}

function showToast(message: string, ms = 4000) {
  if (!toastEl) return
  toastEl.textContent = message
  toastEl.dataset.on = "true"
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.dataset.on = "false"
  }, ms)
}

function toggleTranscriptPanel(event?: MouseEvent) {
  event?.preventDefault()
  event?.stopPropagation()
  if (!transcriptPanelEl) return
  transcriptPanelEl.dataset.on =
    transcriptPanelEl.dataset.on === "true" ? "false" : "true"
}

function closeTranscriptPanel(event?: MouseEvent) {
  event?.preventDefault()
  event?.stopPropagation()
  if (transcriptPanelEl) transcriptPanelEl.dataset.on = "false"
}

function toggleTranscriptExpanded(event?: MouseEvent) {
  event?.preventDefault()
  event?.stopPropagation()
  if (!transcriptPanelEl) return
  transcriptPanelEl.dataset.expanded =
    transcriptPanelEl.dataset.expanded === "true" ? "false" : "true"
}

async function downloadCurrentVideo(event?: MouseEvent) {
  event?.preventDefault()
  event?.stopPropagation()
  try {
    showToast("Buscando la mejor calidad detectada…")
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "download-best-stream",
    })
    if (response?.ok) {
      showToast(response.note ? `Descarga iniciada. ${response.note}` : "Descarga iniciada.")
      return
    }
    if (response?.url && navigator.clipboard) {
      await navigator.clipboard.writeText(response.url).catch(() => undefined)
      showToast(`${response.error || "No es descarga directa"} URL copiada.`)
      return
    }
    showToast(response?.error || "No se encontró una URL de video descargable.")
  } catch (error) {
    showToast(String((error as Error)?.message || error))
  }
}

// ---------------------------------------------------------------------------
// Subtítulos
// ---------------------------------------------------------------------------

function applyCuePosition() {
  if (!cueEl) return
  cueEl.style.left = `${cueLeftPct}%`
  cueEl.style.bottom = `${cueBottomPct}%`
}

function wireCueDrag() {
  const cue = cueEl
  if (!cue) return
  cue.addEventListener("pointerdown", (down) => {
    const media = trackedVideo
    if (!media) return
    down.preventDefault()
    cue.setPointerCapture(down.pointerId)
    cue.dataset.dragging = "true"

    const onMove = (move: PointerEvent) => {
      const rect = (trackedVideo || media).getBoundingClientRect()
      const leftPct = ((move.clientX - rect.left) / rect.width) * 100
      const bottomPct = ((rect.bottom - move.clientY) / rect.height) * 100
      // Permitimos salir bastante del área del video por si el usuario quiere
      // colocar subtítulos en márgenes o encima/debajo del reproductor.
      cueLeftPct = Math.min(180, Math.max(-80, leftPct))
      cueBottomPct = Math.min(160, Math.max(-80, bottomPct))
      applyCuePosition()
    }
    const onUp = () => {
      cue.removeEventListener("pointermove", onMove)
      cue.removeEventListener("pointerup", onUp)
      cue.dataset.dragging = "false"
      void chrome.storage.local.set({ cueLeftPct, cueBottomPct })
    }
    cue.addEventListener("pointermove", onMove)
    cue.addEventListener("pointerup", onUp)
  })
}

function addTranscriptEntry(original: string, translated: string | null) {
  if (!transcriptListEl) return
  transcriptEntries++

  const entry = document.createElement("div")
  entry.className = "subvid-transcript-entry"

  const translatedLine = document.createElement("div")
  translatedLine.className = "subvid-transcript-translated"
  translatedLine.textContent = translated || original
  entry.appendChild(translatedLine)

  const originalLine = document.createElement("div")
  originalLine.className = "subvid-transcript-original"
  originalLine.textContent = original
  entry.appendChild(originalLine)

  transcriptListEl.appendChild(entry)

  // Evita que el panel crezca sin límite en videos largos.
  while (transcriptListEl.children.length > 250) {
    transcriptListEl.firstElementChild?.remove()
  }
  transcriptListEl.scrollTop = transcriptListEl.scrollHeight

  if (transcriptToggleEl) {
    transcriptToggleEl.textContent = `Texto (${Math.min(transcriptEntries, 999)})`
  }
}

function showStatus(phase: Phase, detail?: string, progress?: number) {
  if (!statusEl) return
  if (gotFirstCue && phase !== "error") {
    statusEl.dataset.on = "false"
    return
  }
  const pct =
    typeof progress === "number" ? ` ${Math.round(progress * 100)}%` : ""
  statusEl.textContent = `SubVid · ${detail || phase}${pct}`
  statusEl.dataset.phase = phase
  statusEl.dataset.on = "true"
}

function showCue(original: string, translated: string | null, seconds: number) {
  if (!cueEl || !textEl || !originalEl || !statusEl) return
  gotFirstCue = true
  statusEl.dataset.on = "false"

  const main = translated || original
  textEl.textContent = main
  originalEl.textContent = dual && translated ? original : ""
  cueEl.dataset.on = "true"
  addTranscriptEntry(original, translated)

  clearTimeout(hideTimer)
  const words = main.split(/\s+/).length
  const holdMs = Math.max(
    3500,
    Math.min(10_000, 1800 + words * 380 + seconds * 400),
  )
  hideTimer = setTimeout(() => {
    if (cueEl) cueEl.dataset.on = "false"
  }, holdMs)
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

function startSession(settings?: Settings) {
  applySettings(settings)
  sessionActive = true
  gotFirstCue = false
  transcriptEntries = 0
  if (transcriptListEl) transcriptListEl.textContent = ""
  if (transcriptToggleEl) transcriptToggleEl.textContent = "Texto"
  ensureOverlay()
  if (!trackedVideo) trackedVideo = pickVideo()
  if (!trackedVideo && window.self !== window.top) {
    // Iframes sin video (anuncios, widgets): no dibujamos nada aquí.
    sessionActive = false
    return
  }
  setFabState("active")
  startLoop()
}

function stopSession() {
  sessionActive = false
  clearTimeout(hideTimer)
  if (cueEl) cueEl.dataset.on = "false"
  if (statusEl) statusEl.dataset.on = "false"
  setFabState("idle")
}

function init() {
  // Evitamos borrar overlays globalmente: con doble inyección temporal tras
  // recargar la extensión, eliminar "a ciegas" puede tumbar el overlay bueno.
  console.info("[SubVid] content script activo en", location.href)

  document.addEventListener("fullscreenchange", mountOverlay)
  scanTimer = setInterval(scanTick, 1200)

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "content") return
    switch (message.type) {
      case "ping":
        sendResponse({ pong: true })
        break
      case "session-started":
        startSession(message.settings)
        break
      case "settings-updated":
        applySettings(message.settings)
        break
      case "session-stopped":
        stopSession()
        break
      case "status":
        if (sessionActive)
          showStatus(message.phase, message.detail, message.progress)
        break
      case "cue":
        if (sessionActive)
          showCue(message.original, message.translated, message.seconds)
        break
    }
  })

  // Restaurar preferencias y estado al cargar la página.
  chrome.storage.local
    .get(["cueLeftPct", "cueBottomPct"])
    .then((stored) => {
      if (typeof stored.cueLeftPct === "number") {
        cueLeftPct = stored.cueLeftPct
      }
      if (typeof stored.cueBottomPct === "number") {
        cueBottomPct = stored.cueBottomPct
      }
      applyCuePosition()
    })
    .catch(() => undefined)

  chrome.runtime
    .sendMessage({ target: "background", type: "get-tab-state" })
    .then((response) => {
      const state = response?.state
      if (state?.active) {
        startSession(state.settings)
        if (state.status) {
          showStatus(
            state.status.phase,
            state.status.detail,
            state.status.progress,
          )
        }
      }
    })
    .catch(() => undefined)
}

init()
