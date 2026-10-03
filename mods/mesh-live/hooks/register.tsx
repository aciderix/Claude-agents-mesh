import { atom, read, update } from 'claude-code'
import type { EngineInterface, McpToolResult, Register, SessionRateLimit, ToolCallInput } from 'claude-code'

import type { MeshQuotaMemo, MeshSnapshot } from '../types'
import { matchesPattern, relativeTo } from './lib/glob'
import {
  ACTIVE,
  MeshError,
  WINDOWS,
  WINDOW_LABEL,
  crossedLevel,
  digest,
  errorText,
  freeTasks,
  fr,
  heldTasks,
  isBlockedStatus,
  isQuotaSpent,
  labelOf,
  maskDeep,
  maskText,
  hasToken,
  mentionsToken,
  myAgent,
  parseResult,
  plural,
  statusText,
  toSnapshot,
} from './lib/model'
import type { RawMessage, RawStatus, RawTask } from './lib/model'
import { readOptions } from './lib/options'
import type { Options } from './lib/options'
import {
  COMMANDS,
  FALLBACK_SERVERS,
  GUIDE,
  HANDOFF_PROMPT,
  MUTATING,
  READ_PROMPT,
  WRITERS,
  claimedPrompt,
} from './lib/text'

// The snapshot and the bookkeeping, held by the host for the session.
const EMPTY_SNAPSHOT: MeshSnapshot = {
  server: null,
  me: null,
  agents: [],
  tasks: [],
  messages: [],
  quota: [],
  error: null,
  updatedAt: 0,
}

const snapshotAtom = atom({ plugin: 'mesh-live', key: 'snapshot' } as const, EMPTY_SNAPSHOT)
/** Ids already announced (`m:<message>`, `t:<task>`), so each wakes the agent once. */
const seenAtom = atom({ plugin: 'mesh-live', key: 'seen' } as const, [])
const bandHiddenAtom = atom({ plugin: 'mesh-live', key: 'bandHidden' } as const, false)
/** The mesh context last given to the model, so an unchanged one is not repeated. */
const lastDigestAtom = atom({ plugin: 'mesh-live', key: 'lastDigest' } as const, '')
/** Per rate-limit window: what was reported and whether the handoff ran. */
const quotaMemoAtom = atom({ plugin: 'mesh-live', key: 'quotaMemo' } as const, {})

const PANE = 'mesh'

type HandoffReason = 'quota' | 'blocked' | 'manual'

const REASON: Record<HandoffReason, string> = {
  quota: 'quota presque épuisé',
  blocked: 'quota épuisé',
  manual: 'demande manuelle',
}

// Module state: a reload re-runs this module, so it starts over with each load.
let opts: Options = readOptions({})
let candidates: string[] = []
let leaseSeconds = 120
let server: string | null = null
let inflight: Promise<MeshSnapshot> | null = null
let isWakeQueued = false
let pollTimer: { cancel: () => void } | null = null
// Polls failed in a row; past MAX_FAILURES the timer stops (a refused permission must not re-ask forever).
let failures = 0
const MAX_FAILURES = 2
let handoffRunning: Promise<string> | null = null
let quotaChain: Promise<void> = Promise.resolve()
// A rate_limit stop with no window measured (no reading yet) hands off once.
let hasHandedOffUnmeasured = false

// ---------------------------------------------------------------- mesh calls

/** A refused call may come back as `{ deny }` rather than a rejection. */
function unwrap(result: McpToolResult): McpToolResult {
  const deny = (result as unknown as { deny?: unknown }).deny
  if (typeof deny === 'string') throw new MeshError(`refusé : ${deny}`)
  return result
}

/** The tool-name spelling of a server name (`Claude mesh` → `Claude_mesh`), which $.mcp.call accepts. */
const spelling = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * Finds the mesh server among the tools the session has, without calling
 * anything (a call may ask the person for permission): the server whose tools
 * include get_coordination_status, the configured name first.
 */
async function findServer($: EngineInterface): Promise<string> {
  const found = (await $.tool.list())
    .map(tool => /^mcp__(.+)__get_coordination_status$/.exec(tool.name)?.[1])
    .filter((name): name is string => name !== undefined)
  const preferred = candidates.map(spelling).find(name => found.includes(name))
  const name = preferred ?? found[0]
  if (name === undefined) {
    throw new MeshError(`serveur MCP mesh introuvable : aucun outil get_coordination_status (essayé : ${candidates.join(', ')})`)
  }
  return name
}

