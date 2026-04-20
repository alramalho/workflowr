import { useEffect, useState, useMemo, useRef } from 'react'
import { Command } from 'cmdk'
import { FileText, Folder, MessageSquare } from 'lucide-react'
import './CommandPalette.css'

export function CommandPalette({
  files,
  onSelect,
  onAskAI,
  open,
  onOpenChange,
}: {
  files: Record<string, string>
  onSelect: (path: string) => void
  onAskAI: (query: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  const items = useMemo(() => {
    const people: string[] = []
    const teams: string[] = []
    const other: string[] = []
    for (const path of Object.keys(files)) {
      if (path.startsWith('people/')) people.push(path)
      else if (path.startsWith('teams/')) teams.push(path)
      else other.push(path)
    }
    return { people: people.sort(), teams: teams.sort(), other: other.sort() }
  }, [files])

  const label = (path: string) => {
    const name = path.split('/').pop()?.replace(/\.mdx?$/, '') ?? path
    return name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }

  const listRef = useRef<HTMLDivElement>(null)

  const handleAskAI = () => {
    if (!search.trim()) return
    onAskAI(search.trim())
    onOpenChange(false)
  }

  const hasVisibleItems = () => {
    if (!listRef.current) return false
    return listRef.current.querySelectorAll('[cmdk-item]').length > 0
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && search.trim() && !hasVisibleItems()) {
      e.preventDefault()
      handleAskAI()
    }
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search files"
      className="cmd-dialog"
      onKeyDown={handleKeyDown}
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder="Search or ask AI..."
        className="cmd-input"
      />
      <Command.List className="cmd-list" ref={listRef}>
        <Command.Empty className="cmd-empty-hidden" />

        {items.people.length > 0 && (
          <Command.Group heading="People" className="cmd-group">
            {items.people.map((path) => (
              <Command.Item
                key={path}
                value={path}
                onSelect={() => { onSelect(path); onOpenChange(false) }}
                className="cmd-item"
              >
                <FileText size={14} />
                <span>{label(path)}</span>
                <span className="cmd-path">{path}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {items.teams.length > 0 && (
          <Command.Group heading="Teams" className="cmd-group">
            {items.teams.map((path) => (
              <Command.Item
                key={path}
                value={path}
                onSelect={() => { onSelect(path); onOpenChange(false) }}
                className="cmd-item"
              >
                <Folder size={14} />
                <span>{label(path)}</span>
                <span className="cmd-path">{path}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {items.other.length > 0 && (
          <Command.Group heading="Files" className="cmd-group">
            {items.other.map((path) => (
              <Command.Item
                key={path}
                value={path}
                onSelect={() => { onSelect(path); onOpenChange(false) }}
                className="cmd-item"
              >
                <FileText size={14} />
                <span>{label(path)}</span>
                <span className="cmd-path">{path}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>

      {search.trim() && (
        <div className="cmd-ai-footer" onClick={handleAskAI}>
          <MessageSquare size={14} />
          <span>Ask AI: {search}</span>
          <span className="cmd-path">enter</span>
        </div>
      )}
    </Command.Dialog>
  )
}
