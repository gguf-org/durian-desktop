import { useEffect, useRef } from 'react'
import type { Session, ToolActivity } from '../types'
import MessageBubble from './MessageBubble'
import InputArea from './InputArea'

const SUGGESTIONS = [
  'What can you help me with?',
  'Show me your available tools',
  'List active skills',
  '/status',
]

// Map phase to color class (used for chat header badge)
const PHASE_CLASS: Record<string, string> = {
  init: 'phase-init',
  thinking: 'phase-thinking',
  tool: 'phase-tool',
  warning: 'phase-warning',
  error: 'phase-error',
  info: 'phase-info',
}

interface Props {
  session: Session | null
  isRunning: boolean
  onSend: (text: string, model: string, toolsets: string) => void
  onStop: () => void
  onNewChat: () => void
  durianAvailable: boolean
  durianInstalling: boolean
  durianInstallMessage: string
  projectPath: string
  recentActivities: ToolActivity[]
}

export default function ChatView({
  session,
  isRunning,
  onSend,
  onStop,
  onNewChat,
  durianAvailable,
  durianInstalling,
  durianInstallMessage,
  projectPath,
  recentActivities,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages])

  const messages = session?.messages ?? []
  const title = session?.title ?? 'New chat'
  const lastMsg = messages[messages.length - 1]
  const showStreamingIndicator =
    isRunning && lastMsg?.role !== 'assistant'

  const handleSuggestion = (s: string) => {
    onSend(s, '', '')
  }

  // Get the latest phase for the status indicator
  const latestPhase = recentActivities.length > 0
    ? recentActivities[recentActivities.length - 1].phase || 'info'
    : 'thinking'

  // Build header status text — show action type + path for more context
  const latestActivity = recentActivities.length > 0
    ? recentActivities[recentActivities.length - 1]
    : null

  const headerStatusText = (() => {
    if (!latestActivity) return 'Waiting for response…'
    if (latestActivity.path && latestActivity.actionType) {
      const shortPath = latestActivity.path.length > 30
        ? '…' + latestActivity.path.slice(-27)
        : latestActivity.path
      return shortPath
    }
    const detail = latestActivity.detail || 'Processing…'
    return detail.length > 40 ? detail.slice(0, 40) + '…' : detail
  })()

  const latestIcon = latestActivity?.icon

  return (
    <main className="main">
      <div className="chat-header">
        {!session && (
          <button
            className="icon-btn"
            onClick={onNewChat}
            title="New chat"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <div className="chat-header-title">{title}</div>
        {isRunning && (
          <div className={`chat-header-model ${PHASE_CLASS[latestPhase] || ''}`}>
            <span className="status-dot" />
            {latestIcon && <span className="header-activity-icon">{latestIcon}</span>}
            {headerStatusText}
          </div>
        )}
        {projectPath && (
          <div className="chat-header-project" title={projectPath}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 2h3.5l1 1H11v7H1V2z" stroke="currentColor" strokeWidth="0.7" />
            </svg>
            {projectPath.replace(/\\/g, '/').split('/').filter(Boolean).pop()}
          </div>
        )}
      </div>

      {messages.length === 0 ? (
        <div className="messages-area">
          <div className="welcome">
            <div className="welcome-logo">✷</div>
            <h2>Welcome to Durian</h2>
            <p>
              An AI agent that gets better the more you use it — learns new
              skills, remembers context, and grows over time.
            </p>
            {durianInstalling && (
              <div className="welcome-warn">
                <strong>installing durian</strong> — this may take a minute.
              </div>
            )}
            {!durianAvailable && !durianInstalling && (
              <div className="welcome-warn">
                <strong>durian not found</strong> — automatic install failed.
                {durianInstallMessage ? ` ${durianInstallMessage}` : ''}
              </div>
            )}
            {durianAvailable && !durianInstalling && (
              <div className="suggestions">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    className="suggestion-chip"
                    onClick={() => handleSuggestion(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="messages-area" ref={messagesRef}>
          {messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isStreaming={
                isRunning &&
                msg.role === 'assistant' &&
                i === messages.length - 1
              }
            />
          ))}
          {showStreamingIndicator && (
            <div className="message-row assistant">
              {/* <div className="message-avatar assistant">D</div> */}
              <div className="message-avatar assistant">✷</div>
              <div className="message-bubble">
                <div className="streaming-dots">
                  <span /><span /><span />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}

        <InputArea
          onSend={onSend}
          onStop={onStop}
          isRunning={isRunning}
          disabled={!durianAvailable || durianInstalling}
        />
    </main>
  )
}
