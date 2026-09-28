# 26 · Auditoría de Google Analytics 4 (2026-09-28)

Auditoría pedida el 2026-09-28. El encargo tenía tres partes:

- revisar cómo avanza la integración de GA4, qué datos trae y cuáles llegan a informes y reportes;
- conseguir que esos datos se crucen fácilmente con el resto de la plataforma;
- arreglar lo que falla.

El dueño del proyecto eligió el alcance así:

- **Auditoría + arreglos + GA4 cruzable por campaña.**
- Desglose por **fuente / medio / campaña + `utm_id`** y **eventos clave**.
- **No** por landing page ni por usuarios o interacción (quedan como siguiente paso).

---

## 1. Estado de partida: GA4 no aportaba ningún dato

Medido en producción el 2026-09-28:

| Cliente         | Propiedad   | Días con sesiones | `source_synced_at.ga4` |
| --------------- | ----------- | ----------------: | ---------------------- |
| Cris tributario | `511475756` |          0 de 636 | NULL (falla siempre)   |
| Los otros 5     | —           |                 — | marcado cada día (\*)  |

\* Sin GA4 configurado, el worker marcaba igualmente la fuente como sincronizada: frescura falsa.

- **Causa raíz de Cris:** el ID `511475756` se escribió a mano (no tiene `ga_property_name`) y la cuenta de Google de la agencia (`cuentas@adshouseagencia.com`) **no ve esa propiedad**. Sí ve `524635063` «cristributario.cl», que responde bien. El error (`PERMISSION_DENIED`) solo llegaba a un `log()` del worker, así que nadie lo vio en meses.
- **Aunque hubiera funcionado,** GA4 entraba como tres números por día del sitio entero (`ga_sessions`, `ga_bounce_rate`, `ga_avg_session_duration`). Por eso solo cruzaba **por fecha**: nunca por campaña, fuente ni medio.
- **Propiedades visibles para la cuenta de la agencia:**
  - Camaradictos (`303279534`)
  - cristributario.cl (`524635063`)
  - livejunto.com (`542190565`)
  - Eventos SP Group (`412664434`, cuenta Sur Profundo, sin asignar a propósito: 0 sesiones el día anterior).
- `hotmart_pagos_iniciados` (vistas de la página de pago según GA4) valía 0 en todos los clientes.

## 2. Qué se descarga y dónde se usa (antes)

