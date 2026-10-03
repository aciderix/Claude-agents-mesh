// Pure helpers: the snapshot's shape and everything computed from it. Nothing
// here touches the engine; register.tsx does all of that.
import type { McpToolResult } from 'claude-code'

import type { MeshAgent, MeshMessage, MeshQuota, MeshSnapshot, MeshTask } from '../../types'

export class MeshError extends Error {}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The coordinator answers one text block of JSON, or `Error: ...` with isError. */
export function parseResult(result: McpToolResult): unknown {
  const text = result.content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('')
  if (result.isError) throw new MeshError(text.replace(/^Error:\s*/, '') || 'mesh call failed')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export type RawAgent = {
  id: string
  account_label?: string
  status?: string
  is_me?: boolean
  online?: boolean
  heartbeat_age_seconds?: number | null
}
export type RawTask = {
  id: string
  title?: string
  status?: string
  priority?: number
  assigned_to_agent_id?: string | null
  created_by_agent_id?: string | null
  files?: string[] | null
  lease_expired?: boolean | null
  description?: string | null
}
export type RawStatus = {
  agents?: RawAgent[]
  active_tasks?: RawTask[]
  recent_quota_events?: { agent_id: string; event_type: string }[]
}
export type RawMessage = {
  id: string
  sender_agent_id?: string | null
  message_type?: string
  body?: unknown
  created_at?: string
  task_id?: string | null
}

/** A message body is `{ text }` when sent as text, any JSON otherwise. */
export function bodyText(body: unknown): string {
  if (body !== null && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string') {
    return (body as { text: string }).text
  }
  return body === undefined ? '' : JSON.stringify(body)
}

/** get_coordination_status + read_messages, as the snapshot the features read. */
export function toSnapshot(
  status: RawStatus,
  messages: RawMessage[],
  server: string | null,
  quota: MeshQuota[],
  now: number,
): MeshSnapshot {
  const lastQuota = new Map<string, string>()
  for (const event of status.recent_quota_events ?? []) {
    if (!lastQuota.has(event.agent_id)) lastQuota.set(event.agent_id, event.event_type)
  }
  const agents: MeshAgent[] = (status.agents ?? []).map(a => ({
    id: a.id,
    label: a.account_label ?? a.id.slice(0, 8),
    status: a.status ?? 'offline',
    online: a.online === true,
    isMe: a.is_me === true,
    ageSeconds: a.heartbeat_age_seconds ?? null,
    lastQuotaEvent: lastQuota.get(a.id) ?? null,
  }))
  const tasks: MeshTask[] = (status.active_tasks ?? []).map(t => ({
    id: t.id,
    title: t.title ?? '(sans titre)',
    status: t.status ?? 'pending',
    priority: t.priority ?? 0,
    assigneeId: t.assigned_to_agent_id ?? null,
    creatorId: t.created_by_agent_id ?? null,
    files: Array.isArray(t.files) ? t.files : [],
    leaseExpired: t.lease_expired ?? null,
  }))
  const inbox: MeshMessage[] = messages.map(m => ({
    id: m.id,
    fromId: m.sender_agent_id ?? null,
    type: m.message_type ?? 'text',
    text: bodyText(m.body),
    createdAt: m.created_at ?? '',
    taskId: m.task_id ?? null,
  }))
  return {
    server,
    me: agents.find(a => a.isMe)?.id ?? null,
    agents,
    tasks,
    messages: inbox,
    quota,
    error: null,
    updatedAt: now,
  }
}

export const ACTIVE = new Set(['claimed', 'in_progress'])
const BLOCKED = new Set(['blocked_by_quota', 'waiting_for_reset'])

export const isBlockedStatus = (status: string) => BLOCKED.has(status)

export const labelOf = (s: MeshSnapshot, id: string | null) =>
  id === null ? '?' : (s.agents.find(a => a.id === id)?.label ?? id.slice(0, 8))

export const myAgent = (s: MeshSnapshot) => s.agents.find(a => a.isMe)

/** The tasks this agent holds a live claim on. */
export const heldTasks = (s: MeshSnapshot) =>
  s.tasks.filter(t => s.me !== null && t.assigneeId === s.me && ACTIVE.has(t.status))

/** Pending tasks, and active ones nobody holds any more (lease ran out, or no assignee). */
export const freeTasks = (s: MeshSnapshot) =>
  s.tasks.filter(
    t => t.status === 'pending' || (ACTIVE.has(t.status) && (t.leaseExpired === true || t.assigneeId === null)),
  )

/** True once a rate-limit window is spent: waking the agent would only fail. */
export const isQuotaSpent = (s: MeshSnapshot) =>
  s.quota.some(q => q.percentUsed >= 100) || isBlockedStatus(myAgent(s)?.status ?? '')

export const WINDOWS = new Set(['five_hour', 'seven_day', 'spend_limit'])
export const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7j', spend_limit: 'dépense' }

/** The highest threshold `percent` reaches, or 0. */
export const crossedLevel = (thresholds: number[], percent: number) =>
  thresholds.filter(t => percent >= t).at(-1) ?? 0

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const STATUS_FR: Record<string, string> = {
  available: 'disponible',
  working: 'au travail',
  blocked_by_quota: 'bloqué (quota)',
  waiting_for_reset: 'attend le reset',
  needs_attention: 'quota proche',
  offline: 'hors ligne',
  pending: 'libre',
  claimed: 'réclamée',
  in_progress: 'en cours',
}

export const fr = (status: string) => STATUS_FR[status] ?? status

/** `mesh · 2/3 en ligne · 1 à moi · 2 libres · ✉ 1 · 5h 87 %`. */
export function statusText(s: MeshSnapshot): string {
  if (s.error !== null && s.agents.length === 0) return `mesh ⚠ ${s.error.slice(0, 60)}`
  const parts = ['mesh']
  if (s.error !== null) parts.push('⚠ hors ligne')
  if (s.agents.length > 0) parts.push(`${s.agents.filter(a => a.online).length}/${s.agents.length} en ligne`)
  const mine = heldTasks(s).length
  const free = freeTasks(s).length
  if (mine > 0) parts.push(`${mine} à moi`)
  if (free > 0) parts.push(`${free} libre${free > 1 ? 's' : ''}`)
  if (s.messages.length > 0) parts.push(`✉ ${s.messages.length}`)
  for (const q of s.quota) parts.push(`${WINDOW_LABEL[q.kind] ?? q.kind} ${Math.round(q.percentUsed)} %`)
  return parts.join(' · ')
}

const LIMIT = 8

/** The mesh state beside a prompt; ages left out so it changes only when the state does. */
export function digest(s: MeshSnapshot): string {
  const me = myAgent(s)
  const others = s.agents.filter(a => !a.isMe)
  const held = heldTasks(s)
  const free = freeTasks(s)
  const busy = s.tasks.filter(t => t.assigneeId !== null && t.assigneeId !== s.me && !free.includes(t))
  const files = (list: string[]) => (list.length > 0 ? ` — fichiers : ${list.join(', ')}` : '')
  const lines = [
    '<mesh-status>',
    `Moi : ${me?.label ?? '?'} (${me?.status ?? 'non enregistré'})`,
    `Autres agents : ${others.length === 0 ? 'aucun' : others.map(a => `${a.label} (${a.online ? a.status : 'hors ligne'})`).join(', ')}`,
  ]
  if (held.length > 0) lines.push('Mes tâches :', ...held.slice(0, LIMIT).map(t => `- ${t.title} [${t.id}] ${t.status}${files(t.files)}`))
  if (free.length > 0) lines.push('Tâches libres :', ...free.slice(0, LIMIT).map(t => `- ${t.title} [${t.id}] priorité ${t.priority}`))
  if (busy.length > 0) {
    lines.push('Tâches des autres :', ...busy.slice(0, LIMIT).map(t => `- ${t.title} — ${labelOf(s, t.assigneeId)}${files(t.files)}`))
  }
  if (s.messages.length > 0) {
    const senders = [...new Set(s.messages.map(m => labelOf(s, m.fromId)))].join(', ')
    lines.push(`Messages non lus : ${s.messages.length} (de ${senders}) → read_messages`)
  }
  lines.push('</mesh-status>')
  return lines.join('\n')
}

/** A member token: `mesh_` and 48 hex digits (24 random bytes). */
const TOKEN = /mesh_[0-9a-f]{48}/g

export const hasToken = (text: string) => text.includes('mesh_') && new RegExp(TOKEN.source).test(text)

/** `mesh_1a2b3c4d…[masqué]` keeps the prefix list_tokens shows, so the token stays recognisable. */
export const maskText = (text: string) => text.replace(TOKEN, token => `${token.slice(0, 13)}…[masqué]`)

/** Masks every string inside a value, keeping its shape. */
export function maskDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskText(value)
  if (Array.isArray(value)) return value.map(maskDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskDeep(inner)]))
  }
  return value
}

export const mentionsToken = (value: unknown) => {
  if (value === undefined) return false
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text !== undefined && hasToken(text)
}
