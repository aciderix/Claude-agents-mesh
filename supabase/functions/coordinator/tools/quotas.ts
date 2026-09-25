// Claude Code quota reporting + coordination overview.
import { Ctx, MeshError, myAgentId, requireMember, Tool } from "../lib.ts";

const QUOTA_EVENTS = ["quota_warning", "quota_blocked", "quota_reset", "quota_auto_resumed", "quota_resume_disabled"];
const QUOTA_WINDOWS = ["five_hour", "seven_day", "spend_limit"];

export const quotaTools: Tool[] = [
  {
    name: "report_quota_event",
    description:
      "Report a Claude Code quota event for your agent. 'quota_blocked' sets your status to blocked_by_quota; 'quota_reset'/'quota_auto_resumed' set it back to available; 'quota_warning' sets needs_attention. Lets other agents know when to take over or that you are back.",
    inputSchema: {
      type: "object",
      properties: {
        event_type: { type: "string", enum: QUOTA_EVENTS },
        quota_window: { type: "string", enum: QUOTA_WINDOWS },
        used_percentage: { type: "number", minimum: 0, maximum: 100 },
        resets_at: { type: "string", description: "ISO 8601 timestamp when the quota resets." },
        error_type: { type: "string" },
        error_details: { type: "object", additionalProperties: true },
      },
      required: ["event_type"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const { data, error } = await ctx.supa.rpc("mesh_report_quota_event", {
        p_workspace_id: m.workspaceId, p_agent_id: myId, p_user_id: m.userId,
        p_event_type: String(args.event_type), p_quota_window: args.quota_window ?? null,
        p_used_percentage: args.used_percentage ?? null, p_resets_at: args.resets_at ?? null,
        p_error_type: args.error_type ?? null, p_error_details: args.error_details ?? null,
      });
      if (error) throw new MeshError(`report_quota_event failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      return row ?? { ok: true };
    },
  },
  {
    name: "get_quota_status",
    description: "Summarize quota state across the workspace: each agent's status and its most recent quota event.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (ctx) => {
      const m = requireMember(ctx.principal);
      const { data: agents } = await ctx.supa.from("agents")
        .select("id, account_label, status").eq("workspace_id", m.workspaceId);
      const { data: recent } = await ctx.supa.from("quota_events")
        .select("agent_id, event_type, quota_window, used_percentage, resets_at, created_at")
        .eq("workspace_id", m.workspaceId).order("created_at", { ascending: false }).limit(100);
      const latest = new Map<string, unknown>();
      for (const e of recent ?? []) if (!latest.has(e.agent_id)) latest.set(e.agent_id, e);
      return {
        workspace_id: m.workspaceId,
        agents: (agents ?? []).map((a) => ({ ...a, latest_quota_event: latest.get(a.id) ?? null })),
      };
    },
  },
  {
    name: "get_coordination_status",
    description:
      "One-shot overview of the workspace: agents + presence, active tasks + leases, recent quota events, and recent messages. Use it at session start to understand the current state of the collaboration.",
    inputSchema: {
      type: "object",
      properties: { stale_after_seconds: { type: "integer", minimum: 30, default: 120 } },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const stale = Number(args.stale_after_seconds ?? 120);
      const now = Date.now();
      const [agentsR, tasksR, quotaR, msgR] = await Promise.all([
        ctx.supa.from("agents").select("id, account_label, status, last_heartbeat_at, user_id").eq("workspace_id", m.workspaceId),
        ctx.supa.from("tasks").select("id, title, status, priority, assigned_to_agent_id, lease_until, created_at")
          .eq("workspace_id", m.workspaceId).in("status", ["pending", "claimed", "in_progress"])
          .order("priority", { ascending: false }).limit(100),
        ctx.supa.from("quota_events").select("agent_id, event_type, quota_window, resets_at, created_at")
          .eq("workspace_id", m.workspaceId).order("created_at", { ascending: false }).limit(10),
        ctx.supa.from("messages").select("id, sender_agent_id, recipient_agent_id, message_type, status, created_at")
          .eq("workspace_id", m.workspaceId).order("created_at", { ascending: false }).limit(10),
      ]);
      return {
        workspace_id: m.workspaceId,
        agents: (agentsR.data ?? []).map((a) => {
          const age = a.last_heartbeat_at ? Math.round((now - new Date(a.last_heartbeat_at).getTime()) / 1000) : null;
          return { ...a, is_me: a.user_id === m.userId, heartbeat_age_seconds: age, online: age !== null && age <= stale };
        }),
        active_tasks: (tasksR.data ?? []).map((t) => ({ ...t, lease_expired: t.lease_until ? new Date(t.lease_until).getTime() < now : null })),
        recent_quota_events: quotaR.data ?? [],
        recent_messages: msgR.data ?? [],
      };
    },
  },
];
