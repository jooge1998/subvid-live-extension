// Service worker: orquesta la captura de audio de la pestaña (tabCapture),
// el documento offscreen que ejecuta los modelos de IA, y el relay de
// mensajes entre popup ⇄ offscreen ⇄ content script.

import {
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  type CapturedStream,
  type HlsVariant,
  type Settings,
  type SessionState,
  type StatusPhase,
  type StreamKind,
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

// ---------------------------------------------------------------------------
// Detección y validación de streams de video (webRequest)
// ---------------------------------------------------------------------------

const streamsByTab = new Map<number, CapturedStream[]>()
/**
 * Pistas de audio separadas (FB/IG sirven el audio como archivo aparte). No se
 * muestran en el popup, pero se usan para muxear el audio en la descarga.
 */
type AudioTrackCandidate = { url: string; domain: string; seenAt: number }
const audioTracksByTab = new Map<number, AudioTrackCandidate[]>()
const MAX_STREAMS_PER_TAB = 30
const MAX_AUDIO_TRACKS_PER_TAB = 10
/** MP4 menores a esto son casi siempre previews, init segments o fragmentos. */
const MIN_VIDEO_BYTES = 500 * 1024
const STREAMS_STORAGE_KEY = "capturedStreams"
const AUDIO_TRACKS_STORAGE_KEY = "capturedAudioTracks"

const SEGMENT_EXT = /\.(m4s|ts|cmfv|cmfa|cmfm|init)$/
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|weba)$/

// El SW de MV3 se suspende a los ~30 s de inactividad y el Map en memoria se
// pierde: restauramos lo capturado desde storage.session al despertar.
const streamsRestored = chrome.storage.session
  .get([STREAMS_STORAGE_KEY, AUDIO_TRACKS_STORAGE_KEY])
  .then((data) => {
    const savedStreams = data[STREAMS_STORAGE_KEY] as
      | Record<string, CapturedStream[]>
      | undefined
    for (const [tabId, list] of Object.entries(savedStreams || {})) {
      if (!streamsByTab.has(Number(tabId))) streamsByTab.set(Number(tabId), list)
    }
    const savedAudio = data[AUDIO_TRACKS_STORAGE_KEY] as
      | Record<string, AudioTrackCandidate[]>
      | undefined
    for (const [tabId, list] of Object.entries(savedAudio || {})) {
      if (!audioTracksByTab.has(Number(tabId))) {
        audioTracksByTab.set(Number(tabId), list)
      }
    }
  })
  .catch(() => undefined)

function persistStreams() {
  const streams: Record<string, CapturedStream[]> = {}
  for (const [tabId, list] of streamsByTab) streams[tabId] = list
  const audio: Record<string, AudioTrackCandidate[]> = {}
  for (const [tabId, list] of audioTracksByTab) audio[tabId] = list
  chrome.storage.session
    .set({ [STREAMS_STORAGE_KEY]: streams, [AUDIO_TRACKS_STORAGE_KEY]: audio })
    .catch(() => undefined)
}

function baseDomain(host: string) {
  return host.split(".").slice(-2).join(".")
}

function rememberAudioTrack(tabId: number, rawUrl: string) {
  const { url } = normalizeStreamUrl(rawUrl)
  let domain = ""
  try {
    domain = new URL(url).hostname
  } catch {
    return
  }
  const list = audioTracksByTab.get(tabId) || []
  const existing = list.find((entry) => entry.url === url)
  if (existing) {
    existing.seenAt = Date.now()
    return
  }
  list.unshift({ url, domain, seenAt: Date.now() })
  audioTracksByTab.set(tabId, list.slice(0, MAX_AUDIO_TRACKS_PER_TAB))
  persistStreams()
}

/** Pista de audio del mismo CDN, para muxear con un video que no trae audio. */
function audioCompanionFor(stream: CapturedStream) {
  const list = audioTracksByTab.get(stream.tabId) || []
  return list.find(
    (entry) => stream.domain && baseDomain(entry.domain) === baseDomain(stream.domain),
  )?.url
}

