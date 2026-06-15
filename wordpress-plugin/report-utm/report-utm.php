<?php
/**
 * Plugin Name:       Report UTM — Ad House
 * Plugin URI:        https://reportes.adshouse.cloud/
 * Description:       Tracking UTM server-side para WordPress. Capta leads de formularios y propaga UTMs a links de checkout (Hotmart, CartPanda, Shopify) con atribución multi-touch.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Ad House
 * License:           Proprietary
 * Text Domain:       report-utm
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'RUTM_VERSION',    '1.0.0' );
define( 'RUTM_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'RUTM_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

require_once RUTM_PLUGIN_DIR . 'includes/class-s2s-sender.php';
require_once RUTM_PLUGIN_DIR . 'includes/class-forms.php';
require_once RUTM_PLUGIN_DIR . 'admin/settings-page.php';

/**
 * Punto de entrada principal.
 */
class ReportUTM_Plugin {

    public function __construct() {
        add_action( 'wp_enqueue_scripts', [ $this, 'enqueue_pixel' ] );
        add_action( 'admin_menu',          [ $this, 'register_admin_menu' ] );
        add_action( 'admin_init',          [ $this, 'register_settings' ] );

        $options = get_option( 'rutm_options', [] );
        if ( ! empty( $options['enabled'] ) && ! empty( $options['cliente_slug'] ) ) {
            new ReportUTM_Forms( $options );
        }
    }

    /** Inyecta el pixel JS en el frontend */
    public function enqueue_pixel() {
        $options = get_option( 'rutm_options', [] );
        if ( empty( $options['enabled'] ) || empty( $options['cliente_slug'] ) ) return;

        $base_url = ! empty( $options['base_url'] )
            ? trailingslashit( esc_url_raw( $options['base_url'] ) )
            : 'https://reportes.adshouse.cloud/';

        $pixel_url = $base_url . 'report-utm-pixel.js';
        $slug      = sanitize_text_field( $options['cliente_slug'] );

        // Inyecta config antes del pixel
        wp_add_inline_script(
            'report-utm-pixel',
            sprintf(
                'window.RUTM_CONFIG = %s;',
                wp_json_encode( [
                    'cliente_slug'    => $slug,
                    'propagate_utms'  => ! empty( $options['propagate_utms'] ),
                    'checkout_domains'=> ! empty( $options['checkout_domains'] )
                        ? array_filter( array_map( 'trim', explode( "\n", $options['checkout_domains'] ) ) )
                        : null,
                ] )
            ),
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

    public function register_admin_menu() {
        add_options_page(
            'Report UTM',
            'Report UTM',
            'manage_options',
            'report-utm',
            'rutm_render_settings_page'
        );
    }

    public function register_settings() {
        register_setting( 'rutm_options_group', 'rutm_options', [
            'sanitize_callback' => 'rutm_sanitize_options',
        ] );
    }
}

new ReportUTM_Plugin();
