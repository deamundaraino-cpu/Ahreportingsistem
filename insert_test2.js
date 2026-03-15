const { createClient } = require('@supabase/supabase-js');
const url = 'https://dfdeizrbkpdocgckqlel.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_Juofq3TAtGkQEGOUyq3f9w_oChgJSMf';
const sb = createClient(url, key);
sb.from('metricas_diarias').upsert({
  cliente_id: '2f4b29db-1d01-4e2a-994a-5e28c5a8041a',
  fecha: '2026-01-20',
  meta_spend: 100
}).then(res => console.log(res));
