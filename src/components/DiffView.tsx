import { useState } from 'react'
import type { CodeChange } from '../types'

// ---- diff line types ----

interface DiffLine {
  type: 'file' | 'hunk' | 'add' | 'remove' | 'context'
  content: string
  oldLine: number | null
  newLine: number | null
}

interface SbsCell {
  lineNo: number | null
  sign: string
  content: string
  kind: 'add' | 'remove' | 'context' | 'empty'
}

interface SbsRow {
  type: 'change' | 'context' | 'hunk' | 'file'
  spanContent?: string
  left?: SbsCell
  right?: SbsCell
}

// ---- LCS-based line differ ----

type DiffOp = { op: '+' | '-' | '='; line: string }

function computeLineDiff(a: string[], b: string[]): DiffOp[] {
  const m = a.length
  const n = b.length
  if (m * n > 80000) {
    // Fallback for very large inputs: all-removed then all-added
    return [
      ...a.map(line => ({ op: '-' as const, line })),
      ...b.map(line => ({ op: '+' as const, line })),
    ]
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const result: DiffOp[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ op: '=', line: a[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ op: '+', line: b[j - 1] })
      j--
    } else {
      result.unshift({ op: '-', line: a[i - 1] })
      i--
    }
  }
  return result
}

function buildUnifiedDiff(oldStr: string, newStr: string, filePath: string): string {
  const fileName = filePath.split(/[/\\]/).pop() || filePath
  const a = oldStr.split(/\r?\n/)
  const b = newStr.split(/\r?\n/)
  const ops = computeLineDiff(a, b)

  const CONTEXT = 3
  const lines: Array<{ prefix: string; content: string }> = ops.map(op => ({
    prefix: op.op === '=' ? ' ' : op.op,
    content: op.line,
  }))

  // Collect hunk ranges
  const changed: number[] = []
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].prefix !== ' ') changed.push(idx)
  }
  if (changed.length === 0) return `--- a/${fileName}\n+++ b/${fileName}\n`

  const hunks: Array<[number, number]> = []
  let start = Math.max(0, changed[0] - CONTEXT)
  let end = Math.min(lines.length - 1, changed[0] + CONTEXT)
  for (let k = 1; k < changed.length; k++) {
    const next = changed[k]
    if (next - CONTEXT <= end + CONTEXT) {
      end = Math.min(lines.length - 1, next + CONTEXT)
    } else {
      hunks.push([start, end])
      start = Math.max(0, next - CONTEXT)
      end = Math.min(lines.length - 1, next + CONTEXT)
    }
  }
  hunks.push([start, end])

  // Pre-compute per-op old/new line numbers for accurate hunk headers
  const oldLineNos: (number | null)[] = []
  const newLineNos: (number | null)[] = []
  let ol = 1
  let nl = 1
  for (const l of lines) {
    if (l.prefix === '-') { oldLineNos.push(ol++); newLineNos.push(null) }
    else if (l.prefix === '+') { oldLineNos.push(null); newLineNos.push(nl++) }
    else { oldLineNos.push(ol++); newLineNos.push(nl++) }
  }

  let result = `--- a/${fileName}\n+++ b/${fileName}\n`
  for (const [hs, he] of hunks) {
    let oldCount = 0
    let newCount = 0
    for (let idx = hs; idx <= he; idx++) {
      if (lines[idx].prefix !== '+') oldCount++
      if (lines[idx].prefix !== '-') newCount++
    }
    const hunkOldStart = oldLineNos.slice(0, hs).filter(x => x !== null).length + 1
    const hunkNewStart = newLineNos.slice(0, hs).filter(x => x !== null).length + 1
    result += `@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@\n`
    for (let idx = hs; idx <= he; idx++) {
      result += lines[idx].prefix + lines[idx].content + '\n'
    }
  }

  return result
}

// ---- unified diff parser (same as extension) ----

function parseDiff(diff: string): DiffLine[] {
  const rawLines = diff.split(/\r?\n/)
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const raw of rawLines) {
    if (raw.startsWith('---') || raw.startsWith('+++')) {
      result.push({ type: 'file', content: raw, oldLine: null, newLine: null })
    } else if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldLine = parseInt(m[1], 10)
        newLine = parseInt(m[2], 10)
      }
      result.push({ type: 'hunk', content: raw, oldLine: null, newLine: null })
    } else if (raw.startsWith('-')) {
      result.push({ type: 'remove', content: raw.slice(1), oldLine: oldLine++, newLine: null })
    } else if (raw.startsWith('+')) {
      result.push({ type: 'add', content: raw.slice(1), oldLine: null, newLine: newLine++ })
    } else {
      const content = raw.startsWith(' ') ? raw.slice(1) : raw
      result.push({ type: 'context', content, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return result
}

function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'add') added++
    else if (l.type === 'remove') removed++
  }
  return { added, removed }
}

function toSideBySide(lines: DiffLine[]): SbsRow[] {
  const result: SbsRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.type === 'file') {
      result.push({ type: 'file', spanContent: line.content })
      i++
    } else if (line.type === 'hunk') {
      result.push({ type: 'hunk', spanContent: line.content })
      i++
    } else if (line.type === 'context') {
      result.push({
        type: 'context',
        left: { lineNo: line.oldLine, sign: ' ', content: line.content, kind: 'context' },
        right: { lineNo: line.newLine, sign: ' ', content: line.content, kind: 'context' },
      })
      i++
    } else {
      const removes: DiffLine[] = []
      const adds: DiffLine[] = []
      let j = i
      while (j < lines.length && (lines[j].type === 'remove' || lines[j].type === 'add')) {
        if (lines[j].type === 'remove') removes.push(lines[j])
        else adds.push(lines[j])
        j++
      }
      const maxLen = Math.max(removes.length, adds.length)
      for (let k = 0; k < maxLen; k++) {
        const rem = removes[k]
        const add = adds[k]
        result.push({
          type: 'change',
          left: rem
            ? { lineNo: rem.oldLine, sign: '-', content: rem.content, kind: 'remove' }
            : { lineNo: null, sign: '', content: '', kind: 'empty' },
          right: add
            ? { lineNo: add.newLine, sign: '+', content: add.content, kind: 'add' }
            : { lineNo: null, sign: '', content: '', kind: 'empty' },
        })
      }
      i = j
    }
  }
  return result
}

