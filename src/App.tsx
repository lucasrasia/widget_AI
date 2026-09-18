import { Bot, ChevronRight, Play, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from 'react'
import mascotOrb from './assets/mascot-orb.gif'
import './App.css'

type MascotState = 'idle' | 'processing' | 'completed'
type SessionStatus = 'working' | 'completed'
type UsageFidelity = 'official' | 'derived' | 'manual' | 'unavailable'
type Session = { id: string; name: string; startedAt: string; endedAt?: string; status: SessionStatus }
type UsageWindowData = { usedPercent: number; windowDurationMins: number; resetsAt: number | null }
type ModelUsage = {
  id: string
  provider: string
  model: string
  tokens: number | null
  cost: number | null
  usedPercent: number | null
  fiveHour?: UsageWindowData
  weekly?: UsageWindowData
  fidelity: UsageFidelity
  updatedAt: string | null
  aggregate?: boolean
}
type UsageSnapshot = {
  status: 'loading' | 'ready' | 'stale' | 'unavailable'
  updatedAt: string | null
  plan: string | null
  windows: UsageWindowData[]
  models?: ModelUsage[]
  error: string | null
  source?: string
  fidelity?: Exclude<UsageFidelity, 'unavailable'>
}

const SESSIONS_KEY = 'widgeta-sessions'
const USAGE_CACHE_KEY = 'widgeta-usage-snapshot'
const EMPTY_USAGE: UsageSnapshot = { status: 'loading', updatedAt: null, plan: null, windows: [], error: null }
const MODEL_COLORS = ['#f5f5f5', '#ff7a28', '#2788f5']

function formatClock(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'
}

function formatRemaining(resetsAt: number | null | undefined) {
  if (!resetsAt) return 'reinício indisponível'
  const minutes = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

function formatTokens(value: number | null) {
  if (value === null) return '— tokens'
  return `${new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value)} tokens`
}

function formatCost(value: number | null) {
  return value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}

function fidelityLabel(value: UsageFidelity) {
  if (value === 'official') return 'oficial'
  if (value === 'derived') return 'derivada'
  if (value === 'manual') return 'manual'
  return 'indisponível'
}

function ModelMark({ model }: { model: ModelUsage }) {
  const initials = model.model.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
  return model.provider.toLowerCase().includes('openai') || model.model.toLowerCase().includes('codex')
    ? <Bot aria-hidden="true" />
    : <span aria-hidden="true">{initials || '?'}</span>
}

function App() {
  const [creatingPeriod, setCreatingPeriod] = useState(false)
  const [periodName, setPeriodName] = useState('')
  const [tooltipModelId, setTooltipModelId] = useState<string | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [sessions, setSessions] = useState<Session[]>(() => {
    try {
      return (JSON.parse(window.localStorage.getItem(SESSIONS_KEY) ?? '[]') as Partial<Session>[]).map((item) => ({
        ...item,
        name: item.name?.trim() || 'Período sem nome',
        status: item.status === 'working' ? 'working' : 'completed',
      } as Session))
    } catch { return [] }
  })
  const [mascotState, setMascotState] = useState<MascotState>(() => sessions.some((item) => item.status === 'working') ? 'processing' : 'idle')
  const [usage, setUsage] = useState<UsageSnapshot>(() => {
    try {
      const cached = JSON.parse(window.localStorage.getItem(USAGE_CACHE_KEY) ?? 'null') as UsageSnapshot | null
      return cached?.windows?.length ? { ...cached, status: 'stale' } : EMPTY_USAGE
    } catch { return EMPTY_USAGE }
  })
  const closeTimer = useRef<number | null>(null)
  const unmountTimer = useRef<number | null>(null)
  const currentSession = useMemo(() => sessions.find((item) => item.status === 'working'), [sessions])
  const isTauri = '__TAURI_INTERNALS__' in window
  const fiveHourWindow = usage.windows.find((item) => item.windowDurationMins === 300)
  const weeklyWindow = usage.windows.find((item) => item.windowDurationMins === 10_080)
  const fallbackFidelity: UsageFidelity = usage.status === 'ready' ? usage.fidelity ?? 'official' : usage.status === 'stale' ? usage.fidelity ?? 'derived' : 'unavailable'
  const modelUsages = useMemo<ModelUsage[]>(() => usage.models?.length ? usage.models : [{
    id: 'codex-aggregate',
    provider: 'OpenAI',
    model: 'Codex',
    tokens: null,
    cost: null,
    usedPercent: fiveHourWindow?.usedPercent ?? null,
    fiveHour: fiveHourWindow,
    weekly: weeklyWindow,
    fidelity: fallbackFidelity,
    updatedAt: usage.updatedAt,
    aggregate: true,
  }], [fallbackFidelity, fiveHourWindow, usage.models, usage.updatedAt, weeklyWindow])
  const visibleModels = modelUsages.slice(0, 3)
  const hiddenModelCount = Math.max(0, modelUsages.length - visibleModels.length)
  const tooltipModel = modelUsages.find((model) => model.id === tooltipModelId) ?? null
  const tooltipIndex = tooltipModel ? Math.max(0, visibleModels.findIndex((model) => model.id === tooltipModel.id)) : 0
  const modelCount = Math.max(1, visibleModels.length)
  const modelCenter = 130 + ((tooltipIndex + .5) / modelCount) * 231
  const tooltipLeft = Math.min(120, Math.max(0, modelCenter - 140))
  const tooltipArrow = modelCenter - tooltipLeft
  const knownTokens = modelUsages.every((model) => model.tokens !== null) ? modelUsages.reduce((sum, model) => sum + (model.tokens ?? 0), 0) : null
  const knownCost = modelUsages.every((model) => model.cost !== null) ? modelUsages.reduce((sum, model) => sum + (model.cost ?? 0), 0) : null

  useEffect(() => { window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)) }, [sessions])
  useEffect(() => {
    if (mascotState !== 'completed') return
    const timer = window.setTimeout(() => setMascotState('idle'), 15_000)
    return () => window.clearTimeout(timer)
  }, [mascotState])
  useEffect(() => {
    if (!isTauri) return
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_widget_window_state', { tooltipOpen: Boolean(tooltipModelId) })).catch(() => undefined)
  }, [isTauri, tooltipModelId])
  useEffect(() => {
    let active = true
    async function readUsage() {
      try {
        const snapshot = isTauri
          ? await import('@tauri-apps/api/core').then(({ invoke }) => invoke<UsageSnapshot>('read_codex_usage'))
          : await fetch('http://127.0.0.1:5191/usage').then(async (response) => {
            if (!response.ok) throw new Error()
            return response.json() as Promise<UsageSnapshot>
          })
        if (!active) return
        const next = { ...snapshot, updatedAt: snapshot.updatedAt ?? new Date().toISOString() }
        setUsage(next)
        window.localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify(next))
      } catch {
        if (!active) return
        setUsage((value) => value.windows.length
          ? { ...value, status: 'stale', error: 'Última leitura preservada.' }
          : { ...EMPTY_USAGE, status: 'unavailable', error: 'Leitura do Codex indisponível.' })
      }
    }
    void readUsage()
    const timer = window.setInterval(() => void readUsage(), 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [isTauri])
  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    if (unmountTimer.current) window.clearTimeout(unmountTimer.current)
  }, [])

  function cancelClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    if (unmountTimer.current) window.clearTimeout(unmountTimer.current)
  }
  function openTooltip(id: string) {
    cancelClose()
    setTooltipModelId(id)
    window.requestAnimationFrame(() => setTooltipOpen(true))
  }
  function closeTooltip(delay = 90) {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      setTooltipOpen(false)
      unmountTimer.current = window.setTimeout(() => setTooltipModelId(null), 170)
    }, delay)
  }
  function keepTooltipFocus(event: FocusEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget)) return
    closeTooltip()
  }
  function startPeriod() {
    const name = periodName.trim()
    if (!name || currentSession) return
    setSessions((items) => [...items, { id: crypto.randomUUID(), name, startedAt: new Date().toISOString(), status: 'working' }])
    setPeriodName('')
    setCreatingPeriod(false)
    setMascotState('processing')
  }
  function finishPeriod() {
    if (!currentSession) return
    setSessions((items) => items.map((item) => item.id === currentSession.id ? { ...item, endedAt: new Date().toISOString(), status: 'completed' } : item))
    setMascotState('completed')
  }

  const shellStyle = { '--tooltip-left': `${tooltipLeft}px`, '--tooltip-arrow': `${tooltipArrow}px` } as CSSProperties
  return <main className={`preview-canvas ${isTauri ? 'tauri-shell' : ''}`}>
    <div className={`widget-shell ${tooltipModelId ? 'has-tooltip' : ''}`} style={shellStyle}>
      {tooltipModel && <aside className={`model-tooltip ${tooltipOpen ? 'is-open' : ''}`} id={`model-tooltip-${tooltipModel.id}`} role="tooltip" onMouseEnter={cancelClose} onMouseLeave={() => closeTooltip()}>
        <div className="tooltip-heading"><span className="tooltip-mark"><ModelMark model={tooltipModel} /></span><strong>Uso {tooltipModel.model}</strong><b>5h</b></div>
        <div className="tooltip-track"><i style={{ width: `${tooltipModel.fiveHour?.usedPercent ?? 0}%` }} /></div>
        <div className="tooltip-values"><strong>{tooltipModel.fiveHour ? `${Math.round(tooltipModel.fiveHour.usedPercent)}% usado · ${formatRemaining(tooltipModel.fiveHour.resetsAt)}` : '5h indisponível'}</strong><strong>{tooltipModel.weekly ? `${Math.round(tooltipModel.weekly.usedPercent)}% usado · ${formatRemaining(tooltipModel.weekly.resetsAt)}` : 'Semanal indisponível'}</strong></div>
        <div className="tooltip-meta"><span>{tooltipModel.aggregate ? 'Limites agregados' : tooltipModel.provider}</span><span>{fidelityLabel(tooltipModel.fidelity)} · {formatClock(tooltipModel.updatedAt)}</span></div>
      </aside>}
      <section className="compact-widget" data-tauri-drag-region>
        <div className={`mascot-stage mascot-orb mascot-orb--${mascotState}`} aria-label={`Indicador: ${mascotState === 'processing' ? 'trabalhando' : mascotState === 'completed' ? 'concluído' : 'em espera'}`}><span className="mascot-orb__frame"><img src={mascotOrb} alt="" /></span></div>
        <div className="compact-content">
          <div className="summary-row"><strong>{currentSession ? `DESDE ${formatClock(currentSession.startedAt)}` : 'SEM PERÍODO'}</strong><strong>{formatTokens(knownTokens)}</strong><strong>{formatCost(knownCost)}</strong></div>
          <div className={`model-row model-row--${Math.min(visibleModels.length, 3)}`}>
            {visibleModels.map((model, index) => {
              const percent = model.usedPercent
              return <button className="model-usage" key={model.id} type="button" aria-describedby={tooltipModelId === model.id ? `model-tooltip-${model.id}` : undefined} aria-label={`${model.aggregate ? 'Uso agregado' : 'Uso'} de ${model.model}: ${percent === null ? 'indisponível' : `${Math.round(percent)}%`}`} onMouseEnter={() => openTooltip(model.id)} onMouseLeave={() => closeTooltip()} onFocus={() => openTooltip(model.id)} onBlur={keepTooltipFocus} onKeyDown={(event) => { if (event.key === 'Escape') closeTooltip(0) }}>
                <span className="model-ring" style={{ '--model-color': MODEL_COLORS[index], '--model-progress': `${percent ?? 0}%` } as CSSProperties}><span><ModelMark model={model} /></span></span>
                <b>{percent === null ? '—' : `${Math.round(percent)}%`}</b>
                {hiddenModelCount > 0 && index === visibleModels.length - 1 && <small>+{hiddenModelCount}</small>}
              </button>
            })}
          </div>
          <div className="period-row">
            <div className="period-name-cell">{creatingPeriod ? <div className="compact-period-form"><input autoFocus value={periodName} maxLength={48} placeholder="Nome do período" aria-label="Nome do período" onChange={(event) => setPeriodName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') startPeriod(); if (event.key === 'Escape') setCreatingPeriod(false) }} /><button type="button" onClick={startPeriod} disabled={!periodName.trim()} aria-label="Iniciar período"><Play aria-hidden="true" /></button></div> : currentSession ? <><strong>{currentSession.name}</strong><button className="session-stop" type="button" onClick={finishPeriod} aria-label="Parar período"><Square aria-hidden="true" /></button></> : <button className="create-period" type="button" onClick={() => setCreatingPeriod(true)}>+ NOVO PERÍODO</button>}</div>
            <strong>{formatTokens(knownTokens)}</strong><strong>{formatCost(knownCost)}</strong>
          </div>
        </div>
        <span className="visual-chevron" aria-hidden="true"><ChevronRight /></span>
      </section>
    </div>
  </main>
}

export default App
