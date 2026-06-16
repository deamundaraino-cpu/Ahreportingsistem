<?php
/**
 * Panel de administración de Report UTM.
 *
 * ────────────────────────────────────────────────────────────────────
 *  GUÍA RÁPIDA PARA EL ADMINISTRADOR DE WORDPRESS
 * ────────────────────────────────────────────────────────────────────
 *
 *  Esta página se renderiza en WP Admin → Ajustes → Report UTM.
 *  Incluye toda la información necesaria para instalar, configurar
 *  y verificar la integración sin salir de WordPress.
 *
 *  PASO 1 — ACTIVAR EL PIXEL (mínimo requerido)
 *    a) Pedile el "Slug de cliente" a tu agencia Ad House
 *    b) Ingresá el slug en el campo "Slug de cliente"
 *    c) Activá el toggle "Plugin activo"
 *    d) Guardá los cambios → el pixel ya está corriendo
 *
 *  PASO 2 — VERIFICAR LA INSTALACIÓN DEL PIXEL
 *    a) Abrí cualquier página del sitio
 *    b) Abrí DevTools → Aplicación → Cookies
 *    c) Deberías ver: rutm_vid, rutm_sid, rutm_ft, rutm_lt
 *    Si las cookies no aparecen, revisá si hay un plugin de caché
 *    que esté sirviendo HTML estático sin el script.
 *
 *  PASO 3 — ACTIVAR CAPTURA DE LEADS (requiere S2S Token)
 *    a) Ir a reportes.adshouse.cloud → tu cliente → Integración S2S
 *    b) Activar la integración S2S → copiar el Token generado
 *    c) En esta página: activar "Modo avanzado"
 *    d) Pegar el token en el campo "S2S Token"
 *    e) Guardá → el botón "Verificar conexión" debería mostrar ✓
 *    f) Enviá un formulario de prueba en el sitio
 *    g) Verificá el lead en reportes.adshouse.cloud → Leads
 *
 *  PASO 4 — PROPAGACIÓN DE UTMs A CHECKOUT (opcional)
 *    Si el sitio tiene links a Hotmart, CartPanda u otros checkout:
 *    a) En Modo avanzado: activar "Propagar UTMs a checkout"
 *    b) Opcional: agregar dominios de pago adicionales en la lista
 *    c) Guardá → el pixel JS decorará los links automáticamente
 *    Dominios incluidos por defecto: pay.hotmart.com, go.hotmart.com,
 *    checkout.cartpanda.com, pay.kiwify.com.br, checkout.shopify.com
 *
 * ────────────────────────────────────────────────────────────────────
 *  FORMULARIOS DETECTADOS AUTOMÁTICAMENTE
 * ────────────────────────────────────────────────────────────────────
 *
 *  El plugin detecta envíos sin configuración adicional para:
 *
 *    Elementor Pro Forms
 *      Hook: elementor_pro/forms/new_record
 *      Mapeo automático por tipo de campo:
 *        Tipo 'email' → lead_email
 *        Tipo 'tel'   → lead_phone
 *        Texto con 'name'/'nombre' en ID o label → lead_name
 *      TODOS los campos van en raw_fields (sin filtrar)
 *
 *    Contact Form 7 (CF7)
 *      Hook: wpcf7_mail_sent
 *      Mapeo por nombre de campo (case-insensitive):
 *        your-name, name, nombre, full-name → lead_name
 *        your-email, email, correo, mail    → lead_email
 *        your-phone, phone, telefono, tel   → lead_phone
 *      También busca por substring: campo "mi-nombre" → lead_name
 *
 *    Gravity Forms
 *      Hook: gform_after_submission
 *      Mapeo automático por tipo de campo ($field->type):
 *        'email' → lead_email
 *        'phone' → lead_phone
 *        'name'  → combina first_name (.3) + last_name (.6)
 *
 *    WPForms
 *      Hook: wpforms_process_complete
 *      Mapeo por tipo de campo ($field['type']):
 *        'email', 'phone', 'name' → campos correspondientes
 *
 *  Campos personalizados: Se envían TODOS los campos del formulario
 *  en el objeto raw_fields, aunque no coincidan con nombre/email/teléfono.
 *  Se pueden consultar en la plataforma abriendo el detalle del lead.
 *
 * ────────────────────────────────────────────────────────────────────
 *  MODELO DE ATRIBUCIÓN
 * ────────────────────────────────────────────────────────────────────
 *
 *  Cada lead recibe atribución multi-touch con 4 métodos en cascada:
 *
 *  1. click_id      — Tiene fbclid o gclid en la sesión del visitante.
 *                     Atribución más precisa (directo desde el click del ad).
 *
 *  2. visitor_cookie — Se encontró el visitor_id en eventos previos del pixel.
 *                      Cruza cookies first-party con historial de UTMs.
 *
 *  3. utm_only      — Solo tiene UTMs directos en la URL (sin click_id ni cookie).
 *                     El UTM source/campaign se puede verificar contra el lead.
 *
 *  4. none          — Sin información de origen. El visitante llegó directo o
 *                     usó un navegador que bloqueó las cookies.
 *
 *  La atribución se resuelve en la plataforma al recibir el evento,
 *  consultando el historial del visitor_id contra pixel_events.
 *
 * ────────────────────────────────────────────────────────────────────
 *  SEGURIDAD — CÓMO FUNCIONA LA FIRMA HMAC
 * ────────────────────────────────────────────────────────────────────
 *
 *  El S2S Token es un secreto compartido entre este WordPress y la
 *  plataforma. NUNCA aparece en el HTML del sitio ni en JavaScript.
 *
 *  Por cada envío, el plugin calcula:
 *    firma = HMAC-SHA256(json_body, s2s_token) → string hex
 *
 *  La plataforma recalcula la misma firma con el token almacenado
 *  en la base de datos y rechaza el request si no coincide (HTTP 401).
 *
 *  Esto significa que aunque alguien intercepte el tráfico, no puede
 *  enviar leads falsos sin conocer el token.
 *
 *  Si el token se comprometió: rotarlo en reportes.adshouse.cloud →
 *  tu cliente → Integración S2S → Rotar Token → actualizar aquí.
 *
 * ────────────────────────────────────────────────────────────────────
 *  SOLUCIÓN DE PROBLEMAS
 * ────────────────────────────────────────────────────────────────────
 *
 *  Los leads no aparecen en la plataforma:
 *    1. Verificar que "Plugin activo" está ON y hay slug configurado
 *    2. Verificar que el S2S Token está ingresado (modo avanzado)
 *    3. Usar el botón "Verificar conexión" → debe mostrar ✓
 *    4. Usar el botón "Enviar lead de prueba"
 *    5. Esperar 30 segundos → buscar en reportes.adshouse.cloud → Leads
 *    6. Si no aparece: revisar WP Admin → Herramientas → Error Log
 *
 *  El pixel no carga:
 *    1. Verificar que hay slug configurado
 *    2. Desactivar plugin de caché (WP Super Cache, W3 Total Cache)
 *    3. Revisar Console del navegador por errores JavaScript
 *
 *  Los UTMs no se propagan a los links de checkout:
 *    1. Activar "Propagar UTMs a checkout" en modo avanzado
 *    2. Entrar al sitio con UTMs: misitioweb.com?utm_source=facebook
 *    3. Inspeccionar el link de checkout: debe tener los UTMs appended
 *
 * ────────────────────────────────────────────────────────────────────
 */

