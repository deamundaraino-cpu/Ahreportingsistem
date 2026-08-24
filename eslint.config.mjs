import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Microservicios independientes, cada uno con su propio tsconfig/deps.
    // Coinciden con los `exclude` de tsconfig.json y con .prettierignore.
    'whatsapp-gateway/**',
    'sync-worker/**',
  ]),

  // Convención de descarte explícito: un identificador que empieza por `_` es
  // un placeholder intencional (posición en una desestructuración, argumento
  // que la firma exige pero no se usa, error que se traga a propósito). Sin
  // esto no hay forma de distinguirlo de un olvido, y `--max-warnings 0`
  // obliga a borrarlo aunque haga falta.
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // DEUDA TÉCNICA — listas congeladas el 2026-08-24
  //
  // Estas listas SOLO PUEDEN ENCOGER. No añadas archivos: si aparece uno
  // nuevo, el arreglo es limpiar el archivo, no alargar la lista.
  // Van rutas exactas a propósito — un glob de carpeta dejaría entrar
  // archivos nuevos sin que nadie se entere. Los corchetes de las rutas
  // dinámicas de Next se escriben [[]id[]]: un [id] literal se interpreta
  // como clase de caracteres y no casaría nunca.
  //
  // Al limpiar un archivo, bórralo de la lista en el mismo commit.
  // ─────────────────────────────────────────────────────────────────────────

  // `any` heredado del dashboard y el worker antiguos: 699 usos en
  // 70 archivos. `src/lib/report-utm/**` ya está limpio y no aparece
  // aquí, igual que todo el código nuevo. Plan de vaciado por rentabilidad:
  // (1) `catch (e: any)` → `catch (e)` + helper sobre `unknown`,
  // (2) tipos generados de Supabase para las filas de BD,
  // (3) interfaces de la Graph API de Meta en api/worker/route.ts,
  // (4) una `MetricRow` compartida por campaign-filter.ts y ranking-aggregation.ts.
  {
    files: [
      'scripts/seed-bi-plantillas.ts', // 1
      'scripts/verify-sync-fixes.ts', // 8
      'scripts/verify-upsert-preserva.ts', // 1
      'src/app/(app)/admin/configuracion/_actions.ts', // 4
      'src/app/(app)/admin/configuracion/components/ConfiguracionClient.tsx', // 22
      'src/app/(app)/admin/configuracion/page.tsx', // 10
      'src/app/(app)/admin/layouts/LayoutBuilderClient.tsx', // 15
      'src/app/(app)/admin/layouts/TabTemplatesManager.tsx', // 4
      'src/app/(app)/admin/reports/_actions.ts', // 4
      'src/app/(app)/admin/reports/[[]id[]]/page.tsx', // 11
      'src/app/(app)/admin/reports/ReportsClient.tsx', // 2
      'src/app/(app)/admin/settings/_actions.ts', // 49
      'src/app/(app)/admin/settings/components/ClientConfigForm.tsx', // 18
      'src/app/(app)/admin/settings/components/ClienteCard.tsx', // 1
      'src/app/(app)/admin/settings/page.tsx', // 1
      'src/app/(app)/admin/sync/_actions.ts', // 3
      'src/app/(app)/dashboard/_actions.ts', // 55
      'src/app/(app)/dashboard/[[]clientId[]]/page.tsx', // 1
      'src/app/(app)/dashboard/components/ConversionesOfflineCard.tsx', // 1
      'src/app/(app)/dashboard/components/CountryBreakdown.tsx', // 1
      'src/app/(app)/dashboard/components/DashboardClient.tsx', // 75
      'src/app/(app)/dashboard/components/LayoutConfigModal.tsx', // 26
      'src/app/(app)/dashboard/components/MetricCharts.tsx', // 26
      'src/app/(app)/dashboard/components/PuzzleComponents.tsx', // 6
      'src/app/(app)/dashboard/components/QuickEditModal.tsx', // 14
      'src/app/(app)/dashboard/components/RankingTableBlock.tsx', // 3
      'src/app/(app)/dashboard/components/SupportModule.tsx', // 3
      'src/app/(app)/dashboard/components/TabArchiveView.tsx', // 19
      'src/app/(app)/dashboard/components/TabConfigModal.tsx', // 3
      'src/app/(app)/dashboard/page.tsx', // 5
      'src/app/(app)/soporte/page.tsx', // 2
      'src/app/(app)/soporte/SoporteClient.tsx', // 3
      'src/app/api/admin/detect-sheet-columns/route.ts', // 1
      'src/app/api/admin/list-ga4-properties/route.ts', // 1
      'src/app/api/admin/list-google-sheets/route.ts', // 1
      'src/app/api/admin/list-sheet-tabs/route.ts', // 1
      'src/app/api/admin/sync-conversiones-offline/route.ts', // 4
      'src/app/api/auth/meta/callback/route.ts', // 1
      'src/app/api/auth/tiktok/callback/route.ts', // 2
      'src/app/api/backfill-forms/route.ts', // 5
      'src/app/api/cron/cierre-mes/route.ts', // 2
      'src/app/api/cron/refresh-hotmart-tokens/route.ts', // 2
      'src/app/api/cron/refresh-meta-tokens/route.ts', // 2
      'src/app/api/mcp/route.ts', // 2
      'src/app/api/v1/ad-thumbnails/route.ts', // 1
      'src/app/api/v1/campaigns/route.ts', // 1
      'src/app/api/worker/enqueue/route.ts', // 2
      'src/app/api/worker/google-sheets-conversiones/route.ts', // 2
      'src/app/api/worker/reconcile/route.ts', // 10
      'src/app/api/worker/route.ts', // 110
      'src/app/p/[[]token[]]/page.tsx', // 1
      'src/app/report/monthly/[[]slug[]]/page.tsx', // 5
      'src/lib/campaign-filter.ts', // 29
      'src/lib/country-parser.ts', // 5
      'src/lib/form-filter.ts', // 5
      'src/lib/formula-engine.ts', // 6
      'src/lib/fx.ts', // 3
      'src/lib/hooks/useLayoutReorder.ts', // 1
      'src/lib/integrations/google-analytics.ts', // 1
      'src/lib/integrations/google-sheets-conversiones.ts', // 22
      'src/lib/notifications/rules-engine.ts', // 2
      'src/lib/offline-filter.ts', // 6
      'src/lib/ranking-aggregation.ts', // 22
      'src/lib/rate-limit.ts', // 6
      'src/lib/report-utm/bi-query.ts', // 2
      'src/lib/sync/planner.ts', // 10
      'src/lib/sync/queue.ts', // 14
      'src/lib/sync/reconcile.ts', // 2
      'src/lib/sync/runner.ts', // 9
      'src/lib/validation.ts', // 1
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  // Reglas del compilador de React: 20 avisos en 11 archivos.
  // NO son ruido — marcan renders en cascada y efectos que refetchean de más.
  // Quedan fuera de este pase porque cada uno es un refactor de comportamiento
  // que hay que verificar a mano en la app, y estos componentes no tienen
  // cobertura automática. El patrón dominante es el `setLoading(true)` síncrono
  // al entrar en el efecto: la solución es derivar el estado de carga de la
  // clave de la petición en vez de escribirlo.
  {
    files: [
      'src/app/(app)/dashboard/components/DashboardClient.tsx', // 5
      'src/app/(app)/dashboard/components/LayoutConfigModal.tsx', // 1
      'src/app/(app)/dashboard/components/MetricCharts.tsx', // 2
      'src/app/(app)/dashboard/components/SupportModule.tsx', // 1
      'src/app/(app)/dashboard/components/TabArchiveView.tsx', // 1
      'src/components/notifications/NotificationBell.tsx', // 1
      'src/components/report-utm/bi/BiCalcFieldsModal.tsx', // 1
      'src/components/report-utm/bi/widgets/ChartWidget.tsx', // 2
      'src/components/report-utm/bi/widgets/FunnelWidget.tsx', // 2
      'src/components/report-utm/bi/widgets/ScorecardWidget.tsx', // 2
      'src/components/report-utm/bi/widgets/TableWidget.tsx', // 2
    ],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
]);

export default eslintConfig;
