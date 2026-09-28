# 18 · Fuentes de datos y cruces — guía para armar informes

Cómo están organizados los datos del BI, qué se puede cruzar con qué y por qué,
y cómo traducir una pregunta de negocio en un widget.

Para la configuración previa (conectar un Sheet, definir campos) ver
[doc 16 · Campos de Sheet](./16-campos-de-sheet.md) y
[doc 17 · Campos de lead](./17-campos-de-lead.md).
Para el detalle de tablas, [doc 04 · Modelo de datos](./04-modelo-de-datos.md).

---

## El modelo en una frase

Cada métrica pertenece a **una fuente**, cada fuente tiene un **grano** (qué hace
única una fila) y una lista de **ejes** por los que sabe cruzarse. Un widget
funciona cuando todas las métricas que le pides comparten el eje por el que lo
agrupas.

Eso es todo. El resto de esta guía son las consecuencias.

---

## Parte 1 · Las ocho fuentes

| Fuente                   | Qué mide                                                                     | Grano         | Cruza por                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| **Leads**                | Contactos, uno por fila (formulario web, Meta Lead Ads o CRM de GoHighLevel) | fila          | fecha · plataforma · campaña · conjunto · anuncio · **cualquier columna suya** · campos de formulario |
| **Ventas**               | Transacciones de `sales_events` (GHL…), una por fila; **sin Hotmart**        | fila          | fecha · plataforma · campaña · conjunto · anuncio · UTM · columnas de venta                           |
| **Ventas Hotmart**       | Transacciones de `hotmart_ventas`, una por fila (`hm_*`)                     | fila          | fecha · plataforma · campaña · conjunto · anuncio · UTM · columnas de venta                           |
| **Anuncios**             | Gasto y métricas de plataforma                                               | día × entidad | fecha · plataforma · campaña · conjunto · anuncio                                                     |
| **Cuenta**               | GA4 del sitio (`ga_*`), Hotmart de cuenta (`ventas_*`), métricas manuales    | día           | **solo fecha**                                                                                        |
| **GA4 por campaña**      | Sesiones y eventos clave de `ga4_sesiones_diarias` (`ga4_*`, `ga4ev:`)       | día × UTM     | fecha · campaña · UTM (`utm_source`, `utm_medium`) — **no** conjunto ni anuncio                       |
| **Conversiones offline** | Totales diarios de un Sheet                                                  | día           | **solo fecha**                                                                                        |
| **Campos de Sheet**      | Columnas de un Sheet convertidas en métricas                                 | día / fila    | fecha · valor del campo · campaña · conjunto · anuncio                                                |
| **Suscripciones**        | Foto actual de Hotmart                                                       | foto          | **ninguno** (solo el total)                                                                           |

### Por qué el grano importa

- **Grano de fila** (Leads, Ventas, Ventas Hotmart) — se pueden **contar** y sirven
  de **eje de una tabla dinámica**. Son las únicas.
- **Grano de día** (Anuncios, Cuenta, Offline, Sheet) — vienen preagregadas. Se
  suman, pero no se pueden repartir por algo que la fila no sabe.
- **Foto** (Suscripciones) — no tiene eje temporal. Solo tiene sentido en el total
  del período; en una serie por fecha no aparece.

### Por qué «solo fecha» es una limitación real

`Cuenta` y `Conversiones offline` están agregadas por día y cliente. Una fila
dice «el 12 de julio hubo 340 sesiones», no _de qué campaña_ venían. No es que
falte configurarlo: **el dato no existe**. Por eso al agrupar por campaña esas
métricas caen en la fila total en vez de repartirse.

---

## Parte 2 · La regla del cruce

> Una métrica se desglosa por una dimensión **solo si su fuente declara ese eje**.
> Si no, cae en la fila total.

Y para una métrica derivada, la regla se hereda de la más restrictiva de sus
partes. Ejemplos que conviene tener en la cabeza:

