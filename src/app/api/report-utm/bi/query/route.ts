import { NextRequest, NextResponse } from 'next/server'
import { parseBiQueryParams } from '@/lib/report-utm/bi-query-params'
import { dispatchBiQuery } from '@/lib/report-utm/bi-dispatch'
import { createClient } from '@/utils/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    try {
        const parsed = parseBiQueryParams(req.nextUrl.searchParams)
        const result = await dispatchBiQuery(parsed)
        if (result.error) {
            return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
        }
        return NextResponse.json({ data: result.data })
    } catch (err) {
        console.error('[bi/query]', err)
        return NextResponse.json({ error: 'Query error' }, { status: 500 })
    }
}
