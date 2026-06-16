<?php
/**
 * Plugin Name:       Report UTM — Ad House
 * Plugin URI:        https://reportes.adshouse.cloud/
 * Description:       Tracking UTM server-side para WordPress. Capta leads de formularios con datos de contacto completos, propaga UTMs a links de checkout y registra la atribución multi-touch de cada visitante.
 * Version:           0.3.1
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Robinson Zapata / Ad House
 * Author URI:        https://adshouse.cloud/
 * License:           Proprietary — Ad House Internal Use
 * Text Domain:       report-utm
 *
 * ════════════════════════════════════════════════════════════════════
 *  CÓMO FUNCIONA ESTE PLUGIN
 * ════════════════════════════════════════════════════════════════════
 *
 *  1. PIXEL JS (frontend)
 *     Al activarse, el plugin inyecta automáticamente el script
 *     report-utm-pixel.js en el <head> de cada página. Ese script:
 *       a) Crea o renueva dos cookies first-party de 90 días:
 *            rutm_vid  — visitor ID único y persistente (UUID v4)
 *            rutm_sid  — session ID (se renueva cada 30 min de inactividad)
 *       b) Captura los UTMs de la URL de entrada (utm_source, utm_campaign,
 *          utm_medium, utm_content, utm_term, utm_id) y los guarda en
 *          cookies rutm_ft (first touch) y rutm_lt (last touch).
 *       c) Detecta click IDs publicitarios: fbclid (Meta), gclid (Google),
 *          ttclid (TikTok) y los asocia al visitante.
 *       d) Propaga esos UTMs automáticamente a todos los links de checkout
 *          presentes en el HTML (Hotmart, CartPanda, Shopify, Kiwify, etc.)
 *          usando un MutationObserver para links que aparecen dinámicamente.
 *
 *  2. CAPTURA DE LEADS S2S (server-to-server)
 *     Cuando un visitante envía un formulario, el plugin lo detecta del
 *     lado del servidor PHP (sin depender del navegador ni de ad blockers)
 *     y envía todos los datos a la plataforma firmados con HMAC-SHA256.
 *
 *     Formularios soportados automáticamente:
 *       — Elementor Pro Forms
 *       — Contact Form 7 (CF7)
 *       — Gravity Forms
 *       — WPForms
 *
 *     Datos que se registran por cada lead:
 *       — Nombre, email, teléfono (mapeados automáticamente por campo)
 *       — TODOS los campos del formulario en raw_fields (sin filtrar)
 *       — UTMs del visitante al momento del envío
 *       — Visitor ID (cookie rutm_vid) para atribución multi-touch
 *       — IP, país, user agent, URL de la página
 *       — Atribución: primer toque y último toque antes del lead
 *
 *  3. ATRIBUCIÓN MULTI-TOUCH
 *     La plataforma cruza el visitor_id del lead con los eventos previos
 *     del pixel para determinar:
 *       — Cuál fue el PRIMER anuncio que trajo al visitante al sitio
 *       — Cuál fue el ÚLTIMO anuncio antes de que llenara el formulario
 *       — Si vino de un click en un ad (fbclid/gclid) o de UTMs directos
 *
 *  4. CONFIGURACIÓN MÍNIMA (para empezar)
 *     Paso 1: Activar el plugin en WP Admin → Plugins
 *     Paso 2: Ir a Ajustes → Report UTM
 *     Paso 3: Ingresar el SLUG de tu cliente (te lo da Ad House)
 *     Paso 4: Activar el plugin con el toggle
 *     Paso 5: Guardar → el pixel ya está funcionando
 *
 *  5. CONFIGURACIÓN AVANZADA (para captura de leads)
 *     Además de los pasos anteriores:
 *     Paso 6: Activar "Modo avanzado" en la configuración
 *     Paso 7: Ingresar el S2S Token (desde reportes.adshouse.cloud →
 *             tu cliente → tarjeta "Integración S2S" → Activar)
 *     Paso 8: Guardar → los formularios se trackean desde el servidor
 *
 * ════════════════════════════════════════════════════════════════════
 *  ARQUITECTURA TÉCNICA
 * ════════════════════════════════════════════════════════════════════
 *
 *  Clases incluidas:
 *    ReportUTM_Plugin      — Bootstrap principal (este archivo)
 *    ReportUTM_S2S_Sender  — Cliente HTTP para enviar eventos firmados
 *    ReportUTM_Forms       — Hooks de detección de formularios
 *
 *  Funciones admin:
 *    rutm_render_settings_page() — Renderiza el panel en WP Admin
 *    rutm_sanitize_options()     — Sanitiza y valida la configuración
 *    rutm_check_connection()     — Ping al endpoint S2S para verificar
 *
 *  Opciones almacenadas en wp_options (clave: rutm_options):
 *    enabled          (bool)   — Plugin activo/inactivo
 *    cliente_slug     (string) — Identificador único del cliente en la plataforma
 *    base_url         (string) — URL base de la plataforma (default: reportes.adshouse.cloud)
 *    s2s_token        (string) — Token secreto HMAC para autenticar envíos
 *    propagate_utms   (bool)   — Propagar UTMs a links de checkout
 *    checkout_domains (string) — Lista de dominios de pago (uno por línea)
 *    advanced_mode    (bool)   — Mostrar/ocultar opciones avanzadas
 *
 *  Endpoint S2S de la plataforma:
 *    POST https://reportes.adshouse.cloud/api/report-utm/pixel/s2s
 *    Auth: HMAC-SHA256(rawBody, s2s_token) en header X-Rutm-S2S-Signature
 *
 * ════════════════════════════════════════════════════════════════════
 *  CHANGELOG
 * ════════════════════════════════════════════════════════════════════
 *
 *  v0.3.1 — Correcciones de empaquetado y test
 *    + Fix: ZIP empaquetado con separadores '/' (antes '\' rompía la
 *           instalación en Linux con error fatal en los require_once)
 *    + Fix: polyfills para str_contains/str_starts_with (PHP 7.4)
 *    + Fix: carga defensiva de archivos (aviso en admin en vez de fatal)
 *    + Fix: "Enviar lead de prueba" ahora es bloqueante y reporta el
 *           código HTTP real (404/401/403) en vez de un éxito falso
 *    + Fix: el mensaje del test ahora siempre se muestra (bug de CSS)
 *
 *  v0.3.0 — Captura completa de campos de formulario
 *    + Extracción de lead_name, lead_email, lead_phone por cada plugin
 *    + raw_fields: todos los campos sin filtrar (JSONB en la plataforma)
 *    + Soporte mejorado para Elementor Pro (mapeo por tipo de widget)
 *    + Soporte mejorado para CF7, Gravity Forms, WPForms
 *    + Panel de admin rediseñado con guía de configuración integrada
 *    + Detección automática de plugins de formulario instalados
 *    + Botón "Enviar lead de prueba" para verificar la integración
 *    + Documentación inline completa
 *
 *  v0.2.0 — S2S + propagación UTM
 *    + Endpoint S2S autenticado con HMAC-SHA256
 *    + Propagación automática de UTMs a links de checkout
 *    + MutationObserver para links dinámicos (Elementor, popups)
 *    + Panel de admin con modo simple / avanzado
 *
 *  v0.1.0 — Versión inicial
 *    + Inyección del pixel JS report-utm-pixel.js
 *    + Hooks básicos para CF7, GF, WPForms, Elementor Pro
 *    + Panel de configuración básico
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'RUTM_VERSION',    '0.3.1' );
define( 'RUTM_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'RUTM_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'RUTM_PLATFORM',   'https://reportes.adshouse.cloud/' );

/**
 * Polyfills para funciones de PHP 8.0.
 *
 * El plugin soporta PHP 7.4+. WordPress core polyfilla estas funciones
 * desde la versión 5.9, pero las definimos aquí también (guardadas con
 * function_exists) para garantizar compatibilidad en PHP 7.4 con
 * WordPress 5.8, donde aún no existen.
 */
