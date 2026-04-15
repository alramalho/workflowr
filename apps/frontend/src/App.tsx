import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Panel, Group, Separator } from 'react-resizable-panels'
import './App.css'
import { FileTree } from './components/FileTree'
import { FileViewer } from './components/FileViewer'
import { TabBar } from './components/TabBar'
import { Terminal } from './components/Terminal'
import type { OrgTree, CommandResult, ToolStep } from './types'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3847'

function App() {
  const [data, setData] = useState<OrgTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tabs, setTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [history, setHistory] = useState<CommandResult[]>([])
  const [cmdLoading, setCmdLoading] = useState(false)
  const [pendingCommand, setPendingCommand] = useState<string | null>(null)
  const [liveToolSteps, setLiveToolSteps] = useState<ToolStep[]>([])
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])

  useEffect(() => {
    fetch(`${API_URL}/api/org-tree`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: OrgTree) => {
        setData(d)
        if (d.files['overview.mdx']) {
          setTabs(['overview.mdx'])
          setActiveTab('overview.mdx')
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Cmd+W to close active tab
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        if (activeTab) closeTab(activeTab)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeTab, tabs])

  const openTab = useCallback((path: string, newTab: boolean) => {
    if (newTab || !tabs.includes(path)) {
      setTabs((prev) => prev.includes(path) ? prev : [...prev, path])
    }
    setActiveTab(path)
  }, [tabs])

  const closeTab = useCallback((path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t !== path)
      if (activeTab === path) {
        const idx = prev.indexOf(path)
        const newActive = next[Math.min(idx, next.length - 1)] ?? null
        setActiveTab(newActive)
      }
      return next
    })
  }, [activeTab])

  const handleSelect = useCallback((path: string, metaKey: boolean) => {
    openTab(path, metaKey)
  }, [openTab])

  const handleCommand = useCallback(async (cmd: string) => {
    if (!data) return
    setCmdLoading(true)
    setPendingCommand(cmd)

    const id = Date.now().toString()
    cmdStartTime.current = Date.now()
    const trimmed = cmd.trim()

    if (trimmed === '/clear') {
      setHistory([])
      setChatMessages([])
      setPendingCommand(null)
      setCmdLoading(false)
      return
    }

    setLiveToolSteps([])
    setLiveStatus('thinking...')
    const updatedMessages = [...chatMessages, { role: 'user' as const, content: cmd }]
    setChatMessages(updatedMessages)
    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: updatedMessages,
          viewDescription: activeTab ? `User is viewing: ${activeTab}` : '',
        }),
      })

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let collectedTools: ToolStep[] = []

      if (reader) {
        while (true) {
          const { done: streamDone, value } = await reader.read()
          if (streamDone) break
          buffer += decoder.decode(value, { stream: true })

          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''

          let eventType = ''
          for (const line of parts) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7)
            } else if (line.startsWith('data: ') && eventType) {
              const payload = JSON.parse(line.slice(6))
              if (eventType === 'status') {
                setLiveStatus(payload.status)
              } else if (eventType === 'tool') {
                const steps: ToolStep[] = (payload.tools ?? []).map((t: any) => ({
                  name: t.name, input: t.input, output: t.output,
                }))
                collectedTools = [...collectedTools, ...steps]
                setLiveToolSteps([...collectedTools])
                setLiveStatus(null)
              } else if (eventType === 'done') {
                setLiveToolSteps([])
                setLiveStatus(null)
                const responseText = payload.text ?? 'No response'
                setChatMessages((prev) => [...prev, { role: 'assistant', content: responseText }])
                addResult(id, cmd, responseText, collectedTools)
              } else if (eventType === 'error') {
                setLiveToolSteps([])
                setLiveStatus(null)
                addResult(id, cmd, payload.error ?? 'Error')
              }
              eventType = ''
            }
          }
        }
      }
    } catch (e: any) {
      setLiveToolSteps([])
      setLiveStatus(null)
      addResult(id, cmd, `Error: ${e.message}`)
    }
    setCmdLoading(false)
  }, [data, activeTab, openTab, chatMessages])

  const cmdStartTime = useRef(0)
  const addResult = (id: string, command: string, output: string, toolSteps?: ToolStep[]) => {
    setPendingCommand(null)
    setHistory((prev) => [...prev, { id, command, output, toolSteps, timestamp: Date.now(), durationMs: Date.now() - cmdStartTime.current }])
  }

  if (loading) {
    return <div className="app loading-screen"><span className="pixel-spinner" /></div>
  }
  if (error) {
    return <div className="app loading-screen error">Failed to load: {error}</div>
  }
  if (!data || Object.keys(data.files).length === 0) {
    return <div className="app loading-screen dim">No org data yet. Run /setup-workflowr in Slack.</div>
  }

  const slackIdMap = useMemo(() => {
    const map = new Map<string, { name: string; path: string }>()
    if (!data) return map
    for (const [path, content] of Object.entries(data.files)) {
      if (!path.startsWith('people/')) continue
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue
      const nameM = fmMatch[1].match(/^name:\s*(.+)$/m)
      const slackM = fmMatch[1].match(/^slack_id:\s*(.+)$/m)
      if (nameM && slackM) {
        map.set(slackM[1].trim(), { name: nameM[1].trim(), path })
      }
    }
    return map
  }, [data])

  const activeContent = activeTab ? data.files[activeTab] : null

  return (
    <div className="app">
      <Group orientation="horizontal" id="main-layout">
        <Panel defaultSize={20} minSize={15} id="tree-panel">
          <FileTree
            files={data.files}
            selectedPath={activeTab}
            onSelect={handleSelect}
          />
        </Panel>
        <Separator className="resize-handle" />
        <Panel defaultSize={80} minSize={40} id="right-panel">
          <Group orientation="vertical" id="right-layout">
            <Panel defaultSize={65} minSize={20} id="viewer-panel">
              <div className="viewer-container">
                {tabs.length > 0 && (
                  <TabBar
                    tabs={tabs}
                    activeTab={activeTab}
                    onSelect={setActiveTab}
                    onClose={closeTab}
                  />
                )}
                <div className="viewer-body">
                  {activeContent ? (
                    <FileViewer path={activeTab!} content={activeContent} onNavigate={(p) => openTab(p, true)} slackIdMap={slackIdMap} />
                  ) : (
                    <div className="empty-viewer">
                      <span>Select a file to view</span>
                    </div>
                  )}
                </div>
              </div>
            </Panel>
            <Separator className="resize-handle-h" />
            <Panel defaultSize={35} minSize={15} id="terminal-panel">
              <Terminal
                history={history}
                onCommand={handleCommand}
                loading={cmdLoading}
                pendingCommand={pendingCommand}
                liveToolSteps={liveToolSteps}
                liveStatus={liveStatus}
              />
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  )
}

export default App
