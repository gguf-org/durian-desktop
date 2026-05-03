import { useState, useRef, useEffect } from 'react'

interface Props {
  onSend: (text: string, model: string, toolsets: string) => void
  onStop: () => void
  isRunning: boolean
  disabled?: boolean
}

export default function InputArea({ onSend, onStop, isRunning, disabled }: Props) {
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [toolsets, setToolsets] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [text])

  const handleSend = () => {
    if (!text.trim() || isRunning || disabled) return
    onSend(text, model, toolsets)
    setText('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSend = text.trim().length > 0 && !disabled

  return (
    <div className="input-area">
      <div className="input-bar">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          placeholder={disabled ? 'durian is not installed' : 'Message durian… (Enter to send, Shift+Enter for newline)'}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isRunning}
          rows={1}
        />
        <div className="input-actions">
          {isRunning ? (
            <button className="stop-btn" onClick={onStop} title="Stop">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect x="2" y="2" width="8" height="8" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={handleSend}
              disabled={!canSend}
              title="Send (Enter)"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 11.5V2.5M3 6.5l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="input-meta">
        <span className="input-meta-label">Model</span>
        <input
          className="meta-input"
          placeholder="default"
          value={model}
          onChange={e => setModel(e.target.value)}
          style={{ width: 130 }}
        />
        <span className="input-meta-label" style={{ marginLeft: 6 }}>Toolsets</span>
        <input
          className="meta-input"
          placeholder="e.g. web,file"
          value={toolsets}
          onChange={e => setToolsets(e.target.value)}
          style={{ width: 110 }}
        />
        <span className="input-hint">Shift+Enter for newline</span>
      </div>
    </div>
  )
}
