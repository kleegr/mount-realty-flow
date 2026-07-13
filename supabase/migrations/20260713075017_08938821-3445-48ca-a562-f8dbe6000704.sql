
DROP POLICY IF EXISTS "authenticated read" ON public.crm_pipelines;
DROP POLICY IF EXISTS "Authenticated users can view crm_pipelines" ON public.crm_pipelines;
DROP POLICY IF EXISTS "crm_pipelines select" ON public.crm_pipelines;
DROP POLICY IF EXISTS "Read crm_pipelines" ON public.crm_pipelines;

DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='crm_pipelines' AND cmd='SELECT' LOOP
    EXECUTE format('DROP POLICY %I ON public.crm_pipelines', p.policyname);
  END LOOP;
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='unit_state' AND cmd='SELECT' LOOP
    EXECUTE format('DROP POLICY %I ON public.unit_state', p.policyname);
  END LOOP;
END $$;

CREATE POLICY "Admins and importers can view crm_pipelines"
  ON public.crm_pipelines FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'importer'));

CREATE POLICY "Admins and importers can view unit_state"
  ON public.unit_state FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'importer'));
