-- API Tokens: External integrations and MCP access
CREATE TABLE public.api_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,       -- First 8 chars for display (e.g. "ads_xK9m")
  token_hash TEXT NOT NULL UNIQUE,  -- SHA-256 hash of the full token
  permissions JSONB DEFAULT '["read:metrics","read:clients","read:campaigns"]'::jsonb NOT NULL,
  last_used_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN DEFAULT true NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;

-- Users manage their own tokens
CREATE POLICY "Users manage own tokens"
ON public.api_tokens
FOR ALL USING (auth.uid() = user_id);

-- Admin full access
CREATE POLICY "Admin full access tokens"
ON public.api_tokens
FOR ALL USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');

-- Index for fast token lookup (used on every API request)
CREATE INDEX idx_api_tokens_hash ON public.api_tokens (token_hash);
CREATE INDEX idx_api_tokens_user ON public.api_tokens (user_id);
