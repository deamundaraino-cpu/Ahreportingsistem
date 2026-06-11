# WhatsApp Gateway (Baileys)

Microservicio Node persistente que mantiene la conexión con WhatsApp y expone una
API REST para la app Next.js. **No corre en Vercel** (necesita un proceso de larga
duración con WebSocket vivo). Desplegar en Railway / Render / Fly / VPS.

## Por qué existe

La app principal está en Vercel (serverless): funciones efímeras, sin filesystem
persistente, máx. 300s. Baileys necesita lo contrario. Este gateway aísla todo el
estado de WhatsApp; la app solo lo llama por HTTP con un Bearer compartido.

## Setup local

```bash
cd whatsapp-gateway
npm install
cp .env.example .env   # completar valores
npm run dev
```

Al arrancar sin sesión previa, hacé `GET /qr` (con el header Bearer) y escaneá el
dataURL con el WhatsApp del **número de la agencia**. La sesión se persiste en
Supabase (`public.whatsapp_session`), así sobrevive reinicios/redeploys.

## API

Todas requieren `Authorization: Bearer $WHATSAPP_GATEWAY_API_KEY` (salvo `/health`).

| Método | Ruta      | Descripción |
|--------|-----------|-------------|
| GET    | `/health` | Health-check sin auth |
| GET    | `/status` | `{ connected, me, lastSeen }` |
| GET    | `/qr`     | `{ qr, connected }` — `qr` es dataURL para emparejar |
| GET    | `/groups` | `{ groups: [{ id, name }] }` — grupos donde está la cuenta |
| POST   | `/send`   | body `{ groupId, message }` → `{ messageId }` |

## Variables de entorno

Ver `.env.example`. En producción setearlas en el panel del host.
`WHATSAPP_GATEWAY_API_KEY` debe coincidir con el de Vercel.

## Despliegue (Railway/Render)

- Build: `npm install && npm run build`
- Start: `npm start`
- Exponer el puerto `$PORT`. Copiar la URL pública a `WHATSAPP_GATEWAY_URL` en Vercel.

## Notas anti-baneo

- Usar un **número dedicado** de la agencia (no el personal).
- Los envíos se serializan con un throttle (`WHATSAPP_SEND_THROTTLE_MS`).
- Solo se puede enviar a grupos donde la cuenta ya es miembro.
- Baileys es no oficial: mantener la dependencia actualizada.
