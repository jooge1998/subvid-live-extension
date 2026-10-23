import { PREVIEW_SAMPLES } from "@/scripts/languages.ts"
import type { TranscriptPreview } from "@/scripts/stages/configStage.ts"
import type { ui as appUi } from "@/scripts/ui.ts"

type SubtitlePreviewOptions = {
  ui: typeof appUi
}

// Word-by-word pace of the preview, close to normal speech.
const WORD_MS = 320
// Pause with the whole line spoken before the loop starts again.
const HOLD_MS = 1400
// Roughly one subtitle line.
const MAX_CHARS = 48

// First sentence of the transcript, trimmed to about one subtitle line. Very
// short results are skipped: on silence Whisper tends to hallucinate "you".
function firstLine(text: string) {
  const sentence = text.trim().split(/(?<=[.!?。！？])\s+/)[0] ?? ""
  const isCjk = /[぀-ヿ㐀-鿿가-힯]/.test(sentence)
  const tooShort = isCjk ? sentence.length < 6 : sentence.split(/\s+/).length < 3
  if (tooShort) return ""
  if (sentence.length <= MAX_CHARS) return sentence
  const cut = sentence.slice(0, MAX_CHARS)
  const space = cut.lastIndexOf(" ")
  return `${(space > MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[,;:]$/, "")}…`
}

// Shows, over the config video, how the subtitles will look with the chosen
// options: language, word animation and dual track. Uses a sample sentence
// until the early transcription delivers the video's real first line.
export function createSubtitlePreview({ ui }: SubtitlePreviewOptions) {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")
  const uiLang = document.documentElement.lang
  let transcript: TranscriptPreview | null = null
  let timer = 0

  const sample = (lang: string) =>
    PREVIEW_SAMPLES[lang] ?? PREVIEW_SAMPLES[uiLang] ?? PREVIEW_SAMPLES.en

  function setWords(text: string) {
    ui.configCaption.replaceChildren()
    text
      .split(/\s+/)
      .filter(Boolean)
      .forEach((word, index) => {
        if (index > 0) ui.configCaption.append(" ")
        const span = document.createElement("span")
        span.className = "caption-word"
        span.textContent = word
        ui.configCaption.append(span)
      })
  }

  function animateWords() {
    clearTimeout(timer)
    const words = [...ui.configCaption.querySelectorAll(".caption-word")]
    const speak = (count: number) =>
      words.forEach((word, index) => word.classList.toggle("is-spoken", index < count))

    if (!ui.wordAnimation.checked) return speak(words.length)
    // A frozen mid-sentence frame still shows what the animation does.
    if (reduceMotion.matches) return speak(Math.ceil(words.length / 2))

    let count = 0
    const step = () => {
      if (ui.stageConfig.hidden) return
      speak(count)
      const lineDone = count >= words.length
      count = lineDone ? 0 : count + 1
      timer = window.setTimeout(step, lineDone ? HOLD_MS : WORD_MS)
    }
    step()
  }

  function render() {
    const sourceLang = ui.inputLang.value || transcript?.lang || ""
    const targetLang = ui.outputLang.value === "same" ? sourceLang : ui.outputLang.value
    const realLine = transcript ? firstLine(transcript.text) : ""
    // Real words only fit when no translation is pending.
    const showsReal = !!realLine && (!targetLang || targetLang === sourceLang)
    const dualTrack = ui.dualTrack.checked && !ui.dualTrackField.hidden

    setWords(showsReal ? realLine : sample(targetLang))
    ui.configCaption.classList.toggle("is-word-highlight", ui.wordAnimation.checked)
    ui.configCaptionOriginal.hidden = !dualTrack
    ui.configCaptionOriginal.textContent = dualTrack ? realLine || sample(sourceLang) : ""
    animateWords()
  }

  function setTranscript(next: TranscriptPreview | null) {
    // A hallucinated transcript also has an unreliable language: drop both.
    transcript = next && firstLine(next.text) ? next : null
    render()
  }

  function wire() {
    for (const control of [ui.inputLang, ui.outputLang, ui.dualTrack, ui.wordAnimation]) {
      control.addEventListener("change", render)
    }
    // A new file resets the options without change events: re-render on entry.
    new MutationObserver(() => {
      if (!ui.stageConfig.hidden) render()
    }).observe(ui.stageConfig, { attributes: true, attributeFilter: ["hidden"] })
    reduceMotion.addEventListener("change", animateWords)
    render()
  }

  return { setTranscript, wire }
}
