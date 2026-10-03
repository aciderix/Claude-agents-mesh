export type MeshAgent = {
  id: string
  label: string
  status: string
  online: boolean
  isMe: boolean
  ageSeconds: number | null
  lastQuotaEvent: string | null
}

export type MeshTask = {
  id: string
  title: string
  status: string
  priority: number
  assigneeId: string | null
  creatorId: string | null
  files: string[]
  leaseExpired: boolean | null
}

export type MeshMessage = {
  id: string
  fromId: string | null
  type: string
  text: string
  createdAt: string
  taskId: string | null
}

export type MeshQuota = { kind: string; percentUsed: number; resetsAt: string | null }

export type MeshSnapshot = {
  server: string | null
  me: string | null
  agents: MeshAgent[]
  tasks: MeshTask[]
  messages: MeshMessage[]
  quota: MeshQuota[]
  error: string | null
  updatedAt: number
}

export type MeshQuotaMemo = { resetsAt: string | null; level: number; blocked: boolean; handedOff: boolean }

declare module 'claude-code' {
  interface PluginState {
    'mesh-live': {
      snapshot: MeshSnapshot
      seen: string[]
      bandHidden: boolean
      lastDigest: string
      quotaMemo: Record<string, MeshQuotaMemo>
    }
  }
}
