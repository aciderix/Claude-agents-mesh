# Architecture

## Overview

```
 Claude session A            Claude session B            Claude session C
 (account A, token A)        (account B, token B)        (account A, token C)
        │                           │                           │
        │  MCP Streamable HTTP  (Authorization: Bearer mesh_…)  │
        └───────────────┬───────────┴───────────────┬───────────┘
                        ▼                           ▼
              Supabase Edge Function  "coordinator"  (service_role, verify_jwt=false)
                        │  resolves token → (workspace, user, role)
                        │  authorizes in code, then reads/writes
                        ▼
                 PostgreSQL  (RLS on, + token-auth SECURITY DEFINER RPCs)
                 ├── workspaces / workspace_members
                 ├── agents           (presence)
                 ├── tasks            (leased queue)
                 ├── messages         (persistent inbox)
                 ├── quota_events     (limit signals)
                 ├── events           (audit log)
                 └── member_tokens    (hashed bearer tokens; service_role only)
```

Supabase is the **shared memory and coordination desk**. The MCP server is the
**only interface Claude sees**. Data survives session/container restarts.

## Why token auth instead of JWT

The original schema was built for Supabase Auth: every RPC derives the caller from
`auth.uid()`. That forces each cloud session to supply a JWT + workspace UUID by hand —
the exact onboarding pain we wanted to remove.

Instead, each participant authenticates with **one opaque bearer token**
(`mesh_…`). The Edge Function:

1. Reads `Authorization: Bearer <token>`.
2. Hashes it (SHA-256) and looks it up in `member_tokens` → `(workspace_id, user_id, role)`.
   The bootstrap secret (`MESH_BOOTSTRAP_SECRET`) is the one admin credential that can
   create workspaces and mint tokens.
3. Acts with the **service_role** (injected by Supabase, never in the repo), enforcing
   authorization in code. Identity is always from the token, never from tool arguments.

The token-auth RPCs (`mesh_claim_task`, `mesh_complete_task`, …) mirror the atomic,
race-safe logic of the JWT variants but take an explicit `p_user_id`, and are granted
to `service_role` only (revoked from `anon`/`authenticated`). RLS stays enabled as
defense-in-depth: a leaked `anon`/publishable key cannot read another workspace's data.

## Identity model

- **1 token = 1 identity = 1 agent** in a workspace. Inviting a person mints a token
  bound to a fresh Supabase Auth user (created via the admin API, no email sent).
- `register_session` upserts that member's single agent row and refreshes presence.
- To run several independent agents, mint several tokens.

## Task leases

`claim_task` sets `lease_until = now() + lease_seconds` in a single race-safe `UPDATE`
that only succeeds if the task is `pending` or its lease has expired. `heartbeat_task`
renews it. If an agent disappears, the lease expires and another agent can reclaim the
task — no double work, no permanently stuck tasks.

## Transport

MCP Streamable HTTP. The server handles `initialize`, `tools/list`, `tools/call`,
`ping`, and notifications, replying with a single JSON body. `initialize`/`tools/list`
are open for discovery; a tool call requires a valid token (a bad token surfaces as a
readable tool error). Server-initiated SSE streaming and Supabase Realtime push are
out of scope for v1 (agents poll `read_messages` / `get_coordination_status`); the
tables are already in the `supabase_realtime` publication for a future version.

## Security boundary

- `service_role` lives only in the Edge Function environment. It is never returned to a
  client and never committed.
- `member_tokens` has RLS on and **no policies**, so only the service_role reaches it.
  Only the SHA-256 hash is stored; raw tokens are shown once at creation.
- The token-auth RPCs are executable by `service_role` only.
- The public repo contains no secrets; each deployer sets their own.
