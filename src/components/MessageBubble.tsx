import { useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Message, ToolActivity } from '../types'
import DiffView from './DiffView'

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

// ── Inline renderer ──────────────────────────────────────────────────────────

function renderInline(text: string): ReactNode {
  // Order matters: bold before italic so ** is matched before *
  const re = /(`[^`]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|\[[^\]\n]*\]\([^)\n]*\))/g
  const result: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    const full = m[0]
    const start = m.index
    if (start > last) result.push(text.slice(last, start))

    if (full[0] === '`') {
      result.push(<code key={k++} className="msg-inline-code">{full.slice(1, -1)}</code>)
    } else if (full.startsWith('**')) {
      result.push(<strong key={k++}>{full.slice(2, -2)}</strong>)
    } else if (full[0] === '*' || full[0] === '_') {
      result.push(<em key={k++}>{full.slice(1, -1)}</em>)
    } else if (full.startsWith('~~')) {
      result.push(<del key={k++}>{full.slice(2, -2)}</del>)
    } else {
      // Link [text](url)
      const lm = full.match(/^\[([^\]]*)\]\(([^)]*)\)$/)
      if (lm) {
        result.push(
          <a key={k++} href={lm[2]} className="msg-link" target="_blank" rel="noopener noreferrer">
            {lm[1]}
          </a>
        )
      } else {
        result.push(full)
      }
    }
    last = start + full.length
  }

  if (last < text.length) result.push(text.slice(last))
  return result.length === 0 ? null : result.length === 1 ? result[0] : <>{result}</>
}

// ── Table renderer ────────────────────────────────────────────────────────────

function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length > 2
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
}

function isSepRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c))
}

function renderTable(tableLines: string[], key: number): ReactNode {
  const rows = tableLines.map(parseTableRow)
  const sepIdx = rows.findIndex(isSepRow)
  const headerRows = sepIdx >= 1 ? rows.slice(0, sepIdx) : (rows.length > 0 ? [rows[0]] : [])
  const bodyRows = sepIdx >= 1 ? rows.slice(sepIdx + 1) : rows.slice(1)

  return (
    <div key={key} className="msg-table-wrapper">
      <table className="msg-table">
        {headerRows.length > 0 && (
          <thead>
            {headerRows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <th key={j}>{renderInline(cell)}</th>)}</tr>
            ))}
          </thead>
        )}
        <tbody>
          {bodyRows.map((row, i) => (
            <tr key={i}>{row.map((cell, j) => <td key={j}>{renderInline(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Heading renderer ──────────────────────────────────────────────────────────

function renderHeading(level: number, text: string, key: number): ReactNode {
  const cls = `msg-heading msg-h${level}`
  const content = renderInline(text)
  switch (level) {
    case 1: return <h1 key={key} className={cls}>{content}</h1>
    case 2: return <h2 key={key} className={cls}>{content}</h2>
    case 3: return <h3 key={key} className={cls}>{content}</h3>
    case 4: return <h4 key={key} className={cls}>{content}</h4>
    case 5: return <h5 key={key} className={cls}>{content}</h5>
    default: return <h6 key={key} className={cls}>{content}</h6>
  }
}

// ── Block renderer ────────────────────────────────────────────────────────────

function renderContent(content: string): ReactNode[] {
  const lines = content.split('\n')
  const nodes: ReactNode[] = []
  let inCode = false
  let codeLang = ''
  let codeLines: string[] = []
  let key = 0
  let i = 0

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

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true
        codeLang = line.slice(3).trim()
      } else {
        flushCode()
        inCode = false
      }
      i++
      continue
    }

    if (inCode) {
      codeLines.push(line)
      i++
      continue
    }

    // Table: collect consecutive pipe-delimited rows
    if (isTableRow(line)) {
      const tableLines: string[] = []
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i])
        i++
      }
      nodes.push(renderTable(tableLines, key++))
      continue
    }

    // ATX heading: # ## ### etc.
    const hm = line.match(/^(#{1,6})\s+(.+)$/)
    if (hm) {
      nodes.push(renderHeading(hm[1].length, hm[2], key++))
      i++
      continue
    }

    // Horizontal rule: --- *** ___
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      nodes.push(<hr key={key++} className="msg-hr" />)
      i++
      continue
    }

    // Blockquote: > text
    if (line.startsWith('> ') || line === '>') {
      const bqLines: string[] = []
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        bqLines.push(lines[i].startsWith('> ') ? lines[i].slice(2) : '')
        i++
      }
      nodes.push(
        <blockquote key={key++} className="msg-blockquote">
          {bqLines.map((l, j) => <div key={j} className="msg-line">{renderInline(l)}</div>)}
        </blockquote>
      )
      continue
    }

    // Unordered list: - * +
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      nodes.push(
        <ul key={key++} className="msg-list msg-ul">
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ul>
      )
      continue
    }

    // Ordered list: 1. 2. etc.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i++
      }
      nodes.push(
        <ol key={key++} className="msg-list msg-ol">
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ol>
      )
      continue
    }

    // Normal line
    nodes.push(<div key={key++} className="msg-line">{renderInline(line)}</div>)
    i++
  }

  if (inCode && codeLines.length > 0) flushCode()
  return nodes
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
                  <div key={act.id + i} className={`activity-entry ${PHASE_CLASS[act.phase || 'info'] || ''}`}>
                    <div className={`activity-line ${PHASE_CLASS[act.phase || 'info'] || ''}`}>
                      <span className="activity-icon">{act.icon || FALLBACK_ICONS[act.tool] || '●'}</span>
                      <span className="activity-text" title={act.path || act.detail}>
                        {getActivityLabel(act, false)}
                      </span>
                    </div>
                    {act.codeChange && <DiffView change={act.codeChange} />}
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
