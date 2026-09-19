import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST = '127.0.0.1'
const PORT = Number(process.env.WIDGETA_USAGE_PORT ?? 5191)
const POLL_INTERVAL_MS = 45_000
const REQUEST_TIMEOUT_MS = 8_000
const RESTART_DELAY_MS = 10_000
const clientInfo = { name: 'widgetaai', title: 'WidgetaAI', version: '0.1.0' }

let latest = { status: 'loading', source: 'codex-app-server', updatedAt: null, plan: null, windows: [], models: [], lifetimeTokens: null, error: null }
let child = null
let buffer = ''
let nextId = 1
let startPromise = null
let refreshPromise = null
let restartTimer = null
let stopping = false
const pending = new Map()

function clampPercent(value) {
  return Math.max(0, Math.min(100, value))
}

function normalizeWindow(window) {
  if (!Number.isFinite(window?.windowDurationMins) || !Number.isFinite(window?.usedPercent)) return null
  return {
    usedPercent: clampPercent(window.usedPercent),
    windowDurationMins: window.windowDurationMins,
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
  }
}

function bucketWindows(bucket) {
  return [bucket?.primary, bucket?.secondary].map(normalizeWindow).filter(Boolean)
}

export function normalizeRateLimits(snapshot) {
  const buckets = snapshot?.rateLimitsByLimitId && typeof snapshot.rateLimitsByLimitId === 'object'
    ? Object.entries(snapshot.rateLimitsByLimitId)
    : []
  const windows = bucketWindows(snapshot?.rateLimits)

  for (const [, bucket] of buckets) {
    for (const window of bucketWindows(bucket)) {
      if (!windows.some((candidate) => candidate.windowDurationMins === window.windowDurationMins)) windows.push(window)
    }
  }
  windows.sort((a, b) => a.windowDurationMins - b.windowDurationMins)

  const models = buckets.map(([key, bucket]) => {
    const modelWindows = bucketWindows(bucket)
    const fiveHour = modelWindows.find((window) => window.windowDurationMins === 300)
    const weekly = modelWindows.find((window) => window.windowDurationMins === 10_080)
    return {
      id: bucket?.limitId ?? key,
      provider: 'OpenAI',
      model: bucket?.limitName ?? bucket?.normalModelSlug ?? bucket?.limitId ?? key,
      tokens: null,
      cost: null,
      usedPercent: fiveHour?.usedPercent ?? null,
      fiveHour,
      weekly,
      fidelity: 'official',
      updatedAt: null,
      aggregate: true,
    }
  })

  return { windows, models }
}

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timeout)
    request.reject(error)
  }
  pending.clear()
}

function send(method, params = undefined) {
  if (!child?.stdin.writable) return Promise.reject(new Error('Codex App Server is not running.'))
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out.`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timeout })
    child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`, (error) => {
      if (!error) return
      clearTimeout(timeout)
      pending.delete(id)
      reject(error)
    })
  })
}

function notify(method, params = {}) {
  if (!child?.stdin.writable) throw new Error('Codex App Server is not running.')
  child.stdin.write(`${JSON.stringify({ method, params })}\n`)
}

function onData(chunk) {
  buffer += chunk.toString('utf8')
  for (let lineEnd; (lineEnd = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, lineEnd).trim()
    buffer = buffer.slice(lineEnd + 1)
    if (!line) continue
    try {
      const message = JSON.parse(line)
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id)
        clearTimeout(request.timeout)
        pending.delete(message.id)
        if (message.error) request.reject(new Error(message.error.message ?? 'Codex App Server error'))
        else request.resolve(message.result)
      }
      if (message.method === 'account/rateLimits/updated') void refresh()
    } catch {
      latest = { ...latest, status: latest.windows.length ? 'stale' : 'unavailable', error: 'Invalid Codex App Server response.' }
    }
  }
}

function resolveCodexBin() {
  const npmBin = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  return existsSync(npmBin) ? npmBin : null
}

async function terminateChild() {
  const running = child
  child = null
  if (!running || running.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(running.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      const timeout = setTimeout(() => {
        killer.kill()
        resolve()
      }, 2_000)
      killer.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      killer.once('error', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
  if (running.exitCode !== null) return
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      running.kill('SIGKILL')
      resolve()
    }, 2_000)
    running.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    running.kill()
  })
}

async function start() {
  if (child?.stdin.writable) return
  if (startPromise) return startPromise
  startPromise = (async () => {
    const codexBin = resolveCodexBin()
    if (!codexBin) throw new Error('Codex CLI was not found.')
    buffer = ''
    const spawned = spawn(process.execPath, [codexBin, 'app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    child = spawned
    spawned.stdout.on('data', onData)
    spawned.on('error', (error) => {
      rejectPending(error)
      latest = { ...latest, status: latest.windows.length ? 'stale' : 'unavailable', error: error.message }
    })
    spawned.on('exit', () => {
      if (child === spawned) child = null
      rejectPending(new Error('Codex App Server exited.'))
      latest = { ...latest, status: latest.windows.length ? 'stale' : 'unavailable', error: 'Codex App Server exited.' }
      if (!stopping) restartTimer = setTimeout(() => void start().then(refresh).catch(markUnavailable), RESTART_DELAY_MS)
    })

    await send('initialize', { clientInfo })
    notify('initialized')
  })().catch(async (error) => {
    await terminateChild()
    throw error
  }).finally(() => { startPromise = null })
  return startPromise
}

function markUnavailable(error) {
  latest = {
    ...latest,
    status: latest.windows.length ? 'stale' : 'unavailable',
    error: error instanceof Error ? error.message : 'Failed to read Codex usage.',
  }
}

async function refreshOnce() {
  await start()
  const [account, limits, usage] = await Promise.all([
    send('account/read', { refreshToken: false }).catch(() => null),
    send('account/rateLimits/read'),
    send('account/usage/read', {}).catch(() => null),
  ])
  const { windows, models } = normalizeRateLimits(limits)
  latest = {
    status: 'ready',
    source: 'codex-app-server',
    updatedAt: new Date().toISOString(),
    plan: account?.account?.planType ?? limits?.rateLimits?.planType ?? null,
    windows,
    models,
    lifetimeTokens: Number.isFinite(usage?.summary?.lifetimeTokens) ? usage.summary.lifetimeTokens : null,
    error: null,
  }
}

function refresh() {
  if (refreshPromise) return refreshPromise
  refreshPromise = refreshOnce().catch(async (error) => {
    await terminateChild()
    markUnavailable(error)
  }).finally(() => { refreshPromise = null })
  return refreshPromise
}

async function shutdown(server, interval) {
  if (stopping) return
  stopping = true
  clearInterval(interval)
  if (restartTimer) clearTimeout(restartTimer)
  rejectPending(new Error('WidgetaAI usage bridge is shutting down.'))
  await terminateChild()
  await new Promise((resolve) => server.close(resolve))
}

export function runBridge() {
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (request.url === '/usage') return response.end(JSON.stringify(latest))
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'Not found' }))
  })
  server.listen(PORT, HOST, () => console.log(`WidgetaAI usage bridge at http://${HOST}:${PORT}/usage`))
  void refresh()
  const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void shutdown(server, interval).finally(() => process.exit(0)) })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runBridge()
