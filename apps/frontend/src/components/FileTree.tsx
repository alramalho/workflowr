import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { ChevronRight, ChevronDown, FileText, Folder } from 'lucide-react'
import './FileTree.css'

interface TreeEntry {
  name: string
  path: string
  isDir: boolean
  depth: number
  children?: TreeEntry[]
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function buildEntries(files: Record<string, string>): TreeEntry[] {
  const dirs = new Map<string, TreeEntry>()
  const root: TreeEntry[] = []

  const getOrCreateDir = (path: string, depth: number): TreeEntry => {
    if (dirs.has(path)) return dirs.get(path)!
    const parts = path.split('/')
    const name = parts[parts.length - 1]
    const entry: TreeEntry = { name, path, isDir: true, depth, children: [] }
    dirs.set(path, entry)

    if (parts.length === 1) {
      root.push(entry)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      const parent = getOrCreateDir(parentPath, depth - 1)
      parent.children!.push(entry)
    }
    return entry
  }

  for (const filePath of Object.keys(files).sort()) {
    const parts = filePath.split('/')
    const fileName = parts[parts.length - 1]
    const depth = parts.length - 1

    if (parts.length === 1) {
      root.push({ name: fileName, path: filePath, isDir: false, depth: 0 })
    } else {
      const dirPath = parts.slice(0, -1).join('/')
      const parent = getOrCreateDir(dirPath, depth - 1)
      parent.children!.push({ name: fileName, path: filePath, isDir: false, depth })
    }
  }

  return sortEntries(root)
}

function flattenVisible(entries: TreeEntry[], expanded: Set<string>): TreeEntry[] {
  const result: TreeEntry[] = []
  const walk = (items: TreeEntry[]) => {
    for (const entry of sortEntries([...items])) {
      result.push(entry)
      if (entry.isDir && expanded.has(entry.path) && entry.children) {
        walk(entry.children)
      }
    }
  }
  walk(entries)
  return result
}

export function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: Record<string, string>
  selectedPath: string | null
  onSelect: (path: string, metaKey: boolean) => void
}) {
  const entries = useMemo(() => buildEntries(files), [files])

  // expand top-level dirs by default
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    entries.forEach((e) => { if (e.isDir) initial.add(e.path) })
    return initial
  })
  const [focusIdx, setFocusIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => flattenVisible(entries, expanded), [entries, expanded])

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleClick = useCallback((entry: TreeEntry, idx: number, metaKey: boolean) => {
    setFocusIdx(idx)
    if (entry.isDir) {
      toggleDir(entry.path)
    } else {
      onSelect(entry.path, metaKey)
    }
  }, [toggleDir, onSelect])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx((i) => Math.min(i + 1, visible.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = visible[focusIdx]
      if (!entry) return
      if (entry.isDir) {
        toggleDir(entry.path)
      } else {
        onSelect(entry.path, e.metaKey || e.ctrlKey)
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const entry = visible[focusIdx]
      if (entry?.isDir && !expanded.has(entry.path)) {
        toggleDir(entry.path)
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const entry = visible[focusIdx]
      if (entry?.isDir && expanded.has(entry.path)) {
        toggleDir(entry.path)
      }
    }
  }, [visible, focusIdx, expanded, toggleDir, onSelect])

  // scroll focused entry into view
  useEffect(() => {
    const el = containerRef.current?.querySelector(`[data-idx="${focusIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusIdx])

  // auto-focus on mount
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  return (
    <div className="file-tree" tabIndex={0} onKeyDown={handleKeyDown} ref={containerRef}>
      <div className="tree-header">
        <Folder size={14} />
        <span>org/</span>
      </div>
      <div className="tree-entries">
        {visible.map((entry, idx) => {
          const isSelected = selectedPath === entry.path
          const isFocused = focusIdx === idx
          const isExpanded = entry.isDir && expanded.has(entry.path)

          return (
            <div
              key={entry.path}
              className={`tree-entry${isSelected ? ' selected' : ''}${isFocused ? ' focused' : ''}`}
              style={{ paddingLeft: entry.depth * 16 + 8 }}
              onClick={(e) => handleClick(entry, idx, e.metaKey || e.ctrlKey)}
              data-idx={idx}
            >
              <span className="tree-icon">
                {entry.isDir ? (
                  isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                ) : (
                  <FileText size={14} />
                )}
              </span>
              <span className="tree-name">{entry.name}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
