declare module "@huggingface/transformers-v4" {
  export const env: {
    allowLocalModels: boolean
    useBrowserCache: boolean
    backends?: unknown
  }
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<any>
}
