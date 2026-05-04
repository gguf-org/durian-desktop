import { useState } from 'react'
import type { Session, Theme, Settings } from '../types'
import WorkspacePicker from './WorkspacePicker'

interface Props {
  sessions: Session[]
  currentSessionId: string | null
  onNewChat: () => void
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => void
  theme: Theme
  onToggleTheme: () => void
  open: boolean
  onToggle: () => void
  onOpenSettings: () => void
  settings: Settings
  onSettingsUpdate: (settings: Settings) => void
  onFileSelect?: (path: string) => void
}

function formatDate(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function Sidebar({
  sessions,
  currentSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  theme,
  onToggleTheme,
  open: isOpen,
  onToggle,
  onOpenSettings,
  settings,
  onSettingsUpdate,
  onFileSelect,
}: Props) {
  const [explorerCollapsed, setExplorerCollapsed] = useState(false)

  return (
    <aside className={`sidebar${isOpen ? '' : ' collapsed'}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">𖦹</div>
        <span className="sidebar-title">durian ✷</span>
        {/* <div className="sidebar-logo">✷</div> */}
        {/* <span className="sidebar-title">Durian</span> */}
        <button
          className="icon-btn"
          style={{ marginLeft: 'auto' }}
          onClick={onToggle}
          title={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            {isOpen ? (
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
      </div>

      {/* Workspaces Section */}
      <div className="sidebar-explorer">
        <div
          className="sidebar-section-label clickable"
          onClick={() => setExplorerCollapsed(c => !c)}
          title="Manage workspaces"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0, transition: 'transform 0.15s', transform: explorerCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>
            <path d="M3 1.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          WORKSPACES
        </div>
        {!explorerCollapsed && isOpen && (
          <WorkspacePicker
            settings={settings}
            onSettingsUpdate={onSettingsUpdate}
            onFileSelect={onFileSelect}
          />
        )}
      </div>

      <button className="sidebar-new-btn" onClick={onNewChat}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span>New chat</span>
      </button>

      <div className="sidebar-section-label">Recents</div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="session-empty">No sessions yet</div>
        ) : (
          sessions.map(s => (
            <div
              key={s.id}
              className={`session-item${s.id === currentSessionId ? ' active' : ''}`}
              onClick={() => onSelectSession(s.id)}
              title={s.title}
            >
              <div className="session-icon">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2h8a1 1 0 011 1v5a1 1 0 01-1 1H4l-2 2V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="session-info">
                <div className="session-name">{s.title}</div>
                <div className="session-date">{formatDate(s.createdAt)}</div>
              </div>
              <button
                className="session-del-btn"
                onClick={e => { e.stopPropagation(); onDeleteSession(s.id) }}
                title="Delete session"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button
          className="icon-btn"
          onClick={onOpenSettings}
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6.5 1.5l.35 1.4a.5.5 0 00.38.37l.65.17a.5.5 0 00.47-.1l1.08-.92a.5.5 0 01.63-.02l1.1.8a.5.5 0 01.15.6l-.55 1.3a.5.5 0 00.06.49l.4.52a.5.5 0 00.44.2l1.4-.06a.5.5 0 01.48.4l.3 1.35a.5.5 0 01-.3.55l-1.28.5a.5.5 0 00-.3.4l-.1.65a.5.5 0 00.2.46l1.14.82a.5.5 0 01.12.62l-.78 1.15a.5.5 0 01-.58.18l-1.3-.48a.5.5 0 00-.49.07l-.5.4a.5.5 0 00-.18.47l.22 1.38a.5.5 0 01-.38.52l-1.35.25a.5.5 0 01-.53-.3l-.53-1.28a.5.5 0 00-.41-.3h-.65a.5.5 0 00-.44.23l-.76 1.18a.5.5 0 01-.6.14l-1.2-.7a.5.5 0 01-.14-.58l.5-1.28a.5.5 0 00-.08-.48l-.42-.5a.5.5 0 00-.47-.16l-1.37.27a.5.5 0 01-.5-.35l-.38-1.32a.5.5 0 01.27-.56l1.26-.56a.5.5 0 00.28-.42l.05-.64a.5.5 0 00-.22-.44L1.8 6.47a.5.5 0 01-.1-.6l.76-1.16a.5.5 0 01.57-.2l1.3.44a.5.5 0 00.48-.08l.5-.4a.5.5 0 00.16-.47L5.2 2.6a.5.5 0 01.36-.52L6.5 1.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
            <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M11.89 3.05l-1.06 1.06M3.05 11.89l1.06 1.06" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 9.5A5.5 5.5 0 116.5 2.5a4 4 0 007 7z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <div className="sidebar-footer-spacer" />
        <span style={{ fontSize: 10, color: 'var(--text-faint)', paddingRight: 2 }}>
          {isOpen ? 'v0.1' : ''}
        </span>
      </div>
    </aside>
  )
}
