
CREATE TABLE public.crm_pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id text NOT NULL UNIQUE,
  label text,
  stage_reserved_id text,
  stage_under_contract_id text,
  stage_closed_id text,
  stage_release_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_pipelines TO authenticated;
GRANT ALL ON public.crm_pipelines TO service_role;

ALTER TABLE public.crm_pipelines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view pipelines"
  ON public.crm_pipelines FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can insert pipelines"
  ON public.crm_pipelines FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update pipelines"
  ON public.crm_pipelines FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete pipelines"
  ON public.crm_pipelines FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER crm_pipelines_set_updated_at
  BEFORE UPDATE ON public.crm_pipelines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed from legacy single-pipeline config if present
INSERT INTO public.crm_pipelines (pipeline_id, label, stage_reserved_id, stage_under_contract_id, stage_closed_id, stage_release_id)
SELECT opportunity_pipeline_id, 'Default', stage_reserved_id, stage_under_contract_id, stage_closed_id, stage_release_id
FROM public.crm_config
WHERE id = 1 AND opportunity_pipeline_id IS NOT NULL AND opportunity_pipeline_id <> ''
ON CONFLICT (pipeline_id) DO NOTHING;