/** Calls a coordinator tool through the engine's own MCP connection: one call, so at most one ask. */
async function call<T = unknown>($: EngineInterface, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  server ??= await findServer($)
  return parseResult(unwrap(await $.mcp.call(server, tool, args))) as T
}

async function registerArgs($: EngineInterface): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = { session_id: await $.session.id() }
  if (opts.agentName !== '') args.name = opts.agentName
  return args
}

// ------------------------------------------------------------------- polling

/** Polls the mesh now; concurrent calls share one poll. */
function refresh($: EngineInterface): Promise<MeshSnapshot> {
  inflight ??= poll($)
    .catch(err => ({ ...EMPTY_SNAPSHOT, error: errorText(err), updatedAt: Date.now() }))
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function poll($: EngineInterface): Promise<MeshSnapshot> {
  const prev = await read($, snapshotAtom)
  let next: MeshSnapshot
  try {
    await call($, 'heartbeat_session', {}).catch(async err => {
      // Only a missing agent is fixed by registering; anything else (a refusal) stops here.
      if (!/register_session|no agent registered/i.test(errorText(err))) throw err
      await call($, 'register_session', await registerArgs($))
    })
    const status = await call<RawStatus>($, 'get_coordination_status', {})
    const inbox = await call<{ messages?: RawMessage[] }>($, 'read_messages', {
      only_unread: true,
      mark_delivered: false,
      limit: 50,
    })
    next = toSnapshot(status, inbox.messages ?? [], server, prev.quota, Date.now())
    failures = 0
  } catch (err) {
    failures += 1
    const isPaused = failures >= MAX_FAILURES
    if (isPaused) {
      pollTimer?.cancel()
      pollTimer = null
    }
    const reason = isPaused ? 'en pause (/mesh pour reprendre) : ' : ''
    next = { ...prev, error: `${reason}${errorText(err)}`, updatedAt: Date.now() }
  }
  // session.measure writes the quota meanwhile: keep the newest.
  const stored = await update($, snapshotAtom, current => ({ ...next, quota: current.quota }))
  // One feature failing must not stop the other.
  await keepLeases($, stored).catch(() => {})
  await announce($, stored, prev).catch(() => {})
  drawStatus($, stored)
  return stored
}

/** (Re)starts the poll timer; a poll that keeps failing stops it again. */
function startPolling($: EngineInterface) {
  pollTimer?.cancel()
  failures = 0
  pollTimer = $.clock.every(opts.pollMs, () => void refresh($))
}

// ------------------------------------------------------- 3. lease keeping

async function keepLeases($: EngineInterface, s: MeshSnapshot) {
  if (!opts.keepLeases || s.error !== null) return
  for (const task of heldTasks(s)) {
    await call($, 'heartbeat_task', { task_id: task.id, lease_seconds: leaseSeconds }).catch(() => {})
  }
}

// ----------------------------------------------------- 1. inbox and wake

async function announce($: EngineInterface, s: MeshSnapshot, prev: MeshSnapshot) {
  if (s.error !== null) return
  const seen = new Set(await read($, seenAtom))
  const newMessages = s.messages.filter(m => !seen.has(`m:${m.id}`))
  const newTasks = freeTasks(s).filter(t => !seen.has(`t:${t.id}`) && t.creatorId !== s.me)
  if (newMessages.length === 0 && newTasks.length === 0) return

  const ids = [...newMessages.map(m => `m:${m.id}`), ...newTasks.map(t => `t:${t.id}`)]
  await update($, seenAtom, list => [...new Set([...list, ...ids])].slice(-500))
  if (newMessages.length > 0) await update($, bandHiddenAtom, () => false)

  // The session's first poll only takes stock: what was already there is in the band.
  if (prev.updatedAt === 0 || isQuotaSpent(s)) return

  const parts: string[] = []
  if (opts.wakeOnMessage && newMessages.length > 0) {
    const senders = [...new Set(newMessages.map(m => labelOf(s, m.fromId)))].join(', ')
    const kinds = [...new Set(newMessages.map(m => m.type))].join(', ')
    parts.push(
      `${plural(newMessages.length, 'nouveau message', 'nouveaux messages')} de ${senders} (type : ${kinds}). ` +
        'Appelle read_messages, traite-les, puis ack_message pour chacun.',
    )
  }
  if (opts.wakeOnTask && newTasks.length > 0 && heldTasks(s).length === 0) {
    const titles = newTasks
      .slice(0, 5)
      .map(t => `« ${t.title} » (priorité ${t.priority}, id ${t.id})`)
      .join(' ; ')
    parts.push(
      `${plural(newTasks.length, 'nouvelle tâche disponible', 'nouvelles tâches disponibles')} : ${titles}. ` +
        "Si tu es disponible et qu'elle te correspond, réclame-la avec claim_task et travaille dessus ; sinon ignore-la.",
    )
  }
  if (parts.length === 0) return

  $.ui.toast(newMessages.length > 0 ? 'mesh : nouveau message' : 'mesh : nouvelle tâche')
  if (isWakeQueued) return
  isWakeQueued = true
  // Queued until the session is idle; never folded into a running turn.
  void $.prompt
    .submit({ text: `[mesh] ${parts.join('\n')}\nSi rien n'est à faire, réponds en une ligne.` })
    .catch(() => {})
    .finally(() => {
      isWakeQueued = false
    })
}

// ---------------------------------------------------------- 7. status line

function drawStatus($: EngineInterface, s: MeshSnapshot) {
  if (opts.showStatus) $.ui.status(statusText(s))
}

// ------------------------------------------------------------- 2. quota

const report = ($: EngineInterface, args: Record<string, unknown>) =>
  call($, 'report_quota_event', args).catch(() => {})

async function handleRateLimits($: EngineInterface, limits: readonly SessionRateLimit[]) {
  const stored = await update($, snapshotAtom, s => ({
    ...s,
    quota: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt ?? null })),
  }))
  drawStatus($, stored)
  if (!opts.reportQuota && !opts.autoHandoff) return

  const memos = { ...(await read($, quotaMemoAtom)) }
  for (const limit of limits) {
    const resetsAt = limit.resetsAt ?? null
    const before = memos[limit.kind]
    const memo: MeshQuotaMemo =
      before !== undefined && before.resetsAt === resetsAt
        ? { ...before }
        : { resetsAt, level: 0, blocked: false, handedOff: false }
    const percent = Math.min(100, Math.max(0, limit.percentUsed))
    const label = WINDOW_LABEL[limit.kind] ?? limit.kind
    const base = {
      ...(WINDOWS.has(limit.kind) ? { quota_window: limit.kind } : {}),
      used_percentage: percent,
      ...(resetsAt !== null ? { resets_at: resetsAt } : {}),
    }

    if (opts.reportQuota) {
      if (before !== undefined && before.resetsAt !== resetsAt && before.blocked && percent < 100) {
        await report($, { event_type: 'quota_reset', ...base })
      }
      if (percent >= 100 && !memo.blocked) {
        memo.blocked = true
        memo.level = 100
        await report($, { event_type: 'quota_blocked', ...base })
      } else {
        const level = crossedLevel(opts.quotaThresholds, percent)
        if (level > memo.level) {
          memo.level = level
          await report($, { event_type: 'quota_warning', ...base })
          $.ui.toast(`mesh : quota ${label} à ${percent} %`)
        }
      }
    }

    const shouldHandOff = opts.autoHandoff && percent >= opts.handoffThreshold && !memo.handedOff
    if (shouldHandOff) memo.handedOff = true
    memos[limit.kind] = memo
    await update($, quotaMemoAtom, () => ({ ...memos }))
    if (shouldHandOff) void handoff($, percent >= 100 ? 'blocked' : 'quota', `quota ${label} à ${percent} %`)
  }
}