if ( ! defined( 'ABSPATH' ) ) exit;

/**
 * Sanitiza y valida las opciones del plugin antes de guardar en wp_options.
 */
function rutm_sanitize_options( array $input ): array {
    return [
        'enabled'          => ! empty( $input['enabled'] ),
        'advanced_mode'    => ! empty( $input['advanced_mode'] ),
        'cliente_slug'     => sanitize_text_field( $input['cliente_slug'] ?? '' ),
        'base_url'         => esc_url_raw( $input['base_url'] ?? '' ),
        's2s_token'        => sanitize_text_field( $input['s2s_token'] ?? '' ),
        'propagate_utms'   => ! empty( $input['propagate_utms'] ),
        'checkout_domains' => sanitize_textarea_field( $input['checkout_domains'] ?? '' ),
    ];
}

/**
 * Verifica la conexión con el endpoint S2S.
 *
 * Hace un GET al endpoint (que responde { ok: true }) para confirmar
 * que la URL base es alcanzable. No verifica el token ni la firma,
 * solo que el servidor está disponible.
 *
 * @return bool|null true=OK, false=error, null=no configurado
 */
function rutm_check_connection( array $options ): ?bool {
    if ( empty( $options['cliente_slug'] ) ) return null;

    $base_url = ! empty( $options['base_url'] )
        ? trailingslashit( $options['base_url'] )
        : 'https://reportes.adshouse.cloud/';

    $response = wp_remote_get(
        $base_url . 'api/report-utm/pixel/s2s',
        [ 'timeout' => 8, 'sslverify' => true ]
    );

    if ( is_wp_error( $response ) ) return false;
    $code = wp_remote_retrieve_response_code( $response );
    return in_array( $code, [ 200, 401, 403 ], true );
}

