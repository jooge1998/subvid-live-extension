// Service worker dedicado a subtítulos: captura de audio, documento offscreen
// y mensajería entre popup ⇄ offscreen ⇄ content script.

import {
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  type SessionState,
  type Settings,
  type StatusPhase,
  type TranslationBackendInfo,
} from "./shared/types.ts"
import { speakTranslation, stopSpeaking } from "./shared/tts.ts"

type Session = {
  tabId: number
  settings: Settings
}

const OFFSCREEN_URL = "src/offscreen/offscreen.html"
const CONTEXT_MENU_ID = "subvid-toggle"

let session: Session | null = null
let startingTabId: number | null = null
let creatingOffscreen: Promise<void> | null = null
let lastStatus: { phase: StatusPhase; detail?: string; progress?: number } = {
  phase: "idle",
}
let lastTranslationBackend: TranslationBackendInfo | null = null

function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(value || {}),
    latencyMode: value?.latencyMode === "quality" ? "quality" : "live",
    speakTranslation: value?.speakTranslation === true,
    duckOriginal: value?.duckOriginal !== false,
    style: {
      ...DEFAULT_SUBTITLE_STYLE,
      ...(value?.style || {}),
    },
  }
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings")
  return normalizeSettings(stored.settings)
}

function sendToPopup(message: Record<string, unknown>) {
  void chrome.runtime
    .sendMessage({ target: "popup", ...message })
    .catch(() => undefined)
}

function sendToTab(tabId: number, message: Record<string, unknown>) {
  void chrome.tabs
    .sendMessage(tabId, { target: "content", ...message }, { frameId: 0 })
    .catch(() => undefined)
}

function setStatus(phase: StatusPhase, detail?: string, progress?: number) {
  lastStatus = { phase, detail, progress }
  if (session) {
    sendToTab(session.tabId, { type: "status", phase, detail, progress })
  }
  sendToPopup({ type: "status", phase, detail, progress })
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  })
  return contexts.length > 0
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [
          "USER_MEDIA" as chrome.offscreen.Reason,
          "WORKERS" as chrome.offscreen.Reason,
        ],
        justification:
          "Captura el audio de la pestaña y ejecuta Whisper y la traducción local.",
      })
      .finally(() => {
        creatingOffscreen = null
      })
  }
  await creatingOffscreen
}

async function closeOffscreenDocument() {
  if (!(await hasOffscreenDocument())) return
  await chrome.offscreen.closeDocument().catch(() => undefined)
}

async function sendToOffscreen(message: Record<string, unknown>) {
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    ...message,
  })
  if (!response?.ok) {
    throw new Error(response?.error || "El documento offscreen no respondió")
  }
  return response
}

async function pingContentScript(tabId: number) {
  try {
    const pong = await chrome.tabs.sendMessage(
      tabId,
      { target: "content", type: "ping" },
      { frameId: 0 },
    )
    return !!pong?.pong
  } catch {
    return false
  }
}

async function ensureContentScript(tabId: number) {
  if (await pingContentScript(tabId)) return

  const declaration = chrome.runtime.getManifest().content_scripts?.[0]
  if (!declaration) throw new Error("El manifest no contiene el content script")

  const inject = async (allFrames: boolean) => {
    const target = { tabId, allFrames }
    if (declaration.css?.length) {
      await chrome.scripting
        .insertCSS({ target, files: declaration.css })
        .catch(() => undefined)
    }
    if (declaration.js?.length) {
      await chrome.scripting.executeScript({ target, files: declaration.js })
    }
  }

  try {
    await inject(true)
  } catch {
    await inject(false)
  }

  if (!(await pingContentScript(tabId))) {
    throw new Error(
      "No se pudo iniciar SubVid en esta página. Recárgala (F5) e inténtalo de nuevo.",
    )
  }
}

async function getTabStreamId(tabId: number) {
  return new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError
      if (error || !streamId) {
        reject(
          new Error(
            error?.message ||
              "Chrome no permitió capturar el audio de esta pestaña",
          ),
        )
        return
      }
      resolve(streamId)
    })
  })
}

async function startCapture(tabId: number, rawSettings?: Partial<Settings>) {
  if (startingTabId !== null) {
    throw new Error("SubVid ya está iniciando otra captura")
  }
  if (session?.tabId === tabId) return
  if (session) await stopCapture()

  startingTabId = tabId
  const settings = normalizeSettings(rawSettings)
  setStatus("starting", "Solicitando acceso al audio de la pestaña…")

  try {
    await ensureContentScript(tabId)
    const streamId = await getTabStreamId(tabId)
    await ensureOffscreen()
    await sendToOffscreen({ type: "start", streamId, settings })

    session = { tabId, settings }
    sendToTab(tabId, { type: "session-started", settings })
    chrome.action.setBadgeBackgroundColor({ color: "#8b5cf6" })
    await chrome.action.setBadgeText({ tabId, text: "ON" })
  } catch (error) {
    await closeOffscreenDocument()
    const message = String((error as Error)?.message || error)
    setStatus("error", message)
    throw error
  } finally {
    startingTabId = null
  }
}

async function stopCapture() {
  const activeSession = session
  session = null
  startingTabId = null
  lastTranslationBackend = null
  stopSpeaking()

  if (await hasOffscreenDocument()) {
    await sendToOffscreen({ type: "stop" }).catch(() => undefined)
    await closeOffscreenDocument()
  }

  if (activeSession) {
    sendToTab(activeSession.tabId, { type: "session-stopped" })
    await chrome.action
      .setBadgeText({ tabId: activeSession.tabId, text: "" })
      .catch(() => undefined)
  }
  setStatus("idle")
  sendToPopup({ type: "translation-backend", backend: null })
}

