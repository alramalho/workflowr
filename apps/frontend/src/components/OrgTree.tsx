import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Square, Diamond, Triangle, Circle, GitBranch, Users, UserX } from 'lucide-react'
import type { OrgData, OrgMember, TreeNode } from '../types'
import './OrgTree.css'

function buildTree(members: OrgMember[]): TreeNode[] {
  const bySlackId = new Map(members.map((m) => [m.slackId, m]))
  const childrenOf = new Map<string | null, OrgMember[]>()

  for (const m of members) {
    const parentKey = m.reportsTo && bySlackId.has(m.reportsTo) ? m.reportsTo : null
    const list = childrenOf.get(parentKey) ?? []
    list.push(m)
    childrenOf.set(parentKey, list)
  }

  function build(parentId: string | null): TreeNode[] {
    const kids = childrenOf.get(parentId) ?? []
    return kids.map((m) => ({
      member: m,
      children: build(m.slackId),
    }))
  }

  return build(null)
}

function getVisibleMembers(nodes: TreeNode[], collapsed: Set<string>): OrgMember[] {
  const result: OrgMember[] = []
  for (const node of nodes) {
    result.push(node.member)
    if (!collapsed.has(node.member.slackId)) {
      result.push(...getVisibleMembers(node.children, collapsed))
    }
  }
  return result
}

function describeView(data: OrgData, tree: TreeNode[], collapsed: Set<string>): string {
  const visible = getVisibleMembers(tree, collapsed)
  const collapsedNames = [...collapsed]
    .map((id) => data.members.find((m) => m.slackId === id)?.name)
    .filter(Boolean)

  const lines: string[] = []
  lines.push(`Viewing org: ${data.orgs[0]?.name ?? 'unknown'}`)
  lines.push(`${visible.length} of ${data.members.filter(m => !m.isExternal).length} people visible in hierarchy`)

  if (collapsedNames.length > 0) {
    lines.push(`Collapsed (subordinates hidden): ${collapsedNames.join(', ')}`)
  }

  lines.push('')
  lines.push('Currently visible hierarchy:')
  function walk(nodes: TreeNode[], indent: string) {
    for (const n of nodes) {
      const m = n.member
      const role = m.role ? ` — ${m.role}` : ''
      const teams = m.teams.length ? ` [${m.teams.join(', ')}]` : ''
      const isCollapsed = collapsed.has(m.slackId)
      const suffix = isCollapsed && n.children.length ? ` (+${n.children.length} hidden)` : ''
      lines.push(`${indent}${m.name}${role}${teams}${suffix}`)
      if (!isCollapsed) walk(n.children, indent + '  ')
    }
  }
  walk(tree, '  ')

  if (data.orgs[0]?.teams.length) {
    lines.push('')
    lines.push('Teams:')
    for (const t of data.orgs[0].teams) {
      lines.push(`  ${t.name}: ${t.members.map(m => m.name).join(', ')}`)
    }
  }

  const externals = data.members.filter(m => m.isExternal)
  if (externals.length) {
    lines.push('')
    lines.push(`External: ${externals.map(m => m.name).join(', ')}`)
  }

  return lines.join('\n')
}

interface TreeNodeViewProps {
  node: TreeNode
  isLast: boolean
  depth: number
  collapsed: Set<string>
  onToggle: (slackId: string) => void
}

