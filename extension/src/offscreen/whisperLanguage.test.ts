import { describe, expect, it } from "vitest";
import { extractWhisperLanguageCode } from "./whisperLanguage.ts";

describe("Whisper language token", () => {
	it("extrae francés del prefijo del decoder", () => {
		expect(
			extractWhisperLanguageCode(
				"<|startoftranscript|><|fr|><|transcribe|><|notimestamps|>",
			),
		).toBe("fr");
	});

	it("extrae inglés y español", () => {
		expect(extractWhisperLanguageCode("<|startoftranscript|><|en|>")).toBe(
			"en",
		);
		expect(extractWhisperLanguageCode("<|startoftranscript|><|es|>")).toBe(
			"es",
		);
	});

	it("sin token de idioma devuelve null", () => {
		expect(
			extractWhisperLanguageCode("<|startoftranscript|><|transcribe|>"),
		).toBeNull();
	});
});
