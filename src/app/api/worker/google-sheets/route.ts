import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  fetchLeadsFromSheet,
  filterQualifiedLeads,
  computeDailyAggregates,
  saveLeadsToDb,
} from '@/lib/integrations/google-sheets'
import type { GoogleSheetsConfig } from '@/lib/integrations/google-sheets'

/**
 * Google Sheets worker - fetches leads, qualifies them, saves aggregates.
 * Triggered daily at 8 AM Colombia (UTC-5) via Vercel Cron or external cron.
 *
 * GET /api/worker/google-sheets
 * Authorization: Bearer {CRON_SECRET}
 * Optional: ?client_id=UUID (process single client)
 */
export async function GET(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const clientIdFilter = request.nextUrl.searchParams.get('client_id')

  // Fetch all clients with google_sheets config enabled
  let query = supabase.from('clientes').select('id, nombre, config_api')
  if (clientIdFilter) {
    query = query.eq('id', clientIdFilter)
  }

  const { data: clientes, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const results: Record<string, any> = {}

  for (const cliente of clientes || []) {
    const gsConfig = cliente.config_api?.google_sheets as GoogleSheetsConfig | undefined
    if (!gsConfig?.enabled || !gsConfig?.sheet_url) continue

    try {
      // 1. Fetch leads from Google Sheet (reads all configured sheet tabs)
      const allLeads = await fetchLeadsFromSheet(
        gsConfig.sheet_url,
        gsConfig.client_email,
        gsConfig.private_key,
        gsConfig.sheet_names
      )

      // 2. Filter by quality field
      const qualifiedLeads = filterQualifiedLeads(
        allLeads,
        gsConfig.quality_field,
        gsConfig.qualified_values || []
      )

      // 3. Compute daily aggregates
      const dailyAggregates = computeDailyAggregates(qualifiedLeads)

      // 4. Save to DB
      const saveResult = await saveLeadsToDb(supabase, cliente.id, qualifiedLeads, dailyAggregates)

      results[cliente.nombre] = {
        success: true,
        ...saveResult,
      }
    } catch (err: any) {
      results[cliente.nombre] = {
        success: false,
        error: err.message,
      }
    }
  }

  return NextResponse.json({
    processed: Object.keys(results).length,
    results,
    timestamp: new Date().toISOString(),
  })
}
