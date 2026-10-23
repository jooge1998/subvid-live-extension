// Shared by HomeDemo.astro (build-time layout) and homeDemo.ts (runtime loop),
// so the cue blocks, the waveform and the captions always line up.

// Length of the fake interview, in seconds.
export const DEMO_DURATION = 9.4

export const DEMO_CUES = [
  { start: 0.3, end: 2.9 },
  { start: 3.2, end: 6.0 },
  { start: 6.3, end: 9.0 },
] as const

// One loop of the demo, in seconds. Each phase maps to a step of the home list:
// reveal → "Upload", transcribe + translate → "Generate", play + export → "Edit and export".
export const DEMO_PHASES = {
  reveal: [0, 0.9],
  transcribe: [0.9, 3.1],
  translate: [3.1, 4.0],
  play: [4.0, 4.0 + DEMO_DURATION],
  export: [4.0 + DEMO_DURATION, 15.6],
} as const

export const DEMO_LOOP = DEMO_PHASES.export[1]

export const DEMO_STEPS = [
  DEMO_PHASES.reveal,
  [DEMO_PHASES.transcribe[0], DEMO_PHASES.translate[1]],
  [DEMO_PHASES.play[0], DEMO_PHASES.export[1]],
] as const
