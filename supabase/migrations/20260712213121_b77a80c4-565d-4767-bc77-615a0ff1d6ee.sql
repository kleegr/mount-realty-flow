
UPDATE public.crm_config SET
  location_id = 'UpjC8IK37wMzeb1pc9D0',
  project_object_id = '6a3d6638a203481f18d46483',
  building_object_id = '6a47df17cac2ac453506991a',
  unit_object_id = '6a47dfc4416f7e873476b759'
WHERE id = 1;

INSERT INTO public.crm_pipelines (pipeline_id, label, stage_reserved_id, stage_under_contract_id, stage_closed_id, stage_release_id)
VALUES
  ('rrAHswWw5qhHTlMIepsz', 'Local Market Pipeline',
   'ee419df9-59cf-4ee2-a2b4-a3e9899c165b',
   '29f50cca-a649-4f38-afb4-b20fcc9c6183',
   '1b48cff1-f7ee-4809-a24e-1ac0b2c08f17',
   '1e6d0350-ffe7-40e3-82d9-fb556ceba78b'),
  ('4BppnNxsL9u58NFB7NUW', 'General Market Pipeline',
   NULL,
   '39ee1b08-75ca-42c3-8f01-ffd9fafd2a0e',
   'f25741f6-3a8d-45bd-8332-08a6c79d821c',
   '75b8e10c-13ec-4bcc-84b8-3358894c6979')
ON CONFLICT (pipeline_id) DO UPDATE SET
  label = EXCLUDED.label,
  stage_reserved_id = EXCLUDED.stage_reserved_id,
  stage_under_contract_id = EXCLUDED.stage_under_contract_id,
  stage_closed_id = EXCLUDED.stage_closed_id,
  stage_release_id = EXCLUDED.stage_release_id;
