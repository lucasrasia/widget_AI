import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const HOST = '127.0.0.1'
const PORT = Number(process.env.WIDGETA_USAGE_PORT ?? 5191)
const pollIntervalMs = 45_000
const clientInfo = { name: 'widgetaai', title: 'WidgetaAI', version: '0.1.0' }

let latest = { status: 'loading', source: 'codex-app-server', updatedAt: null, plan: null, windows: [], error: null }
let child
let buffer = ''
let nextId = 1
const pending = new Map()

function send(method, params = undefined) {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} expirou`)) }, 10_000)
    pending.set(id, { resolve, reject, timeout })
  })
}

function normalize(snapshot) {
  const windows = Object.values(snapshot?.rateLimitsByLimitId ?? {})
    .flatMap((bucket) => [bucket.primary, bucket.secondary])
    .concat([snapshot?.rateLimits?.primary, snapshot?.rateLimits?.secondary])
    .filter((window) => Number.isFinite(window?.windowDurationMins) && Number.isFinite(window?.usedPercent))
    .filter((window, index, all) => all.findIndex((candidate) => candidate.windowDurationMins === window.windowDurationMins) === index)
    .map((window) => ({ usedPercent: Math.max(0, Math.min(100, window.usedPercent)), windowDurationMins: window.windowDurationMins, resetsAt: window.resetsAt ?? null }))
    .sort((a, b) => a.windowDurationMins - b.windowDurationMins)

  return windows
}

async function refresh() {
  try {
    let result
    try { result = await send('account/rateLimits/read', { excludeResetCreditDetails: true }) }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('expected unit')) throw error
      result = await send('account/rateLimits/read')
    }
    latest = { status: 'ready', source: 'codex-app-server', updatedAt: new Date().toISOString(), plan: latest.plan, windows: normalize(result), error: null }
  } catch (error) {
    latest = { ...latest, status: latest.windows.length ? 'stale' : 'unavailable', error: error instanceof Error ? error.message : 'Falha ao ler limites' }
  }
}

function resolveCodexBin() {
  const npmBin = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  return existsSync(npmBin) ? npmBin : null
}

function start() {
  const codexBin = resolveCodexBin()
  if (!codexBin) { latest = { ...latest, status: 'unavailable', error: 'Codex CLI não foi encontrado.' }; return }
  child = spawn(process.execPath, [codexBin, 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', onData)
  child.stderr.on('data', () => undefined)
  child.on('exit', () => { latest = { ...latest, status: 'unavailable', error: 'App Server do Codex encerrou.' }; setTimeout(start, 10_000) })
  child.on('error', (error) => { latest = { ...latest, status: 'unavailable', error: error.message } })

  send('initialize', { clientInfo }).then(async () => {
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    const account = await send('account/read', { refreshToken: false })
    latest = { ...latest, plan: account.account?.planType ?? null }
    return refresh()
  }).catch((error) => { latest = { ...latest, status: 'unavailable', error: error.message } })
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
        if (message.error) request.reject(new Error(message.error.message ?? 'Erro do App Server'))
        else request.resolve(message.result)
      }
      if (message.method === 'account/rateLimits/updated') void refresh()
    } catch { latest = { ...latest, status: 'unavailable', error: 'Resposta inválida do App Server.' } }
  }
}

createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5173')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (request.url === '/usage') return response.end(JSON.stringify(latest))
  response.statusCode = 404
  response.end(JSON.stringify({ error: 'Not found' }))
}).listen(PORT, HOST, () => console.log(`WidgetaAI usage bridge em http://${HOST}:${PORT}/usage`))

start()
setInterval(() => { if (child?.stdin.writable) void refresh() }, pollIntervalMs)
