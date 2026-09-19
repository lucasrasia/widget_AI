import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceMascotActivity, expireMascotActivity, INITIAL_MASCOT_ACTIVITY } from '../src/mascotActivity.mjs'

const reading = (tokens, sampledAtMs) => ({ status: 'ready', lifetimeTokens: tokens, sampledAtMs })

test('uses the first fresh reading as a baseline, then turns blue on token growth', () => {
  const baseline = advanceMascotActivity(INITIAL_MASCOT_ACTIVITY, reading(100, 1_000), 1_000)
  assert.equal(baseline.phase, 'idle')
  const working = advanceMascotActivity(baseline, reading(115, 2_000), 2_000)
  assert.equal(working.phase, 'processing')
})

test('turns green on the next unchanged fresh reading, then idles after 15 seconds', () => {
  const baseline = advanceMascotActivity(INITIAL_MASCOT_ACTIVITY, reading(100, 1_000), 1_000)
  const working = advanceMascotActivity(baseline, reading(115, 2_000), 2_000)
  const cached = advanceMascotActivity(working, reading(115, 2_000), 2_500)
  assert.equal(cached, working)
  const completed = advanceMascotActivity(working, reading(115, 3_000), 3_000)
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.greenUntil, 18_000)
  assert.equal(expireMascotActivity(completed, 17_999).phase, 'completed')
  assert.equal(expireMascotActivity(completed, 18_000).phase, 'idle')
})

test('additional tokens during green return to blue without resetting the baseline', () => {
  const baseline = advanceMascotActivity(INITIAL_MASCOT_ACTIVITY, reading(100, 1_000), 1_000)
  const working = advanceMascotActivity(baseline, reading(115, 2_000), 2_000)
  const completed = advanceMascotActivity(working, reading(115, 3_000), 3_000)
  const resumed = advanceMascotActivity(completed, reading(120, 4_000), 4_000)
  assert.equal(resumed.phase, 'processing')
  assert.equal(resumed.lastTokens, 120)
})

test('stale, missing or reset counters never imply activity or completion', () => {
  const baseline = advanceMascotActivity(INITIAL_MASCOT_ACTIVITY, reading(100, 1_000), 1_000)
  const working = advanceMascotActivity(baseline, reading(115, 2_000), 2_000)
  assert.equal(advanceMascotActivity(working, { ...reading(115, 3_000), status: 'stale' }, 3_000).phase, 'idle')
  assert.equal(advanceMascotActivity(working, reading(null, 3_000), 3_000).phase, 'idle')
  assert.equal(advanceMascotActivity(working, reading(10, 3_000), 3_000).phase, 'idle')
})
