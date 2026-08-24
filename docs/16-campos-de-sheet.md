# 16 · Campos de Sheet — guía de configuración

Guía práctica para conectar un Google Sheet y convertir sus columnas en métricas
utilizables desde los informes y los dashboards.

Para el detalle técnico (tokens, tablas, límites del motor) ver
[doc 08 · Integraciones](./08-integraciones.md#campos-de-sheet) y
[doc 04 · Modelo de datos](./04-modelo-de-datos.md#campos-de-sheet-migración-058).

---

## El problema que resuelve

Un cliente recoge leads con varios formularios, cada uno con su propia pestaña en
el Sheet. La misma pregunta se llama distinto en cada uno:

| Pestaña                                   | Columna                        |
| ----------------------------------------- | ------------------------------ |
| `form filtro logico`                      | `rango de ingresos`            |
| `Formulario filtro logico- Abril 2026 V2` | `cual_es_tu_rango_de_ingresos` |

Y las respuestas también se escriben distinto: `entre_$1.300.000_a_$1.600.000` en
una hoja y `entre_$1.300.000_y_$1.600.000` en otra.

Un **campo de Sheet** une todo eso bajo un nombre propio —"Rango de ingresos"— y
lo deja disponible como métrica, como dimensión y como filtro en toda la
plataforma.

---

## Parte 1 · Conectar el Sheet

Todo ocurre en **Ajustes del cliente** (`/admin/settings/[id]`).

### 1. Conecta la cuenta de Google (una sola vez para toda la agencia)

En `/admin/settings`, card **"Conexión Google (Analytics + Sheets)"**. Si ya
aparece un correo conectado, sáltate este paso.

Sin esto el módulo funciona igual pegando URLs a mano, pero pierdes el selector
de documentos de Drive.

### 2. Agrega el documento

Card **"Google Sheets — Conversiones Offline"** → **`+ Agregar Sheet`**.

Ponle un nombre reconocible ("Leads Goodprop", no "Sheet 1"): es el que verás
después al mapear columnas. Luego pega la URL o usa **`Seleccionar`** para
elegirlo del Drive conectado.

### 3. Elige las pestañas

**`Detectar pestañas`** y marca las que quieras sincronizar.

### 4. Configura cada pestaña

Solo hay tres cosas que importan:

- **Fecha** → el nombre exacto de la columna de fecha. **Si te equivocas aquí se
  descarta todo**: la fecha es el eje temporal de todo el módulo. Acepta
  `DD/MM/YYYY`, `YYYY-MM-DD` y el `created_time` de los exports de Meta
  (incluido el formato con espacio, `YYYY-MM-DD HH:MM:SS`).
- **`Cada fila es una conversión`** → márcalo si cada fila del Sheet es un lead.
  Los exports de formularios no traen columna de cantidad y, sin esto, todas sus
  filas se descartan por "cantidad 0".
- **`Tipo fijo` → `Todas son leads`** → para que sumen en `offline_leads`.

El resto del mapeo (tipo, cantidad, valor, fuente, notas) déjalo vacío si tu hoja
no tiene esas columnas.

> Con `Todas son leads` ninguna fila llega como venta, así que `offline_ventas`
> vale 0 permanentemente y las métricas que dividen por él —**Offline: CPA
> Real**, **Close Rate** y **ROAS Real**— solo podrían mostrar `–`. Por eso el
> selector de métricas no las ofrece hasta que el cliente tenga alguna
> conversión offline con `tipo = 'venta'`: mapea una columna de tipo cuyo valor
> sea `venta` en esas filas y aparecerán solas.

> Pulsa **`Validar configuración`** antes de guardar: comprueba que el documento
> es accesible, que las pestañas existen y que las columnas mapeadas están ahí.
> De paso llena el autocompletado de los nombres de columna.

### 5. Guarda y sincroniza

**`Guardar Todo`** → **`Sincronizar todos ahora`**.

Esto llena dos capas: las conversiones de siempre y la **capa cruda**
(`sheet_filas`, todas las columnas tal cual). La capa cruda es lo que hace que
todo lo siguiente sea instantáneo: crear o editar un campo se recalcula desde la
base **sin volver a llamar a Google**.

El botón va **documento a documento** (verás `Sincronizando 2/3 · <nombre>`) y
recalcula los campos al terminar. Es a propósito: los documentos grandes no caben
todos juntos en el límite de tiempo del servidor. Si uno falla, los demás siguen
y el motivo sale como aviso junto al resultado.

---

## Parte 2 · Crear el campo

Card **"Campos de Sheet"**, justo debajo de la de Sheets.

> Si dice _"Aún no hay pestañas sincronizadas"_, falta el paso 5.

### 6. `Agregar campo`

| Ajuste          | Ejemplo             | Qué significa                                            |
| --------------- | ------------------- | -------------------------------------------------------- |
| **Nombre**      | `Rango de ingresos` | El que verás en informes, dashboards y fórmulas          |
| **Se usa como** | `Categoría`         | Categoría = agrupar y filtrar · Número = sumar/promediar |
| **Se mide**     | `Contando filas`    | Cómo se calcula por defecto                              |

### 7. Di dónde está el dato

**"¿Dónde está este dato?"** → **`Añadir pestaña`**. Elige la pestaña y marca la
columna. Debajo de cada columna aparecen valores de ejemplo — úsalos para
reconocerla cuando el nombre no ayude.

**Repite por cada pestaña donde esté el mismo dato.** Aquí está la clave: da igual
que la columna se llame distinto en cada una.

Si marcas varias columnas en la misma pestaña, el desplegable de la derecha decide
qué hacer: quedarse con **la 1ª con dato**, **sumarlas** o tratarlas como valores
independientes (**cada una**).

### 8. `Crear y calcular`

El diálogo se queda abierto, ahora con los valores reales del Sheet.

---

## Parte 3 · Agrupar los valores

Aquí es donde las dos formas de escribir lo mismo dejan de contar por separado.

### 9. Lee las dos columnas

A la izquierda, los valores tal como están en los Sheets, con **cuántas filas**
tiene cada uno y **de qué pestaña** salen. A la derecha, cómo queda el campo.

### 10. Prueba `Auto-agrupar`

Junta las variantes evidentes: `20 a 100`, `20-100` y `20A100` caen en el mismo
grupo. Lo que decidas a mano siempre gana sobre la sugerencia.

### 11. Agrupa el resto

Marca las casillas de las variantes, escribe el nombre del grupo y pulsa
**`Agrupar`**.

El nombre que escribas es por el que filtrarás después: ponlo legible
(`$1.3M - $1.6M`, no `entre_1300000_a_1600000`).

El desplegable **"Los no agrupados…"** decide qué pasa con lo que no toques: van
tal cual, se juntan en `(otros)` o se ignoran.

### 12. `Guardar y recalcular`

Tarda un segundo y no llama a Google.

---

## Parte 4 · Crear las vistas

Una **vista** es un recorte con nombre propio que se comporta como una métrica
más. Son gratis: crea una por cada corte que vayas a mirar seguido.

### 13. `Añadir vista`

| Ajuste        | Ejemplo                                       |
| ------------- | --------------------------------------------- |
| **Nombre**    | `Leads alto ingreso`                          |
| **Se mide**   | `Contar filas`                                |
| **Condición** | `Donde sea` (o `Excepto` para el complemento) |
| **Valores**   | `$2M - $4M`, `Más de $4M`                     |

### 14. `Crear vista`

No requiere recálculo: se evalúa sobre el desglose que el campo ya dejó guardado.

---

## Parte 5 · Usarlo

### En un informe del BI (`/report-utm/informes`)

| Quiero…                           | Widget            | Configuración                         |
| --------------------------------- | ----------------- | ------------------------------------- |
| El número de leads del rango alto | Scorecard         | Métrica: `Leads alto ingreso`         |
| Su evolución                      | Gráfica de líneas | Dimensión `Fecha` + la vista          |
| El reparto por rango              | Barras            | Dimensión `Rango de ingresos`         |
| Filtrar el informe entero         | Slicer            | Sobre el campo                        |
| El CPL de los leads buenos        | Campo calculado   | `meta_spend / sv__leads_alto_ingreso` |

### En el dashboard del cliente

Los campos aparecen con su nombre en **todos** los sitios donde se elige una
métrica: el Layout personalizado, la edición rápida de un bloque y las plantillas
globales de `/admin/layouts` (ahí eliges de qué cliente listar los campos, porque
una plantilla no pertenece a ninguno).

En fórmulas son `sf_<clave>` (el campo) y `sv_<clave>` (una vista). Al insertar
uno en una fórmula vacía se prerrellena su formato: un campo de moneda entra ya
con `$`.

Funcionan igual en el enlace público del cliente, en el archivo de pestañas y en
los comparativos (el "vs. periodo anterior" de las tarjetas).

**Agrupar por fechas.** La tabla y los gráficos agrupan por día, semana, mes o
año. Un campo de conteo o de suma se suma; uno de **promedio** se recalcula sobre
el total del periodo, no se suma —tres días de 30, 32 y 28 dan 30, no 90—, y los
mínimos y máximos se pliegan. Es la misma aritmética que el BI, así que las dos
vistas del mismo dato coinciden.

### El botón "Sincronizar Datos"

Sincroniza las métricas de campaña **y** los Google Sheets del cliente, en ese
orden, mostrando en qué fase va. Si el cliente no tiene Sheets, esa fase ni
aparece. Si el Sheet falla, las métricas sí se guardan y se avisa en ámbar en vez
de marcar todo el sync como error.

---

## Tres cosas que conviene saber

**El orden importa.** Sin sincronizar no hay columnas que mapear ni valores que
agrupar. Si la card de campos se ve vacía, el problema casi siempre está en el
paso 5.

**Puedes renombrar sin miedo.** El nombre visible es libre; la clave interna es
inmutable. Renombrar un campo no rompe ningún informe guardado.

**Un campo de Sheet no cruza con leads ni con gasto.** El Sheet no guarda a qué
lead corresponde cada fila, así que su desglose no se puede repartir entre
campañas. En consecuencia: al agrupar por un campo de Sheet las métricas de otras
fuentes salen en cero, filtrar por él anula el gasto (no sería atribuible) y no
sirve como eje de tabla dinámica. El editor avisa en los tres casos. Para
evolución temporal, usa dimensión `Fecha`.

---

## Diagnóstico

| Síntoma                               | Causa habitual                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| "Aún no hay pestañas sincronizadas"   | Falta sincronizar el Sheet (paso 5)                                                                                        |
| El campo no encuentra valores         | La columna marcada no es la que tiene el dato, o la pestaña no está habilitada                                             |
| Se importaron 0 filas                 | Columna de fecha mal escrita, o falta `Cada fila es una conversión`                                                        |
| Aparece el aviso "muchos valores"     | El campo apunta a algo de alta cardinalidad (correo, id). Deja de ofrecerse como categoría y el excedente cae en `(otros)` |
| Los leads no suman en `offline_leads` | Falta `Tipo fijo → Todas son leads`                                                                                        |

El estado del último sync por sheet (filas importadas, descartadas y avisos por
pestaña) se muestra en la propia card de Sheets.

---

## Limitación conocida

La capa cruda guarda **todas** las columnas de la pestaña, incluidas las de datos
personales (correo, teléfono, nombre, documento). El motor sabe detectarlas
(`esColumnaSensible`) y el sync soporta excluirlas por pestaña con `raw_exclude`,
pero **no tiene interfaz todavía**: hoy hay que ponerlo a mano en
`config_api.google_sheets_conversiones[].tabs[].raw_exclude`.

```jsonc
"raw_exclude": ["email", "telefono", "nombre_completo"]
```

Alternativa por pestaña: `"raw_mode": "declared"` (solo lo declarado) o
`"raw_mode": "none"` (nada en crudo; la pestaña solo alimenta conversiones).
