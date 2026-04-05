export interface OrgTree {
  tree: string[]
  files: Record<string, string>
}

export interface ToolStep {
  name: string
  input: unknown
  output: string
}

export interface CommandResult {
  id: string
  command: string
  output: string
  toolSteps?: ToolStep[]
  timestamp: number
  durationMs?: number
}
