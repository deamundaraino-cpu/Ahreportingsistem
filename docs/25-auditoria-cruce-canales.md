# 25 · Auditoría del cruce de campañas por canal (2026-09-28)

Auditoría pedida el 2026-09-28: revisar cómo entran los datos de cada canal (Meta,
Meta Lead Ads, TikTok, Google Sheets, Hotmart, GoHighLevel, píxel y S2S), cómo se
cruzan leads y ventas con las campañas y cómo lo consumen los informes, y corregir
lo que resta precisión. Continúa la del 2026-09-14 ([doc 22](./22-auditoria-cruce-por-id.md)).

Decisiones del dueño del proyecto que guían los cambios:

- La zona horaria por cliente **se activa**, tomada de la cuenta de Meta.
- Un nombre repetido **sigue sin cruzar** («ambiguo»); no se reparte por gasto.
- Una venta se atribuye al **último lead antes de la venta**.
- La cuenta compartida Somos rentable / Sur Profundo se **recorta por palabras clave**.
- Canales nuevos: **formularios de TikTok** y **sync de oportunidades de GHL**.
- Las superficies se alinean con **tests de paridad y arreglos**, sin un motor único.
- Las cifras que cambian se **corrigen y se avisa** al cliente.

---

## 1. Cifras de partida

`scripts/auditoria-cruce.ts`, del 2026-08-29 al 2026-09-27, leads que cuentan:

| Cliente         |  Leads | Por ID | Nombre | Manual | Ambiguos | Sin cruzar | Gasto con leads |
| --------------- | -----: | -----: | -----: | -----: | -------: | ---------: | --------------: |
| Eduversio       | 21.884 |   87 % |    4 % |    0 % |      3 % |        6 % |            99 % |
| Sur Profundo    |  2.912 |   96 % |    0 % |    0 % |      0 % |        3 % |          49 %\* |
| Somos rentable  |  2.181 |   98 % |    0 % |    0 % |      0 % |        2 % |          26 %\* |
| Invest Brokers  |    208 |   99 % |    0 % |    0 % |      0 % |        1 % |            78 % |
| Cris tributario |    122 |   12 % |   23 % |   33 % |      0 % |       32 % |            89 % |

\* Cuenta de Meta compartida: cada cliente veía el gasto de la cuenta entera.

Estado de producción medido ese día:

- La migración **082 está aplicada**, pero **ningún lead tenía IDs**. El backfill
  rellenaría 721: 719 de Invest Brokers y 2 de Cris.
- **`sales_events` estaba vacía**: GoHighLevel no había registrado nunca una venta.
- **Meta Lead Ads de Eduversio** estaba en `error` desde el 2026-06-22. El cron solo
  reintentaba integraciones `active`, así que no se recuperaba nunca.
- **`sync_jobs_tipo_check` no admitía `ghl_leads`**: el plan diario abortaba al
  encolarlo, y la reconciliación diaria de Hotmart no se encolaba.
- **Las 91 ventas de Hotmart estaban sin atribución.**
- **5 de 6 clientes tienen la cuenta en Chile**. Con su zona, entre el 5 y el 7 %
  de los leads cambian de día.

---

## 2. Hallazgos y qué se hizo

### Pérdida silenciosa de datos

| Hallazgo                                                                                                                          | Arreglo                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Meta multicuenta: si fallaba una cuenta, el día se escribía solo con la otra                                                      | Todas o ninguna: el día conserva lo guardado y la red de seguridad avisa (`worker/route.ts`)                                                                                         |
| Un fallo al pedir anuncios o conjuntos escribía `[]` y la limpieza borraba `ads_daily`                                            | El nivel que falla se omite del upsert; la limpieza del espejo va por plataforma **y nivel**                                                                                         |
| Un error transitorio al sondear la 082 tiraba los IDs del lead                                                                    | Sonda optimista; `insertarLeads` reintenta sin IDs solo si falta la columna (`lead-ids.ts`)                                                                                          |
| Meta Lead Ads: formularios nuevos no se sondeaban; el webhook ignoraba integraciones en `error` y respondía 200 antes de procesar | Redescubrimiento diario; los formularios nuevos se leen 90 días atrás; el orden rota; el webhook procesa antes de responder (500 = Meta reintenta) y guarda el nombre del formulario |
| El cron de Meta Lead Ads nunca reintentaba una integración en `error`                                                             | Recoge `active` y `error`, la más atrasada primero                                                                                                                                   |
| Plugin S2S: envío sin esperar respuesta, sin reintentos y sin `external_id`; IP del servidor                                      | Envío con espera y reintento por WP-Cron; `external_id` determinista; IP y país del visitante; cookies de primer y último toque (plugin 0.5.0)                                       |
| Píxel: el «último toque» era el primero durante 90 días                                                                           | `rutm_lt` se reescribe en cada visita con señal; el evento lleva `utm_id` y los IDs                                                                                                  |
| El plan diario abortaba por el `CHECK` de `sync_jobs`                                                                             | Migración 094 y un `try` por tipo en `planDiario`                                                                                                                                    |

