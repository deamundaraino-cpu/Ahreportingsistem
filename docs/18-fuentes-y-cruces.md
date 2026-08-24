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

## Parte 1 · Las siete fuentes

| Fuente                   | Qué mide                                                                     | Grano         | Cruza por                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| **Leads**                | Contactos, uno por fila (formulario web, Meta Lead Ads o CRM de GoHighLevel) | fila          | fecha · plataforma · campaña · conjunto · anuncio · **cualquier columna suya** · campos de formulario |
| **Ventas**               | Transacciones, una por fila                                                  | fila          | fecha · plataforma · campaña · conjunto · anuncio · columnas de venta                                 |
| **Anuncios**             | Gasto y métricas de plataforma                                               | día × entidad | fecha · plataforma · campaña · conjunto · anuncio                                                     |
| **Cuenta**               | GA4, Hotmart, métricas manuales                                              | día           | **solo fecha**                                                                                        |
| **Conversiones offline** | Totales diarios de un Sheet                                                  | día           | **solo fecha**                                                                                        |
| **Campos de Sheet**      | Columnas de un Sheet convertidas en métricas                                 | día / fila    | fecha · valor del campo · campaña · conjunto · anuncio                                                |
| **Suscripciones**        | Foto actual de Hotmart                                                       | foto          | **ninguno** (solo el total)                                                                           |

### Por qué el grano importa

- **Grano de fila** (Leads, Ventas) — se pueden **contar** y sirven de **eje de una
  tabla dinámica**. Son las únicas.
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
| Sesiones GA4                        | **no**                  | **no** — Cuenta solo cruza por fecha |

Esto es lo que explica el caso que más desconcierta: **un CPL por país sale
vacío o absurdo**. Los leads sí se reparten por país, el gasto no, así que la
división no significa nada. El editor lo avisa antes de que lo pidas.

### El puente entre leads y gasto

Leads y gasto viven en tablas distintas y el gasto no tiene UTM. El puente es la
**identidad de la campaña**, y se resuelve en cascada:

1. Corrección manual del trafficker (`/report-utm/cruce-campanas`)
2. `utm_id` = id de campaña
3. `utm_id` = id de anuncio → sube a su campaña
4. `utm_campaign` = nombre de campaña (normalizado)
5. `utm_content` = nombre de anuncio
6. `utm_term` = nombre de conjunto

**Los pasos 2 y 3 son los que sostienen el sistema.** Hoy entre el 67 % y el
100 % de los leads cruzan, y en dos clientes el cruce por nombre daría
prácticamente cero — sus campañas llevan emojis y corchetes que no coinciden con
el UTM. Cruzan porque el `utm_id` los rescata.

Un lead que no cruza **no se funde en un cubo común**: se queda como su propia
fila con gasto 0 y la UI la marca. Es deliberado — fundirlas escondía justo el
problema que hay que arreglar.

---

## Parte 3 · Armar un informe

Los informes viven en `/report-utm/informes`. Un informe es un lienzo de widgets
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

| Petición                                                   | Por qué no                                     |
| ---------------------------------------------------------- | ---------------------------------------------- |
| Gasto **desglosado** por país / formulario / campo de lead | Anuncios no tiene esas columnas                |
| Sesiones GA4 por campaña                                   | Cuenta está agregada por día, sin desglose     |
| Conversiones offline por campaña                           | Ídem — usa un **campo de Sheet**, que sí cruza |
| Suscripciones en una serie temporal                        | Es una foto, no una serie                      |
| Contar filas de una fuente diaria                          | Solo el grano de fila se cuenta                |
| ROAS real hoy                                              | `sales_events` está vacío (ver Parte 7)        |

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
Sin `public_cliente_id`, cinco de las siete fuentes son invisibles y devuelven
cero **en silencio**. Se ve de un vistazo en `/report-utm/salud`. Se arregla en
`/report-utm/clientes`.

**3. Los leads no cruzan con las campañas.**
Si casi todo cae en `(sin campaña)`, el problema es el etiquetado UTM. Ve a
`/report-utm/cruce-campanas`: muestra qué UTMs no cruzan y propone
correcciones. También lo vigila el panel de salud.

**4. Un filtro no atribuible anula el gasto.**
Filtrar por país o por un campo de formulario deja el gasto en 0 a propósito: no
sería atribuible. El widget lo avisa.

**5. La fuente está parada.**
`/report-utm/salud` dice qué fuente lleva días sin datos y desde cuándo.

**6. Denominador en cero.**
CPL, CPA y ROAS devuelven `—`, no 0. Un guion significa «no se puede calcular»,
no «cero».

---

## Parte 7 · Estado actual de las fuentes

Conviene saberlo antes de prometerle un informe a un cliente:

- **Ventas — vacía.** No hay ninguna transacción en la base. Todo lo que dependa
  de ella (ROAS, CPA, ingresos, tasa de conversión) devuelve vacío. Para los
  negocios que cierran fuera de una pasarela, la vía es el CRM del Sheet.
- **GA4** — configurado en 1 de 8 clientes.
- **Conversiones offline** — 3 clientes, todo de tipo `lead` y sin importe.
- **Suscripciones** — 2 clientes.

`npm run diagnostico` imprime el estado real y, por cliente, de dónde debería
salir una venta.

---

## Parte 8 · Vigilancia

Un informe con una fuente muerta **no se ve roto: se ve vacío**. Por eso hay
herramientas dedicadas:

| Dónde                        | Qué dice                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `/report-utm/salud`          | Fuentes paradas, integraciones caídas, cruce degradado, Sheets mal conectados |
| `/report-utm/cruce-campanas` | Qué UTMs no cruzan y sugerencias de corrección                                |
| `npm run diagnostico`        | Lo mismo por consola, más la ruta de ventas de cada cliente                   |

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
