/**
 * Sondeo estructurado de WebGPU (adapter + device + limits).
 * No basta con `navigator.gpu !== undefined`.
 */

export type WebGpuProbeResult = {
  navigatorGpuDefined: boolean
  adapterAvailable: boolean
  deviceAvailable: boolean
  adapterInfo: {
    vendor?: string
    architecture?: string
    device?: string
    description?: string
  } | null
  limits: Record<string, number> | null
  features: string[]
  error: {
    code: string
    message: string
    stage: "requestAdapter" | "requestDevice" | "unknown"
  } | null
}

type GpuGpu = {
  requestAdapter: () => Promise<GpuAdapter | null>
}

type GpuAdapter = {
  requestDevice: () => Promise<GpuDevice>
  requestAdapterInfo?: () => Promise<Record<string, string>>
  limits?: Record<string, number>
  features: Iterable<string>
}

type GpuDevice = {
  destroy: () => void
}

export async function probeWebGpu(): Promise<WebGpuProbeResult> {
  const empty: WebGpuProbeResult = {
    navigatorGpuDefined: false,
    adapterAvailable: false,
    deviceAvailable: false,
    adapterInfo: null,
    limits: null,
    features: [],
    error: null,
  }

  const nav = globalThis.navigator as Navigator & { gpu?: GpuGpu }

  if (!nav?.gpu) {
    return {
      ...empty,
      error: {
        code: "WEBGPU_UNAVAILABLE",
        message: "navigator.gpu no está definido",
        stage: "unknown",
      },
    }
  }

  empty.navigatorGpuDefined = true

  let adapter: GpuAdapter | null = null
  try {
    adapter = await nav.gpu.requestAdapter()
  } catch (error) {
    return {
      ...empty,
      error: {
        code: "WEBGPU_ADAPTER_ERROR",
        message: String((error as Error)?.message || error),
        stage: "requestAdapter",
      },
    }
  }

  if (!adapter) {
    return {
      ...empty,
      error: {
        code: "WEBGPU_NO_ADAPTER",
        message: "requestAdapter() devolvió null",
        stage: "requestAdapter",
      },
    }
  }

  empty.adapterAvailable = true

  try {
    const info = await adapter.requestAdapterInfo?.()
    if (info) {
      empty.adapterInfo = {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
      }
    }
  } catch {
    /* opcional */
  }

  const limitKeys = [
    "maxBufferSize",
    "maxStorageBufferBindingSize",
    "maxComputeWorkgroupStorageSize",
    "maxComputeInvocationsPerWorkgroup",
    "maxComputeWorkgroupSizeX",
    "maxBindGroups",
    "maxStorageBuffersPerShaderStage",
  ] as const

  const limits: Record<string, number> = {}
  for (const key of limitKeys) {
    const value = adapter.limits?.[key]
    if (typeof value === "number") limits[key] = value
  }
  empty.limits = limits
  empty.features = [...adapter.features].map(String)

  let device: GpuDevice | null = null
  try {
    device = await adapter.requestDevice()
  } catch (error) {
    return {
      ...empty,
      error: {
        code: "WEBGPU_DEVICE_ERROR",
        message: String((error as Error)?.message || error),
        stage: "requestDevice",
      },
    }
  }

  if (!device) {
    return {
      ...empty,
      error: {
        code: "WEBGPU_DEVICE_NULL",
        message: "requestDevice() devolvió null/undefined",
        stage: "requestDevice",
      },
    }
  }

  empty.deviceAvailable = true
  try {
    device.destroy()
  } catch {
    /* ignore */
  }

  return empty
}
