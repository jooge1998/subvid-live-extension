// Content script: dibuja los subtítulos generados en tiempo real encima del
// video más grande visible (YouTube, X, Facebook, Instagram…) y muestra un
// botón flotante para activar/detener los subtítulos sin abrir el popup.

import "./content.css"
import { LANGS } from "../shared/languages.ts"
import {
  formatLatencyDebugPanel,
  enrichLatencyMetrics,
} from "../shared/latencyDebug.ts"
import {
  DEFAULT_SUBTITLE_STYLE,
  type CueLatencyMetrics,
  type CueMessage,
  type CueStatus,
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
let metricsEl: HTMLDivElement | null = null
let statusEl: HTMLDivElement | null = null
let fabEl: HTMLButtonElement | null = null
let toastEl: HTMLDivElement | null = null
let transcriptToggleEl: HTMLButtonElement | null = null
let transcriptPanelEl: HTMLDivElement | null = null
let transcriptListEl: HTMLDivElement | null = null
let transcriptModeEl: HTMLSelectElement | null = null
let transcriptExpandEl: HTMLButtonElement | null = null
let transcriptCloseEl: HTMLButtonElement | null = null

let trackedVideo: HTMLElement | null = null
let looping = false
let rafId = 0
let frameCount = 0
let hideTimer: ReturnType<typeof setTimeout> | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined
let transcriptEntries = 0
let currentSettings: Partial<Settings> | undefined
/** cueId → nodo de historial (para upsert sin parpadeo). */
const transcriptByCueId = new Map<string, HTMLDivElement>()
let activeOverlayCueId: string | null = null
let debugLatency = false
let speakTranslation = false
let ttsMuted = false
let duckOriginal = true
/** Volumen original del <video> antes de hacer ducking. */
let savedVideoVolume: number | null = null
const DUCK_VOLUME = 0.18

/** Timestamps de render percibido por cue (performance.now en la página). */
type CueRenderTiming = {
  firstTextAt?: number
  translationAt?: number
  finalAt?: number
  audioCapturedAt?: number
}
const cueRenderTiming = new Map<string, CueRenderTiming>()

// Posición del subtítulo (en % del reproductor), ajustable arrastrando y
// persistida entre sesiones.
let cueLeftPct = 50
let cueBottomPct = 6

type ControlPos = { left: number; top: number }

/** Posición en % del overlay (centro del botón). */
let fabPos: ControlPos = { left: 92, top: 5 }
let transcriptPanelPos: ControlPos = { left: 72, top: 12 }

const DRAG_TAP_THRESHOLD_PX = 6

let overlayControlsVisible = true

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
  metricsEl = document.createElement("div")
  metricsEl.className = "subvid-cue-metrics"
  metricsEl.dataset.on = "false"
  cueEl.append(originalEl, textEl, metricsEl)
  cueEl.title = "Arrastra para mover los subtítulos"
  wireCueDrag()

  fabEl = document.createElement("button")
  fabEl.className = "subvid-fab"
  fabEl.type = "button"
  fabEl.textContent = "Subvid"
  fabEl.title = "SubVid: activar/detener (arrastra para mover)"
  wireDraggableControl(
    fabEl,
    () => fabPos,
    (pos) => {
      fabPos = pos
    },
    { left: "fabLeftPct", top: "fabTopPct" },
    () => void onFabClick(),
  )

  transcriptToggleEl = document.createElement("button")
  transcriptToggleEl.className = "subvid-transcript-toggle"
  transcriptToggleEl.type = "button"
  transcriptToggleEl.textContent = "Texto"
  transcriptToggleEl.title = "Mostrar / ocultar historial de subtítulos"
  transcriptToggleEl.dataset.on = "false"
  transcriptToggleEl.addEventListener("click", toggleTranscriptPanel)

  transcriptPanelEl = document.createElement("div")
  transcriptPanelEl.className = "subvid-transcript-panel"
  transcriptPanelEl.dataset.on = "false"
  transcriptPanelEl.dataset.view = "translated"

  const transcriptHeader = document.createElement("div")
  transcriptHeader.className = "subvid-transcript-header"
  transcriptHeader.title = "Arrastra para mover el historial"
  wireTranscriptPanelDrag(transcriptHeader)

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

  const transcriptClearEl = document.createElement("button")
  transcriptClearEl.className = "subvid-transcript-action"
  transcriptClearEl.type = "button"
  transcriptClearEl.textContent = "⌫"
  transcriptClearEl.title = "Borrar historial"
  transcriptClearEl.setAttribute("aria-label", "Borrar historial")
  transcriptClearEl.addEventListener("click", clearTranscriptHistory)

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

  transcriptActions.append(
    transcriptClearEl,
    transcriptExpandEl,
    transcriptCloseEl,
  )
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
    transcriptPanelEl,
    toastEl,
  )
  applySubtitleStyle()
  syncTranscriptModeOptions()
  applyCuePosition()
  applyControlPositions()
  applyOverlayControlsVisibility()
  mountOverlay()
}

