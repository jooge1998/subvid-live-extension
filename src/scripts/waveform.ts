// Peak envelope of the transcription audio, drawn under the timeline tracks.
export const PEAKS_PER_SECOND = 200

export type Waveform = { peaks: Float32Array; duration: number }

export function computeWaveform(audio: Float32Array, sampleRate: number): Waveform {
  const bucket = Math.max(1, Math.round(sampleRate / PEAKS_PER_SECOND))
  const peaks = new Float32Array(Math.ceil(audio.length / bucket))
  for (let i = 0; i < peaks.length; i += 1) {
    const end = Math.min(audio.length, (i + 1) * bucket)
    let max = 0
    for (let j = i * bucket; j < end; j += 1) {
      const value = Math.abs(audio[j])
      if (value > max) max = value
    }
    peaks[i] = max
  }

  // Normalize to the loud parts, ignoring the odd spike, so quiet speech
  // still reads as a shape.
  const stride = Math.max(1, Math.floor(peaks.length / 20_000))
  const sample: number[] = []
  for (let i = 0; i < peaks.length; i += stride) sample.push(peaks[i])
  sample.sort((a, b) => a - b)
  const reference = sample[Math.floor((sample.length - 1) * 0.995)] || 1
  for (let i = 0; i < peaks.length; i += 1)
    peaks[i] = Math.min(1, peaks[i] / reference)

  return { peaks, duration: audio.length / sampleRate }
}

/** Highest peak in [from, to) seconds. */
export function peakBetween(waveform: Waveform, from: number, to: number) {
  const { peaks } = waveform
  const start = Math.max(0, Math.floor(from * PEAKS_PER_SECOND))
  const end = Math.min(
    peaks.length,
    Math.max(start + 1, Math.ceil(to * PEAKS_PER_SECOND)),
  )
  let max = 0
  for (let i = start; i < end; i += 1) if (peaks[i] > max) max = peaks[i]
  return max
}
