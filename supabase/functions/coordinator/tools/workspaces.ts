// Workspace + membership + token administration tools.
import {
  Ctx, MeshError, newToken, requireOwnerOrBootstrap, sha256Hex, Tool,
} from "../lib.ts";

/** Create an auth.users row so agents/workspaces FKs stay valid. Returns the user id. */
async function createIdentity(ctx: Ctx, label: string): Promise<string> {
  // Synthetic email keeps the account unique without requiring a real inbox.
  const email = label.includes("@") ? label : `${label.replace(/[^a-z0-9]+/gi, "-")}.${crypto.randomUUID().slice(0, 8)}@mesh.local`;
  const { data, error } = await ctx.supa.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { mesh_label: label },
  });
  if (error || !data?.user) throw new MeshError(`could not create identity: ${error?.message ?? "unknown"}`);
  return data.user.id;
}

async function mintToken(
  ctx: Ctx, workspaceId: string, userId: string, role: "owner" | "member", label: string, createdBy: string | null,
): Promise<{ raw: string; prefix: string }> {
  const { raw, prefix } = newToken();
  const token_hash = await sha256Hex(raw);
  const { error } = await ctx.supa.from("member_tokens").insert({
    workspace_id: workspaceId, user_id: userId, role, label, token_hash, token_prefix: prefix, created_by: createdBy,
  });
  if (error) throw new MeshError(`could not store token: ${error.message}`);
  return { raw, prefix };
}