if ( ! function_exists( 'str_contains' ) ) {
    function str_contains( $haystack, $needle ): bool {
        return $needle === '' || strpos( $haystack, $needle ) !== false;
    }
}
if ( ! function_exists( 'str_starts_with' ) ) {
    function str_starts_with( $haystack, $needle ): bool {
        return $needle === '' || strpos( $haystack, $needle ) === 0;
    }
}
if ( ! function_exists( 'str_ends_with' ) ) {
    function str_ends_with( $haystack, $needle ): bool {
        return $needle === '' || substr( $haystack, -strlen( $needle ) ) === $needle;
    }
}

/**
 * Carga los archivos del plugin de forma defensiva.
 *
 * Si algún archivo no existe (por ejemplo, un ZIP mal empaquetado donde las
 * carpetas no se crearon correctamente), abortamos con un aviso en el admin
 * en lugar de provocar un error fatal con un require_once roto.
 */
$rutm_required_files = [
    'includes/class-s2s-sender.php',
    'includes/class-forms.php',
    'admin/settings-page.php',
];
foreach ( $rutm_required_files as $rutm_file ) {
    $rutm_path = RUTM_PLUGIN_DIR . $rutm_file;
    if ( ! file_exists( $rutm_path ) ) {
        add_action( 'admin_notices', function () use ( $rutm_file ) {
            echo '<div class="notice notice-error"><p><strong>Report UTM:</strong> falta el archivo <code>'
                . esc_html( $rutm_file )
                . '</code>. El paquete del plugin está incompleto o se descomprimió mal. Volvé a subir el ZIP.</p></div>';
        } );
        return; // Aborta la carga del plugin sin matar el sitio
    }
    require_once $rutm_path;
}