async function toggleForTab(tabId: number) {
  if (session?.tabId === tabId) {
    await stopCapture()
    return { ok: true, active: false }
  }
  await startCapture(tabId, await loadSettings())
  return { ok: true, active: true }
}

function getState(): SessionState {
  return {
    active: !!session,
    tabId: session?.tabId,
    settings: session?.settings,
    status: lastStatus,
    translationBackend: lastTranslationBackend,
  }
}

async function handleMessage(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
) {
  switch (message.type) {
    case "start": {
      const tabId = Number(message.tabId)
      if (!Number.isInteger(tabId)) throw new Error("Pestaña inválida")
      await startCapture(tabId, message.settings as Partial<Settings>)
      return { ok: true }
    }
    case "stop":
      await stopCapture()
      return { ok: true }
    case "toggle-from-page": {
      const tabId = sender.tab?.id
      if (!tabId) throw new Error("No se encontró la pestaña")
      return toggleForTab(tabId)
    }
    case "get-state":
      return { ok: true, state: getState() }
    case "get-tab-state": {
      const active = !!session && session.tabId === sender.tab?.id
      return {
        ok: true,
        state: {
          active,
          settings: active ? session?.settings : undefined,
          status: active ? lastStatus : undefined,
          translationBackend: active ? lastTranslationBackend : null,
        } satisfies SessionState,
      }
    }
    case "update-settings": {
      const settings = normalizeSettings(message.settings as Partial<Settings>)
      if (session) {
        session.settings = settings
        sendToTab(session.tabId, { type: "settings-updated", settings })
      }
      return { ok: true }
    }
    case "set-overlay-controls": {
      const visible = message.visible !== false
      await chrome.storage.local.set({ overlayControlsVisible: visible })
      const tabs = await chrome.tabs.query({})
      for (const tab of tabs) {
        if (tab.id) sendToTab(tab.id, { type: "overlay-controls", visible })
      }
      return { ok: true }
    }
    case "cue":
      if (session) {
        const cue = {
          type: "cue",
          cueId: String(message.cueId || ""),
          status: message.status || "transcript_confirmed",
          original: String(message.original || ""),
          translated:
            typeof message.translated === "string" ? message.translated : null,
          confirmedText:
            typeof message.confirmedText === "string"
              ? message.confirmedText
              : undefined,
          deltaText:
            typeof message.deltaText === "string" ? message.deltaText : undefined,
          seconds: Number(message.seconds) || 0,
          stabilityScore:
            typeof message.stabilityScore === "number"
              ? message.stabilityScore
              : undefined,
          isFinal: message.isFinal === true,
          translationBackend:
            message.translationBackend ?? lastTranslationBackend,
          metrics: message.metrics || undefined,
        }
        sendToTab(session.tabId, cue)
        sendToPopup(cue)

        // Doblaje TTS: solo cuando hay traducción nueva confirmada.
        if (
          session.settings.speakTranslation &&
          session.settings.targetLang !== "none" &&
          typeof cue.translated === "string" &&
          cue.translated.trim() &&
          (cue.status === "translation_confirmed" || cue.isFinal)
        ) {
          speakTranslation(cue.translated, session.settings.targetLang)
        }
      }
      return { ok: true }
    case "translation-backend":
      lastTranslationBackend =
        (message.backend as TranslationBackendInfo | null) ?? null
      sendToPopup({
        type: "translation-backend",
        backend: lastTranslationBackend,
      })
      return { ok: true }
    case "status":
      setStatus(
        message.phase as StatusPhase,
        typeof message.detail === "string" ? message.detail : undefined,
        typeof message.progress === "number" ? message.progress : undefined,
      )
      return { ok: true }
    case "capture-ended":
      await stopCapture()
      return { ok: true }
    default:
      return { ok: false, error: `Mensaje desconocido: ${message.type}` }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") return
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      const text = String((error as Error)?.message || error)
      console.error("[subvid:bg]", text)
      sendResponse({ ok: false, error: text })
    })
  return true
})

function createContextMenu() {
  // El icono de 16 px se toma del manifest. CreateProperties.icons requiere
  // Chrome 128+, pero la extensión soporta Chrome 116.
  chrome.contextMenus.create(
    {
      id: CONTEXT_MENU_ID,
      title: "Activar / detener subtítulos",
      contexts: ["all"],
    },
    () => {
      const error = chrome.runtime.lastError
      if (error?.message && !/duplicate/i.test(error.message)) {
        console.error("[subvid:bg] menú contextual:", error.message)
      }
    },
  )
}

function resetContextMenu() {
  chrome.contextMenus.removeAll(() => createContextMenu())
}

chrome.runtime.onInstalled.addListener(() => {
  void closeOffscreenDocument()
  resetContextMenu()
})

chrome.runtime.onStartup.addListener(() => {
  chrome.contextMenus.update(
    CONTEXT_MENU_ID,
    { title: "Activar / detener subtítulos", contexts: ["all"] },
    () => {
      if (chrome.runtime.lastError) createContextMenu()
    },
  )
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return
  void toggleForTab(tab.id).catch((error) => {
    setStatus("error", String((error as Error)?.message || error))
  })
})

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-subtitles") return
  void chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then(([tab]) => {
      if (!tab?.id) throw new Error("No hay una pestaña activa")
      return toggleForTab(tab.id)
    })
    .catch((error) => {
      setStatus("error", String((error as Error)?.message || error))
    })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) void stopCapture()
})
