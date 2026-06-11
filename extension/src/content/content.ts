// Content script: dibuja los subtítulos generados en tiempo real encima del
// video más grande visible (YouTube, X, Facebook, Instagram…) y muestra un
// botón flotante para activar/detener los subtítulos sin abrir el popup.

import "./content.css"
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

let trackedVideo: HTMLElement | null = null
let looping = false
let rafId = 0
let frameCount = 0
let hideTimer: ReturnType<typeof setTimeout> | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined

// Posición vertical del subtítulo (en % desde el borde inferior del video),
// ajustable arrastrando y persistida entre sesiones.
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

  toastEl = document.createElement("div")
  toastEl.className = "subvid-toast"

  overlay.append(statusEl, cueEl, fabEl, toastEl)
  applySubtitleStyle()
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
  dual = !!settings?.dual
  subtitleStyle = normalizeStyle(settings?.style)
  applySubtitleStyle()
  positionOverlay()
}

function mountOverlay() {
  if (!overlay) return
  const host = trackedVideo || document.fullscreenElement || document.body || document.documentElement
  if (host instanceof HTMLElement && host !== document.body && host !== document.documentElement) {
    const position = getComputedStyle(host).position
    if (position === "static") host.style.position = "relative"
    overlay.dataset.mount = "host"
  } else {
    overlay.dataset.mount = "fixed"
  }
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
  if (overlay.parentElement !== trackedVideo) mountOverlay()
  const rect = trackedVideo.getBoundingClientRect()
  if (rect.width < 100 || rect.height < 60) {
    overlay.dataset.visible = "false"
    return
  }
  overlay.dataset.visible = "true"
  if (overlay.dataset.mount === "host") {
    overlay.style.left = "0"
    overlay.style.top = "0"
    overlay.style.width = "100%"
    overlay.style.height = "100%"
  } else {
    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.top}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`
  }
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

// ---------------------------------------------------------------------------
// Subtítulos
// ---------------------------------------------------------------------------

function applyCuePosition() {
  if (cueEl) cueEl.style.bottom = `${cueBottomPct}%`
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
      const pct = ((rect.bottom - move.clientY) / rect.height) * 100 - 4
      cueBottomPct = Math.min(80, Math.max(1, pct))
      applyCuePosition()
    }
    const onUp = () => {
      cue.removeEventListener("pointermove", onMove)
      cue.removeEventListener("pointerup", onUp)
      cue.dataset.dragging = "false"
      void chrome.storage.local.set({ cueBottomPct })
    }
    cue.addEventListener("pointermove", onMove)
    cue.addEventListener("pointerup", onUp)
  })
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
    .get("cueBottomPct")
    .then((stored) => {
      if (typeof stored.cueBottomPct === "number") {
        cueBottomPct = stored.cueBottomPct
        applyCuePosition()
      }
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
