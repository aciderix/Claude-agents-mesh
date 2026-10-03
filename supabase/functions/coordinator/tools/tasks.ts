// Shared task queue with lease-based claiming.
import { Ctx, logEvent, MeshError, myAgentId, requireMember, Tool } from "../lib.ts";

const TASK_STATUSES = ["pending", "claimed", "in_progress", "completed", "failed", "cancelled"];

const FILES_SCHEMA = {
  type: "array",
  items: { type: "string" },
  maxItems: 200,
  description:
    "Repo-relative paths this task edits: a file ('src/app.ts'), a directory ending in '/' ('src/ui/') or a glob ('src/**/*.test.ts'). Other agents are warned before editing them.",
};

/** Trim, drop empties and duplicates, strip a leading "./"; never more than 200 entries. */
function normalizeFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const out = new Set<string>();
  for (const f of files) {
    const v = String(f ?? "").trim().replace(/^\.\//, "");
    if (v) out.add(v);
  }
  return [...out].slice(0, 200);
}

async function rpcSingle(ctx: Ctx, fn: string, params: Record<string, unknown>) {
  const { data, error } = await ctx.supa.rpc(fn, params);
  if (error) throw new MeshError(`${fn} failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}

export const taskTools: Tool[] = [
  {
    name: "create_task",
    description: "Create a task in the shared queue (status 'pending'). Any member can then claim it. You are recorded as the creator.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "integer", description: "Higher = more urgent. Default 0." },
        files: FILES_SCHEMA,
      },
      required: ["title"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const { data, error } = await ctx.supa.from("tasks").insert({
        workspace_id: m.workspaceId, created_by_agent_id: myId, title: String(args.title),
        description: args.description ?? null, priority: Number(args.priority ?? 0), status: "pending",
        files: normalizeFiles(args.files),
      }).select("*").single();
      if (error) throw new MeshError(error.message);
      await logEvent(ctx, m.workspaceId, myId, "task_created", { task_id: data.id, title: data.title });
      return data;
    },
  },
  {
    name: "list_tasks",
    description: "List tasks in your workspace, newest first. Filter by status. Expired leases are visible via lease_until in the past.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: TASK_STATUSES },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      let q = ctx.supa.from("tasks").select("*").eq("workspace_id", m.workspaceId)
        .order("priority", { ascending: false }).order("created_at", { ascending: false })
        .limit(Number(args.limit ?? 50));
      if (args.status) q = q.eq("status", args.status);
      const { data, error } = await q;
      if (error) throw new MeshError(error.message);
      const now = Date.now();
      return {
        count: (data ?? []).length,
        tasks: (data ?? []).map((t) => ({ ...t, lease_expired: t.lease_until ? new Date(t.lease_until).getTime() < now : null })),
      };
    },
  },
  {
    name: "claim_task",
    description:
      "Atomically claim a pending task (or one whose lease has expired) with a temporary lease. Race-safe: only one agent wins. Renew with heartbeat_task before lease_seconds elapse or another agent may take over.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        lease_seconds: { type: "integer", minimum: 15, maximum: 3600, default: 60 },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const row = await rpcSingle(ctx, "mesh_claim_task", {
        p_task_id: String(args.task_id), p_agent_id: myId, p_user_id: m.userId, p_lease_seconds: Number(args.lease_seconds ?? 60),
      });
      if (!row) throw new MeshError("could not claim: task not pending, lease still active, or not in your workspace", -32006);
      await logEvent(ctx, m.workspaceId, myId, "task_claimed", { task_id: row.id });
      return row;
    },
  },
  {
    name: "heartbeat_task",
    description: "Renew the lease on a task you hold and mark it in_progress. Call periodically while working so the lease does not expire.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        lease_seconds: { type: "integer", minimum: 15, maximum: 3600, default: 60 },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const row = await rpcSingle(ctx, "mesh_heartbeat_task", {
        p_task_id: String(args.task_id), p_agent_id: myId, p_user_id: m.userId, p_lease_seconds: Number(args.lease_seconds ?? 60),
      });
      if (!row) throw new MeshError("could not heartbeat: you do not hold this task", -32006);
      return row;
    },
  },
  {
    name: "release_task",
    description: "Release a task you hold back to 'pending' so another agent can claim it.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const row = await rpcSingle(ctx, "mesh_release_task", {
        p_task_id: String(args.task_id), p_agent_id: myId, p_user_id: m.userId,
      });
      if (!row) throw new MeshError("could not release: you do not hold this task", -32006);
      await logEvent(ctx, m.workspaceId, myId, "task_released", { task_id: row.id });
      return row;
    },
  },
  {
    name: "complete_task",
    description: "Mark a task you hold as completed and store a JSON result. Records an event so the creator can see the outcome.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        result: { type: "object", description: "JSON result/artifacts.", additionalProperties: true },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const row = await rpcSingle(ctx, "mesh_complete_task", {
        p_task_id: String(args.task_id), p_agent_id: myId, p_user_id: m.userId, p_result: args.result ?? {},
      });
      if (!row) throw new MeshError("could not complete: you do not hold this task", -32006);
      await logEvent(ctx, m.workspaceId, myId, "task_completed", { task_id: row.id });
      return row;
    },
  },
  {
    name: "update_task",
    description:
      "Update a task's title, description, priority, status (e.g. to 'cancelled' or 'failed') or the files it touches. Only the creator or current assignee may update it.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "integer" },
        status: { type: "string", enum: TASK_STATUSES },
        files: FILES_SCHEMA,
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const { data: task } = await ctx.supa.from("tasks")
        .select("id, created_by_agent_id, assigned_to_agent_id").eq("id", String(args.task_id))
        .eq("workspace_id", m.workspaceId).maybeSingle();
      if (!task) throw new MeshError("task not found in your workspace", -32005);
      if (task.created_by_agent_id !== myId && task.assigned_to_agent_id !== myId) {
        throw new MeshError("only the creator or assignee can update this task", -32003);
      }
      const patch: Record<string, unknown> = {};
      for (const k of ["title", "description", "priority", "status"]) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      if (args.files !== undefined) patch.files = normalizeFiles(args.files);
      if (!Object.keys(patch).length) throw new MeshError("nothing to update");
      const { data, error } = await ctx.supa.from("tasks").update(patch).eq("id", task.id).select("*").single();
      if (error) throw new MeshError(error.message);
      return data;
    },
  },
];