async function handleRateLimitStop($: EngineInterface, details: string | undefined) {
  if (opts.reportQuota) {
    await report($, {
      event_type: 'quota_blocked',
      error_type: 'rate_limit',
      ...(details !== undefined ? { error_details: { details } } : {}),
    })
  }
  if (!opts.autoHandoff) return
  const windows = Object.values(await read($, quotaMemoAtom))
  const isDone = windows.length > 0 ? windows.some(m => m.handedOff) : hasHandedOffUnmeasured
  if (isDone) return
  hasHandedOffUnmeasured = true
  await update($, quotaMemoAtom, current => {
    const out = { ...current }
    for (const [kind, memo] of Object.entries(out)) out[kind] = { ...memo, handedOff: true }
    return out
  })
  void handoff($, 'blocked', 'limite de débit atteinte')
}

// ----------------------------------------------------------- 4. handoff

function handoff($: EngineInterface, reason: HandoffReason, note?: string): Promise<string> {
  handoffRunning ??= runHandoff($, reason, note).finally(() => {
    handoffRunning = null
  })
  return handoffRunning
}

/**
 * The note is written by forking the session's own transcript (served from
 * the prompt cache; skipped once the quota is spent, when it would fail). It
 * is appended to each task held before release, or filed as a new task when
 * none is held; then every other agent online is told.
 */
