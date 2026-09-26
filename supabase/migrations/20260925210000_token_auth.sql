-- Token-based authentication layer for the Claude Agents Mesh MCP.
--
-- Context: the initial schema (workspaces / agents / tasks / messages / quota_events
-- / events) and its RLS policies + coordination functions were written for the
-- Supabase Auth (JWT) model, where every RPC derives the caller from auth.uid().
--
-- That model makes onboarding a cloud Claude Code session painful: each agent must
-- supply a JWT + a workspace UUID by hand. This migration adds an opaque per-member
-- token layer so an agent only needs to paste one HTTP header:
--
--     Authorization: Bearer mesh_<random>
--
-- The MCP server (a Supabase Edge Function) runs with the service_role, resolves the
-- token to (workspace_id, user_id, role), and calls the token-auth RPC variants below,
-- which take an explicit p_user_id instead of auth.uid(). The service_role key never
-- leaves the server; the public repo ships no secrets.

-- ---------------------------------------------------------------------------
-- 1. member_tokens: hashed access tokens that map a bearer token to an identity
-- ---------------------------------------------------------------------------
create table if not exists public.member_tokens (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         public.workspace_role not null default 'member',
  label        text,                       -- human label only (e.g. an email); never emailed
  token_hash   text not null unique,       -- sha-256 hex of the raw token; raw token is never stored
  token_prefix text not null,              -- e.g. "mesh_1a2b3c" for identification in listings
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists member_tokens_workspace_idx on public.member_tokens (workspace_id);
create index if not exists member_tokens_user_idx      on public.member_tokens (user_id);
create index if not exists member_tokens_hash_idx      on public.member_tokens (token_hash);

alter table public.member_tokens enable row level security;
-- Deliberately no RLS policies: neither the anon nor the authenticated role may
-- read or write tokens. Only the Edge Function (service_role, which bypasses RLS)
-- ever touches this table. Defense in depth for a table full of credentials.
revoke all on public.member_tokens from anon, authenticated;

comment on table public.member_tokens is
  'Hashed per-member bearer tokens for MCP auth. Only the service_role (Edge Function) reads/writes this table.';

-- ---------------------------------------------------------------------------
-- 2. Token-auth RPC variants (explicit p_user_id, callable by service_role only)
-- ---------------------------------------------------------------------------
-- These mirror claim_task / heartbeat_task / release_task / complete_task /
-- report_quota_event but take p_user_id explicitly. The MCP server has already
-- resolved p_user_id from the bearer token; the in-database ownership checks are
-- kept as a second line of defense. They are SECURITY DEFINER and MUST NOT be
-- callable by anon/authenticated (an arbitrary p_user_id would be an escalation).

create or replace function public.mesh_claim_task(
  p_task_id uuid, p_agent_id uuid, p_user_id uuid, p_lease_seconds integer default 60
) returns setof public.tasks
  language plpgsql security definer set search_path to 'public' as $$
begin
  if p_lease_seconds < 15 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 15 and 3600';
  end if;
  return query
  update public.tasks t
     set assigned_to_agent_id = p_agent_id,
         status = 'claimed',
         lease_until = now() + make_interval(secs => p_lease_seconds)
   where t.id = p_task_id
     and (t.status = 'pending' or (t.status in ('claimed','in_progress') and t.lease_until < now()))
     and exists (select 1 from public.agents a
                  where a.id = p_agent_id and a.workspace_id = t.workspace_id and a.user_id = p_user_id)
  returning t.*;
end; $$;

create or replace function public.mesh_heartbeat_task(
  p_task_id uuid, p_agent_id uuid, p_user_id uuid, p_lease_seconds integer default 60
) returns setof public.tasks
  language plpgsql security definer set search_path to 'public' as $$
begin
  if p_lease_seconds < 15 or p_lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 15 and 3600';
  end if;
  return query
  update public.tasks t
     set status = 'in_progress',
         lease_until = now() + make_interval(secs => p_lease_seconds)
   where t.id = p_task_id and t.assigned_to_agent_id = p_agent_id
     and t.status in ('claimed','in_progress')
     and exists (select 1 from public.agents a
                  where a.id = p_agent_id and a.workspace_id = t.workspace_id and a.user_id = p_user_id)
  returning t.*;
end; $$;

create or replace function public.mesh_release_task(
  p_task_id uuid, p_agent_id uuid, p_user_id uuid
) returns setof public.tasks
  language plpgsql security definer set search_path to 'public' as $$
begin
  return query
  update public.tasks t
     set assigned_to_agent_id = null, status = 'pending', lease_until = null
   where t.id = p_task_id and t.assigned_to_agent_id = p_agent_id
     and t.status in ('claimed','in_progress')
     and exists (select 1 from public.agents a
                  where a.id = p_agent_id and a.workspace_id = t.workspace_id and a.user_id = p_user_id)
  returning t.*;
end; $$;

create or replace function public.mesh_complete_task(
  p_task_id uuid, p_agent_id uuid, p_user_id uuid, p_result jsonb default '{}'::jsonb
) returns setof public.tasks
  language plpgsql security definer set search_path to 'public' as $$
begin
  return query
  update public.tasks t
     set status = 'completed', result = p_result, lease_until = null, completed_at = now()
   where t.id = p_task_id and t.assigned_to_agent_id = p_agent_id
     and t.status in ('claimed','in_progress')
     and exists (select 1 from public.agents a
                  where a.id = p_agent_id and a.workspace_id = t.workspace_id and a.user_id = p_user_id)
  returning t.*;
end; $$;

create or replace function public.mesh_report_quota_event(
  p_workspace_id uuid, p_agent_id uuid, p_user_id uuid, p_event_type text,
  p_quota_window text default null, p_used_percentage numeric default null,
  p_resets_at timestamptz default null, p_error_type text default null,
  p_error_details jsonb default null
) returns setof public.quota_events
  language plpgsql security definer set search_path to 'public' as $$
declare recorded public.quota_events; next_status public.agent_status;
begin
  if p_event_type = 'quota_blocked' then next_status := 'blocked_by_quota';
  elsif p_event_type in ('quota_reset','quota_auto_resumed') then next_status := 'available';
  elsif p_event_type = 'quota_warning' then next_status := 'needs_attention';
  else next_status := null;
  end if;

  if not exists (select 1 from public.agents a
                  where a.id = p_agent_id and a.workspace_id = p_workspace_id and a.user_id = p_user_id) then
    raise exception 'agent is not owned by the given user';
  end if;

  insert into public.quota_events
    (workspace_id, agent_id, event_type, quota_window, used_percentage, resets_at, error_type, error_details)
  values
    (p_workspace_id, p_agent_id, p_event_type, p_quota_window, p_used_percentage, p_resets_at, p_error_type, p_error_details)
  returning * into recorded;

  if next_status is not null then
    update public.agents set status = next_status, last_heartbeat_at = now() where id = p_agent_id;
  end if;
  return next recorded;
end; $$;

-- Lock the token-auth variants down to service_role only.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.mesh_claim_task(uuid,uuid,uuid,integer)',
    'public.mesh_heartbeat_task(uuid,uuid,uuid,integer)',
    'public.mesh_release_task(uuid,uuid,uuid)',
    'public.mesh_complete_task(uuid,uuid,uuid,jsonb)',
    'public.mesh_report_quota_event(uuid,uuid,uuid,text,text,numeric,timestamptz,text,jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated;', fn);
    execute format('grant execute on function %s to service_role;', fn);
  end loop;
end $$;
