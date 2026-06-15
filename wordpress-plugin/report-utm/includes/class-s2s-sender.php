<?php
/**
 * Envía eventos al endpoint S2S de Report UTM usando wp_remote_post.
 * La firma es HMAC-SHA256(rawBody, s2s_token).
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class ReportUTM_S2S_Sender {

    private string $base_url;
    private string $cliente_slug;
    private string $s2s_token;

    public function __construct( string $base_url, string $cliente_slug, string $s2s_token ) {
        $this->base_url     = trailingslashit( $base_url );
        $this->cliente_slug = $cliente_slug;
        $this->s2s_token    = $s2s_token;
    }

    /**
     * Envía un evento al endpoint S2S.
     *
     * @param string      $event_type  'lead' | 'pageview' | 'custom'
     * @param array       $extra       Campos adicionales (form_name, page_url, etc.)
     * @param string|null $visitor_id  rutm_vid del cookie
     * @return bool
     */
    public function send( string $event_type, array $extra = [], ?string $visitor_id = null ): bool {
        $body = array_merge( [
            'cliente_slug' => $this->cliente_slug,
            'event_type'   => $event_type,
            'visitor_id'   => $visitor_id ?? $this->get_visitor_id(),
            'page_url'     => isset( $_SERVER['HTTP_REFERER'] ) ? esc_url_raw( wp_unslash( $_SERVER['HTTP_REFERER'] ) ) : null,
            'ip'           => $this->get_client_ip(),
            'user_agent'   => isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : null,
        ], $extra );

        $json = wp_json_encode( $body );
        $sig  = hash_hmac( 'sha256', $json, $this->s2s_token );

        $response = wp_remote_post(
            $this->base_url . 'api/report-utm/pixel/s2s',
            [
                'timeout'     => 5,
                'blocking'    => false, // fire-and-forget
                'headers'     => [
                    'Content-Type'           => 'application/json',
                    'X-Rutm-S2S-Signature'   => $sig,
                ],
                'body'        => $json,
                'data_format' => 'body',
            ]
        );

        return ! is_wp_error( $response );
    }

    /** Lee el visitor_id del cookie rutm_vid */
    private function get_visitor_id(): ?string {
        return isset( $_COOKIE['rutm_vid'] ) ? sanitize_text_field( wp_unslash( $_COOKIE['rutm_vid'] ) ) : null;
    }

    /** Obtiene la IP real del visitante respetando proxies confiables */
    private function get_client_ip(): ?string {
        $headers = [ 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP', 'REMOTE_ADDR' ];
        foreach ( $headers as $h ) {
            if ( ! empty( $_SERVER[ $h ] ) ) {
                $ip = trim( explode( ',', sanitize_text_field( wp_unslash( $_SERVER[ $h ] ) ) )[0] );
                if ( filter_var( $ip, FILTER_VALIDATE_IP ) ) return $ip;
            }
        }
        return null;
    }
}
