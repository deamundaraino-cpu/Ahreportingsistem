<?php
/**
 * ReportUTM_Forms — Hooks automáticos para plugins de formulario.
 *
 * ────────────────────────────────────────────────────────────────────
 *  QUÉ HACE
 * ────────────────────────────────────────────────────────────────────
 *  Esta clase registra un hook de WordPress por cada plugin de formulario
 *  soportado. Cuando el visitante envía un formulario, el hook se dispara
 *  desde el lado del servidor PHP, extrae los datos y los envía al
 *  endpoint S2S de la plataforma usando ReportUTM_S2S_Sender.
 *
 *  Ventaja vs pixel JS: no depende del navegador ni de ad blockers.
 *  Incluso si el visitante tiene un bloqueador de anuncios, el lead
 *  se registra porque la request la hace el servidor PHP.
 *
 * ────────────────────────────────────────────────────────────────────
 *  DATOS QUE SE ENVÍAN POR CADA LEAD
 * ────────────────────────────────────────────────────────────────────
 *
 *  Campos base (siempre enviados por ReportUTM_S2S_Sender):
 *    cliente_slug   — identifica la cuenta en la plataforma
 *    event_type     — siempre 'lead' para envíos de formulario
 *    visitor_id     — UUID de 90 días del cookie rutm_vid (si existe)
 *    page_url       — URL de la página donde estaba el formulario
 *    ip             — IP real del visitante
 *    user_agent     — navegador del visitante
 *
 *  Campos específicos del lead (enviados por esta clase):
 *    form_name      — título del formulario (ej: "Formulario de contacto")
 *    form_plugin    — 'elementor' | 'cf7' | 'gravity_forms' | 'wpforms'
 *    form_id        — ID numérico del formulario en WordPress
 *    lead_name      — nombre del contacto (mapeado automáticamente)
 *    lead_email     — email del contacto
 *    lead_phone     — teléfono del contacto
 *    raw_fields     — TODOS los campos del formulario sin filtrar (JSONB)
 *
 * ────────────────────────────────────────────────────────────────────
 *  MAPEO DE CAMPOS (lead_name, lead_email, lead_phone)
 * ────────────────────────────────────────────────────────────────────
 *
 *  Para cada plugin, el mapeo funciona diferente según la API disponible:
 *
 *  ELEMENTOR PRO:
 *    $record->get('fields') devuelve array de ['value', 'type', 'title']
 *    - Tipo 'email'                → lead_email
 *    - Tipo 'tel'                  → lead_phone
 *    - Tipo 'text' + label/id con 'name' o 'nombre' → lead_name
 *    - El primer campo de texto largo se ignora (suele ser mensaje)
 *
 *  CONTACT FORM 7:
 *    $submission->get_posted_data() devuelve todos los campos por name
 *    - Búsqueda exacta en lista: your-name, name, nombre, full-name
 *    - Si no hay exacto, busca por substring del key del campo
 *    - El mismo algoritmo para email y teléfono
 *
 *  GRAVITY FORMS:
 *    $form['fields'] son objetos GF_Field con $field->type
 *    - type 'name': combina subfield .3 (first) + .6 (last) de $entry
 *    - type 'email': toma rgar($entry, $field_id)
 *    - type 'phone': toma rgar($entry, $field_id)
 *
 *  WPFORMS:
 *    $fields llega como array con 'type', 'name', 'value' por campo
 *    - type 'email', 'phone', 'name' mapeados directamente
 *    - Fallback: busca 'name'/'nombre' en el label del campo
 *
 * ────────────────────────────────────────────────────────────────────
 *  raw_fields — campos personalizados
 * ────────────────────────────────────────────────────────────────────
 *
 *  TODOS los campos del formulario se envían en raw_fields sin filtrar.
 *  Esto incluye campos personalizados que no se mapean a lead_name,
 *  lead_email ni lead_phone (ej: "empresa", "puesto", "mensaje").
 *
 *  En la plataforma, abriendo el detalle del lead (ícono expandir)
 *  se pueden ver todos los raw_fields como grilla de clave-valor.
 *
 *  La columna raw_fields en la base de datos es JSONB, lo que permite
 *  hacer queries como:
 *    SELECT * FROM lead_events WHERE raw_fields->>'empresa' = 'Acme';
 *
 * ────────────────────────────────────────────────────────────────────
 *  REQUERIMIENTO: S2S Token
 * ────────────────────────────────────────────────────────────────────
 *
 *  Si no hay S2S Token configurado, esta clase no registra ningún hook
 *  y los formularios no se trackean. Para activar:
 *    WP Admin → Ajustes → Report UTM → Modo avanzado → S2S Token
 *
 * ────────────────────────────────────────────────────────────────────
 */

