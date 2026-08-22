# TranslateGemma 4B (rama experimental)

## Validación REAL (fase actual)

**typecheck/build/tests NO validan el modelo.** Hay que ejecutar el diagnóstico en Chrome:

1. `cd extension && npm run build`
2. Cargar `extension/dist` como extensión sin empaquetar
3. Abrir el popup → **Ejecutar diagnóstico TranslateGemma**
4. Esperar (1ª vez descarga ~2.9 GB). No hay cascade: si falla, el error se muestra.

Ruta:

```
Popup → background → offscreen → TranslateGemmaEngine → worker → modelo
```

Sin Whisper, VAD, TTS, overlay ni fallback Marian/NLLB/Chrome Translator.

### Qué mide

- WebGPU: `requestAdapter` + `requestDevice` + limits/features
- Descarga / carga / inferencia (cold vs warm)
- 5 frases warm + anti-continuación + repetición
- Errores estructurados (`MODEL_MEMORY_ERROR`, operadores ONNX, WebGPU)
- Reutilización de instancia en el worker (`reused: true`)

El informe aparece en el popup y en la consola del offscreen (`[TranslateGemma] …`).

---

## Flujo de producción (cascade)

```
Audio → VAD/chunk → WhisperASR → SubtitleDeduplicator
  → sentenceBoundaryDetector + pendingFragment (heurística)
  → CascadingTranslationEngine
       ├─ TranslateGemma 4B → translation + complete + confidence + reason
       └─ fallback: Chrome/Marian/NLLB (sin complete; gemmaComplete=null)
  → resolveBoundaryDecision (audio + heurística + Gemma)
  → PROVISIONAL | FINAL → overlay
  → TTS solo FINAL + translation_confirmed (cueId + generation)
```

Gemma **no** reemplaza VAD/silencio: solo desempata cuando la heurística espera de más.
Una sola inferencia por cue (no `translate()` + `isComplete()`).

## Integración TranslateGemma

| Pieza | Archivo |
|---|---|
| Interfaz | `src/offscreen/translationEngine.ts` |
| Cascade | `src/offscreen/cascadingTranslationEngine.ts` |
| Adapter | `src/offscreen/translateGemmaEngine.ts` |
| Worker | `src/offscreen/translategemma.worker.ts` |
| Diagnóstico | `src/offscreen/translateGemmaDiagnostic.ts` |
| Modelo | `onnx-community/translategemma-text-4b-it-ONNX` (~2.9 GB q4) |

- Whisper / Marian / NLLB siguen en **`@huggingface/transformers@3.8.1`**.
- TranslateGemma usa el alias **`@huggingface/transformers-v4`** → `4.2.0` **solo en su worker**.

## Notas de riesgo (post-validación)

1. **TTS vs traducción provisional:** el TTS debe ligarse a la versión FINAL del cue (`cueId` + generation/`isFinal`), no solo a `translation_confirmed` de un texto provisional anterior.
2. **Ventana de confirmación:** "I think" no debe FINAL inmediato ni esperar indefinido; silencio corto → esperar; silencio suficiente / continuación → decidir.
3. Tras PASS de carga, comparar calidad/latencia/RAM vs Chrome Translator / Marian / NLLB con 50–100 frases reales de subtítulos.

**No afirmar PASS de TranslateGemma hasta completar el diagnóstico en el navegador.**
