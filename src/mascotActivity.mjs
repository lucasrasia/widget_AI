export const GREEN_DURATION_MS = 15_000

export const INITIAL_MASCOT_ACTIVITY = {
  phase: 'idle',
  lastTokens: null,
  lastSampleAtMs: null,
  greenUntil: null,
}

export function advanceMascotActivity(previous, snapshot, now) {
  const tokens = snapshot?.lifetimeTokens
  const sampleAtMs = snapshot?.sampledAtMs
  if (snapshot?.status !== 'ready' || !Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(sampleAtMs) || sampleAtMs < 0) {
    return INITIAL_MASCOT_ACTIVITY
  }
  if (previous.lastSampleAtMs !== null && sampleAtMs <= previous.lastSampleAtMs) return previous
  if (previous.lastTokens === null || tokens < previous.lastTokens) {
    return { phase: 'idle', lastTokens: tokens, lastSampleAtMs: sampleAtMs, greenUntil: null }
  }
  if (tokens > previous.lastTokens) {
    return { phase: 'processing', lastTokens: tokens, lastSampleAtMs: sampleAtMs, greenUntil: null }
  }
  if (previous.phase === 'processing') {
    return { phase: 'completed', lastTokens: tokens, lastSampleAtMs: sampleAtMs, greenUntil: now + GREEN_DURATION_MS }
  }
  return {
    phase: previous.phase === 'completed' && now < previous.greenUntil ? 'completed' : 'idle',
    lastTokens: tokens,
    lastSampleAtMs: sampleAtMs,
    greenUntil: previous.phase === 'completed' && now < previous.greenUntil ? previous.greenUntil : null,
  }
}

export function expireMascotActivity(previous, now) {
  if (previous.phase !== 'completed' || now < previous.greenUntil) return previous
  return { ...previous, phase: 'idle', greenUntil: null }
}
