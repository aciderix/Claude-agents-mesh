import { describe, expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, On, PromptSubmitInput } from 'claude-code'

import { matchesPattern, relativeTo } from '../hooks/lib/glob'
import { crossedLevel, digest, freeTasks, maskDeep, maskText, statusText, toSnapshot } from '../hooks/lib/model'
import type { RawMessage, RawStatus } from '../hooks/lib/model'
import { parseThresholds } from '../hooks/lib/options'

const ME = '11111111-1111-1111-1111-111111111111'
const BOB = '22222222-2222-2222-2222-222222222222'
const TOKEN = `mesh_${'ab'.repeat(24)}`

const STATUS: Required<RawStatus> = {
  agents: [
    { id: ME, account_label: 'Claude-A', status: 'available', is_me: true, online: true, heartbeat_age_seconds: 3 },
    { id: BOB, account_label: 'Claude-B', status: 'working', is_me: false, online: true, heartbeat_age_seconds: 9 },
  ],
  active_tasks: [
    {
      id: 'task-bob',
      title: 'Refonte UI',
      status: 'in_progress',
      priority: 2,
      assigned_to_agent_id: BOB,
      created_by_agent_id: BOB,
      files: ['src/ui/', 'README.md'],
      lease_expired: false,
    },
    {
      id: 'task-free',
      title: 'Écrire les tests',
      status: 'pending',
      priority: 1,
      assigned_to_agent_id: null,
      created_by_agent_id: BOB,
      files: [],
      lease_expired: null,
    },
  ],
  recent_quota_events: [],
}

const MESSAGES: RawMessage[] = [
  {
    id: 'msg-1',
    sender_agent_id: BOB,
    message_type: 'question',
    body: { text: 'Tu peux relire ma PR ?' },
    created_at: '2026-10-03T10:00:00Z',
    task_id: null,
  },
]

type Call = { tool: string; args: Record<string, unknown> }

/** A command as the person types it; the engine stamps origin and presentation. */
const cmd = (command: string, args = '') => ({ command, args }) as unknown as CommandRunInput
const typed = (text: string) => ({ text }) as unknown as PromptSubmitInput

type World = { status: Required<RawStatus>; messages: RawMessage[] }

/** A fake coordinator beneath the plugin: answers `$.mcp.call` from `world` and records each call. */
function fakeMesh(on: On, calls: Call[], server = 'mesh', world: World = { status: STATUS, messages: MESSAGES }) {
  on('tool.list', () => ({
    value: ['get_coordination_status', 'read_messages'].map(tool => ({ name: `mcp__${server}__${tool}`, description: '', mcp: true })),
  }))
  on('mcp.call', ($, e) => {
    if (e.server !== server) throw new Error(`no MCP server ${e.server}`)
    calls.push({ tool: e.tool, args: e.args })
    const answer: Record<string, unknown> = {
      get_coordination_status: world.status,
      read_messages: { count: world.messages.length, messages: world.messages },
      list_tasks: { tasks: world.status.active_tasks.map(t => ({ ...t, description: `Description de ${t.title}` })) },
      create_task: { id: 'task-new' },
    }
    const out = answer[e.tool] ?? { ok: true }
    return { value: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } }
  })
}

