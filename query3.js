const { createClient } = require('@supabase/supabase-js');
const url = 'https://dfdeizrbkpdocgckqlel.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_Juofq3TAtGkQEGOUyq3f9w_oChgJSMf';
const sb = createClient(url, key);
sb.from('metricas_diarias').select('*').then(res => console.log(res.data.filter(i => i.meta_spend > 0).slice(0,5)));