### Cruce lead ↔ campaña (`campaign-resolver.ts`)

- **Plataforma.** El cruce por nombre solo busca en la plataforma de `utm_source`.
  Una fuente sin gasto (Google, email) no cruza por nombre. Ver
  [doc 18](./18-fuentes-y-cruces.md#el-puente-entre-leads-y-gasto).
- **TikTok por ID.** Sus anuncios y adgroups se indexan por ID, igual que Meta.
- **Campañas homónimas.** Dos campañas con el mismo nombre dan «ambiguo» en vez de
  la última escrita. El anuncio o el conjunto pueden desempatar.
- **Cuenta compartida.** `alcance_campanas` en la ficha recorta el índice y el gasto
  del BI (`alcance-campanas.ts`).
- **Ventas antiguas.** El índice conoce la identidad de lo que gastó hasta 180 días
  antes de la ventana (`ads_entidades_ids`, 094). No suma gasto y no añade nombres.
- **Correcciones manuales:**
  - orden determinista y sin duplicados normalizados;
  - no pisan un ID exacto, salvo las de nivel anuncio;
  - «Confirmar todas» solo con ≥ 95 % de similitud y previa confirmación;
  - `nivel` y `target_*` se reinician al re-mapear;
  - la API comprueba el acceso al cliente (antes cualquier sesión veía cualquier
    diagnóstico, y el DELETE no miraba el cliente).
- **Desplegables del BI.** Usan `bi_valores_utm_v2` (094), con IDs y fuente, y
  titulan igual que el motor.
- **Consumidores.** Todos los que resuelven campaña pasan `utm_source`: el motor,
  los cubos, el diagnóstico, la salud y el agente.
- **CSV de leads.** Con un cliente elegido añade «Campaña / Conjunto / Anuncio
  (cruzado)».

### Venta ↔ campaña

- **Hotmart:**
  - una macro sin rellenar ya no cuenta como tracking propio;
  - un lead que solo trae IDs es candidato;
  - la venta heredada guarda en `utm_id` el ID más específico del lead
    (`hotmart_leads_para_atribucion_v2`, 094).
- **GoHighLevel:**
  - la venta toma la atribución del último lead del contacto anterior a la venta
    (email, teléfono o `ghl:<id>`); sin lead, el último toque de GHL como bloque;
  - la fecha de la venta es la de la oportunidad y no se mueve con los reenvíos;
  - una oportunidad perdida revierte la venta;
  - un sync diario de oportunidades (`ghl_oportunidades`) hace de red de seguridad.
    Ver [doc 20](./20-integracion-gohighlevel.md).
- **Dashboard y BI** cuentan las ventas del CRM con el mismo criterio: sin Hotmart,
  aprobadas, por `created_at` y paginadas.

### Zona horaria por cliente

- **Origen de la zona.** Sale, por este orden, de la ficha (`zona_horaria`), de la
  cuenta de Meta (`timezone_name`, que ahora guarda el vigilante de cuentas), de
  TikTok o, si no hay ninguna, de Colombia (`zona-horaria.ts`).
- **Cómo se aplica.** Cada consulta de un cliente corre en su zona
  (`zona-activa.ts`): el BI, las pestañas, la API/MCP, el diagnóstico, `/leads` y su
  CSV, la sincronización de Hotmart y la de Sheets. Los helpers de
  `colombia-date.ts` y las RPC por día (migración 095) la usan. Fuera de un cliente
  (worker, planificador, navegador) todo sigue en Colombia.
- **Sheets.** Un `created_time` con desfase va al día del cliente.
- **Histórico de Hotmart.** `scripts/recalcular-fecha-venta-hotmart.ts` recalcula
  `fecha_venta` y reagrega.

### Informes

- **Paridad.** `verify-paridad-superficies.ts` compara, cliente a cliente:
  - el gasto del BI con el del dashboard y la API;
  - los leads del BI con los del cubo del dashboard;
  - que la tabla por campaña sume el total.
    Está en `test:datos`, junto con `verify-bi-unificacion` y `verify-bi-cruce`.
- **Total de las tablas.** Calcula los ratios desde sus bases, pone «—» si el
  denominador es 0 y dice «Total (filas visibles)» con Top-N.
- **Métricas no aditivas.** Frecuencia, rebote y duración de GA4, tasa de
  calificación y porcentajes de Sheet se ponderan; antes se sumaban día a día.
- **Degradaciones visibles.** El widget avisa cuando el cruce no se pudo cargar,
  cuando falló el conteo de leads, cuando una lectura quedó incompleta y cuando hay
  gasto en otra moneda que la del informe.
- **Gasto por el camino JSONB.** Se titula con el nombre vigente de cada ID (como
  la RPC de la 082) y se ordena antes del `limit`.
- **Filas sin entidad.** «(gasto sin campaña)» ya no se funde con los leads sin UTM.
- **Frescura.** Los informes muestran cuándo se sincronizó el cliente por última vez.

### Canales nuevos

- **Formularios de TikTok** (`tiktok-leads.ts`, job `tiktok_leads`). Se activan con
  `tiktok_leads: true` en la cuenta de `tiktok_accounts`; ver
  [doc 08](./08-integraciones.md).
- **Moneda y zona de TikTok.** Se guardan en `config_api.tiktok_cuentas_info`.
- **Reconciliación de TikTok.** Incluye a los clientes que solo tienen TikTok y pide
  tramos de 30 días como máximo.

---

## 3. Pasos operativos

Hechos el 2026-09-28:

- [x] Migraciones **094** y **095** (las aplicó el dueño del proyecto).
- [x] IDs del histórico: `backfill-ids-leads.ts --aplicar` → 721 leads (719 Invest
      Brokers, 2 Cris).
- [x] Alcance de la cuenta compartida: Somos rentable `somos rentable, [lsr]`;
      Sur Profundo `-somos rentable, -[lsr]` (las «Mensajería - Fran» caen en Sur
      Profundo).
- [x] Zonas de las cuentas de Meta (`capturar-zona-cuentas-meta.ts --aplicar`):
      Eduversio en `America/Bogota`; los otros cinco en `America/Santiago`.
- [x] `recalcular-fecha-venta-hotmart.ts --aplicar`: 1 de 91 ventas de Cris cambió
      de día; 2 días reagregados.

Pendientes (fuera del código):

1. **Desplegar** la rama: el código de producción (`main`) no lee todavía el
   alcance ni la zona, y el plan diario sigue sin encolar `ghl_leads` hasta que
   corra el código nuevo con la 094 ya aplicada.
2. **Plantilla de URL con IDs** en los anuncios activos:
   - Meta: `…&utm_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`;
   - TikTok: `…&utm_id=__CAMPAIGN_ID__&adset_id=__AID__&ad_id=__CID__`.
3. **Webhook de Hotmart** por cliente que venda por Hotmart:
   1. en la configuración de webhooks de Hotmart, la URL
      `https://reportes.adshouse.cloud/api/report-utm/webhooks/hotmart/<id de report_utm.clientes>`
      (la muestra la tarjeta de Hotmart del cliente), con los eventos de compra,
      reembolso y contracargo;
   2. pegar el hottok de Hotmart en la tarjeta del cliente;
   3. añadir `sck={{ad.id}}` a los enlaces del checkout de los anuncios;
   4. comprobar que la venta de prueba llega a `hotmart_ventas` con `utm_id`.
4. **GoHighLevel**: dar al token el alcance `opportunities.readonly` y crear el
   Workflow «Opportunity Status Changed» que llama al webhook de ventas.
5. **Formularios de TikTok**: poner `tiktok_leads: true` en la cuenta de
   `tiktok_accounts` del cliente que los use.
6. **Eduversio**: reconectar Meta con permiso de Páginas o desactivar su
   integración de Meta Lead Ads (sus leads entran por S2S).
7. **Avisar a los clientes** de las cifras del apartado 4.

## 3 bis. Cifras después

`scripts/auditoria-cruce.ts`, mismo rango (2026-08-29 → 2026-09-27):

| Cliente         | Gasto con leads antes | Después | IDs propios en los leads |
| --------------- | --------------------: | ------: | -----------------------: |
| Somos rentable  |                  26 % |    74 % |                      0 % |
| Sur Profundo    |                  49 % |    76 % |                      0 % |
| Invest Brokers  |                  78 % |    78 % |                     98 % |
| Eduversio       |                  99 % |    99 % |                      0 % |
| Cris tributario |                  89 % |    89 % |                      0 % |

Los IDs propios del resto llegarán con la plantilla de URL (paso 2). El desglose
«sin cruzar» ya no sale en negativo.

## 4. Cifras que cambian (aviso a clientes)

| Qué                                                                                       | Antes                     | Ahora                                             |
| ----------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------- |
| Frecuencia de Meta en un rango y en rankings                                              | suma de las diarias       | impresiones ÷ alcance                             |
| Rebote y duración de GA4                                                                  | suma de las diarias       | media ponderada por sesiones                      |
| Tasa de calificación y columnas % de Sheets                                               | suma                      | cociente / media ponderada                        |
| ROAS y ventas sin Hotmart conectado; `ga_*` sin GA4; `tiktok_*` sin TikTok                | 0                         | «—»                                               |
| Total de las tablas del BI (CPL, CPA, ROAS, CTR…)                                         | 0                         | el ratio real                                     |
| Días de leads y ventas de clientes con cuenta en Chile                                    | día de Colombia           | día de Chile (~5–7 % de los leads cambian de día) |
| Gasto de Somos rentable y Sur Profundo en el BI (con alcance)                             | cuenta entera             | solo sus campañas                                 |
| Una campaña renombrada en rangos antiguos (camino JSONB)                                  | dos filas                 | una fila, con el nombre vigente                   |
| Leads con un nombre de campaña repetido, o de TikTok con el nombre de una campaña de Meta | la última campaña escrita | «ambiguo», o la de su plataforma                  |
| Presupuesto de una pestaña filtrada por grupo de campañas                                 | 0                         | el gasto real del grupo                           |

---

## 5. Lo que no se cambió, y por qué

- **El filtro de `/leads` sigue sobre el UTM crudo.** Es un buscador de campos
  (`utm_campaign` contiene…) y los enlaces guardados dependen de ello. La campaña
  resuelta está en el CSV (con un cliente elegido) y en los informes.
- **El gasto no se convierte de moneda.** Hoy ningún cliente mezcla monedas en sus
  cuentas. En vez de convertir, cada informe avisa si una cuenta de Meta o de
  TikTok gasta en otra moneda que la del informe.
- **`sales_events.amount` no se convierte.** Las ventas de GHL se escriben ya en
  la moneda de reporte del cliente, y el espejo de Hotmart no cuenta en `sales.*`.
- **Fórmulas que suman `hm_*` y `sales.*`.** No se bloquean. Sumarlas cuenta dos
  veces solo si un mismo cliente vende por Hotmart y por el CRM a la vez, que hoy
  solo podría pasar con Cris. Si se hace, que sea a sabiendas.
- **Las preguntas de los formularios de TikTok** no se guardan en
  `lead_preguntas`: su `CHECK` de `fuente` no admite `tiktok`. Las respuestas sí
  entran en `raw_fields` y se pueden medir como campos de lead.

## 6. Verificación

```bash
npm run validate
npm run test:puro    # incluye verify-cruce-por-id, verify-zona-cliente, verify-ghl-ventas, verify-tiktok-leads…
npm run test:datos   # incluye verify-paridad-superficies, verify-bi-unificacion, verify-bi-cruce
npx tsx --conditions=react-server scripts/auditoria-cruce.ts   # antes y después
```
