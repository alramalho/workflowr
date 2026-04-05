import { useState, useRef, useEffect } from 'react'
import { Minimize2, X, Maximize2, ArrowUpRight, ArrowDownLeft } from 'lucide-react'
import Markdown from 'react-markdown'
import './ChatPanel.css'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3847'

interface ChatPanelProps {
  viewDescription: string
  expanded?: boolean
  onExpand: () => void
  onCollapse: () => void
}

export function ChatPanel({ viewDescription, expanded, onExpand, onCollapse }: ChatPanelProps) {
  const [open, setOpen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const viewRef = useRef(viewDescription)
  viewRef.current = viewDescription

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if ((open || expanded) && !minimized) inputRef.current?.focus()
  }, [open, expanded, minimized])

  async function send() {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: Message = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          viewDescription: viewRef.current,
        }),
      })
      const data = await res.json()
      setMessages([...newMessages, { role: 'assistant', content: data.message ?? data.error ?? 'No response' }])
    } catch {
      setMessages([...newMessages, { role: 'assistant', content: 'Failed to reach workflowr.' }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function handleClose() {
    setOpen(false)
    if (expanded) onCollapse()
  }

  const chatBody = (
    <>
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <img src="/workflowr_icon.png" alt="" className="empty-icon" />
            <p className="empty-title">Ask workflowr</p>
            <p className="empty-sub">I can see the org tree. Ask me anything about it.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg ${msg.role}`}>
            {msg.role === 'assistant' && <span className="msg-avatar">▲</span>}
            <div className="msg-bubble">
              {msg.role === 'assistant' ? <Markdown>{msg.content}</Markdown> : msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="chat-msg assistant">
            <span className="msg-avatar">▲</span>
            <div className="msg-bubble"><span className="typing-dot" /></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder="Ask workflowr..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button className="chat-send" onClick={send} disabled={!input.trim() || loading}>
          ↑
        </button>
      </div>
    </>
  )

  // Expanded: inline side panel
  if (expanded) {
    return (
      <div className="chat-side-panel">
        <div className="chat-header">
          <img src="/workflowr_icon.png" alt="" className="chat-header-icon" />
          <span className="chat-title">workflowr</span>
          <div className="chat-controls">
            <button onClick={onCollapse} className="ctrl-btn" title="Collapse to widget"><ArrowDownLeft size={13} /></button>
            <button onClick={handleClose} className="ctrl-btn" title="Close"><X size={14} /></button>
          </div>
        </div>
        {chatBody}
      </div>
    )
  }

  // Floating: FAB
  if (!open) {
    return (
      <button className="chat-fab" onClick={() => setOpen(true)}>
        <img src="/workflowr_icon.png" alt="" className="fab-icon" />
        <span>Ask workflowr</span>
      </button>
    )
  }

  // Floating: minimized
  if (minimized) {
    return (
      <div className="chat-panel minimized" onClick={() => setMinimized(false)}>
        <div className="chat-header">
          <img src="/workflowr_icon.png" alt="" className="chat-header-icon" />
          <span className="chat-title">workflowr</span>
          <div className="chat-controls">
            <button onClick={(e) => { e.stopPropagation(); setMinimized(false) }} className="ctrl-btn" title="Expand"><Maximize2 size={13} /></button>
            <button onClick={(e) => { e.stopPropagation(); handleClose() }} className="ctrl-btn" title="Close"><X size={14} /></button>
          </div>
        </div>
      </div>
    )
  }

  // Floating: open
  return (
    <div className="chat-panel">
      <div className="chat-header">
        <img src="/workflowr_icon.png" alt="" className="chat-header-icon" />
        <span className="chat-title">workflowr</span>
        <div className="chat-controls">
          <button onClick={() => { onExpand(); setOpen(false) }} className="ctrl-btn" title="Expand to side panel"><ArrowUpRight size={13} /></button>
          <button onClick={() => setMinimized(true)} className="ctrl-btn" title="Minimize"><Minimize2 size={13} /></button>
          <button onClick={handleClose} className="ctrl-btn" title="Close"><X size={14} /></button>
        </div>
      </div>
      {chatBody}
    </div>
  )
}