/**
 * Detecta qué plugins de formulario están activos en este WordPress.
 *
 * @return array [plugin_key => [label, active, hook]]
 */
function rutm_detect_form_plugins(): array {
    return [
        'elementor' => [
            'label'  => 'Elementor Pro',
            'active' => defined( 'ELEMENTOR_PRO_VERSION' ),
            'hook'   => 'elementor_pro/forms/new_record',
        ],
        'cf7' => [
            'label'  => 'Contact Form 7',
            'active' => defined( 'WPCF7_VERSION' ),
            'hook'   => 'wpcf7_mail_sent',
        ],
        'gravity_forms' => [
            'label'  => 'Gravity Forms',
            'active' => class_exists( 'GFCommon' ),
            'hook'   => 'gform_after_submission',
        ],
        'wpforms' => [
            'label'  => 'WPForms',
            'active' => defined( 'WPFORMS_VERSION' ),
            'hook'   => 'wpforms_process_complete',
        ],
    ];
}

/**
 * Renderiza el panel de administración completo.
 */
function rutm_render_settings_page(): void {
    if ( ! current_user_can( 'manage_options' ) ) return;

    $options      = get_option( 'rutm_options', [] );
    $conn_ok      = rutm_check_connection( $options );
    $advanced     = ! empty( $options['advanced_mode'] );
    $form_plugins = rutm_detect_form_plugins();
    $has_s2s      = ! empty( $options['s2s_token'] );

    $active_plugins_count = count( array_filter( $form_plugins, fn( $p ) => $p['active'] ) );

    ?>
    <style>
        .rutm-wrap { max-width: 760px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .rutm-header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #e2e8f0; }
        .rutm-badge { font-size: 11px; color: #64748b; background: #f1f5f9; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
        .rutm-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .rutm-card-title { font-size: 14px; font-weight: 700; color: #1e293b; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
        .rutm-card-desc { font-size: 12px; color: #64748b; margin: 0 0 20px; line-height: 1.5; }
        .rutm-card-title .dashicons { font-size: 18px; width: 18px; height: 18px; color: #10b981; }
        .rutm-field { margin-bottom: 16px; }
        .rutm-field label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
        .rutm-field .rutm-help { display: block; font-size: 11px; color: #6b7280; margin-top: 4px; line-height: 1.6; }
        .rutm-field input[type="text"],
        .rutm-field input[type="url"],
        .rutm-field input[type="password"],
        .rutm-field textarea { width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; color: #1e293b; box-sizing: border-box; }
        .rutm-field input:focus, .rutm-field textarea:focus { border-color: #10b981; outline: none; box-shadow: 0 0 0 3px rgba(16,185,129,0.15); }
        .rutm-status { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
        .rutm-status-ok   { background: #d1fae5; color: #059669; }
        .rutm-status-fail { background: #fee2e2; color: #dc2626; }
        .rutm-status-idle { background: #f3f4f6; color: #6b7280; }
        .rutm-plugin-list { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
        .rutm-plugin-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 12px; font-weight: 500; }
        .rutm-plugin-item.active { border-color: #bbf7d0; background: #f0fdf4; color: #166534; }
        .rutm-plugin-item.inactive { color: #6b7280; }
        .rutm-plugin-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 3px; }
        .rutm-plugin-dot.active { background: #10b981; }
        .rutm-plugin-dot.inactive { background: #d1d5db; }
        .rutm-steps { counter-reset: rutm-step; list-style: none; padding: 0; margin: 0; }
        .rutm-steps li { counter-increment: rutm-step; display: flex; gap: 12px; margin-bottom: 12px; font-size: 12px; color: #374151; line-height: 1.6; }
        .rutm-steps li::before { content: counter(rutm-step); min-width: 22px; height: 22px; background: #10b981; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
        .rutm-steps code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 11px; font-family: monospace; color: #0f172a; }
        .rutm-alert { display: flex; gap: 10px; border-radius: 8px; padding: 12px 14px; margin-top: 16px; font-size: 12px; }
        .rutm-alert.warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
        .rutm-alert.info { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; }
        .rutm-attr-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 12px; }
        .rutm-attr-item { padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 8px; }
        .rutm-attr-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 2px; }
        .rutm-attr-value { font-size: 12px; color: #374151; line-height: 1.5; }
        .rutm-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 20px; }
        .rutm-btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: all .15s; text-decoration: none; display: inline-block; }
        .rutm-btn-primary { background: #10b981; color: #fff; border-color: #10b981; }
        .rutm-btn-primary:hover { background: #059669; color: #fff; }
        .rutm-btn-secondary { background: #f1f5f9; color: #374151; border-color: #e2e8f0; }
        .rutm-btn-secondary:hover { background: #e2e8f0; color: #374151; }
        #rutm-test-result { font-size: 12px; padding: 6px 12px; border-radius: 6px; display: none; }
        #rutm-test-result.ok   { background: #d1fae5; color: #065f46; display: inline-block; }
        #rutm-test-result.fail { background: #fee2e2; color: #991b1b; display: inline-block; }
        #rutm-advanced-section { display: <?php echo $advanced ? 'block' : 'none'; ?>; }
        @media (max-width: 640px) { .rutm-plugin-list, .rutm-attr-grid { grid-template-columns: 1fr; } }
    </style>

    <div class="wrap rutm-wrap">

        <!-- Header -->
        <div class="rutm-header">
            <div style="width:36px;height:36px;background:#10b981;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 3h18v2H3zm0 4h18v2H3zm0 4h12v2H3zm0 4h8v2H3zm10 0l4 4 4-4-1.41-1.41L18 19.17l-2.59-2.58z"/>
                </svg>
            </div>
            <div>
                <h1 style="margin:0;font-size:22px;display:flex;align-items:center;gap:8px;">
                    Report UTM
                    <span class="rutm-badge">v<?php echo esc_html( RUTM_VERSION ); ?></span>
                </h1>
                <p style="margin:0;font-size:12px;color:#64748b;">Diseñado por Robinson Zapata · Ad House</p>
            </div>
            <div style="margin-left:auto;">
                <?php if ( $conn_ok === true ) : ?>
                    <span class="rutm-status rutm-status-ok">✓ Conectado</span>
                <?php elseif ( $conn_ok === false ) : ?>
                    <span class="rutm-status rutm-status-fail">✕ Sin conexión</span>
                <?php else : ?>
                    <span class="rutm-status rutm-status-idle">Sin configurar</span>
                <?php endif; ?>
            </div>
        </div>

        <form method="post" action="options.php">
            <?php settings_fields( 'rutm_options_group' ); ?>

            <!-- Card 1: Configuración básica -->
            <div class="rutm-card">
                <p class="rutm-card-title"><span class="dashicons dashicons-admin-settings"></span> Configuración básica</p>
                <p class="rutm-card-desc">Mínimo necesario para que el pixel JS empiece a registrar visitantes y UTMs.</p>

                <div class="rutm-field">
                    <label>
                        <input type="checkbox" name="rutm_options[enabled]" value="1" <?php checked( ! empty( $options['enabled'] ) ); ?> style="margin-right:6px;">
                        Plugin activo
                    </label>
                    <span class="rutm-help">Cuando está desactivado, el pixel no se inyecta y los formularios no se trackean.</span>
                </div>

                <div class="rutm-field">
                    <label for="rutm-slug">Slug de cliente <span style="color:#ef4444;">*</span></label>
                    <input
                        type="text"
                        id="rutm-slug"
                        name="rutm_options[cliente_slug]"
                        value="<?php echo esc_attr( $options['cliente_slug'] ?? '' ); ?>"
                        placeholder="ej: mi-empresa"
                        autocomplete="off"
                    >
                    <span class="rutm-help">
                        Identificador único de tu cuenta en la plataforma Report UTM.<br>
                        Pedíselo a tu agencia Ad House o encontralo en: <strong>reportes.adshouse.cloud → tu empresa → Configuración → Slug</strong>
                    </span>
                </div>

                <div class="rutm-field">
                    <label>
                        <input type="checkbox" name="rutm_options[advanced_mode]" id="rutm-advanced-toggle" value="1" <?php checked( $advanced ); ?>>
                        Mostrar opciones avanzadas
                    </label>
                    <span class="rutm-help">Requerido para captura de leads (S2S Token) y propagación de UTMs a checkout.</span>
                </div>
            </div>

            <!-- Card 2: S2S y opciones avanzadas -->
            <div id="rutm-advanced-section">
                <div class="rutm-card">
                    <p class="rutm-card-title"><span class="dashicons dashicons-lock"></span> Integración S2S — Captura de leads</p>
                    <p class="rutm-card-desc">
                        El modo S2S (server-to-server) envía los datos de cada formulario desde PHP, sin depender del navegador ni de ad blockers.
                        Con esto se registran en la plataforma el nombre, email, teléfono y todos los campos del formulario, junto con la atribución UTM.
                    </p>

                    <div class="rutm-field">
                        <label for="rutm-token">S2S Token <span style="color:#ef4444;">*</span></label>
                        <input
                            type="password"
                            id="rutm-token"
                            name="rutm_options[s2s_token]"
                            value="<?php echo esc_attr( $options['s2s_token'] ?? '' ); ?>"
                            placeholder="Pegar el token generado en la plataforma"
                            autocomplete="new-password"
                        >
                        <span class="rutm-help">
                            <strong>Dónde obtenerlo:</strong> reportes.adshouse.cloud → tu cliente → tarjeta "Integración S2S" → "Activar S2S" → copiar el token.<br>
                            <strong>Seguridad:</strong> Este token nunca aparece en el HTML del sitio. Solo PHP lo usa para firmar los envíos con HMAC-SHA256.<br>
                            Si fue comprometido: rotarlo en la plataforma → "Rotar Token" → actualizarlo aquí.
                        </span>
                    </div>

                    <div class="rutm-field">
                        <label for="rutm-base-url">URL base de la plataforma</label>
                        <input
                            type="url"
                            id="rutm-base-url"
                            name="rutm_options[base_url]"
                            value="<?php echo esc_attr( $options['base_url'] ?? '' ); ?>"
                            placeholder="https://reportes.adshouse.cloud/ (default)"
                        >
                        <span class="rutm-help">Dejar en blanco para usar el servidor de Ad House. Cambiar solo si tenés instalación propia.</span>
                    </div>
                </div>

                <div class="rutm-card">
                    <p class="rutm-card-title"><span class="dashicons dashicons-share"></span> Propagación de UTMs a checkout</p>
                    <p class="rutm-card-desc">
                        El pixel JS añade automáticamente los UTMs del visitante a todos los links de pago del HTML.
                        Soporta links dinámicos (popups, modals) via MutationObserver.
                    </p>

                    <div class="rutm-field">
                        <label>
                            <input type="checkbox" name="rutm_options[propagate_utms]" value="1" <?php checked( ! empty( $options['propagate_utms'] ) ); ?>>
                            Propagar UTMs a links de checkout
                        </label>
                        <span class="rutm-help">
                            Cuando está activo, el script JS añade <code>?utm_source=X&utm_campaign=Y</code> a los links de pago.<br>
                            Dominios incluidos por defecto: <code>pay.hotmart.com</code>, <code>go.hotmart.com</code>,
                            <code>checkout.cartpanda.com</code>, <code>pay.kiwify.com.br</code>, <code>checkout.shopify.com</code>
                        </span>
                    </div>

                    <div class="rutm-field">
                        <label for="rutm-domains">Dominios de checkout adicionales</label>
                        <textarea
                            id="rutm-domains"
                            name="rutm_options[checkout_domains]"
                            rows="4"
                            placeholder="checkout.miplataforma.com&#10;pay.miempresa.com&#10;(uno por línea)"
                        ><?php echo esc_textarea( $options['checkout_domains'] ?? '' ); ?></textarea>
                        <span class="rutm-help">Un dominio por línea. Se agregan a los dominios por defecto, no los reemplazan.</span>
                    </div>
                </div>
            </div>

            <!-- Acciones -->
            <div class="rutm-actions">
                <?php submit_button( 'Guardar configuración', 'primary', 'submit', false, [ 'class' => 'rutm-btn rutm-btn-primary' ] ); ?>
                <?php if ( $has_s2s ) : ?>
                    <button type="button" id="rutm-test-btn" class="rutm-btn rutm-btn-secondary">
                        Enviar lead de prueba
                    </button>
                    <span id="rutm-test-result"></span>
                <?php endif; ?>
                <a href="https://reportes.adshouse.cloud/" target="_blank" rel="noopener" class="rutm-btn rutm-btn-secondary">
                    Abrir plataforma ↗
                </a>
            </div>
        </form>

        <!-- Card: Plugins de formulario detectados -->
        <div class="rutm-card" style="margin-top:24px;">
            <p class="rutm-card-title"><span class="dashicons dashicons-forms"></span> Plugins de formulario detectados</p>
            <p class="rutm-card-desc">
                Los envíos de los plugins marcados como activos se trackean automáticamente.
                <?php if ( $active_plugins_count === 0 ) : ?>
                    <strong>Ningún plugin de formulario está activo en este WordPress.</strong>
                <?php elseif ( ! $has_s2s ) : ?>
                    Configurá el S2S Token para que los leads se envíen a la plataforma.
                <?php else : ?>
                    <?php echo esc_html( $active_plugins_count ); ?> plugin(s) activos — los leads se registrarán automáticamente.
                <?php endif; ?>
            </p>
            <div class="rutm-plugin-list">
                <?php foreach ( $form_plugins as $plugin ) : ?>
                    <div class="rutm-plugin-item <?php echo $plugin['active'] ? 'active' : 'inactive'; ?>">
                        <span class="rutm-plugin-dot <?php echo $plugin['active'] ? 'active' : 'inactive'; ?>"></span>
                        <div>
                            <strong><?php echo esc_html( $plugin['label'] ); ?></strong><br>
                            <span style="font-size:10px;opacity:.7;"><?php echo esc_html( $plugin['hook'] ); ?></span>
                        </div>
                    </div>
                <?php endforeach; ?>
            </div>
        </div>

        <!-- Card: Modelo de atribución -->
        <div class="rutm-card">
            <p class="rutm-card-title"><span class="dashicons dashicons-chart-line"></span> Modelo de atribución multi-touch</p>
            <p class="rutm-card-desc">Cómo la plataforma determina el origen de cada lead (en cascada — usa el más preciso disponible).</p>
            <div class="rutm-attr-grid">
                <div class="rutm-attr-item">
                    <div class="rutm-attr-label" style="color:#7c3aed;">1 · click_id</div>
                    <div class="rutm-attr-value">Click en anuncio de Meta (fbclid) o Google (gclid). Atribución más precisa, directa al ad.</div>
                </div>
                <div class="rutm-attr-item">
                    <div class="rutm-attr-label" style="color:#2563eb;">2 · visitor_cookie</div>
                    <div class="rutm-attr-value">Cookie rutm_vid (90 días) cruzada con historial de UTMs del visitante. Funciona entre sesiones.</div>
                </div>
                <div class="rutm-attr-item">
                    <div class="rutm-attr-label" style="color:#d97706;">3 · utm_only</div>
                    <div class="rutm-attr-value">Solo UTMs en la URL, sin click_id ni cookie. El origen se puede verificar contra el lead.</div>
                </div>
                <div class="rutm-attr-item">
                    <div class="rutm-attr-label" style="color:#6b7280;">4 · none</div>
                    <div class="rutm-attr-value">Sin información de origen. Llegó directo o el navegador bloqueó las cookies.</div>
                </div>
            </div>
        </div>

        <!-- Card: Guía de configuración -->
        <div class="rutm-card">
            <p class="rutm-card-title"><span class="dashicons dashicons-list-view"></span> Guía de verificación paso a paso</p>
            <p class="rutm-card-desc">Seguí estos pasos para confirmar que todo está funcionando.</p>
            <ol class="rutm-steps">
                <li>
                    Activar el plugin y guardar el <strong>Slug de cliente</strong>.<br>
                    <em style="color:#6b7280;">El pixel JS ya empieza a registrar UTMs y cookies en el sitio.</em>
                </li>
                <li>
                    Abrir el sitio con DevTools → Aplicación → Cookies.<br>
                    Verificar que existen: <code>rutm_vid</code>, <code>rutm_sid</code>, <code>rutm_ft</code>, <code>rutm_lt</code>.
                </li>
                <li>
                    Entrar al sitio con UTMs: <code>tusitio.com?utm_source=facebook&utm_campaign=test</code><br>
                    Verificar que <code>rutm_lt</code> contiene los UTMs.
                </li>
                <li>
                    En la plataforma: <strong>reportes.adshouse.cloud → tu cliente → Integración S2S → Activar</strong><br>
                    Copiar el token generado → pegarlo en el campo S2S Token de esta página.
                </li>
                <li>
                    Guardar la configuración. El indicador de estado debe mostrar <strong>✓ Conectado</strong>.
                </li>
                <li>
                    Usar el botón <strong>"Enviar lead de prueba"</strong>.<br>
                    Verificar en reportes.adshouse.cloud → Leads que el lead aparece.
                </li>
                <li>
                    Enviar un formulario real desde el sitio.<br>
                    Verificar que aparece con nombre, email, UTMs y atribución correctos.
                </li>
            </ol>

            <?php if ( empty( $options['enabled'] ) || empty( $options['cliente_slug'] ) ) : ?>
                <div class="rutm-alert warn">
                    <span class="dashicons dashicons-warning" style="flex-shrink:0;"></span>
                    <span>El plugin no está activo o falta el slug. Completá la configuración básica y guardá los cambios.</span>
                </div>
            <?php elseif ( ! $has_s2s ) : ?>
                <div class="rutm-alert info">
                    <span class="dashicons dashicons-info" style="flex-shrink:0;"></span>
                    <span>El pixel JS está activo. Para capturar leads de formularios, activá el <strong>Modo avanzado</strong> e ingresá el S2S Token.</span>
                </div>
            <?php endif; ?>
        </div>

        <!-- Footer -->
        <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:8px;padding-bottom:32px;">
            Report UTM v<?php echo esc_html( RUTM_VERSION ); ?> · Diseñado por <strong>Robinson Zapata</strong> para
            <a href="https://adshouse.cloud/" target="_blank" rel="noopener" style="color:#10b981;text-decoration:none;">Ad House</a>
        </p>
    </div>

    <script>
    document.addEventListener('DOMContentLoaded', function () {
        // Toggle modo avanzado
        var toggle  = document.getElementById('rutm-advanced-toggle');
        var section = document.getElementById('rutm-advanced-section');
        if (toggle && section) {
            toggle.addEventListener('change', function () {
                section.style.display = this.checked ? 'block' : 'none';
            });
        }

        // Botón "Enviar lead de prueba"
        var testBtn    = document.getElementById('rutm-test-btn');
        var testResult = document.getElementById('rutm-test-result');
        if (testBtn && testResult) {
            testBtn.addEventListener('click', function () {
                testBtn.disabled    = true;
                testBtn.textContent = 'Enviando…';
                testResult.className     = '';
                testResult.style.display = 'none';

                fetch(ajaxurl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        action: 'rutm_test_lead',
                        nonce:  '<?php echo esc_js( wp_create_nonce( 'rutm_test_lead' ) ); ?>'
                    })
                })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    testResult.textContent = data.data || (data.success ? '¡Enviado!' : 'Error desconocido');
                    testResult.className   = data.success ? 'ok' : 'fail';
                })
                .catch(function () {
                    testResult.textContent = 'Error de red. Intentá de nuevo.';
                    testResult.className   = 'fail';
                })
                .finally(function () {
                    testBtn.disabled    = false;
                    testBtn.textContent = 'Enviar lead de prueba';
                });
            });
        }
    });
    </script>
    <?php
}
