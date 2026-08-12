# Runbook — aplicar la migración 069

Estado detectado el **2026-08-12**: el código de `google-sheets-conversiones.ts`
que llama a las RPC de 069 está desplegado, pero **069 no está aplicada** en
producción (`dfdeizrbkpdocgckqlel`). Ninguna de sus 5 funciones, 2 índices ni 3
columnas existe en la base.

Consecuencia: cada escritura de Sheets falla con
`Could not find the function public.conversiones_offline_upsert_lote(...)`, el
worker lo atrapa por cliente y la cola queda verde. `conversiones_offline` y
`sheet_filas` están congeladas desde el **2026-08-11 00:21 UTC**.

Esto es exactamente el paso 2 del orden que documenta la cabecera de 069
("1. desplegar el código nuevo · 2. aplicar esta migración"). El paso 1 ya está
hecho.

---

## 1. Pre-vuelo

Verificado el 2026-08-12; repetir por si la base cambió desde entonces.

```sql
select 'sheet_filas filas'            k, count(*)::text v from public.sheet_filas
union all select 'claves distintas',    count(distinct (cliente_id, sheet_id, tab_name, fila_num))::text from public.sheet_filas
union all select 'fila_num NULL',       count(*) filter (where fila_num is null)::text from public.sheet_filas;
```

Debe cumplirse **filas == claves distintas** (si no, `uq_sheet_filas_fila` no se
puede crear). Última medición: `25863 / 25863 / 0`. ✅

## 2. Aplicar

Pegar íntegro `migrations/069_sheets_sync_incremental.sql` en el SQL editor de
Supabase. Es idempotente (`IF NOT EXISTS` / `CREATE OR REPLACE`), así que se
puede reejecutar sin daño.

## 3. Post-vuelo

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('sheet_filas_upsert_lote', 'conversiones_offline_upsert_lote',
                    'sheet_filas_podar_tab', 'conversiones_offline_podar_tab',
                    'sheet_podar_tabs');
```

Deben salir **5 filas**.

## 4. Forzar un sync y comprobar que escribe

Desde /admin/sync, o encolando a mano:

```bash
curl -X POST "$APP_URL/api/worker/enqueue" \
  -H "Authorization: Bearer $CRON_SECRET" -H 'Content-Type: application/json' \
  -d '{"tipo":"sheets_conversiones","cliente_id":"<UUID>","prioridad":1,"triggered_by":"runbook_069"}'
curl -X POST "$APP_URL/api/worker/run-jobs" -H "Authorization: Bearer $CRON_SECRET"
```

Y confirmar que el dato se movió:

```sql
select c.nombre, count(*) filas, max(o.fecha) ultima_fecha, max(o.created_at) ultima_escritura
from public.conversiones_offline o join public.clientes c on c.id = o.cliente_id
group by 1 order by 1;

select c.nombre, l.status, l.rows_ok, left(coalesce(l.detalle->>'error',''), 120) err, l.run_at
from public.conversiones_offline_sync_log l join public.clientes c on c.id = l.cliente_id
order by l.run_at desc limit 10;
```

`status` debe ser `ok`/`partial`, **nunca** `error` por función inexistente.

## Qué esperar en el PRIMER sync (una sola vez)

`conversiones_offline` no tenía `fila_num`: al añadirla, sus 25.863 filas quedan
a NULL y por tanto **fuera** del índice único parcial. El primer upsert las
inserta de nuevo con su `fila_num` y acto seguido
`conversiones_offline_podar_tab` retira las de `fila_num IS NULL` (la poda las
incluye a propósito). Es decir:

- pico transitorio de ~52.000 filas en `conversiones_offline`, luego vuelve a ~25.863;
- `sheet_filas` **no** sufre esto — ya tenía `fila_num` poblado, así que entra
  por UPSERT directo y la mayoría de sus filas no se reescriben.

A partir del segundo sync, un Sheet sin cambios escribe **cero filas**, que es el
objetivo de la migración.

## Rollback

En la cabecera de `069_sheets_sync_incremental.sql`. Ojo: revertir la base sin
revertir también el código deja el sync roto igual que ahora.
