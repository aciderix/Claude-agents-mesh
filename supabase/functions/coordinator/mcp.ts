// MCP (Model Context Protocol) JSON-RPC handling over Streamable HTTP.
// Implements initialize / tools/list / tools/call / ping and swallows notifications.
import { Ctx, Json, Tool } from "./lib.ts";
import { workspaceTools } from "./tools/workspaces.ts";
import { agentTools } from "./tools/agents.ts";
import { messageTools } from "./tools/messages.ts";
import { taskTools } from "./tools/tasks.ts";
import { quotaTools } from "./tools/quotas.ts";

export const SERVER_NAME = "claude-agents-mesh";
export const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

export const TOOLS: Tool[] = [
  ...workspaceTools,
  ...agentTools,
  ...taskTools,
  ...messageTools,
  ...quotaTools,
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

function result(id: Json, res: Json) {
  return { jsonrpc: "2.0", id, result: res };
}
function rpcError(id: Json, code: number, message: string, data?: Json) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

/**
 * Handle one JSON-RPC message. Returns null for notifications (no response).
 * `resolveCtx` authenticates lazily: only tools/call needs a valid token, so
 * initialize/tools/list stay open for discovery and a bad token surfaces as a
 * readable tool error rather than a hard connection failure.
 */
export async function handleRpc(msg: RpcRequest, resolveCtx: () => Promise<Ctx>): Promise<Json | null> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Coordination hub for multiple Claude Code sessions sharing a Supabase project. " +
          "Call whoami to confirm identity, register_session at start, then use tasks/messages/quota tools to collaborate.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications: no reply

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });

    case "tools/call": {
      const name = params?.name as string;
      const args = (params?.arguments ?? {}) as Json;
      const tool = TOOL_MAP.get(name);
      if (!tool) return rpcError(id, -32601, `unknown tool: ${name}`);
      try {
        const ctx = await resolveCtx();
        const out = await tool.handler(ctx, args);
        return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Tool-level errors are returned as isError content so Claude can read and react.
        return result(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
