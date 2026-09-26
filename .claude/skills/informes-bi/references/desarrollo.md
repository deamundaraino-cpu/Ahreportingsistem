<!-- Generado por `npm run skill:informes` desde src/lib/agent/guias/informes.ts. No lo edites a mano. -->

# Desarrollo: herramientas de informes

- **Herramientas**: `src/lib/agent/tools/informes/` — `lectura.ts`, `edicion.ts`, `ciclo.ts`; validación en `validacion.ts` y `esquema.ts`; ids de cliente en `clientes-bi.ts`; revisiones en `revisiones.ts`.
- **Ejecutor**: `src/lib/agent/execute.ts`. `mutation.approval: 'directa'` (solo con `risk: 'low'`) se aplica al momento; el resto crea una propuesta en `agent_action_approvals`. `mutation.precheck` corre antes de proponer.
- **Motor**: `preview_widget` usa `paramsDeWidget` (`src/lib/report-utm/bi/consulta-widget.ts`) + `parseBiQueryParams` + `dispatchBiQuery`, igual que `/api/report-utm/bi/query`.
- **Catálogo**: `catalogoEstatico` (`src/lib/report-utm/bi/catalogo-estatico.ts`) y `camposDinamicosCliente` (`src/lib/report-utm/bi/campos-cliente.ts`).
- **Revisiones**: tabla `public.bi_report_revisions` (`migrations/092_bi_report_revisions.sql`).
- **Guía y skills**: `src/lib/agent/guias/informes.ts` es la fuente; `npm run skill:informes` regenera esta skill y la de claude.ai.
- **Tests**: `npx tsx --conditions=react-server scripts/verify-agent-informes.ts` y `scripts/verify-skill-informes.ts` (ambos en `npm run test:puro`).