function headerValue(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value
}

/**
 * Facebook/Instagram piden el video por trozos con ?bytestart=&byteend=.
 * Descargar esa URL tal cual produce un archivo corto y corrupto (solo ese
 * rango). Sin los parámetros, el CDN devuelve el archivo completo.
 */
function normalizeStreamUrl(raw: string) {
  try {
    const url = new URL(raw)
    let normalized = false
    for (const param of ["bytestart", "byteend"]) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param)
        normalized = true
      }
    }
    return { url: url.toString(), normalized }
  } catch {
    return { url: raw, normalized: false }
  }
}

/** X/Twitter incluye la resolución en la ruta: /avc1/1280x720/xxx.mp4 */
function resolutionFromUrl(url: string) {
  return /\/(\d{2,4}x\d{2,4})\//.exec(url)?.[1]
}

function totalSizeFromHeaders(
  headers: chrome.webRequest.HttpHeader[] | undefined,
) {
  // En respuestas 206 el total real viene en Content-Range: "bytes 0-999/123456"
  const range = headerValue(headers, "content-range")
  const total = range ? Number(/\/(\d+)\s*$/.exec(range)?.[1]) : NaN
  if (Number.isFinite(total) && total > 0) return total
  const length = Number(headerValue(headers, "content-length"))
  return Number.isFinite(length) && length > 0 ? length : undefined
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

type Classification = { kind: StreamKind; detectedBy: string }
type Rejection = { reason: string; isAudioTrack?: boolean }

/**
 * Lista blanca: solo manifiestos principales y archivos de video completos.
 * Devuelve null si ni siquiera es candidato (no se loguea para no inundar).
 */
function classifyResponse(
  url: string,
  contentType: string,
  path: string,
): Classification | Rejection | null {
  if (
    contentType.startsWith("image/") ||
    contentType.startsWith("text/html") ||
    contentType.startsWith("text/css") ||
    contentType.includes("javascript") ||
    contentType.startsWith("font/")
  ) {
    return null
  }

  if (path.endsWith(".m3u8") || contentType.includes("mpegurl")) {
    return {
      kind: "hls",
      detectedBy: path.endsWith(".m3u8")
        ? "extensión .m3u8"
        : `Content-Type ${contentType}`,
    }
  }

  if (path.endsWith(".mpd") || contentType.includes("dash+xml")) {
    return {
      kind: "dash",
      detectedBy: path.endsWith(".mpd")
        ? "extensión .mpd"
        : `Content-Type ${contentType}`,
    }
  }

  if (SEGMENT_EXT.test(path)) return { reason: "segmento individual (.ts/.m4s)" }
  if (url.includes("/mp4a/")) {
    return {
      reason: "pista de solo audio (X) — guardada para mux",
      isAudioTrack: true,
    }
  }
  if (AUDIO_EXT.test(path) || contentType.startsWith("audio/")) {
    return { reason: "audio aislado — guardado para mux", isAudioTrack: true }
  }
  if (url.includes("videoplayback")) {
    return { reason: "chunk parcial de YouTube (no es un archivo completo)" }
  }
  // Contenedores CMAF de solo video (X: /amplify_video/.../avc1/720x1280/x.mp4).
  // No traen audio: el flujo correcto es el manifiesto HLS, que sí conoce la
  // pista de audio y permite muxear ambas.
  if (/\/(avc1|hevc|vp9)\//.test(path)) {
    return { reason: "pista de video sin audio — se usará el manifiesto HLS" }
  }

  if (VIDEO_EXT.test(path) || contentType.startsWith("video/")) {
    return {
      kind: "video",
      detectedBy: VIDEO_EXT.test(path)
        ? `extensión ${path.slice(path.lastIndexOf("."))}`
        : `Content-Type ${contentType}`,
    }
  }
  return null
}

function logStreamDecision(
  verdict: "aceptado" | "descartado",
  url: string,
  contentType: string,
  sizeBytes: number | undefined,
  classification?: Classification,
  reason?: string,
) {
  const short = url.length > 90 ? `${url.slice(0, 90)}…` : url
  console.groupCollapsed(
    `[subvid:net] ${verdict === "aceptado" ? "✔ aceptado" : "✖ descartado"} · ${
      classification?.kind || "—"
    } · ${short}`,
  )
  console.log("URL interceptada:", url)
  console.log("Tipo detectado:", classification?.kind || "ninguno")
  console.log("Método de detección:", classification?.detectedBy || "—")
  console.log("Content-Type:", contentType || "(sin cabecera)")
  console.log(
    "Tamaño reportado:",
    sizeBytes ? `${sizeBytes} bytes (${formatBytes(sizeBytes)})` : "desconocido",
  )
  console.log(
    "Estado de validación:",
    verdict === "aceptado" ? "aceptado" : `descartado — ${reason}`,
  )
  console.groupEnd()
}

async function rememberStream(
  input: Omit<CapturedStream, "id" | "seenAt" | "domain">,
) {
  await streamsRestored
  const list = streamsByTab.get(input.tabId) || []

  const existing = list.find((entry) => entry.url === input.url)
  if (existing) {
    existing.seenAt = Date.now()
    if (input.sizeBytes && !existing.sizeBytes) {
      existing.sizeBytes = input.sizeBytes
      persistStreams()
    }
    return
  }

  // Una media playlist que ya figura como variante de un master no aporta nada.
  if (
    input.kind === "hls" &&
    list.some((entry) => entry.variants?.some((v) => v.url === input.url))
  ) {
    return
  }

  let domain = ""
  try {
    domain = new URL(input.url).hostname
  } catch {
    /* dominio desconocido */
  }

  const entry: CapturedStream = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    seenAt: Date.now(),
    domain,
  }
  list.unshift(entry)
  streamsByTab.set(input.tabId, list.slice(0, MAX_STREAMS_PER_TAB))
  persistStreams()
  notifyStreamUpdate(entry)

  if (entry.kind === "hls") void analyzeHlsManifest(entry)
  if (entry.kind === "dash") void analyzeDashManifest(entry)
}

