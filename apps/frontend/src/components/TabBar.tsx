import { X } from 'lucide-react'
import './TabBar.css'

export function TabBar({
  tabs,
  activeTab,
  onSelect,
  onClose,
}: {
  tabs: string[]
  activeTab: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
}) {
  return (
    <div className="tab-bar">
      {tabs.map((path) => {
        const name = path.split('/').pop() ?? path
        const isActive = path === activeTab
        return (
          <div
            key={path}
            className={`tab${isActive ? ' active' : ''}`}
            onClick={() => onSelect(path)}
            title={path}
          >
            <span className="tab-name">{name}</span>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onClose(path) }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
