-- Migración: grupo general fijo del equipo para alertas de WhatsApp.
-- Ejecutar en Supabase SQL Editor.
--
-- Las alertas de reglas (notification_rules) se envían SIEMPRE a este grupo,
-- además del grupo específico del cliente si lo tiene. Si el cliente no tiene
-- grupo propio, solo se notifica aquí. No requiere tabla nueva: reutiliza la
-- tabla key/value public.system_settings (ver 041_system_branding_settings.sql).
--
-- Contrato del value:
--   { "group_id": "<jid @g.us> | null", "enabled": <bool> }
--   - group_id = null o enabled = false  → no se agrega ningún grupo de equipo.

INSERT INTO public.system_settings (key, value)
VALUES (
    'whatsapp_alert_team_group',
    '{
        "group_id": null,
        "enabled": false
    }'::jsonb
) ON CONFLICT (key) DO NOTHING;
