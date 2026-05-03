import { useState, useEffect, useRef, useCallback } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Workspace, Settings, FileEntry } from '../types'

interface Props {
  settings: Settings
  onSettingsUpdate: (settings: Settings) => void
  onFileSelect?: (path: string) => void
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const wslMatch = normalized.match(/^\/mnt\/([a-z])\/(.*)$/)
  return wslMatch ? `${wslMatch[1]}:/${wslMatch[2]}` : normalized
}

// Simple file icon based on extension
function FileIcon({ name, isDir, expanded }: { name: string; isDir: boolean; expanded: boolean }) {
  if (isDir) {
    return expanded ? (
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
        <path d="M1.5 2.5h4l1.5 1h5.5v8h-11v-9z" fill="var(--accent)" fillOpacity="0.25" stroke="var(--accent)" strokeWidth="0.8" />
      </svg>
    ) : (
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
        <path d="M1.5 2.5h4l1.5 1h5.5v8h-11v-9z" stroke="var(--accent)" strokeWidth="0.8" />
      </svg>
    )
  }

  const ext = name.split('.').pop()?.toLowerCase() || ''
  const color: Record<string, string> = {
    ts: '#3178c6', tsx: '#3178c6',
    js: '#f7df1e', jsx: '#f7df1e', mjs: '#f7df1e',
    py: '#3572a5', rs: '#dea584', go: '#00add8',
    css: '#563d7c', scss: '#c6538c', html: '#e34c26',
    json: '#555', yaml: '#cb171e', yml: '#cb171e',
    md: '#083fa1', toml: '#9c4221',
    sh: '#89e051', bash: '#89e051',
    png: '#a074c4', jpg: '#a074c4', svg: '#ff9900',
    lock: '#6b7280',
  }
  const c = color[ext] || 'var(--text-faint)'

  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
      <path d="M2 1h6l3.5 3.5V13H2V1z" stroke={c} strokeWidth="0.8" />
      <path d="M8 1v3.5h3.5" stroke={c} strokeWidth="0.8" />
    </svg>
  )
}