| Pieza                | Qué hacía                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchGA4` (worker)  | Un `runReport` por día, sin dimensiones, más hasta 4 consultas de `screenPageViews` para las URL del embudo de cada pestaña. Una petición por día: 5N llamadas, sin paginación y sin leer umbrales ni zona horaria. |
| `metricas_diarias`   | Guarda `ga_sessions`, `ga_bounce_rate` (fracción 0-1), `ga_avg_session_duration`, todas con `DEFAULT 0`. Las dos últimas no tenían DDL en el repo.                                                                  |
| BI (fuente `cuenta`) | `joinAxes: ['date']`: GA4 solo por fecha o total. Rebote y duración ponderados por sesiones (correcto).                                                                                                             |
| Dashboard clásico    | `$visitas` = `ga_sessions`; `funnel_costo_visita`, `% clics→visitas`, `% visitas→pagos`.                                                                                                                            |
| Agente / MCP, API v1 | Solo `ga_sessions`.                                                                                                                                                                                                 |
| Alertas              | Ninguna regla de GA4. Solo la salud de fuentes («nunca entregó una sesión»).                                                                                                                                        |

## 3. Hallazgos y qué se hizo

### Seguridad

- **Cualquiera podía sustituir la cuenta de Google de la agencia.**
  - Antes: `/api/auth/google` mandaba `state: 'agency'` fijo, el callback no lo validaba y `/api/auth/` no exige sesión en el middleware.
  - Ahora: la ruta de inicio exige rol admin/superadmin. El `state` va firmado y ligado a una cookie httpOnly, con el mismo mecanismo que Hotmart (`lib/hotmart/oauth-state.ts`, reutilizado en `lib/integrations/google-oauth-state.ts`). Un `state` de Hotmart no sirve para Google.
- **Meta y TikTok tienen el mismo patrón** (`state = clientId` sin firmar). **No se tocó**, porque queda fuera del alcance de GA4. Es el siguiente arreglo de seguridad.
- **Clave privada de GA4:** la limpieza de `guardarConfigPestana` era un no-op (`/\n/g` en vez de `/\\n/g`); corregida. Sigue guardándose en claro: la vía recomendada es el OAuth de agencia, no la service account.

### Conexión y errores visibles

- **Cliente GA compartido.** `lib/integrations/ga4-cliente.ts` concentra la precedencia de credenciales (antes duplicada en el worker y en ajustes). También traduce el error de GA4 a un mensaje accionable, con la cuenta y la propiedad.
- **«Probar conexión» ahora diagnostica.** Si falla por permisos, contrasta con las propiedades que ve la cuenta de la agencia y lo dice. Así se encontró el ID equivocado de Cris.
- **Datos corregidos:** Cris pasa a `524635063` (con nombre y cuenta de la propiedad).
- **`source_synced_at.ga4`** solo se marca si GA4 está configurado.
- **`hotmart_pagos_iniciados`** cuenta cada URL de pago una vez: dos pestañas con la misma página ya no duplican. Tampoco depende de `by_tab` de Hotmart, que queda vacío cuando Hotmart se omite.
- **Salud de fuentes** (`salud-fuentes.ts`) informa de:
  - el error REAL del desglose (crítico si es de permisos);
  - desglose desactualizado;
  - umbrales de privacidad;
  - zona horaria de la propiedad distinta de la del cliente.
- **Embudos deshabilitados:** ya no cuentan como «página de pago mapeada».

### GA4 cruzable: la fuente nueva `ga4`

Migración **097** (aplicada por el dueño del proyecto el 2026-09-28):

- `ga4_sesiones_diarias`: día × `utm_source` × `utm_medium` × `utm_campaign` × `utm_id`, con `sesiones`, `sesiones_interaccion`, `eventos_clave` e `ingresos`.
- `ga4_eventos_clave_diarios`: lo mismo por evento clave (`purchase`, `generate_lead`…).
- `ga4_estado`: por cliente, el último éxito, el **último error**, la cobertura, la moneda, la zona y los flags de umbral o fila «(other)», más el catálogo de eventos.
- RPC `ga4_reemplazar_rango`, atómica (un fallo a mitad no deja datos a medias), y RPC de lectura agregada.
- `sync_jobs_tipo_check` + `'ga4'`.

**Sincronización** (`lib/integrations/ga4-desglose.ts`, job `ga4`, ruta `/api/worker/ga4`):

- Una petición por **ventana de 31 días** con la dimensión `date`, paginada. Un año son ~24 peticiones, no ~1.800.
- Lee los metadatos (umbral, «(other)», muestreo, zona, moneda y cuota).
- `planDiario` encola los **últimos 4 días** de cada cliente con propiedad, porque GA asienta los datos en 24-72 h.
- Al guardar una propiedad nueva se encola el **backfill de ~13 meses**.
- Una respuesta vacía con datos la semana anterior no borra nada: se registra como error.

**Cruce:**

- Las UTM se guardan en crudo y la campaña se **resuelve al consultar** con el mismo motor que los leads y Hotmart (`campaign-resolver.ts`).
- `utm_id` = id de campaña de Meta cruza exacto.
- Una ubicación en `utm_source` (`Facebook_Right_Column`, `Instagram_Feed`) cuenta como Meta.
- `utm_source=google` no cruza por nombre con Meta.
- Las visitas directas y orgánicas caen en «(sin campaña)», la misma fila que los leads sin UTM.

**Métricas nuevas del BI:**

| Token                      | Qué es                                                        |
| -------------------------- | ------------------------------------------------------------- |
| `ga4_sesiones`             | Sesiones por campaña/fuente/medio                             |
| `ga4_sesiones_interaccion` | Sesiones con interacción                                      |
| `ga4_eventos_clave`        | Eventos clave (todos)                                         |
| `ga4_ingresos`             | Ingresos de GA4, convertidos a la moneda de reporte           |
| `ga4_tasa_interaccion`     | Interacción ÷ sesiones                                        |
| `ga4_tasa_rebote`          | 1 − interacción (la de GA4, agregable)                        |
| `ga4_tasa_evento_clave`    | Eventos clave ÷ sesiones                                      |
| `ga4_coste_sesion`         | Gasto ÷ sesiones                                              |
| `ga4_coste_evento_clave`   | Gasto ÷ eventos clave                                         |
| `ga4_tasa_sesion_lead`     | Leads ÷ sesiones                                              |
| `ga4_roas`                 | Ingresos GA4 ÷ gasto                                          |
| `ga4ev:<evento>`           | Un evento clave concreto; alias `ga4ev__<evento>` en fórmulas |

**Qué cruza con qué:**

- Las métricas de GA4 por campaña cruzan por **fecha, campaña (`utm_campaign`/`utm_id`), `utm_source` y `utm_medium`**. No por anuncio, conjunto, país ni pregunta de lead: GA4 no guarda `utm_content`/`utm_term` en lo que se descarga.
- Las que usan el gasto (`ga4_coste_*`, `ga4_roas`) cruzan solo por fecha y campaña.
- En el registro (`bi/registry.ts`) esto son dos desgloses nuevos, `utm` y `campaign_top`, que se combinan por **intersección** en vez de por la escala lineal de antes. Ninguna métrica existente cambia; lo comprueba `verify-bi-registry`.

**Superficies:**

- Motor (`bi-query.ts`: `queryGa4Direct` y `mergeResults`, con un solo objeto para la fila y los campos calculados).
- Fila Total (`derivadasGa4`, la misma definición).
- Disponibilidad, diagnósticos («no configurado»), editor (grupo «Eventos clave de GA4» y fórmulas) y etiquetas en informes públicos.
- Agente: validadores, `list_report_fields` con `fuente: "ga4"`, guía y skill regeneradas.

**`ga_*` no se redirige a `ga4_*`.** Por los umbrales de privacidad y la fila «(other)», la suma por campaña no tiene por qué coincidir con el total del sitio. Son dos conceptos: «GA4 del sitio» y «GA4 por campaña».

### Cifras que cambian («0» pasa a «—»)

- **`ga_sessions`, `ga_bounce_rate`, `ga_avg_session_duration` y `hotmart_pagos_iniciados`** salen «—» en un cliente sin GA4 configurado. Afecta al BI y a `get_summary` del agente.
- **Las métricas de la cuenta** (GA4 del sitio, Hotmart agregado, manuales) salen «—» cuando el gasto viene del desglose por entidad (filtro de campaña) o por plataforma. Antes salían 0.
- **Con `alcance_campanas`** (Somos rentable, Sur Profundo) y el informe por total o por fecha, esas métricas vuelven a salir. Antes el alcance las dejaba en 0 siempre.

## 4. Cifras después

Backfill de Cris (2025-08-29 → 2026-09-28, 20 s, 13 ventanas):

- **2.179 tuplas de sesiones y 18 de eventos clave.**
- La propiedad tiene datos desde finales de enero de 2026.
- **Del 1 de junio a principios de julio de 2026 GA4 no tiene ni una fila:** es un hueco del tag en el sitio, no del sync. La guarda de «vacío sospechoso» lo detectó y no escribió nada.

Del 1 al 27 de septiembre, por campaña (motor del BI real):

| Campaña (recortada)                    |   Gasto | Sesiones | Coste/sesión | Leads | Sesión → lead |
| -------------------------------------- | ------: | -------: | -----------: | ----: | ------------: |
| F2[27\|08]… ADS IMGS TANDA 1           | 137.618 |      227 |          606 |    21 |        9,25 % |
| F2[24\|08]… ADS X TANDAS - LAND DANIEL | 123.157 |      147 |          838 |    13 |        8,84 % |
| F2[22\|09]… ADS WIN - TEST LAND        | 106.607 |      157 |          679 |    10 |        6,37 % |

Por fuente, `Facebook_Right_Column` trae 216 sesiones con **99 % de rebote y 0 leads**: tráfico de la columna derecha que no convierte.

## 5. Lo que no se cambió, y por qué

- **Unidades de la tasa de rebote en el dashboard clásico** (fracción 0-1 con sufijo «%»). Cambiarlas altera fórmulas guardadas que ya multiplican por 100, así que es **decisión del dueño**. La métrica nueva `ga4_tasa_rebote` va en 0-100 y no tiene el problema.
- **«Visitas» en una pestaña con landing configurada** son vistas de página (`screenPageViews`), no sesiones. Se dice en la ayuda de la pestaña y en el código, pero no se renombró la métrica en todos los widgets.
- **Un 0 real de sesiones tras días con datos** sigue sin escribirse en el GA4 del sitio (guarda de inconsistencia del worker clásico). El desglose tiene su propia guarda, más fina.
- **Zona horaria:** la fecha de GA4 es el día de la propiedad (Cris: `Pacific/Easter`), igual que el gasto usa el día de la cuenta. No se recorta; la salud avisa si difiere de la del cliente.
- **Landing page, usuarios e interacción** quedan fuera por decisión de alcance.

## 6. Pasos operativos pendientes

1. **Desplegar** la rama. El job `ga4` y `/api/worker/ga4` no existen en producción hasta entonces. Redesplegar también el `sync-worker` del VPS, que importa `runner.ts`.
2. **Enlaces de Meta:** añadir `utm_id={{campaign.id}}` a los parámetros de URL de los anuncios. Es la clave exacta del cruce; sin ella se cruza por nombre, y un nombre recortado por GA4 no cruza.
3. **GA4 del sitio de Cris** (`ga_sessions` de `metricas_diarias`) sigue en 0 para el histórico. La sincronización diaria clásica lo rellena desde ya; para el pasado, un job `metricas` con `platforms=ga4` por tramos. Ojo con la instancia Micro.
4. **Otros clientes:** darle a la cuenta de la agencia acceso de Lector a sus propiedades y elegirlas desde el selector. Guardar la propiedad lanza el backfill solo.
5. **OAuth de Meta y TikTok:** mismo `state` sin firmar que tenía Google.

## 7. Verificación

- `npm run validate` (tsc, eslint, prettier) y `npm run test:puro`: en verde.
- Nuevo `scripts/verify-ga4-desglose.ts` (en `test:puro`), con fixtures de `runReport` con los formatos reales de Cris. Cubre:
  - mapeo por cabecera, normalización y suma de colisiones;
  - metadatos, paginación, ventanas y vacío sospechoso;
  - derivadas y sus null, y la fila Total;
  - tokens `ga4ev:`, qué cruza con qué y desgloses del registro;
  - el resolver (por id, por nombre codificado, Google no cruza, directo → «(sin campaña)»);
  - errores de GA4, el `state` de OAuth firmado;
  - `SYNC_JOB_TIPOS` ⊆ último CHECK de `migrations/`.
- `verify-salud-fuentes`: casos del desglose (error real, error ya superado, umbral, zona).
- `verify-bi-registry`: 108 métricas, paridad de etiquetas, formatos, grupos y desgloses.
- `verify-agent-informes`: el tope de discrepancias sube de 174 a 177 por la misma pareja `utm_id` que ya hereda todo el gasto.
- De punta a punta: prueba de acceso real a GA4, backfill de Cris y `runBiQuery` por campaña, fuente, total y anuncio (GA4 → «—»).
