-- Files a task touches, so agents can avoid editing the same files at once.
-- Entries are repo-relative paths: an exact file ("src/app.ts"), a directory
-- ending in "/" ("src/ui/"), or a glob ("src/**/*.test.ts"). The mesh-live mod
-- reads them from get_coordination_status to warn before conflicting edits.
alter table public.tasks
  add column if not exists files text[] not null default '{}'::text[];
