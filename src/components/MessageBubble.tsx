import { useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Message, ToolActivity } from '../types'

interface Props {
  message: Message
  isStreaming?: boolean
}

// Fallback icons when no icon provided by backend
const FALLBACK_ICONS: Record<string, string> = {
  agent: '🤖',
  model: '🧠',
  terminal: '⌨',
  browser: '🌐',
  file: '📄',
  search: '🔍',
}

// Map phase to color class
const PHASE_CLASS: Record<string, string> = {
  init: 'phase-init',
  thinking: 'phase-thinking',
  tool: 'phase-tool',
  warning: 'phase-warning',
  error: 'phase-error',
  info: 'phase-info',
}

// Action type labels for the live status bar and drawer rows.
const ACTION_LABELS: Record<string, { past: string; active: string }> = {
  read: { past: 'Read', active: 'Reading' },
  write: { past: 'Wrote', active: 'Writing' },
  terminal: { past: 'Ran', active: 'Preparing terminal' },
  search: { past: 'Searched', active: 'Searching' },
  browser: { past: 'Browsed', active: 'Browsing' },
  memory: { past: 'Updated memory', active: 'Updating memory' },
  skill: { past: 'Loaded skill', active: 'Loading skill' },
  delegate: { past: 'Delegated', active: 'Delegating' },
  generic: { past: 'Processed', active: 'Processing' },
}

function renderContent(content: string) {
  const lines = content.split('\n')
  const nodes: ReactNode[] = []
  let inCode = false
  let codeLang = ''
  let codeLines: string[] = []
  let key = 0

  const flushCode = () => {
    nodes.push(
      <pre key={key++} className="msg-code-block">
        {codeLang && <span className="msg-code-lang">{codeLang}</span>}
        <code>{codeLines.join('\n')}</code>
      </pre>
    )
    codeLines = []
    codeLang = ''
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true
        codeLang = line.slice(3).trim()
      } else {
        flushCode()
        inCode = false
      }
    } else if (inCode) {
      codeLines.push(line)
    } else {
      nodes.push(
        <div key={key++} className="msg-line">
          {renderInline(line)}
        </div>
      )
    }
  }

  if (inCode && codeLines.length > 0) flushCode()

  return nodes
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="msg-inline-code">
          {part.slice(1, -1)}
        </code>
      )
    }
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g)
    return boldParts.map((bp, j) => {
      if (bp.startsWith('**') && bp.endsWith('**') && bp.length > 4) {
        return <strong key={`${i}-${j}`}>{bp.slice(2, -2)}</strong>
      }
      return bp ? <span key={`${i}-${j}`}>{bp}</span> : null
    })
  })
}

/** Build the live status label for the current action */
function getLiveStatusLabel(act: ToolActivity): string {
  return getActivityLabel(act, true)
}

function getActivityLabel(act: ToolActivity, active: boolean): string {
  const label = ACTION_LABELS[act.actionType || 'generic']
  const verb = active ? label?.active : label?.past
  if (verb && act.path && act.path.length > 0) {
    return `${verb} ${shortenPath(act.path)}`
  }
  if (verb && act.detail && act.detail !== 'Generating response…') return act.detail
  return act.detail || verb || 'Processed'
}

/** Build the completed summary label */
function getCompletedLabel(activities: ToolActivity[]): string {
  if (activities.length === 0) return ''
  const n = activities.length
  return `${n} step${n !== 1 ? 's' : ''} processed`
}

export default function MessageBubble({ message, isStreaming }: Props) {
  const isUser = message.role === 'user'
  const hasActivity = message.toolActivity && message.toolActivity.length > 0
  const [activityExpanded, setActivityExpanded] = useState(false)
  const activityEndRef = useRef<HTMLDivElement>(null)

  const isActivityExpanded = isStreaming && hasActivity ? true : activityExpanded

  // Auto-scroll activity drawer when expanded and streaming
  useEffect(() => {
    if (isActivityExpanded && isStreaming) {
      activityEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [message.toolActivity, isActivityExpanded, isStreaming])

  const activities = message.toolActivity || []
  const latestActivity = activities[activities.length - 1]
  const latestPhase = latestActivity?.phase || 'info'
  // Find the latest tool-phase activity (not thinking/init) for the live status
  const latestToolActivity = [...activities].reverse().find(a => a.phase === 'tool')
  const liveActivity = latestToolActivity || latestActivity
  const livePhase = liveActivity?.phase || latestPhase
  const liveIcon = liveActivity?.icon

  return (
    <div className={`message-row ${isUser ? 'user' : 'assistant'}`}>
      <div className={`message-avatar ${isUser ? 'user' : 'assistant'}`}>
        {isUser ? (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="6.5" cy="4" r="2.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M1.5 11c0-2.76 2.24-5 5-5s5 2.76 5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        ) : (
          '✷'
        )}
      </div>
      <div className="message-bubble">
        {/* Live status bar - shown during streaming, ABOVE the content */}
        {!isUser && isStreaming && hasActivity && liveActivity && (
          <div className={`live-status-bar ${PHASE_CLASS[livePhase] || ''}`}>
            <div className={`activity-pulse ${PHASE_CLASS[livePhase] || ''}`} />
            <span className="live-status-icon">{liveIcon || FALLBACK_ICONS[liveActivity.tool] || '●'}</span>
            <span className="live-status-text">{getLiveStatusLabel(liveActivity)}</span>
          </div>
        )}

        {isStreaming && !message.content ? (
          <div className="streaming-dots">
            <span /><span /><span />
          </div>
        ) : (
          renderContent(message.content)
        )}

        {/* Completed activity disclosure - shown after streaming ends */}
        {!isUser && hasActivity && !isStreaming && (
          <div className={`inline-activity ${isActivityExpanded ? 'expanded' : ''}`}>
            <div
              className="inline-activity-header"
              onClick={() => setActivityExpanded(v => !v)}
            >
              <div className="activity-pulse phase-done" />
              <span className="inline-activity-title">
                {getCompletedLabel(activities)}
              </span>
              <span className={`inline-activity-chevron ${isActivityExpanded ? 'open' : ''}`}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </div>
            <div className="inline-activity-drawer">
              <div className="inline-activity-log">
                {activities.slice(-20).map((act, i) => (
                  <div
                    key={act.id + i}
                    className={`activity-line ${PHASE_CLASS[act.phase || 'info'] || ''}`}
                  >
                    <span className="activity-icon">{act.icon || FALLBACK_ICONS[act.tool] || '●'}</span>
                    <span className="activity-text" title={act.path || act.detail}>
                      {getActivityLabel(act, false)}
                    </span>
                  </div>
                ))}
                <div ref={activityEndRef} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Shorten a path for display in the activity log */
function shortenPath(p: string): string {
  if (p.length <= 55) return p
  // Try to show filename + some parent dirs
  const parts = p.split('/')
  if (parts.length <= 2) return '…' + p.slice(-52)
  // Show last 3 parts
  const short = parts.slice(-3).join('/')
  return '…/' + short
}
