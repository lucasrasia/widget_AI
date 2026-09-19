import { ChevronDown, ChevronUp, Pause, Play, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from 'react'
import mascotOrb from './assets/mascot-orb.gif'
import openaiMark from './assets/openai-mark.png'
import { createSession, migrateSessions, pauseSession, resumeSession, sessionDuration, sessionTokensUsed, type Session } from './sessionMetrics.mjs'
import './App.css'

type UsageFidelity = 'official' | 'derived' | 'manual' | 'unavailable'
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
  lifetimeTokens?: number | null
  error: string | null
  source?: string
  fidelity?: Exclude<UsageFidelity, 'unavailable'>
}

const SESSIONS_KEY = 'widgeta-sessions'
const SESSIONS_MIGRATION_KEY = 'widgeta-sessions-migration'
const SESSIONS_MIGRATION_VERSION = '1'
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

function formatDuration(durationMs: number) {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainingSeconds = seconds % 60
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
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
    ? <img src={openaiMark} alt="" aria-hidden="true" />
    : <span aria-hidden="true">{initials || '?'}</span>
}

function UsageBar({ label, window }: { label: string; window?: UsageWindowData }) {
  const percent = window?.usedPercent ?? 0
  return <div className="usage-window">
    <div><span>{label}</span><strong>{window ? `${Math.round(percent)}% usado` : 'indisponível'}</strong></div>
    <div className="tooltip-track"><i style={{ width: `${percent}%` }} /></div>
    <small>{window ? formatRemaining(window.resetsAt) : 'sem leitura do limite'}</small>
  </div>
}

function ExpandedModelUsage({ model }: { model: ModelUsage }) {
  return <article className="expanded-model-usage">
    <div className="tooltip-heading">
      <span className="tooltip-mark"><ModelMark model={model} /></span>
      <strong>Limite {model.model}</strong>
      <b>{formatTokens(model.tokens)}</b>
    </div>
    <UsageBar label="5 HORAS" window={model.fiveHour} />
    <UsageBar label="SEMANAL" window={model.weekly} />
    <div className="tooltip-meta"><span>{model.aggregate ? 'Limites agregados' : model.provider}</span><span>{fidelityLabel(model.fidelity)} · {formatClock(model.updatedAt)}</span></div>
  </article>
}

function TooltipBody({ model, left, arrow, onEnter, onLeave }: { model: ModelUsage; left: number; arrow: number; onEnter: () => void; onLeave: () => void }) {
  return <aside className="model-tooltip is-open" style={{ '--tooltip-left': `${left}px`, '--tooltip-arrow': `${arrow}px` } as CSSProperties} id={`model-tooltip-${model.id}`} role="tooltip" onMouseEnter={onEnter} onMouseLeave={onLeave}>
    <div className="tooltip-heading"><span className="tooltip-mark"><ModelMark model={model} /></span><strong>Uso {model.model}</strong><b>5h</b></div>
    <div className="tooltip-track"><i style={{ width: `${model.fiveHour?.usedPercent ?? 0}%` }} /></div>
    <div className="tooltip-values"><strong>{model.fiveHour ? `${Math.round(model.fiveHour.usedPercent)}% usado · ${formatRemaining(model.fiveHour.resetsAt)}` : '5h indisponível'}</strong><strong>{model.weekly ? `${Math.round(model.weekly.usedPercent)}% usado · ${formatRemaining(model.weekly.resetsAt)}` : 'Semanal indisponível'}</strong></div>
    <div className="tooltip-meta"><span>{model.aggregate ? 'Limites agregados' : model.provider}</span><span>{fidelityLabel(model.fidelity)} · {formatClock(model.updatedAt)}</span></div>
  </aside>
}

function TooltipWindow() {
  const [payload, setPayload] = useState<{ model: ModelUsage; left: number; arrow: number } | null>(null)
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let active = true
    void import('@tauri-apps/api/event').then(({ listen }) => listen<{ model: ModelUsage; left: number; arrow: number }>('widget-tooltip-model', (event) => setPayload(event.payload))).then(async (cleanup) => {
      if (!active) { cleanup(); return }
      unlisten = cleanup
      const { invoke } = await import('@tauri-apps/api/core')
      const current = await invoke<{ model: ModelUsage; left: number; arrow: number } | null>('get_widget_tooltip')
      if (active && current) setPayload(current)
    }).catch(() => undefined)
    return () => { active = false; unlisten?.() }
  }, [])
  function notify(entered: boolean) {
    void import('@tauri-apps/api/event').then(({ emitTo }) => emitTo('main', entered ? 'widget-tooltip-enter' : 'widget-tooltip-leave')).catch(() => undefined)
  }
  return <main className="tooltip-window" onMouseEnter={() => notify(true)} onMouseLeave={() => notify(false)}>{payload && <TooltipBody {...payload} onEnter={() => notify(true)} onLeave={() => notify(false)} />}</main>
}

