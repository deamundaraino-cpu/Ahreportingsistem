-- Migration 030: Sistema de Bitácoras por Cliente
-- Registro de cambios y notas con tres niveles de visibilidad:
--   privado    → solo admin y superadmin
--   trafficker → trafficker asignado + admin + superadmin
--   publico    → todos, incluyendo el enlace público /p/[token]

CREATE TABLE public.bitacoras (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID        NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    author_id   UUID        NOT NULL REFERENCES auth.users(id),
    author_name TEXT,
    titulo      TEXT        NOT NULL,
    contenido   TEXT        NOT NULL,
    visibilidad TEXT        NOT NULL DEFAULT 'trafficker'
                                CHECK (visibilidad IN ('privado', 'trafficker', 'publico')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

ALTER TABLE public.bitacoras ENABLE ROW LEVEL SECURITY;

-- Índice para cargas por cliente ordenadas por fecha
CREATE INDEX idx_bitacoras_cliente_fecha
    ON public.bitacoras(cliente_id, created_at DESC);

-- SELECT:
--   admin/superadmin: ven todas las entradas
--   trafficker: solo 'trafficker' y 'publico' de sus clientes asignados
CREATE POLICY "bitacoras_select" ON public.bitacoras
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM user_profiles p
            WHERE p.id = auth.uid()
            AND (
                p.role IN ('admin', 'superadmin')
                OR (
                    p.role = 'trafficker'
                    AND visibilidad IN ('trafficker', 'publico')
                    AND EXISTS (
                        SELECT 1 FROM user_client_assignments a
                        WHERE a.user_id = auth.uid()
                          AND a.client_id = bitacoras.cliente_id
                    )
                )
            )
        )
    );

-- INSERT: trafficker, admin, superadmin pueden crear entradas
CREATE POLICY "bitacoras_insert" ON public.bitacoras
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM user_profiles p
            WHERE p.id = auth.uid()
              AND p.role IN ('admin', 'superadmin', 'trafficker')
        )
    );

-- UPDATE: el autor puede editar sus propias; admins/superadmins pueden editar cualquiera
CREATE POLICY "bitacoras_update" ON public.bitacoras
    FOR UPDATE USING (
        author_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM user_profiles p
            WHERE p.id = auth.uid()
              AND p.role IN ('admin', 'superadmin')
        )
    );

-- DELETE: igual que update
CREATE POLICY "bitacoras_delete" ON public.bitacoras
    FOR DELETE USING (
        author_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM user_profiles p
            WHERE p.id = auth.uid()
              AND p.role IN ('admin', 'superadmin')
        )
    );
