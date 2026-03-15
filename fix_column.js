const { createClient } = require('@supabase/supabase-js');
const url = 'https://dfdeizrbkpdocgckqlel.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_Juofq3TAtGkQEGOUyq3f9w_oChgJSMf';
const sb = createClient(url, key);
// To run a raw query from the supabase js client, we can call rpc or we can just try to see if it allows it.. wait we can't run raw SQL from standard JS client.
// I will just use the REST API manually if needed, or remove hotmart_pagos_iniciados from the upsert for now since we don't display it yet.
