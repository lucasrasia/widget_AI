export type MascotActivityState = {
  phase: 'idle' | 'processing' | 'completed'
  lastTokens: number | null
  lastSampleAtMs: number | null
  greenUntil: number | null
}

export const GREEN_DURATION_MS: number
export const INITIAL_MASCOT_ACTIVITY: MascotActivityState
export function advanceMascotActivity(previous: MascotActivityState, snapshot: { status: string; lifetimeTokens?: number | null; sampledAtMs?: number | null }, now: number): MascotActivityState
export function expireMascotActivity(previous: MascotActivityState, now: number): MascotActivityState
