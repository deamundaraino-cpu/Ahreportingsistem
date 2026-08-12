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
`report_utm.lead_events.raw_fields` (JSONB plano), venga de WordPress o de Meta
Lead Ads. El BI ya podía agrupar por una clave cruda (`field:<clave>`), pero el
dato crudo no cuadra para cruzarlo:

**La misma pregunta llega con claves distintas** según el formulario:

| Origen | Clave en `raw_fields` | Leads |
|---|---|---|
| Meta Lead Ads | `cual_es_tu_rango_de_ingresos` | 10.404 |
| Formulario web | `¿cuál_es_tu_rango_aproximado_de_ingresos?` | 1.725 |

Son dos dimensiones separadas: ningún informe suma los 12.129 leads.

**El mismo valor se escribe de varias formas** y cuenta doble:

| Respuesta | Leads |
|---|---|
| `Entre $2.000.000 a $3.000.000` | 424 |
| `Entre $2.000.000 – $3.000.000` | 30 |

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

### Límite conocido: el gasto no se recorta por respuesta

`metricas_diarias` está preagregada por día×cliente y el único puente hacia UTM
es el nombre de campaña. Un rango de ingresos no existe a nivel de anuncio, así
que **con un filtro de campo de lead activo el gasto y sus derivados (CPL, CPA,
ROAS) se muestran en 0**, con el aviso correspondiente en el informe. Los leads y
las ventas sí quedan filtrados.

Es la misma limitación que ya tenían los filtros por país, formulario o campo
crudo, y es deliberada: repartir el gasto entre respuestas daría un CPL
inventado. Para el costo por lead de un segmento hay que compararlo a mano contra
el gasto de la campaña.

---

## Detalle técnico

| Pieza | Dónde |
|---|---|
| Tabla | `report_utm.lead_campos` (migración `060`) |
| Bloque del dashboard | `LeadAnswerBlockDef` + RPC `bi_respuestas_por_dia` (migración `071`) |
| Lógica pura | [`src/lib/report-utm/lead-campos.ts`](../src/lib/report-utm/lead-campos.ts) |
| Lectura/escritura y detección | [`src/lib/report-utm/lead-campos-db.ts`](../src/lib/report-utm/lead-campos-db.ts) |
| Token del BI | `leadfield:<clave>` (dimensión y filtro) |
| API | `/api/report-utm/lead-campos`, `/lead-campos/detectar`, `/api/report-utm/bi/lead-fields` |
| UI | [`LeadCamposCard`](../src/components/report-utm/LeadCamposCard.tsx) |
| Comprobaciones | `npx tsx scripts/verify-lead-campos.ts` |

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
