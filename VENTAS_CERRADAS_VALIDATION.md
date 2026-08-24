# Validación de VENTAS_CERRADAS Integration

## Estado de Implementación

✅ **Completado:**

- [x] Migración SQL aplicada en Supabase (011_add_ventas_cerradas.sql)
- [x] Campo `ventas_cerradas` agregado a tabla `metricas_diarias`
- [x] MCP endpoint `get_summary` expone `ventas_cerradas` en totals
- [x] MCP endpoint `get_metrics` incluye `ventas_cerradas` en datos diarios
- [x] REST API v1/metrics incluye `ventas_cerradas`
- [x] FIELD_MAP en formula-engine.ts registra `ventas_cerradas`
- [x] LayoutBuilder UI permite seleccionar `ventas_cerradas` como métrica

## Estructura de Respuesta

### get_summary Response

```json
{
  "client": { "id": "...", "name": "Cris Tributario" },
  "period": { "from": "2026-04-01", "to": "2026-05-01", "days": 30 },
  "totals": {
    "total_spend": 148060,
    "total_clicks": 475,
    "total_impressions": 31447,
    "total_sessions": 205,
    "total_revenue": 15000,
    "ventas_cerradas": 5000,      ← NUEVO CAMPO
    "roas": 0.10,
    "ctr": 1.51,
    "cpc": 311.60
  }
}
```

### get_metrics Response (diario)

```json
{
  "client": { "id": "...", "name": "Cris Tributario" },
  "period": { "from": "2026-04-01", "to": "2026-05-01" },
  "metrics": [
    {
      "fecha": "2026-04-01",
      "meta_spend": 5000,
      "meta_impressions": 1000,
      "meta_clicks": 20,
      "ga_sessions": 8,
      "hotmart_pagos_iniciados": 2,
      "ventas_principal": 500,
      "ventas_bump": 100,
      "ventas_upsell": 50,
      "ventas_cerradas": 300    ← NUEVO CAMPO
    }
  ]
}
```

## Cómo Usar

### Desde Cowork/MCP

```
Pregunta a Claude: "¿Cuáles fueron las ventas cerradas de Cris Tributario en abril?"
Claude usa get_summary → encuentra ventas_cerradas en el response
```

### Desde Dashboard

1. Ir a Admin > Layouts
2. Seleccionar métrica "Ventas Cerradas" (en sección "Ventas · Totales")
3. Guardar layout
4. Las ventas cerradas aparecerán en el dashboard

### Vía API REST

```bash
curl -X GET "http://localhost:3000/api/v1/metrics?client_id=XXX" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Datos Manuales - Cómo Cargar

Para agregar ventas de asesorías u otros cierres manuales:

1. **Vía Supabase UI:**
   - Dashboard > metricas_diarias
   - Editar fila (cliente_id, fecha)
   - Actualizar columna `ventas_cerradas`

2. **Vía API (si tienes endpoint UPDATE):**
   ```sql
   UPDATE metricas_diarias
   SET ventas_cerradas = 500
   WHERE cliente_id = 'XXX' AND fecha = '2026-05-01'
   ```

## Fórmulas Disponibles

Puedes usar `ventas_cerradas` en fórmulas personalizadas:

```
"Total Ingresos" = ventas_principal + ventas_bump + ventas_upsell + ventas_cerradas
"ROAS Combinado" = (ventas_principal + ventas_cerradas) / meta_spend
```

## Validación Rápida

Ejecutar test:

```bash
chmod +x test-ventas-cerradas.sh
./test-ventas-cerradas.sh YOUR_CLIENT_ID YOUR_API_TOKEN
```

Si ves `"ventas_cerradas": X` en ambas respuestas, ✅ está funcionando.

## Archivos Modificados

| Archivo                                             | Cambio                              |
| --------------------------------------------------- | ----------------------------------- |
| migrations/011_add_ventas_cerradas.sql              | Nuevacolumna en metricas_diarias    |
| src/app/api/mcp/route.ts                            | Expose en get_summary y get_metrics |
| src/app/api/v1/metrics/route.ts                     | Agregado a consulta SELECT          |
| src/lib/formula-engine.ts                           | Registrado en FIELD_MAP             |
| src/app/(app)/admin/layouts/LayoutBuilderClient.tsx | Opción selectable UI                |

## Próximos Pasos

- [ ] Cargar datos históricos de asesorías en ventas_cerradas
- [ ] Crear dashboard view agrupado por estrategia (asesorías vs ebook)
- [ ] Configurar alertas si ventas_cerradas > X threshold
