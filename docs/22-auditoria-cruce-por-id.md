# 22 · Auditoría del cruce de campañas y cruce por ID de conjunto y anuncio

Auditoría pedida el 2026-09-14: ¿cómo cruzan los leads con el gasto, y se puede hacer
también con el ID del conjunto y del anuncio?

Respuesta corta: el cruce ya era por ID a nivel de campaña para la gran mayoría de
los leads. Los fallos estaban en el **cruce por nombre**, y en que **se tiraban IDs que
ya llegaban**. Ahora el lead guarda sus tres IDs (campaña, conjunto y anuncio), el
resolver los usa primero y deja de adivinar con nombres repetidos.

---

## 1. Lo que se encontró (antes del cambio)

Leads de los últimos 30 días, clasificados por la regla del cruce que les aplica.
Medido con SQL de solo lectura contra producción (la consulta aproxima la
normalización de `normLabel`).

| Cliente                        | Por ID de campaña | Por nombre de campaña | Nombre de anuncio **ambiguo** | Sin cruce |
| ------------------------------ | ----------------: | --------------------: | ----------------------------: | --------: |
| Eduversio (S2S)                |            24.639 |                   253 |                       **651** |     1.627 |
| Somos Rentable (S2S)           |             2.439 |                     – |                             – |        63 |
| Sur Profundo (S2S, con TikTok) |      813 + TikTok |                   130 |                             2 |       ~41 |
| Invest Brokers (Meta Lead Ads) |               238 |                     – |                             – |         2 |
| Cris Tributario (GHL)          |                61 |                    75 |                             4 |    1.502¹ |

¹ Sin ninguna señal publicitaria: el problema conocido de Cris ([doc 21](./21-auditoria-utms-ghl.md)).
Se resuelve con la regla «Qué leads cuentan», no con el cruce.

### Hallazgos

1. **Nombres repetidos entre campañas.** El mismo creativo se duplica en varias
   campañas:
   - Eduversio: 83 de 91 nombres de anuncio con gasto y 54 de 80 de conjunto;
   - Somos Rentable y Sur Profundo: 40 de 161 anuncios;
   - Cris: 29 de 45.

   El índice guardaba un nombre → **una** campaña, la última que leía. Los 651 leads
   de Eduversio que solo cruzaban por el nombre del anuncio caían en una campaña al azar.

2. **Campañas renombradas.** El índice solo registraba el primer nombre de cada ID.
   Un lead guarda el nombre del día en que entró, así que tras un renombrado no
   cruzaba. Es el caso de Eduversio: el lead trae `V5[D][2|08]…` y la campaña se llama
   hoy `V5[D][2|09]…`.

   Además, la RPC del gasto (`ads_daily_resumen`) agrupaba por nombre, así que la
   campaña salía **partida en dos filas**. En 90 días: Sur Profundo 7 campañas,
   Somos 5, Expo Renta Corta 4, Cris 1.

3. **UTMs URL-encoded.** 73 leads de Eduversio traían `%5BV1%5D%5B13%7C08%5D…`, que es
   exactamente `[V1][13|08]…`. La normalización no lo decodificaba.
4. **IDs que se tiraban:**
   - Meta Lead Ads recibe `ad_id` y `adset_id` con cada lead y solo guardaba el de
     campaña.
   - GoHighLevel dejaba `adId` / `adGroupId` dentro de `custom_data`.
   - El píxel no capturaba ni `utm_id`.
   - `sales_events.ad_id / ad_set_id / ad_campaign_id` existían desde la migración
     012 y nadie las escribía.
5. **`utm_id` con el ID de un conjunto** titulaba el conjunto, pero no ataba el lead a
   su campaña.

Lo que **no** era un problema:

- Los 1.157 leads «sin cruce» de Sur Profundo que salían en la consulta SQL son de
  TikTok. Traen el ID de campaña de TikTok y el resolver sí los cruza; la consulta
  solo miraba Meta.
- Los 55 leads de Invest Brokers «sin anuncio» eran la `Ń` de ÑUÑOA, que la consulta
  no normalizaba y `normLabel` sí.

---

## 2. Qué cambió

### La cascada (src/lib/report-utm/campaign-resolver.ts)

La primera regla que acierta gana:

| #   | Regla                                    | Qué compara                                                           |
| --- | ---------------------------------------- | --------------------------------------------------------------------- |
| 1   | Corrección manual                        | `utm_campaign_map`, a nivel campaña, conjunto o anuncio               |
| 2   | **ID propio del lead**                   | `ad_id` → `adset_id` → `campaign_id` (migración 082)                  |
| 3   | ID de campaña en `utm_id`                | `utm_id` = `campaign_id`                                              |
| 4   | ID de anuncio o **conjunto** en `utm_id` | → su campaña                                                          |
| 5   | ID en el campo del nombre                | `utm_campaign` / `utm_content` / `utm_term` = ID                      |
| 6   | Nombre de campaña                        | cualquier nombre que haya tenido; también URL-encoded                 |
| 7   | Nombre de anuncio / conjunto             | **solo si lleva a UNA campaña**, solo o cruzando anuncio con conjunto |

Un nombre que existe en varias campañas y que el otro campo no desambigua queda
como **`ambiguous`**: no cruza, y aparece en `/report-utm/cruce-campanas` → «Nombres
repetidos en varias campañas», con las campañas candidatas. Se decidió así a propósito:
baja el % de cruce visible, pero deja de inventarlo.

El conjunto y el anuncio se titulan igual: corrección manual → ID propio → ID en
`utm_id` o en su campo → nombre.

