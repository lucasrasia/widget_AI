import test from 'node:test'
import assert from 'node:assert/strict'
import { createSession, migrateSessions, pauseSession, resumeSession, sessionDuration, sessionTokensUsed } from '../src/sessionMetrics.mjs'

test('session migration clears legacy periods exactly once per version', () => {
  const values = new Map([['periods', '[{"id":"legacy"}]']])
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }

  assert.equal(migrateSessions(storage, 'periods', 'migration', '1'), true)
  assert.equal(values.has('periods'), false)

  values.set('periods', '[{"id":"new"}]')
  assert.equal(migrateSessions(storage, 'periods', 'migration', '1'), false)
  assert.equal(values.get('periods'), '[{"id":"new"}]')
})

test('multiple periods keep independent token and duration totals across pause and resume', () => {
  const first = createSession({ id: 'a', name: 'First', at: '2026-09-18T10:00:00.000Z', currentTokens: 1_000 })
  const second = createSession({ id: 'b', name: 'Second', at: '2026-09-18T10:02:00.000Z', currentTokens: 1_100 })

  const firstPaused = pauseSession(first, '2026-09-18T10:05:00.000Z', 1_250)
  const secondPaused = pauseSession(second, '2026-09-18T10:06:00.000Z', 1_300)
  const firstResumed = resumeSession(firstPaused, '2026-09-18T10:10:00.000Z', 1_400)
  const firstPausedAgain = pauseSession(firstResumed, '2026-09-18T10:12:00.000Z', 1_475)

  assert.equal(sessionTokensUsed(firstPausedAgain, 1_475), 325)
  assert.equal(sessionDuration(firstPausedAgain, Date.parse('2026-09-18T11:00:00.000Z')), 7 * 60_000)
  assert.equal(sessionTokensUsed(secondPaused, 1_300), 200)
  assert.equal(sessionDuration(secondPaused, Date.parse('2026-09-18T11:00:00.000Z')), 4 * 60_000)
})

test('unknown token totals stay unknown instead of becoming zero', () => {
  const session = createSession({ id: 'a', name: 'Unknown', at: '2026-09-18T10:00:00.000Z', currentTokens: null })
  assert.equal(sessionTokensUsed(pauseSession(session, '2026-09-18T10:01:00.000Z', null), null), null)
})

test('paused token and duration state survives JSON persistence before resume', () => {
  const started = createSession({ id: 'a', name: 'Persisted', at: '2026-09-18T10:00:00.000Z', currentTokens: 500 })
  const paused = pauseSession(started, '2026-09-18T10:03:00.000Z', 650)
  const restored = JSON.parse(JSON.stringify(paused))
  const resumed = resumeSession(restored, '2026-09-18T10:10:00.000Z', 700)
  const finished = pauseSession(resumed, '2026-09-18T10:12:00.000Z', 760)

  assert.equal(sessionTokensUsed(finished, 760), 210)
  assert.equal(sessionDuration(finished, Date.parse('2026-09-18T11:00:00.000Z')), 5 * 60_000)
})