async function runHandoff($: EngineInterface, reason: HandoffReason, note?: string): Promise<string> {
  const s = await refresh($)
  if (s.me === null) return `mesh injoignable : ${s.error ?? 'agent non enregistré'}`
  const me = myAgent(s)?.label ?? 'cet agent'

  let summary: string | null = null
  if (reason !== 'blocked') {
    const forked = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (forked.isAnswered) summary = forked.text.trim()
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const notes = [
    `Passation ${stamp} UTC par ${me} (${REASON[reason]})`,
    note !== undefined && note.trim() !== '' ? `Note : ${note.trim()}` : null,
    summary ?? "(pas de résumé automatique : voir l'historique git et les messages de l'agent)",
  ]
    .filter(line => line !== null)
    .join('\n')

  const held = heldTasks(s)
  const released: string[] = []
  let created: string | null = null
  try {
    if (held.length > 0) {
      const all = await call<{ tasks?: RawTask[] }>($, 'list_tasks', { limit: 200 })
      for (const task of held) {
        const before = all.tasks?.find(t => t.id === task.id)?.description ?? ''
        const description = [before.trim(), '---', notes].filter(part => part !== '').join('\n\n')
        await call($, 'update_task', { task_id: task.id, description }).catch(() => {})
        await call($, 'release_task', { task_id: task.id })
        released.push(`« ${task.title} »`)
      }
    } else if (summary !== null || reason === 'manual') {
      const task = await call<{ id: string }>($, 'create_task', {
        title: `Reprise du travail de ${me}`,
        description: notes,
        priority: 1,
      })
      created = task.id
    }
  } catch (err) {
    return `passation incomplète : ${errorText(err)}`
  }

  const what =
    released.length > 0
      ? `Tâches libérées avec la note de passation : ${released.join(', ')}.`
      : created !== null
        ? `Tâche de reprise créée (id ${created}).`
        : 'Aucune tâche en cours.'
  const peers = s.agents.filter(a => !a.isMe && a.online && !isBlockedStatus(a.status))
  await Promise.all(
    peers.map(peer =>
      call($, 'send_message', {
        to: peer.id,
        message_type: 'handoff',
        text: `${me} passe la main (${REASON[reason]}). ${what} Réclame-les avec claim_task pour reprendre.`,
      }).catch(() => {}),
    ),
  )

  $.ui.toast(`mesh : passation faite (${released.length > 0 ? released.length : created !== null ? 1 : 0} tâche(s))`)
  void refresh($)
  const told = peers.length > 0 ? `Prévenus : ${peers.map(p => p.label).join(', ')}.` : 'Aucun autre agent en ligne.'
  return [what, told, '', notes].join('\n')
}

// ------------------------------------------------- 9. file locks

type LockVerdict = { deny: string } | { warn: string } | null

async function checkFileLock($: EngineInterface, e: ToolCallInput): Promise<LockVerdict> {
  if (opts.fileLock === 'off') return null
  const field = WRITERS[String(e.tool)]
  const path = field !== undefined ? (e as unknown as Record<string, unknown>)[field] : undefined
  if (typeof path !== 'string' || path === '') return null

  const s = await read($, snapshotAtom)
  const rel = relativeTo(await $.session.cwd(), path)
  const owner = s.tasks.find(
    t =>
      t.assigneeId !== null &&
      t.assigneeId !== s.me &&
      ACTIVE.has(t.status) &&
      t.leaseExpired !== true &&
      t.files.some(pattern => matchesPattern(pattern, rel)),
  )
  if (owner === undefined) return null

  const who = labelOf(s, owner.assigneeId)
  const notice = `${rel} est réservé par ${who} (tâche « ${owner.title} », id ${owner.id})`
  if (opts.fileLock === 'deny') {
    return { deny: `mesh-live : ${notice}. Coordonne-toi avec ${who} via send_message avant de le modifier.` }
  }
  $.ui.toast(`⚠ mesh : ${notice}`)
  return { warn: `Attention (mesh) : ${notice}. Préviens ${who} avec send_message pour éviter un conflit de modifications.` }
}

// ------------------------------------------------- presence and actions

async function setStatus($: EngineInterface, status: 'working' | 'available') {
  const me = myAgent(await read($, snapshotAtom))
  if (me === undefined || isBlockedStatus(me.status) || me.status === status) return
  await call($, 'heartbeat_session', { status }).catch(() => {})
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'Mesh' })
  void refresh($)
  return opened
}

