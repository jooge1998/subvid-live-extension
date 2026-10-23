// The transcript as a single editable document: one line per subtitle and one
// span per word. On the transcription track, deleting words cuts them from the
// video (they stay struck through so they can be restored) and typing corrects
// the text without touching the audio. Translation tracks are plain text.
import { keptParts, type TimeRange } from "@/scripts/cuts.ts"
import {
  estimatedWordsForSegment,
  wordsText,
  type SubtitleSegment,
  type SubtitleWord,
} from "@/scripts/subtitles.ts"

type Segment = SubtitleSegment
type WordRef = { line: number; word: number }
type WordHit = WordRef & {
  span: HTMLElement
  from: number
  to: number
  partial: boolean
}
type CaretInfo = {
  line: number
  /** Last word ending at or before the caret. */
  before?: number
  /** First word starting at or after the caret. */
  after?: number
  /** Word the caret is strictly inside of. */
  inside?: { word: number; offset: number; span: HTMLElement }
}
type CaretMark = { chars: number; space: boolean }
type Token = { text: string; sources: number[]; word?: SubtitleWord }

type TranscriptEditorOptions = {
  root: HTMLElement
  tt: (path: string, vars?: Record<string, unknown>) => string
  segmentsFor: (lang: string) => Segment[]
  activeLang: () => string
  /** The track whose words drive the cuts (the transcription). */
  sourceLang: () => string
  cutRanges: () => TimeRange[]
  snapshotSegments: () => string
  pushHistory: (snapshotBefore: string) => void
  undo: () => void
  redo: () => void
  seek: (time: number) => void
  /** Text changed while typing: captions should follow. */
  onTextChange: () => void
  /** Words were cut/restored or lines split/merged. */
  onStructureChange: () => void
}

const TEXT_EDIT_IDLE_MS = 1200

function setEditable(el: HTMLElement, on: boolean) {
  if (!on) {
    el.contentEditable = "false"
    return
  }
  try {
    el.contentEditable = "plaintext-only"
  } catch {
    el.contentEditable = "true"
  }
}

function shortClock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function nonSpaceLength(text: string) {
  return text.replace(/\s/g, "").length
}