function notifyStreamUpdate(entry: CapturedStream) {
  sendToPopup({ type: "stream-detected", stream: entry })
  sendToTab(entry.tabId, { type: "stream-detected", stream: entry })
}

function streamsForTab(tabId: number) {
  return streamsByTab.get(tabId) || []
}

function resolutionArea(res?: string) {
  const m = res ? /^(\d+)x(\d+)$/.exec(res) : null
  return m ? Number(m[1]) * Number(m[2]) : 0
}

function bestStreamForTab(tabId: number) {
  const list = streamsForTab(tabId)
  const videos = list
    .filter((entry) => entry.kind === "video")
    .sort(
      (a, b) =>
        resolutionArea(b.resolution) - resolutionArea(a.resolution) ||
        (b.sizeBytes || 0) - (a.sizeBytes || 0),
    )
  return (
    videos[0] ||
    list.find((entry) => entry.kind === "hls" && entry.isMaster) ||
    list.find((entry) => entry.kind === "hls") ||
    list.find((entry) => entry.kind === "dash") ||
    null
  )
}

// --- Análisis de manifiestos -----------------------------------------------

function parseHlsMasterVariants(text: string, baseUrl: string): HlsVariant[] {
  const lines = text.split(/\r?\n/)
  const variants: HlsVariant[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1]) || undefined
    const resolution = /RESOLUTION=(\d+x\d+)/i.exec(lines[i])?.[1]
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim()
      if (!candidate || candidate.startsWith("#")) continue
      try {
        variants.push({
          url: new URL(candidate, baseUrl).toString(),
          resolution,
          bandwidth,
        })
      } catch {
        /* URI inválida */
      }
      break
    }
  }
  return variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
}

function parseHlsAudioRendition(text: string, baseUrl: string) {
  const line = text
    .split(/\r?\n/)
    .find((l) => l.startsWith("#EXT-X-MEDIA") && l.includes("TYPE=AUDIO"))
  const uri = line ? /URI="([^"]+)"/.exec(line)?.[1] : undefined
  if (!uri) return undefined
  try {
    return new URL(uri, baseUrl).toString()
  } catch {
    return undefined
  }
}

