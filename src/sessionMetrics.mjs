export function migrateSessions(storage, sessionsKey, migrationKey, version) {
  if (storage.getItem(migrationKey) === version) return false
  storage.removeItem(sessionsKey)
  storage.setItem(migrationKey, version)
  return true
}

export function createSession({ id, name, at, currentTokens }) {
  return {
    id,
    name,
    startedAt: at,
    activeStartedAt: at,
    status: 'working',
    startedTokens: currentTokens,
    trackingStartedTokens: currentTokens,
    elapsedMs: 0,
    accumulatedTokens: currentTokens === null ? null : 0,
  }
}

export function sessionTokensUsed(session, currentTokens) {
  if (session.accumulatedTokens === null) return null
  const accumulated = session.accumulatedTokens ?? 0
  if (session.status === 'working') {
    const baseline = session.trackingStartedTokens ?? session.startedTokens
    if (baseline === null || baseline === undefined || currentTokens === null) return null
    return accumulated + Math.max(0, currentTokens - baseline)
  }
  if (session.accumulatedTokens !== undefined) return accumulated
  if (session.startedTokens === null || session.startedTokens === undefined || session.endedTokens === null || session.endedTokens === undefined) return null
  return Math.max(0, session.endedTokens - session.startedTokens)
}

export function sessionDuration(session, now) {
  if (session.elapsedMs !== undefined) {
    if (session.status !== 'working') return session.elapsedMs
    const activeStartedAt = new Date(session.activeStartedAt ?? session.startedAt).getTime()
    return session.elapsedMs + Math.max(0, now - activeStartedAt)
  }
  const end = session.status === 'working' ? now : session.endedAt ? new Date(session.endedAt).getTime() : new Date(session.startedAt).getTime()
  return Math.max(0, end - new Date(session.startedAt).getTime())
}

export function pauseSession(session, at, currentTokens) {
  if (session.status !== 'working') return session
  const pausedAt = new Date(at)
  return {
    ...session,
    status: 'paused',
    endedAt: pausedAt.toISOString(),
    endedTokens: currentTokens,
    elapsedMs: sessionDuration(session, pausedAt.getTime()),
    accumulatedTokens: sessionTokensUsed(session, currentTokens),
  }
}

export function resumeSession(session, at, currentTokens) {
  if (session.status !== 'paused') return session
  return {
    ...session,
    status: 'working',
    activeStartedAt: new Date(at).toISOString(),
    trackingStartedTokens: currentTokens,
    endedAt: undefined,
    endedTokens: undefined,
  }
}
