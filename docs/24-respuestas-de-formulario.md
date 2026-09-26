# 24 · Respuestas de formulario: un solo sitio, una métrica por respuesta

Cómo se configuran y se usan las respuestas de los formularios de leads desde la
auditoría del 2026-09-26. Sustituye como punto de partida a los pasos manuales de
[doc 17](./17-campos-de-lead.md) y [doc 19](./19-guia-segmentos-de-lead.md), que
siguen valiendo como referencia de las reglas (sobre todo la del gasto).

---

## Lo esencial

- **Un sitio para configurar.** Ficha del cliente → pestaña **Leads**
  (`/admin/settings/[id]?tab=leads`). Ahí están las preguntas de los formularios
  (Meta Lead Ads, GoHighLevel, plugin de WordPress) y, debajo, los campos de los
  Sheets. Ya no hay que pasar por la pestaña CRM ni por el dashboard.
- **Un clic para medir una pregunta.** «Medir» crea el campo ya listo: nombre
  legible, respuestas con su nombre real (el de la plataforma si lo publica),
  variantes de escritura fundidas, «Seleccione una opción» apartado como «sin
  respuesta» y rangos ordenados de menor a mayor.
- **Cada respuesta es una métrica**, sin crear nada más, en las pestañas del
  dashboard y en los informes: `lf__<pregunta>__<respuesta>`. Los segmentos
  quedan para JUNTAR varias respuestas («Desde 2M»).
- **Renombrar no rompe nada.** Cada respuesta tiene una clave guardada
  (`lead_campos.respuestas`); renombrarla o fusionarla conserva la clave, y los
  segmentos se reescriben solos.

## La pantalla de Leads

**Preguntas medidas.** Una fila por pregunta; al abrirla, sus respuestas con los
leads y el % de cada una. Todo se guarda al momento:

| Quiero…                                           | Hago…                                                         |
| ------------------------------------------------- | ------------------------------------------------------------- |
| cambiar el nombre de una respuesta                | clic en el nombre, escribir, Enter                            |
| reordenar                                         | arrastrar por el asa, o «Orden automático» (rangos numéricos) |
| juntar dos formas de escribir lo mismo            | marcar las dos → «Unir»                                       |
| que «Seleccione una opción» no cuente             | «Apartar» en esa respuesta (cuenta como sin respuesta)        |
| «todos los que ganan de 2M para arriba»           | «≥» en la respuesta «2M» (crea el segmento acumulado)         |
| un grupo cualquiera de respuestas                 | marcar → «Nuevo segmento»                                     |
| una pregunta de casillas (varias respuestas)      | «Se pueden elegir varias»                                     |
| agrupar valores a mano, cambiar claves de origen  | ⚙ (edición avanzada)                                          |

Si llegan respuestas que el campo no conoce, sale el aviso «N respuestas sin
nombre propio» con «Añadir como respuestas».

**Preguntas detectadas sin medir.** Lo que llega en los leads o publican las
plataformas y todavía no se mide, con sus fuentes, formularios y respuestas de
ejemplo. «Medir» la activa; «Es la misma que…» la suma a una pregunta ya medida
(la versión web de una pregunta de Meta, por ejemplo).

## Usarlas

**En un informe (`/informes`):**

- Métrica → fuente **Respuestas de formulario** → cada respuesta de cada pregunta,
  agrupadas por pregunta. Funciona en tarjeta, tabla, gráficas, embudo y
  apilado.
- Dimensión → **Respuestas de formulario → Preguntas** para partir filas por
  respuesta (el gasto sale «—»: no se reparte por respuesta).
- Fórmula → «+ Métrica» → cada respuesta trae los atajos **CPL** (`spend / …`) y
  **%** (`… / leads_count * 100`). Debajo del campo aparece cómo se lee la
  fórmula.
- **Rápida → Respuestas de formulario → <pregunta>** inserta el reparto de
  respuestas y una tabla por campaña con inversión, leads y, por cada respuesta,
  sus leads y su CPL (con fila de totales).

**En una pestaña del dashboard:**

- Cualquier tarjeta, columna o gráfica: selector de fórmula → pestaña
  **Respuestas** → la respuesta, o sus atajos **CPL** (`total_spend / …`) y **%**
  (`… / utm_leads * 100`).
