import type { PluginOptions } from 'claude-code'

export type FileLockMode = 'warn' | 'deny' | 'off'

export type Options = {
  meshServer: string
  agentName: string
  pollMs: number
  wakeOnMessage: boolean
  wakeOnTask: boolean
  showBand: boolean
  showStatus: boolean
  reportQuota: boolean
  quotaThresholds: number[]
  autoHandoff: boolean
  handoffThreshold: number
  keepLeases: boolean
  releaseOnExit: boolean
  injectContext: boolean
  fileLock: FileLockMode
  maskTokens: boolean
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v.trim() : fallback)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

/** Parses "80, 90,95" into [80, 90, 95]: sorted, deduplicated, each in 1..100. */
export function parseThresholds(text: string): number[] {
  const values = text
    .split(',')
    .map(part => Number(part.trim()))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 100)
  return [...new Set(values)].sort((a, b) => a - b)
}

export function readOptions(options: PluginOptions): Options {
  const lock = str(options.file_lock, 'warn')
  return {
    meshServer: str(options.mesh_server, 'mesh') || 'mesh',
    agentName: str(options.agent_name, ''),
    pollMs: Math.max(10, num(options.poll_seconds, 30)) * 1000,
    wakeOnMessage: bool(options.wake_on_message, true),
    wakeOnTask: bool(options.wake_on_task, true),
    showBand: bool(options.show_band, true),
    showStatus: bool(options.show_status, true),
    reportQuota: bool(options.report_quota, true),
    quotaThresholds: parseThresholds(str(options.quota_thresholds, '80,90,95')),
    autoHandoff: bool(options.auto_handoff, true),
    handoffThreshold: Math.min(100, Math.max(1, num(options.handoff_threshold, 95))),
    keepLeases: bool(options.keep_leases, true),
    releaseOnExit: bool(options.release_on_exit, true),
    injectContext: bool(options.inject_context, true),
    fileLock: lock === 'deny' || lock === 'off' ? lock : 'warn',
    maskTokens: bool(options.mask_tokens, true),
  }
}
