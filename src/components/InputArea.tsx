import { useState, useRef, useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '../types'

interface Props {
  onSend: (text: string, model: string, toolsets: string) => void
  onStop: () => void
  isRunning: boolean
  disabled?: boolean
  settings: Settings
}

const MODEL_OPTIONS: Record<string, string[]> = {
  '': ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'claude-sonnet-4.5', 'gemini-3-pro'],
  openrouter: ['openai/gpt-5.4', 'openai/gpt-5.4-mini', 'anthropic/claude-sonnet-4.5', 'google/gemini-3-pro', 'moonshotai/kimi-k2-thinking'],
  anthropic: ['claude-sonnet-4.5', 'claude-opus-4.1', 'claude-haiku-4.5', 'claude-sonnet-4-20250514'],
  'openai-codex': ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
  'openai-codex-api': ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
  copilot: ['gpt-5.4', 'gpt-5.3-codex', 'claude-sonnet-4.5'],
  'copilot-acp': ['gpt-5.4', 'gpt-5.3-codex', 'claude-sonnet-4.5'],
  gemini: ['gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  ollama: ['qwen3-coder:latest', 'devstral:latest', 'llama3.3:latest', 'gemma3:latest'],
  lmstudio: ['qwen3-coder', 'devstral', 'llama-3.3', 'gemma-3'],
  vllm: ['Qwen/Qwen3-Coder', 'deepseek-ai/DeepSeek-Coder-V2-Instruct', 'meta-llama/Llama-3.3-70B-Instruct'],
  nous: ['DeepHermes-3-Mistral-24B-Preview', 'Hermes-3-Llama-3.1-405B'],
  zai: ['glm-5', 'glm-4.6', 'glm-4.5'],
  huggingface: ['Qwen/Qwen3-Coder', 'deepseek-ai/DeepSeek-Coder-V2-Instruct', 'meta-llama/Llama-3.3-70B-Instruct'],
  'kimi-coding': ['kimi-k2-thinking', 'moonshot-v1-128k', 'moonshot-v1-32k'],
  minimax: ['minimax-m2.7', 'minimax-m2.5', 'minimax-m2', 'abab6.5s-chat'],
  kilocode: ['kilocode/kilo-code', 'openai/gpt-5.4', 'anthropic/claude-sonnet-4.5'],
  xiaomi: ['MiMo-VL-7B-RL', 'MiMo-7B-RL'],
  arcee: ['AFM-4.5B', 'Virtuoso-Large'],
}

const TOOLSET_OPTIONS = ['web', 'file', 'terminal', 'browser', 'memory', 'skill']

function unique(values: string[]) {
  return values.filter((value, index) => value && values.indexOf(value) === index)
}

export default function InputArea({ onSend, onStop, isRunning, disabled, settings }: Props) {
  const [text, setText] = useState('')
  const [model, setModel] = useState('')
  const [toolsets, setToolsets] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const modelOptions = unique([
    settings.model,
    ...(MODEL_OPTIONS[settings.provider] || MODEL_OPTIONS['']),
  ])

  const selectedToolsets = toolsets !== null
    ? toolsets.split(',').map(t => t.trim()).filter(Boolean)
    : settings.toolsets.split(',').map(t => t.trim()).filter(Boolean)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [text])

  const handleSend = () => {
    if (!text.trim() || isRunning || disabled) return
    onSend(text, model, toolsets ?? '')
    setText('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleAttach = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: 'Add file or picture to prompt',
      })
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
      if (paths.length === 0) return

      setText(prev => {
        const prefix = prev.trimEnd()
        const attachmentText = paths
          .map(path => {
            const normalized = path.replace(/\\/g, '/')
            const name = normalized.split('/').filter(Boolean).pop() || normalized
            return `Attached file: ${name}\nPath: ${path}`
          })
          .join('\n\n')
        return `${prefix ? `${prefix}\n\n` : ''}${attachmentText}`
      })
      setTimeout(() => textareaRef.current?.focus(), 0)
    } catch (e) {
      console.error('Failed to attach file:', e)
    }
  }

  const handleToolsetChange = (toolset: string, checked: boolean) => {
    const next = new Set(selectedToolsets)
    if (checked) {
      next.add(toolset)
    } else {
      next.delete(toolset)
    }
    setToolsets(Array.from(next).join(','))
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
        <select
          className="meta-select model-select"
          title={`Model for ${settings.provider || 'Auto provider'}`}
          value={model}
          onChange={e => setModel(e.target.value)}
          disabled={disabled || isRunning}
        >
          <option value="">{settings.model ? `Default: ${settings.model}` : 'Model: default'}</option>
          {modelOptions.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>

        <div className="toolset-menu">
          <button
            className="meta-icon-btn"
            type="button"
            title={selectedToolsets.length ? `Toolsets: ${selectedToolsets.join(', ')}` : 'Toolsets'}
            disabled={disabled || isRunning}
          >
            🔨
          </button>
          <div className="toolset-popover">
            {TOOLSET_OPTIONS.map(option => (
              <label key={option} className="toolset-option">
                <input
                  type="checkbox"
                  checked={selectedToolsets.includes(option)}
                  onChange={e => handleToolsetChange(option, e.target.checked)}
                />
                {option}
              </label>
            ))}
          </div>
        </div>

        <button
          className="meta-icon-btn"
          type="button"
          title="Add file or picture"
          onClick={handleAttach}
          disabled={disabled || isRunning}
        >
          +
        </button>

        {selectedToolsets.length > 0 && (
          <span className="input-toolset-summary">{selectedToolsets.join(', ')}</span>
        )}
        <span className="input-hint">Shift+Enter for newline</span>
      </div>
    </div>
  )
}
