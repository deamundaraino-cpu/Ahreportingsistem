# 20 · Integración GoHighLevel (leads del CRM en el UTM report)

Guía paso a paso para dar de alta un cliente que trabaja su captación en
GoHighLevel, sin tocar código. Al terminar, sus contactos aparecen como leads en
el UTM report, con CPL, campos de formulario y cruce contra el gasto de campañas.

**Tiempo estimado:** 15 minutos por cliente.
**Quién puede hacerlo:** cualquier rol con permiso de escritura en Report-UTM
(admin, superadmin o trafficker con escritura).

---

## Qué hace exactamente

Cada contacto creado en la location de GHL entra en la tabla de leads de siempre
(`report_utm.lead_events`), la misma que ya alimentan el formulario web y Meta
Lead Ads. No hay un informe aparte ni una métrica nueva: el lead de GHL suma en
`leads.count`, en `utm_leads` del dashboard y en el CPL como cualquier otro.

Se mapea:

| Del contacto de GHL | Al UTM report |
|---|---|
| Nombre, email, teléfono | Datos de contacto del lead |
| País | Dimensión *País* |
| Fecha de creación | El día del lead (en hora Colombia) |
| Anuncio de origen | `utm_id` → **cruce exacto con el gasto de la campaña** |
| Campos personalizados | Respuestas del formulario → campos de lead y segmentos |
| Etiquetas, oportunidades, atribución cruda | Se guardan para auditoría |

Hay **dos vías** funcionando a la vez, y no se pisan:

- **Webhook** — el lead entra en segundos, en cuanto se crea el contacto.
- **Sincronización periódica** — trae los últimos 90 días la primera vez y
  después repasa por si algún webhook se perdió. Un contacto nunca entra dos
  veces.

---

## Antes de empezar: dos decisiones

### 1. GoHighLevel será la fuente única de leads de ese cliente

Al guardar la integración se **pausan** automáticamente las otras vías de lead
del cliente (el formulario de WordPress y Meta Lead Ads).

No es un capricho: la tabla de leads no descarta duplicados por email ni por
teléfono. Si dejáramos dos vías activas, la misma persona entraría dos veces —
una por el formulario y otra por el CRM— y el conteo de leads quedaría inflado
sin que nada lo avisara. Es preferible perder la atribución de píxel del
formulario web (que en estos clientes ya la resuelve el propio CRM) antes que
tener una métrica que miente.

La tarjeta te pide confirmar esto antes de guardar.

### 2. Qué contacto cuenta como lead

Por defecto cuenta **todo contacto nuevo**. En una location con chatbot eso puede
ser un problema: si el bot crea contactos que no son captación, entran como leads
y el CPL se hunde.

Para eso está el filtro por etiquetas, que podés dejar vacío y ajustar después:

- **Solo etiquetas** — solo entran los contactos que traen al menos una de esas
  etiquetas.
- **Excluir etiquetas** — quedan fuera los contactos que traigan cualquiera de
  esas etiquetas.

Si dudás, empezá sin filtro, mirá los primeros días y ajustá. Cambiar el filtro
no borra lo ya importado.

---

## Paso 1 · Sacar el Location ID y el token en GoHighLevel

1. Entrá a la **sub-cuenta (location)** del cliente en GHL.
2. **Settings → Business Profile**: copiá el **Location ID** (una cadena tipo
   `sWSeAhElmT7anfpZSqXS`). También aparece en la URL cuando estás dentro de la
   location.
3. **Settings → Private Integrations → Create new integration**.
4. Ponele un nombre reconocible (por ejemplo *UTM Report*) y marcá estos scopes:

   | Scope | Para qué |
   |---|---|
   | `contacts.readonly` | Leer los contactos y su atribución |
   | `locations/customFields.readonly` | Traducir los campos personalizados a sus nombres |
   | `opportunities.readonly` | Guardar las oportunidades del contacto (opcional pero recomendado) |

5. Creá la integración y **copiá el token**. GHL lo muestra **una sola vez**: si
   lo perdés hay que generar otro.

> El token da acceso de lectura a los contactos del cliente. Se guarda cifrado y
> no se vuelve a mostrar en la aplicación. Si sospechás que se filtró, revocá la
> Private Integration en GHL y creá una nueva.

---

## Paso 2 · Configurar la integración en el UTM report

1. Entrá a **Report-UTM → Clientes → (el cliente)**.
2. Bajá hasta la tarjeta **GoHighLevel · CRM**.
3. Completá:
   - **Location ID** — el del paso 1.
   - **Private Integration Token** — el del paso 1.
   - **Solo etiquetas / Excluir etiquetas** — opcional (ver la decisión 2).