// Recursive tree node with auto-refresh on fs-change
function TreeNode({
  entry,
  depth,
  onFileSelect,
  refreshStamp,
}: {
  entry: FileEntry
  depth: number
  onFileSelect: (path: string) => void
  refreshStamp: number  // increment to trigger re-fetch
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)

  const loadChildren = useCallback(async () => {
    if (!entry.is_dir) return
    setLoading(true)
    try {
      const entries = await invoke<FileEntry[]>('list_dir', { path: entry.path })
      setChildren(entries)
    } catch (e) {
      console.error('Failed to list dir:', e)
    }
    setLoading(false)
  }, [entry.path, entry.is_dir])

  const toggle = useCallback(async () => {
    if (!entry.is_dir) {
      onFileSelect(entry.path)
      return
    }
    if (expanded) {
      setExpanded(false)
      return
    }
    await loadChildren()
    setExpanded(true)
  }, [entry, expanded, onFileSelect, loadChildren])

  // Re-fetch children when expanded and refreshStamp changes
  useEffect(() => {
    if (expanded && entry.is_dir) {
      const timer = setTimeout(() => {
        loadChildren()
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [expanded, entry.is_dir, loadChildren, refreshStamp])

  const name = entry.name

  return (
    <div>
      <div
        className={`tree-node${entry.is_dir ? ' dir' : ' file'}`}
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={toggle}
        title={entry.path}
      >
        {entry.is_dir && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0, transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
            <path d="M3 1.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {!entry.is_dir && <span style={{ width: 10, flexShrink: 0 }} />}
        <FileIcon name={name} isDir={entry.is_dir} expanded={expanded} />
        <span className="tree-node-name">{name}</span>
        {loading && <span className="tree-loading" />}
      </div>
      {expanded && children.map(child => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          onFileSelect={onFileSelect}
          refreshStamp={refreshStamp}
        />
      ))}
    </div>
  )
}

// A single workspace item that expands to show its file tree
function WorkspaceItem({
  workspace,
  isActive,
  isExpanded,
  onSelect,
  onToggleExpand,
  onRemove,
  onFileSelect,
  refreshStamp,
  latestChange,
}: {
  workspace: Workspace
  isActive: boolean
  isExpanded: boolean
  onSelect: () => void
  onToggleExpand: () => void
  onRemove: () => void
  onFileSelect: (path: string) => void
  refreshStamp: number
  latestChange: { path: string; kind: string } | null
}) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const loadEntries = useCallback(async () => {
    setLoading(true)
    try {
      const result = await invoke<FileEntry[]>('list_dir', { path: workspace.path })
      setEntries(result)
      setLoaded(true)
    } catch (e) {
      console.error('Failed to refresh:', e)
    }
    setLoading(false)
  }, [workspace.path])

  const handleExpand = useCallback(async () => {
    onToggleExpand()
    if (!isExpanded && !loaded) {
      await loadEntries()
    }
  }, [isExpanded, loaded, onToggleExpand, loadEntries])

  // Re-fetch when refreshStamp changes and we're expanded
  useEffect(() => {
    if (isExpanded) {
      const timer = setTimeout(() => {
        loadEntries()
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [isExpanded, loadEntries, refreshStamp])

  return (
    <div className={`ws-item${isActive ? ' active' : ''}`}>
      <div className="ws-item-row">
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          className="ws-expand-arrow"
          style={{ flexShrink: 0, transition: 'transform 0.15s', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', cursor: 'pointer' }}
          onClick={handleExpand}
        >
          <path d="M3 1.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="ws-item-label" onClick={() => { onSelect(); if (!isExpanded) handleExpand() }}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
            <path d="M1.5 2.5h4l1.5 1h5.5v8h-11v-9z" stroke="currentColor" strokeWidth="0.9" />
          </svg>
          <span className="ws-item-name">{workspace.name}</span>
        </div>
        <button className="ws-remove-btn" onClick={e => { e.stopPropagation(); onRemove() }} title="Remove workspace">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {isExpanded && (
        <div className="ws-file-tree">
          <div className="ws-tree-header">
            <span className="ws-tree-path" title={workspace.path}>{workspace.path}</span>
            {isActive && latestChange && (
              <span
                className="ws-tree-status"
                title={`${latestChange.kind}: ${latestChange.path}`}
              >
                {latestChange.kind}
              </span>
            )}
            <button className="icon-btn ws-refresh-btn" onClick={loadEntries} title="Refresh">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M9.5 5.5a4 4 0 11-1.5 3.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                <path d="M9.5 2.5v3h-3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {loading && <div className="tree-loading-text">Loading...</div>}
          {!loading && entries.map(entry => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              onFileSelect={onFileSelect}
              refreshStamp={refreshStamp}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function WorkspacePicker({ settings, onSettingsUpdate, onFileSelect }: Props) {
  const [confirmPath, setConfirmPath] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const [error, setError] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [expandedWsId, setExpandedWsId] = useState<string | null>(settings.currentWorkspaceId || null)

  // Debounced refresh counter — incremented when fs-change events arrive
  const [refreshStamp, setRefreshStamp] = useState(0)
  const [latestChange, setLatestChange] = useState<{ path: string; kind: string } | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentWorkspaceIdRef = useRef(settings.currentWorkspaceId)
  const currentWorkspacePathRef = useRef('')

  useEffect(() => {
    currentWorkspaceIdRef.current = settings.currentWorkspaceId
    currentWorkspacePathRef.current =
      settings.workspaces.find(w => w.id === settings.currentWorkspaceId)?.path || ''
  }, [settings.currentWorkspaceId, settings.workspaces])

  // Start/stop the filesystem watcher when the active workspace changes
  useEffect(() => {
    // Test command to verify backend is reachable
    invoke<string>('ping_test', { msg: 'workspace-picker-mounted' }).then(r => {
      console.log('[WorkspacePicker] ping_test response:', r)
    }).catch(e => {
      console.error('[WorkspacePicker] ping_test failed:', e)
    })

    const ws = settings.workspaces.find(w => w.id === settings.currentWorkspaceId)
    if (ws && ws.path) {
      console.log('[WorkspacePicker] Starting watcher for:', ws.path)
      invoke('watch_workspace', { path: ws.path }).then(() => {
        console.log('[WorkspacePicker] Watcher started successfully')
      }).catch(e => {
        console.error('[WorkspacePicker] Failed to start watcher:', e)
      })
    } else {
      console.log('[WorkspacePicker] No workspace, stopping watcher')
      invoke('stop_watching').catch(() => {})
    }

    return () => {
      invoke('stop_watching').catch(() => {})
    }
  }, [settings.currentWorkspaceId, settings.workspaces])

  // Listen for fs-change events and debounce-refresh
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    listen<{ path: string; kind: string }>('fs-change', event => {
      if (cancelled) return
      const currentWorkspacePath = currentWorkspacePathRef.current
      if (!currentWorkspacePath) return
      const eventPath = normalizePath(event.payload.path)
      const workspacePath = normalizePath(currentWorkspacePath)
      if (eventPath !== workspacePath && !eventPath.startsWith(workspacePath + '/')) {
        return
      }

      setLatestChange(event.payload)
      // Debounce: wait 300ms after the last event before refreshing
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(() => {
        if (currentWorkspaceIdRef.current) {
          setExpandedWsId(currentWorkspaceIdRef.current)
        }
        setRefreshStamp(s => s + 1)
      }, 300)
    }).then(fn => {
      if (cancelled) { fn() } else { unlisten = fn }
    })

    return () => {
      cancelled = true
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      unlisten?.()
    }
  }, [])

  const handleOpenFolder = async () => {
    try {
      setError('')
      const selected = await open({ directory: true, multiple: false, title: 'Select Folder to Add as Workspace' })
      if (selected && typeof selected === 'string') {
        if (settings.workspaces.some(w => w.path === selected)) {
          setError('This folder is already in your workspaces')
          return
        }
        const folderName = selected.replace(/\\/g, '/').split('/').filter(Boolean).pop() || selected
        setConfirmName(folderName)
        setConfirmPath(selected)
      }
    } catch (e) {
      console.error('Failed to open folder dialog:', e)
    }
  }

  const handleConfirmAdd = async () => {
    if (!confirmPath) return
    try {
      setError('')
      const updated = await invoke<Settings>('add_workspace', {
        path: confirmPath,
        name: confirmName || null,
      })
      onSettingsUpdate(updated)
      const newWs = updated.workspaces.find(w => w.path === confirmPath)
      if (newWs) setExpandedWsId(newWs.id)
      setConfirmPath(null)
      setConfirmName('')
    } catch (e) {
      setError(String(e))
    }
  }

  const handleCancelAdd = () => {
    setConfirmPath(null)
    setConfirmName('')
    setError('')
  }

  const handleSwitch = async (workspaceId: string) => {
    if (workspaceId === settings.currentWorkspaceId) return
    try {
      setError('')
      const updated = await invoke<Settings>('switch_workspace', { workspaceId })
      onSettingsUpdate(updated)
      setExpandedWsId(workspaceId)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleRemove = async (workspaceId: string) => {
    setRemovingId(workspaceId)
  }

  const handleConfirmRemove = async () => {
    if (!removingId) return
    try {
      setError('')
      const updated = await invoke<Settings>('remove_workspace', { workspaceId: removingId })
      onSettingsUpdate(updated)
      if (expandedWsId === removingId) setExpandedWsId(null)
      setRemovingId(null)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="workspace-picker">
      {/* Add workspace button */}
      <button className="workspace-add-btn" onClick={handleOpenFolder}>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
          <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span>Add Workspace</span>
      </button>

      {/* Workspace list with inline file trees */}
      {settings.workspaces.length > 0 && (
        <div className="workspace-list">
          {settings.workspaces.map(ws => (
            <WorkspaceItem
              key={ws.id}
              workspace={ws}
              isActive={ws.id === settings.currentWorkspaceId}
              isExpanded={ws.id === expandedWsId}
              onSelect={() => handleSwitch(ws.id)}
              onToggleExpand={() => setExpandedWsId(prev => prev === ws.id ? null : ws.id)}
              onRemove={() => handleRemove(ws.id)}
              onFileSelect={onFileSelect || (() => {})}
              refreshStamp={refreshStamp}
              latestChange={ws.id === settings.currentWorkspaceId ? latestChange : null}
            />
          ))}
        </div>
      )}

      {/* Error message */}
      {error && <div className="workspace-error">{error}</div>}

      {/* Confirmation dialog: Add workspace */}
      {confirmPath && (
        <div className="workspace-confirm-overlay" onClick={e => { if (e.target === e.currentTarget) handleCancelAdd() }}>
          <div className="workspace-confirm-panel">
            <div className="workspace-confirm-title">Add Workspace</div>
            <div className="workspace-confirm-text">
              Add this folder to your workspaces?
            </div>
            <div className="workspace-confirm-path" title={confirmPath}>
              {confirmPath}
            </div>
            <div className="workspace-confirm-field">
              <label className="workspace-confirm-label">Name</label>
              <input
                className="workspace-confirm-input"
                type="text"
                value={confirmName}
                onChange={e => setConfirmName(e.target.value)}
                placeholder="Workspace name"
              />
            </div>
            <div className="workspace-confirm-actions">
              <button className="workspace-confirm-cancel" onClick={handleCancelAdd}>Cancel</button>
              <button className="workspace-confirm-ok" onClick={handleConfirmAdd}>Add & Select</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation dialog: Remove workspace */}
      {removingId && (
        <div className="workspace-confirm-overlay" onClick={e => { if (e.target === e.currentTarget) setRemovingId(null) }}>
          <div className="workspace-confirm-panel">
            <div className="workspace-confirm-title">Remove Workspace</div>
            <div className="workspace-confirm-text">
              Remove <strong>{settings.workspaces.find(w => w.id === removingId)?.name}</strong> from your workspaces?
            </div>
            <div className="workspace-confirm-note">
              This only removes it from the app. The folder on disk is not affected.
            </div>
            <div className="workspace-confirm-actions">
              <button className="workspace-confirm-cancel" onClick={() => setRemovingId(null)}>Cancel</button>
              <button className="workspace-confirm-danger" onClick={handleConfirmRemove}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