function clampControlPct(value: number) {
  return Math.min(102, Math.max(-6, value))
}

function applyOverlayControlsVisibility() {
  if (!overlay) return
  overlay.dataset.controls = overlayControlsVisible ? "visible" : "hidden"
  if (!overlayControlsVisible) closeTranscriptPanel()
}

function applyControlPositions() {
  if (fabEl) {
    fabEl.style.left = `${fabPos.left}%`
    fabEl.style.top = `${fabPos.top}%`
  }
  // Historial "Texto" siempre debajo del botón SubVid (misma columna).
  if (transcriptToggleEl) {
    transcriptToggleEl.style.left = `${fabPos.left}%`
    transcriptToggleEl.style.top = `${clampControlPct(fabPos.top + 9)}%`
    transcriptToggleEl.style.right = "auto"
  }
  if (transcriptPanelEl) {
    transcriptPanelEl.style.left = `${transcriptPanelPos.left}%`
    transcriptPanelEl.style.top = `${transcriptPanelPos.top}%`
  }
}

function wireTranscriptPanelDrag(handle: HTMLElement) {
  handle.addEventListener("pointerdown", (down) => {
    const panel = transcriptPanelEl
    const overlayEl = overlay
    if (!panel || !overlayEl) return
    if ((down.target as Element).closest("select, button")) return

    down.preventDefault()
    down.stopPropagation()
    const startX = down.clientX
    const startY = down.clientY
    const start = { ...transcriptPanelPos }
    const overlayRect = overlayEl.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const startCenterX =
      overlayRect.left + (start.left / 100) * overlayRect.width
    const startTop = overlayRect.top + (start.top / 100) * overlayRect.height
    handle.setPointerCapture(down.pointerId)
    panel.dataset.dragging = "true"

    const onMove = (move: PointerEvent) => {
      const rect = overlayEl.getBoundingClientRect()
      const halfWidth = Math.min(panelRect.width / 2, window.innerWidth / 2 - 8)
      const centerX = Math.min(
        window.innerWidth - halfWidth - 8,
        Math.max(halfWidth + 8, startCenterX + move.clientX - startX),
      )
      const maxTop = Math.max(8, window.innerHeight - Math.min(panelRect.height, window.innerHeight - 16) - 8)
      const top = Math.min(
        maxTop,
        Math.max(8, startTop + move.clientY - startY),
      )
      transcriptPanelPos = {
        left: ((centerX - rect.left) / rect.width) * 100,
        top: ((top - rect.top) / rect.height) * 100,
      }
      applyControlPositions()
    }

    const cleanup = () => {
      try {
        handle.releasePointerCapture(down.pointerId)
      } catch {
        /* el puntero ya se soltó */
      }
      panel.dataset.dragging = "false"
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onCancel)
    }

    const onUp = () => {
      cleanup()
      void chrome.storage.local.set({
        transcriptPanelLeftPct: transcriptPanelPos.left,
        transcriptPanelTopPct: transcriptPanelPos.top,
      })
    }
    const onCancel = () => cleanup()

    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onCancel)
  })
}

