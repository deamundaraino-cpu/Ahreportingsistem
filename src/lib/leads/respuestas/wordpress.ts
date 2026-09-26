// `fields_meta` del plugin de WordPress (0.4.0) → preguntas de `lead_preguntas`.
//
// El plugin manda con cada lead el tipo y las opciones de sus desplegables,
// casillas y radios, con la MISMA clave con la que el valor viaja en
// `raw_fields`. Aquí se valida (llega de fuera: viene firmado, pero es de un
// sitio que no controlamos) y se convierte. Puro, para poder comprobarlo.

import type { PreguntaPlataforma, TipoPlataforma } from './preguntas-db';

const MAX_CAMPOS = 50;
const MAX_OPCIONES = 200;
const MAX_TEXTO = 300;

function texto(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, MAX_TEXTO).trim() : '';
}

/**
 * null si `fields_meta` no es un objeto utilizable. Ignora lo que no entiende en
 * vez de rechazar el lead entero: el lead ya se guardó y esto es un extra.
 */
export function preguntasDeFieldsMeta(
  fieldsMeta: unknown,
  form: { form_id?: string | null; form_name?: string | null }
): PreguntaPlataforma[] | null {
  if (!fieldsMeta || typeof fieldsMeta !== 'object' || Array.isArray(fieldsMeta)) return null;
  const out: PreguntaPlataforma[] = [];
  for (const [clave, meta] of Object.entries(fieldsMeta as Record<string, unknown>).slice(
    0,
    MAX_CAMPOS
  )) {
    if (!clave || !meta || typeof meta !== 'object') continue;
    const m = meta as { type?: unknown; multiple?: unknown; options?: unknown };
    const opciones = (Array.isArray(m.options) ? m.options : [])
      .slice(0, MAX_OPCIONES)
      .map((o) => {
        const oo = (o ?? {}) as { value?: unknown; label?: unknown };
        const valor = texto(oo.value) || texto(oo.label);
        return valor ? { valor, etiqueta: texto(oo.label) || null } : null;
      })
      .filter((o): o is { valor: string; etiqueta: string | null } => o !== null);
    if (opciones.length === 0) continue;
    const tipo: TipoPlataforma = m.multiple === true ? 'multiple' : 'opcion';
    out.push({
      form_id: form.form_id ?? '',
      form_name: form.form_name ?? null,
      clave_origen: clave.slice(0, MAX_TEXTO),
      etiqueta: clave.slice(0, MAX_TEXTO),
      tipo,
      opciones,
    });
  }
  return out;
}
