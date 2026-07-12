CREATE TABLE public.unit_state (
  unit_crm_id text PRIMARY KEY,
  building_crm_id text,
  project_crm_id text,
  availability text,
  stage text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX unit_state_building_idx ON public.unit_state(building_crm_id);
CREATE INDEX unit_state_project_idx ON public.unit_state(project_crm_id);

GRANT ALL ON public.unit_state TO service_role;
GRANT SELECT ON public.unit_state TO authenticated;

ALTER TABLE public.unit_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read unit state"
  ON public.unit_state FOR SELECT
  TO authenticated
  USING (true);

CREATE TRIGGER unit_state_set_updated_at
  BEFORE UPDATE ON public.unit_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();