function MainWidget() {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState<number | null>(null)
  const [creatingPeriod, setCreatingPeriod] = useState(false)
  const [periodName, setPeriodName] = useState('')
  const [tooltipModelId, setTooltipModelId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>(() => {
    try {
      if (migrateSessions(window.localStorage, SESSIONS_KEY, SESSIONS_MIGRATION_KEY, SESSIONS_MIGRATION_VERSION)) return []
      return (JSON.parse(window.localStorage.getItem(SESSIONS_KEY) ?? '[]') as Partial<Session>[]).map((item) => ({
        ...item,
        name: item.name?.trim() || 'Período sem nome',
        status: item.status === 'working' || item.status === 'paused' ? item.status : 'completed',
      } as Session))
    } catch { return [] }
  })
  const [usage, setUsage] = useState<UsageSnapshot>(() => {
    try {
      const cached = JSON.parse(window.localStorage.getItem(USAGE_CACHE_KEY) ?? 'null') as UsageSnapshot | null
      return cached?.windows?.length ? { ...cached, status: 'stale' } : EMPTY_USAGE
    } catch { return EMPTY_USAGE }
  })
  const closeTimer = useRef<number | null>(null)
  const activeSessionCount = useMemo(() => sessions.filter((item) => item.status === 'working').length, [sessions])
  const displayedSessions = useMemo(() => [...sessions].reverse(), [sessions])
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
  const knownTokens = usage.lifetimeTokens ?? null
  const knownCost = modelUsages.every((model) => model.cost !== null) ? modelUsages.reduce((sum, model) => sum + (model.cost ?? 0), 0) : null

  useEffect(() => { window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)) }, [sessions])
  useEffect(() => {
    if (!activeSessionCount) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [activeSessionCount])
  useEffect(() => {
    if (!isTauri) return
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_widget_window_state', { expanded })).catch(() => undefined)
  }, [expanded, isTauri])
  useEffect(() => {
    if (!isTauri) return
    let unlistenEnter: (() => void) | undefined
    let unlistenLeave: (() => void) | undefined
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      unlistenEnter = await listen('widget-tooltip-enter', () => {
        if (closeTimer.current) window.clearTimeout(closeTimer.current)
      })
      unlistenLeave = await listen('widget-tooltip-leave', () => {
        if (closeTimer.current) window.clearTimeout(closeTimer.current)
        closeTimer.current = window.setTimeout(() => {
          setTooltipModelId(null)
          void import('@tauri-apps/api/core').then(({ invoke }) => invoke('hide_widget_tooltip')).catch(() => undefined)
        }, 90)
      })
    }).catch(() => undefined)
    return () => { unlistenEnter?.(); unlistenLeave?.() }
  }, [isTauri])
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
  }, [])

  function cancelClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
  }
  function openTooltip(id: string) {
    cancelClose()
    setTooltipModelId(id)
    if (isTauri) {
      const model = modelUsages.find((item) => item.id === id)
      if (model) {
        const index = Math.max(0, visibleModels.findIndex((item) => item.id === id))
        const center = 130 + ((index + .5) / modelCount) * 231
        const left = Math.min(120, Math.max(0, center - 140))
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_widget_tooltip', { model, left, arrow: center - left })).catch(() => undefined)
      }
    }
  }
  function closeTooltip(delay = 90) {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      setTooltipModelId(null)
      if (isTauri) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('hide_widget_tooltip')).catch(() => undefined)
    }, delay)
  }
  function keepTooltipFocus(event: FocusEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget)) return
    closeTooltip()
  }
  function startPeriod() {
    const name = periodName.trim()
    if (!name) return
    setSessions((items) => [...items, createSession({
      id: crypto.randomUUID(),
      name,
      at: new Date().toISOString(),
      currentTokens: knownTokens,
    })])
    setPeriodName('')
    setCreatingPeriod(false)
  }
  function pausePeriod(id: string) {
    const pausedAt = new Date()
    setSessions((items) => items.map((item) => item.id === id ? pauseSession(item, pausedAt, knownTokens) : item))
  }
  function resumePeriod(id: string) {
    const resumedAt = new Date()
    setSessions((items) => items.map((item) => item.id === id ? resumeSession(item, resumedAt, knownTokens) : item))
  }
  function deletePeriod(id: string) {
    setSessions((items) => items.filter((item) => item.id !== id))
  }

  const shellStyle = { '--tooltip-left': `${tooltipLeft}px`, '--tooltip-arrow': `${tooltipArrow}px` } as CSSProperties
  return <main className={`preview-canvas ${isTauri ? 'tauri-shell' : ''}`}>
    <div className={`widget-shell ${expanded ? 'is-expanded' : ''} ${tooltipModelId ? 'has-tooltip' : ''}`} style={shellStyle}>
      {tooltipModel && !expanded && !isTauri && <TooltipBody model={tooltipModel} left={tooltipLeft} arrow={tooltipArrow} onEnter={cancelClose} onLeave={() => closeTooltip()} />}
      <section className={`compact-widget ${expanded ? 'is-expanded' : ''}`} data-tauri-drag-region>
        <div className="mascot-stage mascot-orb mascot-orb--idle" aria-label="Indicador: em espera"><span className="mascot-orb__frame"><img src={mascotOrb} alt="" /></span></div>
        <div className="compact-content">
          <div className="summary-row"><strong>USO ATUAL</strong><strong>{formatTokens(knownTokens)}</strong><strong>{formatCost(knownCost)}</strong></div>
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
            <strong>{modelUsages.length} {modelUsages.length === 1 ? 'LIMITE' : 'LIMITES'}</strong>
            <strong>{formatTokens(knownTokens)}</strong><strong>{formatCost(knownCost)}</strong>
          </div>
        </div>
        {expanded && <div className="expanded-usage" aria-label="Limites de uso detalhados">
          <div className="expanded-usage__title"><strong>LIMITES DE USO</strong><span>{usage.plan ? `PLANO ${usage.plan}` : 'LIMITES DA CONTA'}</span></div>
          <div className="expanded-usage__list">{modelUsages.map((model) => <ExpandedModelUsage key={model.id} model={model} />)}</div>
          <div className="period-history" aria-label="Períodos de análise de tokens">
            {displayedSessions.map((session) => {
              const isWorking = session.status === 'working'
              const isPaused = session.status === 'paused'
              const statusLabel = isWorking ? 'EM ANDAMENTO' : isPaused ? 'PAUSADO' : 'CONCLUÍDO'
              const duration = sessionDuration(session, now ?? new Date(session.activeStartedAt ?? session.startedAt).getTime())
              return <article className={`analysis-session ${isWorking ? 'is-running' : isPaused ? 'is-paused' : 'is-completed'}`} key={session.id}>
                <div className="analysis-session__identity"><small>{statusLabel}</small><strong>{session.name}</strong></div>
                <div className="analysis-session__metric"><span>TOKENS</span><b>{formatTokens(sessionTokensUsed(session, knownTokens))}</b></div>
                <div className="analysis-session__metric"><span>DURAÇÃO</span><b>{formatDuration(duration)}</b></div>
                <div className="analysis-session__actions">
                  {isWorking && <button type="button" className="period-stop" onClick={() => pausePeriod(session.id)} aria-label={`Pausar ${session.name}`}><Pause aria-hidden="true" /> PAUSAR</button>}
                  {isPaused && <button type="button" className="period-resume" onClick={() => resumePeriod(session.id)} aria-label={`Retomar ${session.name}`}><Play aria-hidden="true" /> RETOMAR</button>}
                  <button type="button" className="period-delete" onClick={() => deletePeriod(session.id)} aria-label={`Excluir ${session.name}`}><Trash2 aria-hidden="true" /></button>
                </div>
              </article>
            })}
          </div>
          <section className="analysis-period" aria-label="Criar período de análise">
            {creatingPeriod ? <form className="analysis-period__form" onSubmit={(event) => { event.preventDefault(); startPeriod() }}>
              <input autoFocus value={periodName} maxLength={48} placeholder="Nome do período de análise" aria-label="Nome do período de análise" onChange={(event) => setPeriodName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setCreatingPeriod(false) }} />
              <button type="submit" disabled={!periodName.trim()} aria-label="Iniciar período de análise"><Play aria-hidden="true" /></button>
            </form> : <button className="analysis-period__create" type="button" onClick={() => setCreatingPeriod(true)}><span>+</span> Criar período de análise</button>}
          </section>
        </div>}
        <button className="expand-toggle" type="button" aria-label={expanded ? 'Recolher uso detalhado' : 'Expandir uso detalhado'} aria-expanded={expanded} onClick={() => { closeTooltip(0); setExpanded((value) => !value) }}>
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
        </button>
      </section>
    </div>
  </main>
}

export default function App() {
  return window.location.search.includes('tooltip=1') ? <TooltipWindow /> : <MainWidget />
}
