-- migrations/025_google_sheets_multi.sql
-- Converts existing single-object google_sheets_conversiones config to array format.
-- Clients that already have an array config are untouched.
-- Adds 'id' (UUID) and 'name' fields so the frontend can identify each sheet.

UPDATE clientes
SET config_api = jsonb_set(
  config_api,
  '{google_sheets_conversiones}',
  jsonb_build_array(
    (config_api->'google_sheets_conversiones')
    || jsonb_build_object(
        'id',   gen_random_uuid()::text,
        'name', 'Sheet Principal'
    )
  )
)
WHERE config_api ? 'google_sheets_conversiones'
  AND jsonb_typeof(config_api->'google_sheets_conversiones') = 'object';
