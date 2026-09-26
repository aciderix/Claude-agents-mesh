// Persistent messaging between agents.
import { Ctx, logEvent, MeshError, myAgentId, requireMember, resolveAgentRef, Tool } from "../lib.ts";

export const messageTools: Tool[] = [
  {
    name: "send_message",
    description:
      "Send a persistent message to another agent in your workspace. The recipient is addressed by agent id (UUID) or account label. The message survives session restarts and is delivered when the recipient calls read_messages.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent id (UUID) or account_label." },
        text: { type: "string", description: "Message text. Stored as {text: ...} unless 'body' is given." },
        body: { type: "object", description: "Structured JSON payload (overrides 'text' if both given).", additionalProperties: true },
        message_type: { type: "string", description: "Free-form type tag, e.g. 'text', 'handoff', 'question'. Default 'text'." },
        task_id: { type: "string", description: "Optional task this message relates to." },
        correlation_id: { type: "string", description: "Optional id to thread a request/response pair." },
      },
      required: ["to"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const senderId = await myAgentId(ctx);
      const recipientId = await resolveAgentRef(ctx, m.workspaceId, String(args.to));
      const body = args.body ?? { text: String(args.text ?? "") };
      if (!args.body && !args.text) throw new MeshError("provide 'text' or 'body'");
      const { data, error } = await ctx.supa.from("messages").insert({
        workspace_id: m.workspaceId, sender_agent_id: senderId, recipient_agent_id: recipientId,
        task_id: args.task_id ?? null, message_type: args.message_type ?? "text", body,
        correlation_id: args.correlation_id ?? null, status: "pending",
      }).select("id, created_at").single();
      if (error) throw new MeshError(`could not send: ${error.message}`);
      await logEvent(ctx, m.workspaceId, senderId, "message_sent", { message_id: data.id, to: recipientId });
      return { message_id: data.id, to: recipientId, created_at: data.created_at, status: "pending" };
    },
  },
  {
    name: "read_messages",
    description:
      "Read messages addressed to you. By default returns undelivered/unacknowledged messages and marks them delivered. The database stays the source of truth, so nothing is lost if you were offline.",
    inputSchema: {
      type: "object",
      properties: {
        only_unread: { type: "boolean", description: "Only messages not yet acknowledged (default true)." },
        mark_delivered: { type: "boolean", description: "Mark returned pending messages as delivered (default true)." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const onlyUnread = args.only_unread !== false;
      const limit = Number(args.limit ?? 50);
      let q = ctx.supa.from("messages")
        .select("id, sender_agent_id, task_id, message_type, body, status, correlation_id, created_at, delivered_at, acknowledged_at")
        .eq("workspace_id", m.workspaceId).eq("recipient_agent_id", myId)
        .order("created_at", { ascending: true }).limit(limit);
      if (onlyUnread) q = q.neq("status", "acknowledged");
      const { data, error } = await q;
      if (error) throw new MeshError(error.message);
      const msgs = data ?? [];
      if (args.mark_delivered !== false) {
        const toMark = msgs.filter((x) => x.status === "pending").map((x) => x.id);
        if (toMark.length) {
          await ctx.supa.from("messages").update({ status: "delivered", delivered_at: new Date().toISOString() })
            .in("id", toMark);
        }
      }
      return { count: msgs.length, messages: msgs };
    },
  },
  {
    name: "ack_message",
    description: "Acknowledge a message you received, marking it handled. Only the recipient can acknowledge.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const m = requireMember(ctx.principal);
      const myId = await myAgentId(ctx);
      const { data, error } = await ctx.supa.from("messages")
        .update({ status: "acknowledged", acknowledged_at: new Date().toISOString() })
        .eq("id", String(args.message_id)).eq("recipient_agent_id", myId)
        .select("id, status, acknowledged_at").maybeSingle();
      if (error) throw new MeshError(error.message);
      if (!data) throw new MeshError("message not found or not addressed to you", -32005);
      await logEvent(ctx, m.workspaceId, myId, "message_acknowledged", { message_id: data.id });
      return data;
    },
  },
];
