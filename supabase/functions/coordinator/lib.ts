// Shared library for the Claude Agents Mesh MCP server (Supabase Edge Function).
//
// Trust model: this function is the security boundary. It runs with the
// service_role key (injected by Supabase, never shipped in the repo), which
// bypasses RLS. Every request is authenticated from the `Authorization: Bearer`
// header before any data is touched, and identity is ALWAYS derived from the
// token, never from arguments the MCP client sends.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// The one secret the deployer must set themselves. Acts as the master/admin
// credential that can create workspaces and mint member tokens.
const BOOTSTRAP_SECRET = Deno.env.get("MESH_BOOTSTRAP_SECRET") ?? "";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
};

export function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---- token helpers ---------------------------------------------------------

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(): { raw: string; prefix: string } {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = `mesh_${hex}`;
  return { raw, prefix: raw.slice(0, 13) }; // "mesh_" + 8 hex chars
}

// ---- authentication --------------------------------------------------------

export type Principal =
  | { kind: "bootstrap" }
  | {
    kind: "member";
    tokenId: string;
    workspaceId: string;
    userId: string;
    role: "owner" | "member";
  };

export class MeshError extends Error {
  constructor(message: string, public code = -32000) {
    super(message);
  }
}

/** Resolve the bearer token to a principal. Throws MeshError on failure. */
export async function authenticate(req: Request, supa: SupabaseClient): Promise<Principal> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new MeshError("missing Authorization: Bearer <token> header", -32001);

  if (BOOTSTRAP_SECRET && token === BOOTSTRAP_SECRET) {
    return { kind: "bootstrap" };
  }

  const hash = await sha256Hex(token);
  const { data, error } = await supa
    .from("member_tokens")
    .select("id, workspace_id, user_id, role, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();

  if (error) throw new MeshError(`token lookup failed: ${error.message}`, -32002);
  if (!data || data.revoked_at) throw new MeshError("invalid or revoked token", -32001);

  // Best-effort last-used timestamp; never block the request on it.
  supa.from("member_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id)
    .then(() => {}, () => {});

  return {
    kind: "member",
    tokenId: data.id,
    workspaceId: data.workspace_id,
    userId: data.user_id,
    role: data.role,
  };
}

export function requireMember(p: Principal): Extract<Principal, { kind: "member" }> {
  if (p.kind !== "member") {
    throw new MeshError("this tool needs a member token (mesh_...), not the bootstrap token", -32003);
  }
  return p;
}

export function requireOwnerOrBootstrap(p: Principal): void {
  if (p.kind === "bootstrap") return;
  if (p.kind === "member" && p.role === "owner") return;
  throw new MeshError("this tool requires an owner or the bootstrap token", -32003);
}

// ---- shared data helpers ---------------------------------------------------

export interface Ctx {
  supa: SupabaseClient;
  principal: Principal;
}

// deno-lint-ignore no-explicit-any
export type Json = any;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  handler: (ctx: Ctx, args: Json) => Promise<Json>;
}

/** Ensure the caller has an agent row in their workspace; return its id. */
export async function ensureAgent(
  ctx: Ctx,
  opts: { sessionId?: string; name?: string; capabilities?: unknown; status?: string } = {},
): Promise<{ id: string; created: boolean }> {
  const m = requireMember(ctx.principal);
  const { data: existing } = await ctx.supa
    .from("agents").select("id").eq("workspace_id", m.workspaceId).eq("user_id", m.userId).maybeSingle();

  if (existing) {
    const patch: Record<string, unknown> = { last_heartbeat_at: new Date().toISOString() };
    if (opts.sessionId) patch.session_id = opts.sessionId;
    if (opts.name) patch.account_label = opts.name;
    if (opts.capabilities !== undefined) patch.capabilities = opts.capabilities;
    if (opts.status) patch.status = opts.status;
    await ctx.supa.from("agents").update(patch).eq("id", existing.id);
    return { id: existing.id, created: false };
  }

  const label = opts.name ?? m.userId.slice(0, 8);
  const sessionId = opts.sessionId ?? `sess_${crypto.randomUUID()}`;
  const { data, error } = await ctx.supa.from("agents").insert({
    workspace_id: m.workspaceId,
    user_id: m.userId,
    account_label: label,
    session_id: sessionId,
    status: opts.status ?? "available",
    capabilities: opts.capabilities ?? {},
    last_heartbeat_at: new Date().toISOString(),
  }).select("id").single();
  if (error) throw new MeshError(`could not register agent: ${error.message}`);
  return { id: data.id, created: true };
}

/** Look up the caller's agent id (must already exist). */
export async function myAgentId(ctx: Ctx): Promise<string> {
  const m = requireMember(ctx.principal);
  const { data } = await ctx.supa
    .from("agents").select("id").eq("workspace_id", m.workspaceId).eq("user_id", m.userId).maybeSingle();
  if (!data) throw new MeshError("no agent registered yet — call register_session first", -32004);
  return data.id;
}

export async function logEvent(
  ctx: Ctx, workspaceId: string, actorAgentId: string | null, type: string, payload: unknown = {},
): Promise<void> {
  await ctx.supa.from("events").insert({
    workspace_id: workspaceId, actor_agent_id: actorAgentId, event_type: type, payload: payload ?? {},
  }).then(() => {}, () => {});
}

/** Resolve a recipient reference (agent id UUID or account_label) to an agent id in the workspace. */
export async function resolveAgentRef(ctx: Ctx, workspaceId: string, ref: string): Promise<string> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const q = ctx.supa.from("agents").select("id").eq("workspace_id", workspaceId);
  const { data } = isUuid ? await q.eq("id", ref).maybeSingle() : await q.eq("account_label", ref).maybeSingle();
  if (!data) throw new MeshError(`no agent "${ref}" in this workspace`, -32005);
  return data.id;
}
