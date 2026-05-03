import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '../types'

interface Props {
  settings: Settings
  onSave: (settings: Settings) => void
  onClose: () => void
}

const PROVIDER_OPTIONS = [
  { value: '', label: 'Auto (default)' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'vllm', label: 'vLLM' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai-codex', label: 'OpenAI Codex (OAuth)' },
  { value: 'openai-codex-api', label: 'OpenAI Codex (API Key)' },
  { value: 'copilot', label: 'GitHub Copilot' },
  { value: 'copilot-acp', label: 'Copilot ACP' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'nous', label: 'Nous Portal' },
  { value: 'zai', label: 'Z.AI / GLM' },
  { value: 'huggingface', label: 'HuggingFace' },
  { value: 'kimi-coding', label: 'Kimi / Moonshot' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'kilocode', label: 'Kilocode' },
  { value: 'xiaomi', label: 'Xiaomi' },
  { value: 'arcee', label: 'Arcee' },
]

export default function SettingsPage({ settings, onSave, onClose }: Props) {
  const [form, setForm] = useState<Settings>({ ...settings })
  const [saved, setSaved] = useState(false)
  const [showKey, setShowKey] = useState(false)

  const update = (key: keyof Settings, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const handleSave = () => {
    onSave(form)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const handleReset = () => {
    setForm({ provider: '', endpoint: '', apiKey: '', model: '', toolsets: '', projectPath: '', workspaces: [], currentWorkspaceId: '' })
    setSaved(false)
  }

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select Project Folder' })
      if (selected && typeof selected === 'string') {
        update('projectPath', selected)
      }
    } catch (e) {
      console.error('Failed to open folder dialog:', e)
    }
  }

  return (
    <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings-panel">
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <div className="settings-section-title">Project Folder</div>
            <div className="settings-key-row">
              <input
                className="settings-input"
                type="text"
                placeholder="/path/to/project (leave empty for current directory)"
                value={form.projectPath}
                onChange={e => update('projectPath', e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="icon-btn settings-key-toggle" onClick={handleBrowseFolder} title="Browse">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M1.5 2.5h4l1.5 1h5.5v8h-11v-9z" stroke="currentColor" strokeWidth="0.8" />
                </svg>
              </button>
            </div>
            <div className="settings-hint">
              Select the project folder for durian to work in. Sets the working directory and <code>terminal.cwd</code> in config.
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Provider</div>
            <select
              className="settings-select"
              value={form.provider}
              onChange={e => update('provider', e.target.value)}
            >
              {PROVIDER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <div className="settings-hint">
              Choose your AI provider. For custom OpenAI-compatible endpoints, set the endpoint and API key below and select "Auto".
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">API Endpoint (Base URL)</div>
            <input
              className="settings-input"
              type="text"
              placeholder="https://api.openai.com/v1 (leave empty for default)"
              value={form.endpoint}
              onChange={e => update('endpoint', e.target.value)}
            />
            <div className="settings-hint">
              Custom API base URL. This sets <code>model.base_url</code> in durian config. Used for custom or self-hosted OpenAI-compatible endpoints.
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">API Key</div>
            <div className="settings-key-row">
              <input
                className="settings-input"
                type={showKey ? 'text' : 'password'}
                placeholder="sk-... (leave empty if not required)"
                value={form.apiKey}
                onChange={e => update('apiKey', e.target.value)}
              />
              <button
                className="icon-btn settings-key-toggle"
                onClick={() => setShowKey(v => !v)}
                title={showKey ? 'Hide' : 'Show'}
              >
                {showKey ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M2 2l10 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                )}
              </button>
            </div>
            <div className="settings-hint">
              Your API key. Stored locally on your device and set as <code>model.api_key</code> in durian config.
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Default Model</div>
            <input
              className="settings-input"
              type="text"
              placeholder="e.g. anthropic/claude-sonnet-4 (leave empty for default)"
              value={form.model}
              onChange={e => update('model', e.target.value)}
            />
            <div className="settings-hint">
              Default model to use for all queries. Can be overridden per-query in the chat input.
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Default Toolsets</div>
            <input
              className="settings-input"
              type="text"
              placeholder="e.g. web,terminal,file (leave empty for default)"
              value={form.toolsets}
              onChange={e => update('toolsets', e.target.value)}
            />
            <div className="settings-hint">
              Comma-separated list of toolsets enabled by default. Can be overridden per-query.
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button className="settings-reset-btn" onClick={handleReset}>
            Reset to Defaults
          </button>
          <button className="settings-save-btn" onClick={handleSave}>
            {saved ? '✓ Saved' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  )
}