/** Arrastra el control; si no hubo movimiento, ejecuta onTap (clic). */
function wireDraggableControl(
  el: HTMLElement,
  getPos: () => ControlPos,
  setPos: (pos: ControlPos) => void,
  storageKeys: { left: string; top: string },
  onTap: () => void,
) {
  el.addEventListener("pointerdown", (down) => {
    const overlayEl = overlay
    if (!overlayEl) return
    down.preventDefault()
    down.stopPropagation()
    const startX = down.clientX
    const startY = down.clientY
    let dragged = false
    el.setPointerCapture(down.pointerId)
    el.dataset.dragging = "true"

    const onMove = (move: PointerEvent) => {
      if (
        Math.hypot(move.clientX - startX, move.clientY - startY) >=
        DRAG_TAP_THRESHOLD_PX
      ) {
        dragged = true
      }
      const rect = overlayEl.getBoundingClientRect()
      setPos({
        left: clampControlPct(((move.clientX - rect.left) / rect.width) * 100),
        top: clampControlPct(((move.clientY - rect.top) / rect.height) * 100),
      })
      applyControlPositions()
    }

    const onUp = () => {
      el.releasePointerCapture(down.pointerId)
      el.dataset.dragging = "false"
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      if (dragged) {
        const pos = getPos()
        void chrome.storage.local.set({
          [storageKeys.left]: pos.left,
          [storageKeys.top]: pos.top,
        })
      } else {
        onTap()
      }
    }

    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
  })
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

function findTrackedHtmlVideo(): HTMLVideoElement | null {
  if (!trackedVideo) return null
  if (trackedVideo instanceof HTMLVideoElement) return trackedVideo
  return trackedVideo.querySelector("video")
}

/** Video al que escuchamos ended / loop para detener la traducción. */
let watchedMediaVideo: HTMLVideoElement | null = null
let lastWatchedTime = 0
let stoppingForVideoEnd = false

function onTrackedVideoEnded() {
  void stopBecauseVideoEnded("el video terminó")
}

/**
 * En sitios con loop (X, Reels) a menudo no dispara `ended`:
 * detectamos salto del final → inicio.
 */
function onTrackedVideoTimeUpdate() {
  const video = watchedMediaVideo
  if (!video || !sessionActive) return
  const t = video.currentTime
  const d = video.duration
  if (
    Number.isFinite(d) &&
    d > 1.5 &&
    lastWatchedTime >= d - 0.85 &&
    t < 0.85
  ) {
    void stopBecauseVideoEnded("el video se reinició (loop)")
    return
  }
  lastWatchedTime = t
}

async function stopBecauseVideoEnded(reason: string) {
  if (!sessionActive || stoppingForVideoEnd) return
  stoppingForVideoEnd = true
  showToast(`SubVid detenido: ${reason} (cerrando frase…)`, 4000)
  try {
    // Flush pendiente + no cortar TTS a medias (a diferencia de Detener manual).
    await chrome.runtime.sendMessage({
      target: "background",
      type: "stop-after-flush",
    })
  } catch (error) {
    console.warn("[SubVid] no se pudo detener al terminar el video", error)
  } finally {
    stoppingForVideoEnd = false
  }
}

function unbindVideoEndWatch() {
  if (watchedMediaVideo) {
    watchedMediaVideo.removeEventListener("ended", onTrackedVideoEnded)
    watchedMediaVideo.removeEventListener("timeupdate", onTrackedVideoTimeUpdate)
  }
  watchedMediaVideo = null
  lastWatchedTime = 0
}

function bindVideoEndWatch() {
  const video = findTrackedHtmlVideo()
  if (video === watchedMediaVideo) return
  unbindVideoEndWatch()
  if (!video || !sessionActive) return
  watchedMediaVideo = video
  lastWatchedTime = video.currentTime
  video.addEventListener("ended", onTrackedVideoEnded)
  video.addEventListener("timeupdate", onTrackedVideoTimeUpdate)
}

function applyOriginalAudioDuck() {
  const video = findTrackedHtmlVideo()
  if (!video) return
  if (speakTranslation && !ttsMuted && duckOriginal) {
    if (savedVideoVolume == null) savedVideoVolume = video.volume
    video.volume = Math.min(video.volume, DUCK_VOLUME)
  } else {
    restoreOriginalAudio()
  }
}

function restoreOriginalAudio() {
  const video = findTrackedHtmlVideo()
  if (video && savedVideoVolume != null) {
    video.volume = savedVideoVolume
  }
  savedVideoVolume = null
}

function applySettings(settings?: Partial<Settings>) {
  currentSettings = settings
  dual = !!settings?.dual
  debugLatency = !!settings?.debugLatency
  speakTranslation = !!settings?.speakTranslation
  duckOriginal = settings?.duckOriginal !== false
  subtitleStyle = normalizeStyle(settings?.style)
  applySubtitleStyle()
  syncTranscriptModeOptions()
  positionOverlay()
  if (!debugLatency && metricsEl) metricsEl.dataset.on = "false"
  if (sessionActive) applyOriginalAudioDuck()
}

function languageLabel(code: string | undefined, fallback: string) {
  if (!code || code === "none") return fallback
  if (code === "auto") return "Auto"
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

function isInstagramPage() {
  return /instagram\.com$/i.test(location.hostname.replace(/^www\./, ""))
}

/** Reel/video centrado en pantalla (Instagram precarga varios <video> fuera de vista). */
function isVideoInMainViewport(video: HTMLVideoElement) {
  const rect = video.getBoundingClientRect()
  const vh = window.innerHeight
  const vw = window.innerWidth
  if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) {
    return false
  }
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  return cx >= vw * 0.08 && cx <= vw * 0.92 && cy >= vh * 0.08 && cy <= vh * 0.92
}

function viewportFocusScore(rect: DOMRect) {
  const area = scoreRect(rect)
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const dist = Math.hypot(cx - window.innerWidth / 2, cy - window.innerHeight / 2)
  return area / (1 + dist * 0.015)
}

/** Descarta imágenes disfrazadas de video; en Instagram acepta Reels antes de cargar metadata. */
function isPlayableVideo(video: HTMLVideoElement) {
  const rect = video.getBoundingClientRect()
  if (!isVisibleRect(rect)) return false

  const src = video.currentSrc || video.src || ""
  if (/\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(src) || src.startsWith("data:image")) {
    return false
  }

  // Reels de Instagram: <video> visible y centrado aunque aún no tenga src/duración.
  if (isInstagramPage() && isVideoInMainViewport(video)) {
    return true
  }

  // Señales de video real (cargado o reproduciéndose).
  if (video.videoWidth >= 64 && video.videoHeight >= 64) return true
  if (Number.isFinite(video.duration) && video.duration > 0.5) return true
  if (!video.paused && video.currentTime > 0) return true

  for (const source of video.querySelectorAll("source[src]")) {
    const href = source.getAttribute("src") || ""
    if (href && !/\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(href)) return true
  }

  if (
    src &&
    (src.startsWith("blob:") ||
      /\.(mp4|webm|m3u8|mpd|mov)(\?|$)/i.test(src) ||
      src.includes("video"))
  ) {
    return true
  }

  // Reproductor conocido aunque el stream aún no haya cargado metadata.
  if (
    video.controls ||
    video.closest(
      '[data-testid*="video" i], [data-video-id], .html5-video-player, ytd-player, .video-stream',
    )
  ) {
    return true
  }

  return false
}

/** Contenedores de reproductor en SPAs donde el <video> puede reaparecer tras un rerender. */
const PLAYER_SHELL_SELECTORS = [
  '[data-testid="videoComponent"]',
  '[data-testid="videoPlayer"]',
  '[data-testid="videoPlayerContainer"]',
  '[data-video-id]',
  ".html5-video-player",
  "ytd-player",
  ".vp-video",
]

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
  let bestScore = 0
  for (const video of document.querySelectorAll("video")) {
    if (!isPlayableVideo(video)) continue
    const rect = video.getBoundingClientRect()
    const score = isInstagramPage() ? viewportFocusScore(rect) : scoreRect(rect)
    if (score > bestScore) {
      bestVideo = video
      bestScore = score
    }
  }
  if (bestVideo) return findVideoHost(bestVideo)

  // Solo shells de reproductor explícitos (X/YouTube/FB). Nunca imágenes ni
  // botones genéricos como los posts estáticos de Instagram.
  let bestShell: HTMLElement | null = null
  let bestShellScore = 0
  for (const selector of PLAYER_SHELL_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const rect = el.getBoundingClientRect()
      const score = scoreRect(rect)
      if (!isVisibleRect(rect) || score <= bestShellScore) continue
      bestShell = el
      bestShellScore = score
    }
  }
  return bestShell
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
  applyControlPositions()
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
    if (sessionActive) bindVideoEndWatch()
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
  unbindVideoEndWatch()
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

