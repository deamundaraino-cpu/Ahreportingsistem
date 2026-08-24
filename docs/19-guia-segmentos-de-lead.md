# 19 · Guía práctica: medir con las respuestas de los formularios

Cómo usar los **segmentos de campo de lead** (migración `073`) para responder
preguntas del tipo _«¿cuánto me cuesta un lead que gana más de 2 millones?»_
sin salir del editor de widgets.

Para configurar un campo desde cero, [doc 17 · Campos de lead](./17-campos-de-lead.md).
Para el mapa general de qué cruza con qué, [doc 18 · Fuentes y cruces](./18-fuentes-y-cruces.md).

---

## Lo que cambió, en una frase

Antes un campo de lead solo servía para **partir filas** (agrupar y filtrar).
Ahora, además, cada campo puede tener **segmentos** —«Desde 2M» = estos tres
rangos— que son **números**: van en una tarjeta, en una columna, en un embudo y
dentro de una fórmula.

**La consecuencia que importa:** `spend / lseg__ingresos_desde_2m` te da el CPL de
ese tipo de lead, con el gasto real. Antes eso no se podía pedir.

---

## Parte 1 · Los tres tipos de dato, y cuándo usar cada uno

| Lo que quieres                               | Qué usas          | Cómo se llama                                  | Dónde va  |
| -------------------------------------------- | ----------------- | ---------------------------------------------- | --------- |
| «Repárteme las filas por lo que contestaron» | **Campo**         | `Rango de ingresos`                            | Dimensión |
| «Solo los que contestaron X»                 | **Campo + valor** | filtro `Rango de ingresos = Más de $4.000.000` | Filtro    |
| «¿Cuántos contestaron exactamente X?»        | **Respuesta**     | `lf__rango_de_ingresos__mas_de_4_000_000`      | Métrica   |
| «¿Cuántos ganan de 2M para arriba?»          | **Segmento**      | `lseg__ingresos_desde_2m`                      | Métrica   |

Las dos primeras filas ya existían. Las dos últimas son lo nuevo.

**Respuesta vs segmento.** Una _respuesta_ es un bucket suelto y se genera sola a
partir del campo: no hay que crear nada. Un _segmento_ junta varios buckets bajo
un nombre —y por eso hay que definirlo— y es lo único que resuelve un acumulado
(«≥ 2M» son cuatro respuestas, no una).

> **Un segmento no es una dimensión ni un filtro, y es a propósito.** No aparece
> en esas listas. Si lo que quieres es _recortar_ el informe, usa el campo con su
> valor; si lo que quieres es _contar_ un subconjunto, usa el segmento. La
> diferencia decide si el gasto se anula o no — Parte 5.

---

## Parte 2 · Crear un segmento

Todo ocurre en la **ficha del cliente**: `/report-utm/clientes/[id]`, card
**«Campos de lead»**. Bajo cada campo hay una sección **«Segmentos · métricas de
este campo»** con tres formas de crearlos.

### Requisito previo: el campo tiene que estar agrupado y ordenado

Un segmento se define eligiendo buckets, así que si el campo no agrupa nada no hay
nada que elegir. Antes de empezar, comprueba en el editor del campo que:

1. **Paso 3 (Respuestas)** tiene las variantes fundidas — «Entre $2.000.000 a
   $3.000.000» y «Entre $2.000.000 – $3.000.000» deben ser **un** bucket, no dos.
2. **Paso 4 (Orden)** tiene los buckets de menor a mayor. Sin orden no se puede
   crear un acumulado: el sistema no sabe qué es «hacia arriba» y el atajo no
   aparece.

### Camino A — «Acumulado desde…» _(el más útil)_

Un desplegable con los buckets del campo. Eliges uno y crea **«Desde X»** con ese
bucket y todos los posteriores.

```
Campo:   Rango de ingresos
Orden:   Menos de $1.3M < $1.0-1.3M < $1.3-1.6M < $1.6-2M < $2-4M < Más de $4M
Eliges:  «Entre $2.000.000 y $4.000.000»
Crea:    «Desde Entre $2.000.000 y $4.000.000» = [$2-4M, Más de $4M]
```

Renómbralo a «Desde 2M» y listo. El nombre se puede cambiar cuando quieras; la
clave interna no.

### Camino B — «Una métrica por respuesta»

Un clic y crea un segmento por cada bucket del campo. Es lo que quieres en una
pregunta **categórica**, donde no hay ningún «desde X» que signifique nada:
ubicación, canal de origen, perfil profesional.

### Camino C — «Añadir segmento» (a mano)

