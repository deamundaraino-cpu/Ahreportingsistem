#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Test del webhook report-utm (Hotmart) en local.
#
# Uso:
#   ./test-report-utm-webhook.sh <CLIENTE_ID> <WEBHOOK_SECRET> [HOST]
#
# Ejemplo:
#   ./test-report-utm-webhook.sh \
#     a1b2c3d4-... \
#     deadbeef... \
#     http://localhost:3000
#
# El secret se obtiene activando la integración Hotmart en
# /report-utm/clientes/<id> y copiando el valor revelado UNA vez.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

CLIENTE_ID="${1:-}"
SECRET="${2:-}"
HOST="${3:-http://localhost:3000}"

if [[ -z "$CLIENTE_ID" || -z "$SECRET" ]]; then
    echo "Uso: $0 <cliente_id> <webhook_secret> [host]"
    exit 1
fi

URL="$HOST/api/report-utm/webhooks/hotmart/$CLIENTE_ID"

# Payload de ejemplo (estructura Hotmart v2 simplificada).
TXN="HP-TEST-$(date +%s)"
PAYLOAD=$(cat <<EOF
{
  "id": "evt-$TXN",
  "creation_date": $(date +%s)000,
  "event": "PURCHASE_APPROVED",
  "version": "2.0.0",
  "data": {
    "product": {
      "id": 1234567,
      "name": "Curso Demo Report-UTM"
    },
    "buyer": {
      "name": "Cliente Demo",
      "email": "demo@example.com",
      "checkout_phone": "+54 9 11 1234 5678",
      "address": { "country": "AR" }
    },
    "purchase": {
      "transaction": "$TXN",
      "approved_date": $(date +%s)000,
      "price": { "value": 199.90, "currency_value": "BRL" },
      "tracking": {
        "source_sck": "facebook",
        "source": "campaign-test"
      },
      "customData": {
        "utm_source": "FB",
        "utm_medium": "cpc",
        "utm_campaign": "test_local_phase1",
        "utm_content": "creative_a",
        "fbclid": "fb.1.test.abc123"
      }
    }
  }
}
EOF
)

# Firma HMAC-SHA256 del raw body con el secret
SIGNATURE=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

echo "→ POST $URL"
echo "→ Transaction: $TXN"
echo "→ Signature: $SIGNATURE"
echo

curl -i -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "x-hotmart-signature: $SIGNATURE" \
    --data-raw "$PAYLOAD"

echo
echo
echo "✓ Re-ejecutá el script para probar deduplicación (mismo TXN → upsert sin error)."