// ---- helpers ----

function truncateCode(value: string, maxLines = 220): string {
  const lines = value.split(/\r?\n/)
  if (lines.length <= maxLines) return value
  return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more lines`
}

// ---- sub-components ----

function SplitDiffTable({ rows }: { rows: SbsRow[] }) {
  return (
    <table className="dv-table dv-sbs">
      <tbody>
        {rows.map((row, i) => {
          if (row.type === 'file' || row.type === 'hunk') {
            return (
              <tr className={`dv-row dv-row-${row.type}`} key={i}>
                <td colSpan={6} className="dv-content">
                  <code>{row.spanContent || ''}</code>
                </td>
              </tr>
            )
          }
          const l = row.left!
          const r = row.right!
          return (
            <tr className="dv-row" key={i}>
              <td className="dv-ln">{l.lineNo ?? ''}</td>
              <td className={`dv-sign dv-sign-${l.kind}`}>{l.sign}</td>
              <td className={`dv-content dv-side-${l.kind}`}><code>{l.content || ' '}</code></td>
              <td className="dv-ln dv-ln-right">{r.lineNo ?? ''}</td>
              <td className={`dv-sign dv-sign-${r.kind}`}>{r.sign}</td>
              <td className={`dv-content dv-side-${r.kind}`}><code>{r.content || ' '}</code></td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ---- main component ----

const COLLAPSE_THRESHOLD = 20

export default function DiffView({ change }: { change: CodeChange }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pathCopied, setPathCopied] = useState(false)
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split')

  // Resolve diff string: prefer explicit diff, then generate from old/new strings
  const diffStr = change.diff
    ?? (change.kind === 'patch' && change.oldString != null
      ? buildUnifiedDiff(change.oldString, change.newString ?? '', change.path)
      : null)

  const hasContent = Boolean(diffStr || change.content)
  if (!hasContent) return null

  const diffLines = diffStr ? parseDiff(diffStr) : null
  const stats = diffLines ? diffStats(diffLines) : null
  const totalLines = diffLines
    ? diffLines.length
    : (change.content?.split(/\r?\n/).length ?? 0)
  const isLong = totalLines > COLLAPSE_THRESHOLD
  const visibleLines = diffLines
    ? (expanded ? diffLines : diffLines.slice(0, COLLAPSE_THRESHOLD))
    : null

  function copy() {
    const text = diffStr || change.content || ''
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  function copyPath() {
    navigator.clipboard.writeText(change.path).then(() => {
      setPathCopied(true)
      setTimeout(() => setPathCopied(false), 1500)
    })
  }

  return (
    <section className={`dv-root dv-status-${change.status || 'applied'}`}>
      <header className="dv-header">
        <div className="dv-meta">
          <span className={`dv-dot dv-dot-${change.status || 'applied'}`} />
          <strong className="dv-title">{change.title}</strong>
          <span className="dv-path" title={change.path}>{change.path}</span>
        </div>
        <div className="dv-actions">
          {stats && (stats.added > 0 || stats.removed > 0) && (
            <span className="dv-stats">
              {stats.added > 0 && <span className="dv-stat-add">+{stats.added}</span>}
              {stats.removed > 0 && <span className="dv-stat-rem">-{stats.removed}</span>}
            </span>
          )}
          {diffLines && (
            <button
              className={`dv-btn${viewMode === 'split' ? ' active' : ''}`}
              title={viewMode === 'split' ? 'Switch to unified' : 'Switch to split'}
              onClick={() => setViewMode(m => m === 'split' ? 'unified' : 'split')}
            >
              {viewMode === 'split' ? '⊞' : '≡'}
            </button>
          )}
          <button className="dv-btn" title="Copy diff" onClick={copy}>
            {copied ? '✓' : '⎘'}
          </button>
          <button className="dv-btn" title="Copy file path" onClick={copyPath}>
            {pathCopied ? '✓' : '↗'}
          </button>
        </div>
      </header>

      {visibleLines ? (
        <>
          {viewMode === 'split' ? (
            <SplitDiffTable rows={toSideBySide(visibleLines)} />
          ) : (
            <table className="dv-table">
              <tbody>
                {visibleLines.map((line, i) => (
                  <tr className={`dv-row dv-row-${line.type}`} key={i}>
                    <td className="dv-ln">{line.oldLine ?? ''}</td>
                    <td className="dv-ln">{line.newLine ?? ''}</td>
                    <td className={`dv-sign dv-sign-${line.type}`}>
                      {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''}
                    </td>
                    <td className="dv-content"><code>{line.content || ' '}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {isLong && (
            <button className="dv-expand" onClick={() => setExpanded(e => !e)}>
              {expanded ? '▲ collapse' : `▼ ${totalLines - COLLAPSE_THRESHOLD} more lines`}
            </button>
          )}
        </>
      ) : (
        <pre className="dv-code-view">
          <code>{truncateCode(change.content || '')}</code>
        </pre>
      )}
    </section>
  )
}
