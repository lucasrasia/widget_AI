import { ChevronRight, Clock3, Play, Save, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import './App.css'

type MascotState = 'idle' | 'processing' | 'completed'
type SessionStatus = 'waiting' | 'working' | 'completed'
type Session = { id: string; name: string; startedAt: string; endedAt?: string; status: SessionStatus; tokens: string; cost: string }
type SessionDraft = Omit<Session, 'id'>

const SESSIONS_KEY = 'widgeta-sessions'
const MIN_WIDGET_SCALE = .55
const MAX_WIDGET_SCALE = 1.25
const DEFAULT_WIDGET_SCALE = .95
type UsageWindowData = { usedPercent: number; windowDurationMins: number; resetsAt: number | null }
type UsageSnapshot = { status: 'loading' | 'ready' | 'stale' | 'unavailable'; updatedAt: string | null; plan: string | null; windows: UsageWindowData[]; error: string | null }
const EMPTY_USAGE: UsageSnapshot = { status: 'loading', updatedAt: null, plan: null, windows: [], error: null }

const mascotClips: Record<MascotState, { src: string; label: string; scale: number; loop: boolean }> = {
  idle: { src: '/mascot/idle.mp4', label: 'Em espera', scale: 1.06, loop: true },
  processing: { src: '/mascot/processing.mp4', label: 'Trabalhando', scale: 1.58, loop: true },
  completed: { src: '/mascot/completed.mp4', label: 'Concluído', scale: 1.45, loop: false },
}

function toDatetimeLocal(date: Date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }
function makeDraft(session?: Session): SessionDraft {
  return session ? { name: session.name, startedAt: session.startedAt, endedAt: session.endedAt, status: session.status, tokens: session.tokens, cost: session.cost } : { name: 'Sessão sem nome', startedAt: toDatetimeLocal(new Date()), endedAt: '', status: 'waiting', tokens: '', cost: '' }
}
function formatTime(value: string) { return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }
function formatDuration(startedAt: string, endedAt: string | undefined, now: number) {
  const minutes = Math.max(0, Math.floor(((endedAt ? new Date(endedAt).getTime() : now) - new Date(startedAt).getTime()) / 60_000))
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}min`
}

function ProviderLogo() { return <span className="provider-logo" aria-label="OpenAI">OpenAI</span> }
function UsageWindow({ label, window }: { label: string; window?: UsageWindowData }) {
  const used = window?.usedPercent
  const reset = window?.resetsAt ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(window.resetsAt * 1000)) : null
  return <section className="usage-window" aria-label={used === undefined ? `${label}: limite indisponível` : `${label}: ${used}% usado`}><h2>{label}</h2><div className="usage-window__line"><div className="segment-track"><i style={{ width: `${used ?? 0}%`, backgroundColor: '#f4f4f5' }} /></div><strong title={reset ? `Redefine em ${reset}` : undefined}>{used === undefined ? '—' : `${used}%`}</strong><ProviderLogo /></div></section>
}

function MascotStage({ state, onCompleted }: { state: MascotState; onCompleted: () => void }) {
  const videos = useRef<Partial<Record<MascotState, HTMLVideoElement>>>({})
  useEffect(() => { const video = videos.current[state]; if (video) { video.currentTime = 0; void video.play().catch(() => undefined) } }, [state])
  return <div className={`mascot-stage mascot-stage--${state}`} aria-label={`Mascote: ${mascotClips[state].label}`}>
    <div className="mascot-idle-repair" aria-hidden="true"><i className="mascot-idle-repair__body" /><i className="mascot-idle-repair__eye mascot-idle-repair__eye--left" /><i className="mascot-idle-repair__eye mascot-idle-repair__eye--right" /></div>
    {(Object.keys(mascotClips) as MascotState[]).map((clipState) => { const clip = mascotClips[clipState]; return <video key={clipState} ref={(element) => { videos.current[clipState] = element ?? undefined }} className={`mascot-video mascot-video--${clipState} ${state === clipState ? 'is-active' : ''}`} style={{ '--mascot-scale': clip.scale } as CSSProperties} src={clip.src} muted playsInline loop={clip.loop} preload="auto" onEnded={clipState === 'completed' ? onCompleted : undefined} /> })}
  </div>
}

function App() {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [sessions, setSessions] = useState<Session[]>(() => { try { return JSON.parse(window.localStorage.getItem(SESSIONS_KEY) ?? '[]') as Session[] } catch { return [] } })
  const [mascotState, setMascotState] = useState<MascotState>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) ?? '[]') as Session[]
      return saved.some((session) => session.status === 'working') ? 'processing' : 'idle'
    } catch { return 'idle' }
  })
  const [draft, setDraft] = useState<SessionDraft>(() => makeDraft())
  const [usage, setUsage] = useState<UsageSnapshot>(EMPTY_USAGE)
  const [widgetScale, setWidgetScale] = useState(() => { const saved = Number(window.localStorage.getItem('widgeta-widget-scale')); return Number.isFinite(saved) && saved >= MIN_WIDGET_SCALE && saved <= MAX_WIDGET_SCALE ? saved : DEFAULT_WIDGET_SCALE })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStart = useRef<{ x: number; y: number; scale: number } | null>(null)
  const currentSession = useMemo(() => sessions.find((session) => session.status !== 'completed'), [sessions])
  const displayedSession = currentSession ?? sessions.at(-1)
  const widgetHeight = expanded ? 590 : 294

  useEffect(() => { window.localStorage.setItem('widgeta-widget-scale', String(widgetScale)) }, [widgetScale])
  useEffect(() => { window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)) }, [sessions])
  useEffect(() => { if (!currentSession || currentSession.status !== 'working') return; const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer) }, [currentSession])
  useEffect(() => {
    let active = true
    async function readUsage() {
      try {
        const response = await fetch('http://127.0.0.1:5191/usage')
        if (!response.ok) throw new Error('Ponte de uso indisponível')
        const snapshot = await response.json() as UsageSnapshot
        if (active) setUsage(snapshot)
      } catch {
        if (active) setUsage((value) => value.status === 'ready' ? { ...value, status: 'stale' } : { ...EMPTY_USAGE, status: 'unavailable', error: 'Inicie a ponte de uso do Codex.' })
      }
    }
    void readUsage()
    const timer = window.setInterval(() => void readUsage(), 10_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  function openSessionEditor() { setDraft(makeDraft(currentSession)); setExpanded(true) }
  function updateDraft<K extends keyof SessionDraft>(key: K, next: SessionDraft[K]) { setDraft((value) => ({ ...value, [key]: next })) }
  function resizeFromPointer(clientX: number, clientY: number) { if (!resizeStart.current) return; const next = resizeStart.current.scale + Math.max((clientX - resizeStart.current.x) / 740, (clientY - resizeStart.current.y) / widgetHeight); setWidgetScale(Math.min(MAX_WIDGET_SCALE, Math.max(MIN_WIDGET_SCALE, next))) }
  function startResize(event: ReactPointerEvent<HTMLButtonElement>) { resizeStart.current = { x: event.clientX, y: event.clientY, scale: widgetScale }; event.currentTarget.setPointerCapture(event.pointerId); setIsResizing(true) }
  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) { const step = .03; if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); setWidgetScale((value) => Math.min(MAX_WIDGET_SCALE, value + step)) } if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); setWidgetScale((value) => Math.max(MIN_WIDGET_SCALE, value - step)) } if (event.key === 'Home') setWidgetScale(MIN_WIDGET_SCALE); if (event.key === 'End') setWidgetScale(MAX_WIDGET_SCALE) }
  function saveSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft.name.trim() || !draft.startedAt || (draft.endedAt && new Date(draft.endedAt) < new Date(draft.startedAt))) return
    const next = { ...draft, name: draft.name.trim(), status: (draft.endedAt ? 'completed' : draft.status) as SessionStatus }
    setSessions((items) => currentSession ? items.map((item) => item.id === currentSession.id ? { ...item, ...next } : item) : [...items, { ...next, id: crypto.randomUUID() }])
    setMascotState(next.status === 'working' ? 'processing' : next.status === 'completed' ? 'completed' : 'idle'); setExpanded(false)
  }
  function startNow() { const next = { ...makeDraft(currentSession), startedAt: toDatetimeLocal(new Date()), endedAt: '', status: 'working' as const }; setDraft(next); setSessions((items) => currentSession ? items.map((item) => item.id === currentSession.id ? { ...item, ...next } : item) : [...items, { ...next, id: crypto.randomUUID() }]); setMascotState('processing') }
  function finishNow() { if (!currentSession) return; setSessions((items) => items.map((item) => item.id === currentSession.id ? { ...item, endedAt: toDatetimeLocal(new Date()), status: 'completed' } : item)); setMascotState('completed') }

  const duration = displayedSession ? formatDuration(displayedSession.startedAt, displayedSession.endedAt, now) : null
  const fiveHourWindow = usage.windows.find((window) => window.windowDurationMins === 300)
  const weeklyWindow = usage.windows.find((window) => window.windowDurationMins === 10_080)
  const usageStatus = usage.status === 'ready' ? `Codex ${usage.plan ?? ''} · sincronizado` : usage.status === 'stale' ? 'Codex · última leitura preservada' : usage.status === 'loading' ? 'Codex · sincronizando' : 'Codex · limites indisponíveis'
  return <main className="preview-canvas"><div className="widget-scale" style={{ width: `${740 * widgetScale}px`, height: `${widgetHeight * widgetScale}px`, '--widget-scale': widgetScale } as CSSProperties}>
    <section className={`token-widget ${expanded ? 'expanded' : ''}`} aria-label="WidgetaAI, monitoramento de tokens"><MascotStage state={mascotState} onCompleted={() => setMascotState('idle')} /><div className="widget-content">
      <div className="topline"><span>{displayedSession ? `DESDE ${formatTime(displayedSession.startedAt)}` : 'SEM SESSÃO ATIVA'}</span><span>{usageStatus}</span><span>{usage.updatedAt ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(usage.updatedAt)) : '—'}</span></div>
      <div className="usage-windows"><UsageWindow label="JANELA SEMANAL" window={weeklyWindow} /><UsageWindow label="JANELA DE 5 HORAS" window={fiveHourWindow} /></div>
      <button className="marker-line" type="button" onClick={openSessionEditor} aria-expanded={expanded}><strong>{displayedSession ? displayedSession.name : 'MARCAR SESSÃO'}</strong><div><span>{duration ?? 'Definir período'}</span><b>{displayedSession?.status === 'working' ? 'Em andamento' : displayedSession?.status === 'completed' ? 'Concluída' : displayedSession ? 'Em espera' : 'Novo'}</b></div></button>
      {expanded && <form className="session-editor" onSubmit={saveSession} aria-label="Definir sessão marcada"><div className="details-heading"><span>SESSÃO MARCADA</span><button type="button" onClick={() => setExpanded(false)} aria-label="Fechar editor"><X aria-hidden="true" /></button></div><label>Nome da sessão<input value={draft.name} maxLength={40} onChange={(event) => updateDraft('name', event.target.value)} /></label><div className="session-time-fields"><label>Início<input type="datetime-local" value={draft.startedAt} onChange={(event) => updateDraft('startedAt', event.target.value)} /></label><button className="now-button" type="button" onClick={() => updateDraft('startedAt', toDatetimeLocal(new Date()))}>Agora</button></div><div className="session-time-fields"><label>Fim <small>opcional</small><input type="datetime-local" value={draft.endedAt ?? ''} min={draft.startedAt} onChange={(event) => updateDraft('endedAt', event.target.value)} /></label><button className="now-button" type="button" onClick={() => updateDraft('endedAt', toDatetimeLocal(new Date()))}>Agora</button></div><div className="session-status"><span>Status</span>{(['waiting', 'working'] as const).map((status) => <button key={status} className={draft.status === status ? 'is-active' : ''} type="button" onClick={() => updateDraft('status', status)}>{status === 'working' ? 'Trabalhando' : 'Em espera'}</button>)}</div><div className="session-metrics"><label>Tokens<input placeholder="ex.: 41k" value={draft.tokens} onChange={(event) => updateDraft('tokens', event.target.value)} /></label><label>Custo<input placeholder="ex.: $0.20" value={draft.cost} onChange={(event) => updateDraft('cost', event.target.value)} /></label></div><div className="session-actions"><button className="start-button" type="button" onClick={startNow}><Play aria-hidden="true" />Iniciar agora</button>{currentSession?.status === 'working' && <button className="finish-button" type="button" onClick={finishNow}><Square aria-hidden="true" />Concluir agora</button>}<button className="save-button" type="submit"><Save aria-hidden="true" />Salvar período</button></div><p>Os limites exibidos acima são lidos da conta Codex local. A sessão marcada continua sendo apenas seu registro de trabalho.</p></form>}
    </div><button className="expand-button" type="button" aria-expanded={expanded} onClick={() => expanded ? setExpanded(false) : openSessionEditor()}><span className="sr-only">{expanded ? 'Recolher sessão' : 'Editar sessão'}</span><ChevronRight aria-hidden="true" /></button></section>
    <button className={`resize-handle ${isResizing ? 'is-resizing' : ''}`} type="button" aria-label={`Redimensionar ilha, tamanho atual ${Math.round(widgetScale * 100)} por cento`} title="Arraste para redimensionar. Setas ajustam o tamanho." onPointerDown={startResize} onPointerMove={(event) => resizeFromPointer(event.clientX, event.clientY)} onPointerUp={() => { resizeStart.current = null; setIsResizing(false) }} onPointerCancel={() => { resizeStart.current = null; setIsResizing(false) }} onKeyDown={resizeWithKeyboard} onDoubleClick={() => setWidgetScale(DEFAULT_WIDGET_SCALE)}><span aria-hidden="true">↘</span><span className="sr-only">Arraste para definir o tamanho da ilha.</span></button>
  </div><div className="preview-footer"><p className="preview-label"><Clock3 aria-hidden="true" />Prévia da ilha — sessões ficam salvas neste navegador.</p><div className="mascot-state-controls" aria-label="Testar estados do mascote">{(Object.keys(mascotClips) as MascotState[]).map((state) => <button className={mascotState === state ? 'is-active' : ''} key={state} type="button" onClick={() => setMascotState(state)}>{mascotClips[state].label}</button>)}</div></div></main>
}

export default App
