import './FileViewer.css'

type SlackIdMap = Map<string, { name: string; path: string }>

function renderFmValue(
  key: string,
  value: string,
  onNavigate: (path: string) => void,
  slackIdMap: SlackIdMap,
): JSX.Element {
  const trimmed = value.trim()

  if (key === 'reports_to' && /^U[A-Z0-9]+$/.test(trimmed)) {
    const person = slackIdMap.get(trimmed)
    if (person) {
      return <span className="mdx-link" onClick={(e) => { e.stopPropagation(); onNavigate(person.path) }}>{person.name}</span>
    }
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const items = JSON.parse(trimmed) as string[]
      if (Array.isArray(items) && items.every((i) => typeof i === 'string')) {
        return (
          <>
            {items.map((item, i) => {
              if (key === 'teams') {
                const slug = item.toLowerCase().replace(/\s+/g, '-')
                const path = `teams/${slug}.mdx`
                return <span key={i}>{i > 0 && ', '}<span className="mdx-link" onClick={(e) => { e.stopPropagation(); onNavigate(path) }}>{item}</span></span>
              }
              return <span key={i}>{i > 0 && ', '}{item}</span>
            })}
          </>
        )
      }
    } catch { /* fall through */ }
  }

  return <>{trimmed}</>
}

function renderMdx(content: string, onNavigate: (path: string) => void, slackIdMap: SlackIdMap): JSX.Element[] {
  const lines = content.split('\n')
  const elements: JSX.Element[] = []
  let inFrontmatter = false
  let frontmatterLines: string[] = []
  let inTable = false
  let tableRows: string[][] = []

  const flushTable = () => {
    if (tableRows.length === 0) return
    elements.push(
      <table key={`table-${elements.length}`} className="mdx-table">
        <thead>
          <tr>
            {tableRows[0].map((cell, i) => <th key={i}>{renderInline(cell.trim(), onNavigate)}</th>)}
          </tr>
        </thead>
        <tbody>
          {tableRows.slice(2).map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => <td key={j}>{renderInline(cell.trim(), onNavigate)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    )
    tableRows = []
    inTable = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (i === 0 && line === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line === '---') {
        inFrontmatter = false
        elements.push(
          <div key="frontmatter" className="mdx-frontmatter">
            {frontmatterLines.map((l, j) => {
              const [key, ...rest] = l.split(':')
              const rawValue = rest.join(':').trim()
              return (
                <div key={j} className="fm-row">
                  <span className="fm-key">{key.trim()}</span>
                  <span className="fm-val">{renderFmValue(key.trim(), rawValue, onNavigate, slackIdMap)}</span>
                </div>
              )
            })}
          </div>
        )
        continue
      }
      frontmatterLines.push(line)
      continue
    }

    // table
    if (line.startsWith('|')) {
      if (!inTable) inTable = true
      const cells = line.split('|').slice(1, -1)
      tableRows.push(cells)
      continue
    } else if (inTable) {
      flushTable()
    }

    if (line === '') {
      elements.push(<div key={i} className="mdx-spacer" />)
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="mdx-h2">{line.slice(3)}</h2>)
    } else if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="mdx-h1">{line.slice(2)}</h1>)
    } else if (line.startsWith('- ')) {
      elements.push(<div key={i} className="mdx-list-item">{renderInline(line.slice(2), onNavigate)}</div>)
    } else {
      elements.push(<p key={i} className="mdx-p">{renderInline(line, onNavigate)}</p>)
    }
  }

  if (inTable) flushTable()
  return elements
}

function resolveLinkPath(href: string): string | null {
  // @people/alex.mdx or @teams/ai.mdx → people/alex.mdx
  const cleaned = href.replace(/^@/, '')
  if (cleaned.endsWith('.mdx')) return cleaned
  return null
}

function renderInline(text: string, onNavigate: (path: string) => void): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  const linkRe = /\[([^\]]*)\]\(([^)]*)\)|\[(@[^\]]+\.mdx)\]/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = linkRe.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[3]) {
      // bare link [@teams/ai.mdx]
      const path = match[3].replace(/^@/, '')
      const label = path.split('/').pop()?.replace('.mdx', '') ?? path
      parts.push(
        <span key={match.index} className="mdx-link" onClick={(e) => { e.stopPropagation(); onNavigate(path) }}>{label}</span>
      )
    } else {
      const label = match[1] || match[2]
      const path = resolveLinkPath(match[2])
      if (path) {
        parts.push(
          <span key={match.index} className="mdx-link" onClick={(e) => { e.stopPropagation(); onNavigate(path) }}>{label}</span>
        )
      } else {
        parts.push(<span key={match.index} className="mdx-link">{label}</span>)
      }
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function FileViewer({
  path,
  content,
  onNavigate,
  slackIdMap = new Map(),
}: {
  path: string
  content: string
  onNavigate: (path: string) => void
  slackIdMap?: SlackIdMap
}) {
  return (
    <div className="file-viewer">
      <div className="viewer-header">
        <span className="viewer-path">{path}</span>
      </div>
      <div className="viewer-content">
        {renderMdx(content, onNavigate, slackIdMap)}
      </div>
    </div>
  )
}
