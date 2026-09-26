-- Claude Agents Mesh — consolidated base schema.
--
-- Idempotent recreation of the coordination schema (workspaces, members, agents,
-- tasks, messages, quota_events, events), its RLS policies, helper/coordination
-- functions, triggers, and realtime publication. Safe to run on a fresh Supabase
-- project. The token-auth layer lives in the next migration (token_auth).
--
-- RLS here targets the `authenticated` role (Supabase Auth / JWT). The MCP server
-- runs with the service_role and calls the token-auth RPC variants, so these
-- policies are defense-in-depth for any direct client access.

create schema if not exists private;

-- ---- enums ----------------------------------------------------------------
do $$ begin create type public.agent_status as enum
  ('available','working','blocked_by_quota','waiting_for_reset','needs_attention','offline');
exception when duplicate_object then null; end $$;
do $$ begin create type public.task_status as enum
  ('pending','claimed','in_progress','completed','failed','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type public.message_status as enum
  ('pending','delivered','acknowledged','failed');
exception when duplicate_object then null; end $$;
do $$ begin create type public.workspace_role as enum ('owner','member');
exception when duplicate_object then null; end $$;

-- ---- utility + security-definer helpers -----------------------------------
create or replace function public.set_updated_at()
  returns trigger language plpgsql set search_path to 'public'
as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function private.add_workspace_creator_as_owner()
  returns trigger language plpgsql security definer set search_path to 'public'
as $$ begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict do nothing;
  return new;
end; $$;

create or replace function private.is_workspace_member(target_workspace_id uuid)
  returns boolean language sql stable security definer set search_path to 'public'
as $$ select exists (select 1 from public.workspace_members wm
  where wm.workspace_id = target_workspace_id and wm.user_id = (select auth.uid())); $$;

create or replace function private.is_workspace_owner(target_workspace_id uuid)
  returns boolean language sql stable security definer set search_path to 'public'
as $$ select exists (select 1 from public.workspace_members wm
  where wm.workspace_id = target_workspace_id and wm.user_id = (select auth.uid())
    and wm.role = 'owner'); $$;

grant usage on schema private to authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.is_workspace_owner(uuid) to authenticated;

-- ---- tables ---------------------------------------------------------------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_label text not null,
  session_id text not null,
  status public.agent_status not null default 'offline',
  capabilities jsonb not null default '{}'::jsonb,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, session_id)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by_agent_id uuid not null references public.agents(id) on delete restrict,
  assigned_to_agent_id uuid references public.agents(id) on delete set null,
  title text not null,
  description text,
  status public.task_status not null default 'pending',
  priority integer not null default 0,
  lease_until timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sender_agent_id uuid not null references public.agents(id) on delete restrict,
  recipient_agent_id uuid not null references public.agents(id) on delete restrict,
  task_id uuid references public.tasks(id) on delete set null,
  message_type text not null default 'text',
  body jsonb not null,
  status public.message_status not null default 'pending',
  correlation_id uuid,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  acknowledged_at timestamptz
);

create table if not exists public.quota_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  event_type text not null,
  quota_window text,
  used_percentage numeric,
  resets_at timestamptz,
  error_type text,
  error_details jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_agent_id uuid references public.agents(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---- indexes --------------------------------------------------------------
create index if not exists workspaces_created_by_idx on public.workspaces (created_by);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id);
create index if not exists agents_user_idx on public.agents (user_id);
create index if not exists agents_heartbeat_idx on public.agents (last_heartbeat_at);
create index if not exists agents_workspace_status_idx on public.agents (workspace_id, status);
create index if not exists tasks_queue_idx on public.tasks (workspace_id, status, priority desc, created_at);
create index if not exists tasks_assigned_to_agent_idx on public.tasks (assigned_to_agent_id);
create index if not exists tasks_created_by_agent_idx on public.tasks (created_by_agent_id);
create index if not exists tasks_lease_idx on public.tasks (lease_until) where (status in ('claimed','in_progress'));
create index if not exists messages_recipient_idx on public.messages (recipient_agent_id, status, created_at);
create index if not exists messages_sender_idx on public.messages (sender_agent_id);
create index if not exists messages_task_idx on public.messages (task_id, created_at);
create index if not exists messages_workspace_idx on public.messages (workspace_id);
create index if not exists quota_events_agent_idx on public.quota_events (agent_id, created_at desc);
create index if not exists quota_events_workspace_idx on public.quota_events (workspace_id);
create index if not exists events_actor_idx on public.events (actor_agent_id);
create index if not exists events_workspace_idx on public.events (workspace_id, created_at desc);

-- ---- triggers -------------------------------------------------------------
drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();
drop trigger if exists workspaces_add_creator_as_owner on public.workspaces;
create trigger workspaces_add_creator_as_owner after insert on public.workspaces
  for each row execute function private.add_workspace_creator_as_owner();
