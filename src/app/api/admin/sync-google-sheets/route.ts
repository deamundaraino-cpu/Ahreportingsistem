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
 * Manual sync endpoint for Google Sheets leads
 * POST /api/admin/sync-google-sheets
 * Body: { clientId: string }
 * Returns: sync results with leads count
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { clientId } = body

    if (!clientId) {
      return NextResponse.json(
        { error: 'clientId is required' },
        { status: 400 }
      )
    }

    // Create admin Supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch client with Google Sheets config
    const { data: cliente, error: clientError } = await supabase
      .from('clientes')
      .select('id, nombre, config_api')
      .eq('id', clientId)
      .single()

    if (clientError || !cliente) {
      return NextResponse.json(
        { error: 'Client not found' },
        { status: 404 }
      )
    }

    const gsConfig = cliente.config_api?.google_sheets as GoogleSheetsConfig | undefined

    if (!gsConfig?.enabled || !gsConfig?.sheet_url) {
      return NextResponse.json(
        {
          error: 'Google Sheets not configured for this client',
          clientName: cliente.nombre,
        },
        { status: 400 }
      )
    }

    // 1. Fetch leads from Google Sheet (using client-specific credentials if available)
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
    const saveResult = await saveLeadsToDb(
      supabase,
      cliente.id,
      qualifiedLeads,
      dailyAggregates
    )

    return NextResponse.json({
      success: true,
      clientName: cliente.nombre,
      totalLeads: allLeads.length,
      qualifiedLeads: qualifiedLeads.filter(l => l.is_qualified).length,
      unqualifiedLeads: qualifiedLeads.filter(l => !l.is_qualified).length,
      qualificationRate: qualifiedLeads.length > 0
        ? Math.round(
            (qualifiedLeads.filter(l => l.is_qualified).length / qualifiedLeads.length) * 100
          )
        : 0,
      daysProcessed: dailyAggregates.length,
      saveResult,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error('Google Sheets sync error:', error)
    return NextResponse.json(
      {
        error: error.message || 'Failed to sync Google Sheets',
      },
      { status: 500 }
    )
  }
}

/**
 * GET endpoint to check if Google Sheets is configured
 */
export async function GET(request: NextRequest) {
  try {
    const clientId = request.nextUrl.searchParams.get('clientId')

    if (!clientId) {
      return NextResponse.json(
        { error: 'clientId is required' },
        { status: 400 }
      )
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: cliente } = await supabase
      .from('clientes')
      .select('config_api')
      .eq('id', clientId)
      .single()

    const gsConfig = cliente?.config_api?.google_sheets as GoogleSheetsConfig | undefined
    const isConfigured = gsConfig?.enabled && !!gsConfig?.sheet_url

    return NextResponse.json({
      isConfigured,
      qualityField: gsConfig?.quality_field || null,
      qualifiedValuesCount: gsConfig?.qualified_values?.length || 0,
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to check configuration' },
      { status: 500 }
    )
  }
}