async function onFabClick(event?: MouseEvent) {
  event?.preventDefault()
  event?.stopPropagation()
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
          "Primera vez en esta pestaña: haz clic derecho → «Activar / detener subtítulos», pulsa Ctrl+Shift+Y o el icono de la extensión. Después este botón funcionará directo.",
          7000,
        )
      } else {
        showToast(error || "No se pudo iniciar la captura")
      }
      setFabState(sessionActive ? "active" : "idle")
    }
    // El estado definitivo llega por session-started / session-stopped.
  } catch (error) {
    const message = String((error as Error)?.message || error)
    showToast(
      /invalidated|receiving end/i.test(message)
        ? "La extensión se actualizó. Recarga esta página (F5)."
        : message || "No se pudo conectar con SubVid.",
      6000,
    )
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

// ---------------------------------------------------------------------------
// Subtítulos
// ---------------------------------------------------------------------------

function applyCuePosition() {
  if (!cueEl) return
  cueLeftPct = Math.min(92, Math.max(8, cueLeftPct))
  cueBottomPct = Math.min(92, Math.max(4, cueBottomPct))
  cueEl.style.left = `${cueLeftPct}%`
  cueEl.style.bottom = `${cueBottomPct}%`
}

function ensureCueVisible() {
  if (!cueEl || !overlay || cueEl.dataset.on !== "true") return
  const cueRect = cueEl.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  const outside =
    cueRect.right < overlayRect.left ||
    cueRect.left > overlayRect.right ||
    cueRect.bottom < overlayRect.top ||
    cueRect.top > overlayRect.bottom
  if (!outside) return
  cueLeftPct = 50
  cueBottomPct = 6
  applyCuePosition()
  void chrome.storage.local.set({ cueLeftPct, cueBottomPct })
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
      cueLeftPct = Math.min(92, Math.max(8, leftPct))
      cueBottomPct = Math.min(92, Math.max(4, bottomPct))
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

function formatLatencyMetrics(
  metrics?: CueLatencyMetrics,
  timing?: CueRenderTiming,
) {
  if (!metrics) return ""
  const firstRenderedAt = timing?.firstTextAt ?? metrics.firstRenderedAt
  const translationRenderedAt =
    timing?.translationAt ?? metrics.translationRenderedAt
  const finalCueAt = timing?.finalAt ?? metrics.finalCueAt ?? metrics.finalAt
  return formatLatencyDebugPanel(
    enrichLatencyMetrics({
      ...metrics,
      firstRenderedAt,
      firstTextRenderedAt: firstRenderedAt,
      translationRenderedAt,
      finalCueAt,
      finalAt: finalCueAt,
    }),
  )
}

function renderHighlightedText(
  host: HTMLElement,
  confirmed: string,
  delta: string,
) {
  host.textContent = ""
  if (confirmed) {
    host.appendChild(document.createTextNode(confirmed))
  }
  if (delta) {
    if (confirmed && !/\s$/.test(confirmed) && !/^\s/.test(delta)) {
      host.appendChild(document.createTextNode(" "))
    }
    const span = document.createElement("span")
    span.className = "subvid-cue-delta"
    span.textContent = delta
    host.appendChild(span)
  }
  if (!confirmed && !delta) {
    host.textContent = ""
  }
}

function upsertTranscriptEntry(
  cueId: string,
  original: string,
  translated: string | null,
  confirmedText?: string,
  deltaText?: string,
) {
  if (!transcriptListEl) return

  let entry = transcriptByCueId.get(cueId)
  if (!entry) {
    entry = document.createElement("div")
    entry.className = "subvid-transcript-entry"
    entry.dataset.cueId = cueId

    const translatedLine = document.createElement("div")
    translatedLine.className = "subvid-transcript-translated"
    const originalLine = document.createElement("div")
    originalLine.className = "subvid-transcript-original"
    entry.append(translatedLine, originalLine)

    transcriptListEl.appendChild(entry)
    transcriptByCueId.set(cueId, entry)
    transcriptEntries++

    while (transcriptListEl.children.length > 250) {
      const first = transcriptListEl.firstElementChild as HTMLDivElement | null
      if (!first) break
      const oldId = first.dataset.cueId
      if (oldId) transcriptByCueId.delete(oldId)
      first.remove()
    }
  }

  const translatedLine = entry.querySelector(
    ".subvid-transcript-translated",
  ) as HTMLDivElement | null
  const originalLine = entry.querySelector(
    ".subvid-transcript-original",
  ) as HTMLDivElement | null

  const confirmed = (confirmedText ?? original).trim()
  const delta = (deltaText || "").trim()

  if (translatedLine) {
    if (translated) {
      translatedLine.textContent = translated
    } else if (delta) {
      renderHighlightedText(translatedLine, confirmed, delta)
    } else {
      translatedLine.textContent = original
    }
  }
  if (originalLine) {
    if (delta) {
      renderHighlightedText(originalLine, confirmed, delta)
    } else {
      originalLine.textContent = original
    }
  }

  transcriptListEl.scrollTop = transcriptListEl.scrollHeight
  if (transcriptToggleEl) {
    transcriptToggleEl.textContent = `Texto (${Math.min(transcriptEntries, 999)})`
  }
}

function setTranscriptToggleVisible(visible: boolean) {
  if (!transcriptToggleEl) return
  transcriptToggleEl.dataset.on = visible ? "true" : "false"
  if (!visible) closeTranscriptPanel()
}

function showStatus(phase: Phase, detail?: string, progress?: number) {
  if (!statusEl) return
  // Mientras la sesión está activa el historial debe verse aunque el status
  // pase por "downloading/loading" (p. ej. TranslateGemma en segundo plano).
  if (sessionActive) setTranscriptToggleVisible(true)
  else setTranscriptToggleVisible(phase === "listening" || phase === "transcribing")
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

/**
 * Muestra o actualiza un subtítulo por cueId (sin recrear el nodo → sin flicker).
 * - Sin dual + traducción pendiente: muestra original provisional.
 * - Sin dual + traducción lista: reemplaza por traducción.
 * - Con dual: original arriba, traducción abajo cuando llega.
 * - isFinal/stabilityScore controlan estilo provisional, no bloquean el texto.
 */
function upsertCue(message: CueMessage) {
  if (!cueEl || !textEl || !originalEl || !statusEl) return
  const {
    cueId,
    status,
    original,
    translated,
    confirmedText,
    deltaText,
    seconds,
    metrics,
    stabilityScore,
    isFinal,
  } = message
  if (!cueId || !original) return

  gotFirstCue = true
  statusEl.dataset.on = "false"

  activeOverlayCueId = cueId

  const now = Date.now()
  let timing = cueRenderTiming.get(cueId)
  if (!timing) {
    timing = { audioCapturedAt: metrics?.audioCapturedAt }
    cueRenderTiming.set(cueId, timing)
  } else if (
    metrics?.audioCapturedAt != null &&
    timing.audioCapturedAt == null
  ) {
    timing.audioCapturedAt = metrics.audioCapturedAt
  }

  if (timing.firstTextAt == null) timing.firstTextAt = now

  const hasTranslation =
    typeof translated === "string" && translated.trim().length > 0
  if (hasTranslation && timing.translationAt == null) {
    timing.translationAt = now
  }
  if (isFinal && timing.finalAt == null) timing.finalAt = now

  const awaitingTranslation =
    status === "translation_pending" ||
    (status === "transcript_confirmed" && !hasTranslation)
  const lowStability =
    typeof stabilityScore === "number" && stabilityScore < 0.55 && !isFinal

  const confirmed = (confirmedText ?? original).trim()
  const delta = !isFinal && deltaText ? deltaText.trim() : ""

  if (dual) {
    if (delta) {
      renderHighlightedText(originalEl, confirmed, delta)
    } else {
      originalEl.textContent = original
    }
    if (hasTranslation) {
      textEl.textContent = translated
    } else if (delta) {
      renderHighlightedText(textEl, confirmed, delta)
    } else {
      textEl.textContent = original
    }
    textEl.dataset.provisional =
      (!hasTranslation && awaitingTranslation) || lowStability
        ? "true"
        : "false"
  } else if (hasTranslation) {
    originalEl.textContent = ""
    textEl.textContent = translated
    textEl.dataset.provisional = "false"
  } else if (delta) {
    originalEl.textContent = ""
    renderHighlightedText(textEl, confirmed, delta)
    textEl.dataset.provisional =
      awaitingTranslation || lowStability ? "true" : "false"
  } else {
    originalEl.textContent = ""
    textEl.textContent = original
    textEl.dataset.provisional =
      awaitingTranslation || lowStability ? "true" : "false"
  }

  cueEl.dataset.on = "true"
  cueEl.dataset.status = status as CueStatus
  cueEl.dataset.final = isFinal ? "true" : "false"

  if (debugLatency && metricsEl) {
    const label = formatLatencyMetrics(metrics, timing)
    metricsEl.textContent = label
    metricsEl.dataset.on = label ? "true" : "false"
  } else if (metricsEl) {
    metricsEl.dataset.on = "false"
  }

  upsertTranscriptEntry(cueId, original, translated, confirmed, delta)
  requestAnimationFrame(ensureCueVisible)

  const main = textEl.textContent || original
  const words = main.split(/\s+/).length
  const holdMs = Math.max(
    3500,
    Math.min(10_000, 1800 + words * 380 + seconds * 400),
  )
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (cueEl) cueEl.dataset.on = "false"
    activeOverlayCueId = null
  }, holdMs)

  if (cueRenderTiming.size > 80) {
    const oldest = cueRenderTiming.keys().next().value
    if (oldest) cueRenderTiming.delete(oldest)
  }
}

function clearTranscriptHistory(event?: MouseEvent) {
  event?.preventDefault()
  event?.stopPropagation()
  transcriptEntries = 0
  transcriptByCueId.clear()
  cueRenderTiming.clear()
  if (transcriptListEl) transcriptListEl.textContent = ""
  if (transcriptToggleEl) transcriptToggleEl.textContent = "Texto"
  showToast("Historial borrado")
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

function startSession(settings?: Settings) {
  ttsMuted = false
  applySettings(settings)
  sessionActive = true
  gotFirstCue = false
  transcriptEntries = 0
  transcriptByCueId.clear()
  cueRenderTiming.clear()
  activeOverlayCueId = null
  if (transcriptListEl) transcriptListEl.textContent = ""
  if (transcriptToggleEl) transcriptToggleEl.textContent = "Texto"
  setTranscriptToggleVisible(true)
  ensureOverlay()
  applyControlPositions()
  if (!trackedVideo) trackedVideo = pickVideo()
  if (!trackedVideo && window.self !== window.top) {
    // Iframes sin video (anuncios, widgets): no dibujamos nada aquí.
    sessionActive = false
    return
  }
  setFabState("active")
  startLoop()
  bindVideoEndWatch()
  applyOriginalAudioDuck()
}

function stopSession() {
  sessionActive = false
  ttsMuted = false
  unbindVideoEndWatch()
  clearTimeout(hideTimer)
  activeOverlayCueId = null
  restoreOriginalAudio()
  if (cueEl) cueEl.dataset.on = "false"
  if (statusEl) statusEl.dataset.on = "false"
  if (metricsEl) metricsEl.dataset.on = "false"
  setTranscriptToggleVisible(false)
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
      case "tts-muted":
        ttsMuted = message.muted === true
        applyOriginalAudioDuck()
        break
      case "session-stopped":
        stopSession()
        break
      case "status":
        if (sessionActive)
          showStatus(message.phase, message.detail, message.progress)
        break
      case "cue":
        if (sessionActive) upsertCue(message as CueMessage)
        break
      case "overlay-controls":
        overlayControlsVisible = message.visible !== false
        applyOverlayControlsVisibility()
        break
    }
  })

  // Restaurar preferencias y estado al cargar la página.
  chrome.storage.local
    .get([
      "cueLeftPct",
      "cueBottomPct",
      "fabLeftPct",
      "fabTopPct",
      "transcriptPanelLeftPct",
      "transcriptPanelTopPct",
      "overlayControlsVisible",
    ])
    .then((stored) => {
      if (typeof stored.cueLeftPct === "number") {
        cueLeftPct = stored.cueLeftPct
      }
      if (typeof stored.cueBottomPct === "number") {
        cueBottomPct = stored.cueBottomPct
      }
      if (typeof stored.fabLeftPct === "number") {
        fabPos.left = stored.fabLeftPct
      }
      if (typeof stored.fabTopPct === "number") {
        fabPos.top = stored.fabTopPct
      }
      if (typeof stored.transcriptPanelLeftPct === "number") {
        transcriptPanelPos.left = stored.transcriptPanelLeftPct
      }
      if (typeof stored.transcriptPanelTopPct === "number") {
        transcriptPanelPos.top = stored.transcriptPanelTopPct
      }
      overlayControlsVisible = stored.overlayControlsVisible !== false
      applyCuePosition()
      applyControlPositions()
      applyOverlayControlsVisibility()
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
