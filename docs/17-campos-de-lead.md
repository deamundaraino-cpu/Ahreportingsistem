# 17 · Campos de lead — cruzar las respuestas de los formularios

Guía práctica para convertir las respuestas de los formularios de un cliente
(rango de ingresos, plazo de compra, tipo de propiedad…) en dimensiones y
filtros de los informes de Report-UTM.

Es el equivalente, para los leads que entran por formulario, de lo que
[doc 16 · Campos de Sheet](./16-campos-de-sheet.md) hace con las columnas de un
Google Sheet.

---

## El problema que resuelve

Cada lead guarda TODAS las respuestas de su formulario en
`report_utm.lead_events.raw_fields` (JSONB plano), venga de WordPress, de Meta
Lead Ads o de GoHighLevel (migración 074). El BI ya podía agrupar por una clave
cruda (`field:<clave>`), pero el dato crudo no cuadra para cruzarlo:

**La misma pregunta llega con claves distintas** según el formulario:

| Origen         | Clave en `raw_fields`                                   | Leads  |
| -------------- | ------------------------------------------------------- | ------ |
| Meta Lead Ads  | `cual_es_tu_rango_de_ingresos`                          | 10.404 |
| Formulario web | `¿cuál_es_tu_rango_aproximado_de_ingresos?`             | 1.725  |
| GoHighLevel    | `Rango de ingresos` (el nombre del campo personalizado) | —      |

Son dos dimensiones separadas: ningún informe suma los 12.129 leads.

**El mismo valor se escribe de varias formas** y cuenta doble:

| Respuesta                       | Leads |
| ------------------------------- | ----- |
| `Entre $2.000.000 a $3.000.000` | 424   |
| `Entre $2.000.000 – $3.000.000` | 30    |

Además Meta normaliza a snake_case (`entre_$2.000.000_y_$4.000.000`), feo en un
informe de cliente, y los rangos se ordenan alfabéticamente en vez de de menor a
mayor.

Un **campo de lead** une todo eso bajo un nombre propio —"Rango de ingresos"— con
sus valores agrupados y en el orden correcto.

---

## Configuración

Todo ocurre en la **ficha del cliente** (`/report-utm/clientes/[id]`), card
**"Campos de lead"**.

### 1. Nuevo campo

El módulo escanea los leads del último año y lista las preguntas detectadas, con
cuántos leads las responden y cuántas respuestas distintas tienen. Las marcadas
como `OPCIÓN` (pocas respuestas, muy repetidas) van primero: son las cruzables.

No se ofrecen las claves que nunca son un campo —correo, teléfono, nombre, los
`utm_*` (que ya son dimensiones propias del BI) ni los `field_9f2a1b3` sin
etiqueta de Elementor.

### 2. Marca las preguntas equivalentes

Marca **todas** las claves que sean la misma pregunta. Ahí es donde se unifica el
formulario web con el de Meta. La comparación ignora mayúsculas, acentos y
signos, así que `Rango de renta` y `rango_de_renta` ya son la misma clave.

### 3. Agrupa las respuestas

Aparecen las respuestas reales de esas preguntas, con sus leads. **Auto-agrupar**
propone juntar las variantes evidentes: trata `a`, `y`, `-` y `–` entre números
como el mismo separador, de modo que las tres parejas del ejemplo caen juntas.
El nombre propuesto para el grupo es la variante más frecuente; se puede
renombrar marcando los valores y escribiendo el nombre.

El botón **"Apartar «Seleccione una opción»"** manda los rellenos de desplegable
y los leads de prueba de Meta a `(sin respuesta)`.

El desplegable de la derecha decide qué pasa con lo que no agrupes: dejarlo tal
cual, mandarlo a `(otros)` o ignorarlo.

### 4. Ordena los valores

Sube y baja los buckets hasta dejarlos de menor a mayor. Sin esto, la tabla los
ordena alfabéticamente y "Menos de $2M" acaba entre medio de los demás.

Además, sin orden no se pueden crear **acumulados**: el paso siguiente necesita
saber qué es "hacia arriba".

### 5. Segmentos: convertir una respuesta en una métrica

Un campo es una **dimensión**: agrupa y filtra. Un **segmento** es un subconjunto
con nombre de sus buckets —"Desde 2M" = estos tres— y sí es una **métrica**: va en
una tarjeta, en una columna de tabla, en una etapa de embudo y dentro de una
fórmula.

Existe porque un acumulado ("todos los que ganan ≥ 2M") no es un bucket, son
varios. Sin esto la única salida era crear **un campo de lead por umbral**, que es
exactamente lo que había en producción: Goodprop tenía cuatro campos sobre la
misma pregunta y Cris tributario tres, todos fingiendo ser contadores.

Debajo de cada campo, en la misma card, hay tres formas de crearlos:

- **Añadir segmento** — eliges los buckets a mano. El desplegable `Excepto`
  invierte la selección ("todos menos los que no respondieron el rango alto").
- **Una métrica por respuesta** — un segmento por cada bucket, de un clic. Es lo
  que quieres para una pregunta categórica (ubicación, canal, perfil), donde no
  hay ningún "desde X" que tenga sentido.
- **Acumulado desde…** — crea "Desde $2M" con ese bucket y todos los posteriores
  del orden que definiste en el paso 4. Es el atajo que sustituye al campo por
  umbral.

Un lead que **no respondió** la pregunta no entra en ningún segmento, tampoco en
uno de tipo `Excepto`: "no contestó" no es "no es de este grupo".

Los segmentos **solapan** buckets a propósito, así que no entran en la suma
`respuestas + (sin respuesta) = utm_leads` del bloque del dashboard, que sigue
cerrando igual.

---

## Uso en el General Overview

Desde la migración 071, los campos de lead **también se consumen fuera del BI**:
las pestañas de cada empresa en `/dashboard/[clientId]` pueden llevar un bloque
de **Respuestas de formulario** que desglosa los leads por lo que contestaron.

- Si el cliente tiene campos configurados aquí, el bloque los usa tal cual —con
  el nombre, la agrupación y el orden que definiste—. Si no, autodetecta las
  preguntas de opción y las muestra en crudo, y ofrece guardarlas en este
  catálogo con un botón.
- El bloque respeta el filtro de campañas y el rango de fechas de la pestaña, y
  viaja al enlace público del cliente.
- **Solo cuenta leads**, por la misma razón que se explica más abajo: el gasto no
  se puede recortar por respuesta. Ahí el bloque no muestra 0, sino que declara
  que no reparte inversión.

