const { createClient } = require('@supabase/supabase-js');
const url = 'https://dfdeizrbkpdocgckqlel.supabase.co';
const key = 'sb_publishable_Juofq3TAtGkQEGOUyq3f9w_oChgJSMf';
const sb = createClient(url, key);
sb.from('metricas_diarias').select('*').then(res => console.log(res));