/** The engine's own answers the session start needs, beneath the plugin. */
function engineBasics(on: On, statuses: (string | undefined)[], toasts: string[] = []) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-test' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('pure helpers', () => {
  test('file patterns: exact file, directory, glob', () => {
    expect(matchesPattern('src/app.ts', 'src/app.ts')).toBe(true)
    expect(matchesPattern('src/app.ts', '/home/me/repo/src/app.ts')).toBe(true)
    expect(matchesPattern('src/app.ts', 'src/app.tsx')).toBe(false)
    expect(matchesPattern('src/ui/', 'src/ui/button.tsx')).toBe(true)
    expect(matchesPattern('src/ui/', 'src/uix/button.tsx')).toBe(false)
    expect(matchesPattern('src/**/*.test.ts', 'src/a/b/c.test.ts')).toBe(true)
    expect(matchesPattern('src/**/*.test.ts', 'src/c.test.ts')).toBe(true)
    expect(matchesPattern('*.md', 'docs/guide.md')).toBe(true)
    expect(matchesPattern('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(relativeTo('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/repo', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts')
  })

  test('thresholds and levels', () => {
    expect(parseThresholds(' 95, 80,abc,90,80,120')).toEqual([80, 90, 95])
    expect(crossedLevel([80, 90, 95], 79)).toBe(0)
    expect(crossedLevel([80, 90, 95], 91.5)).toBe(90)
    expect(crossedLevel([80, 90, 95], 100)).toBe(95)
  })

  test('tokens are masked, shapes kept', () => {
    expect(maskText(`token: ${TOKEN}.`)).toBe(`token: ${TOKEN.slice(0, 13)}…[masqué].`)
    expect(maskText('mesh_short stays')).toBe('mesh_short stays')
    expect(maskDeep({ a: [TOKEN, 3], b: { c: TOKEN } })).toEqual({
      a: [`${TOKEN.slice(0, 13)}…[masqué]`, 3],
      b: { c: `${TOKEN.slice(0, 13)}…[masqué]` },
    })
  })

  test('orphaned and expired tasks count as free', () => {
    const s = toSnapshot(
      {
        agents: STATUS.agents,
        active_tasks: [
          { id: 'a', title: 'orpheline', status: 'in_progress', assigned_to_agent_id: null, lease_expired: null },
          { id: 'b', title: 'expirée', status: 'claimed', assigned_to_agent_id: BOB, lease_expired: true },
          { id: 'c', title: 'tenue', status: 'in_progress', assigned_to_agent_id: BOB, lease_expired: false },
        ],
      },
      [],
      'mesh',
      [],
      1,
    )
    expect(freeTasks(s).map(t => t.id)).toEqual(['a', 'b'])
  })

  test('status line and digest read the snapshot', () => {
    const s = toSnapshot(STATUS, MESSAGES, 'mesh', [{ kind: 'five_hour', percentUsed: 87.4, resetsAt: null }], 1)
    expect(statusText(s)).toBe('mesh · 2/2 en ligne · 1 libre · ✉ 1 · 5h 87 %')
    const text = digest(s)
    expect(text).toContain('Moi : Claude-A (available)')
    expect(text).toContain('- Écrire les tests [task-free] priorité 1')
    expect(text).toContain('- Refonte UI — Claude-B — fichiers : src/ui/, README.md')
    expect(text).toContain('Messages non lus : 1 (de Claude-B)')
  })
})

