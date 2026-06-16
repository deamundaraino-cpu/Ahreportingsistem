export type ReportUtmCliente = {
    id: string
    nombre: string
    slug: string
    descripcion: string | null
    color: string
    public_cliente_id: string | null
    config: Record<string, unknown>
    status: 'active' | 'paused' | 'archived'
    created_at: string
    updated_at: string
}

export type ReportUtmIntegration = {
    id: string
    cliente_id: string
    tipo: 'hotmart' | 'meta' | 'google' | 'cartpanda' | 'shopify' | 's2s'
    webhook_secret: string | null
    s2s_token: string | null
    access_token_encrypted: string | null
    refresh_token_encrypted: string | null
    config: Record<string, unknown>
    status: 'active' | 'error' | 'inactive'
    last_sync_at: string | null
    last_error: string | null
    created_at: string
    updated_at: string
}

export type ReportUtmSalesEvent = {
    id: string
    cliente_id: string
    platform: string
    platform_sale_id: string
    amount: number
    currency: string
    status: 'approved' | 'pending' | 'refunded' | 'chargeback'
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_content: string | null
    utm_term: string | null
    utm_id: string | null
    ad_account_id: string | null
    ad_campaign_id: string | null
    ad_set_id: string | null
    ad_id: string | null
    placement: string | null
    click_id: string | null
    customer_id: string | null
    customer_name: string | null
    customer_email: string | null
    customer_phone: string | null
    customer_country: string | null
    product_id: string | null
    product_name: string | null
    transaction_type: string | null
    raw_payload: Record<string, unknown> | null
    sale_timestamp: string | null
    received_at: string
    processed_at: string | null
    created_at: string
}

export type ReportUtmLeadEvent = {
    id: string
    cliente_id: string
    form_name: string | null
    form_id: string | null
    form_plugin: string | null
    lead_name: string | null
    lead_email: string | null
    lead_phone: string | null
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_content: string | null
    utm_term: string | null
    utm_id: string | null
    click_id: string | null
    visitor_id: string | null
    session_id: string | null
    page_url: string | null
    referrer: string | null
    ip_address: string | null
    ip_country: string | null
    user_agent: string | null
    first_touch: Record<string, unknown> | null
    last_touch: Record<string, unknown> | null
    attribution_method: string | null
    attribution_resolved_at: string | null
    custom_data: Record<string, unknown> | null
    raw_fields: Record<string, unknown> | null
    source: string
    created_at: string
}

export type ReportUtmTrackingLink = {
    id: string
    cliente_id: string
    slug: string
    nombre: string
    destination_url: string
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_content: string | null
    utm_term: string | null
    clicks_count: number
    last_click_at: string | null
    enabled: boolean
    created_at: string
    updated_at: string
}
