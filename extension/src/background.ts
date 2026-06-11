// Service worker: orquesta la captura de audio de la pestaña (tabCapture),
// el documento offscreen que ejecuta los modelos de IA, y el relay de
// mensajes entre popup ⇄ offscreen ⇄ content script.

import {
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  type Settings,
  type SessionState,
  type StatusPhase,
} from "./shared/types.ts"

type Session = {
  tabId: number
  settings: Settings
}

let session: Session | null = null
let lastStatus: { phase: StatusPhase; detail?: string; progress?: number } = {
  phase: "idle",
}
let creatingOffscreen: Promise<void> | null = null

const OFFSCREEN_URL = "src/offscreen/offscreen.html"

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
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
          "Captura el audio de la pestaña y ejecuta Whisper y los modelos de traducción localmente.",
      })
      .finally(() => {
        creatingOffscreen = null
      })
  }
  await creatingOffscreen
}

function sendToOffscreen(message: Record<string, unknown>) {
  return chrome.runtime
    .sendMessage({ target: "offscreen", ...message })
    .catch(() => undefined)
}

function sendToPopup(message: Record<string, unknown>) {
  // Si el popup está cerrado el sendMessage rechaza: lo ignoramos.
  chrome.runtime
    .sendMessage({ target: "popup", ...message })
    .catch(() => undefined)
}

function sendToTab(tabId: number, message: Record<string, unknown>) {
  chrome.tabs
    // El overlay vive en el frame principal. Sin frameId, en páginas con
    // muchos iframes (X/FB) los mensajes pueden terminar en un frame secundario
    // y el popup muestra texto pero el video no.
    .sendMessage(tabId, { target: "content", ...message }, { frameId: 0 })
    .catch(() => undefined)
}

function setStatus(phase: StatusPhase, detail?: string, progress?: number) {
  lastStatus = { phase, detail, progress }
  if (session) sendToTab(session.tabId, { type: "status", phase, detail, progress })
  sendToPopup({ type: "status", phase, detail, progress })
}

async function pingContentScript(tabId: number) {
  try {
    // frameId 0 = frame principal, donde está el video. Sin esto, un script
    // vivo en cualquier iframe (X los crea a cada rato) respondería el ping
    // aunque el frame principal esté huérfano tras recargar la extensión.
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

// Tras recargar la extensión (o instalarla), las pestañas ya abiertas se
// quedan con el content script viejo "huérfano". Antes de iniciar, hacemos
// ping y si nadie responde lo reinyectamos (activeTab ya está concedido en
// todos los flujos que llegan aquí). Si aun así no responde, fallamos en voz
// alta: capturar audio sin overlay visible solo confunde.
async function ensureContentScript(tabId: number) {
  if (await pingContentScript(tabId)) return

  const declaration = chrome.runtime.getManifest().content_scripts?.[0]
  if (!declaration) throw new Error("Manifest sin content script")

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
  } catch (error) {
    console.warn("[subvid:bg] inyección allFrames falló, reintento solo top", error)
    await inject(false)
  }

  if (!(await pingContentScript(tabId))) {
    throw new Error(
      "No se pudo mostrar el overlay en esta página. Refresca la pestaña (F5) e inténtalo de nuevo.",
    )
  }
  console.info("[subvid:bg] content script inyectado en la pestaña", tabId)
}

async function startCapture(tabId: number, settings: Settings) {
  if (session) await stopCapture()

  setStatus("starting", "Iniciando captura de audio…")
  await ensureContentScript(tabId)
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const error = chrome.runtime.lastError
      if (error || !id) {
        reject(new Error(error?.message || "No se pudo capturar la pestaña"))
      } else {
        resolve(id)
      }
    })
  })

  await ensureOffscreen()
  session = { tabId, settings }
  sendToTab(tabId, { type: "session-started", settings })
  await sendToOffscreen({ type: "start", streamId, settings })

  chrome.action.setBadgeBackgroundColor({ color: "#8b5cf6" }).catch(() => undefined)
  chrome.action.setBadgeText({ tabId, text: "ON" }).catch(() => undefined)
}

async function stopCapture() {
  if (!session) return
  const { tabId } = session
  session = null
  await sendToOffscreen({ type: "stop" })
  sendToTab(tabId, { type: "session-stopped" })
  setStatus("idle")
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined)
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings")
  return normalizeSettings(stored.settings)
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

/** Inicio/parada rápida desde el botón sobre el video, menú contextual o atajo. */
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
  }
}

async function handleMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
): Promise<any> {
  switch (message.type) {
    case "start":
      await startCapture(message.tabId, message.settings)
      return { ok: true }

    case "stop":
      await stopCapture()
      return { ok: true }

    case "toggle-from-page": {
      const tabId = sender.tab?.id
      if (!tabId) return { ok: false, error: "No se encontró la pestaña" }
      return toggleForTab(tabId)
    }

    case "get-state":
      return { ok: true, state: getState() }

    case "update-settings": {
      const next = normalizeSettings(message.settings)
      if (session) {
        session.settings = next
        sendToTab(session.tabId, { type: "settings-updated", settings: next })
      }
      return { ok: true }
    }

    case "get-tab-state": {
      const tabId = sender.tab?.id
      const active = !!session && session.tabId === tabId
      return {
        ok: true,
        state: {
          active,
          settings: active ? session?.settings : undefined,
          status: active ? lastStatus : undefined,
        } satisfies SessionState,
      }
    }

    // Desde el documento offscreen:
    case "cue": {
      if (session) {
        sendToTab(session.tabId, {
          type: "cue",
          original: message.original,
          translated: message.translated,
          seconds: message.seconds,
        })
        sendToPopup({
          type: "cue",
          original: message.original,
          translated: message.translated,
          seconds: message.seconds,
        })
      }
      return { ok: true }
    }

    case "status":
      setStatus(message.phase, message.detail, message.progress)
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
      console.error("[subvid:bg]", error)
      const text = String(error?.message || error)
      if (message.type === "start") setStatus("error", text)
      sendResponse({ ok: false, error: text })
    })
  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) void stopCapture()
})

// Menú contextual: clic derecho en la página cuenta como "invocación" de la
// extensión, así que concede el permiso activeTab que tabCapture necesita.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "subvid-toggle",
    title: "Activar / detener subtítulos",
    contexts: ["all"],
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "subvid-toggle" || !tab?.id) return
  toggleForTab(tab.id).catch((error) => {
    console.error("[subvid:bg] toggle desde menú falló", error)
    setStatus("error", String(error?.message || error))
  })
})

// Atajo de teclado (Ctrl+Shift+S por defecto): también concede activeTab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-subtitles") return
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  toggleForTab(tab.id).catch((error) => {
    console.error("[subvid:bg] toggle desde atajo falló", error)
    setStatus("error", String(error?.message || error))
  })
})