export function createTranscriptEditor(options: TranscriptEditorOptions) {
  const {
    root,
    tt,
    segmentsFor,
    activeLang,
    sourceLang,
    cutRanges,
    snapshotSegments,
    pushHistory,
    undo,
    redo,
    seek,
    onTextChange,
    onStructureChange,
  } = options

  let renderedLang = ""
  let pendingSnapshot: string | null = null
  let commitTimer = 0
  let wordTimes: Array<{ start: number; end: number; el: HTMLElement }> = []
  let wordTimesDirty = true
  let currentWord: HTMLElement | null = null
  let activeLine: HTMLElement | null = null

  const segments = () => segmentsFor(activeLang())
  const cutMode = () => !!activeLang() && activeLang() === sourceLang()

  // ── Model helpers ──

  function ensureWords(seg: Segment) {
    const kept = (seg.words || []).filter((word) => !word.cut)
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
    if (seg.words?.length && normalize(wordsText(kept)) === normalize(seg.text))
      return seg.words
    // No word timings (or text edited elsewhere): estimate them from the line.
    seg.words = estimatedWordsForSegment({ ...seg, words: undefined }).map(
      (word) => ({ ...word }),
    )
    return seg.words
  }

  function syncText(seg: Segment) {
    seg.text = wordsText((seg.words || []).filter((word) => !word.cut))
  }

  // ── Rendering ──

  function cutGroup(words: SubtitleWord[], from: number, to: number) {
    const group = document.createElement("span")
    group.className = "tx-cut"
    group.contentEditable = "false"
    group.dataset.from = String(from)
    group.dataset.to = String(to)
    group.title = tt("transcript.restore")
    group.textContent = wordsText(words.slice(from, to))
    return group
  }

  function renderLine(seg: Segment, index: number) {
    const line = document.createElement("p")
    line.className = "tx-line"
    line.dataset.index = String(index)
    line.dataset.time = shortClock(seg.start)

    if (!cutMode()) {
      line.classList.add("is-plain")
      const ranges = cutRanges()
      const fullyCut =
        ranges.length > 0 && keptParts(ranges, seg.start, seg.end).length === 0
      line.classList.toggle("is-cut", fullyCut)
      setEditable(line, !fullyCut)
      line.spellcheck = false
      line.textContent = seg.text
      return line
    }

    const words = ensureWords(seg)
    let i = 0
    while (i < words.length) {
      if (i > 0) line.append(" ")
      if (words[i].cut) {
        const from = i
        while (i < words.length && words[i].cut) i += 1
        line.append(cutGroup(words, from, i))
        continue
      }
      const span = document.createElement("span")
      span.className = "tx-w"
      span.dataset.w = String(i)
      span.textContent = words[i].text
      line.append(span)
      i += 1
    }
    line.classList.toggle("is-cut", words.length > 0 && words.every((w) => w.cut))
    if (!words.length) line.append(document.createElement("br"))
    return line
  }

  function render() {
    commitPendingEdit()
    const segs = segments()
    renderedLang = activeLang()
    currentWord = null
    activeLine = null
    wordTimesDirty = true
    root.classList.toggle("is-plain", !cutMode())

    if (!segs.length) {
      setEditable(root, false)
      root.innerHTML = `<p class="tx-empty">${tt("segEmpty")}</p>`
      return
    }

    setEditable(root, cutMode())
    root.spellcheck = false
    const fragment = document.createDocumentFragment()
    segs.forEach((seg, index) => fragment.append(renderLine(seg, index)))
    root.replaceChildren(fragment)
  }

  function renderLineAt(index: number) {
    const seg = segments()[index]
    const old = lineEl(index)
    if (!seg || !old) return render()
    old.replaceWith(renderLine(seg, index))
    wordTimesDirty = true
  }

  // ── DOM lookups ──

  function lineEl(index: number) {
    return root.querySelector<HTMLElement>(`.tx-line[data-index="${index}"]`)
  }

  function lineOf(node: Node | null) {
    const el = node instanceof Element ? node : node?.parentElement
    const line = el?.closest<HTMLElement>(".tx-line")
    return line && root.contains(line) ? line : null
  }

  function wordSpans(line: HTMLElement) {
    return [...line.querySelectorAll<HTMLElement>(".tx-w")]
  }

  function wordSpan(line: HTMLElement, word: number) {
    return line.querySelector<HTMLElement>(`.tx-w[data-w="${word}"]`)
  }

  function textOffsetWithin(el: HTMLElement, node: Node, offset: number) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.setEnd(node, offset)
    return range.toString().length
  }

  function selectionRange() {
    const selection = window.getSelection()
    if (!selection?.rangeCount) return null
    const range = selection.getRangeAt(0)
    return root.contains(range.commonAncestorContainer) ? range : null
  }

  function caretInfo(range: Range): CaretInfo | null {
    const line = lineOf(range.startContainer)
    if (!line) return null
    const info: CaretInfo = { line: Number(line.dataset.index) }
    for (const span of wordSpans(line)) {
      const word = Number(span.dataset.w)
      if (range.comparePoint(span, 0) >= 0) {
        info.after = word
        break
      }
      if (range.comparePoint(span, span.childNodes.length) <= 0) {
        info.before = word
        continue
      }
      const offset = textOffsetWithin(span, range.startContainer, range.startOffset)
      const length = span.textContent?.length || 0
      if (offset <= 0) {
        info.after = word
        break
      }
      if (offset >= length) {
        info.before = word
        continue
      }
      info.inside = { word, offset, span }
      break
    }
    return info
  }

  function selectedWords(range: Range): WordHit[] {
    const hits: WordHit[] = []
    root.querySelectorAll<HTMLElement>(".tx-line").forEach((line) => {
      if (!range.intersectsNode(line)) return
      for (const span of wordSpans(line)) {
        if (!range.intersectsNode(span)) continue
        const length = span.textContent?.length || 0
        const from = span.contains(range.startContainer)
          ? textOffsetWithin(span, range.startContainer, range.startOffset)
          : 0
        const to = span.contains(range.endContainer)
          ? textOffsetWithin(span, range.endContainer, range.endOffset)
          : length
        if (to <= from) continue
        hits.push({
          line: Number(line.dataset.index),
          word: Number(span.dataset.w),
          span,
          from,
          to,
          partial: from > 0 || to < length,
        })
      }
    })
    return hits
  }

  // ── Caret ──

  function setCaret(node: Node, offset: number) {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function caretAtWord(line: number, word: number, edge: "start" | "end") {
    const el = lineEl(line)
    const span = el && wordSpan(el, word)
    if (!span) {
      if (el) setCaret(el, 0)
      return
    }
    const text = span.firstChild || span
    setCaret(text, edge === "start" ? 0 : text.textContent?.length || 0)
  }

  /** Puts the caret next to the closest word that is still in the video. */
  function caretNear(line: number, word: number, prefer: "before" | "after") {
    const words = segments()[line]?.words || []
    let previous = -1
    for (let i = Math.min(word, words.length) - 1; i >= 0; i -= 1)
      if (!words[i].cut) {
        previous = i
        break
      }
    let next = -1
    for (let i = Math.max(0, word); i < words.length; i += 1)
      if (!words[i].cut) {
        next = i
        break
      }
    if (prefer === "before" && previous >= 0) caretAtWord(line, previous, "end")
    else if (next >= 0) caretAtWord(line, next, "start")
    else if (previous >= 0) caretAtWord(line, previous, "end")
    else caretAtWord(line, -1, "start")
  }

  // Counting non-space characters survives re-renders that normalize spaces.
  function caretMark(line: HTMLElement, node: Node, offset: number): CaretMark {
    const range = document.createRange()
    range.setStart(line, 0)
    range.setEnd(node, offset)
    const fragment = range.cloneContents()
    fragment.querySelectorAll(".tx-cut").forEach((el) => el.remove())
    const text = fragment.textContent || ""
    return { chars: nonSpaceLength(text), space: /\s$/.test(text) }
  }

  function restoreCaret(line: HTMLElement, mark: CaretMark) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let count = 0
    let target: { node: Text; offset: number } | null = null
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      if (node.parentElement?.closest(".tx-cut")) continue
      if (!target && mark.chars === 0) target = { node, offset: 0 }
      for (let i = 0; i < node.data.length && !target; i += 1) {
        if (/\s/.test(node.data[i])) continue
        count += 1
        if (count === mark.chars) target = { node, offset: i + 1 }
      }
      if (target) break
    }
    if (!target) {
      setCaret(line, line.childNodes.length)
      return
    }
    if (mark.space) {
      const { node: text, offset } = target
      if (/\s/.test(text.data[offset] || "")) target.offset += 1
    }
    setCaret(target.node, target.offset)
  }

  // ── History ──

  function beginTextEdit() {
    pendingSnapshot ??= snapshotSegments()
    window.clearTimeout(commitTimer)
    commitTimer = window.setTimeout(commitPendingEdit, TEXT_EDIT_IDLE_MS)
  }

  function commitPendingEdit() {
    window.clearTimeout(commitTimer)
    if (pendingSnapshot && pendingSnapshot !== snapshotSegments())
      pushHistory(pendingSnapshot)
    pendingSnapshot = null
  }

  function structuralChange(apply: () => void) {
    commitPendingEdit()
    const before = snapshotSegments()
    apply()
    pushHistory(before)
    onStructureChange()
  }

  // ── Cuts ──

  function cutWords(refs: WordRef[], prefer: "before" | "after") {
    const segs = segments()
    const targets = refs.filter(({ line, word }) => {
      const w = segs[line]?.words?.[word]
      return w && !w.cut
    })
    if (!targets.length) return
    structuralChange(() => {
      const lines = new Set<number>()
      targets.forEach(({ line, word }) => {
        segs[line].words![word].cut = true
        lines.add(line)
      })
      lines.forEach((line) => {
        syncText(segs[line])
        renderLineAt(line)
      })
    })
    const anchor = prefer === "before" ? targets[0] : targets[targets.length - 1]
    caretNear(
      anchor.line,
      prefer === "before" ? anchor.word : anchor.word + 1,
      prefer,
    )
  }

  function restoreWords(line: number, from: number, to: number) {
    const seg = segments()[line]
    if (!seg?.words) return
    structuralChange(() => {
      for (let i = from; i < to; i += 1) if (seg.words![i]) seg.words![i].cut = false
      syncText(seg)
      renderLineAt(line)
    })
  }

  // ── Text corrections ──

  function editWordText(ref: WordRef, span: HTMLElement, text: string, caret: number) {
    const seg = segments()[ref.line]
    const word = seg?.words?.[ref.word]
    if (!word) return
    beginTextEdit()
    word.text = text
    syncText(seg)
    span.textContent = text
    if (span.firstChild) setCaret(span.firstChild, caret)
    onTextChange()
  }

  function deleteChars(info: CaretInfo, event: InputEvent, forward: boolean) {
    const inside = info.inside!
    const text = inside.span.textContent || ""
    let from = forward ? inside.offset : inside.offset - 1
    let to = forward ? inside.offset + 1 : inside.offset
    // Trust the browser on grapheme boundaries when it tells us.
    const target = event.getTargetRanges?.()[0]
    if (target && inside.span.contains(target.startContainer)) {
      from = textOffsetWithin(inside.span, target.startContainer, target.startOffset)
      to = textOffsetWithin(inside.span, target.endContainer, target.endOffset)
    }
    if (to <= from || to - from >= text.length) {
      cutWords([{ line: info.line, word: inside.word }], forward ? "after" : "before")
      return
    }
    editWordText(
      { line: info.line, word: inside.word },
      inside.span,
      text.slice(0, from) + text.slice(to),
      from,
    )
  }

  function wordsInLine(line: number, from: number, to: number): WordRef[] {
    const refs: WordRef[] = []
    const words = segments()[line]?.words || []
    for (let i = Math.max(0, from); i <= Math.min(to, words.length - 1); i += 1)
      if (!words[i].cut) refs.push({ line, word: i })
    return refs
  }

  function handleDelete(event: InputEvent) {
    const range = selectionRange()
    if (!range) return
    const type = event.inputType
    const forward = type.endsWith("Forward")

    if (!range.collapsed) {
      const hits = selectedWords(range)
      if (hits.length === 1 && hits[0].partial) {
        const [hit] = hits
        const text = hit.span.textContent || ""
        editWordText(hit, hit.span, text.slice(0, hit.from) + text.slice(hit.to), hit.from)
        return
      }
      cutWords(hits, "before")
      return
    }

    const info = caretInfo(range)
    if (!info) return
    const { line, before, after, inside } = info

    if (/Line(Backward|Forward)$/.test(type)) {
      const pivot = inside?.word ?? (forward ? after : before)
      if (pivot == null) return
      cutWords(
        forward ? wordsInLine(line, pivot, Infinity) : wordsInLine(line, 0, pivot),
        forward ? "after" : "before",
      )
      return
    }

    if (inside) {
      if (type.startsWith("deleteWord"))
        cutWords([{ line, word: inside.word }], forward ? "after" : "before")
      else deleteChars(info, event, forward)
      return
    }

    const target = forward ? after : before
    if (target != null) {
      cutWords([{ line, word: target }], forward ? "after" : "before")
      return
    }
    // At the edge of a line: join it with its neighbour, like a text editor.
    mergeLines(forward ? line : line - 1)
  }

  function replaceSelection(range: Range, text: string) {
    const hits = selectedWords(range)
    if (!hits.length) {
      // Insert at the start of the selection and reconcile, as the `input`
      // event would (undo/redo are handled by the editor, not the browser).
      range.collapse(true)
      const node = document.createTextNode(text)
      range.insertNode(node)
      setCaret(node, text.length)
      reconcileFromSelection()
      return
    }
    const segs = segments()
    const [first] = hits
    const last = hits[hits.length - 1]
    const prefix = (first.span.textContent || "").slice(0, first.from)
    const suffix = (last.span.textContent || "").slice(last.to)
    const sameLine = last.line === first.line
    const caretChars =
      (segs[first.line].words || [])
        .slice(0, first.word)
        .filter((word) => !word.cut)
        .reduce((sum, word) => sum + nonSpaceLength(word.text), 0) +
      nonSpaceLength(prefix + text)

    structuralChange(() => {
      const firstWord = segs[first.line].words![first.word]
      const lineHits = hits.filter((hit) => hit.line === first.line)
      firstWord.text = `${prefix}${text}${sameLine ? suffix : ""}`
      firstWord.end = Math.max(
        firstWord.end,
        segs[first.line].words![lineHits[lineHits.length - 1].word].end,
      )
      // The other selected words are replaced, not cut: their audio stays.
      // A partly selected last word on another line keeps its unselected end.
      if (!sameLine && suffix)
        segs[last.line].words![last.word].text = suffix
      const removed = new Set(
        hits
          .slice(1)
          .filter((hit) => sameLine || hit !== last || !suffix)
          .map((hit) => `${hit.line}:${hit.word}`),
      )
      segs.forEach((seg, line) => {
        if (seg.words && hits.some((hit) => hit.line === line))
          seg.words = seg.words.filter((_, word) => !removed.has(`${line}:${word}`))
      })
      splitSpaces(segs[first.line])
      for (let line = segs.length - 1; line >= first.line; line -= 1) {
        if (!hits.some((hit) => hit.line === line)) continue
        if (line > first.line && !segs[line].words?.length) segs.splice(line, 1)
        else syncText(segs[line])
      }
      render()
    })

    const line = lineEl(first.line)
    if (line) restoreCaret(line, { chars: caretChars, space: /\s$/.test(text) })
  }

  /** Splits words containing spaces, sharing out their timing. */
  function splitSpaces(seg: Segment) {
    if (!seg.words) return
    seg.words = seg.words.flatMap((word) => {
      const parts = word.text.split(/\s+/).filter(Boolean)
      if (parts.length <= 1) return [{ ...word, text: parts[0] ?? word.text }]
      const total = parts.reduce((sum, part) => sum + part.length, 0)
      let cursor = word.start
      return parts.map((part, index) => {
        const end =
          index === parts.length - 1
            ? word.end
            : cursor + ((word.end - word.start) * part.length) / total
        const next = { ...word, start: cursor, end, text: part }
        cursor = end
        return next
      })
    })
  }

  // ── Lines ──

  function splitLine(range: Range) {
    const info = caretInfo(range)
    if (!info) return
    const segs = segments()
    const seg = segs[info.line]
    if (!seg) return
    const words = ensureWords(seg)
    let at = info.after ?? words.length
    if (info.inside) {
      const length = info.inside.span.textContent?.length || 0
      at = info.inside.offset >= length / 2 ? info.inside.word + 1 : info.inside.word
    }
    if (at <= 0 || at >= words.length) return

    structuralChange(() => {
      const head = words.slice(0, at)
      const tail = words.slice(at)
      const end = seg.end
      seg.words = head
      seg.end = Math.max(seg.start + 0.1, head[head.length - 1].end)
      const next: Segment = {
        start: Math.max(seg.end, tail[0].start),
        end: Math.max(end, tail[tail.length - 1].end),
        text: "",
        words: tail,
      }
      syncText(seg)
      syncText(next)
      segs.splice(info.line + 1, 0, next)
      render()
    })
    caretNear(info.line + 1, 0, "after")
  }

  function mergeLines(first: number) {
    const segs = segments()
    const a = segs[first]
    const b = segs[first + 1]
    if (!a || !b) return
    const join = ensureWords(a).length
    ensureWords(b)
    structuralChange(() => {
      a.words = [...a.words!, ...b.words!]
      a.start = Math.min(a.start, b.start)
      a.end = Math.max(a.end, b.end)
      syncText(a)
      segs.splice(first + 1, 1)
      render()
    })
    caretNear(first, join, "before")
  }

  // ── Reading typed text back ──

  // Native typing lands wherever the browser puts it (inside a word span or in
  // the spaces between them). Every character is tagged with the word it came
  // from, so retyped words keep their timing and new words get none.
  function reconcileLine(line: HTMLElement) {
    const index = Number(line.dataset.index)
    const seg = segments()[index]
    if (!seg) return
    const oldWords = seg.words || []
    type Item = { kind: "chars"; chars: Array<[string, number]> } | { kind: "cut"; from: number; to: number }
    const items: Item[] = []
    let chars: Array<[string, number]> = []
    let looseText = false
    const flush = () => {
      if (chars.length) items.push({ kind: "chars", chars })
      chars = []
    }
    const walk = (node: Node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const owner = child.parentElement?.closest<HTMLElement>(".tx-w")
          const source = owner ? Number(owner.dataset.w) : -1
          const data = (child as Text).data
          if (source < 0 && data.trim()) looseText = true
          for (const ch of data) chars.push([ch, source])
        } else if (child instanceof HTMLElement) {
          if (child.classList.contains("tx-cut")) {
            flush()
            items.push({
              kind: "cut",
              from: Number(child.dataset.from),
              to: Number(child.dataset.to),
            })
          } else if (child.tagName === "BR") chars.push([" ", -1])
          else walk(child)
        }
      })
    }
    walk(line)
    flush()

    const sequence: Array<Token | SubtitleWord> = []
    const tokens: Token[] = []
    items.forEach((item) => {
      if (item.kind === "cut") {
        sequence.push(...oldWords.slice(item.from, item.to))
        return
      }
      let text = ""
      let sources = new Set<number>()
      const push = () => {
        if (!text) return
        const token = { text, sources: [...sources].filter((s) => s >= 0) }
        tokens.push(token)
        sequence.push(token)
        text = ""
        sources = new Set()
      }
      item.chars.forEach(([ch, source]) => {
        if (/\s/.test(ch)) push()
        else {
          text += ch
          sources.add(source)
        }
      })
      push()
    })

    // Timing: a word split in several tokens shares its time; merged words
    // span all of theirs; brand-new words get a zero-length slot.
    const bySource = new Map<number, Token[]>()
    tokens.forEach((token) => {
      if (token.sources.length !== 1) return
      const group = bySource.get(token.sources[0]) || []
      group.push(token)
      bySource.set(token.sources[0], group)
    })
    bySource.forEach((group, source) => {
      const original = oldWords[source]
      if (!original) return
      // Typing a new word right next to an existing one lands in its span:
      // the untouched word keeps its time and the new ones get none.
      const kept = group.findIndex((token) => token.text === original.text)
      if (kept >= 0) {
        group.forEach((token, i) => {
          const at = i < kept ? original.start : original.end
          token.word =
            i === kept
              ? { start: original.start, end: original.end, text: token.text }
              : { start: at, end: at, text: token.text }
        })
        return
      }
      const total = group.reduce((sum, token) => sum + token.text.length, 0)
      let cursor = original.start
      group.forEach((token, i) => {
        const end =
          i === group.length - 1
            ? original.end
            : cursor + ((original.end - original.start) * token.text.length) / total
        token.word = { start: cursor, end, text: token.text }
        cursor = end
      })
    })
    tokens.forEach((token) => {
      if (token.sources.length < 2) return
      const merged = token.sources.map((source) => oldWords[source]).filter(Boolean)
      token.word = {
        start: Math.min(...merged.map((w) => w.start)),
        end: Math.max(...merged.map((w) => w.end)),
        text: token.text,
      }
    })
    let lastEnd: number | null = null
    const next = sequence.map((item, i) => {
      let word = "sources" in item ? item.word : item
      if (!word) {
        const following = sequence
          .slice(i + 1)
          .map((rest) => ("sources" in rest ? rest.word : rest))
          .find(Boolean)
        const at = lastEnd ?? following?.start ?? seg.start
        word = { start: at, end: at, text: (item as Token).text }
      }
      lastEnd = word.end
      return word
    })

    const structural =
      next.length !== oldWords.length ||
      next.some(
        (word, i) =>
          word.start !== oldWords[i].start ||
          word.end !== oldWords[i].end ||
          !!word.cut !== !!oldWords[i].cut,
      )
    const drifted = wordSpans(line).some(
      (span) => (span.textContent || "").trim() !== next[Number(span.dataset.w)]?.text,
    )
    const changed =
      structural || next.some((word, i) => word.text !== oldWords[i]?.text)
    if (!changed && !looseText) return

    beginTextEdit()
    seg.words = next
    syncText(seg)
    if (structural || looseText || drifted) {
      const selection = window.getSelection()
      const mark =
        selection?.rangeCount && line.contains(selection.anchorNode)
          ? caretMark(line, selection.anchorNode!, selection.anchorOffset)
          : null
      renderLineAt(index)
      const fresh = lineEl(index)
      if (fresh && mark) restoreCaret(fresh, mark)
    }
    onTextChange()
  }

  function reconcilePlainLine(line: HTMLElement) {
    const seg = segments()[Number(line.dataset.index)]
    if (!seg) return
    const text = (line.textContent || "").replace(/\n/g, " ")
    if (text === seg.text) return
    beginTextEdit()
    seg.text = text
    onTextChange()
  }

  function reconcileFromSelection() {
    const range = selectionRange()
    const line = lineOf(range?.startContainer || null)
    if (!line) {
      // Text typed outside any line: drop it and redraw.
      if ([...root.childNodes].some((n) => !(n instanceof HTMLElement && n.matches(".tx-line"))))
        render()
      return
    }
    if (line.classList.contains("is-plain")) reconcilePlainLine(line)
    else reconcileLine(line)
  }

  // ── Copy / cut keep the struck words out ──

  function selectedPlainText(range: Range) {
    const fragment = range.cloneContents()
    fragment.querySelectorAll(".tx-cut").forEach((el) => el.remove())
    const lines = [...fragment.querySelectorAll(".tx-line")]
    if (!lines.length) return (fragment.textContent || "").replace(/\s+/g, " ").trim()
    return lines
      .map((line) => (line.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
  }

  // ── Playback highlight ──

  function rebuildWordTimes() {
    wordTimesDirty = false
    wordTimes = []
    if (!cutMode()) return
    const segs = segments()
    root.querySelectorAll<HTMLElement>(".tx-line").forEach((line) => {
      const words = segs[Number(line.dataset.index)]?.words || []
      wordSpans(line).forEach((el) => {
        const word = words[Number(el.dataset.w)]
        if (word) wordTimes.push({ start: word.start, end: word.end, el })
      })
    })
    wordTimes.sort((a, b) => a.start - b.start)
  }

  function highlightTime(time: number) {
    if (renderedLang !== activeLang()) return
    if (wordTimesDirty) rebuildWordTimes()
    let lo = 0
    let hi = wordTimes.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (wordTimes[mid].start <= time) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    const hit = found >= 0 && time <= wordTimes[found].end + 0.08 ? wordTimes[found].el : null
    if (hit === currentWord) return
    currentWord?.classList.remove("is-current")
    hit?.classList.add("is-current")
    currentWord = hit
  }

  function setActiveLine(index: number, lang: string, scroll: boolean) {
    if (lang !== renderedLang) return
    const line = index >= 0 ? lineEl(index) : null
    if (line !== activeLine) {
      activeLine?.classList.remove("is-active")
      line?.classList.add("is-active")
      activeLine = line
    }
    if (line && scroll && !root.contains(document.activeElement))
      line.scrollIntoView({ block: "nearest" })
  }

  // ── Events ──

  function wire() {
    root.addEventListener("beforeinput", (event: InputEvent) => {
      const type = event.inputType
      if (type === "historyUndo" || type === "historyRedo") {
        event.preventDefault()
        commitPendingEdit()
        if (type === "historyUndo") undo()
        else redo()
        return
      }
      if (
        type.startsWith("format") ||
        type === "insertParagraph" ||
        type === "insertLineBreak" ||
        type === "insertFromDrop" ||
        type === "deleteByDrag"
      ) {
        event.preventDefault()
        if (type === "insertParagraph" || type === "insertLineBreak") {
          const range = selectionRange()
          if (range && cutMode()) splitLine(range)
        }
        return
      }
      if (!cutMode()) return

      if (type.startsWith("delete")) {
        event.preventDefault()
        handleDelete(event)
        return
      }
      if (event.isComposing) return
      const range = selectionRange()
      const target = event.getTargetRanges?.()[0]
      const replacing = range && !range.collapsed ? range : null
      const targetRange =
        replacing ||
        (target && !target.collapsed && type === "insertReplacementText"
          ? (() => {
              const r = document.createRange()
              r.setStart(target.startContainer, target.startOffset)
              r.setEnd(target.endContainer, target.endOffset)
              return r
            })()
          : null)
      if (targetRange) {
        const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? ""
        event.preventDefault()
        replaceSelection(targetRange, text.replace(/\s+/g, " "))
      }
    })

    root.addEventListener("input", (event) => {
      if ((event as InputEvent).isComposing) return
      reconcileFromSelection()
    })
    root.addEventListener("compositionend", () => reconcileFromSelection())

    root.addEventListener("copy", (event: ClipboardEvent) => {
      const range = selectionRange()
      if (!range || range.collapsed || !event.clipboardData) return
      event.preventDefault()
      event.clipboardData.setData("text/plain", selectedPlainText(range))
    })
    root.addEventListener("cut", (event: ClipboardEvent) => {
      const range = selectionRange()
      if (!range || range.collapsed || !event.clipboardData) return
      event.preventDefault()
      event.clipboardData.setData("text/plain", selectedPlainText(range))
      if (cutMode()) cutWords(selectedWords(range), "before")
    })
    root.addEventListener("dragstart", (event) => event.preventDefault())

    root.addEventListener("mousedown", (event) => {
      // Keep the caret where it is when restoring words.
      if ((event.target as Element).closest(".tx-cut")) event.preventDefault()
    })

    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement
      const group = target.closest<HTMLElement>(".tx-cut")
      const line = target.closest<HTMLElement>(".tx-line")
      if (!line) return
      const index = Number(line.dataset.index)
      const seg = segments()[index]
      if (!seg) return
      if (group) {
        restoreWords(index, Number(group.dataset.from), Number(group.dataset.to))
        return
      }
      // The timestamp gutter is the line's ::before.
      const gutter = parseFloat(getComputedStyle(line).paddingLeft) || 0
      if (event.clientX < line.getBoundingClientRect().left + gutter) {
        seek(seg.start)
        return
      }
      const span = target.closest<HTMLElement>(".tx-w")
      const word = span && seg.words?.[Number(span.dataset.w)]
      if (!window.getSelection()?.isCollapsed) return
      if (word) seek(word.start)
      else if (line.classList.contains("is-plain")) seek(seg.start)
    })

    root.addEventListener("focusout", (event) => {
      if (root.contains(event.relatedTarget as Node)) return
      commitPendingEdit()
      if (!cutMode()) {
        segments().forEach((seg) => {
          seg.text = seg.text.replace(/\s+/g, " ").trim()
        })
      }
    })
  }

  wire()

  return {
    render,
    renderedLang: () => renderedLang,
    commitPendingEdit,
    highlightTime,
    setActiveLine,
  }
}

export type TranscriptEditor = ReturnType<typeof createTranscriptEditor>
