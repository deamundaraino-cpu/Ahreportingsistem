/**
 * Cierre ordenado de un script de verificación.
 *
 * `process.exit()` mata el proceso con los handles del cliente de Supabase aún
 * abiertos. Con Node 24 en Windows eso dispara una aserción de libuv
 * (`UV_HANDLE_CLOSING`, async.c:76): el script imprimía «TODO OK» y acto seguido
 * moría con 127. En `test:datos`, que encadena doce scripts con `&&`, eso
 * cortaba la suite en un punto distinto cada vez y la hacía parecer rota cuando
 * todas sus comprobaciones habían pasado.
 *
 * Fijar `exitCode` y dejar que Node cierre solo da el mismo resultado (0 si
 * pasa, 1 si falla) con un cierre limpio. El `unref()` no impide salir antes:
 * solo cubre el caso de un handle que se quede colgado y evita que un script
 * se cuelgue para siempre en vez de terminar.
 *
 * Las salidas tempranas por error de entorno siguen usando `process.exit(1)`
 * directamente: ahí sí hace falta cortar en seco, y todavía no hay handles.
 */
export function salir(fallos: number): void {
  process.exitCode = fallos === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();
}
