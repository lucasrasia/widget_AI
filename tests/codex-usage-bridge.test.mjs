import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRateLimits } from '../scripts/codex-usage-bridge.mjs'

test('normalizes legacy rateLimits windows and clamps percentages', () => {
  const result = normalizeRateLimits({
    rateLimits: {
      primary: { usedPercent: 120, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: -2, windowDurationMins: 10_080, resetsAt: null },
    },
  })
  assert.deepEqual(result.windows.map((window) => window.usedPercent), [100, 0])
  assert.deepEqual(result.models, [])
})

test('normalizes rateLimitsByLimitId and keeps unsupported precision null', () => {
  const result = normalizeRateLimits({
    rateLimits: { primary: null, secondary: null },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        normalModelSlug: 'gpt-5-codex',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 100 },
        secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 200 },
      },
    },
  })
  assert.equal(result.windows.length, 2)
  assert.equal(result.models[0].model, 'gpt-5-codex')
  assert.equal(result.models[0].tokens, null)
  assert.equal(result.models[0].cost, null)
})
