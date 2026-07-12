
-- 1. sync_jobs table
CREATE TABLE public.sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('project', 'building', 'unit', 'all')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  total int NOT NULL DEFAULT 0,
  processed int NOT NULL DEFAULT 0,
  created_count int NOT NULL DEFAULT 0,
  updated_count int NOT NULL DEFAULT 0,
  error_count int NOT NULL DEFAULT 0,
  error_summary text,
  started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

GRANT SELECT ON public.sync_jobs TO authenticated;
GRANT ALL ON public.sync_jobs TO service_role;

ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sync_jobs: importer/admin read"
  ON public.sync_jobs FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'importer'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX sync_jobs_started_at_idx ON public.sync_jobs (started_at DESC);

-- 2. extend external_id_map with cached display fields
ALTER TABLE public.external_id_map
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS parent_crm_id text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS external_id_map_display_name_idx
  ON public.external_id_map (scope, display_name);
CREATE INDEX IF NOT EXISTS external_id_map_code_idx
  ON public.external_id_map (scope, code);
