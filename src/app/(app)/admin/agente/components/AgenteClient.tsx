'use client';

import { useState } from 'react';
import { MessageSquare, Target, Smartphone, AlertTriangle } from 'lucide-react';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ConsolaChat } from './ConsolaChat';
import { EstrategiasManager } from './EstrategiasManager';
import { CanalesWhatsApp } from './CanalesWhatsApp';
import type {
  ConversacionResumen,
  EstrategiaTipoRow,
  CanalRow,
  ContactoConIdentidades,
  RemitenteVisto,
  EstadoAgente,
} from '../_actions';

type Props = {
  esAdmin: boolean;
  conversacionesIniciales: ConversacionResumen[];
  estrategiasIniciales: EstrategiaTipoRow[];
  canalesIniciales: CanalRow[];
  contactosIniciales: ContactoConIdentidades[];
  remitentesIniciales: RemitenteVisto[];
  estado: EstadoAgente;
  politica: Record<string, unknown>;
  clientes: { id: string; nombre: string }[];
  usuarios: { id: string; role: string; full_name: string | null }[];
};

/**
 * Aviso de configuración incompleta.
 *
 * Sin la clave del modelo la consola no puede responder, y un error genérico en
 * mitad de una conversación no dice a nadie qué hay que hacer. Mejor decirlo
 * antes de que lo intenten.
 */
function AvisosDeConfiguracion({ estado }: { estado: EstadoAgente }) {
  const avisos: string[] = [];

  if (!estado.tieneClaveLlm) {
    avisos.push(
      'Falta OPENROUTER_API_KEY: el agente no puede responder. Las herramientas y el servidor MCP siguen funcionando.'
    );
  }
  if (!estado.tieneSecretoEntrante) {
    avisos.push(
      'Falta AGENT_INBOUND_SECRET: WhatsApp no puede entregar mensajes. Debe tener el mismo valor aquí y en el gateway.'
    );
  }
  // Si los turnos se acumulan y no bajan, nadie está procesando la cola. Es el
  // fallo más probable al abrir WhatsApp y desde fuera parece que está muerto.
  if (estado.turnosPendientes > 3) {
    avisos.push(
      `Hay ${estado.turnosPendientes} turnos esperando. Si el número no baja, el proceso que consume la cola no está corriendo en el servidor.`
    );
  }
  if (estado.turnosConError > 0) {
    avisos.push(`${estado.turnosConError} turno(s) terminaron con error.`);
  }

  if (avisos.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            Configuración pendiente
          </p>
          <ul className="text-muted-foreground space-y-1 text-sm">
            {avisos.map((a) => (
              <li key={a}>· {a}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function AgenteClient({
  esAdmin,
  conversacionesIniciales,
  estrategiasIniciales,
  canalesIniciales,
  contactosIniciales,
  remitentesIniciales,
  estado,
  politica,
  clientes,
  usuarios,
}: Props) {
  const [tab, setTab] = useState('chat');

  return (
    <div className="space-y-4">
      <AvisosDeConfiguracion estado={estado} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-muted/80">
          <TabsTrigger
            value="chat"
            className="data-[state=active]:bg-card flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
          >
            <MessageSquare className="h-4 w-4 text-emerald-500" />
            Chat
          </TabsTrigger>
          <TabsTrigger
            value="estrategias"
            className="data-[state=active]:bg-card flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
          >
            <Target className="h-4 w-4 text-indigo-500" />
            Estrategias
          </TabsTrigger>
          {esAdmin && (
            <TabsTrigger
              value="whatsapp"
              className="data-[state=active]:bg-card flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
            >
              <Smartphone className="h-4 w-4 text-violet-500" />
              WhatsApp
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="chat" className="mt-4 outline-none">
          <ConsolaChat
            conversacionesIniciales={conversacionesIniciales}
            clientes={clientes}
            puedeResponder={estado.tieneClaveLlm}
          />
        </TabsContent>

        <TabsContent value="estrategias" className="mt-4 outline-none">
          <EstrategiasManager iniciales={estrategiasIniciales} soloLectura={!esAdmin} />
        </TabsContent>

        {esAdmin && (
          <TabsContent value="whatsapp" className="mt-4 outline-none">
            <CanalesWhatsApp
              canalesIniciales={canalesIniciales}
              contactosIniciales={contactosIniciales}
              remitentesIniciales={remitentesIniciales}
              clientes={clientes}
              usuarios={usuarios}
              politica={politica}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
