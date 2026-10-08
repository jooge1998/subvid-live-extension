/** Extrae el token de idioma elegido por Whisper: <|fr|>, <|en|>, etc. */
export function extractWhisperLanguageCode(
	tokenText: string,
): string | null {
	const matches = String(tokenText || "").matchAll(/<\|([a-z]{2,3})\|>/gi);
	for (const match of matches) {
		const code = match[1]?.toLowerCase();
		// Excluir tokens de tarea/control que también usan <|...|>.
		if (
			code &&
			!["sot", "eot", "not", "nos", "tra"].includes(code)
		) {
			return code;
		}
	}
	return null;
}
