import { describe, expect, it } from "vitest"
import {
  classifyGemmaError,
  percentile,
} from "./gemmaErrorClassify.ts"

describe("classifyGemmaError", () => {
  it("detecta MODEL_MEMORY_ERROR", () => {
    const e = classifyGemmaError(new Error("Failed to allocate GPU memory (OOM)"))
    expect(e.code).toBe("MODEL_MEMORY_ERROR")
  })

  it("detecta MODEL_LOAD_TIMEOUT", () => {
    const e = classifyGemmaError(
      new Error("Timeout (ensure-translategemma) id=1"),
    )
    expect(e.code).toBe("MODEL_LOAD_TIMEOUT")
  })

  it("detecta ONNX_OPERATOR_ERROR", () => {
    const e = classifyGemmaError(
      new Error("Unsupported operator: MatMulNBits at node /model/layers.0"),
    )
    expect(e.code).toBe("ONNX_OPERATOR_ERROR")
    expect(e.operator).toBe("MatMulNBits")
  })
})

describe("percentile", () => {
  it("calcula p50/p95", () => {
    const sorted = [10, 20, 30, 40, 50]
    expect(percentile(sorted, 50)).toBe(30)
    expect(percentile(sorted, 95)).toBe(50)
  })
})
