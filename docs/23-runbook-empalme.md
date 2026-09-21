# 23 · Runbook de empalme: si algo falla, qué mirar

Para quien opera la plataforma sin haberla construido. Cada sección empieza por el
síntoma que se ve, dice dónde mirar y qué hacer. Si nada de esto lo resuelve, el
último bloque explica cómo pedir ayuda con el contexto justo.

---

## Antes de nada: las tres pantallas de diagnóstico

| Pantalla          | Qué dice                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `/admin/salud`    | Fuentes paradas, integraciones en error, cuentas de Meta que no pueden publicar, cruce de leads degradado |
| `/cruce-campanas` | Qué UTMs no cruzan con campañas, conjuntos y anuncios, y cuántos leads quedaron excluidos                 |
| `/admin/sync`     | Estado de las sincronizaciones y sus errores                                                              |

Y por consola: `npm run diagnostico` (estado real de cada fuente por cliente).

---

## «El informe sale vacío o en cero»

En este orden de probabilidad:

1. **La métrica no cruza con la dimensión.** El editor atenúa las métricas que no
   se reparten por esa dimensión (el gasto no se reparte por país; las sesiones de
   GA4 no se reparten por campaña). Cambia la dimensión.
2. **El cliente está sin enlace.** En `/admin/settings` aparece «Sin enlace».
   Sin enlace, cinco de las siete fuentes devuelven cero en silencio. Usa
   «Enlazar con…» en esa fila.
3. **Los leads no cruzan con las campañas.** `/cruce-campanas`. Si casi
   todo cae en «(sin campaña)», es etiquetado UTM, no un fallo: corrígelo ahí (por
   campaña, conjunto o anuncio) o revisa los campos ocultos del formulario de GHL
   ([doc 21](./21-auditoria-utms-ghl.md)).
4. **La fuente está parada.** `/admin/salud` dice cuál y desde cuándo.

## «Hay muchos menos leads que antes»

Probablemente la regla «Qué leads cuentan» del cliente está activa. Es a propósito:
los leads sin atribución (WhatsApp directo, perfil de Instagram) no cuentan.

- Mira `/leads` → pestaña **Excluidos**: ahí están, con el motivo.
- Si alguno sí debía contar, selecciónalo y «Volver a contar».
- Si la regla está mal calibrada, cámbiala en la ficha del cliente y usa
  «Previsualizar sobre el histórico» antes de «Aplicar».

## «Se cayó la sincronización»

1. `/admin/sync`: el último error dice qué plataforma y por qué.
2. Errores de credenciales de Meta → el token caducó. Reconecta Meta en
   Ajustes → cliente. Los tokens se renuevan solos a diario; si falla varias
   veces seguidas, el token fue revocado.
3. Una API caída no borra datos: el worker preserva lo que ya había y avisa en la
   campana (una vez cada pocas horas, no en cada intento).
4. Para relanzar un rango: botón de sincronizar en el dashboard del cliente, o el
   agente con `trigger_sync`.

## «Alerta: cuenta de Meta sin poder publicar»

Meta paró la cuenta (pago rechazado, saldo pendiente o inhabilitada). El aviso
llega a la campana y al grupo de WhatsApp del equipo una vez al día como mucho.

- Revisa el pago en el Administrador de anuncios de Meta.
- Tras pagar, la alerta desaparece de `/admin/salud` en la siguiente
  sincronización.

## «El ROAS de Hotmart no tiene sentido»

- Revisa la **moneda de reporte** del cliente (ficha del cliente): tiene que ser la
  de su cuenta de Meta. Hotmart se convierte a esa moneda con la tasa del día de
  cada venta.
- Si la venta es anterior a julio de 2026 y la moneda no es USD, puede faltar la
  tasa de ese día: `npx tsx --conditions=react-server scripts/backfill-fx-historico.ts --desde=2026-01-01 --monedas=CLP`
  (simula; añade `--apply` para guardar).

## «La venta que se cerró en GoHighLevel no aparece»

1. En GHL, el Workflow de venta (Opportunity Won → Webhook) tiene que estar
   **publicado** y apuntar a `/api/report-utm/webhooks/ghl/venta/{id-del-cliente}`
   con el header `X-Rutm-Ghl-Token`.