| Métrica                             | Se desglosa por campaña | Se desglosa por país                 |
| ----------------------------------- | ----------------------- | ------------------------------------ |
| Leads                               | sí                      | sí (es columna suya)                 |
| Gasto                               | sí                      | **no** (Anuncios no tiene país)      |
| **CPL** (gasto ÷ leads)             | sí                      | **no** — hereda el límite del gasto  |
| Tasa de conversión (ventas ÷ leads) | sí                      | sí — las dos son de grano fila       |
| Sesiones GA4 del sitio (`ga_*`)     | **no**                  | **no** — Cuenta solo cruza por fecha |
| Sesiones GA4 por campaña (`ga4_*`)  | **sí**                  | **no** — GA4 no tiene país de lead   |

Esto es lo que explica el caso que más desconcierta: **un CPL por país sale
vacío o absurdo**. Los leads sí se reparten por país, el gasto no, así que la
división no significa nada. El editor lo avisa antes de que lo pidas.

### El puente entre leads y gasto

Leads y gasto viven en tablas distintas y el gasto no tiene UTM. El puente es la
**identidad de la campaña**, y se resuelve en cascada:

1. Corrección manual del trafficker (`/cruce-campanas`), a nivel
   campaña, conjunto o anuncio
2. **IDs propios del lead** (desde 2026-09-14, migración 082): `ad_id` → `adset_id`
   → `campaign_id`. Los traen Meta Lead Ads, la atribución de GoHighLevel, los
   Sheets con columnas de ID y los enlaces con `ad_id={{ad.id}}`
3. `utm_id` = id de campaña
4. `utm_id` = id de anuncio o de conjunto → sube a su campaña
5. El ID llegó en el campo del NOMBRE (desde 2026-09-12): `utm_campaign` = id de
   campaña, `utm_content` = id de anuncio, `utm_term` = id de conjunto
6. `utm_campaign` = nombre de campaña (normalizado; también los nombres
   anteriores de una campaña renombrada, y los UTM que llegan URL-encoded)
7. `utm_content` = nombre de anuncio · `utm_term` = nombre de conjunto — **solo si
   ese nombre lleva a UNA campaña**, solo o cruzando anuncio con conjunto

**Los pasos 2 a 5 son los que sostienen el sistema.** Hoy entre el 67 % y el
100 % de los leads cruzan, y en dos clientes el cruce por nombre daría
prácticamente cero — sus campañas llevan emojis y corchetes que no coinciden con
el UTM. Cruzan porque el ID los rescata. El paso 5 existe porque GoHighLevel y
algunos enlaces mandan `{{ad.id}}` / `{{adset.id}}` donde se esperaba el nombre:
en Eduversio es el 18 % de los leads ([doc 21](./21-auditoria-utms-ghl.md)).

**Un nombre repetido no se adivina.** El mismo creativo se duplica entre campañas
(en Eduversio 83 de 91 nombres de anuncio). Si un lead solo trae ese nombre, se
queda sin cruzar como «ambiguo» y aparece en `/cruce-campanas` →
«Nombres repetidos en varias campañas», en vez de caer en una campaña cualquiera.
La cura es poner los IDs en el enlace ([doc 22](./22-auditoria-cruce-por-id.md)).
Desde el 2026-09-28 vale también para el **nombre de campaña**: dos campañas que se
llaman igual (una duplicada sin renombrar) ya no cruzan con la última escrita; el
anuncio o el conjunto del lead pueden desempatar.

**El nombre solo cruza dentro de su plataforma** (2026-09-28). `utm_source` dice la
plataforma (`facebook_*`, `instagram_*`, `ig`, `fb`, `th`, `whatsapp_*` → Meta;
`tiktok`, `pangle` → TikTok): un lead de TikTok ya no cae en una campaña de Meta
que se llame igual. Una fuente conocida sin gasto en el reporting (Google, email…)
no cruza por nombre; una desconocida o una macro busca en todas, como antes. Los
IDs cruzan siempre, sea cual sea la fuente. Los anuncios y adgroups de TikTok se
indexan por ID, así que la plantilla `ad_id=__CID__` del doc 22 ya funciona.