drop trigger if exists agents_set_updated_at on public.agents;
create trigger agents_set_updated_at before update on public.agents
  for each row execute function public.set_updated_at();
drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---- coordination functions (JWT / auth.uid() variants) -------------------
create or replace function public.claim_task(p_task_id uuid, p_agent_id uuid, p_lease_seconds integer default 60)
  returns setof public.tasks language plpgsql set search_path to 'public' as $$
begin
  if p_lease_seconds < 15 or p_lease_seconds > 3600 then raise exception 'lease_seconds must be between 15 and 3600'; end if;
  return query
  update public.tasks t set assigned_to_agent_id = p_agent_id, status = 'claimed',
    lease_until = now() + make_interval(secs => p_lease_seconds)
  where t.id = p_task_id
    and (t.status = 'pending' or (t.status in ('claimed','in_progress') and t.lease_until < now()))
    and exists (select 1 from public.agents a where a.id = p_agent_id and a.workspace_id = t.workspace_id and a.user_id = (select auth.uid()))
  returning t.*;
end; $$;

create or replace function public.heartbeat_task(p_task_id uuid, p_agent_id uuid, p_lease_seconds integer default 60)
  returns setof public.tasks language plpgsql set search_path to 'public' as $$
begin
  if p_lease_seconds < 15 or p_lease_seconds > 3600 then raise exception 'lease_seconds must be between 15 and 3600'; end if;
  return query
  update public.tasks t set status = 'in_progress', lease_until = now() + make_interval(secs => p_lease_seconds)
  where t.id = p_task_id and t.assigned_to_agent_id = p_agent_id and t.status in ('claimed','in_progress')
    and exists (select 1 from public.agents a where a.id = p_agent_id and a.workspace_id = t.workspace_id and a.user_id = (select auth.uid()))
  returning t.*;
end; $$;

create or replace function public.release_task(p_task_id uuid, p_agent_id uuid)
  returns setof public.tasks language plpgsql set search_path to 'public' as $$
begin
  return query
  update public.tasks t set assigned_to_agent_id = null, status = 'pending', lease_until = null
  where t.id = p_task_id and t.assigned_to_agent_id = p_agent_id and t.status in ('claimed','in_progress')
    and exists (select 1 from public.agents a where a.id = p_agent_id and a.workspace_id = t.workspace_id and a.user_id = (select auth.uid()))
  returning t.*;
end; $$;

create or replace function public.complete_task(p_task_id uuid, p_agent_id uuid, p_result jsonb default '{}'::jsonb)
  returns setof public.tasks language plpgsql set search_path to 'public' as $$
begin
  return query
  update public.tasks t set status = 'completed', result = p_result, lease_until = null, completed_at = now()
  where t.id = p_task_id and t.assigned_to_agent_id = p_agent_id and t.status in ('claimed','in_progress')
    and exists (select 1 from public.agents a where a.id = p_agent_id and a.workspace_id = t.workspace_id and a.user_id = (select auth.uid()))
  returning t.*;
end; $$;

create or replace function public.report_quota_event(
  p_workspace_id uuid, p_agent_id uuid, p_event_type text, p_quota_window text default null,
  p_used_percentage numeric default null, p_resets_at timestamptz default null,
  p_error_type text default null, p_error_details jsonb default null)
  returns setof public.quota_events language plpgsql set search_path to 'public' as $$
declare recorded public.quota_events; next_status public.agent_status;
begin
  if p_event_type = 'quota_blocked' then next_status := 'blocked_by_quota';
  elsif p_event_type in ('quota_reset','quota_auto_resumed') then next_status := 'available';
  elsif p_event_type = 'quota_warning' then next_status := 'needs_attention';
  else next_status := null; end if;
  if not exists (select 1 from public.agents a where a.id = p_agent_id and a.workspace_id = p_workspace_id and a.user_id = (select auth.uid())) then
    raise exception 'agent is not owned by the authenticated user';
  end if;
  insert into public.quota_events (workspace_id, agent_id, event_type, quota_window, used_percentage, resets_at, error_type, error_details)
  values (p_workspace_id, p_agent_id, p_event_type, p_quota_window, p_used_percentage, p_resets_at, p_error_type, p_error_details)
  returning * into recorded;
  if next_status is not null then update public.agents set status = next_status, last_heartbeat_at = now() where id = p_agent_id; end if;
  return next recorded;
end; $$;

-- ---- row level security ---------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.agents enable row level security;
alter table public.tasks enable row level security;
alter table public.messages enable row level security;
alter table public.quota_events enable row level security;
alter table public.events enable row level security;

drop policy if exists workspace_members_can_read_workspaces on public.workspaces;
create policy workspace_members_can_read_workspaces on public.workspaces for select to authenticated
  using (private.is_workspace_member(id));
