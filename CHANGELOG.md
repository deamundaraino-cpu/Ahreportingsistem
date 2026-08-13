# Changelog

Todas las versiones notables de **Ad House Reporting** se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/)
y el proyecto adhiere a [Versionado Semántico](https://semver.org/lang/es/):
`MAYOR.MENOR.PARCHE`.

## [No publicado]

### Añadido
- **Desglose de leads por respuesta de formulario en el General Overview.** Un
  bloque configurable más del layout de cada pestaña (**Agregar → Respuestas de
  formulario**) que responde «cuántos leads contestaron A, cuántos B y cuántos C»
  en una pregunta, no solo «cuántos respondieron». Respeta el filtro de campañas
  y el rango de fechas de la pestaña, viaja al enlace público, compara contra el
  período anterior y se exporta a CSV. Migración `071`.
  - Usa los campos de lead ya configurados (`report_utm.lead_campos`) cuando
    existen y, si no, **autodetecta** las preguntas de opción del formulario. El
    botón «Guardar en el catálogo» promueve una pregunta detectada a campo real.
  - Modo **tabla diaria**: el total de contactos de cada día y su reparto por
    respuesta, incluidos los que no contestaron. La fila cierra siempre.
- **Métricas de Report-UTM en cualquier widget.** `utm_leads` (contactos del día
  según `lead_events`) y una métrica por respuesta (`lf__<campo>__<respuesta>`,
  más su `sin_respuesta`) disponibles en tarjetas, gráficas, columnas de tabla y
  tablas de ranking. Migración `072`.
  - Se inyectan en el cliente, ya recortadas por el filtro de campañas de la
    pestaña —igual que los campos `funnel_*`—, de modo que dividirlas por el
    gasto da el costo por lead de un segmento y no una cifra descuadrada.
  - **El gasto sigue sin repartirse entre respuestas**, que es lo que docs 17 y
    18 rechazan. Dividir el gasto total del ámbito por los leads de un tipo sí
    está permitido y es la razón de ser de estas métricas.
  - `utm_leads` **no se suma con `meta_leads`**: miden lo mismo desde fuentes
    distintas y se solapan.

### Cambiado
- **El filtro de Sheet del Layout Builder ya no se sale de la tarjeta.** Se
  colapsa en un icono y solo se despliega al usarlo o cuando ya hay un filtro
  configurado; las filas de controles pasan a `flex-wrap`. Antes sus tres
  selects competían por el ancho con el filtro de campaña y se desbordaban
  sobre el botón de eliminar.
- **Deja de ofrecerse donde nunca pudo funcionar.** No aparece en gráficos con
  `dimension`, y `RankingTableDef.sheetFilter` desaparece del tipo. Ambos
  agregan por campaña/anuncio con `aggregateRankingRows`, que construye sus
  filas desde `meta_campaigns`/`meta_ads`: no llevan datos offline, así que el
  filtro no tenía a qué aplicarse.
- **`Offline: CPA Real`, `Close Rate` y `ROAS Real` solo se ofrecen si hay
  ventas offline.** Dividen por `offline_ventas` y, con la configuración
  recomendada («Tipo fijo → Todas son leads»), ese divisor es 0 permanente: la
  métrica solo podía mostrar «–». Reaparecen en cuanto el Sheet mapee una
  columna de tipo con valor `venta`.

### Corregido
- **El comparativo de las tarjetas con filtro de Sheet salía siempre 0.** El
  período anterior se cargaba sin `offline_rows`, así que `enrichOfflineRow`
  veía una lista vacía y devolvía 0 en todas las claves offline; el guard
  `prevValue !== 0` ocultaba entonces el delta. Ahora esas filas se cargan si
  algún bloque del layout, de sus pestañas o de sus plantillas declara un
  `sheetFilter` (`layoutUsaSheetFilter`), y solo entonces.
- **El archivo de pestañas ignoraba el filtro de Sheet.** `computeCardValue`
  aplicaba únicamente `campaignFilter`, así que la misma tarjeta mostraba un
  número en el dashboard y otro en el archivo. `getArchiveMetrics` acepta ahora
  el flag de filas offline y `TabArchiveView` lo pide solo cuando alguna
  tarjeta archivada las va a filtrar — el archivo abarca desde 2020.
- **El espejo público perdía las tablas de ranking.** `getMirrorDashboardData`
  construía el layout de la pestaña sin `ranking_tables`, así que una tabla
  configurada en una pestaña se veía en el dashboard interno y desaparecía sin
  ningún error en el enlace compartido al cliente. Presente desde la migración
  018.

- **Las métricas de respuestas no aparecían en el selector.** El filtro del
  desplegable descartaba toda métrica cuyo id contuviera `__`, una guarda pensada
  para los sumandos internos de los campos de Sheet. Escondía las
  `lf__<campo>__<respuesta>` enteras, así que solo se podían usar escribiendo la
  fórmula a mano. La comprobación pasa a ser por prefijo y sufijo — y de paso se
  descubrió que la guarda genérica no protegía de nada: `buildAvailableMetrics`
  nunca ha emitido esos sumandos.
- **El filtro de campaña de una tarjeta o columna no recortaba sus contactos.**
  `applyCompoundFilter` solo recalcula las claves `meta_*`/`tiktok_*`, así que una
  tarjeta `meta_spend / utm_leads` con filtro propio dividía un gasto ya recortado
  entre los leads de TODA la pestaña: el CPL salía sistemáticamente hundido y nada
  lo delataba. Ahora la fila lleva el cubo por referencia y las claves se
  re-derivan con el filtro del bloque encadenado al de la pestaña.
- **Rankings y gráficas por dimensión** mostraban `—` o —peor— un 0 literal en
  estas métricas. En dimensión Campaña ahora se reparten de verdad; en Anuncio y
  Conjunto declaran `n/a` con el motivo, porque un lead se resuelve a campaña y no
  a anuncio.
- **Gráficas con filtro de campaña propio** salían planas en 0: consumían las
  filas previas a la inyección. Reciben las suyas, y con el filtro de pestaña
  **sin** aplicar, que es lo que su contrato significa.
- **Días con formularios pero sin inversión** mostraban `—` en vez de sus
  contactos: la fila de relleno no llevaba las claves.
- **Truncado silencioso en las consultas de respuestas.** PostgREST corta las
  respuestas de RPC en 1.000 filas igual que las de tabla, así que el desglose de
  un cliente con más combinaciones mostraba de menos —cuadrando consigo mismo, lo
  que lo hacía indetectable a ojo—. Ahora se pagina y se declara si algo se
  trunca. Detectado midiendo Eduversio: 14.090 contactos de 22.224 reales.

### Interno
- Índice de cobertura `idx_rutm_lead_events_utm_cover`. Sin él, el total diario
  del cliente mayor tardaba **8.105 ms en frío** y agotaba el `statement_timeout`
  de 8 s (460 ms en caliente). Con él es un Index Only Scan sin lecturas de heap:
  7.707 páginas → 453, 562 ms leyendo de disco. Cuesta 13 MB. Requiere el VACUUM
  que la migración ejecuta: sin el mapa de visibilidad el planificador lo ignora.
- `resolveRtmClienteId()` en `campaign-resolver.ts`: el camino público →
  report_utm estaba copiado dentro de la página del dashboard y hacía falta otra
  vez para el bloque nuevo.
- `report_utm.norm_clave()`: espejo SQL de `sanitizarColumna`, para que las
  consultas encuentren las claves de `raw_fields` tal como las escribió el
  formulario (con acentos, espacios y mayúsculas) y no solo las de Meta, que ya
  llegan en snake_case.

## [1.0.0] - 2026-06-23

Primer release estable en producción (https://reportes.adshouse.cloud/).

### Plataformas y sincronización
- Integración con **Meta Ads** (OAuth, refresco automático de tokens, Meta Forms, leads).
- Integración con **TikTok Ads** con soporte multi-cuenta y filtrado por `account_id`.
- Integración con **Hotmart** (OAuth, funnels, suscripciones) y **Google Analytics 4**.
- Integración con **Google Sheets** para conversiones offline y leads por cliente.
- Worker de sincronización con procesamiento de clientes en paralelo y fetch por rango.

### Dashboards e informes
- Dashboard por cliente con **pestañas personalizables** (drag & drop, archivado).
- **Plantillas de pestañas** globales reutilizables: guarda la visualización de una
  pestaña y aplícala al crear nuevas pestañas en cualquier cliente. Gestión
  (renombrar/eliminar) desde **Constructor de Layouts**.
- **Constructor de Layouts**: plantillas de métricas asignables a clientes.
- **Motor de fórmulas** para métricas aritméticas y macros.
- Tarjetas (KPIs), gráficos, tablas de ranking y bloques de texto editables en línea.
- Filtros de campaña compuestos aplicados a tarjetas, gráficos y tablas.
- **Reportes Mensuales** y **Report-UTM** (informes BI, atribución, links, píxel).
- Enlaces públicos (mirror) por cliente y por pestaña.

### Operación y equipo
- Roles y permisos: superadmin, admin, trafficker, viewer.
- Módulo de **Roadmap / Soporte** con gestión de tickets.
- **Notificaciones** in-app (campanita) y por **WhatsApp** (Evolution API).
- **Bitácoras** y tema claro/oscuro.

[1.0.0]: https://reportes.adshouse.cloud/
