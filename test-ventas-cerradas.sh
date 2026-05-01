#!/bin/bash

# Test script to verify VENTAS_CERRADAS is available in MCP endpoints
# Usage: ./test-ventas-cerradas.sh <client_id> <token>

CLIENT_ID="${1:-YOUR_CLIENT_ID}"
TOKEN="${2:-YOUR_API_TOKEN}"
BASE_URL="${3:-http://localhost:3000}"

echo "Testing VENTAS_CERRADAS integration..."
echo "Base URL: $BASE_URL"
echo "Client ID: $CLIENT_ID"
echo ""

# Test 1: get_summary endpoint
echo "▶ Test 1: get_summary endpoint"
curl -s -X POST "$BASE_URL/api/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "call_tool",
    "params": {
      "name": "get_summary",
      "arguments": {
        "client_id": "'$CLIENT_ID'"
      }
    }
  }' | jq '.result.totals | {total_revenue, ventas_cerradas, roas}'

echo ""

# Test 2: get_metrics endpoint (daily breakdown)
echo "▶ Test 2: get_metrics endpoint (should show ventas_cerradas per day)"
curl -s -X POST "$BASE_URL/api/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "call_tool",
    "params": {
      "name": "get_metrics",
      "arguments": {
        "client_id": "'$CLIENT_ID'",
        "from": "2026-04-01",
        "to": "2026-05-01"
      }
    }
  }' | jq '.result.metrics[0] | {fecha, ventas_principal, ventas_bump, ventas_upsell, ventas_cerradas}'

echo ""
echo "✓ If both responses show ventas_cerradas, the integration is working!"
