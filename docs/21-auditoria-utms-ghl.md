# 21 · Auditoría de UTMs: qué arrastra GoHighLevel y qué toma el UTM Report

Respuesta a las tres revisiones que el PM pidió en la reunión del 2026-09-08:

1. ¿Qué UTMs arrastra GoHighLevel?
2. ¿Qué datos toma el UTM Report (AdsHouse)?
3. ¿El campo oculto del formulario de GHL toma las variables UTM del enlace?

Datos medidos el **2026-09-12** sobre `report_utm.lead_events`, últimos 90 días, con
la consulta del final (solo lectura).

---

## 1. Qué llega, por cliente y por vía de entrada

«Es ID» = el campo trae un número de 10+ dígitos (un ID de Meta) en vez de un nombre.

| Cliente         | Vía                  |  Leads |   Sin atribución | Campaña es ID | Anuncio: ID / nombre | Conjunto: ID / nombre |
| --------------- | -------------------- | -----: | ---------------: | ------------: | -------------------: | --------------------: |
| Cris Tributario | GoHighLevel          |  1.746 | **1.551 (89 %)** |            61 |             61 / 130 |              61 / 129 |
| Cris Tributario | Formulario web (S2S) |    669 |               25 |            11 |             11 / 629 |              11 / 629 |
| Eduversio       | Formulario web (S2S) | 64.767 |              313 |    **11.933** |  **11.933** / 50.002 |   **11.933** / 49.847 |
| Goodprop        | Meta Lead Ads        |  8.790 |                6 |             0 |            0 / 8.784 |             0 / 8.784 |
| Inspira         | GoHighLevel          |     53 |               14 |             0 |               0 / 39 |                0 / 39 |
| Inspira         | Formulario web (S2S) |    134 |               16 |             0 |              0 / 116 |               0 / 105 |
| Invest Brokers  | Meta Lead Ads        |    619 |                2 |             0 |              0 / 617 |               0 / 617 |
| Somos Rentable  | Formulario web (S2S) |  8.710 |               45 |             9 |          333 / 8.278 |           333 / 8.278 |
| Sur Profundo    | Formulario web (S2S) |  8.178 |              100 |             1 |            1 / 6.810 |             1 / 6.791 |

### Lo que dicen los números

- **El problema de Cris no es el cruce: es lo que entra.** El 89 % de los contactos
  que manda GHL no trae NINGUNA señal publicitaria. Son los que escribieron por
  WhatsApp, por el perfil de Instagram, o que el CRM creó por otra vía. Es lo que
  hundía el CPL. La regla «Qué leads cuentan» de la ficha del cliente los deja
  fuera sin borrarlos (ver [doc 18](./18-fuentes-y-cruces.md)).
- **Los IDs en los campos de nombre son reales y frecuentes.** Eduversio manda el ID
  de campaña, anuncio y conjunto en el 18 % de sus leads; Somos Rentable, el del
  anuncio y el conjunto en 333. Hasta el 2026-09-12 esos leads salían en el informe
  con el número en vez del nombre. Ahora el resolver los traduce solo.
- **Meta Lead Ads siempre llega bien.** Goodprop e Invest Brokers traen el ID en
  `utm_id` y el nombre en contenido/conjunto: cruce del 100 %.

---

## 2. Qué toma el UTM Report y en qué orden

Para cada lead, la campaña se busca en cascada. La primera regla que acierta gana:

| #   | Regla                      | Qué compara                                                                 |
| --- | -------------------------- | --------------------------------------------------------------------------- |
| 1   | Corrección manual          | `utm_campaign_map` (Cruce de campañas), a nivel campaña, conjunto o anuncio |
| 2   | ID de campaña              | `utm_id` = `campaign_id`                                                    |
| 3   | ID de anuncio              | `utm_id` = `ad_id` → su campaña                                             |
| 3b  | ID en el campo de campaña  | `utm_campaign` = `campaign_id`                                              |
| 3c  | ID en el campo de anuncio  | `utm_content` = `ad_id` → su campaña                                        |
| 3d  | ID en el campo de conjunto | `utm_term` = `adset_id` → su campaña                                        |
| 4   | Nombre de campaña          | `utm_campaign` ≈ nombre (sin mayúsculas ni acentos)                         |
| 5   | Nombre de anuncio          | `utm_content` ≈ nombre del anuncio                                          |
| 6   | Nombre de conjunto         | `utm_term` ≈ nombre del conjunto                                            |

Los pasos 3b–3d son los nuevos. El conjunto y el anuncio se titulan con el mismo
criterio: primero la corrección manual, luego el ID (venga en `utm_id` o en su
propio campo), luego el nombre.

> **Actualización 2026-09-14.** La cascada ganó IDs propios del lead (campaña,
> conjunto y anuncio, migración 082), `utm_id` = ID de conjunto, y dejó de adivinar
> con nombres repetidos entre campañas. Detalle y cifras en
> [doc 22](./22-auditoria-cruce-por-id.md).

Para GoHighLevel en concreto, `ghl-leads.ts` construye los UTM así:

- Si el contacto trae UTMs reales (formulario con querystring) → tal cual.
- Si trae `adId` en su atribución (Click-to-WhatsApp) → `utm_id` = campaña o anuncio,
  cruce exacto aunque GHL lo etiquete como «Social media».
- Si solo trae canal (`medium`, `sessionSource`) → orgánico, sin `utm_id`.
- El `mediumId` de GHL (id de la página/cuenta de Instagram) NUNCA se usa: no es una
  campaña.

---

## 3. El campo oculto del formulario de GHL

**No se puede resolver desde el código.** Es configuración en GHL: el formulario
tiene que tener campos ocultos que lean los parámetros de la URL (`{{utm_source}}`,
`{{utm_campaign}}`, `{{utm_content}}`, `{{utm_term}}`, `{{utm_id}}`). Si el
formulario vive dentro de WordPress, el iframe tiene que recibir esos parámetros de
la página que lo contiene.

Cómo comprobarlo en 5 minutos:

1. Abrir la landing con UTMs de prueba:
   `…?utm_source=prueba&utm_campaign=prueba_campo_oculto&utm_id=123`.
2. Enviar el formulario.
3. En GHL → el contacto → Atribución: si aparecen `utm_campaign = prueba_campo_oculto`
   y `utm_id = 123`, los campos ocultos funcionan.
4. En `/report-utm/leads` debe aparecer con esa campaña en menos de un minuto.

Mientras no funcione, el sistema sigue cubriendo el caso: los leads con anuncio
cruzan por `utm_id`, y los que no traen nada se excluyen con la regla del cliente.
Con los campos ocultos bien puestos, el 89 % sin atribución de Cris debería bajar a
los contactos realmente orgánicos.

---

## La consulta

```sql
select c.nombre, e.source, count(*) leads,
       count(*) filter (where e.utm_campaign ~ '^[0-9]{10,}$') campana_es_id,
       count(*) filter (where e.utm_content  ~ '^[0-9]{10,}$') anuncio_es_id,
       count(*) filter (where e.utm_term     ~ '^[0-9]{10,}$') conjunto_es_id,
       count(*) filter (where coalesce(e.utm_id, e.utm_campaign, e.utm_content,
                                       e.utm_term, e.click_id) is null) sin_atribucion
from report_utm.lead_events e
join report_utm.clientes c on c.id = e.cliente_id
where e.created_at >= now() - interval '90 days'
group by 1, 2 order by 1, 2;
```

`npx tsx scripts/sql-remoto.ts --query="…"` la ejecuta contra producción.
