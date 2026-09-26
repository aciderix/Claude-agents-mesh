// Agent presence tools: register, heartbeat, list, status.
import { Ctx, ensureAgent, logEvent, MeshError, requireMember, Tool } from "../lib.ts";

const AGENT_STATUSES = ["available", "working", "blocked_by_quota", "waiting_for_reset", "needs_attention", "offline"];

/** Seconds since a timestamp, or null. */
function ageSeconds(ts: string | null): number | null {
  if (!ts) return null;
  return Math.round((Date.now() - new Date(ts).getTime()) / 1000);
}

export const agentTools: Tool[] = [
  {
    name: "register_session",
    description:
      "Register (or refresh) your agent in the workspace. Idempotent: one agent per member per workspace. Call this at session start. Identity comes from your token — you cannot register as someone else.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display label for this agent, e.g. 'Claude-A' or your project role." },
        session_id: { type: "string", description: "Optional Claude session id (e.g. $CLAUDE_SESSION_ID). Auto-generated if omitted." },
        capabilities: { type: "object", description: "Free-form JSON describing what this agent can do.", additionalProperties: true },
        status: { type: "string", enum: AGENT_STATUSES, description: "Initial status; defaults to 'available'." },
      },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const { id, created } = await ensureAgent(ctx, {
        name: args.name, sessionId: args.session_id, capabilities: args.capabilities,
        status: args.status ?? "available",
      });
      await logEvent(ctx, m.workspaceId, id, "session_registered", { created, name: args.name ?? null });
      return { agent_id: id, workspace_id: m.workspaceId, created, status: args.status ?? "available" };
    },
  },
  {
    name: "heartbeat_session",
    description: "Refresh your agent's presence (last_heartbeat_at) and optionally set its status. Call periodically so others see you as online.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: AGENT_STATUSES } },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const patch: Record<string, unknown> = { last_heartbeat_at: new Date().toISOString() };
      if (args.status) patch.status = args.status;
      const { data, error } = await ctx.supa.from("agents").update(patch)
        .eq("workspace_id", m.workspaceId).eq("user_id", m.userId)
        .select("id, status, last_heartbeat_at").maybeSingle();
      if (error) throw new MeshError(error.message);
      if (!data) throw new MeshError("no agent registered yet — call register_session first", -32004);
      return { agent_id: data.id, status: data.status, last_heartbeat_at: data.last_heartbeat_at };
    },
  },
  {
    name: "list_agents",
    description:
      "List all agents in your workspace with status and staleness. An agent whose last heartbeat is older than stale_after_seconds (default 120) is flagged offline_by_staleness so you can tell who is really present.",
    inputSchema: {
      type: "object",
      properties: { stale_after_seconds: { type: "integer", minimum: 30, default: 120 } },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const stale = Number(args.stale_after_seconds ?? 120);
      const { data } = await ctx.supa.from("agents")
        .select("id, account_label, status, capabilities, session_id, last_heartbeat_at, user_id, created_at")
        .eq("workspace_id", m.workspaceId).order("created_at", { ascending: true });
      return {
        workspace_id: m.workspaceId,
        agents: (data ?? []).map((a) => {
          const age = ageSeconds(a.last_heartbeat_at);
          return {
            ...a, is_me: a.user_id === m.userId,
            heartbeat_age_seconds: age,
            offline_by_staleness: age === null ? true : age > stale,
          };
        }),
      };
    },
  },
  {
    name: "get_agent_status",
    description: "Get one agent's full status by agent id (UUID) or account label.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", description: "Agent id (UUID) or account_label." } },
      required: ["agent"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const ref = String(args.agent);
      const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
      const base = ctx.supa.from("agents")
        .select("id, account_label, status, capabilities, session_id, last_heartbeat_at, user_id, created_at, updated_at")
        .eq("workspace_id", m.workspaceId);
      const { data } = isUuid ? await base.eq("id", ref).maybeSingle() : await base.eq("account_label", ref).maybeSingle();
      if (!data) throw new MeshError(`no agent "${ref}" in this workspace`, -32005);
      return { ...data, heartbeat_age_seconds: ageSeconds(data.last_heartbeat_at) };
    },
  },
];
