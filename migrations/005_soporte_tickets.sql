-- 005_soporte_tickets.sql
-- New table for Ads House Support Tickets

CREATE TABLE public.soporte_tickets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  id_serial SERIAL, -- Automatic serial number
  id_ticket_display TEXT, -- Formatted string like #1001
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE CASCADE NOT NULL,
  nombre_solicitante TEXT NOT NULL,
  fecha_solicitud TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  requerimiento TEXT NOT NULL,
  observaciones TEXT,
  responsable TEXT,
  fecha_entrega DATE,
  prioridad INTEGER DEFAULT 3 CHECK (prioridad IN (1, 2, 3)), -- 1: High, 2: Medium, 3: Low
  estado TEXT DEFAULT 'abierto' CHECK (estado IN ('abierto', 'en_progreso', 'completado', 'cancelado')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Trigger to set id_ticket_display automatically
CREATE OR REPLACE FUNCTION set_ticket_display_id()
RETURNS TRIGGER AS $$
BEGIN
  -- We use 1000 as base so it starts at #1001
  NEW.id_ticket_display := '#' || (NEW.id_serial + 1000);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_ticket_display_id
BEFORE INSERT ON public.soporte_tickets
FOR EACH ROW EXECUTE FUNCTION set_ticket_display_id();

-- RLS
ALTER TABLE public.soporte_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clients can view their own tickets"
ON public.soporte_tickets
FOR SELECT USING (
  cliente_id IN (
    SELECT id FROM public.clientes WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Clients can create their own tickets"
ON public.soporte_tickets
FOR INSERT WITH CHECK (
  cliente_id IN (
    SELECT id FROM public.clientes WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Admin full access tickets"
ON public.soporte_tickets
FOR ALL USING (auth.jwt() ->> 'email' = 'robinson@adshouse.com');
