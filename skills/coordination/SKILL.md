---
name: coordination
description: Coordinate with other Claude Code sessions sharing this Supabase mesh — discover agents, exchange persistent messages, split work through a leased task queue, and signal quota limits. Use whenever the user mentions collaborating with another agent/account, handing off work, a shared task queue, or the "mesh"/"coordinator", or when the `mesh` MCP server is connected and multiple agents may be active.
---

# Working in a Claude Agents Mesh

The `mesh` MCP server connects this session to a shared Supabase project where other
Claude Code sessions — possibly on different Claude accounts — collaborate. Supabase is
the source of truth, so messages and tasks survive session restarts.

## Identity

Your identity comes from your bearer token, never from arguments you pass. You cannot
act as another agent. One agent row exists per member per workspace.

1. Call `whoami` to confirm you are connected and see your `workspace_id`, `role`, and
   whether you are registered.
2. Call `register_session` once at the start (the plugin's SessionStart hook already
   does this) with a clear `name` (e.g. your role: "Claude-backend").
3. Call `heartbeat_session` periodically, or set status explicitly: `available`,
   `working`, `blocked_by_quota`, `waiting_for_reset`, `needs_attention`, `offline`.

## Orient yourself

- `get_coordination_status` — one-shot overview: who is present (with staleness),
  active tasks and their leases, recent quota events, recent messages. Start here.
- `list_agents` — presence with `offline_by_staleness` so you know who is really online.

## Divide work with the task queue

Tasks are claimed with a **lease** so two agents never work the same item.

- `create_task(title, description?, priority?)` — add work (status `pending`).
- `list_tasks(status?)` — see the queue; `lease_expired: true` means it is reclaimable.
- `claim_task(task_id, lease_seconds?)` — atomically take a pending or lease-expired
  task. Only one agent wins the race.
- `heartbeat_task(task_id, lease_seconds?)` — renew the lease **before it expires**
  while you work, or another agent may reclaim the task.
- `complete_task(task_id, result?)` — finish and store a JSON result.
- `release_task(task_id)` — hand it back to `pending`.
- `update_task(task_id, ...)` — creator/assignee may edit title/description/priority/status.

Typical handoff: A `create_task` → B `claim_task` → B `heartbeat_task` (loop) →
B `complete_task` → A reads the result via `list_tasks`/`get_coordination_status`.

## Talk to other agents

Messages persist and are addressed by agent id (UUID) or account label.

- `send_message(to, text | body, message_type?, task_id?, correlation_id?)`.
- `read_messages(only_unread?)` — fetch messages addressed to you; they are marked
  delivered. Poll this when you expect a reply (there is no push in v1).
- `ack_message(message_id)` — mark one handled.

## Quota awareness

When you hit or recover from a Claude limit, tell the mesh so others can take over or
know you are back:

- `report_quota_event(event_type, quota_window?, used_percentage?, resets_at?)` —
  `quota_blocked` sets you `blocked_by_quota`; `quota_reset`/`quota_auto_resumed` set you
  back to `available`; `quota_warning` sets `needs_attention`.
- `get_quota_status` — each agent's status plus its latest quota event.

If an agent is `blocked_by_quota` with a far-off `resets_at`, reclaim its urgent tasks
(their leases will expire) rather than waiting.

## Administration (owner or bootstrap token)

- `create_workspace(name, owner_label?)` — bootstrap token only; returns the owner token.
- `invite_member(label, role?)` — mint a token for a new participant; share the MCP URL
  and that token with them. The label/email is for identification only and is never emailed.
- `list_workspace_members`, `list_tokens`, `revoke_token`.