2. La oportunidad tiene que estar en estado **won** (o el Workflow filtrar por la
   etapa de venta).
3. Aparece en `/ventas` y, en el dashboard, como `crm_ventas`.

## «Borré un cliente y sigue apareciendo»

Ya no debería pasar. Borrar en Ajustes o en Report-UTM lo borra en los dos lados
**con todos sus datos** (regla del 2026-09-14), y el diálogo de confirmación dice
antes qué se pierde: métricas, leads, ventas, Hotmart, bitácoras, informes BI,
pestañas, integraciones, notificaciones, mensajes de WhatsApp y canales,
conversaciones y propuestas pendientes del agente. No se puede deshacer; para
ocultar sin perder nada, **archiva**.

Lo hace `eliminarClienteCompleto` (`src/lib/clientes/ciclo-de-vida.ts`):

- **Base de datos:** las FK en cascada (migraciones 080 y 081) borran todo lo que
  cuelga del cliente, también si alguien lo borra por SQL o desde el panel de
  Supabase. `npm run test:datos` lo vigila en el catálogo real
  (`verify-borrado-cascada.ts`).
- **Lo que ninguna FK alcanza** lo borra el código: las propuestas pendientes y
  las conversaciones de sus grupos del agente, su id en el alcance de los
  contactos del agente, y las imágenes de sus bitácoras y sus logos en Storage.
- **Se desconecta solo:** la suscripción de sus Páginas de Meta al webhook de
  leads y sus grupos de WhatsApp (salvo que otro cliente use la misma Página o el
  mismo grupo).
- **Hay que hacerlo a mano** (el diálogo lo lista según lo que tenga conectado):
  desactivar los workflows de GoHighLevel, quitar el webhook de Hotmart, retirar
  el píxel o el plugin de WordPress de su sitio y sacar el bot de sus grupos de
  WhatsApp. Si no, siguen enviando y reciben error.
- **Se conserva a propósito:** el registro de auditoría del agente
  (`agent_audit_log`, quién hizo qué) y los accesos de Meta, Google y Hotmart en
  el proveedor, que son de la agencia y los comparten otros clientes.

Si al borrar sale un aviso (Storage o Meta no respondieron), el cliente ya está
borrado. Lo que quedó en Storage se limpia con:

```bash
npx tsx scripts/limpiar-storage-huerfano.ts            # lista, no borra
npx tsx scripts/limpiar-storage-huerfano.ts --apply
```

Si ves clientes «Sin enlace» (huérfanos de antes de la regla):

```bash
npx tsx scripts/borrar-clientes-huerfanos.ts                        # lista y cuenta, no borra
npx tsx scripts/borrar-clientes-huerfanos.ts --ids=<uuid>,<uuid> --apply
```

O uno a uno con «Eliminar» en `/admin/settings`.

## «No me deja eliminar un usuario»

Si es dueño de clientes, no: borrar un usuario nunca borra clientes (migración
081; antes se los llevaba con todos sus datos). En `/admin/users` aparece la lista
de sus clientes y un selector para pasarlos a otro usuario; al confirmar, se
pasan y el usuario se elimina.

---

## Pedir ayuda con el contexto justo

El código está en GitHub. Para que otra persona (o un asistente) lo resuelva
rápido, pásale:

1. **Qué ves**: la pantalla, el cliente y el rango de fechas.
2. **Qué dice el diagnóstico**: captura de `/admin/salud` y de `/admin/sync`.
3. **Qué documento aplica**: este runbook enlaza el doc de cada tema.

Comprobaciones que puede correr quien toque el código:

```bash
npm run validate     # tipos + lint + formato
npm run test:puro    # reglas, sin base de datos
npm run test:datos   # contra datos reales
```

Documentación por tema: [18 · Fuentes y cruces](./18-fuentes-y-cruces.md) ·
[20 · GoHighLevel](./20-integracion-gohighlevel.md) ·
[21 · Auditoría de UTMs](./21-auditoria-utms-ghl.md) ·
[22 · Plantilla de agente](./22-plantilla-agente-interno.md).
