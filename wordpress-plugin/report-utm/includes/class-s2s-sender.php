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
 *    1. Bloqueante con timeout corto (3 s). Hasta la 0.4.0 era
 *       fire-and-forget (blocking: false): si la plataforma estaba caída
 *       o respondía 500, el lead se perdía sin dejar rastro, porque nadie
 *       miraba la respuesta. Ahora se mira.
 *    2. Reintentado desde WP-Cron si falla (error de red, 408, 429 o 5xx):
 *       hasta 3 reintentos a 1, 5 y 15 minutos, con el MISMO body. Un 4xx
 *       (firma, slug, integración inactiva) no se reintenta: repetir la
 *       misma petición daría el mismo error.
 *    3. Idempotente: cada lead lleva un `external_id` calculado al primer
 *       intento y que viaja igual en los reintentos. La plataforma rechaza
 *       la segunda copia (índice único) y responde 200 { duplicate: true }.
 *    4. Firmado con HMAC-SHA256 para que la plataforma verifique
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
 *  ip           — IP real del visitante: la primera PÚBLICA de Cloudflare,
 *                 X-Forwarded-For, X-Real-IP o REMOTE_ADDR. La plataforma
 *                 la usa en vez de la de este servidor.
 *  visitor_country — país del visitante si el sitio está detrás de
 *                 Cloudflare (CF-IPCountry); si no, no se envía.
 *  user_agent   — navegador del visitante
 *  first_touch  — cookie rutm_ft del pixel JS (primer anuncio), si existe
 *  last_touch   — cookie rutm_lt del pixel JS (último anuncio), si existe.
 *                 La plataforma la usa cuando la URL del formulario no trae
 *                 UTMs (página de gracias, popup en otra URL…).
 *
 *  Para event_type='lead' se añaden además:
 *  external_id  — 's2s:<hash>' para que un reintento no duplique el lead
 *                 (ver build_external_id)
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
 *    200 { ok: true, duplicate }  — ese external_id ya estaba (reintento)
 *    400 { error: '...' }         — body inválido o cliente_slug vacío
 *    401 { error: 'Invalid sig' } — firma HMAC incorrecta
 *    403 { error: '...' }         — integración S2S inactiva o sin token
 *    404 { error: '...' }         — cliente_slug no encontrado
 *
 * ────────────────────────────────────────────────────────────────────
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class ReportUTM_S2S_Sender {

    /** Hook de WP-Cron que reintenta un envío fallido. */
    const RETRY_HOOK = 'rutm_s2s_retry';

    /**
     * Espera antes de cada reintento, en segundos: 1, 5 y 15 minutos. Tres
     * reintentos cubren un deploy o un reinicio de la plataforma (minutos) sin
     * dejar leads dando vueltas en el cron durante horas.
     */
    const RETRY_DELAYS = [ 60, 300, 900 ];

    /** Timeout del envío normal: lo que puede tardar de más el formulario. */
    const TIMEOUT_FORM = 3;

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
     * Registra el handler de reintentos. Se llama siempre al cargar el plugin
     * (no solo cuando hay formularios): WP-Cron corre en cualquier petición y
     * el hook tiene que existir para que el reintento no se descarte.
     */
    public static function register_retry_hook(): void {
        add_action( self::RETRY_HOOK, [ __CLASS__, 'handle_retry' ], 10, 2 );
    }

    /**
     * Envía un evento al endpoint S2S y, si falla, agenda un reintento.
     *
     * Es el método que usan los hooks de formulario. Espera la respuesta como
     * mucho TIMEOUT_FORM segundos: es lo que cuesta saber si el lead llegó. Si
     * no llegó, el reintento va por WP-Cron y el visitante no espera más.
     *
     * @param string $event_type  'lead' | 'pageview' | 'custom'
     * @param array  $extra       Campos específicos del evento:
     *                            Para lead: form_name, form_plugin, form_id,
     *                                       lead_name, lead_email, lead_phone, raw_fields
     * @return bool true si la plataforma respondió 2xx al primer intento
     */
    public function send( string $event_type, array $extra = [] ): bool {
        $json     = $this->build_json( $event_type, $extra );
        $response = $this->post( $json, self::TIMEOUT_FORM );
        if ( self::delivered( $response ) ) return true;

        if ( self::retriable( $response ) ) {
            self::schedule_retry( $json, 1 );
        }
        return false;
    }

    /**
     * Envía un evento de forma BLOQUEANTE y devuelve el resultado real.
     *
     * Usado por el botón "Enviar lead de prueba" del panel: reporta el código
     * y el cuerpo, para poder diagnosticar errores (404 slug inválido, 401
     * firma, 403 inactivo). No reintenta: quien lo pulsa está mirando.
     *
     * @return array { ok: bool, code: int, message: string }
     */
    public function send_blocking( string $event_type, array $extra = [] ): array {
        $response = $this->post( $this->build_json( $event_type, $extra ), 15 );

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
     * Handler de WP-Cron: reenvía el MISMO body (mismo external_id) y, si
     * vuelve a fallar, agenda el siguiente intento hasta agotar RETRY_DELAYS.
     *
     * La firma se calcula al reenviar, con el token vigente: si alguien lo rotó
     * entre medias, el reintento sale con el nuevo. Si el plugin se desactivó
     * o se quitó el token, el reintento se descarta.
     *
     * @param string $json    Body JSON tal como salió en el primer intento
     * @param int    $attempt Número de este reintento (1..count(RETRY_DELAYS))
     */
    public static function handle_retry( $json, $attempt ): void {
        $options = get_option( 'rutm_options', [] );
        if ( empty( $options['enabled'] ) || empty( $options['s2s_token'] ) ) return;
        if ( ! is_string( $json ) || $json === '' ) return;

        $data = json_decode( $json, true );
        if ( ! is_array( $data ) || empty( $data['cliente_slug'] ) ) return;

        $base_url = ! empty( $options['base_url'] ) ? $options['base_url'] : RUTM_PLATFORM;
        $sender   = new self( $base_url, (string) $data['cliente_slug'], $options['s2s_token'] );
        $response = $sender->post( $json, 10 );
        if ( self::delivered( $response ) ) return;

        $attempt = (int) $attempt;
        if ( self::retriable( $response ) && $attempt < count( self::RETRY_DELAYS ) ) {
            self::schedule_retry( $json, $attempt + 1 );
        } elseif ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
            error_log( '[report-utm] lead S2S descartado tras ' . $attempt . ' reintentos: '
                . ( is_wp_error( $response )
                    ? $response->get_error_message()
                    : 'HTTP ' . wp_remote_retrieve_response_code( $response ) ) );
        }
    }

    /**
     * Agenda el reintento número $attempt. El body viaja en los args del evento
     * (se guardan en la opción `cron` de WordPress hasta que se ejecuta): es la
     * única forma de reenviar exactamente lo mismo sin una tabla propia.
     */
    private static function schedule_retry( string $json, int $attempt ): void {
        $delay = self::RETRY_DELAYS[ $attempt - 1 ] ?? null;
        if ( $delay === null ) return;
        wp_schedule_single_event( time() + $delay, self::RETRY_HOOK, [ $json, $attempt ] );
    }

    /** ¿La plataforma aceptó el evento? (2xx, incluido el duplicado) */
    private static function delivered( $response ): bool {
        if ( is_wp_error( $response ) ) return false;
        $code = (int) wp_remote_retrieve_response_code( $response );
        return $code >= 200 && $code < 300;
    }

    /**
     * ¿Tiene sentido reintentar? Sí ante un error de red o un fallo pasajero
     * de la plataforma (408, 429, 5xx). No ante el resto de 4xx: firma, slug o
     * integración inactiva no se arreglan repitiendo la misma petición.
     */
    private static function retriable( $response ): bool {
        if ( is_wp_error( $response ) ) return true;
        $code = (int) wp_remote_retrieve_response_code( $response );
        return $code === 0 || $code === 408 || $code === 429 || $code >= 500;
    }

    /**
     * Construye el body JSON del evento. Se construye UNA vez: los reintentos
     * reenvían esta misma cadena, así que el external_id no cambia.
     */
    private function build_json( string $event_type, array $extra ): string {
        $body = array_merge( [
            'cliente_slug' => $this->cliente_slug,
            'event_type'   => $event_type,
            'visitor_id'   => $this->get_visitor_id(),
            'page_url'     => $this->get_referer(),
            'ip'           => $this->get_client_ip(),
            'user_agent'   => $this->get_user_agent(),
        ], $extra );

        $country = $this->get_visitor_country();
        if ( $country !== null && ! isset( $body['visitor_country'] ) ) {
            $body['visitor_country'] = $country;
        }

        // Cookies de toque del pixel JS: la plataforma usa el último toque si la
        // URL del formulario no trae UTMs.
        $ft = $this->get_touch_cookie( 'rutm_ft' );
        if ( $ft !== null && ! isset( $body['first_touch'] ) ) $body['first_touch'] = $ft;
        $lt = $this->get_touch_cookie( 'rutm_lt' );
        if ( $lt !== null && ! isset( $body['last_touch'] ) ) $body['last_touch'] = $lt;

        if ( $event_type === 'lead' && empty( $body['external_id'] ) ) {
            $body['external_id'] = self::build_external_id( $body );
        }

        // raw_fields debe ser un objeto JSON, no una cadena
        if ( isset( $body['raw_fields'] ) && ! is_array( $body['raw_fields'] ) ) {
            unset( $body['raw_fields'] );
        }

        return (string) wp_json_encode( $body );
    }

    /**
     * Firma y ejecuta el POST.
     *
     * @return array|WP_Error Resultado crudo de wp_remote_post
     */
    private function post( string $json, int $timeout ) {
        $sig = hash_hmac( 'sha256', $json, $this->s2s_token );

        return wp_remote_post(
            $this->base_url . 'api/report-utm/pixel/s2s',
            [
                'timeout'     => $timeout,
                'blocking'    => true,
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
     * external_id del lead: 's2s:' + 32 hex.
     *
     * Con email o teléfono es determinista: sha256 de
     * "<form_id o form_name>|<e:email | t:últimos 9 dígitos>|<minuto UTC>",
     * el mismo cálculo que hace la plataforma (externalIdS2S en
     * src/lib/report-utm/s2s-captura.ts) cuando un plugin viejo no lo manda.
     * Un doble clic en "Enviar" cae en el mismo minuto y no duplica.
     *
     * Sin contacto no hay nada estable que hashear: se usa uno aleatorio, que
     * igual hace idempotente el reintento porque viaja dentro del body.
     */
    private static function build_external_id( array $body ): string {
        $form = '';
        if ( isset( $body['form_id'] ) && trim( (string) $body['form_id'] ) !== '' ) {
            $form = trim( (string) $body['form_id'] );
        } elseif ( isset( $body['form_name'] ) && trim( (string) $body['form_name'] ) !== '' ) {
            $form = trim( (string) $body['form_name'] );
        }

        $contacto = null;
        $email    = strtolower( trim( (string) ( $body['lead_email'] ?? '' ) ) );
        if ( strpos( $email, '@' ) !== false && strlen( $email ) >= 3 ) {
            $contacto = 'e:' . $email;
        } else {
            $digitos = preg_replace( '/\D/', '', (string) ( $body['lead_phone'] ?? '' ) );
            if ( strlen( $digitos ) >= 7 ) $contacto = 't:' . substr( $digitos, -9 );
        }

        if ( $contacto === null ) {
            return 's2s:' . str_replace( '-', '', wp_generate_uuid4() );
        }
        $minuto = gmdate( 'Y-m-d\TH:i' );
        return 's2s:' . substr( hash( 'sha256', $form . '|' . $contacto . '|' . $minuto ), 0, 32 );
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
     * Cookie de toque del pixel (rutm_ft / rutm_lt) como array limpio, o null.
     *
     * El pixel la escribe con encodeURIComponent(JSON) y PHP ya la entrega
     * decodificada en $_COOKIE. Solo pasan las claves que escribe el pixel,
     * como texto y recortadas: es una cookie, cualquiera puede editarla.
     */
    private function get_touch_cookie( string $name ): ?array {
        if ( empty( $_COOKIE[ $name ] ) || ! is_string( $_COOKIE[ $name ] ) ) return null;
        $data = json_decode( wp_unslash( $_COOKIE[ $name ] ), true, 4 );
        if ( ! is_array( $data ) ) return null;

        $keys = [
            'source', 'medium', 'campaign', 'content', 'term', 'click_id', 'ts',
            'utm_id', 'campaign_id', 'adset_id', 'ad_id',
        ];
        $touch = [];
        foreach ( $keys as $k ) {
            if ( isset( $data[ $k ] ) && is_scalar( $data[ $k ] ) && (string) $data[ $k ] !== '' ) {
                $touch[ $k ] = substr( sanitize_text_field( (string) $data[ $k ] ), 0, 500 );
            }
        }
        return $touch ? $touch : null;
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
     * IP real del visitante: la primera IP PÚBLICA, por orden de prioridad:
     *   1. CF-Connecting-IP (Cloudflare)
     *   2. X-Forwarded-For (proxies / load balancers; se recorre la lista)
     *   3. X-Real-IP (Nginx)
     *   4. REMOTE_ADDR (conexión directa)
     *
     * Una privada (10.x, 192.168.x…) es la del proxy delante de WordPress, no
     * la del visitante: solo se devuelve si no hay ninguna pública, y la
     * plataforma la descarta igual.
     */
    private function get_client_ip(): ?string {
        $headers = [
            'HTTP_CF_CONNECTING_IP',
            'HTTP_X_FORWARDED_FOR',
            'HTTP_X_REAL_IP',
            'REMOTE_ADDR',
        ];
        $fallback = null;
        foreach ( $headers as $h ) {
            if ( empty( $_SERVER[ $h ] ) ) continue;
            $raw = sanitize_text_field( wp_unslash( $_SERVER[ $h ] ) );
            foreach ( explode( ',', $raw ) as $parte ) {
                $ip = trim( $parte );
                if ( ! filter_var( $ip, FILTER_VALIDATE_IP ) ) continue;
                if ( filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) {
                    return $ip;
                }
                if ( $fallback === null ) $fallback = $ip;
            }
        }
        return $fallback;
    }

    /** País del visitante según Cloudflare (CF-IPCountry), o null. */
    private function get_visitor_country(): ?string {
        if ( empty( $_SERVER['HTTP_CF_IPCOUNTRY'] ) ) return null;
        $pais = strtoupper( sanitize_text_field( wp_unslash( $_SERVER['HTTP_CF_IPCOUNTRY'] ) ) );
        return preg_match( '/^[A-Z]{2}$/', $pais ) && $pais !== 'XX' ? $pais : null;
    }

    /** User agent del navegador del visitante */
    private function get_user_agent(): ?string {
        if ( isset( $_SERVER['HTTP_USER_AGENT'] ) ) {
            return sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) );
        }
        return null;
    }
}
