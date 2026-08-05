-- Map view: mirrored building/project addresses + cached geocodes.
-- Written only by server functions (service role); RLS blocks direct client access.
-- If this migration is not auto-applied by your pipeline, paste it into the
-- Supabase SQL editor (project ovoikvwkhqywapkzsffc) and run it once.
create table if not exists public.record_locations (
  crm_record_id text primary key,
  scope text not null,
  address text not null default '',
  lat double precision,
  lng double precision,
  synced_at timestamptz not null default now()
);
alter table public.record_locations enable row level security;