if ( ! defined( 'ABSPATH' ) ) exit;

class ReportUTM_Forms {

    private ReportUTM_S2S_Sender $sender;
    private array $options;

    /**
     * Constructor: inicializa el sender y registra los hooks si hay token.
     *
     * @param array $options Opciones del plugin (rutm_options de wp_options)
     */
    public function __construct( array $options ) {
        $this->options = $options;

        // Sin S2S Token: no trackear formularios (sin autenticación no se puede enviar)
        if ( empty( $options['s2s_token'] ) ) return;

        $base_url = ! empty( $options['base_url'] )
            ? $options['base_url']
            : 'https://reportes.adshouse.cloud/';

        $this->sender = new ReportUTM_S2S_Sender(
            $base_url,
            $options['cliente_slug'],
            $options['s2s_token']
        );

        $this->register_hooks();
    }

    /**
     * Registra los hooks de WordPress para cada plugin de formulario.
     * Se usan add_action() y no add_filter() porque no necesitamos modificar
     * ningún valor, solo reaccionar a los envíos.
     */
    private function register_hooks(): void {
        // CF7: disparado después de enviar el email de notificación
        add_action( 'wpcf7_mail_sent', [ $this, 'on_cf7_sent' ] );

        // Gravity Forms: disparado después de procesar el entry completo
        add_action( 'gform_after_submission', [ $this, 'on_gravity_forms_submission' ], 10, 2 );

        // WPForms: disparado después de guardar el entry en la DB de WP
        add_action( 'wpforms_process_complete', [ $this, 'on_wpforms_complete' ], 10, 4 );

        // Elementor Pro: disparado cuando el form action procesa el record
        add_action( 'elementor_pro/forms/new_record', [ $this, 'on_elementor_form' ], 10, 2 );
    }

    // ─────────────────────────────────────────────────────────────────
    //  Contact Form 7
    // ─────────────────────────────────────────────────────────────────

    /**
     * @param WPCF7_ContactForm $contact_form Objeto del formulario CF7
     */
    public function on_cf7_sent( $contact_form ): void {
        $submission = WPCF7_Submission::get_instance();
        if ( ! $submission ) return;

        $posted     = $submission->get_posted_data();
        $raw_fields = $this->sanitize_fields( $posted );

        // Mapeo por nombres comunes de campos CF7
        $lead_name  = $this->find_field( $raw_fields, [ 'your-name', 'name', 'nombre', 'full-name', 'fullname', 'tu-nombre' ] );
        $lead_email = $this->find_field( $raw_fields, [ 'your-email', 'email', 'correo', 'mail', 'tu-email' ] );
        $lead_phone = $this->find_field( $raw_fields, [ 'your-phone', 'phone', 'telefono', 'tel', 'mobile', 'celular', 'movil' ] );

        $this->sender->send( 'lead', [
            'form_name'   => $contact_form->title(),
            'form_plugin' => 'cf7',
            'form_id'     => (string) $contact_form->id(),
            'lead_name'   => $lead_name,
            'lead_email'  => $lead_email,
            'lead_phone'  => $lead_phone,
            'raw_fields'  => $raw_fields,
        ] );
    }

    // ─────────────────────────────────────────────────────────────────
    //  Gravity Forms
    // ─────────────────────────────────────────────────────────────────

