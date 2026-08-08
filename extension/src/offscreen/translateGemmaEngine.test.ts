import { describe, expect, it } from "vitest"
import { cleanGemmaTranslation } from "./translateGemmaEngine.ts"

describe("cleanGemmaTranslation", () => {
  it("quita prefijos de explicación sin truncar la traducción", () => {
    expect(cleanGemmaTranslation("Translation: Hola mundo", "Hello world")).toBe(
      "Hola mundo",
    )
  })

  it("no inventa contenido: deja pasar traducción gramatical distinta", () => {
    expect(
      cleanGemmaTranslation("Creo que deberíamos ir.", "I think we should go."),
    ).toBe("Creo que deberíamos ir.")
  })

  it("Because → Porque (sin completar)", () => {
    expect(cleanGemmaTranslation("Porque", "Because")).toBe("Porque")
  })
})
