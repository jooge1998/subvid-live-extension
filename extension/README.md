# SubVid Live — extensión de Chrome

Subtítulos y traducción **en tiempo real** para videos de YouTube, X, Facebook,
Instagram y cualquier sitio con video. Misma filosofía que
[subvid.app](../README.md): **sin APIs de pago y sin backend** — todo el
procesamiento (Whisper + traducción) ocurre localmente en tu navegador.

## Cómo funciona

1. Pulsas **Activar subtítulos** en el popup de la extensión.
2. El service worker captura el audio de la pestaña con `chrome.tabCapture`
   (funciona con cualquier video, incluso con audio protegido por CORS).
3. Un documento offscreen trocea el audio en fragmentos (con detección de
   pausas) y los transcribe con **Whisper** vía transformers.js
   (WebGPU si está disponible, WASM si no).
4. Cada frase se traduce localmente, en este orden de preferencia:
   - **Translator API de Chrome** (Chrome 138+, modelos locales del navegador)
   - **MarianMT** (`Xenova/opus-mt-*`) para pares comunes
   - **NLLB-200** como último recurso
5. El content script dibuja los subtítulos superpuestos sobre el video.

La primera vez se descargan los modelos desde Hugging Face y quedan en la
caché del navegador; después funciona sin red (salvo el propio video).

## Desarrollo

```bash
cd extension
npm install
npm run build   # genera dist/
```

## Instalar en Chrome

1. Abre `chrome://extensions`
2. Activa **Modo de desarrollador**
3. **Cargar descomprimida** → selecciona la carpeta `extension/dist`
4. Abre un video, pulsa el icono de la extensión y **Activar subtítulos**

### Activación rápida

- Botón **CC** flotante en la esquina del video (aparece al pasar el ratón).
- Clic derecho en la página → **Activar / detener subtítulos**.
- Atajo **Ctrl+Shift+S** (configurable en `chrome://extensions/shortcuts`).

Nota: Chrome exige que la extensión haya sido "invocada" en la pestaña
(activeTab) antes de poder capturar audio. El menú contextual, el atajo y el
icono cuentan como invocación; el botón CC funciona a partir de ese momento.

Los subtítulos se pueden **arrastrar verticalmente** para no tapar nada; la
posición se recuerda.

## Notas

- Modelo *tiny* recomendado para tiempo real en equipos sin WebGPU; *base* o
  *small* dan mejor calidad si tu equipo va sobrado.
- La latencia típica es de unos segundos (tamaño del fragmento + inferencia).
- Si vas con retraso, la extensión descarta fragmentos antiguos para mantenerse
  "en vivo".
- El audio de la pestaña se sigue escuchando con normalidad mientras se captura.
