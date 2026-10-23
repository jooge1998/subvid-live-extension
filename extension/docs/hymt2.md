# Hy-MT2 en SubVid Live

Hy-MT2 es la familia de modelos de traducción de Tencent Hunyuan. Esta prueba usa **Hy-MT2-1.8B** en GGUF, servido por `llama-server`. SubVid Live no descarga el modelo. El motor por defecto sigue siendo la cascada actual (`auto`: TranslateGemma y, si hace falta, Chrome / Marian / NLLB).

Hy-MT2 y TranslateGemma conviven. Se elige uno en el popup, en **Motor de traducción**.

## 1. Qué archivo usar

La primera prueba usa la cuantización oficial `Q4_K_M`:

`Hy-MT2-1.8B-Q4_K_M.gguf`

Está en [tencent/Hy-MT2-1.8B-GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF). Pesa alrededor de 1.1 GB.

```bash
huggingface-cli download tencent/Hy-MT2-1.8B-GGUF Hy-MT2-1.8B-Q4_K_M.gguf --local-dir models
```

URL directa:

`https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf`

## 2. llama.cpp

La ficha del modelo pide un `llama.cpp` reciente de [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp). El GGUF depende del kernel STQ integrado en [PR #22836](https://github.com/ggml-org/llama.cpp/pull/22836). También puedes usar un binario actual de los [releases](https://github.com/ggml-org/llama.cpp/releases) que incluya `llama-server`.

Compilación que documenta Tencent, sin elegir GPU:

```bash
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
cmake -B build
cmake --build build --config Release
```

En Windows el ejecutable queda en `build\bin\Release\llama-server.exe` o en `build\bin\llama-server.exe`, según el generador. No pases `-ngl`: la build usa CPU, CUDA, Metal o Vulkan según cómo se haya compilado.

## 3. Arranque automático en Windows

SubVid puede iniciar y detener automáticamente el servidor Vulkan probado. La primera vez instala el host local de Windows desde PowerShell:

```powershell
cd extension\native-host
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

El instalador compila el host Native Messaging, registra el permiso para el ID exacto de esta extensión y solicita las rutas de `llama-server.exe` y del GGUF. Usa la build Vulkan y el modelo que ya validaste. Al activar Hy-MT2, SubVid ejecuta `llama-server` con `--host 127.0.0.1 --port 8080 --jinja -c 4096 -ngl 33`; al detener los subtítulos, detiene únicamente el proceso que inició SubVid. Si ya había un servidor escuchando, lo reutiliza y no lo termina al detener.

El host guarda stdout y stderr del servidor en `%LOCALAPPDATA%\SubVid\llama-server.stdout.log` y `%LOCALAPPDATA%\SubVid\llama-server.stderr.log`. Para desinstalar únicamente el registro Native Messaging:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Esto no borra el modelo ni los logs. Si Hy-MT2 tiene una URL distinta de `http://127.0.0.1:8080`, el arranque automático informa el requisito y no inicia el servidor en otro puerto.

## 4. Arrancar llama-server manualmente

`--jinja` aplica la plantilla de chat del GGUF. La ficha oficial la usa en los ejemplos de inferencia. `--host` y `--port` son los flags actuales de `llama-server`.

```bash
llama-server -m ./models/Hy-MT2-1.8B-Q4_K_M.gguf --host 127.0.0.1 --port 8080 --jinja
```

En Windows:

```bat
llama-server.exe -m .\models\Hy-MT2-1.8B-Q4_K_M.gguf --host 127.0.0.1 --port 8080 --jinja
```

Comprueba que responde:

```bash
curl http://127.0.0.1:8080/v1/models
```

## 5. Configurar SubVid Live

1. `cd extension && npm install && npm run build`
2. En `chrome://extensions`, carga `extension/dist`.
3. Abre el popup.

Para seguir con el traductor actual, deja **Auto cascade** o elige **TranslateGemma 4B**.

Para esta prueba, elige **Hy-MT2 1.8B**. Aparecen tres campos, guardados en la configuración de la extensión (no hace falta un `.env`):

| Campo | Equivale a | Valor inicial |
|---|---|---|
| Hy-MT2 URL | `HYMT2_BASE_URL` | `http://127.0.0.1:8080` |
| Modelo GGUF | `HYMT2_MODEL` | `Hy-MT2-1.8B-Q4_K_M.gguf` |
| Timeout (ms) | `HYMT2_TIMEOUT_MS` | `10000` |

La extensión solo puede llamar a `127.0.0.1` y a `localhost`. Si cambias el puerto, cámbialo también en el popup.

Detén los subtítulos y vuelve a activarlos después de cambiar de motor. El pipeline de Whisper y el VAD no cambian.

## 6. Prompt

Hy-MT2 no lleva system prompt. El mensaje de usuario sigue la plantilla oficial:

```text
Translate the following text into Spanish. Note that you should only output the translated result without any additional explanation:
Hello
```

Con cues previos se usa la plantilla **Background Information**. Esos cues no se vuelven a traducir. Si hay glosario, se añade el bloque oficial `translates to`.

Los parámetros de muestreo son los de la ficha para 1.8B: temperatura `0.7`, `top_p` `0.6`, `top_k` `20`, `repeat_penalty` `1.05`. `max_tokens` queda en 512 porque un subtítulo es corto.

## 7. Si llama-server no está

La extensión sigue escuchando y Whisper sigue generando el texto original. La traducción de ese cue queda vacía. En la consola del documento offscreen aparece, como mucho cada 8 segundos:

```text
Hy-MT2 unavailable at http://127.0.0.1:8080
```

El estado del popup también lo muestra. No hay sondeo continuo: la comprobación es `GET /v1/models` al activar subtítulos, y cada cue hace un solo `POST /v1/chat/completions`.

## 8. Benchmark

El benchmark no cambia el motor activo. Manda el mismo texto a los providers que le pases.

Dataset: `extension/tests/translation/subtitles.json` (inglés → español, inglés → japonés, japonés → español).

Contra el servidor local:

```bash
cd extension
npm run benchmark:translation
```

Una frase:

```bash
npm run benchmark:translation -- --id en-es-captain
```

Variables opcionales: `HYMT2_BASE_URL`, `HYMT2_MODEL`, `HYMT2_TIMEOUT_MS`.

La comparación en el mismo proceso está en `benchmarkTranslation()`. Los tests le pasan un provider TranslateGemma y otro Hy-MT2 con el mismo request y comprueban que el pipeline en vivo no cambia. TranslateGemma sigue ejecutándose dentro de Chrome; este script de Node solo llega a llama-server.

## 9. Métricas

Cada traducción de Hy-MT2 escribe en la consola del offscreen, sin el texto ni el audio:

```text
provider
sourceLanguage
targetLanguage
inputLength
outputLength
latencyMs
```

Con **Mostrar latencia** activado, el panel del subtítulo repite `provider`, `inputLength`, `outputLength` y `latencyMs`.

`latencyMs` es el tiempo del `POST` a llama-server. No incluye Whisper.

## 10. Prueba manual inmediata

Con `llama-server` en marcha:

```bash
curl http://127.0.0.1:8080/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"Hy-MT2-1.8B-Q4_K_M.gguf\",\"messages\":[{\"role\":\"user\",\"content\":\"Translate the following text into Spanish. Note that you should only output the translated result without any additional explanation:\\nHe said we should leave immediately.\"}],\"temperature\":0.7,\"top_p\":0.6,\"top_k\":20,\"repeat_penalty\":1.05,\"max_tokens\":512}"
```

Inglés → japonés: cambia el destino a `Japanese` y el texto a `Room 305, password 4418.`

Japonés → español:

```text
Translate the following text into Spanish. Note that you should only output the translated result without any additional explanation:
待って。
```
