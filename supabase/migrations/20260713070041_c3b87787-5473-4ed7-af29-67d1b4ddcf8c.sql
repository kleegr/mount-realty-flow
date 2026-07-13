
-- Flexible importer: add columns for mapping, duplicate strategy, parent behavior, undo.
ALTER TYPE public.import_action ADD VALUE IF NOT EXISTS 'create_duplicate';
ALTER TYPE public.import_action ADD VALUE IF NOT EXISTS 'auto_create_parent';

ALTER TABLE public.import_jobs
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS column_map jsonb,
  ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_created_projects integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_created_buildings integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raw_rows jsonb,
  ADD COLUMN IF NOT EXISTS headers text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS undone_at timestamptz;

ALTER TABLE public.import_items
  ADD COLUMN IF NOT EXISTS resolution text,
  ADD COLUMN IF NOT EXISTS parent_resolution text,
  ADD COLUMN IF NOT EXISTS undo_op jsonb,
  ADD COLUMN IF NOT EXISTS error_message text;
