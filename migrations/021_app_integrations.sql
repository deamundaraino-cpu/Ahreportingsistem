-- App Integrations: credenciales OAuth globales a nivel agencia (no por cliente).
-- Usado para la conexión única de Google (Analytics + Sheets) de la agencia.
CREATE TABLE public.app_integrations (
  provider          TEXT PRIMARY KEY,            -- ej. 'google'
  refresh_token     TEXT,                        -- token de larga duración (no expira en Workspace "Interno")
  access_token      TEXT,                        -- access token cacheado
  token_expires_at  TIMESTAMP WITH TIME ZONE,    -- vencimiento del access_token cacheado
  scopes            TEXT[] DEFAULT '{}'::text[], -- scopes concedidos
  connected_email   TEXT,                        -- cuenta de Google que autorizó (ej. marketing@fullyclub.agency)
  connection_status TEXT DEFAULT 'disconnected', -- 'connected' | 'disconnected' | 'error'
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- RLS activado: solo el service role (workers / callbacks OAuth) accede a estas credenciales.
-- No se define ninguna policy para usuarios normales -> sin acceso por anon/auth key.
ALTER TABLE public.app_integrations ENABLE ROW LEVEL SECURITY;
