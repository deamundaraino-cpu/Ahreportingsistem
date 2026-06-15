/**
 * Google Ads Offline Conversions API (REST v18)
 * Sube una conversión por click (gclid) cuando hay una venta aprobada.
 *
 * Requiere:
 *   GOOGLE_ADS_DEVELOPER_TOKEN — developer token de la cuenta MCC
 *
 * Por cliente (en integrations.config para tipo='google'):
 *   customer_id              — ID del cliente de Google Ads (sin guiones, ej: "1234567890")
 *   conversion_action        — resource name, ej: "customers/1234567890/conversionActions/987654321"
 *   login_customer_id        — (opcional) ID del MCC si se accede a través de él
 */

const GADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? 'v18'
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? ''

export type GadsResult = {
    ok: boolean
    partial_failure?: boolean
    results?: unknown[]
    error?: string
    raw?: unknown
}

export type UploadClickConversionArgs = {
    accessToken: string
    customerId: string
    loginCustomerId?: string | null
    conversionAction: string
    gclid: string
    conversionDateTime: string
    conversionValue: number
    currencyCode: string
}

/**
 * Sube una conversión offline a Google Ads.
 * conversionDateTime debe estar en formato "yyyy-MM-dd HH:mm:ss+ZZ:ZZ"
 */
export async function uploadClickConversion(args: UploadClickConversionArgs): Promise<GadsResult> {
    const {
        accessToken,
        customerId,
        loginCustomerId,
        conversionAction,
        gclid,
        conversionDateTime,
        conversionValue,
        currencyCode,
    } = args

    if (!DEVELOPER_TOKEN) {
        return { ok: false, error: 'GOOGLE_ADS_DEVELOPER_TOKEN no configurado' }
    }

    const url = `https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${customerId}:uploadClickConversions`

    const headers: Record<string, string> = {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': DEVELOPER_TOKEN,
        'Content-Type': 'application/json',
    }
    if (loginCustomerId) {
        headers['login-customer-id'] = loginCustomerId
    }

    const body = {
        conversions: [
            {
                gclid,
                conversion_action: conversionAction,
                conversion_date_time: formatGadsDateTime(conversionDateTime),
                conversion_value: conversionValue,
                currency_code: currencyCode,
            },
        ],
        partialFailure: true,
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        })

        const json = (await res.json()) as Record<string, unknown>

        if (!res.ok) {
            const errMsg = extractGadsError(json)
            return { ok: false, error: errMsg, raw: json }
        }

        const hasPartialFailure =
            Array.isArray(json.partialFailureError) && json.partialFailureError.length > 0

        return {
            ok: !hasPartialFailure,
            partial_failure: hasPartialFailure,
            results: Array.isArray(json.results) ? json.results : [],
            raw: json,
        }
    } catch (err) {
        return { ok: false, error: String(err) }
    }
}

/** Formatea un ISO timestamp al formato que Google Ads espera: "yyyy-MM-dd HH:mm:ss+00:00" */
function formatGadsDateTime(iso: string): string {
    try {
        const d = new Date(iso)
        const pad = (n: number) => String(n).padStart(2, '0')
        const yyyy = d.getUTCFullYear()
        const MM = pad(d.getUTCMonth() + 1)
        const dd = pad(d.getUTCDate())
        const HH = pad(d.getUTCHours())
        const mm = pad(d.getUTCMinutes())
        const ss = pad(d.getUTCSeconds())
        return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}+00:00`
    } catch {
        return iso
    }
}

function extractGadsError(json: Record<string, unknown>): string {
    try {
        const errs = json.error as Record<string, unknown>
        if (errs?.message) return String(errs.message)
        return JSON.stringify(json)
    } catch {
        return 'Unknown Google Ads error'
    }
}