**Una corrección manual no pisa un ID exacto.** Una corrección de campaña o de
conjunto se hace sobre un nombre; si el lead trae un `ad_id` que el índice conoce,
manda el ID. Solo una corrección de nivel anuncio manda también sobre él.

**Cuenta compartida entre clientes.** Si dos clientes usan la misma cuenta
publicitaria, el campo «Campañas de este cliente» de la ficha (`alcance_campanas`)
dice cuáles son suyas: recorta el índice del cruce y el gasto de todos los informes
BI. Sin él, cada cliente ve el gasto de la cuenta entera.

**Los días, en la zona del cliente.** Leads y ventas se cortan por día en la zona
de la cuenta de Meta del cliente (o la escrita en la ficha), que es la zona en la
que Meta corta el gasto. Ver `src/lib/zona-activa.ts` y la migración 095.

El conjunto y el anuncio se titulan con la misma lógica: corrección manual → ID
propio → ID en `utm_id` o en su propio campo → nombre. Un ID que la cuenta no
conoce se queda como su propia fila, marcada como no resuelta, y se corrige en
`/cruce-campanas` → «Conjunto y anuncio».

### Leads que no cuentan

Cada cliente puede tener una regla «Qué leads cuentan» (ficha del cliente): exigir
atribución publicitaria, excluir fuentes o formularios. Los leads que la regla deja
fuera **se guardan igual** con `excluido = true` y su motivo, pero no suman en
`leads_count`, en el CPL, en las respuestas ni en el % de cruce. Se ven y se pueden
re-incluir en `/leads` → pestaña «Excluidos». La regla vive en
`src/lib/report-utm/lead-exclusion.ts` y la aplican las tres vías de ingesta.
Requiere la migración 079.

Esa pestaña desglosa **por qué** no cuenta cada lead (sin atribución / fuente
excluida / formulario excluido / a mano) y deja filtrar por motivo. No es lo
mismo que sobren 1.500 leads porque la regla filtra un formulario que porque
lleguen sin atribución: son dos problemas con dos arreglos distintos.

### Buscar un lead concreto

`/leads?q=` busca a la vez en nombre, email y teléfono, y se combina con el resto
de filtros y con el CSV. Tres cosas que conviene saber:

- **Mínimo 3 caracteres.** Con menos, `pg_trgm` no puede usar el índice y la
  consulta pasaría a recorrer la tabla entera; la UI lo avisa en vez de callarse.
- **No pliega tildes.** «Jose» no encuentra «José». `unaccent` no está instalado y
  añadirlo costaría otros tres índices.
- **Los teléfonos se normalizan.** El 31 % de los guardados empiezan por `+57`, así
  que un término que parece un teléfono se busca también en solo dígitos.

Los filtros —los de la página y los del CSV— salen de un único módulo,
`src/lib/report-utm/leads-filtros.ts`. Estaban duplicados y habían divergido: el
CSV recortaba el rango en UTC y la página en día Colombia, así que el total de la
pantalla y las filas del CSV no cuadraban. Requiere la migración 086 para que la
búsqueda use índice (funciona sin ella, pero con un seq scan de 171 MB).

Un lead que no cruza **no se funde en un cubo común**: se queda como su propia
fila con gasto 0 y la UI la marca. Es deliberado — fundirlas escondía justo el
problema que hay que arreglar. Por lo mismo, el gasto sin entidad (objetos de
TikTok antiguos) sale como «(gasto sin campaña)», no en la fila «(sin campaña)»
de los leads sin UTM.

### El eje `utm`