    /**
     * @param array $entry Array de la entrada de Gravity Forms
     * @param array $form  Definición del formulario con $form['fields']
     */
    public function on_gravity_forms_submission( $entry, $form ): void {
        $raw_fields = [];
        $lead_name  = null;
        $lead_email = null;
        $lead_phone = null;

        foreach ( $form['fields'] as $field ) {
            $field_id    = $field->id;
            $field_label = strtolower( $field->label ?? '' );
            $field_type  = strtolower( $field->type ?? '' );

            if ( $field_type === 'name' ) {
                // Campo nombre dividido: .3 = primer nombre, .6 = apellido
                $first = sanitize_text_field( rgar( $entry, $field_id . '.3' ) );
                $last  = sanitize_text_field( rgar( $entry, $field_id . '.6' ) );
                $val   = trim( "$first $last" );
                $raw_fields[ $field_label ?: "campo_{$field_id}" ] = $val;
                if ( ! $lead_name && $val ) $lead_name = $val;
            } else {
                $val = sanitize_text_field( rgar( $entry, (string) $field_id ) );
                $raw_fields[ $field_label ?: "campo_{$field_id}" ] = $val;

                // Mapeo automático por tipo de campo
                if ( ! $lead_email && $field_type === 'email' && $val ) $lead_email = $val;
                if ( ! $lead_phone && $field_type === 'phone'  && $val ) $lead_phone = $val;
                if ( ! $lead_name  && ( str_contains( $field_label, 'name' ) || str_contains( $field_label, 'nombre' ) ) && $val ) {
                    $lead_name = $val;
                }
            }
        }

        $this->sender->send( 'lead', [
            'form_name'   => $form['title'] ?? '',
            'form_plugin' => 'gravity_forms',
            'form_id'     => (string) ( $form['id'] ?? '' ),
            'lead_name'   => $lead_name,
            'lead_email'  => $lead_email,
            'lead_phone'  => $lead_phone,
            'raw_fields'  => $raw_fields,
        ] );
    }

    // ─────────────────────────────────────────────────────────────────
    //  WPForms
    // ─────────────────────────────────────────────────────────────────

    /**
     * @param array $fields    Campos procesados con type, name, value
     * @param array $entry     Entry raw de WPForms
     * @param array $form_data Configuración del formulario
     * @param int   $entry_id  ID del entry guardado
     */
    public function on_wpforms_complete( $fields, $entry, $form_data, $entry_id ): void {
        $raw_fields = [];
        $lead_name  = null;
        $lead_email = null;
        $lead_phone = null;

        foreach ( $fields as $field ) {
            $label = strtolower( $field['name'] ?? "campo_{$field['id']}" );
            $type  = strtolower( $field['type'] ?? '' );
            $val   = sanitize_text_field( $field['value'] ?? '' );

            $raw_fields[ $label ] = $val;

            if ( ! $lead_email && $type === 'email' && $val ) $lead_email = $val;
            if ( ! $lead_phone && $type === 'phone' && $val ) $lead_phone = $val;
            if ( ! $lead_name  && $type === 'name'  && $val ) $lead_name  = $val;
            // Fallback por label para campos de nombre no tipados
            if ( ! $lead_name && ( str_contains( $label, 'name' ) || str_contains( $label, 'nombre' ) ) && $val ) {
                $lead_name = $val;
            }
        }

        $this->sender->send( 'lead', [
            'form_name'   => $form_data['settings']['form_title'] ?? '',
            'form_plugin' => 'wpforms',
            'form_id'     => (string) ( $form_data['id'] ?? '' ),
            'lead_name'   => $lead_name,
            'lead_email'  => $lead_email,
            'lead_phone'  => $lead_phone,
            'raw_fields'  => $raw_fields,
        ] );
    }

    // ─────────────────────────────────────────────────────────────────
    //  Elementor Pro Forms
    // ─────────────────────────────────────────────────────────────────