- Bloque «Respuestas de formulario»: opción **Mostrar CPL por respuesta**.
- Rankings y gráficas por **campaña, conjunto o anuncio** (Meta) aceptan columnas
  con respuestas. El cubo por conjunto y anuncio solo se carga cuando alguno lo
  usa; un anuncio cuyo nombre se repite en otra campaña y no trae su id no
  recibe leads (se evita colgarlos del homónimo equivocado).

## La regla del gasto (no cambia)

- **Medir** una respuesta (`lf__…`, `leadans:…`, `lseg__…`) NO recorta nada: el
  gasto es el del ámbito entero y `spend / lf__…` es el costo de conseguir un
  lead que respondió eso.
- **Filtrar o agrupar** por una pregunta sí recorta: el gasto, las ventas y todo
  lo que no sale de los leads sale **«—»** (antes salía 0, que se leía como «no
  gastó»).

## Vocabulario

| Qué                        | Fórmula (dashboard e informes) | Token de widget (BI)            |
| -------------------------- | ------------------------------ | ------------------------------- |
| Contactos                  | `utm_leads`                    | `leads_count`                   |
| Una respuesta              | `lf__<pregunta>__<respuesta>`  | `leadans:<pregunta>:<respuesta>` |
| No respondieron            | `lf__<pregunta>__sin_respuesta` | `leadans:<pregunta>:sin_respuesta` |
| Segmento                   | `lseg__<segmento>`             | `leadseg:<segmento>`            |
| La pregunta (dimensión)    | —                              | `leadfield:<pregunta>`          |

Todo vive en [`src/lib/leads/respuestas/claves.ts`](../src/lib/leads/respuestas/claves.ts).

## Para quien mantiene el código

| Pieza                                  | Dónde                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Claves estables y referencias exactas  | `src/lib/leads/respuestas/claves.ts`                                                           |
| Activación automática, orden de rangos | `src/lib/leads/respuestas/catalogo.ts` · `activar-db.ts`                                       |
| Edición de respuestas                  | `src/lib/leads/respuestas/edicion.ts`                                                          |
| Cubo único (dashboard)                 | RPC `report_utm.leads_cubo` (migración `090`) · `cubo-db.ts` (ventanas de ≤ 366 días) · `cubo.ts` |
| Preguntas de las plataformas           | tabla `report_utm.lead_preguntas` (migración `091`) · `preguntas-db.ts` · `wordpress.ts`       |
| Detección compartida                   | `src/lib/leads/respuestas/deteccion-db.ts` (`VENTANA_DESCUBRIMIENTO_DIAS`)                     |
| Pantalla                               | `src/components/report-utm/leads/LeadsConfigCard.tsx`                                          |
| APIs                                   | `/api/report-utm/lead-preguntas` · `/api/report-utm/lead-campos/activar`                       |
| Seguridad del informe público          | `src/lib/report-utm/bi/public-allowlist.ts`                                                    |
| Tests                                  | `verify-lead-respuestas`, `verify-bi-publico-seguridad` (puros) · `verify-leads-cubo-db`, `verify-lead-segmentos-db` (datos) |

**Migraciones.** La `090` (claves de respuesta + `leads_cubo`) y la `091`
(`lead_preguntas`) las aplica una persona:

```
npx tsx scripts/sql-remoto.ts migrations/090_respuestas_de_lead.sql
npx tsx scripts/sql-remoto.ts migrations/091_lead_preguntas.sql
npx tsx scripts/migrar-respuestas-lead.ts            # informe en seco
npx tsx scripts/migrar-respuestas-lead.ts --aplicar  # congela las claves (con copia)
```

Hasta entonces todo funciona con los caminos anteriores: el dashboard usa
`bi_leads_por_dia` + `bi_respuestas_por_dia` (con su tope de cuatro preguntas por
carga), las claves se derivan de forma determinista y las preguntas salen solo de
los leads.

**Selección múltiple.** Meta y GHL unen las opciones elegidas con «, »; el plugin
0.4.0 también. `bucketsDeValor` las parte probando primero el trozo más largo que
esté mapeado (una opción puede llevar comas). En una pregunta múltiple la suma de
respuestas no cierra con el total: `(sin respuesta)` se calcula contra los que
respondieron algo (`respondidosPorFecha`).