Nombre + los buckets que marques. El desplegable `Excepto` invierte la selección:
«todos menos los que dijeron _Solo explorando_».

> **Un lead que no respondió la pregunta no entra en ningún segmento**, tampoco en
> uno de tipo `Excepto`. «No contestó» no es «no es de este grupo».

### Qué ves al crearlo

Cada segmento muestra su alias en monoespaciado: `lseg__ingresos_desde_2m`. **Ese
es el que se escribe en las fórmulas**, y es el mismo en los informes y en el
dashboard.

---

## Parte 3 · Usarlo en los informes (`/report-utm/informes`)

### Como métrica

Editor del widget → **Métrica** → grupo **«Segmentos de lead»**. Salen etiquetados
con su pregunta delante: _«Rango de ingresos: Desde 2M»_.

Funciona en **todos** los tipos: `scorecard`, `table`, `line`, `area`, `bar`,
`combo`, `pie`, `scatter`, `funnel` y como dimensión secundaria.

### Como fórmula

Editor del widget → botón **Fórmula** → **«+ Métrica»** → grupo **«Segmentos de
lead»** → lo eliges de la lista, no hace falta teclearlo.

```
spend / lseg__ingresos_desde_2m
```

### Como campo calculado del informe

Cabecera del informe → **Campos calculados** → **«+ Métrica»**. Aquí el segmento
sale junto a los campos de Sheet (`sf__`, `sv__`) y las columnas offline
(`off__`), que **antes de esta versión no se listaban en ningún sitio**.

Un campo calculado se define una vez y se reutiliza como columna en varios
widgets:

```
Nombre:   CPL 2M+
Fórmula:  spend / lseg__ingresos_desde_2m
Formato:  Moneda
```

---

## Parte 4 · Usarlo en el dashboard del cliente (`/dashboard/[clientId]`)

Layout Builder → tarjeta o columna → **Fórmula** → pestaña **«Respuestas»**. Ahí
están `utm_leads`, las respuestas (`lf__…`) y los segmentos (`lseg__…`), todos con
su nombre legible.

Todo lo que definas viaja al **enlace público** del cliente.

**Ojo con el ámbito.** Si la tarjeta lleva su propio filtro de campaña, tanto el
gasto como el segmento se recortan por ese filtro, así que la división sigue
significando algo. Eso es deliberado y está verificado.

**Dónde no aplica:** las tablas de ranking y las gráficas por **Anuncio** o
**Conjunto** muestran `n/a`, no 0. Un formulario no sabe qué anuncio trajo al
visitante; el cubo resuelve cada lead hasta su **campaña** y ahí se planta. Un 0
afirmaría que no hubo leads, que es falso.

---

## Parte 5 · La regla del gasto (la parte que hay que entender)

Es la única sutileza real de todo esto, y decide si un número significa algo.

|                                                  | Gasto    | Por qué                                                                                                                                                                         |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filtrar** por `Rango de ingresos = Más de $4M` | **0**    | El gasto vive en `metricas_diarias`, agregado por día y campaña. Una fila de gasto no sabe qué contestó cada lead. Repartirlo daría un CPL inventado con aspecto de dato medido |
| **Medir** con `lseg__ingresos_desde_2m`          | **real** | Una métrica no recorta la consulta: el gasto se trae entero y el segmento cuenta dentro del mismo ámbito                                                                        |

Lado a lado, el mismo widget:

```
❌  Métrica: spend, leads_count
    Filtro:  Rango de ingresos = Más de $4.000.000
    →  spend sale 0, con aviso. No hay CPL posible.

✅  Métrica: spend
    Fórmula: spend / lseg__ingresos_desde_2m
    →  spend real ÷ leads de ese tipo = el CPL del segmento.
```

Lo que **no** se puede seguir pidiendo es _repartir_ el gasto entre respuestas
(cuánto gasté “en” los de 2M+). Eso no existe en el dato. Lo que sí se puede es
_dividir_ el gasto del ámbito por los leads de un tipo, que es la pregunta que de
verdad se optimiza.

---

## Parte 6 · Recetario

### «¿Cuánto me cuesta un lead de más de 2M?»

```
Widget:     scorecard
Fórmula:    spend / lseg__ingresos_desde_2m
Formato:    Moneda
Comparar:   con el período anterior
```

### «¿Y campaña por campaña?»

```
Widget:     table
Dimensión:  Campaña
Columnas:   spend · leads_count · Rango de ingresos: Desde 2M · CPL 2M+
Orden:      spend desc · Top 15
```