function TreeNodeView({ node, isLast, depth, collapsed, onToggle }: TreeNodeViewProps) {
  const m = node.member
  const hasChildren = node.children.length > 0
  const isCollapsed = collapsed.has(m.slackId)

  return (
    <li className={`tree-item ${isLast ? 'last' : ''} ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="tree-line">
        <span className="tree-branch" />
        <span className="tree-node-dot">
          {hasChildren ? (isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />) : <Square size={6} fill="currentColor" />}
        </span>
      </div>
      <div className="tree-content">
        <div
          className={`tree-person ${hasChildren ? 'clickable' : ''}`}
          onClick={hasChildren ? () => onToggle(m.slackId) : undefined}
        >
          <span className="person-name">{m.name}</span>
          {m.role && <span className="person-role">{m.role}</span>}
          {m.isExternal && <span className="person-tag external">ext</span>}
          {hasChildren && isCollapsed && (
            <span className="collapse-count">{node.children.length}</span>
          )}
        </div>
        {m.teams.length > 0 && (
          <div className="person-teams">
            {m.teams.map((t) => (
              <span key={t} className="team-badge">{t}</span>
            ))}
          </div>
        )}
        {hasChildren && !isCollapsed && (
          <ul className="tree-children">
            {node.children.map((child, i) => (
              <TreeNodeView
                key={child.member.slackId}
                node={child}
                isLast={i === node.children.length - 1}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

export function OrgTree({ data, onViewChange }: { data: OrgData; onViewChange?: (description: string) => void }) {
  const tree = useMemo(() => buildTree(data.members.filter((m) => !m.isExternal)), [data])
  const externals = data.members.filter((m) => m.isExternal)
  const org = data.orgs[0]
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const onViewChangeRef = useRef(onViewChange)
  onViewChangeRef.current = onViewChange

  const toggle = useCallback((slackId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(slackId)) next.delete(slackId)
      else next.add(slackId)
      return next
    })
  }, [])

  useEffect(() => {
    onViewChangeRef.current?.(describeView(data, tree, collapsed))
  }, [data, tree, collapsed])

  return (
    <div className="org-tree">
      {org && (
        <div className="org-header">
          <div className="org-name-row">
            <Diamond size={14} className="org-diamond" />
            <h2 className="org-name">{org.name}</h2>
          </div>
          {org.description && <p className="org-desc">{org.description}</p>}
          <div className="org-stats">
            <span className="stat"><Users size={12} /> {data.members.filter(m => !m.isExternal).length} people</span>
            <span className="stat"><Triangle size={10} fill="currentColor" /> {org.teams.length} teams</span>
            {externals.length > 0 && <span className="stat"><UserX size={12} /> {externals.length} external</span>}
          </div>
          <div className="org-meta">
            {org.industry && <span>{org.industry}</span>}
            {org.location && <span>{org.location}</span>}
            {org.url && <span>{org.url}</span>}
          </div>
        </div>
      )}

      <div className="tree-section">
        <div className="section-label">
          <GitBranch size={12} className="tick" /> hierarchy
        </div>
        <ul className="tree-root">
          {tree.map((node, i) => (
            <TreeNodeView
              key={node.member.slackId}
              node={node}
              isLast={i === tree.length - 1}
              depth={0}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ))}
        </ul>
      </div>

      {org && org.teams.length > 0 && (
        <div className="tree-section">
          <div className="section-label">
            <Users size={12} className="tick" /> teams
          </div>
          <div className="teams-grid">
            {org.teams.map((team) => (
              <div key={team.id} className="team-card">
                <div className="team-card-header">
                  <Triangle size={10} fill="currentColor" className="team-diamond" />
                  <span className="team-card-name">{team.name}</span>
                  {team.tools.length > 0 && (
                    <span className="team-tools">{team.tools.join(', ')}</span>
                  )}
                </div>
                <div className="team-card-members">
                  {team.members.map((tm) => (
                    <div key={tm.slackId} className="team-member-row">
                      <Square size={6} fill="currentColor" className="tm-dot" />
                      <span className="tm-name">{tm.name}</span>
                      {tm.role && <span className="tm-role">{tm.role}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {externals.length > 0 && (
        <div className="tree-section">
          <div className="section-label">
            <UserX size={12} className="tick" /> external
          </div>
          <div className="externals-list">
            {externals.map((m) => (
              <div key={m.slackId} className="external-row">
                <Circle size={8} className="ext-dot" />
                <span className="ext-name">{m.name}</span>
                {m.role && <span className="ext-role">{m.role}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