4. Marcá la casilla de confirmación de fuente única.
5. **Guardar y probar conexión**.

Si el token o el Location ID están mal, el error de GHL se muestra tal cual y no
se guarda nada. Si va bien, verás cuántos contactos tiene la location: ese es el
tamaño del histórico y te dice qué esperar del backfill.

Guardá también el **secreto del webhook** que aparece justo después: se muestra
una sola vez y lo necesitás en el paso 3.

---

## Paso 3 · Montar el Workflow en GoHighLevel

Esto es lo que hace que los leads lleguen en tiempo real.

1. En GHL: **Automation → Workflows → Create Workflow → Start from scratch**.
2. **Trigger:** *Contact Created*.
3. **Acción:** *Webhook*.
   - **Method:** `POST`
   - **URL:** la que muestra la tarjeta, con forma
     `https://reportes.adshouse.cloud/api/report-utm/webhooks/ghl/{id-del-cliente}`
     (usá el botón de copiar, lleva el id correcto).
   - **Headers → Add header:**
     - Key: `X-Rutm-Ghl-Token`
     - Value: el secreto del paso 2.
4. **Publicá** el workflow (arriba a la derecha, *Publish*). Un workflow en
   borrador no dispara nada.

No hace falta configurar el cuerpo del webhook: con que incluya el
`contact_id` alcanza. El sistema vuelve a pedirle a GHL el contacto completo con
el token, así que la atribución y los campos personalizados llegan siempre
completos aunque el payload del workflow sea mínimo.

---

## Paso 4 · Traer el histórico

En la tarjeta, **Sincronizar ahora**. Trae los últimos 90 días.

Si la location tiene muchos contactos, una pasada no alcanza: la sincronización
se corta sola por tiempo, guarda por dónde iba y sigue en la corrida siguiente
(la automática es a las 05:00 y 14:00, hora Colombia). Podés apretar
*Sincronizar ahora* varias veces para acelerarlo.

El mensaje te dice cuántos leads nuevos entraron, cuántos contactos se revisaron
y cuántos descartó el filtro.

---

## Paso 5 · Comprobar que funciona

En este orden:

1. **La tarjeta** — estado *Activa*, sin error, "Leads última sync" con un número
   y "Campos personalizados" mayor que cero.
2. **Prueba de punta a punta** — creá un contacto de prueba en GHL y verificá que
   aparece en **Report-UTM → Leads** en menos de un minuto. Borralo después.
3. **Campos de lead** — en la ficha del cliente, tarjeta *Campos de lead* →
   *Detectar*. Los campos personalizados de GHL deben aparecer como preguntas
   disponibles. Si el cliente ya tenía campos configurados desde el formulario
   web o Meta, agregá la clave de GHL a las *claves de origen* del campo que ya
   existe en vez de crear uno nuevo: así el informe sigue teniendo una sola
   pregunta.
4. **Cruce con el gasto** — en **Report-UTM → Cruce de campañas**, los leads de
   GHL deben aparecer asociados a sus campañas. Lo que quede en *(sin campaña)*
   debería ser tráfico orgánico.
5. **Salud** — en **Report-UTM → Salud**, mirá el porcentaje de leads cruzados.
   Si cae mucho después del backfill, está entrando demasiado tráfico orgánico
   como lead: volvé al filtro por etiquetas.
6. **El informe** — armá un widget con *Gasto*, *Leads* y *CPL* agrupado por
   campaña y comparalo con lo que el cliente reporta a mano.

---

## Cómo se cruzan los leads con el gasto

Merece entenderlo porque explica el 90% de las dudas.

- Un contacto que llegó **por un anuncio** (típicamente Click-to-WhatsApp) trae
  el id del anuncio en su atribución. Ese id se usa para encontrar la campaña, y
  el cruce es **exacto**: no depende de que los nombres coincidan.
- Un contacto **orgánico** (llegó por el perfil de Instagram, por un mensaje
  directo, por recomendación) no tiene anuncio, así que queda en *(sin campaña)*
  con gasto 0. **Esto es correcto**, no es un fallo: ese lead no costó pauta y
  meterlo en una campaña inventada falsearía el CPL de esa campaña.
- Un contacto que llegó por una **landing con UTMs** conserva sus UTMs tal cual.

Por eso, si ves muchos leads en *(sin campaña)*, la pregunta no es "por qué no
cruza" sino "¿cuánto de mi captación es orgánica?".

