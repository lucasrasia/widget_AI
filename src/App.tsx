import { Bot, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import './App.css'

type MascotState = 'idle' | 'processing' | 'completed'

const MIN_WIDGET_SCALE = .55
const MAX_WIDGET_SCALE = 1.25
const DEFAULT_WIDGET_SCALE = .95

const mascotClips: Record<MascotState, { src: string; label: string; scale: number; loop: boolean }> = {
  idle: { src: '/mascot/idle.mp4', label: 'Em espera', scale: 1.06, loop: true },
  processing: { src: '/mascot/processing.mp4', label: 'Trabalhando', scale: 1.58, loop: true },
  completed: { src: '/mascot/completed.mp4', label: 'Concluído', scale: 1.45, loop: false },
}

type ModelUsage = {
  id: string
  name: string
  tokens: string
  cost: string
  used: number
  color: string
}

const agent: ModelUsage = { id: 'codex', name: 'Codex', tokens: '314k tokens', cost: '$0.74', used: 34, color: '#f4f4f5' }

function UsageWindow({ label, used }: { label: string; used: number }) {
  return <section className="usage-window" aria-label={`${label}: ${used}% usado`}>
    <h2>{label}</h2>
    <div className="usage-window__line">
      <div className="segment-track"><i style={{ width: `${used}%`, backgroundColor: agent.color }} /></div>
      <strong>{used}%</strong>
      <Bot aria-hidden="true" />
    </div>
  </section>
}

function ExpandedModel({ model }: { model: ModelUsage }) {
  return <article className="expanded-model">
    <div className="model-title"><span className={`model-dot ${model.id}`} /><strong>{model.name}</strong><span>{model.tokens}</span><b>{model.cost}</b></div>
    <div className="model-progress"><i style={{ width: `${model.used}%`, backgroundColor: model.color }} /></div>
    <p>{model.used}% do limite semanal usado</p>
  </article>
}

function MascotStage({ state, onCompleted }: { state: MascotState; onCompleted: () => void }) {
  const videos = useRef<Partial<Record<MascotState, HTMLVideoElement>>>({})

  useEffect(() => {
    const activeVideo = videos.current[state]
    if (!activeVideo) return

    activeVideo.currentTime = 0
    void activeVideo.play().catch(() => undefined)
  }, [state])

  return <div className={`mascot-stage mascot-stage--${state}`} aria-label={`Mascote: ${mascotClips[state].label}`}>
    <div className="mascot-idle-repair" aria-hidden="true">
      <i className="mascot-idle-repair__body" />
      <i className="mascot-idle-repair__eye mascot-idle-repair__eye--left" />
      <i className="mascot-idle-repair__eye mascot-idle-repair__eye--right" />
    </div>
    {(Object.keys(mascotClips) as MascotState[]).map((clipState) => {
      const clip = mascotClips[clipState]
      return <video
        key={clipState}
        ref={(element) => { videos.current[clipState] = element ?? undefined }}
        className={`mascot-video mascot-video--${clipState} ${state === clipState ? 'is-active' : ''}`}
        style={{ '--mascot-scale': clip.scale } as CSSProperties}
        src={clip.src}
        muted
        playsInline
        loop={clip.loop}
        preload="auto"
        onEnded={clipState === 'completed' ? onCompleted : undefined}
      />
    })}
  </div>
}

function App() {
  const [expanded, setExpanded] = useState(false)
  const [mascotState, setMascotState] = useState<MascotState>('idle')
  const [widgetScale, setWidgetScale] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDGET_SCALE
    const savedScale = Number(window.localStorage.getItem('widgeta-widget-scale'))
    return Number.isFinite(savedScale) && savedScale >= MIN_WIDGET_SCALE && savedScale <= MAX_WIDGET_SCALE
      ? savedScale
      : DEFAULT_WIDGET_SCALE
  })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStart = useRef<{ x: number; y: number; scale: number } | null>(null)
  const widgetHeight = expanded ? 510 : 294

  useEffect(() => {
    window.localStorage.setItem('widgeta-widget-scale', String(widgetScale))
  }, [widgetScale])

  function resizeFromPointer(clientX: number, clientY: number) {
    if (!resizeStart.current) return
    const horizontalDelta = (clientX - resizeStart.current.x) / 740
    const verticalDelta = (clientY - resizeStart.current.y) / widgetHeight
    const nextScale = resizeStart.current.scale + Math.max(horizontalDelta, verticalDelta)
    setWidgetScale(Math.min(MAX_WIDGET_SCALE, Math.max(MIN_WIDGET_SCALE, nextScale)))
  }

  function startResize(event: ReactPointerEvent<HTMLButtonElement>) {
    resizeStart.current = { x: event.clientX, y: event.clientY, scale: widgetScale }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsResizing(true)
  }

  function moveResize(event: ReactPointerEvent<HTMLButtonElement>) {
    resizeFromPointer(event.clientX, event.clientY)
  }

  function stopResize() {
    resizeStart.current = null
    setIsResizing(false)
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const step = .03
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      setWidgetScale((value) => Math.min(MAX_WIDGET_SCALE, value + step))
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      setWidgetScale((value) => Math.max(MIN_WIDGET_SCALE, value - step))
    }
    if (event.key === 'Home') setWidgetScale(MIN_WIDGET_SCALE)
    if (event.key === 'End') setWidgetScale(MAX_WIDGET_SCALE)
  }

  return <main className="preview-canvas">
    <div className="widget-scale" style={{
      width: `${740 * widgetScale}px`,
      height: `${widgetHeight * widgetScale}px`,
      '--widget-scale': widgetScale,
    } as CSSProperties}>
    <section className={`token-widget ${expanded ? 'expanded' : ''}`} aria-label="WidgetaAI, monitoramento de tokens">
      <MascotStage state={mascotState} onCompleted={() => setMascotState('idle')} />

      <div className="widget-content">
        <div className="topline"><span>DESDE 16:10</span><span>{agent.tokens}</span><span>{agent.cost}</span></div>
        <div className="usage-windows">
          <UsageWindow label="JANELA SEMANAL" used={agent.used} />
          <UsageWindow label="JANELA DE 5 HORAS" used={73} />
        </div>

        <div className="marker-line"><strong>SPEC 02</strong><div><span>41k tokens</span><b>$0.20</b></div></div>

        {expanded && <div className="details" aria-label="Detalhes por modelo">
          <div className="details-heading"><span>LIMITES POR MODELO</span><button type="button">Definir novo período</button></div>
          <ExpandedModel model={agent} />
          <p className="details-footnote">Os limites são mostrados para o agente ativo.</p>
        </div>}
      </div>

      <button className="expand-button" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <span className="sr-only">{expanded ? 'Recolher detalhes' : 'Expandir detalhes'}</span>
        <ChevronRight aria-hidden="true" />
      </button>
    </section>
    <button
      className={`resize-handle ${isResizing ? 'is-resizing' : ''}`}
      type="button"
      aria-label={`Redimensionar ilha, tamanho atual ${Math.round(widgetScale * 100)} por cento`}
      title="Arraste para redimensionar. Setas ajustam o tamanho."
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => setWidgetScale(DEFAULT_WIDGET_SCALE)}
    ><span aria-hidden="true">↘</span><span className="sr-only">Arraste para definir o tamanho da ilha.</span></button>
    </div>
    <div className="preview-footer">
      <p className="preview-label">Prévia da ilha — as trocas usam crossfade sem alterar a caixa do mascote.</p>
      <div className="mascot-state-controls" aria-label="Testar estados do mascote">
        {(Object.keys(mascotClips) as MascotState[]).map((state) => <button
          className={mascotState === state ? 'is-active' : ''}
          key={state}
          type="button"
          onClick={() => setMascotState(state)}
        >{mascotClips[state].label}</button>)}
      </div>
    </div>
  </main>
}

export default App