`CPL 2M+` es el campo calculado de la Parte 3. La fila de totales suma la columna
del segmento correctamente (es un conteo, es aditivo).

### «Embudo de calificación del mes»

El caso que antes obligaba a crear cuatro campos.

```
Widget:  funnel
Etapas:  Respondieron el rango → Desde 1.3M → Desde 1.6M → Desde 2M
```

Con segmentos acumulados las etapas salen ordenadas de mayor a menor **por
construcción**: cada una es un subconjunto de la anterior.

### «¿Está mejorando la calidad del lead?»

```
Widget:      line
Métricas:    leads_count (línea 1) · Rango de ingresos: Desde 2M (línea 2)
Dimensión:   Fecha
Agrupación:  semana
```

Si la línea de arriba sube y la de abajo no, estás comprando volumen barato.

### «¿Qué porcentaje de mis leads califica?»

```
Widget:   scorecard
Fórmula:  lseg__ingresos_desde_2m / utm_leads * 100
Formato:  Porcentaje
```

`utm_leads` son **todos** los contactos, contesten o no. Si quieres el porcentaje
sobre los que sí contestaron, cambia el divisor por
`lseg__respondieron_rango`.

### «¿Qué campañas traen los leads que compran ya?»

```
Widget:     bar
Métrica:    Plazo de compra: Hasta 3 meses
Dimensión:  Campaña
Orden:      desc · Top 10
```

### «Reparto completo de una pregunta»

Aquí no hace falta segmento: usa el campo como dimensión.

```
Widget:     pie
Métrica:    leads_count
Dimensión:  Rango de ingresos
```

No añadas `spend`: no se reparte por respuesta y ensuciaría el gráfico con una
fila total desproporcionada.

### «Cruce de dos preguntas»

```
Widget:      bar
Métrica:     leads_count
Dimensión:   Campaña
Dimensión2:  Rango de ingresos
```

También puedes usar un segmento como métrica del pivot: `Desde 2M` por `Campaña ×
Plazo de compra`.

---

## Parte 7 · Catálogo actual, listo para copiar

Estado a **2026-08-18**. Los alias son los que se escriben en las fórmulas.

### Goodprop

**Rango de ingresos** — `Menos de $1.300.000` · `Entre $1.000.000 y $1.300.000` ·
`Entre $1.300.000 y $1.600.000` · `Entre $1.600.000 y $2.000.000` ·
`Entre $2.000.000 y $4.000.000` · `Más de $4.000.000`

| Segmento              | Alias                       | Qué incluye          |
| --------------------- | --------------------------- | -------------------- |
| Respondieron el rango | `lseg__respondieron_rango`  | los 6 buckets        |
| Desde 1.3M            | `lseg__ingresos_desde_1_3m` | de $1.3M para arriba |
| Desde 1.6M            | `lseg__ingresos_desde_1_6m` | de $1.6M para arriba |
| Desde 2M              | `lseg__ingresos_desde_2m`   | de $2M para arriba   |

Respuestas sueltas: `lf__rango_de_ingresos__mas_de_4_000_000`,
`lf__rango_de_ingresos__entre_2_000_000_y_4_000_000`,
`lf__rango_de_ingresos__menos_de_1_300_000`, …y `lf__rango_de_ingresos__sin_respuesta`.

**Plazo de compra** — `Cuanto antes` · `1 a 3 meses` · `3 a 6 meses` · `Solo explorando`

| Segmento      | Alias                       |
| ------------- | --------------------------- |
| Hasta 3 meses | `lseg__plazo_hasta_3_meses` |
| Hasta 6 meses | `lseg__plazo_hasta_6_meses` |

### Somos rentable

**Monto a invertir** — `Menos de $15M` · `Entre $15M y $30M` · `Entre $30M y $50M` · `Más de $50M`

| Segmento   | Alias                      |
| ---------- | -------------------------- |
| Desde $15M | `lseg__invertir_desde_15m` |
| Desde $30M | `lseg__invertir_desde_30m` |
| Desde $50M | `lseg__invertir_desde_50m` |

### Sur Profundo

**Rango de renta** — `Menos de $2.000.000` · `Entre $2.000.000 y $3.000.000` · `Más de $3.000.000`
→ `lseg__renta_desde_2m` · `lseg__renta_desde_3m`

**Pie disponible** — `Menos de $12.000.000` · `Entre $12.000.000 y $15.000.000` · `Más de $15.000.000`
→ `lseg__pie_desde_12m` · `lseg__pie_desde_15m`

### Cris tributario

Van **dos campos separados** porque los dos formularios usan escalas que no
encajan. Fundirlos inventaría una equivalencia entre «2 a 3» y «Tengo 3-4» que no
existe.