---

## Mantenimiento

| Situación | Qué hacer |
|---|---|
| Perdiste el secreto del webhook | *Rotar secreto* en la tarjeta y actualizar el header en el Workflow de GHL. Hasta que lo actualices, el webhook deja de entrar (la sincronización periódica sigue cubriendo). |
| El token de GHL fue revocado o caducó | Crear otro en GHL y usar *Actualizar credenciales*. |
| Cambió qué cuenta como lead | Ajustar las etiquetas y *Guardar filtro*. Aplica desde la siguiente sincronización; no borra lo ya importado. |
| Se creó un campo personalizado nuevo en GHL | No hay que hacer nada: se detecta solo. Para que sea una dimensión del informe, configuralo en *Campos de lead*. |
| Hay que parar la ingesta | *Pausar* en la tarjeta. Los leads ya importados se quedan. |
| Se quiere volver al formulario web | Pausar GoHighLevel y reactivar la integración S2S / Meta Lead Ads del cliente. |

---

## Errores frecuentes

| Mensaje o síntoma | Causa y solución |
|---|---|
| `GHL POST /contacts/search: ...401...` al guardar | El token está mal copiado o fue revocado. Generá una Private Integration nueva. |
| `GHL ...: The token does not have access to this location` | El token es de otra location. Verificá que lo creaste dentro de la sub-cuenta del cliente. |
| La conexión funciona pero **Campos personalizados: 0** | Al token le falta el scope `locations/customFields.readonly`. Recreá la integración con ese scope marcado. |
| El webhook no trae nada | Tres causas, en este orden: el Workflow está en borrador (falta *Publish*); el header `X-Rutm-Ghl-Token` está mal escrito o con el secreto viejo; la URL no es la de este cliente. Mientras tanto la sincronización periódica sigue trayendo los leads con retraso. |
| Entran muchísimos más leads de los esperados | Están entrando contactos que no son captación (chatbot, importaciones, contactos manuales). Usá *Excluir etiquetas*. |
| Un lead aparece dos veces | Comprobá que la integración S2S o Meta Lead Ads del cliente quedó efectivamente en pausa. El mismo contacto de GHL nunca se duplica: está protegido por su id. |
| Todos los leads caen en *(sin campaña)* | Si el cliente hace Click-to-WhatsApp, revisá en GHL que los contactos traigan atribución (*Contact → Attribution*). Si no la traen, el problema está en cómo se configuró la campaña en Meta, no aquí. |
| La tarjeta dice "Sincronización parcial por límite de tiempo" | Es normal en el backfill de una location grande. Continúa sola en la siguiente corrida. |

---

## Detalle técnico

Para quien tenga que tocar el código.

| Pieza | Archivo |
|---|---|
| Diseño y decisiones | `migrations/074_report_utm_ghl_leads.sql` |
| Cliente HTTP de la API de GHL | `src/lib/report-utm/ghl-client.ts` |
| Mapeo, filtro, dedup y sincronización | `src/lib/report-utm/ghl-leads.ts` |
| Webhook por cliente | `src/app/api/report-utm/webhooks/ghl/[clienteId]/route.ts` |
| Polling / backfill | `src/app/api/cron/sync-ghl-leads/route.ts` |
| Alta desde la UI | `src/components/report-utm/GhlLeadsCard.tsx` + `_actions.ts` de la ficha del cliente |
| Comprobaciones del mapeo | `npx tsx scripts/verify-ghl-leads.ts` |

Notas que evitan sustos:

- El contacto se guarda con `source = 'gohighlevel'` y
  `external_id = 'ghl:<contactId>'`. El prefijo es lo que impide que choque con
  los `leadgen_id` de Meta en el índice único `(cliente_id, external_id)`.
- `created_at` es la fecha de creación **en GHL**, nunca la de ingesta: las RPC
  agrupan por día en `America/Bogota` y sellar la fecha de importación movería de
  día todo el backfill.
- `utm_id` se llena con el id de campaña o, en su defecto, el del anuncio. El
  `mediumId` de la atribución **no** es una campaña (es la cuenta o página de
  origen) y nunca se usa para cruzar.
- Los campos de texto largo (transcripciones, resúmenes de IA) no entran en las
  respuestas del formulario: tendrían un valor distinto por lead y ensuciarían el
  detector de campos. Se guardan en `custom_data`.
- El job de la cola se llama `ghl_leads` y lo encola el planner de las 05:00 y
  14:00, igual que `meta_leads`.