async function analyzeHlsManifest(entry: CapturedStream) {
  try {
    const text = await (await fetch(entry.url, { credentials: "omit" })).text()
    if (!text.includes("#EXTM3U")) return

    if (text.includes("#EXT-X-STREAM-INF")) {
      entry.isMaster = true
      entry.variants = parseHlsMasterVariants(text, entry.url)
      entry.resolution = entry.variants[0]?.resolution || entry.resolution
      entry.audioPlaylistUrl = parseHlsAudioRendition(text, entry.url)
      console.info(
        `[subvid:net] master HLS analizado (${entry.variants.length} calidades: ${entry.variants
          .map((v) => v.resolution || `${v.bandwidth ?? "?"} bps`)
          .join(", ")})`,
        entry.url,
      )
      // Quitamos de la lista las media playlists que ya cubren estas variantes.
      const list = streamsByTab.get(entry.tabId) || []
      const variantUrls = new Set(entry.variants.map((v) => v.url))
      streamsByTab.set(
        entry.tabId,
        list.filter((e) => e === entry || !variantUrls.has(e.url)),
      )
    } else {
      entry.isMaster = false
    }
    persistStreams()
    notifyStreamUpdate(entry)
  } catch (error) {
    console.warn("[subvid:net] no se pudo analizar el manifiesto HLS", entry.url, error)
  }
}

async function analyzeDashManifest(entry: CapturedStream) {
  try {
    const text = await (await fetch(entry.url, { credentials: "omit" })).text()
    if (!text.includes("<MPD")) return

    // El service worker no tiene DOMParser: extraemos lo esencial con regex.
    let videoTracks = 0
    let audioTracks = 0
    let maxW = 0
    let maxH = 0
    for (const match of text.matchAll(/<Representation\b[^>]*>/g)) {
      const rep = match[0]
      const w = Number(/\bwidth="(\d+)"/.exec(rep)?.[1])
      const h = Number(/\bheight="(\d+)"/.exec(rep)?.[1])
      if (w && h) {
        videoTracks++
        if (w * h > maxW * maxH) {
          maxW = w
          maxH = h
        }
      } else if (/audioSamplingRate=|mimeType="audio\//.test(rep)) {
        audioTracks++
      }
    }
    if (!audioTracks) {
      audioTracks = (
        text.match(
          /<AdaptationSet\b[^>]*(?:mimeType="audio\/|contentType="audio")/g,
        ) || []
      ).length
    }
    entry.dashInfo = {
      videoTracks,
      audioTracks,
      maxResolution: maxW ? `${maxW}x${maxH}` : undefined,
    }
    entry.resolution = entry.dashInfo.maxResolution || entry.resolution
    console.info(
      `[subvid:net] manifiesto DASH analizado: ${videoTracks} pista(s) de video / ${audioTracks} de audio, máx ${
        entry.resolution || "?"
      }`,
      entry.url,
    )
    persistStreams()
    notifyStreamUpdate(entry)
  } catch (error) {
    console.warn("[subvid:net] no se pudo analizar el manifiesto DASH", entry.url, error)
  }
}

// --- Descarga ---------------------------------------------------------------

function filenameFor(stream: CapturedStream, ext: string, suffix = "") {
  const res = stream.resolution ? `_${stream.resolution}` : ""
  const host = (stream.domain || "video").replace(/[^a-z0-9.-]/gi, "")
  return `subvid/${host}${res}${suffix}.${ext}`
}

type HlsMediaPlaylist = {
  mapUri?: string
  segments: string[]
  /** Definido si todos los segmentos apuntan al mismo archivo contenedor. */
  singleContainer?: string
}

function parseHlsMediaPlaylist(text: string, baseUrl: string): HlsMediaPlaylist {
  const segments: string[] = []
  let mapUri: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith("#EXT-X-MAP")) {
      const uri = /URI="([^"]+)"/.exec(trimmed)?.[1]
      if (uri) {
        try {
          mapUri = new URL(uri, baseUrl).toString()
        } catch {
          /* URI inválida */
        }
      }
    } else if (trimmed && !trimmed.startsWith("#")) {
      try {
        segments.push(new URL(trimmed, baseUrl).toString())
      } catch {
        /* URI inválida */
      }
    }
  }
  const unique = new Set(segments)
  if (mapUri) unique.add(mapUri)
  return {
    mapUri,
    segments,
    singleContainer: unique.size === 1 ? [...unique][0] : undefined,
  }
}