### Los IDs llegan al lead

| Fuente          | De dónde salen                                                                            |
| --------------- | ----------------------------------------------------------------------------------------- |
| Meta Lead Ads   | `campaign_id`, `adset_id`, `ad_id` del propio lead (`meta-leads.ts`)                      |
| GoHighLevel     | `campaignId`, `adGroupId`, `adId` de la atribución (`idsDeContacto`); también en la venta |
| Formularios S2S | parámetros `campaign_id`, `adset_id`, `ad_id` del cuerpo o de la URL de la landing        |
| Píxel           | los guarda en la cookie de touch y los propaga al checkout                                |
| Google Sheets   | columnas `campaign_id` / `adset_id` / `ad_id` (ya existía; ahora por separado)            |

Solo se guarda un valor que sea un ID de verdad (10+ dígitos). Una macro sin
rellenar (`{{ad.id}}`, `__CID__`) se descarta.

### Plantilla de parámetros de URL

Para que el cruce baje a conjunto y anuncio por ID, los enlaces deben llevar:

- **Meta**: `utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&utm_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`
- **TikTok**: `utm_campaign=__CAMPAIGN_NAME__&utm_id=__CAMPAIGN_ID__&adset_id=__AID__&ad_id=__CID__`

Los nombres siguen haciendo falta para leer el informe; los IDs son los que cruzan.

---

## 3. Pasos operativos

1. **Aplicar la migración 082** (la aplica una persona):
   `npx tsx scripts/sql-remoto.ts migrations/082_ids_publicitarios_en_leads.sql`
   - Añade `lead_events.campaign_id / adset_id / ad_id`.
   - Redefine `ads_daily_resumen`: cada fila se titula con el nombre más reciente de
     su ID, lo que funde las campañas renombradas. Los totales no cambian.
   - Hasta aplicarla, el código funciona como antes: sondea las columnas
     (`lead-ids.ts`) y no las pide ni las escribe.
2. **Rellenar el histórico**:
   - en seco: `npx tsx --conditions=react-server scripts/backfill-ids-leads.ts`;
   - luego escribirlo con `--aplicar`.

   GHL sale de `custom_data`. Meta Lead Ads busca campaña + conjunto + anuncio en el
   gasto y solo escribe si hay un anuncio único. S2S lee la URL de la landing. Nunca
   pisa un ID existente.

3. **Poner la plantilla de URL** en los anuncios activos.
4. **Medir**: `npx tsx --conditions=react-server scripts/auditoria-cruce.ts`. Usa el
   resolver real; da el % por ID, por nombre, ambiguos y sin cruzar, y la cobertura de
   IDs por cliente.

---

## 4. Cifras con el resolver nuevo

`scripts/auditoria-cruce.ts`, del 2026-08-15 al 2026-09-13, sobre los leads que
cuentan. La migración 082 aún no está aplicada, así que «por ID» es el ID que llega
en los UTM, todavía no los IDs propios del lead.

| Cliente         |  Leads | Por ID | Por nombre | Manual | Ambiguos | Sin cruzar | Gasto con leads |
| --------------- | -----: | -----: | ---------: | -----: | -------: | ---------: | --------------: |
| Eduversio       | 27.318 |   90 % |        1 % |    0 % |      2 % |        6 % |            99 % |
| Somos Rentable  |  2.552 |   97 % |        0 % |    0 % |      0 % |        3 % |           30 %² |
| Sur Profundo    |  2.100 |   97 % |        1 % |    0 % |      0 % |        2 % |           39 %² |
| Invest Brokers  |    243 |   99 % |        0 % |    0 % |      0 % |        1 % |            89 % |
| Cris Tributario |  1.625 |    0 % |        5 % |    4 % |      0 % |      91 %³ |            90 % |

² Somos Rentable y Sur Profundo comparten la cuenta de Meta a propósito: el gasto de
una cuenta se reparte entre las dos.
³ 1.480 de esos leads solo traen el canal (contactos orgánicos de GHL). Con la 079 ya
aplicada, la regla «Qué leads cuentan» de la ficha de Cris los puede dejar fuera.

**Lo que no cruza, en Eduversio (6 %):**

- 1.506 leads llegan sin ningún UTM;
- 108 traen macros sin rellenar (`{{campaign.name}}`);
- solo 7 traen un valor que no existe.

Los URL-encoded y las campañas renombradas ya no aparecen: cruzan.

**Ambiguos (2 % de Eduversio).** Los tres nombres de anuncio que más se repiten
reúnen 552 leads que antes caían en una campaña al azar:

| Nombre de anuncio  | Leads | Campañas donde existe |
| ------------------ | ----: | --------------------: |
| AD 1 TANDA 1 SEPT  |   269 |                     7 |
| IMAGEN 1 - IA 100% |   209 |                     5 |
| IMAGEN 5           |    74 |                    15 |

Se resuelven poniendo `ad_id={{ad.id}}` en esos enlaces.

**Relleno del histórico (en seco, 2026-09-14).**

| Fuente             | Resultado                                                                              |
| ------------------ | -------------------------------------------------------------------------------------- |
| Meta Lead Ads      | Invest Brokers: 671 de 675 leads con anuncio único; 2 cuyo anuncio no está en el gasto |
| GHL                | Cris: 2 de 1.799                                                                       |
| S2S (66 mil leads) | Ninguno trae todavía los IDs en la URL de la landing                                   |

Por eso el paso 3 (la plantilla de URL) es el que más mueve la aguja.