/**
 * Clase principal del plugin.
 *
 * Responsabilidades:
 *   - Inyectar el pixel JS en el frontend via wp_enqueue_scripts
 *   - Registrar el menú de ajustes en WP Admin
 *   - Inicializar ReportUTM_Forms si el plugin está activo y configurado
 */
class ReportUTM_Plugin {

    public function __construct() {
        add_action( 'wp_enqueue_scripts', [ $this, 'enqueue_pixel' ] );
        add_action( 'admin_menu',          [ $this, 'register_admin_menu' ] );
        add_action( 'admin_init',          [ $this, 'register_settings' ] );
        add_action( 'wp_ajax_rutm_test_lead', [ $this, 'ajax_test_lead' ] );

        $options = get_option( 'rutm_options', [] );
        if ( ! empty( $options['enabled'] ) && ! empty( $options['cliente_slug'] ) ) {
            new ReportUTM_Forms( $options );
        }
    }

    /**
     * Inyecta window.RUTM_CONFIG y el pixel JS en el <head> del sitio.
     *
     * El objeto RUTM_CONFIG le indica al pixel JS:
     *   cliente_slug    — a qué cuenta de la plataforma enviar los eventos
     *   propagate_utms  — si debe decorar links de checkout con UTMs
     *   checkout_domains — lista de dominios a los que propagar UTMs
     *                      (null = usar la lista por defecto de la plataforma)
     */
    public function enqueue_pixel(): void {
        $options = get_option( 'rutm_options', [] );
        if ( empty( $options['enabled'] ) || empty( $options['cliente_slug'] ) ) return;

        $base_url  = ! empty( $options['base_url'] )
            ? trailingslashit( esc_url_raw( $options['base_url'] ) )
            : RUTM_PLATFORM;
        $pixel_url = $base_url . 'report-utm-pixel.js';
        $slug      = sanitize_text_field( $options['cliente_slug'] );

        $checkout_domains = null;
        if ( ! empty( $options['checkout_domains'] ) ) {
            $lines = explode( "\n", $options['checkout_domains'] );
            $checkout_domains = array_values(
                array_filter( array_map( 'trim', $lines ) )
            );
        }

        wp_add_inline_script(
            'report-utm-pixel',
            sprintf( 'window.RUTM_CONFIG = %s;', wp_json_encode( [
                'cliente_slug'     => $slug,
                'propagate_utms'   => ! empty( $options['propagate_utms'] ),
                'checkout_domains' => $checkout_domains,
            ] ) ),
            'before'
        );

        wp_enqueue_script(
            'report-utm-pixel',
            $pixel_url,
            [],
            RUTM_VERSION,
            [ 'strategy' => 'defer', 'in_footer' => false ]
        );
    }

