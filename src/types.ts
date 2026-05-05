export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  streaming?: boolean
  toolActivity?: ToolActivity[]
}

export interface ToolActivity {
  id: string
  tool: string
  detail: string
  timestamp: number
  phase?: string  // init, thinking, tool, warning, error, info
  icon?: string   // emoji icon from backend (e.g. "📄", "⌨", "🔧")
  actionType?: string  // read, write, terminal, search, browser, memory, skill, delegate, generic
  path?: string   // file path, URL, or command being operated on
}

export type ApprovalChoice = 'allow' | 'reject' | 'other'

export interface ApprovalRequest {
  id: string
  command: string
  detail: string
  timestamp: number
}

export interface Session {
  id: string
  title: string
  createdAt: number
  messages: Message[]
}

export type Theme = 'dark' | 'light' | 'pixel'

export interface Workspace {
  id: string
  name: string
  path: string
  addedAt: number
}

export interface Settings {
  provider: string
  endpoint: string
  apiKey: string
  model: string
  toolsets: string
  projectPath: string
  workspaces: Workspace[]
  currentWorkspaceId: string
}

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number
}