    /**
     * @param \ElementorPro\Modules\Forms\Classes\Form_Record $record  Datos del envío
     * @param \ElementorPro\Modules\Forms\Classes\Ajax_Handler $handler Handler AJAX
     */
    public function on_elementor_form( $record, $handler ): void {
        // $record->get('fields') devuelve:
        // [ 'field_id' => [ 'value' => '...', 'type' => 'email|tel|text|...', 'title' => 'Label' ] ]
        $fields     = $record->get( 'fields' );
        $raw_fields = [];
        $lead_name  = null;
        $lead_email = null;
        $lead_phone = null;

        foreach ( $fields as $id => $field ) {
            $val   = sanitize_text_field( $field['value'] ?? '' );
            $type  = strtolower( $field['type'] ?? '' );
            $label = strtolower( $field['title'] ?? $id );
            $id_lc = strtolower( $id );

            // Guardar en raw_fields usando label o ID como clave
            $raw_fields[ $label ?: $id ] = $val;

            if ( ! $val ) continue;

            // Mapeo por tipo de widget Elementor o por label/ID
            if ( ! $lead_email && ( $type === 'email' || str_contains( $label, 'email' ) || str_contains( $id_lc, 'email' ) || str_contains( $label, 'correo' ) ) ) {
                $lead_email = $val;
            } elseif ( ! $lead_phone && ( $type === 'tel' || str_contains( $label, 'phone' ) || str_contains( $label, 'telefon' ) || str_contains( $label, 'celular' ) || str_contains( $id_lc, 'phone' ) || str_contains( $id_lc, 'tel' ) ) ) {
                $lead_phone = $val;
            } elseif ( ! $lead_name && $type === 'text' && ( str_contains( $label, 'name' ) || str_contains( $label, 'nombre' ) || str_contains( $id_lc, 'name' ) || str_contains( $id_lc, 'nombre' ) ) ) {
                $lead_name = $val;
            }
        }

        $this->sender->send( 'lead', [
            'form_name'   => $record->get_form_settings( 'form_name' ),
            'form_plugin' => 'elementor',
            'form_id'     => $record->get_form_settings( 'id' ) ?? '',
            'lead_name'   => $lead_name,
            'lead_email'  => $lead_email,
            'lead_phone'  => $lead_phone,
            'raw_fields'  => $raw_fields,
        ] );
    }

    // ─────────────────────────────────────────────────────────────────
    //  Helpers internos
    // ─────────────────────────────────────────────────────────────────

    /**
     * Sanitiza un array de campos arbitrarios del formulario.
     * Aplana arrays (ej: checkboxes) a strings separados por espacio.
     * Excluye campos internos de WordPress (empiezan con _).
     *
     * @param array $raw Array crudo de get_posted_data() u equivalente
     * @return array [ campo => valor_sanitizado ]
     */
    private function sanitize_fields( array $raw ): array {
        $out = [];
        foreach ( $raw as $key => $val ) {
            // Saltar campos internos de WordPress y CF7
            if ( str_starts_with( $key, '_' ) ) continue;

            if ( is_array( $val ) ) {
                $val = implode( ' ', array_filter( array_map( 'sanitize_text_field', $val ) ) );
            } else {
                $val = sanitize_text_field( (string) $val );
            }

            $out[ sanitize_key( $key ) ] = $val;
        }
        return $out;
    }

    /**
     * Busca el valor del primer campo que coincida con algún nombre de la lista.
     *
     * Estrategia:
     *   1. Coincidencia exacta de clave (más rápida y precisa)
     *   2. Coincidencia por substring (para claves como "tu-email-aqui")
     *
     * @param array  $fields Array [key => value] ya sanitizado
     * @param array  $names  Lista de nombres/substrings a buscar
     * @return string|null Primer valor no vacío encontrado
     */
    private function find_field( array $fields, array $names ): ?string {
        // Paso 1: coincidencia exacta
        foreach ( $names as $name ) {
            if ( isset( $fields[ $name ] ) && $fields[ $name ] !== '' ) {
                return $fields[ $name ];
            }
        }

        // Paso 2: substring (ej: campo "your-email-contact" coincide con "email")
        foreach ( $fields as $key => $val ) {
            if ( $val === '' ) continue;
            foreach ( $names as $name ) {
                if ( str_contains( strtolower( $key ), $name ) ) {
                    return $val;
                }
            }
        }

        return null;
    }
}
