/**
 * AudioWorkletProcessor: captura PCM del canal 0 y lo envía al documento
 * offscreen. Corre en el hilo de audio (menos jitter que ScriptProcessor).
 *
 * Registro: audioWorklet.addModule(...) desde offscreen.ts
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0] && input[0].length) {
      // Copiamos: el buffer del worklet se reutiliza en el siguiente quantum.
      const copy = new Float32Array(input[0])
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor)