Las UTM crudas —`Source`, `Medium`, `UTM ID` y `Campaña UTM (crudo)`— son un eje
propio, `utm`, desde el 2026-09-25: las tienen leads, ventas de `sales_events` y
ventas de Hotmart. El resto de columnas de lead (país IP, formulario, campos de
formulario) sigue en `lead_column`, que solo tienen los leads. Con un único eje,
abrir el cruce por source a Hotmart habría abierto también el cruce por formulario.

### Ventas de Hotmart por campaña (`hm_*`)

La fuente `hotmart` lee `public.hotmart_ventas` (una fila por transacción) y resuelve
cada venta a su campaña con el **mismo resolver que los leads**, a partir de su tupla
UTM: la que trajo Hotmart o la heredada del lead del mismo comprador (ver
[doc 08](./08-integraciones.md#atribución-de-dónde-sale-la-campaña-de-una-venta)). En el
BI sus tokens son `hotmart.*`; en fórmulas y en el dashboard, los alias planos `hm_*`.
La definición de cada medida es **una sola**, `src/lib/hotmart/metricas.ts`, y la usan
por igual el motor del BI y las pestañas.

| Métrica                                 | Qué es                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `hm_ventas`                             | Transacciones cobradas: el bump y el upsell de un comprador cuentan aparte                             |
| `hm_compras`                            | **Pedidos** cobrados: ni bump, upsell, downsell o suscripción, ni order bump, ni con transacción padre |
| `hm_bumps`                              | Order bumps cobrados                                                                                   |
| `hm_neto` · `hm_bruto`                  | Facturación en la moneda de reporte (`hm_neto_usd` · `hm_bruto_usd`, en dólares)                       |
| `hm_reembolsos` · `hm_neto_reembolsado` | Devoluciones y chargebacks, imputados a la fecha de la **venta**                                       |
| `hm_roas` · `hm_cpa`                    | Neto ÷ gasto · gasto ÷ ventas                                                                          |
| `hm_cpa_compra` · `hm_ticket_compra`    | Gasto ÷ compras · neto ÷ compras: lo que cuesta y lo que deja cada comprador                           |
| `hm_ticket_medio`                       | Neto ÷ ventas                                                                                          |
| `hm_tasa_reembolso`                     | Reembolsado ÷ (neto + reembolsado): sobre lo facturado **antes** de devolver                           |
| `hm_tasa_bump`                          | Bumps ÷ compras                                                                                        |
| `hm_conversion`                         | Compras ÷ leads del mismo período (no sigue a cada lead hasta su compra). Solo en el BI                |

**Compras frente a ventas.** En Cris tributario (julio–agosto de 2026) hubo 88 ventas
= 53 principales + 34 bumps + 1 upsell. El gasto entre 88 da un CPA ~40 % más bajo
que lo que cuesta de verdad conseguir un comprador: para eso está `hm_cpa_compra`.
`hm_compras` se define por exclusión, no como `tipo = 'principal'`, para no caer a 0
en un cliente sin embudo configurado.

**En el BI** la fuente respeta los filtros planos, los avanzados y los de entidad
(campaña, conjunto, anuncio), y sirve de eje de tabla dinámica. Un filtro o una
dimensión que solo tienen los leads (país IP, formulario, campos de formulario) la
deja vacía: una venta no tiene esas columnas. Sus dimensiones propias: Tipo de venta,
Oferta, Producto, País y Método de pago (Hotmart).

**`sales.*` ya no incluye Hotmart.** El webhook espeja cada venta de Hotmart en
`sales_events`, y contarla también allí, en su moneda original, la sumaría dos veces.
`sales.*` excluye `platform = 'hotmart'`; esas ventas se miden solo con `hm_*`.

**En las pestañas del dashboard**, las `hm_*` las pone el cubo de ventas
(`src/lib/hotmart/cubo-db.ts` → `src/lib/dashboard/hotmart-cubo.ts`), que sigue el
filtro de campañas de la pestaña y, encima, el de cada tarjeta o columna. Es la
diferencia con `ventas_*`, `total_*` y `funnel_*`, que son de **cuenta**: en una
pestaña filtrada por campaña dividían toda la facturación del cliente entre un gasto
ya recortado. Sin filtro cuentan todas las ventas, también las `(sin campaña)`; con
filtro, solo las que cruzan con una campaña que pasa. En las tablas de ranking por
campaña (de Meta o de TikTok) cada campaña lleva sus `hm_*`; por anuncio o conjunto
no aplican. Las macros derivadas están en
[doc 09](./09-motor-de-formulas.md#macros-de-hotmart-auditoría-del-2026-09-25).

---

## Parte 3 · Armar un informe

Los informes viven en `/informes`. Un informe es un lienzo de widgets
sobre **un cliente y un rango de fechas**.

### Los pasos

1. **Nuevo informe** → elige cliente.
2. **Agregar widget** → elige el tipo.
3. En el editor: **fuente → campo** (el selector agrupa por fuente y atenúa lo
   que no cruza con la dimensión que ya elegiste).
4. Elige la **dimensión** (cómo se parten las filas).
5. Opcional: filtros, Top-N, orden, comparación con el período anterior.

### Tipos de widget

| Tipo            | Para qué                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| `scorecard`     | Un número. Admite comparar contra el período anterior y umbrales verde/ámbar |
| `line` · `area` | Evolución en el tiempo                                                       |
| `bar`           | Ranking por campaña, anuncio, país…                                          |
| `combo`         | Dos escalas — gasto en barras y CPL en línea                                 |
| `pie`           | Reparto de un total                                                          |
| `table`         | Varias métricas por fila, con formato condicional y fila de totales          |
| `funnel`        | Etapas del embudo                                                            |
| `slicer`        | Control para filtrar el informe entero                                       |
| `section`       | Agrupa widgets, colapsable                                                   |

### Dimensiones disponibles

| Dimensión                                | Agrupa por                                   |
| ---------------------------------------- | -------------------------------------------- |
| `Total`                                  | Todo junto: un solo valor                    |
| `Fecha`                                  | Día, semana, mes o trimestre                 |
| `Campaña` · `Conjunto` · `Anuncio`       | Entidad real de publicidad (ya resuelta)     |
| `Campaña UTM (crudo)`                    | El `utm_campaign` tal cual, **sin resolver** |
| `Plataforma` · `Source` · `Medium`       | Origen del tráfico                           |
| `País` · `Formulario` · `Atribución`     | Columnas de los leads                        |
| `Producto` · `Tipo de transacción`       | Columnas de las ventas                       |
| Campos de formulario, de lead y de Sheet | Los que definas por cliente                  |

> Un **segmento** de campo de lead (`lseg__…`) no aparece aquí a propósito: es una
> métrica, no una dimensión. Para partir las filas por la respuesta se usa el
> campo; para contar un subconjunto, el segmento.

> **`Campaña` vs `Campaña UTM (crudo)`** — la primera agrupa por el nombre real y
> trae el gasto. La segunda muestra el UTM literal y **no cruza con el gasto**.
> Úsala solo para diagnosticar etiquetado.

### Campos calculados

Un campo calculado es una expresión sobre las métricas del informe, reutilizable
en varios widgets:

```
spend / leads_count            → costo por lead
revenue / spend                → ROAS
sf__leads_calificados_2m / leads_count   → tasa de calificación
```

Si la fórmula es de un solo widget, escríbela directamente en su campo `Fórmula`.
Un denominador en 0 da `—`, nunca un número inventado.

---

## Parte 4 · Recetario

Preguntas reales y cómo se piden.

### «¿Cuánto me cuesta un lead en cada campaña?»

```
Widget:     bar
Métrica:    spend, leads_count  (o el campo calculado CPL)
Dimensión:  Campaña
Orden:      desc · Top 15
```

### «¿Cuánto me cuesta un lead CALIFICADO en cada anuncio?»

Esta es la que antes no se podía pedir.

```
Widget:     table
Métricas:   spend · <tu campo de Sheet «leads calificados»>
Dimensión:  Anuncio
Fórmula:    spend / sf__leads_calificados_2m
```

Funciona porque la exportación de Meta Lead Ads que alimenta el Sheet trae
`campaign_id`, `adset_id` y `ad_id` en cada fila. Cuando pides un eje de
publicidad, el motor lee las filas crudas en vez del resumen diario y recupera
esa identidad.

**Requisito**: que el Sheet sea una exportación de Meta Lead Ads (con esas
columnas). Un Sheet de CRM llenado a mano no las tiene y caerá en `(sin campaña)`.

### «¿Cuánto me cuesta un lead de más de 2M?»

La que antes obligaba a crear un campo de lead por umbral.

```
Widget:     scorecard
Fórmula:    spend / lseg__ingresos_desde_2m
Dimensión:  Total  (o Campaña, para verlo campaña a campaña)
```

El segmento se define una vez en la ficha del cliente (**Campos de lead → tu
pregunta → Acumulado desde…**) y a partir de ahí sale en la lista de métricas y
en la de fórmulas, en los informes y en el dashboard.

Aquí el gasto **no** se anula: un segmento es una medida, no un filtro, así que
numerador y denominador quedan recortados por el mismo ámbito. Ver
[doc 17](./17-campos-de-lead.md#filtrar-anula-el-gasto-medir-con-un-segmento-no).

### «¿Qué tipo de lead me trae cada campaña?»

```
Widget:     bar
Métrica:    leads_count
Dimensión:  Campaña
Dimensión2: <campo de formulario, ej. rango de ingresos>
```

La dimensión secundaria apila las barras. Solo el grano de fila puede ser eje de
un pivot, por eso funciona con leads y no con gasto.

### «¿Cómo evoluciona la inversión y el CPL?»

```
Widget:        combo
Métricas:      spend (barras) · cpl (línea)
Dimensión:     Fecha
Agrupación:    semana
```

### «¿De qué países vienen mis leads?»

```
Widget:     pie
Métrica:    leads_count
Dimensión:  País
```

No añadas gasto: no se reparte por país y ensuciaría el gráfico con una fila
total desproporcionada.

### «Embudo del mes»

```
Widget:   funnel
Métricas: impressions → clicks → leads_count → sales_count
```

### «Dejar que el cliente filtre por campaña»

```
Widget:      slicer
Modo:        multiselección
Dimensión:   Campaña
```

Afecta a todos los widgets del informe.

---

## Parte 5 · Qué NO se puede pedir

Merece la pena conocerlas para no perder tiempo:

| Petición                                                   | Por qué no                                         |
| ---------------------------------------------------------- | -------------------------------------------------- |
| Gasto **desglosado** por país / formulario / campo de lead | Anuncios no tiene esas columnas                    |
| Sesiones GA4 por **anuncio o conjunto**                    | GA4 por campaña no guarda `utm_content`/`utm_term` |
| Conversiones offline por campaña                           | Ídem — usa un **campo de Sheet**, que sí cruza     |
| Suscripciones en una serie temporal                        | Es una foto, no una serie                          |
| Contar filas de una fuente diaria                          | Solo el grano de fila se cuenta                    |
| CPA o ROAS de Hotmart **por producto**                     | Anuncios no sabe qué producto se vendió            |

> **Ojo con la primera fila.** Lo que no se puede es _repartir_ el gasto entre las
> respuestas. **Dividir** el gasto total del ámbito por un segmento de lead sí se
> puede, y es la receta de abajo: `spend / lseg__ingresos_desde_2m`. La diferencia
> es que un segmento es una MÉTRICA y no recorta la consulta, mientras que un
> filtro `leadfield:` sí — y por eso ese sigue dejando el gasto en 0.

---

## Parte 6 · Un widget sale vacío o en cero

En orden de probabilidad:

**1. La métrica no cruza con la dimensión.**
Lo más común. El selector atenúa los campos incompatibles; si ya lo guardaste, el
widget muestra el aviso. Solución: cambia la dimensión o quita esa métrica.

**2. El cliente no está enlazado.**
Sin `public_cliente_id`, seis de las ocho fuentes son invisibles y devuelven
cero **en silencio**. Se ve de un vistazo en `/admin/salud`. Se arregla en
`/admin/settings`.

**3. Los leads no cruzan con las campañas.**
Si casi todo cae en `(sin campaña)`, el problema es el etiquetado UTM. Ve a
`/cruce-campanas`: muestra qué UTMs no cruzan y propone
correcciones. También lo vigila el panel de salud.

**4. Un filtro no atribuible anula el gasto.**
Filtrar por país o por un campo de formulario deja el gasto en 0 a propósito: no
sería atribuible. El widget lo avisa.

**5. La fuente está parada.**
`/admin/salud` dice qué fuente lleva días sin datos y desde cuándo.

**6. Denominador en cero.**
CPL, CPA y ROAS devuelven `—`, no 0. Un guion significa «no se puede calcular»,
no «cero».

---

## Parte 7 · Estado actual de las fuentes

Conviene saberlo antes de prometerle un informe a un cliente:

- **Ventas Hotmart — con datos, pero casi sin campaña** (2026-09-25).
  `hotmart_ventas` tiene las ventas que trae la API (88 de Cris tributario en
  julio–agosto de 2026), así que facturación, ROAS y CPA **totales** funcionan. Pero
  hasta esa fecha ninguna tenía UTM: Hotmart no guarda las `utm_*` del checkout, el
  parser no leía el `src` que da la API (`tracking.source`) y el webhook no se llegó
  a configurar en ningún cliente. Por campaña, casi todo cae en `(sin campaña)`. Las
  vías: `sck={{ad.id}}` en el enlace del checkout (la recomendada: cruza por ID
  exacto), la tupla empaquetada en `src` (se despliega al guardar; lo ya guardado la
  recupera al volver a descargarse) y la herencia del lead del mismo email o
  teléfono, que exige la migración 089 (pendiente). Ver
  [doc 08](./08-integraciones.md#atribución-de-dónde-sale-la-campaña-de-una-venta).
- **Ventas (`sales_events`)** — las del CRM de GoHighLevel y el espejo del webhook de
  Hotmart, que `sales.*` no cuenta. Para los negocios que cierran fuera de una
  pasarela, la vía es el CRM del Sheet.
- **GA4** — configurado en 1 cliente (Cris). Hasta el 2026-09-28 con un ID de propiedad que la cuenta de la agencia no veía: nunca entregó datos ([doc 26](./26-auditoria-ga4.md)).
- **Conversiones offline** — 3 clientes, todo de tipo `lead` y sin importe.
- **Suscripciones** — 2 clientes.

`npm run diagnostico` imprime el estado real y, por cliente, de dónde debería
salir una venta.

---

## Parte 8 · Vigilancia

Un informe con una fuente muerta **no se ve roto: se ve vacío**. Por eso hay
herramientas dedicadas:

| Dónde                 | Qué dice                                                                      |
| --------------------- | ----------------------------------------------------------------------------- |
| `/admin/salud`        | Fuentes paradas, integraciones caídas, cruce degradado, Sheets mal conectados |
| `/cruce-campanas`     | Qué UTMs no cruzan y sugerencias de corrección                                |
| `npm run diagnostico` | Lo mismo por consola, más la ruta de ventas de cada cliente                   |

### Comprobaciones automáticas

```bash
npm test          # todo
npm run test:puro   # sin base de datos: reglas, registro, atribución
npm run test:datos  # contra datos reales: paridad de gasto, cruces, golden
```

Las que conviene conocer:

- **`verify-bi-golden`** — congela los números del motor para un rango fijo. Si
  cambia algo, avisa. Recapturar con `--capturar` **solo** cuando entiendas por
  qué cambió.
- **`verify-ads-daily-paridad`** — el gasto tiene que salir igual desde
  `ads_daily` y desde los JSONB. Si falla, casi siempre faltan días:
  `npx tsx scripts/backfill-ads-daily.ts`.
- **`verify-bi-sheet-por-campana`** — que agrupar un campo de Sheet por campaña
  conserve el total.
- **`verify-bi-registry`** — que el catálogo y el motor no se separen.
- **`verify-hotmart-*`** — parser, atribución, webhook, credenciales y cubo de las
  pestañas (en `test:puro`). La migración 089 se prueba aparte, sin dejar nada
  escrito: `npx tsx scripts/verify-hotmart-089.ts`.

---

## Apéndice · Tokens

Los campos por cliente viajan como tokens. Normalmente los escribe el editor,
pero aparecen en las fórmulas y en los informes guardados.

| Token                     | Qué es                                     | Alias en fórmulas |
| ------------------------- | ------------------------------------------ | ----------------- |
| `sheetagg:<agg>:<clave>`  | Campo de Sheet como métrica                | `sf__<clave>`     |
| `sheetview:<clave>`       | Vista guardada de un campo                 | `sv__<clave>`     |
| `sheetdim:<clave>`        | Campo de Sheet como dimensión              | —                 |
| `field:<clave>`           | Campo de formulario como dimensión         | —                 |
| `fieldagg:<agg>:<clave>`  | Campo de formulario como métrica           | —                 |
| `leadfield:<clave>`       | Campo de lead como dimensión               | —                 |
| `leadseg:<clave>`         | Segmento de un campo de lead, como métrica | `lseg__<clave>`   |
| `offfield:<tipo>:<clave>` | Columna de conversiones offline            | `off__<clave>`    |

`<agg>` es `count`, `sum`, `avg`, `min` o `max`. La agregación viaja **dentro**
del token para que un widget guardado siga midiendo lo mismo aunque después
cambies la agregación por defecto del campo.

Las métricas de Hotmart no son por cliente, pero también tienen dos nombres: el
token del BI `hotmart.<medida>` (`hotmart.compras`, `hotmart.cpa_compra`…) y el alias
plano `hm_<medida>` (`hm_compras`, `hm_cpa_compra`…), que es el que se escribe en
fórmulas y en el dashboard. La tabla completa está en la
[Parte 2](#ventas-de-hotmart-por-campaña-hm_). Las `hotmart_*` (`hotmart_revenue`,
`hotmart_roas`…) siguen apuntando a la fuente Cuenta a propósito: repuntarlas a
`hotmart_ventas` movería números de informes ya entregados.

---

## Apéndice · Notas técnicas

**De dónde sale el gasto.** El motor lee `public.ads_daily` (normalizada, una
fila por cliente × fecha × plataforma × nivel × entidad) a través de la función
`ads_daily_resumen`. Si la tabla no cubre el rango pedido —el nivel anuncio se
purga a los 30 días y el histórico arranca en enero de 2026— cae a los JSONB de
`metricas_diarias`. Los dos caminos dan el mismo número; `verify-ads-daily-paridad`
lo comprueba.

**Los niveles de Meta no suman entre sí.** La deduplicación de atribución hace
que la suma de los anuncios de una campaña supere la cifra de la campaña, y
`reach` cuenta personas únicas. Toda lectura de `ads_daily` fija el nivel; la RPC
lo exige y falla si no se le pasa.

**`BI_ADS_SOURCE=jsonb`** fuerza el camino antiguo. Sirve para comparar y como
salida de emergencia sin desplegar.

**Los dos caminos del Sheet.** Al agrupar por fecha, por un campo de Sheet o por
el total, el motor lee el desglose ya materializado (barato). Al pedir campaña,
conjunto o anuncio, lee las filas crudas para recuperar la identidad del anuncio.
El total es idéntico en los dos casos.