drop policy if exists users_can_create_workspaces on public.workspaces;
create policy users_can_create_workspaces on public.workspaces for insert to authenticated
  with check ((select auth.uid()) = created_by);

drop policy if exists workspace_members_can_read_members on public.workspace_members;
create policy workspace_members_can_read_members on public.workspace_members for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy if exists workspace_owners_can_insert_members on public.workspace_members;
create policy workspace_owners_can_insert_members on public.workspace_members for insert to authenticated
  with check (private.is_workspace_owner(workspace_id));
drop policy if exists workspace_owners_can_update_members on public.workspace_members;
create policy workspace_owners_can_update_members on public.workspace_members for update to authenticated
  using (private.is_workspace_owner(workspace_id)) with check (private.is_workspace_owner(workspace_id));
drop policy if exists workspace_owners_can_delete_members on public.workspace_members;
create policy workspace_owners_can_delete_members on public.workspace_members for delete to authenticated
  using (private.is_workspace_owner(workspace_id));

drop policy if exists workspace_members_can_read_agents on public.agents;
create policy workspace_members_can_read_agents on public.agents for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy if exists users_can_register_their_agent on public.agents;
create policy users_can_register_their_agent on public.agents for insert to authenticated
  with check (private.is_workspace_member(workspace_id) and (user_id = (select auth.uid())));
drop policy if exists users_can_update_their_agents on public.agents;
create policy users_can_update_their_agents on public.agents for update to authenticated
  using ((user_id = (select auth.uid())) and private.is_workspace_member(workspace_id))
  with check ((user_id = (select auth.uid())) and private.is_workspace_member(workspace_id));

drop policy if exists workspace_members_can_read_tasks on public.tasks;
create policy workspace_members_can_read_tasks on public.tasks for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy if exists agents_can_create_tasks on public.tasks;
create policy agents_can_create_tasks on public.tasks for insert to authenticated
  with check (private.is_workspace_member(workspace_id) and exists (
    select 1 from public.agents a where a.id = tasks.created_by_agent_id
      and a.workspace_id = tasks.workspace_id and a.user_id = (select auth.uid())));
drop policy if exists workspace_agents_can_update_tasks on public.tasks;
create policy workspace_agents_can_update_tasks on public.tasks for update to authenticated
  using (private.is_workspace_member(workspace_id)) with check (private.is_workspace_member(workspace_id));

drop policy if exists workspace_members_can_read_messages on public.messages;
create policy workspace_members_can_read_messages on public.messages for select to authenticated
  using (private.is_workspace_member(workspace_id) and ((exists (
      select 1 from public.agents a where a.id = messages.recipient_agent_id and a.user_id = (select auth.uid())))
    or (exists (
      select 1 from public.agents a where a.id = messages.sender_agent_id and a.user_id = (select auth.uid())))));
drop policy if exists agents_can_send_messages on public.messages;
create policy agents_can_send_messages on public.messages for insert to authenticated
  with check (private.is_workspace_member(workspace_id) and exists (
      select 1 from public.agents sender where sender.id = messages.sender_agent_id
        and sender.workspace_id = messages.workspace_id and sender.user_id = (select auth.uid()))
    and exists (
      select 1 from public.agents recipient where recipient.id = messages.recipient_agent_id
        and recipient.workspace_id = messages.workspace_id));
drop policy if exists recipients_can_ack_messages on public.messages;
create policy recipients_can_ack_messages on public.messages for update to authenticated
  using (exists (select 1 from public.agents recipient where recipient.id = messages.recipient_agent_id and recipient.user_id = (select auth.uid())))
  with check (exists (select 1 from public.agents recipient where recipient.id = messages.recipient_agent_id and recipient.user_id = (select auth.uid())));

drop policy if exists workspace_members_can_read_quota_events on public.quota_events;
create policy workspace_members_can_read_quota_events on public.quota_events for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy if exists agents_can_insert_own_quota_events on public.quota_events;
create policy agents_can_insert_own_quota_events on public.quota_events for insert to authenticated
  with check (private.is_workspace_member(workspace_id) and exists (
    select 1 from public.agents a where a.id = quota_events.agent_id
      and a.workspace_id = quota_events.workspace_id and a.user_id = (select auth.uid())));

drop policy if exists workspace_members_can_read_events on public.events;
create policy workspace_members_can_read_events on public.events for select to authenticated
  using (private.is_workspace_member(workspace_id));
drop policy if exists agents_can_insert_events on public.events;
create policy agents_can_insert_events on public.events for insert to authenticated
  with check (private.is_workspace_member(workspace_id) and ((actor_agent_id is null) or exists (
    select 1 from public.agents a where a.id = events.actor_agent_id
      and a.workspace_id = events.workspace_id and a.user_id = (select auth.uid()))));

-- ---- realtime -------------------------------------------------------------
do $$ begin alter publication supabase_realtime add table public.agents; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.tasks; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.quota_events; exception when duplicate_object then null; end $$;
