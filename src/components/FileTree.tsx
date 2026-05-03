import { useState, useCallback, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { FileEntry } from '../types'

interface Props {
  rootPath: string
  onFileSelect?: (path: string) => void
}

// Simple file icon based on extension
function FileIcon({ name, isDir, expanded }: { name: string; isDir: boolean; expanded: boolean }) {
  if (isDir) {
    return expanded ? (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
        <path d="M1.5 2.5h4l1.5 1h5.5v8h-11v-9z" fill="var(--accent)" fillOpacity="0.3" stroke="var(--accent)" strokeWidth="0.8" />
      </svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
        <path d="M1.5 2.5h4l1.5 1h5.5v8h-11v-9z" stroke="var(--accent)" strokeWidth="0.8" />
      </svg>
    )
  }

  const ext = name.split('.').pop()?.toLowerCase() || ''
  const color: Record<string, string> = {
    ts: '#3178c6', tsx: '#3178c6',
    js: '#f7df1e', jsx: '#f7df1e', mjs: '#f7df1e',
    py: '#3572a5',
    rs: '#dea584',
    go: '#00add8',
    rb: '#701516',
    java: '#b07219',
    css: '#563d7c', scss: '#c6538c',
    html: '#e34c26',
    json: '#292929',
    yaml: '#cb171e', yml: '#cb171e',
    md: '#083fa1',
    toml: '#9c4221',
    sh: '#89e051', bash: '#89e051',
    sql: '#e38c00',
    png: '#a074c4', jpg: '#a074c4', svg: '#ff9900', gif: '#a074c4',
    lock: '#6b7280',
  }
  const c = color[ext] || 'var(--text-faint)'

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0 }}>
      <path d="M2 1h6l3.5 3.5V13H2V1z" stroke={c} strokeWidth="0.8" />
      <path d="M8 1v3.5h3.5" stroke={c} strokeWidth="0.8" />
    </svg>
  )
}

function TreeNode({ entry, depth, onFileSelect }: { entry: FileEntry; depth: number; onFileSelect: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)

  const toggle = useCallback(async () => {
    if (!entry.is_dir) {
      onFileSelect(entry.path)
      return
    }
    if (expanded) {
      setExpanded(false)
      return
    }
    setLoading(true)
    try {
      const entries = await invoke<FileEntry[]>('list_dir', { path: entry.path })
      setChildren(entries)
      setExpanded(true)
    } catch (e) {
      console.error('Failed to list dir:', e)
    }
    setLoading(false)
  }, [entry, expanded, onFileSelect])

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
        <TreeNode key={child.path} entry={child} depth={depth + 1} onFileSelect={onFileSelect} />
      ))}
    </div>
  )
}

export default function FileTree({ rootPath, onFileSelect }: Props) {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loadedPath, setLoadedPath] = useState('')

  const loadRoot = useCallback(async () => {
    if (!rootPath) return
    setLoading(true)
    try {
      const entries = await invoke<FileEntry[]>('list_dir', { path: rootPath })
      setRootEntries(entries)
      setLoadedPath(rootPath)
    } catch (e) {
      console.error('Failed to list root:', e)
    }
    setLoading(false)
  }, [rootPath])

  // Auto-load when rootPath changes
  useEffect(() => {
    if (rootPath && rootPath !== loadedPath) {
      setRootEntries([])
      loadRoot()
    }
  }, [rootPath, loadedPath, loadRoot])

  if (!rootPath) return null

  return (
    <div className="file-tree">
      {loading && <div className="tree-loading-text">Loading...</div>}
      {!loading && rootEntries.map(entry => (
        <TreeNode key={entry.path} entry={entry} depth={0} onFileSelect={onFileSelect || (() => {})} />
      ))}
    </div>
  )
}