export const workspaceTools: Tool[] = [
  {
    name: "whoami",
    description:
      "Return the identity resolved from your bearer token: principal kind, workspace, user id, role, and your agent id if registered. Use this first to confirm you are connected and identified.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (ctx) => {
      if (ctx.principal.kind === "bootstrap") {
        return { kind: "bootstrap", note: "Admin/master token. Use create_workspace or invite_member, then switch to a member token (mesh_...) for agent work." };
      }
      const m = ctx.principal;
      const { data: agent } = await ctx.supa.from("agents")
        .select("id, account_label, status, session_id, last_heartbeat_at")
        .eq("workspace_id", m.workspaceId).eq("user_id", m.userId).maybeSingle();
      const { data: ws } = await ctx.supa.from("workspaces").select("name").eq("id", m.workspaceId).maybeSingle();
      return {
        kind: "member", workspace_id: m.workspaceId, workspace_name: ws?.name ?? null,
        user_id: m.userId, role: m.role, agent: agent ?? null,
        registered: !!agent,
      };
    },
  },
  {
    name: "create_workspace",
    description:
      "Create a shared workspace and its first owner. Bootstrap token only. Returns the owner's member token (mesh_...): switch your MCP Authorization header to it for all agent work. Keep it secret.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human name of the workspace, e.g. 'mon-projet'." },
        owner_label: { type: "string", description: "Label/email for the owner (identification only, never emailed)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      if (ctx.principal.kind !== "bootstrap") {
        throw new MeshError("create_workspace requires the bootstrap token (MESH_BOOTSTRAP_SECRET)", -32003);
      }
      const name = String(args.name).trim();
      if (!name) throw new MeshError("name is required");
      const ownerLabel = String(args.owner_label ?? "owner");
      const ownerId = await createIdentity(ctx, ownerLabel);
      // Insert workspace; the add_workspace_creator_as_owner trigger adds the owner member row.
      const { data: ws, error } = await ctx.supa.from("workspaces")
        .insert({ name, created_by: ownerId }).select("id, name, created_at").single();
      if (error) throw new MeshError(`could not create workspace: ${error.message}`);
      const token = await mintToken(ctx, ws.id, ownerId, "owner", ownerLabel, ownerId);
      return {
        workspace_id: ws.id, workspace_name: ws.name, owner_user_id: ownerId,
        owner_token: token.raw, token_prefix: token.prefix,
        next: "Set your MCP header to `Authorization: Bearer <owner_token>` and call register_session. Invite others with invite_member.",
      };
    },
  },
  {
    name: "invite_member",
    description:
      "Create a new member identity + access token for a workspace. Owner or bootstrap token. Returns a mesh_ token to hand to that person (share the MCP URL + this token). The label/email is for identification only and is never emailed.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Email or name identifying the invitee (identification only)." },
        role: { type: "string", enum: ["member", "owner"], description: "Defaults to 'member'." },
        workspace_id: { type: "string", description: "Required only when using the bootstrap token; ignored for a member token (uses your own workspace)." },
      },
      required: ["label"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      requireOwnerOrBootstrap(ctx.principal);
      const label = String(args.label).trim();
      if (!label) throw new MeshError("label is required");
      const role = (args.role === "owner" ? "owner" : "member") as "owner" | "member";
      let workspaceId: string;
      let createdBy: string | null = null;
      if (ctx.principal.kind === "member") {
        workspaceId = ctx.principal.workspaceId;
        createdBy = ctx.principal.userId;
      } else {
        if (!args.workspace_id) throw new MeshError("workspace_id is required when using the bootstrap token");
        workspaceId = String(args.workspace_id);
      }
      const userId = await createIdentity(ctx, label);
      const { error: memErr } = await ctx.supa.from("workspace_members")
        .insert({ workspace_id: workspaceId, user_id: userId, role });
      if (memErr) throw new MeshError(`could not add member: ${memErr.message}`);
      const token = await mintToken(ctx, workspaceId, userId, role, label, createdBy);
      return {
        workspace_id: workspaceId, user_id: userId, role, label,
        token: token.raw, token_prefix: token.prefix,
        next: "Give this person the MCP URL and this token. They set `Authorization: Bearer <token>` and call register_session.",
      };
    },
  },
  {
    name: "list_workspace_members",
    description: "List the members of your workspace with their role and whether they have a registered agent. Any member token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (ctx) => {
      const m = requireMemberPrincipal(ctx);
      const { data: members } = await ctx.supa.from("workspace_members")
        .select("user_id, role, created_at").eq("workspace_id", m.workspaceId);
      const { data: agents } = await ctx.supa.from("agents")
        .select("id, user_id, account_label, status, last_heartbeat_at").eq("workspace_id", m.workspaceId);
      const byUser = new Map((agents ?? []).map((a) => [a.user_id, a]));
      return {
        workspace_id: m.workspaceId,
        members: (members ?? []).map((mem) => ({
          user_id: mem.user_id, role: mem.role, joined_at: mem.created_at, agent: byUser.get(mem.user_id) ?? null,
        })),
      };
    },
  },
  {
    name: "list_tokens",
    description: "List access tokens issued for your workspace (prefix + label + status only; raw tokens are never shown). Owner or bootstrap.",
    inputSchema: {
      type: "object",
      properties: { workspace_id: { type: "string", description: "Required only for the bootstrap token." } },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      requireOwnerOrBootstrap(ctx.principal);
      const workspaceId = ctx.principal.kind === "member" ? ctx.principal.workspaceId : String(args.workspace_id ?? "");
      if (!workspaceId) throw new MeshError("workspace_id is required when using the bootstrap token");
      const { data } = await ctx.supa.from("member_tokens")
        .select("id, token_prefix, label, role, created_at, last_used_at, revoked_at")
        .eq("workspace_id", workspaceId).order("created_at", { ascending: true });
      return { workspace_id: workspaceId, tokens: data ?? [] };
    },
  },
  {
    name: "revoke_token",
    description: "Revoke an access token by its id (from list_tokens). The holder can no longer authenticate. Owner or bootstrap.",
    inputSchema: {
      type: "object",
      properties: { token_id: { type: "string" } },
      required: ["token_id"],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      requireOwnerOrBootstrap(ctx.principal);
      const q = ctx.supa.from("member_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", String(args.token_id));
      if (ctx.principal.kind === "member") q.eq("workspace_id", ctx.principal.workspaceId);
      const { data, error } = await q.select("id, token_prefix, label").maybeSingle();
      if (error) throw new MeshError(error.message);
      if (!data) throw new MeshError("token not found in your scope", -32005);
      return { revoked: data };
    },
  },
];

function requireMemberPrincipal(ctx: Ctx) {
  if (ctx.principal.kind !== "member") throw new MeshError("this tool needs a member token (mesh_...)", -32003);
  return ctx.principal;
}
