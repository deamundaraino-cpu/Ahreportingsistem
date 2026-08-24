# report-utm — módulo de tracking & atribución

Módulo aislado dentro del mismo proyecto Next.js. Comparte auth, deploy y
cliente Supabase con el reporting principal, pero **no comparte tablas ni rutas**.

## Activación local

1. Correr la migration:

   ```bash
   npx supabase db query --linked -f migrations/012_report_utm_schema.sql
   ```

2. En Supabase Studio → **Settings → API → Exposed schemas**, agregar `report_utm`
   a la lista (separado por coma del `public` que ya está).

3. En `.env.local`:

   ```
   NEXT_PUBLIC_REPORT_UTM_ENABLED=true
   ```

4. `npm run dev` y entrar a `/report-utm` (solo admin/superadmin).

En producción, mientras la flag no esté activa, el route group redirige a
`/dashboard` y el switcher del sidebar principal queda oculto.

## Aislamiento

| Concepto         | Ubicación                                        |
| ---------------- | ------------------------------------------------ |
| Tablas           | schema Postgres `report_utm.*` (no `public.*`)   |
| Rutas UI         | `src/app/(report-utm)/report-utm/**`             |
| API              | `src/app/api/report-utm/**` (próximas fases)     |
| Sidebar          | `src/components/report-utm/ReportUtmSidebar.tsx` |
| Cliente Supabase | `src/lib/report-utm/client.ts`                   |
| Tipos            | `src/lib/report-utm/types.ts`                    |

`report_utm.clientes` tiene un FK opcional `public_cliente_id` por si
después se quiere cruzar un cliente del módulo con uno del reporting principal,
pero por defecto son universos separados.

## Roadmap

- **Fase 0** — Esqueleto (✅ implementado).
- **Fase 1** — Webhook Hotmart + sales_events + listado de ventas.
- **Fase 2** — Dashboard UTM + atribución + agregaciones.
- **Fase 3** — Tracking links `/t/:slug` + pixel JS.
- **Fase 4** — Meta CAPI outbound + reglas / automatizaciones.
