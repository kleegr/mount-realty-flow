
-- ============================================================================
-- ENUMS
-- ============================================================================
create type public.app_role as enum ('admin', 'importer', 'viewer');
create type public.import_status as enum (
  'validating', 'awaiting_confirm', 'running',
  'success', 'success_with_warnings', 'partial_failure', 'failed'
);
create type public.import_scope as enum ('project', 'building', 'unit');
create type public.import_action as enum ('create', 'update', 'skip', 'error');

-- ============================================================================
-- SHARED updated_at trigger
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

-- ============================================================================
-- PROFILES
-- ============================================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

-- ============================================================================
-- USER ROLES
-- ============================================================================
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role);
$$;

create policy "profiles: own or admin read" on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role(auth.uid(), 'admin'));
create policy "profiles: self update" on public.profiles for update to authenticated
  using (id = auth.uid());
create policy "profiles: self insert" on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy "roles: self read" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- Auto-create profile + bootstrap first user as admin
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare user_count int;
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'))
  on conflict (id) do nothing;
  select count(*) into user_count from public.user_roles;
  if user_count = 0 then
    insert into public.user_roles (user_id, role) values (new.id, 'admin');
  else
    insert into public.user_roles (user_id, role) values (new.id, 'viewer') on conflict do nothing;
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- CRM CONFIG (singleton)
-- ============================================================================
create table public.crm_config (
  id int primary key default 1 check (id = 1),
  location_id text,
  api_base_url text not null default 'https://services.leadconnectorhq.com',
  project_object_key text not null default 'custom_objects.projects',
  building_object_key text not null default 'custom_objects.buildings',
  unit_object_key text not null default 'custom_objects.units',
  project_object_id text,
  building_object_id text,
  unit_object_id text,
  opportunity_pipeline_id text,
  stage_reserved_id text,
  stage_under_contract_id text,
  stage_closed_id text,
  stage_release_id text,
  template_xlsx_url text,
  updated_at timestamptz not null default now()
);
grant select on public.crm_config to authenticated;
grant all on public.crm_config to service_role;
alter table public.crm_config enable row level security;
create policy "crm_config: importer read" on public.crm_config for select to authenticated
  using (public.has_role(auth.uid(), 'importer') or public.has_role(auth.uid(), 'admin'));

-- Seed with the confirmed location ID from the spec
insert into public.crm_config (id, location_id, project_object_id, building_object_id, unit_object_id)
values (1, 'UpjC8IK37wMzeb1pc9D0', '6a3d6638a203481f18d46483', '6a47df17cac2ac453506991a', null)
on conflict do nothing;
create trigger crm_config_updated before update on public.crm_config
  for each row execute function public.set_updated_at();

-- ============================================================================
-- EXTERNAL ID MAP
-- ============================================================================
create table public.external_id_map (
  id uuid primary key default gen_random_uuid(),
  scope public.import_scope not null,
  external_import_id text not null,
  crm_record_id text not null,
  first_seen_job_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope, external_import_id)
);
grant select on public.external_id_map to authenticated;
grant all on public.external_id_map to service_role;
alter table public.external_id_map enable row level security;
create policy "id_map: importer read" on public.external_id_map for select to authenticated
  using (public.has_role(auth.uid(), 'importer') or public.has_role(auth.uid(), 'admin'));
create index external_id_map_crm_record_id_idx on public.external_id_map (crm_record_id);

-- ============================================================================
-- IMPORT JOBS
-- ============================================================================
create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  filename text,
  file_hash text,
  mode text,
  status public.import_status not null default 'validating',
  row_count int not null default 0,
  projects_created int not null default 0,
  projects_updated int not null default 0,
  buildings_created int not null default 0,
  buildings_updated int not null default 0,
  units_created int not null default 0,
  units_updated int not null default 0,
  skipped int not null default 0,
  warnings_count int not null default 0,
  errors_count int not null default 0,
  validation_snapshot jsonb,
  report jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
grant select on public.import_jobs to authenticated;
grant all on public.import_jobs to service_role;
alter table public.import_jobs enable row level security;
create policy "jobs: importer read" on public.import_jobs for select to authenticated
  using (public.has_role(auth.uid(), 'importer') or public.has_role(auth.uid(), 'admin'));
create trigger import_jobs_updated before update on public.import_jobs
  for each row execute function public.set_updated_at();
create index import_jobs_created_idx on public.import_jobs (created_at desc);

-- ============================================================================
-- IMPORT ITEMS
-- ============================================================================
create table public.import_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.import_jobs(id) on delete cascade,
  row_number int,
  import_row_id text,
  scope public.import_scope not null,
  external_import_id text,
  action public.import_action not null,
  matched_crm_id text,
  source jsonb,
  proposed jsonb,
  existing jsonb,
  messages jsonb,
  status text,
  correlation_id text,
  created_at timestamptz not null default now()
);
grant select on public.import_items to authenticated;
grant all on public.import_items to service_role;
alter table public.import_items enable row level security;
create policy "items: importer read" on public.import_items for select to authenticated
  using (public.has_role(auth.uid(), 'importer') or public.has_role(auth.uid(), 'admin'));
create index import_items_job_idx on public.import_items (job_id);

-- ============================================================================
-- AUDIT EVENTS
-- ============================================================================
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  kind text not null,
  entity_scope public.import_scope,
  entity_crm_id text,
  previous jsonb,
  next jsonb,
  reason text,
  correlation_id text,
  created_at timestamptz not null default now()
);
grant select on public.audit_events to authenticated;
grant all on public.audit_events to service_role;
alter table public.audit_events enable row level security;
create policy "audit: importer read" on public.audit_events for select to authenticated
  using (public.has_role(auth.uid(), 'importer') or public.has_role(auth.uid(), 'admin'));
create index audit_events_created_idx on public.audit_events (created_at desc);
create index audit_events_entity_idx on public.audit_events (entity_crm_id);

-- ============================================================================
-- WEBHOOK EVENTS
-- ============================================================================
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text unique,
  pipeline_id text,
  stage_id text,
  opportunity_id text,
  unit_crm_id text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  raw jsonb
);
grant select on public.webhook_events to authenticated;
grant all on public.webhook_events to service_role;
alter table public.webhook_events enable row level security;
create policy "webhooks: importer read" on public.webhook_events for select to authenticated
  using (public.has_role(auth.uid(), 'importer') or public.has_role(auth.uid(), 'admin'));
create index webhook_events_opp_idx on public.webhook_events (opportunity_id);