type HlsSource = {
  /** URLs a descargar y concatenar en orden (init + segmentos, o 1 contenedor). */
  urls: string[]
  /** Segmentos MPEG-TS: el audio ya viene entrelazado, basta concatenar. */
  tsConcat: boolean
}

/** Resuelve una playlist HLS (master o media) a la lista de URLs a descargar. */
async function resolveHlsSource(playlistUrl: string): Promise<HlsSource> {
  const text = await (await fetch(playlistUrl, { credentials: "omit" })).text()

  if (text.includes("#EXT-X-STREAM-INF")) {
    const variants = parseHlsMasterVariants(text, playlistUrl)
    if (!variants.length) throw new Error("Manifiesto HLS sin variantes")
    return resolveHlsSource(variants[0].url)
  }

  const playlist = parseHlsMediaPlaylist(text, playlistUrl)
  if (!playlist.segments.length) {
    throw new Error("La playlist HLS no contiene segmentos")
  }

  // X referencia un único .mp4 por rangos de bytes (#EXT-X-BYTERANGE): basta
  // con descargar el archivo contenedor completo.
  if (playlist.singleContainer) {
    return { urls: [playlist.singleContainer], tsConcat: false }
  }

  return {
    urls: playlist.mapUri
      ? [playlist.mapUri, ...playlist.segments]
      : playlist.segments,
    tsConcat: /\.ts(\?|$)/.test(playlist.segments[0]),
  }
}

/** Descarga vía offscreen: concatena segmentos y muxea audio si hace falta. */
async function muxAndDownload(
  stream: CapturedStream,
  video: HlsSource,
  audioUrls?: string[],
): Promise<{ ok: boolean; error?: string; url?: string; note?: string }> {
  console.info(
    `[subvid:net] descarga: ${video.urls.length} parte(s) de video, ` +
      `${audioUrls?.length || 0} de audio, tsConcat=${video.tsConcat}`,
  )
  await ensureOffscreen()
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "mux-download",
    request: {
      video: video.urls,
      audio: video.tsConcat ? undefined : audioUrls,
      tsConcat: video.tsConcat,
    },
  })
  if (!response?.ok || !response.blobUrl) {
    return {
      ok: false,
      url: stream.url,
      error: response?.error || "No se pudo descargar el stream",
    }
  }
  await chrome.downloads.download({
    url: response.blobUrl,
    filename: filenameFor(stream, response.ext || "mp4"),
    conflictAction: "uniquify",
  })
  return { ok: true, url: stream.url, note: response.note }
}

