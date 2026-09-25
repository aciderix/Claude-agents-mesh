// Claude Agents Mesh — MCP coordinator (Supabase Edge Function).
//
// Endpoint (after deploy):
//   https://<project-ref>.supabase.co/functions/v1/coordinator/mcp
//
// Transport: MCP Streamable HTTP. Clients POST JSON-RPC; this server replies with
// a single JSON body (no server-initiated SSE stream in v1). Authentication is a
// bearer token in the Authorization header, resolved to an identity server-side.
//
// Deploy with verify_jwt = false so our own bearer tokens (mesh_... and the
// bootstrap secret) reach this code instead of being rejected by the platform.
import { admin, authenticate, CORS_HEADERS, Ctx, Json, MeshError, Principal } from "./lib.ts";
import { handleRpc, SERVER_NAME, SERVER_VERSION, TOOLS } from "./mcp.ts";

function json(body: Json, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Simple health/info endpoint for humans and uptime checks.
  if (req.method === "GET") {
    if (path.endsWith("/health") || path.endsWith("/coordinator") || path.endsWith("/coordinator/")) {
      return json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, tools: TOOLS.length, transport: "streamable-http (POST)" });
    }
    // MCP GET (SSE stream) is not implemented; tell the client to POST.
    return json({ error: "use POST for MCP JSON-RPC" }, 405, { Allow: "POST, OPTIONS" });
  }

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, { Allow: "POST, GET, OPTIONS" });
  }

  let body: Json;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }

  const supa = admin();

  // Lazy, cached authentication — only invoked by tools/call.
  let cachedPrincipal: Principal | null = null;
  const resolveCtx = async (): Promise<Ctx> => {
    if (!cachedPrincipal) cachedPrincipal = await authenticate(req, supa);
    return { supa, principal: cachedPrincipal };
  };

  try {
    if (Array.isArray(body)) {
      const responses: Json[] = [];
      for (const msg of body) {
        const r = await handleRpc(msg, resolveCtx);
        if (r !== null) responses.push(r);
      }
      return responses.length ? json(responses) : new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    const r = await handleRpc(body, resolveCtx);
    if (r === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return json(r);
  } catch (e) {
    const code = e instanceof MeshError ? e.code : -32603;
    const message = e instanceof Error ? e.message : String(e);
    const id = (!Array.isArray(body) && body?.id !== undefined) ? body.id : null;
    return json({ jsonrpc: "2.0", id, error: { code, message } }, 200);
  }
});
