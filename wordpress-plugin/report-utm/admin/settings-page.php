<?php
/**
 * Página de configuración en WP Admin → Ajustes → Report UTM.
 * Modo simple: solo slug + toggle.
 * Modo avanzado: S2S token, dominios custom, selección de plugins.
 */

if ( ! defined( 'ABSPATH' ) ) exit;

function rutm_sanitize_options( array $input ): array {
    $clean = [];
    $clean['enabled']          = ! empty( $input['enabled'] ) ? 1 : 0;
    $clean['cliente_slug']     = sanitize_text_field( $input['cliente_slug'] ?? '' );
    $clean['base_url']         = esc_url_raw( $input['base_url'] ?? 'https://reportes.adshouse.cloud/' );
    $clean['s2s_token']        = sanitize_text_field( $input['s2s_token'] ?? '' );
    $clean['propagate_utms']   = ! empty( $input['propagate_utms'] ) ? 1 : 0;
    $clean['checkout_domains'] = sanitize_textarea_field( $input['checkout_domains'] ?? '' );
    $clean['advanced_mode']    = ! empty( $input['advanced_mode'] ) ? 1 : 0;
    return $clean;
}

function rutm_render_settings_page(): void {
    if ( ! current_user_can( 'manage_options' ) ) return;

    $options      = get_option( 'rutm_options', [] );
    $advanced     = ! empty( $options['advanced_mode'] );
    $is_connected = rutm_check_connection( $options );

    ?>
    <div class="wrap">
        <h1>
            <span style="display:inline-flex;align-items:center;gap:8px;">
                📊 Report UTM — Ad House
            </span>
        </h1>

        <?php if ( $is_connected === true ): ?>
            <div class="notice notice-success is-dismissible">
                <p>✅ <strong>Conectado</strong> — el endpoint S2S responde correctamente.</p>
            </div>
        <?php elseif ( $is_connected === false && ! empty( $options['enabled'] ) ): ?>
            <div class="notice notice-warning is-dismissible">
                <p>⚠️ No se pudo verificar la conexión con Report UTM. Revisá el Slug y el S2S Token.</p>
            </div>
        <?php endif; ?>

        <form method="post" action="options.php">
            <?php settings_fields( 'rutm_options_group' ); ?>

            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row">Activar plugin</th>
                    <td>
                        <label>
                            <input type="checkbox" name="rutm_options[enabled]" value="1" <?php checked( 1, $options['enabled'] ?? 0 ); ?> />
                            Inyectar pixel y capturar leads
                        </label>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="rutm_slug">Slug del cliente</label></th>
                    <td>
                        <input
                            type="text"
                            id="rutm_slug"
                            name="rutm_options[cliente_slug]"
                            value="<?php echo esc_attr( $options['cliente_slug'] ?? '' ); ?>"
                            class="regular-text"
                            placeholder="mi-empresa"
                        />
                        <p class="description">El slug que te dio Ad House para tu cuenta.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row">Modo avanzado</th>
                    <td>
                        <label>
                            <input type="checkbox" name="rutm_options[advanced_mode]" value="1" <?php checked( 1, $options['advanced_mode'] ?? 0 ); ?> id="rutm_advanced_toggle" />
                            Mostrar opciones avanzadas
                        </label>
                    </td>
                </tr>
            </table>

            <div id="rutm-advanced-section" style="<?php echo $advanced ? '' : 'display:none'; ?>">
                <h2>Opciones avanzadas</h2>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="rutm_base_url">URL base de Report UTM</label></th>
                        <td>
                            <input
                                type="url"
                                id="rutm_base_url"
                                name="rutm_options[base_url]"
                                value="<?php echo esc_attr( $options['base_url'] ?? 'https://reportes.adshouse.cloud/' ); ?>"
                                class="regular-text"
                            />
                            <p class="description">Solo cambiar si usás una instancia propia.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="rutm_s2s_token">S2S Token</label></th>
                        <td>
                            <input
                                type="password"
                                id="rutm_s2s_token"
                                name="rutm_options[s2s_token]"
                                value="<?php echo esc_attr( $options['s2s_token'] ?? '' ); ?>"
                                class="regular-text"
                                autocomplete="new-password"
                            />
                            <p class="description">
                                Token secreto para autenticar el envío server-side (S2S).
                                Lo encontrás en Report UTM → tu cliente → Integración S2S.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Propagar UTMs</th>
                        <td>
                            <label>
                                <input type="checkbox" name="rutm_options[propagate_utms]" value="1" <?php checked( 1, $options['propagate_utms'] ?? 1 ); ?> />
                                Añadir UTMs automáticamente a links de checkout en el contenido
                            </label>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="rutm_checkout_domains">Dominios de checkout</label></th>
                        <td>
                            <textarea
                                id="rutm_checkout_domains"
                                name="rutm_options[checkout_domains]"
                                rows="6"
                                class="large-text"
                                placeholder="pay.hotmart.com&#10;checkout.cartpanda.com&#10;pay.kiwify.com.br"
                            ><?php echo esc_textarea( $options['checkout_domains'] ?? '' ); ?></textarea>
                            <p class="description">Un dominio por línea. Si está vacío se usan los dominios predeterminados (Hotmart, CartPanda, Shopify, Kiwify, Monetizze).</p>
                        </td>
                    </tr>
                </table>

                <h2>Estado de conexión</h2>
                <p>
                    <?php
                    if ( $is_connected === true ) {
                        echo '<span style="color:#00a32a;font-weight:600;">✅ Conectado</span>';
                    } elseif ( ! empty( $options['enabled'] ) && ! empty( $options['cliente_slug'] ) ) {
                        echo '<span style="color:#d63638;font-weight:600;">❌ Sin conexión</span> — verificá el Slug y el Token.';
                    } else {
                        echo '<em>Activá el plugin y guardá para verificar.</em>';
                    }
                    ?>
                </p>
            </div>

            <?php submit_button( 'Guardar configuración' ); ?>
        </form>
    </div>

    <script>
    (function() {
        var toggle = document.getElementById('rutm_advanced_toggle');
        var section = document.getElementById('rutm-advanced-section');
        if (toggle && section) {
            toggle.addEventListener('change', function() {
                section.style.display = this.checked ? '' : 'none';
            });
        }
    })();
    </script>
    <?php
}

/**
 * Hace un ping al endpoint de health-check S2S para verificar la conexión.
 * Devuelve true/false/null (null = sin datos suficientes para intentar).
 */
function rutm_check_connection( array $options ): ?bool {
    if ( empty( $options['enabled'] ) || empty( $options['cliente_slug'] ) ) return null;

    $base_url = ! empty( $options['base_url'] ) ? $options['base_url'] : 'https://reportes.adshouse.cloud/';
    $url      = trailingslashit( $base_url ) . 'api/report-utm/pixel/s2s';

    $response = wp_remote_get( $url, [ 'timeout' => 5 ] );
    if ( is_wp_error( $response ) ) return false;

    $code = wp_remote_retrieve_response_code( $response );
    // El endpoint GET devuelve 200 con { ok: true }
    return $code >= 200 && $code < 300;
}