async function act($: EngineInterface, done: string, tool: string, args: Record<string, unknown>) {
  try {
    await call($, tool, args)
    $.ui.toast(`mesh : ${done}`)
  } catch (err) {
    $.ui.toast(`mesh : ${errorText(err)}`)
  }
  await refresh($)
}

async function claimFromPane($: EngineInterface, id: string, title: string) {
  try {
    await call($, 'claim_task', { task_id: id, lease_seconds: leaseSeconds })
  } catch (err) {
    $.ui.toast(`mesh : ${errorText(err)}`)
    return
  }
  void refresh($)
  await $.prompt.submit({ text: claimedPrompt(title, id) })
}

/**
 * mesh-live: the Claude Agents Mesh, live inside Claude Code.
 *
 * One poller (get_coordination_status + read_messages, every poll_seconds)
 * feeds a snapshot kept in $.state; the features read it:
 *  1. inbox band above the prompt, and a wake-up turn on a new message or task
 *  2. quota reports from the engine's real rate-limit figures
 *  3. the leases of the tasks held, renewed on each poll
 *  4. the handoff near the quota limit (note, tasks released, peers told)
 *  5. the /mesh pane
 *  6. /mesh, /inbox, /claim, /handoff, /tell
 *  7. the status line
 *  8. a mesh guide in the system prompt, and the live state beside each prompt
 *  9. file locks: warn or deny an edit of a file another agent's task declares
 * 10. mesh_ tokens masked wherever the transcript draws them
 */
