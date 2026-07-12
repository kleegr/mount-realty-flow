
ALTER TABLE public.crm_pipelines
  ADD COLUMN IF NOT EXISTS pipeline_name text,
  ADD COLUMN IF NOT EXISTS stage_reserved_name text,
  ADD COLUMN IF NOT EXISTS stage_under_contract_name text,
  ADD COLUMN IF NOT EXISTS stage_closed_name text,
  ADD COLUMN IF NOT EXISTS stage_release_name text;

CREATE INDEX IF NOT EXISTS crm_pipelines_name_idx ON public.crm_pipelines (pipeline_name);

-- Seed the two known pipelines with their stage names
UPDATE public.crm_pipelines
   SET pipeline_name = 'Local Market Pipeline',
       stage_reserved_name = 'Contract Negotiation / Unit Reserved',
       stage_under_contract_name = 'Contract Signed / Unit Locked',
       stage_closed_name = 'Closing',
       stage_release_name = 'Lost / Not Interested'
 WHERE pipeline_id = 'rrAHswWw5qhHTlMIepsz';

UPDATE public.crm_pipelines
   SET pipeline_name = 'General Market Pipeline',
       stage_reserved_name = NULL,
       stage_under_contract_name = 'Contract Signed / Unit Reserved',
       stage_closed_name = 'Closing',
       stage_release_name = 'Lost / Not Interested'
 WHERE pipeline_id = '4BppnNxsL9u58NFB7NUW';
