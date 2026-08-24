'use client';

import { useState, useTransition } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { disconnectGoogle } from '../_actions';

interface Props {
  connected: boolean;
  email: string | null;
}

// Panel a nivel agencia para conectar UNA cuenta de Google (Analytics + Sheets)
// vía OAuth. Una sola conexión sirve para todos los clientes.
export function GoogleConnectionCard({ connected, email }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleDisconnect = () => {
    if (
      !confirm(
        '¿Desconectar la cuenta de Google de la agencia? Los clientes dejarán de sincronizar GA4/Sheets por OAuth.'
      )
    )
      return;
    startTransition(async () => {
      const res = await disconnectGoogle();
      if (res?.error) setError(res.error);
    });
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground text-lg">
          <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden>
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
            />
          </svg>
          Conexión Google (Analytics + Sheets)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          Conecta <span className="text-foreground">una sola cuenta de Google de la agencia</span>{' '}
          con acceso a todas las propiedades de GA4 y a los Sheets de tus clientes. Una vez
          conectada, dar de alta un cliente solo requiere su{' '}
          <span className="text-foreground">ID de propiedad GA4</span> y la{' '}
          <span className="text-foreground">URL del Sheet</span> — sin subir JSON ni compartir
          credenciales por cliente.
        </p>

        {connected ? (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-muted/60 p-3 rounded">
            <div className="text-sm">
              <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                ● Conectado
              </span>
              {email && <span className="text-muted-foreground ml-2">como {email}</span>}
            </div>
            <div className="flex gap-2">
              <a href="/api/auth/google">
                <Button variant="outline" size="sm" disabled={isPending}>
                  Reconectar
                </Button>
              </a>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDisconnect}
                disabled={isPending}
              >
                {isPending ? 'Desconectando…' : 'Desconectar'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 bg-muted/60 p-3 rounded">
            <span className="text-amber-600 dark:text-amber-400 text-sm font-medium">
              ● No conectado
            </span>
            <a href="/api/auth/google">
              <Button size="sm">Conectar con Google</Button>
            </a>
          </div>
        )}

        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      </CardContent>
    </Card>
  );
}