    /** Registra el submenú en Ajustes → Report UTM */
    public function register_admin_menu(): void {
        add_options_page(
            'Report UTM — Ad House',
            'Report UTM',
            'manage_options',
            'report-utm',
            'rutm_render_settings_page'
        );
    }

    /** Registra la opción con sanitización en la API de Settings de WP */
    public function register_settings(): void {
        register_setting( 'rutm_options_group', 'rutm_options', [
            'sanitize_callback' => 'rutm_sanitize_options',
        ] );
    }

    /**
     * Handler AJAX para el botón "Enviar lead de prueba" en el panel.
     * Envía un lead ficticio al endpoint S2S para verificar que la firma
     * y la configuración son correctas.
     */
    public function ajax_test_lead(): void {
        check_ajax_referer( 'rutm_test_lead', 'nonce' );
        if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Forbidden', 403 );

        $options = get_option( 'rutm_options', [] );
        if ( empty( $options['cliente_slug'] ) || empty( $options['s2s_token'] ) ) {
            wp_send_json_error( 'Configurá el Slug y el S2S Token primero.' );
        }

        $base_url = ! empty( $options['base_url'] ) ? $options['base_url'] : RUTM_PLATFORM;
        $sender   = new ReportUTM_S2S_Sender(
            $base_url,
            $options['cliente_slug'],
            $options['s2s_token']
        );

        $result = $sender->send_blocking( 'lead', [
            'form_name'   => 'Test desde WP Admin',
            'form_plugin' => 's2s',
            'lead_name'   => 'Test Lead',
            'lead_email'  => 'test@adshouse.cloud',
            'lead_phone'  => '+54 11 0000-0000',
            'raw_fields'  => [ 'origen' => 'wp_admin_test', 'version' => RUTM_VERSION ],
        ] );

        if ( $result['ok'] ) {
            wp_send_json_success(
                'Lead de prueba enviado (HTTP ' . $result['code'] . '). '
                . 'Verificá en reportes.adshouse.cloud → Leads.'
            );
        }

        // Construir un mensaje de error diagnóstico a partir de la respuesta
        $detail = '';
        $decoded = json_decode( $result['message'], true );
        if ( is_array( $decoded ) && ! empty( $decoded['error'] ) ) {
            $detail = $decoded['error'];
        }

        if ( $result['code'] === 0 ) {
            $msg = 'No se pudo contactar el servidor. Revisá la URL base y que el sitio tenga salida a internet.';
        } elseif ( $result['code'] === 404 ) {
            $msg = 'HTTP 404 — El slug "' . esc_html( $options['cliente_slug'] ) . '" no existe en la plataforma. Revisá el Slug de cliente.';
        } elseif ( $result['code'] === 401 ) {
            $msg = 'HTTP 401 — Firma inválida. El S2S Token no coincide con el de la plataforma. Rotalo y volvé a copiarlo.';
        } elseif ( $result['code'] === 403 ) {
            $msg = 'HTTP 403 — La integración S2S está inactiva o sin token en la plataforma. Activala en reportes.adshouse.cloud.';
        } else {
            $msg = 'HTTP ' . $result['code'] . ( $detail ? ' — ' . $detail : ' — Error al enviar.' );
        }

        wp_send_json_error( $msg );
    }
}

new ReportUTM_Plugin();
