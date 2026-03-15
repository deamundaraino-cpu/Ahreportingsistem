'use server'

import { BetaAnalyticsDataClient } from '@google-analytics/data'

export async function testMetaConnection(token: string, accountId: string) {
    if (!token || !accountId) return { error: 'Faltan credenciales' }

    try {
        const actId = accountId.startsWith('act_') ? accountId : `act_${accountId}`
        const url = `https://graph.facebook.com/v19.0/${actId}?fields=name&access_token=${token}`
        const res = await fetch(url)
        const data = await res.json()

        if (data.error) {
            return { error: data.error.message }
        }
        return { success: true, name: data.name }
    } catch (err: any) {
        return { error: err.message }
    }
}

export async function testHotmartConnection(config: any) {
    let accessToken = config.hotmart_token

    try {
        if (config.hotmart_basic) {
            const params = new URLSearchParams()
            params.append('grant_type', 'client_credentials')

            const res = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${config.hotmart_basic}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params.toString()
            })
            const data = await res.json()
            if (data.error) return { error: data.error_description || data.error }
            accessToken = data.access_token
        }

        if (!accessToken) return { error: 'No hay token disponible' }

        const res = await fetch('https://developers.hotmart.com/payments/api/v1/sales/history?page_size=1', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        })
        const data = await res.json()
        if (res.status !== 200) return { error: data.error_description || 'Error de conexión' }

        return { success: true }
    } catch (err: any) {
        return { error: err.message }
    }
}

export async function testGA4Connection(config: any) {
    if (!config.ga_property_id || !config.ga_client_email || !config.ga_private_key) {
        return { error: 'Faltan credenciales de GA4' }
    }

    try {
        const formattedPrivateKey = config.ga_private_key.replace(/\\n/g, '\n')
        const analyticsDataClient = new BetaAnalyticsDataClient({
            credentials: {
                client_email: config.ga_client_email,
                private_key: formattedPrivateKey
            }
        })

        const [metadata] = await analyticsDataClient.getMetadata({
            name: `properties/${config.ga_property_id}/metadata`
        })

        return { success: true }
    } catch (err: any) {
        return { error: err.message }
    }
}