| Campo                        | Buckets                  | Segmentos                                                           |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------- |
| Número de propiedades (web)  | 0 a 1 · 2 a 3 · Más de 4 | `lseg__propiedades_web_desde_2` · `lseg__propiedades_web_desde_4`   |
| Número de propiedades (Meta) | 3 a 4 · 5 a 8 · Más de 8 | `lseg__propiedades_meta_desde_5` · `lseg__propiedades_meta_desde_9` |

**No los sumes entre sí.** Son dos poblaciones distintas medidas con dos reglas
distintas.

### Inspira

Cuatro campos categóricos, sin segmentos todavía: `ubicacion`, `prioridad`,
`canal`, `perfil`. Aquí el camino es **«Una métrica por respuesta»**, no los
acumulados. Ejemplo de alias generado: `lf__perfil__investor_family_office`.

### Eduversio

**No tiene ni tendrá campos, y no es un olvido.** Sus 41.569 leads del último año
no traen ninguna pregunta de opción: los formularios solo piden nombre y correo.
No hay nada que agrupar.

---

## Parte 8 · Problemas frecuentes

**El segmento no aparece en la lista de métricas.**
Comprueba que el informe tiene un cliente seleccionado: los campos de lead son por
cliente. Si acabas de crearlo, recarga el editor.

**No puedo crear un acumulado, no sale el desplegable.**
El campo no tiene orden configurado. Editor del campo → paso 4 → ordena los
buckets de menor a mayor.

**El segmento cuenta menos de lo que espero.**
Casi siempre es que el campo no agrupa las variantes de escritura, así que la
mitad de los leads cae en otro bucket que no marcaste. Míralo en el paso 3 del
editor del campo: si ves «Entre $2.000.000 a $3.000.000» y «Entre $2.000.000 –
$3.000.000» por separado, ese es el problema. **Auto-agrupar** los junta.

**El gasto sale 0.**
Tienes un **filtro** por campo de lead activo en el widget o en el informe. Quita
el filtro y usa el segmento como métrica (Parte 5).

**La columna sale `n/a` en una tabla de ranking.**
Estás agrupando por Anuncio o Conjunto. Los leads solo se resuelven hasta
Campaña — Parte 4.

**Cambié el nombre del segmento y los widgets siguen funcionando.**
Correcto, y es a propósito: los widgets guardan la **clave**, no el nombre.
Renombrar es libre; la clave es inmutable desde el alta.

---

## Apéndice · Para quien mantiene el código

| Pieza               | Dónde                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Tabla               | `report_utm.lead_campo_segmentos` (migración `073`)                                                                        |
| Token del BI        | `leadseg:<clave>` · alias de fórmula `lseg__<clave>`                                                                       |
| Clave del dashboard | `lseg__<clave>` — **la misma cadena**, a diferencia de los campos de Sheet                                                 |
| Lógica pura         | [`lead-campos.ts`](../src/lib/report-utm/lead-campos.ts): `segmentoIncluyeBucket`, `cuentaEnSegmento`, `bucketsAcumulados` |
| Motor del BI        | [`bi-query.ts`](../src/lib/report-utm/bi-query.ts): `collectLeadSegClaves`, `aggregateLeads`, `mergeResults`               |
| Cubo del dashboard  | [`lead-answer-aggregation.ts`](../src/lib/dashboard/lead-answer-aggregation.ts): `claveSegmento`, `clavesDelDia`           |
| UI                  | [`LeadSegmentosEditor`](../src/components/report-utm/LeadSegmentosEditor.tsx)                                              |
| API                 | `/api/report-utm/lead-campos/segmentos` · `/api/report-utm/bi/lead-fields`                                                 |
| Comprobaciones      | `verify-lead-segmentos.ts` (puro) · `verify-lead-segmentos-db.ts` (datos reales)                                           |
| Migración de datos  | `npx tsx scripts/migrar-segmentos-lead.ts` — informe · `--aplicar` · `--revertir <copia>`                                  |

Tres invariantes que los tests vigilan y que no se pueden romper:

1. Un segmento **nunca** entra en la suma `respuestas + sin_respuesta = utm_leads`
   del dashboard: solapa buckets a propósito.
2. Un segmento **no** se añade a `NON_ATTRIBUTABLE_FIELDS`. Es una medida, no un
   filtro; si entrara ahí, `spend / lseg__x` daría 0 y la feature no serviría.
3. El motor del BI y el cubo del dashboard tienen que devolver **el mismo número**
   para el mismo segmento y rango.
