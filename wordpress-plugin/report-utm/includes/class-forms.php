<?php
/**
 * Hooks automáticos para los plugins de formularios más usados.
 * Detecta envíos y dispara un evento 'lead' al endpoint S2S.
 *
 * Soporta:
 *   - Contact Form 7 (CF7)
 *   - Gravity Forms
 *   - WPForms
 *   - Elementor Pro Forms
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class ReportUTM_Forms {

    private ReportUTM_S2S_Sender $sender;
    private array $options;

    public function __construct( array $options ) {
        $this->options = $options;

        if ( empty( $options['s2s_token'] ) ) return;

        $base_url = ! empty( $options['base_url'] ) ? $options['base_url'] : 'https://reportes.adshouse.cloud/';
        $this->sender = new ReportUTM_S2S_Sender(
            $base_url,
            $options['cliente_slug'],
            $options['s2s_token']
        );

        $this->register_hooks();
    }

    private function register_hooks(): void {
        // Contact Form 7
        add_action( 'wpcf7_mail_sent', [ $this, 'on_cf7_sent' ] );

        // Gravity Forms
        add_action( 'gform_after_submission', [ $this, 'on_gravity_forms_submission' ], 10, 2 );

        // WPForms
        add_action( 'wpforms_process_complete', [ $this, 'on_wpforms_complete' ], 10, 4 );

        // Elementor Pro
        add_action( 'elementor_pro/forms/new_record', [ $this, 'on_elementor_form' ], 10, 2 );
    }

    /** Contact Form 7 */
    public function on_cf7_sent( $contact_form ): void {
        $this->sender->send( 'lead', [
            'form_name'     => $contact_form->title(),
            'form_plugin'   => 'cf7',
            'form_id'       => (string) $contact_form->id(),
        ] );
    }

    /** Gravity Forms */
    public function on_gravity_forms_submission( $entry, $form ): void {
        $this->sender->send( 'lead', [
            'form_name'     => $form['title'] ?? '',
            'form_plugin'   => 'gravity_forms',
            'form_id'       => (string) ( $form['id'] ?? '' ),
        ] );
    }

    /** WPForms */
    public function on_wpforms_complete( $fields, $entry, $form_data, $entry_id ): void {
        $this->sender->send( 'lead', [
            'form_name'     => $form_data['settings']['form_title'] ?? '',
            'form_plugin'   => 'wpforms',
            'form_id'       => (string) ( $form_data['id'] ?? '' ),
        ] );
    }

    /** Elementor Pro Forms */
    public function on_elementor_form( $record, $handler ): void {
        $form_name = $record->get_form_settings( 'form_name' );
        $this->sender->send( 'lead', [
            'form_name'     => $form_name,
            'form_plugin'   => 'elementor',
        ] );
    }
}
