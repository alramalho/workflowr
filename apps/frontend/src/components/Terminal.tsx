import { useState, useRef, useEffect, type JSX } from 'react'
import { TerminalSquare } from 'lucide-react'
import type { CommandResult, ToolStep } from '../types'
import './Terminal.css'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function renderInlineMarkdown(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  // match: markdown links, raw URLs, backtick code, bold, italic
  const re = /(\[([^\]]+)\]\((https?:\/\/[^)]+)\)|(https?:\/\/[^\s)]+)|`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[2] && match[3]) {
      // markdown link [text](url)
      parts.push(<a key={key++} className="terminal-link" href={match[3]} target="_blank" rel="noopener noreferrer">{match[2]}</a>)
    } else if (match[4]) {
      // raw URL
      parts.push(<a key={key++} className="terminal-link" href={match[4]} target="_blank" rel="noopener noreferrer">{match[4]}</a>)
    } else if (match[5]) {
      parts.push(<span key={key++} className="syntax-code">{match[5]}</span>)
    } else if (match[6]) {
      parts.push(<strong key={key++}>{match[6]}</strong>)
    } else {
      parts.push(<em key={key++}>{match[7] ?? match[8]}</em>)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

function renderAsciiTable(tableLines: string[]): JSX.Element {
  const rows = tableLines
    .filter((l) => !l.match(/^\|[\s-:|]+\|$/))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))

  if (rows.length === 0) return <pre className="cmd-ascii-table">{tableLines.join('\n')}</pre>

  const colCount = rows[0].length
  const widths = Array(colCount).fill(0)
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i], stripMarkdown(row[i] ?? '').length)
    }
  }

  const border = (l: string, m: string, r: string) =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r

  const renderRow = (row: string[], isHeader: boolean) => {
    const cells = row.map((cell, i) => {
      const plain = stripMarkdown(cell)
      const content = cell + ' '.repeat(Math.max(0, widths[i] - plain.length))
      return ` ${content} `
    })

    return (
      <span className={isHeader ? 'table-header' : ''}>{'│'}{cells.map((c, i) => <span key={i}>{renderInlineMarkdown(c)}{i < cells.length - 1 ? '│' : ''}</span>)}{'│'}</span>
    )
  }

  return (
    <pre className="cmd-ascii-table">
      {border('┌', '┬', '┐')}{'\n'}
      {renderRow(rows[0], true)}{'\n'}
      {border('├', '┼', '┤')}{'\n'}
      {rows.slice(1).map((row, i) => (
        <span key={i}>{renderRow(row, false)}{'\n'}</span>
      ))}
      {border('└', '┴', '┘')}
    </pre>
  )
}

function renderOutput(text: string): JSX.Element {
  const lines = text.replace(/<br\s*\/?>/gi, '\n').split('\n')
  const elements: JSX.Element[] = []
  let i = 0

  while (i < lines.length) {
    if (lines[i].startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      elements.push(<span key={`table-${i}`}>{renderAsciiTable(tableLines)}</span>)
    } else {
      elements.push(
        <div key={i} className="cmd-output-line">
          {renderInlineMarkdown(lines[i])}
        </div>
      )
      i++
    }
  }

  return <>{elements}</>
}

const COMMANDS = new Set(['/clear'])

function highlightCommand(text: string): JSX.Element {
  const parts = text.split(/(\s+)/)
  const cmd = parts[0]
  const isBuiltin = COMMANDS.has(cmd)

  return (
    <>
      <span className={isBuiltin ? 'syntax-cmd' : ''}>{cmd}</span>
      {parts.slice(1).map((part, i) => {
        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>
        // quoted strings
        if (/^["'].*["']$/.test(part)) return <span key={i} className="syntax-string">{part}</span>
        // paths (contain / or end in .mdx)
        if (part.includes('/') || part.endsWith('.mdx')) return <span key={i} className="syntax-path">{part}</span>
        return <span key={i} className="syntax-arg">{part}</span>
      })}
    </>
  )
}

function formatToolLabel(step: ToolStep): string {
  const input = typeof step.input === 'string'
    ? step.input
    : typeof step.input === 'object' && step.input
      ? Object.values(step.input as Record<string, unknown>).filter(v => typeof v === 'string').join(' ')
      : ''
  return `${step.name}${input ? ` ${input}` : ''}`
}

function stringify(val: unknown): string {
  if (typeof val === 'string') return val
  try { return JSON.stringify(val, null, 2) } catch { return String(val) }
}

function ToolStepLine({ step }: { step: ToolStep }) {
  const [expanded, setExpanded] = useState(false)
  const details = [
    step.input ? `input: ${stringify(step.input)}` : null,
    step.output ? `output: ${stringify(step.output)}` : null,
  ].filter(Boolean).join('\n\n')

  return (
    <div className="tool-step">
      <span className="tool-step-label" onClick={() => setExpanded(!expanded)}>
        ↳ {formatToolLabel(step)}
      </span>
      {expanded && details && (
        <pre className="tool-step-output">{details}</pre>
      )}
    </div>
  )
}

export function Terminal({
  history,
  onCommand,
  loading,
  pendingCommand,
  liveToolSteps,
  liveStatus,
  onClose,
}: {
  history: CommandResult[]
  onCommand: (cmd: string) => void
  loading: boolean
  pendingCommand: string | null
  liveToolSteps: ToolStep[]
  liveStatus: string | null
  onClose?: () => void
}) {
  const [input, setInput] = useState('')
  const [cmdHistory, setCmdHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [history, loading, pendingCommand, liveToolSteps, liveStatus])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = inputRef.current.scrollHeight + 'px'
    }
  }, [input])

  const submit = () => {
    const cmd = input.trim()
    if (!cmd || loading) return
    setCmdHistory((prev) => [cmd, ...prev])
    setHistoryIdx(-1)
    onCommand(cmd)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (cmdHistory.length > 0) {
        const next = Math.min(historyIdx + 1, cmdHistory.length - 1)
        setHistoryIdx(next)
        setInput(cmdHistory[next])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIdx > 0) {
        const next = historyIdx - 1
        setHistoryIdx(next)
        setInput(cmdHistory[next])
      } else {
        setHistoryIdx(-1)
        setInput('')
      }
    }
  }

  return (
    <div className="terminal" onClick={() => inputRef.current?.focus()}>
      <div className="terminal-header">
        <TerminalSquare size={13} />
        <span>terminal</span>
        {onClose && <button className="terminal-close" onClick={onClose}>&times;</button>}
      </div>
      <div className="terminal-output" ref={scrollRef}>
        {history.map((r) => (
          <div key={r.id} className="cmd-entry">
            <div className="cmd-line">
              <span className="cmd-prompt">$</span>
              <span className="cmd-text">{highlightCommand(r.command)}</span>
              {r.durationMs != null && (
                <span className="cmd-duration">{formatDuration(r.durationMs)}</span>
              )}
            </div>
            {r.toolSteps?.map((step, i) => (
              <ToolStepLine key={i} step={step} />
            ))}
            {r.toolSteps?.length ? (
              <div className="cmd-response">
                <img src="/workflowr_icon.png" className="response-icon" alt="" />
                <div className="cmd-output">{renderOutput(r.output)}</div>
              </div>
            ) : (
              <div className="cmd-output">{renderOutput(r.output)}</div>
            )}
          </div>
        ))}
        {pendingCommand && (
          <div className="cmd-entry">
            <div className="cmd-line">
              <span className="cmd-prompt">$</span>
              <span className="cmd-text">{pendingCommand}</span>
            </div>
            {liveToolSteps.map((step, i) => (
              <ToolStepLine key={i} step={step} />
            ))}
            {liveStatus && <span className="cmd-loading">{liveStatus}</span>}
          </div>
        )}
      </div>
      <div className="terminal-input" onClick={() => inputRef.current?.focus()}>
        <span className="cmd-prompt">$</span>
        <div className="input-wrapper">
          <div className="input-highlight" aria-hidden>
            {input ? <>{highlightCommand(input)}{'\u00a0'}</> : <span className="input-placeholder">{loading ? 'running...' : 'ask a question...'}</span>}
          </div>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            autoFocus
            rows={1}
          />
        </div>
      </div>
    </div>
  )
}