describe('in a session', () => {
  test('registers, polls and draws the status line', async ($, on) => {
    const calls: Call[] = []
    const statuses: (string | undefined)[] = []
    engineBasics(on, statuses)
    fakeMesh(on, calls)

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await flush()

    expect(calls.map(c => c.tool)).toEqual(
      expect.arrayContaining(['register_session', 'heartbeat_session', 'get_coordination_status', 'read_messages']),
    )
    expect(calls.find(c => c.tool === 'read_messages')?.args).toEqual({ only_unread: true, mark_delivered: false, limit: 50 })
    // /inbox joins the poll in flight, so the status line is drawn once it resolves.
    await $.command.run(cmd('inbox', ''))
    expect(statuses.at(-1)).toBe('mesh · 2/2 en ligne · 1 libre · ✉ 1')
  })

  test('finds the server under another name', async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls, 'Claude_mesh')

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await flush()

    expect(calls.some(c => c.tool === 'get_coordination_status')).toBe(true)
  })

  test('/inbox lists the unread messages', async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await flush()

    const result = await $.command.run(cmd('inbox', ''))
    expect(result.text).toContain('1 message non lu')
    expect(result.text).toContain('[question] Claude-B')
    expect(result.text).toContain('Tu peux relire ma PR ?')
  })

  test('/tell sends a message', async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await flush()

    const result = await $.command.run(cmd('tell', 'Claude-B salut, je prends les tests'))
    expect(result.text).toBe('Message envoyé à Claude-B.')
    expect(calls.find(c => c.tool === 'send_message')?.args).toEqual({ to: 'Claude-B', text: 'salut, je prends les tests' })
  })

  test('an edit of a file another agent holds is flagged', async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls)
    on('tool.call', () => ({ result: { ok: true } }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await flush()

    const flagged = await $.tool.call({
      tool: 'Write',
      file_path: '/repo/src/ui/button.tsx',
      content: 'x',
    } as never)
    expect(flagged.context?.join('\n')).toContain('src/ui/button.tsx est réservé par Claude-B')

    const free = await $.tool.call({ tool: 'Write', file_path: '/repo/src/other.ts', content: 'x' } as never)
    expect(free.context ?? []).toEqual([])
  })

  test('with file_lock deny, the edit is refused', { options: { file_lock: 'deny' } }, async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls)
    on('tool.call', () => ({ result: { ok: true } }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await flush()

    const refused = await $.tool.call({ tool: 'Edit', file_path: '/repo/README.md', old_string: 'a', new_string: 'b' } as never)
    expect(refused.deny).toContain('README.md est réservé par Claude-B')
  })

  test('quota thresholds are reported once per window', async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await flush()

    const measure = (percentUsed: number) =>
      $.session.measure({
        context: { window: 200000 } as never,
        rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: '2026-10-03T15:00:00Z' }],
        changed: ['rateLimits'],
      })
    await measure(50)
    await measure(82)
    await measure(84)
    await flush()

    const reports = calls.filter(c => c.tool === 'report_quota_event').map(c => c.args)
    expect(reports).toEqual([
      { event_type: 'quota_warning', quota_window: 'five_hour', used_percentage: 82, resets_at: '2026-10-03T15:00:00Z' },
    ])
  })

  // The wake-up turn itself is queued by the engine until the session is idle,
  // which the test kit does not simulate: the toast raised with it is checked.
  test('a new message is announced once, not the ones already there', async ($, on) => {
    const calls: Call[] = []
    const toasts: string[] = []
    const world: World = { status: STATUS, messages: [...MESSAGES] }
    engineBasics(on, [], toasts)
    fakeMesh(on, calls, 'mesh', world)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run(cmd('inbox', ''))
    await $.command.run(cmd('inbox', ''))
    expect(toasts).toEqual([]) // the first poll only takes stock

    world.messages.push({ ...MESSAGES[0]!, id: 'msg-2', message_type: 'handoff', body: { text: 'je passe la main' } })
    await $.command.run(cmd('inbox', ''))
    await $.command.run(cmd('inbox', ''))
    await flush()
    expect(toasts).toEqual(['mesh : nouveau message'])
  })

  test('/handoff annotates and releases the tasks held, then tells the others', async ($, on) => {
    const calls: Call[] = []
    const mine = { ...STATUS.active_tasks[0]!, id: 'task-mine', title: 'Écrire les tests', assigned_to_agent_id: ME, files: [] }
    const world: World = { status: { ...STATUS, active_tasks: [STATUS.active_tasks[0]!, mine] }, messages: [] }
    engineBasics(on, [])
    fakeMesh(on, calls, 'mesh', world)
    on('model.fork', () => ({
      value: {
        isAnswered: true,
        text: 'Objectif : tests. Reste : CI.',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run(cmd('inbox', ''))

    const result = await $.command.run(cmd('handoff', 'fin de journée'))
    expect(result.text).toContain('Tâches libérées avec la note de passation : « Écrire les tests »')

    const updated = calls.find(c => c.tool === 'update_task')?.args
    expect(updated?.task_id).toBe('task-mine')
    expect(String(updated?.description)).toContain('Description de Écrire les tests')
    expect(String(updated?.description)).toContain('Note : fin de journée')
    expect(String(updated?.description)).toContain('Objectif : tests. Reste : CI.')
    expect(calls.find(c => c.tool === 'release_task')?.args).toEqual({ task_id: 'task-mine' })
    expect(calls.find(c => c.tool === 'send_message')?.args).toEqual(
      expect.objectContaining({ to: BOB, message_type: 'handoff' }),
    )
  })

  test('the mesh state rides beside a prompt only when it changed', async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls)
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run(cmd('inbox', ''))

    const first = await $.prompt.submit(typed('bonjour'))
    expect(first.context?.join('\n')).toContain('<mesh-status>')
    const second = await $.prompt.submit(typed('et ensuite ?'))
    expect(second.context ?? []).toEqual([])
  })

  test('the band shows the unread messages', async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run(cmd('inbox', ''))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'mesh-live',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
      })
      expect((await ui.find({ type: 'Text', text: /1 message de Claude-B/ }))).toBeDefined()
      expect(await ui.find({ key: 'mesh-band-read' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the pane lists agents, tasks and messages', async ($, on) => {
    const calls: Call[] = []
    engineBasics(on, [])
    fakeMesh(on, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run(cmd('inbox', ''))

    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'mesh-live',
        surface,
        component: 'Pane',
        requestId: 'mesh',
        props: { title: 'Mesh', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
      })
      expect(await ui.find({ key: 'claim-task-free' })).toBeDefined()
      expect(await ui.find({ key: 'ack-msg-1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Claude-B/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('tokens are masked in a reply', async ($, on) => {
    on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: [] }) as never)
    const ui = await $.ui.mount({
      plugin: 'mesh-live',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: `Voici le token : ${TOKEN}`, isFirstOfReply: true },
    })
    expect(JSON.stringify(await ui.drawn())).not.toContain(TOKEN)
    await ui.unmount()
  })

  test('a refused call stops the polling instead of asking again', async ($, on) => {
    const calls: Call[] = []
    const statuses: (string | undefined)[] = []
    engineBasics(on, statuses)
    on('tool.list', () => ({ value: [{ name: 'mcp__mesh__get_coordination_status', description: '', mcp: true }] }))
    on('mcp.call', ($, e) => {
      calls.push({ tool: e.tool, args: e.args })
      return { deny: 'refusé par la personne' }
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 3; i++) await $.command.run(cmd('inbox'))
    await flush()

    // One ask per call: no other server name tried, no register_session after a refused heartbeat.
    expect(calls.filter(c => c.tool === 'register_session')).toHaveLength(1)
    expect(statuses.at(-1)).toContain('en pause')
  })
})
