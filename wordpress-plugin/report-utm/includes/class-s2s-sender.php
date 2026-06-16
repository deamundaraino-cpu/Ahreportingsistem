<?php
/**
 * ReportUTM_S2S_Sender — Cliente HTTP para el endpoint S2S de la plataforma.
 *
 * ────────────────────────────────────────────────────────────────────
 *  QUÉ HACE
 * ────────────────────────────────────────────────────────────────────
 *  Envía eventos al endpoint Report UTM server-to-server usando
 *  wp_remote_post (no requiere cURL directamente).
 *
 *  Cada envío es:
 *    1. No bloqueante (blocking: false) — el servidor PHP no espera
 *       la respuesta, la página carga sin retraso.
 *    2. Firmado con HMAC-SHA256 para que la plataforma verifique
 *       que el envío proviene de este servidor.
 *
 * ────────────────────────────────────────────────────────────────────
 *  PROTOCOLO DE AUTENTICACIÓN
 * ────────────────────────────────────────────────────────────────────
 *
 *  La firma se calcula sobre el body JSON completo:
 *
 *    $firma = hash_hmac('sha256', $json_body, $s2s_token);
 *
 *  Y se envía en el header:
 *
 *    X-Rutm-S2S-Signature: <firma_hex>
 *
 *  La plataforma recibe el body crudo, calcula la misma firma con el
 *  mismo token (almacenado en la base de datos) y rechaza la request
 *  con HTTP 401 si no coincide.
 *
 * ────────────────────────────────────────────────────────────────────
 *  CAMPOS QUE SE ENVÍAN SIEMPRE (body base)
 * ────────────────────────────────────────────────────────────────────
 *
 *  cliente_slug — identifica la cuenta en la plataforma
 *  event_type   — tipo de evento ('lead' | 'pageview' | 'custom')
 *  visitor_id   — UUID de 90 días leído del cookie rutm_vid
 *                 (null si el visitante aún no pasó por el pixel JS)
 *  page_url     — URL de donde provino la request (HTTP_REFERER)
 *  ip           — IP real del visitante (respeta Cloudflare, proxies)
 *  user_agent   — navegador del visitante
 *
 *  Para event_type='lead' se añaden además:
 *  form_name    — nombre del formulario
 *  form_plugin  — 'elementor' | 'cf7' | 'gravity_forms' | 'wpforms'
 *  form_id      — ID del formulario en WordPress
 *  lead_name    — nombre del contacto (mapeado automáticamente)
 *  lead_email   — email del contacto
 *  lead_phone   — teléfono del contacto
 *  raw_fields   — TODOS los campos del formulario (objeto JSON)
 *
 * ────────────────────────────────────────────────────────────────────
 *  ENDPOINT DE LA PLATAFORMA
 * ────────────────────────────────────────────────────────────────────
 *
 *  URL:     POST https://reportes.adshouse.cloud/api/report-utm/pixel/s2s
 *  Headers: Content-Type: application/json
 *           X-Rutm-S2S-Signature: <hmac_sha256_hex>
 *
 *  Respuestas posibles:
 *    200 { ok: true }             — evento registrado correctamente
 *    400 { error: '...' }         — body inválido o cliente_slug vacío
 *    401 { error: 'Invalid sig' } — firma HMAC incorrecta
 *    403 { error: '...' }         — integración S2S inactiva o sin token
 *    404 { error: '...' }         — cliente_slug no encontrado
 *
 * ────────────────────────────────────────────────────────────────────
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class ReportUTM_S2S_Sender {

    private string $base_url;
    private string $cliente_slug;
    private string $s2s_token;

    /**
     * @param string $base_url      URL base de la plataforma (con trailing slash)
     * @param string $cliente_slug  Slug del cliente en la plataforma
     * @param string $s2s_token     Token secreto HMAC (obtenido en la plataforma)
     */
    public function __construct( string $base_url, string $cliente_slug, string $s2s_token ) {
        $this->base_url     = trailingslashit( $base_url );
        $this->cliente_slug = $cliente_slug;
        $this->s2s_token    = $s2s_token;
    }

    /**
     * Envía un evento al endpoint S2S (fire-and-forget, no bloqueante).
     *
     * Este es el método que usan los hooks de formulario: no espera la
     * respuesta del servidor para no retrasar la carga de la página.
     *
     * @param string $event_type  'lead' | 'pageview' | 'custom'
     * @param array  $extra       Campos específicos del evento:
     *                            Para lead: form_name, form_plugin, form_id,
     *                                       lead_name, lead_email, lead_phone, raw_fields
     * @return bool true si wp_remote_post no devolvió WP_Error al despachar
     */
    public function send( string $event_type, array $extra = [] ): bool {
        $response = $this->dispatch( $event_type, $extra, false );
        return ! is_wp_error( $response );
    }

    /**
     * Envía un evento de forma BLOQUEANTE y devuelve el resultado real.
     *
     * Usado por el botón "Enviar lead de prueba" del panel: a diferencia de
     * send(), espera la respuesta HTTP y reporta el código y el cuerpo, para
     * poder diagnosticar errores (404 slug inválido, 401 firma, 403 inactivo).
     *
     * @return array { ok: bool, code: int, message: string }
     */
    public function send_blocking( string $event_type, array $extra = [] ): array {
        $response = $this->dispatch( $event_type, $extra, true );

        if ( is_wp_error( $response ) ) {
            return [
                'ok'      => false,
                'code'    => 0,
                'message' => $response->get_error_message(),
            ];
        }

        $code = (int) wp_remote_retrieve_response_code( $response );
        $body = wp_remote_retrieve_body( $response );

        return [
            'ok'      => $code >= 200 && $code < 300,
            'code'    => $code,
            'message' => $body,
        ];
    }

    /**
     * Construye el body firmado y ejecuta el POST.
     *
     * @param bool $blocking true para esperar la respuesta (test); false
     *                       para fire-and-forget (envío normal de leads).
     * @return array|WP_Error Resultado crudo de wp_remote_post
     */
    private function dispatch( string $event_type, array $extra, bool $blocking ) {
        $body = array_merge( [
            'cliente_slug' => $this->cliente_slug,
            'event_type'   => $event_type,
            'visitor_id'   => $this->get_visitor_id(),
            'page_url'     => $this->get_referer(),
            'ip'           => $this->get_client_ip(),
            'user_agent'   => $this->get_user_agent(),
        ], $extra );

        // raw_fields debe ser un objeto JSON, no una cadena
        if ( isset( $body['raw_fields'] ) && ! is_array( $body['raw_fields'] ) ) {
            unset( $body['raw_fields'] );
        }

        $json = wp_json_encode( $body );
        $sig  = hash_hmac( 'sha256', $json, $this->s2s_token );

        return wp_remote_post(
            $this->base_url . 'api/report-utm/pixel/s2s',
            [
                'timeout'     => $blocking ? 15 : 5,
                'blocking'    => $blocking,
                'headers'     => [
                    'Content-Type'         => 'application/json',
                    'X-Rutm-S2S-Signature' => $sig,
                ],
                'body'        => $json,
                'data_format' => 'body',
            ]
        );
    }

    /**
     * Lee el visitor ID del cookie rutm_vid que inyecta el pixel JS.
     * Devuelve null si el visitante aún no pasó por una página con el pixel.
     * La plataforma puede cruzar este ID con eventos previos para la atribución.
     */
    private function get_visitor_id(): ?string {
        if ( isset( $_COOKIE['rutm_vid'] ) ) {
            return sanitize_text_field( wp_unslash( $_COOKIE['rutm_vid'] ) );
        }
        return null;
    }

    /**
     * URL de la página desde donde se envió el formulario.
     * Se usa HTTP_REFERER porque en el contexto del hook PHP, la request
     * actual es la de procesamiento del formulario, no la de la página.
     */
    private function get_referer(): ?string {
        if ( isset( $_SERVER['HTTP_REFERER'] ) ) {
            return esc_url_raw( wp_unslash( $_SERVER['HTTP_REFERER'] ) );
        }
        return null;
    }

    /**
     * Obtiene la IP real del visitante respetando el orden de prioridad:
     *   1. CF-Connecting-IP (Cloudflare)
     *   2. X-Forwarded-For (proxies / load balancers, primer IP)
     *   3. X-Real-IP (Nginx)
     *   4. REMOTE_ADDR (conexión directa)
     */
    private function get_client_ip(): ?string {
        $headers = [
            'HTTP_CF_CONNECTING_IP',
            'HTTP_X_FORWARDED_FOR',
            'HTTP_X_REAL_IP',
            'REMOTE_ADDR',
        ];
        foreach ( $headers as $h ) {
            if ( ! empty( $_SERVER[ $h ] ) ) {
                $raw = sanitize_text_field( wp_unslash( $_SERVER[ $h ] ) );
                $ip  = trim( explode( ',', $raw )[0] );
                if ( filter_var( $ip, FILTER_VALIDATE_IP ) ) return $ip;
            }
        }
        return null;
    }

    /** User agent del navegador del visitante */
    private function get_user_agent(): ?string {
        if ( isset( $_SERVER['HTTP_USER_AGENT'] ) ) {
            return sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) );
        }
        return null;
    }
}
