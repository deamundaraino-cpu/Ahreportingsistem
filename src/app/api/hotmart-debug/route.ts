import { NextResponse } from 'next/server'

const FX: Record<string, number> = {
    'USD': 1, 'CLP': 0.001064, 'BRL': 0.174,
    'COP': 0.000232, 'MXN': 0.048, 'ARS': 0.00087,
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date') || '2026-02-27'
    const basicAuth = 'YWFiZjA4NWUtYmYwMi00MzBkLTg4ZDYtODE5YzlkNWUwNmVmOmM3ZjRhNTgyLWQxOWEtNDExYS1iYjBmLWEzZTNlOGY5MWM3YQ=='

    const tokenRes = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` }
    })
    const tokenData = await tokenRes.json()
    const accessToken = tokenData.access_token
    if (!accessToken) return NextResponse.json({ error: 'No token', tokenData })

    const dayStart = new Date(date + 'T00:00:00Z').getTime()
    const dayEnd = dayStart + 86399999

    // Paginar TODOS los items
    const allItems: any[] = []
    let pageToken = ''
    let hasNext = true

    while (hasNext) {
        const url = new URL('https://developers.hotmart.com/payments/api/v1/sales/history')
        url.searchParams.append('start_date', dayStart.toString())
        url.searchParams.append('end_date', dayEnd.toString())
        url.searchParams.append('max_results', '50')
        url.searchParams.append('transaction_status', 'APPROVED')
        url.searchParams.append('transaction_status', 'COMPLETE')
        if (pageToken) url.searchParams.append('page_token', pageToken)

        const res = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${accessToken}` } })
        const data = await res.json()
        if (data.items) allItems.push(...data.items)
        pageToken = data.page_info?.next_page_token
        hasNext = !!pageToken
    }

    // Analizar cada item
    let totalUSD = 0
    const breakdown = allItems.map((item: any) => {
        const purchase = item.purchase || {}
        const currency = purchase.price?.currency_code || 'USD'
        const grossValue = purchase.price?.value || 0
        const feeTotal = purchase.hotmart_fee?.total || 0
        const feeCurrency = purchase.hotmart_fee?.currency_code || 'USD'
        const netLocal = grossValue - feeTotal
        const rate = FX[currency] ?? 1
        const feeRate = FX[feeCurrency] ?? 1

        // Escenario A: fee en USD, gross en moneda local
        const netUSD_A = parseFloat(((grossValue * rate) - (feeTotal * feeRate)).toFixed(2))
        // Escenario B: fee también en moneda local (ambos misma moneda)
        const netUSD_B = parseFloat((netLocal * rate).toFixed(2))

        totalUSD += netUSD_A

        return {
            tx: purchase.transaction,
            product: item.product?.name,
            currency,
            gross: grossValue,
            fee: feeTotal,
            fee_currency: feeCurrency,
            net_local: parseFloat(netLocal.toFixed(2)),
            rate,
            net_usd_A: netUSD_A,    // gross en local → USD, luego restar fee en USD
            net_usd_B: netUSD_B,    // (gross - fee) en local → USD
        }
    })

    return NextResponse.json({
        date, dayStart, dayEnd,
        total_items: allItems.length,
        total_USD_calculated: parseFloat(totalUSD.toFixed(2)),
        hotmart_ingreso_neto_shown: '198.12',
        breakdown
    })
}