async function downloadStreamEntry(
  stream: CapturedStream,
  variantUrl?: string,
): Promise<{ ok: boolean; error?: string; url?: string; note?: string }> {
  if (stream.kind === "video") {
    // Si el mismo CDN sirvió una pista de audio separada (FB/IG), el MP4 es
    // probablemente solo-video: lo pasamos por el mux. Si no, descarga directa.
    const companion = audioCompanionFor(stream)
    if (companion) {
      return muxAndDownload(
        stream,
        { urls: [stream.url], tsConcat: false },
        [companion],
      )
    }
    await chrome.downloads.download({
      url: stream.url,
      filename: filenameFor(stream, stream.url.includes(".webm") ? "webm" : "mp4"),
      conflictAction: "uniquify",
    })
    return { ok: true, url: stream.url }
  }

  if (stream.kind === "hls") {
    const playlistUrl =
      variantUrl ||
      (stream.isMaster && stream.variants?.length
        ? stream.variants[0].url
        : stream.url)
    const video = await resolveHlsSource(playlistUrl)

    let audioUrls: string[] | undefined
    if (!video.tsConcat && stream.audioPlaylistUrl) {
      try {
        audioUrls = (await resolveHlsSource(stream.audioPlaylistUrl)).urls
      } catch (error) {
        console.warn("[subvid:net] no se pudo resolver la pista de audio HLS", error)
      }
    }
    if (!audioUrls?.length) {
      const companion = audioCompanionFor(stream)
      if (companion) audioUrls = [companion]
    }

    return muxAndDownload(stream, video, audioUrls)
  }

  // DASH: el manifiesto ya está analizado, pero la descarga completa de
  // representaciones segmentadas aún no está implementada.
  return {
    ok: false,
    url: stream.url,
    error:
      "DASH detectado: copia la URL del manifiesto y úsala con yt-dlp o ffmpeg para la descarga completa.",
  }
}

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

    case "get-streams":
      await streamsRestored
      return { ok: true, streams: streamsForTab(message.tabId) }

    case "download-stream": {
      await streamsRestored
      const stream = streamsForTab(message.tabId).find(
        (entry) => entry.id === message.streamId,
      )
      if (!stream) return { ok: false, error: "No se encontró la URL del stream" }
      return downloadStreamEntry(stream, message.variantUrl)
    }

    case "download-best-stream": {
      const tabId = sender.tab?.id || message.tabId
      if (!tabId) return { ok: false, error: "No se encontró la pestaña" }
      await streamsRestored
      const stream = bestStreamForTab(tabId)
      if (!stream) {
        return {
          ok: false,
          error:
            "Todavía no se detectó una URL de video. Reproduce el video unos segundos e inténtalo otra vez.",
        }
      }
      return downloadStreamEntry(stream)
    }

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

// onResponseStarted (y no onBeforeRequest) para poder leer las cabeceras de
// respuesta: Content-Type y tamaño real son la base de la validación.
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (typeof details.tabId !== "number" || details.tabId < 0) return
    if (details.statusCode < 200 || details.statusCode >= 300) return
    if (details.url.startsWith("chrome-extension://")) return

    let path = ""
    try {
      path = new URL(details.url).pathname.toLowerCase()
    } catch {
      return
    }
    const contentType = (headerValue(details.responseHeaders, "content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase()

    const result = classifyResponse(details.url, contentType, path)
    if (!result) return

    const sizeBytes = totalSizeFromHeaders(details.responseHeaders)

    if ("reason" in result) {
      if (result.isAudioTrack) rememberAudioTrack(details.tabId, details.url)
      logStreamDecision(
        "descartado",
        details.url,
        contentType,
        sizeBytes,
        undefined,
        result.reason,
      )
      return
    }

    const { url: normalizedUrl, normalized } = normalizeStreamUrl(details.url)

    if (
      result.kind === "video" &&
      !normalized &&
      sizeBytes !== undefined &&
      sizeBytes < MIN_VIDEO_BYTES
    ) {
      logStreamDecision(
        "descartado",
        details.url,
        contentType,
        sizeBytes,
        result,
        `tamaño menor a ${formatBytes(MIN_VIDEO_BYTES)} (probable fragmento o preview)`,
      )
      return
    }

    logStreamDecision("aceptado", normalizedUrl, contentType, sizeBytes, result)

    void rememberStream({
      tabId: details.tabId,
      url: normalizedUrl,
      kind: result.kind,
      contentType: contentType || undefined,
      sizeBytes,
      resolution: resolutionFromUrl(normalizedUrl),
      detectedBy: normalized
        ? `${result.detectedBy} + rango bytestart/byteend eliminado`
        : result.detectedBy,
    })
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
  ["responseHeaders"],
)

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) void stopCapture()
  streamsByTab.delete(tabId)
  audioTracksByTab.delete(tabId)
  persistStreams()
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
