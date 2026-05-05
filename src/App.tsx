import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './App.css'
import type { Session, Message, Theme, Settings, ToolActivity, ApprovalRequest, ApprovalChoice } from './types'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import SettingsPage from './components/SettingsPage'

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

interface OutputChunk {
  id: string
  text: string
  done: boolean
}

interface DurianInstallStatus {
  installing: boolean
  available: boolean
  message?: string
}

const DEFAULT_SETTINGS: Settings = {
  provider: '',
  endpoint: '',
  apiKey: '',
  model: '',
  toolsets: '',
  projectPath: '',
  workspaces: [],
  currentWorkspaceId: '',
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem('theme') as Theme) || 'dark'
  )
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [durianAvailable, setDurianAvailable] = useState(true)
  const [durianInstalling, setDurianInstalling] = useState(false)
  const [durianInstallMessage, setDurianInstallMessage] = useState('')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recentActivities, setRecentActivities] = useState<ToolActivity[]>([])
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null)

  const currentSessionIdRef = useRef<string | null>(null)
  const currentQueryIdRef = useRef<string | null>(null)

  const currentSession = sessions.find(s => s.id === currentSessionId) ?? null

  const projectPath = settings.projectPath

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  // Load sessions and ensure durian is available on mount
  useEffect(() => {
    let unlistenInstall: (() => void) | undefined
    let cancelled = false

    invoke<Session[]>('load_sessions')
      .then(s => setSessions(s))
      .catch(console.error)

    listen<DurianInstallStatus>('durian-install-status', event => {
      if (cancelled) return
      setDurianInstalling(event.payload.installing)
      setDurianAvailable(event.payload.available)
      setDurianInstallMessage(event.payload.message || '')
    }).then(fn => {
      if (cancelled) {
        fn()
      } else {
        unlistenInstall = fn
      }
    })

    invoke<boolean>('ensure_durian_installed')
      .then(available => {
        if (cancelled) return
        setDurianAvailable(available)
        setDurianInstalling(!available)
      })
      .catch(error => {
        console.error(error)
        if (cancelled) return
        setDurianAvailable(false)
        setDurianInstalling(false)
        setDurianInstallMessage(String(error))
      })

    invoke<Settings>('load_settings')
      .then(s => setSettings(s))
      .catch(console.error)

    return () => {
      cancelled = true
      unlistenInstall?.()
    }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    listen<ApprovalRequest>('durian-approval-request', event => {
      if (cancelled) return
      if (event.payload.id !== currentQueryIdRef.current) return
      setApprovalRequest(event.payload)
    }).then(fn => {
      if (cancelled) {
        fn()
      } else {
        unlisten = fn
      }
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  // Debounce-save session whenever messages change
  useEffect(() => {
    if (!currentSession || currentSession.messages.length === 0) return
    const t = setTimeout(() => {
      invoke('save_session', { session: currentSession }).catch(console.error)
    }, 600)
    return () => clearTimeout(t)
  }, [currentSession])

  // Subscribe to durian output events once
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    listen<OutputChunk>('durian-output', event => {
      if (cancelled) return
      const { id, text, done } = event.payload
      if (id !== currentQueryIdRef.current) return

      if (done) {
        setIsRunning(false)
        currentQueryIdRef.current = null
        setApprovalRequest(null)
        return
      }

      if (!text) return

      const sid = currentSessionIdRef.current
      setSessions(prev =>
        prev.map(s => {
          if (s.id !== sid) return s
          const msgs = s.messages
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && last.streaming && last.id === id) {
            return {
              ...s,
              messages: msgs.map(m =>
                m.id === id
                  ? { ...m, content: m.content ? m.content + '\n' + text : text }
                  : m
              ),
            }
          }
          return {
            ...s,
            messages: [
              ...msgs,
              {
                id,
                role: 'assistant' as const,
                content: text,
                timestamp: Date.now(),
                streaming: true,
              },
            ],
          }
        })
      )
    }).then(fn => {
      if (cancelled) {
        fn()
      } else {
        unlisten = fn
      }
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  // Subscribe to durian activity events (tool status from agent.log)
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    listen<{ id: string; phase?: string; tool?: string; detail?: string; icon?: string; ping?: boolean; actionType?: string; path?: string }>('durian-activity', event => {
      if (cancelled) return
      const { id, phase, tool, detail, icon, ping, actionType, path } = event.payload
      if (id !== currentQueryIdRef.current) return

      // Ping events are just keep-alive, skip
      if (ping) return

      if (tool && detail) {
        const activity: ToolActivity = {
          id: Math.random().toString(36).slice(2),
          tool,
          detail,
          timestamp: Date.now(),
          phase: phase || 'info',
          icon,
          actionType,
          path,
        }
        setRecentActivities(prev => [...prev.slice(-30), activity])
        // Also persist to the last assistant message
        setSessions(prev =>
          prev.map(s => {
            if (s.id !== currentSessionIdRef.current) return s
            const msgs = [...s.messages]
            const lastIdx = msgs.length - 1
            if (
              lastIdx < 0 ||
              msgs[lastIdx].role !== 'assistant' ||
              msgs[lastIdx].id !== currentQueryIdRef.current
            ) {
              return {
                ...s,
                messages: [
                  ...msgs,
                  {
                    id: currentQueryIdRef.current || activity.id,
                    role: 'assistant' as const,
                    content: '',
                    timestamp: Date.now(),
                    streaming: true,
                    toolActivity: [activity],
                  },
                ],
              }
            }
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              toolActivity: [...(msgs[lastIdx].toolActivity || []), activity].slice(-30),
            }
            return { ...s, messages: msgs }
          })
        )
      }
    }).then(fn => {
      if (cancelled) {
        fn()
      } else {
        unlisten = fn
      }
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const handleNewChat = useCallback(() => {
    const id = genId()
    const newSession: Session = {
      id,
      title: 'New chat',
      createdAt: Date.now(),
      messages: [],
    }
    setSessions(prev => [newSession, ...prev])
    setCurrentSessionId(id)
  }, [])

  const handleSend = useCallback(
    async (text: string, model: string, toolsets: string) => {
      if (!text.trim() || isRunning) return

      let sid = currentSessionIdRef.current
      if (!sid) {
        sid = genId()
        const newSession: Session = {
          id: sid,
          title: text.trim().slice(0, 60),
          createdAt: Date.now(),
          messages: [],
        }
        setSessions(prev => [newSession, ...prev])
        setCurrentSessionId(sid)
        currentSessionIdRef.current = sid
      }

      const queryId = genId()
      currentQueryIdRef.current = queryId

      const userMsg: Message = {
        id: genId(),
        role: 'user',
        content: text.trim(),
        timestamp: Date.now(),
      }

      setSessions(prev =>
        prev.map(s => {
          if (s.id !== sid) return s
          return {
            ...s,
            title: s.messages.length === 0 ? text.trim().slice(0, 60) : s.title,
            messages: [...s.messages, userMsg],
          }
        })
      )

      setIsRunning(true)
      setRecentActivities([])
      setApprovalRequest(null)

      try {
        await invoke('run_durian_query', {
          id: queryId,
          query: text.trim(),
          model: model || null,
          toolsets: toolsets || null,
        })
      } catch (e) {
        setIsRunning(false)
        currentQueryIdRef.current = null
        setApprovalRequest(null)
        const errMsg: Message = {
          id: genId(),
          role: 'assistant',
          content: `Error: ${String(e)}`,
          timestamp: Date.now(),
        }
        setSessions(prev =>
          prev.map(s =>
            s.id === sid ? { ...s, messages: [...s.messages, errMsg] } : s
          )
        )
      }
    },
    [isRunning]
  )

  const handleStop = useCallback(() => {
    if (currentQueryIdRef.current) {
      invoke('stop_durian', { id: currentQueryIdRef.current }).catch(console.error)
      setIsRunning(false)
      currentQueryIdRef.current = null
      setApprovalRequest(null)
    }
  }, [])

  const handleApprovalResponse = useCallback(
    async (choice: ApprovalChoice, response?: string) => {
      const request = approvalRequest
      if (!request) return
      setApprovalRequest(null)
      try {
        await invoke('respond_durian_approval', {
          id: request.id,
          choice,
          response: response || null,
        })
      } catch (e) {
        console.error('Failed to respond to approval request:', e)
      }
    },
    [approvalRequest]
  )

  const handleDeleteSession = useCallback(async (id: string) => {
    await invoke('delete_session', { id }).catch(console.error)
    setSessions(prev => prev.filter(s => s.id !== id))
    if (currentSessionIdRef.current === id) {
      setCurrentSessionId(null)
    }
  }, [])

  const handleSaveSettings = useCallback(async (newSettings: Settings) => {
    try {
      await invoke('save_settings', { settings: newSettings })
      setSettings(newSettings)
    } catch (e) {
      console.error('Failed to save settings:', e)
    }
  }, [])

  const handleSettingsUpdate = useCallback((updated: Settings) => {
    setSettings(updated)
  }, [])

  const handleFileSelect = useCallback((path: string) => {
    console.log('File selected:', path)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(t => {
      if (t === 'dark') return 'light'
      if (t === 'light') return 'pixel'
      return 'dark'
    })
  }, [])

  return (
    <div id="app" data-theme={theme}>
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onNewChat={handleNewChat}
        onSelectSession={setCurrentSessionId}
        onDeleteSession={handleDeleteSession}
        theme={theme}
        onToggleTheme={toggleTheme}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        onOpenSettings={() => setSettingsOpen(true)}
        settings={settings}
        onSettingsUpdate={handleSettingsUpdate}
        onFileSelect={handleFileSelect}
      />
      <ChatView
        session={currentSession}
        isRunning={isRunning}
        onSend={handleSend}
        onStop={handleStop}
        onNewChat={handleNewChat}
        durianAvailable={durianAvailable}
        durianInstalling={durianInstalling}
        durianInstallMessage={durianInstallMessage}
        projectPath={projectPath}
        recentActivities={recentActivities}
        settings={settings}
        approvalRequest={approvalRequest}
        onApprovalResponse={handleApprovalResponse}
      />
      {settingsOpen && (
        <SettingsPage
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