Detalle en [doc 10 · Sistema de layouts](./10-sistema-de-layouts.md#desglose-por-respuesta-de-formulario-leadanswerblockdef).

> **¿Buscas cómo usarlo, no cómo configurarlo?** La guía práctica con recetas,
> ejemplos copiables y el catálogo actual de cada cliente está en
> [doc 19 · Guía de segmentos de lead](./19-guia-segmentos-de-lead.md).

## Uso en los informes

El campo aparece de inmediato — no hay recálculo: el catálogo se aplica al
consultar, así que editar una agrupación se ve en el informe al recargar.

- **Agrupar**: en el editor de widgets, el campo sale en la lista de dimensiones
  con su nombre. Una tabla `Rango de ingresos × Leads` responde "cuántos leads
  dijeron cada rango".
- **Filtrar todo el informe**: en el constructor de filtros, eligiendo el campo
  y su valor de la lista (los valores se ofrecen en un desplegable, no hay que
  escribirlos).
- **Slicer**: un widget de tipo Slicer sobre el campo deja que el cliente
  cambie el valor desde el informe compartido.
- **Tabla dinámica**: como dimensión secundaria, ej. `Campaña × Rango de
ingresos`.

### Filtrar anula el gasto; medir con un segmento no

Es la distinción que hay que tener clara, porque decide qué se puede pedir.

**Un filtro** por campo de lead deja el gasto y sus derivados (CPL, CPA, ROAS)
**en 0**, con el aviso correspondiente en el informe. Los leads y las ventas sí
quedan filtrados. `metricas_diarias` está preagregada por día×cliente y el único
puente hacia UTM es el nombre de campaña: un rango de ingresos no existe a nivel
de anuncio, así que repartir el gasto entre respuestas daría un CPL inventado con
aspecto de dato medido. Misma limitación que los filtros por país, formulario o
campo crudo, y es deliberada.

**Una métrica de segmento no es un filtro.** No recorta el ámbito de la consulta,
así que el gasto se sigue trayendo entero:

```
spend / lseg__ingresos_desde_2m      → costo por lead de más de 2M
```

Numerador y denominador quedan recortados por el mismo ámbito (la campaña, la
fecha, el filtro que tenga el widget), así que la división significa algo. No
reparte nada: responde «cuánto me cuesta conseguir un lead de este tipo», que es
justo lo que se optimiza. Es la misma decisión que
[doc 10](./10-sistema-de-layouts.md) ya documenta para `meta_spend / lf__x`.

Por eso un segmento **no se ofrece como filtro ni como dimensión**: para filtrar
está el campo con su valor, que sí es honesto sobre el gasto.

---

## Retirar un campo sin romper nada

Un campo se puede **desactivar** (botón del ojo en la card) o **borrar**. Las dos
cosas tienen el mismo efecto para quien lo estaba usando: el catálogo se lee con
`soloActivos`, así que el campo deja de existir para el BI y para los bloques del
dashboard, y **eso no produce ningún error** — simplemente el widget se queda sin
datos.

Por eso, antes de desactivar o borrar, la card dice **quién lo está usando**, con
nombre y motivo:

- informes del BI que llevan `leadfield:<clave>` en una dimensión o un filtro;
- pestañas o layouts con una fórmula `lf__<clave>__…`;
- pestañas con un **bloque de «Respuestas de formulario»** apuntando al campo;
- y los **segmentos** del campo (`leadseg:` / `lseg__`), que caen con él.

Esa tercera vía es la que faltaba y costó una avería real: los bloques guardan la
clave **desnuda** (`{"origen":"catalogo","clave":"…"}`), sin ningún token, así que
la comprobación de `migrar-segmentos-lead.ts` —que solo buscaba tokens— dio el
visto bueno al desactivar los cuatro campos-umbral de Goodprop y dejó dos bloques
de la pestaña «Evergreen Captacion» mostrando un cartel de error durante semanas.

Si un bloque se queda apuntando a un campo retirado, el dashboard **lo dice con
esas palabras** y nombra la clave, en vez del engañoso «este cliente no tiene
respuestas de formulario». Y el selector de pregunta sigue mostrando el campo
configurado, marcado como `inactivo`, para poder decidir entre reactivarlo o
cambiar de pregunta.

Para re-apuntar bloques en masa: `npx tsx scripts/reapuntar-bloques-lead.ts`
(simulación; `--aplicar` para escribir, con volcado previo para revertir).

---

## Detalle técnico

| Pieza                         | Dónde                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabla del campo               | `report_utm.lead_campos` (migración `060`)                                                                                                                      |
| Tabla del segmento            | `report_utm.lead_campo_segmentos` (migración `073`)                                                                                                             |
| Bloque del dashboard          | `LeadAnswerBlockDef` + RPC `bi_respuestas_por_dia` (migración `071`)                                                                                            |
| Lógica pura                   | [`src/lib/report-utm/lead-campos.ts`](../src/lib/report-utm/lead-campos.ts)                                                                                     |
| Lectura/escritura y detección | [`src/lib/report-utm/lead-campos-db.ts`](../src/lib/report-utm/lead-campos-db.ts)                                                                               |
| Token del campo               | `leadfield:<clave>` (dimensión y filtro)                                                                                                                        |
| Token del segmento            | `leadseg:<clave>` (métrica) · alias de fórmula `lseg__<clave>`                                                                                                  |
| Métrica por respuesta         | `lf__<campo>__<respuesta>` — solo en el dashboard, derivada de los buckets                                                                                      |
| Quién usa un campo            | [`src/lib/report-utm/lead-campo-referencias.ts`](../src/lib/report-utm/lead-campo-referencias.ts) · `GET /api/report-utm/lead-campos?con_referencias=1`         |
| API                           | `/api/report-utm/lead-campos`, `/lead-campos/detectar`, `/lead-campos/segmentos`, `/lead-campos/sugeridas`, `/api/report-utm/bi/lead-fields`                    |
| UI                            | [`LeadCamposCard`](../src/components/report-utm/LeadCamposCard.tsx) + [`LeadSegmentosEditor`](../src/components/report-utm/LeadSegmentosEditor.tsx)             |
| Comprobaciones                | `npx tsx scripts/verify-lead-segmentos.ts` (puro) · `verify-lead-segmentos-db.ts` y `verify-lead-campo-referencias.ts` (datos reales) · `verify-lead-campos.ts` |
| Migración de datos            | `npx tsx scripts/migrar-segmentos-lead.ts` (informe · `--aplicar` · `--revertir`) · `scripts/reapuntar-bloques-lead.ts`                                         |

> **Ojo con el orden de las RPC.** `bi_respuestas_por_dia` y `bi_leads_por_dia` se
> leen paginando por OFFSET, así que su `ORDER BY` **tiene que cubrir el grano
> completo** o unas filas salen dos veces y otras ninguna. Lo arregló la migración
> `078`; antes de ella el conteo del dashboard cambiaba entre recargas y
> `verify-lead-segmentos-db` fallaba una de cada tres veces.

El alias del segmento es **la misma cadena en el BI y en el dashboard**
(`lseg__<clave>`), a diferencia de los campos de Sheet (`sf__` / `sf_`), que
divergen por una colisión histórica con el prefijo `sheet_`. Quien aprende un
alias en una pantalla lo escribe igual en la otra.

La `clave` es un slug estable que se fija en el alta: es lo que queda guardado
dentro de los widgets, así que **renombrar el campo no rompe los informes ya
creados**.

Los filtros por campo de lead no se pueden resolver en SQL (unen varias claves y
funden valores), así que el motor los pasa al filtro avanzado y los evalúa en
memoria sobre las filas ya traídas — un único camino para tabla, pivot, slicer y
embudo.

El agrupador de valores es el mismo componente que usan los campos de Sheet
([`components/campos/ValoresAgrupador`](../src/components/campos/ValoresAgrupador.tsx)),
con la heurística de auto-agrupación cambiada por props.
