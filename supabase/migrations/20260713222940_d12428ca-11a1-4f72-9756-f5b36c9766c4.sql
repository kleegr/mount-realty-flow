UPDATE public.crm_config
SET
  project_object_key = 'custom_objects.project',
  building_object_key = 'custom_objects.building',
  unit_object_key = 'custom_objects.unit'
WHERE id = 1;