export const register: Register = (on, options) => {
  opts = readOptions(options)
  candidates = [...new Set([opts.meshServer, ...FALLBACK_SERVERS].filter(name => name !== ''))]
  leaseSeconds = Math.min(3600, Math.max(60, Math.round((opts.pollMs / 1000) * 4)))
  server = null

  // ============================================================= the hooks

  on('session.start', async ($, e, next) => {
    void (async () => {
      try {
        await call($, 'register_session', await registerArgs($))
      } catch {
        // The poll below reports it in the status line.
      }
      await refresh($)
    })().catch(() => {})
    startPolling($)
    for (const command of COMMANDS) await $.command.register({ ...command })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, lastDigestAtom, () => '')
    if (opts.releaseOnExit && e.reason !== 'resume') {
      const s = await read($, snapshotAtom)
      await Promise.all(heldTasks(s).map(task => call($, 'release_task', { task_id: task.id }).catch(() => {})))
      await call($, 'heartbeat_session', { status: 'offline' }).catch(() => {})
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    void setStatus($, 'working')
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) void setStatus($, 'available').then(() => refresh($))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const lock = await checkFileLock($, e)
    if (lock !== null && 'deny' in lock) return { deny: lock.deny }
    const ran = await next(e)
    if (MUTATING.test(String(e.tool))) void refresh($)
    if (lock === null || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), lock.warn] }
  })

  on('session.measure', ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const limits = e.rateLimits
      quotaChain = quotaChain.then(() => handleRateLimits($, limits)).catch(() => {})
    }
    return next(e)
  })

  on('classic.StopFailure', ($, e, next) => {
    if (e.error === 'rate_limit') {
      const details = e.error_details
      quotaChain = quotaChain.then(() => handleRateLimitStop($, details)).catch(() => {})
    }
    return next(e)
  })

  if (opts.injectContext) {
    // Fixed text, so the system prompt stays cacheable.
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)
      return { sections: [...composed.sections, { id: 'mesh-live:mesh', text: GUIDE, scope: 'session' as const }] }
    })

    on('prompt.submit', async ($, e, next) => {
      const s = await read($, snapshotAtom)
      if (s.updatedAt === 0 || s.error !== null) return next(e)
      const text = digest(s)
      if (text === (await read($, lastDigestAtom))) return next(e)
      await update($, lastDigestAtom, () => text)
      return next({ ...e, context: [...(e.context ?? []), text] })
    })
  }

  // ------------------------------------------------------------ commands

  on('command.run', { command: 'mesh' }, async $ => {
    if (pollTimer === null) startPolling($)
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Panneau Mesh ouvert.' : "Panneau Mesh demandé : il s'affichera dès que la place le permet." }
  })

  on('command.run', { command: 'inbox' }, async $ => {
    const s = await refresh($)
    if (s.error !== null) return { text: `mesh injoignable : ${s.error}` }
    if (s.messages.length === 0) return { text: 'Aucun message mesh non lu.' }
    const lines = s.messages.map(
      m => `- [${m.type}] ${labelOf(s, m.fromId)} (${m.createdAt.slice(0, 16).replace('T', ' ')}) : ${m.text}  (id ${m.id})`,
    )
    return { text: [`${plural(s.messages.length, 'message non lu', 'messages non lus')} :`, ...lines, '', 'Confirme chacun avec ack_message une fois traité.'].join('\n') }
  })

  on('command.run', { command: 'claim' }, async ($, e) => {
    const s = await refresh($)
    if (s.error !== null) return { text: `mesh injoignable : ${s.error}` }
    const wanted = e.args.trim()
    const target =
      wanted !== ''
        ? s.tasks.find(t => t.id === wanted || t.id.startsWith(wanted))
        : [...freeTasks(s)].sort((a, b) => b.priority - a.priority)[0]
    if (target === undefined) return { text: wanted !== '' ? `Aucune tâche active « ${wanted} ».` : 'Aucune tâche libre.' }
    try {
      await call($, 'claim_task', { task_id: target.id, lease_seconds: leaseSeconds })
    } catch (err) {
      return { text: `Réclamation impossible : ${errorText(err)}` }
    }
    void refresh($)
    const all = await call<{ tasks?: RawTask[] }>($, 'list_tasks', { limit: 200 }).catch(() => ({ tasks: [] as RawTask[] }))
    const description = all.tasks?.find(t => t.id === target.id)?.description ?? ''
    return {
      text: `Tâche « ${target.title} » réclamée (id ${target.id}). Le bail est renouvelé automatiquement.`,
      context: [
        `Tâche mesh réclamée : « ${target.title} » (id ${target.id}, priorité ${target.priority}).` +
          (description !== '' ? `\nDescription :\n${description}` : '') +
          '\nDéclare les fichiers que tu modifies avec update_task (champ files), puis termine avec complete_task.',
      ],
    }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => ({ text: await handoff($, 'manual', e.args) }))

  on('command.run', { command: 'tell' }, async ($, e) => {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(e.args.trim())
    if (match === null) return { text: 'Usage : /tell <agent> <message>' }
    const [, to, text] = match
    try {
      await call($, 'send_message', { to, text })
    } catch (err) {
      return { text: `Envoi impossible : ${errorText(err)}` }
    }
    void refresh($)
    return { text: `Message envoyé à ${to}.` }
  })

  // ------------------------------------------------------- 1. inbox band

  if (opts.showBand) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      if (e.props.hasSurvey) return next(e)
      const s = await read($, snapshotAtom)
      const isHidden = await read($, bandHiddenAtom)
      const unread = s.messages.length
      const free = freeTasks(s).length
      if (isHidden || (unread === 0 && free === 0)) return next(e)

      const { Box, Text, Button } = $.ui.resolve(e)
      const senders = [...new Set(s.messages.map(m => labelOf(s, m.fromId)))].join(', ')

      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text color="cyan" bold>
            mesh
          </Text>
          {unread > 0 && (
            <Text>
              ✉ {plural(unread, 'message', 'messages')}
              {senders !== '' ? ` de ${senders}` : ''}
            </Text>
          )}
          {free > 0 && <Text dimColor>· {plural(free, 'tâche libre', 'tâches libres')}</Text>}
          {unread > 0 && (
            <Button key="mesh-band-read" label="Lire" onPress={() => void $.prompt.submit({ text: READ_PROMPT })} />
          )}
          <Button key="mesh-band-pane" label="Panneau" onPress={() => void $.ui.open({ id: PANE, title: 'Mesh' })} />
          <Button key="mesh-band-hide" label="Masquer" onPress={() => void update($, bandHiddenAtom, () => true)} />
        </Box>
      )
    })
  }

  // ------------------------------------------------------------ 5. pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snapshotAtom)
    const held = new Set(heldTasks(s).map(t => t.id))
    const free = new Set(freeTasks(s).map(t => t.id))
    const quota = s.quota.map(q => `${WINDOW_LABEL[q.kind] ?? q.kind} ${Math.round(q.percentUsed)} %`).join(' · ')
    const updated = s.updatedAt === 0 ? 'jamais' : `${new Date(s.updatedAt).toISOString().slice(11, 19)} UTC`

    return (
      <Box flexDirection="column" rowGap={1}>
        {s.error !== null && <Text color="red">⚠ {s.error}</Text>}

        <Box flexDirection="column">
          <Text bold>
            Agents ({s.agents.filter(a => a.online).length}/{s.agents.length} en ligne)
          </Text>
          {s.agents.length === 0 && <Text dimColor>Aucun agent.</Text>}
          {s.agents.map(a => (
            <Text wrap="truncate-end" dimColor={!a.online}>
              {a.online ? '●' : '○'} {a.label}
              {a.isMe ? ' (moi)' : ''} · {fr(a.status)}
              {a.lastQuotaEvent !== null ? ` · ${a.lastQuotaEvent}` : ''}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Tâches actives ({s.tasks.length})</Text>
          {s.tasks.length === 0 && <Text dimColor>Aucune tâche active.</Text>}
          {s.tasks.map(t => (
            <Box key={`task-${t.id}`} flexDirection="row" columnGap={1}>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  [P{t.priority}] {t.title}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {fr(t.status)}
                  {t.assigneeId !== null && ACTIVE.has(t.status) ? ` · ${labelOf(s, t.assigneeId)}` : ''}
                  {t.leaseExpired === true ? ' · bail expiré' : ''}
                  {t.files.length > 0 ? ` · ${t.files.join(', ')}` : ''}
                </Text>
              </Box>
              {free.has(t.id) && !held.has(t.id) && (
                <Button key={`claim-${t.id}`} label="Réclamer" onPress={() => void claimFromPane($, t.id, t.title)} />
              )}
              {held.has(t.id) && (
                <Button
                  key={`release-${t.id}`}
                  label="Libérer"
                  onPress={() => void act($, 'tâche libérée', 'release_task', { task_id: t.id })}
                />
              )}
              {held.has(t.id) && (
                <Button
                  key={`done-${t.id}`}
                  label="Terminée"
                  onPress={() => void act($, 'tâche terminée', 'complete_task', { task_id: t.id })}
                />
              )}
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Messages non lus ({s.messages.length})</Text>
          {s.messages.length === 0 && <Text dimColor>Rien de neuf.</Text>}
          {s.messages.map(m => (
            <Box key={`msg-${m.id}`} flexDirection="row" columnGap={1}>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  {labelOf(s, m.fromId)} · {m.type} : {m.text}
                </Text>
              </Box>
              <Button
                key={`ack-${m.id}`}
                label="Lu"
                onPress={() => void act($, 'message confirmé', 'ack_message', { message_id: m.id })}
              />
            </Box>
          ))}
        </Box>

        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>
            maj {updated}
            {quota !== '' ? ` · ${quota}` : ''}
            {s.server !== null ? ` · ${s.server}` : ''}
          </Text>
          <Button key="mesh-refresh" label="Actualiser" onPress={() => void refresh($)} />
          <Button key="mesh-close" label="Fermer" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })

  // ----------------------------------------------------- 10. token masking

  if (opts.maskTokens) {
    on('ui.render', { component: 'AssistantMessage' }, ($, e, next) =>
      hasToken(e.props.text) ? next({ ...e, props: { ...e.props, text: maskText(e.props.text) } }) : next(e),
    )

    on('ui.render', { component: 'UserMessage' }, ($, e, next) =>
      hasToken(e.props.text) ? next({ ...e, props: { ...e.props, text: maskText(e.props.text) } }) : next(e),
    )

    on('ui.render', { component: 'ToolUse' }, ($, e, next) =>
      mentionsToken(e.props.input) || mentionsToken(e.props.output)
        ? next({ ...e, props: { ...e.props, input: maskDeep(e.props.input), output: maskDeep(e.props.output) } })
        : next(e),
    )

    on('ui.render', { component: 'ToolResult' }, ($, e, next) =>
      mentionsToken(e.props.output) ? next({ ...e, props: { ...e.props, output: maskDeep(e.props.output) } }) : next(e),
    )
  }
}
