export type SessionStatus = 'working' | 'paused' | 'completed'

export type Session = {
  id: string
  name: string
  startedAt: string
  endedAt?: string
  status: SessionStatus
  startedTokens?: number | null
  endedTokens?: number | null
  activeStartedAt?: string
  trackingStartedTokens?: number | null
  elapsedMs?: number
  accumulatedTokens?: number | null
}

export function createSession(input: { id: string; name: string; at: string; currentTokens: number | null }): Session
export function sessionTokensUsed(session: Session, currentTokens: number | null): number | null
export function sessionDuration(session: Session, now: number): number
export function pauseSession(session: Session, at: string | number | Date, currentTokens: number | null): Session
export function resumeSession(session: Session, at: string | number | Date, currentTokens: number | null): Session
export function migrateSessions(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  sessionsKey: string,
  migrationKey: string,
  version: string,
): boolean
