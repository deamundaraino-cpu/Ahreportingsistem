=== Report UTM — Ad House ===
Contributors: adshouse, robinsonzapata
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.3.1
License: Proprietary — Ad House Internal Use

Tracking UTM server-side para WordPress. Capta leads de formularios con atribución multi-touch, propaga UTMs a checkout y registra cada conversión con primer y último toque.

== Description ==

Report UTM conecta tu sitio WordPress con la plataforma de análisis de Ad House para que puedas saber exactamente qué campaña generó cada lead y cada venta, aunque el visitante tarde días en convertir.

Diseñado por **Robinson Zapata** para **Ad House**.

= Cómo funciona =

**1. Pixel JS (frontend)**

El plugin inyecta automáticamente el script report-utm-pixel.js en el `<head>` de cada página. Ese script:

* Crea o renueva cookies first-party de 90 días: `rutm_vid` (visitor ID), `rutm_sid` (session ID), `rutm_ft` (first touch), `rutm_lt` (last touch)
* Captura UTMs de la URL: utm_source, utm_campaign, utm_medium, utm_content, utm_term
* Detecta click IDs de ads: fbclid (Meta), gclid (Google Ads), ttclid (TikTok)
* Propaga UTMs a links de checkout (Hotmart, CartPanda, Shopify, etc.) via MutationObserver para links dinámicos

**2. Captura de leads S2S (server-to-server)**

Cuando un visitante envía un formulario, el plugin lo detecta desde PHP y envía todos los datos al servidor de Ad House firmados con HMAC-SHA256. No depende del navegador, por lo que funciona aunque el visitante use un ad blocker.

Por cada lead se registran:

* Nombre, email, teléfono (mapeados automáticamente)
* Todos los campos del formulario en `raw_fields` (sin filtrar)
* UTMs activos al momento del envío
* Visitor ID para atribución cross-session
* IP, país, user agent, URL de la página

**3. Atribución multi-touch**

La plataforma cruza el visitor_id del lead con el historial de eventos del pixel para determinar primer toque (qué anuncio trajo al visitante) y último toque (qué anuncio estaba activo al enviar el formulario).

Métodos de atribución (cascada):
1. `click_id` — click directo en ad con fbclid/gclid (más preciso)
2. `visitor_cookie` — cookie rutm_vid cruzada con historial de eventos
3. `utm_only` — UTMs directos en la URL
4. `none` — sin información de origen

= Formularios soportados =

* **Elementor Pro Forms** — mapeo por tipo de campo (email/tel/text)
* **Contact Form 7** — mapeo por nombre de campo (your-email, email, correo...)
* **Gravity Forms** — mapeo por tipo de campo GF ($field->type)
* **WPForms** — mapeo por tipo de campo WPForms ($field['type'])

**Campos personalizados:** todos los campos del formulario se envían en `raw_fields` sin filtrar. Se pueden consultar en la plataforma abriendo el detalle de cada lead.

= Características técnicas =

* Sin cookies de terceros — todo en cookies first-party SameSite=Lax de 90 días
* Autenticación HMAC-SHA256 — el S2S Token nunca aparece en el HTML del sitio
* Fire-and-forget — wp_remote_post con blocking=false, sin retraso en la carga
* MutationObserver — detecta links de checkout que aparecen dinámicamente

== Instalación ==

1. Subir el archivo `report-utm.zip` en WP Admin → Plugins → Añadir nuevo → Subir plugin
2. Activar el plugin
3. Ir a Ajustes → Report UTM
4. Ingresar el Slug de cliente (provisto por Ad House)
5. Activar el toggle "Plugin activo" y guardar

Para habilitar captura de leads:

6. Activar "Mostrar opciones avanzadas"
7. Ingresar el S2S Token (desde reportes.adshouse.cloud → tu cliente → Integración S2S)
8. Guardar → verificar con el botón "Enviar lead de prueba"

== Frequently Asked Questions ==

= ¿Necesito conocimientos técnicos? =

No. La configuración básica requiere solo el Slug de cliente que te provee Ad House.

= ¿Qué es el S2S Token y dónde lo obtengo? =

Es un token secreto que autentica los envíos del plugin hacia la plataforma. Lo obtenés en reportes.adshouse.cloud → tu cliente → tarjeta "Integración S2S" → botón "Activar S2S".

= ¿Funciona con page builders? =

Sí. El pixel JS usa MutationObserver para detectar links que se inyectan dinámicamente (Elementor popups, Divi, etc.).

= ¿Qué pasa si el visitante usa un ad blocker? =

Con el S2S Token configurado, los envíos de formularios se registran desde el servidor PHP, sin depender del navegador del visitante.

= ¿Los campos personalizados del formulario también se capturan? =

Sí. Todos los campos se envían en el campo raw_fields sin filtrar. En la plataforma podés ver todos los campos abriendo el detalle de cada lead.

= ¿Qué cookies instala el plugin? =

Las 4 cookies del pixel (rutm_vid, rutm_sid, rutm_ft, rutm_lt) son first-party, SameSite=Lax, duración 90 días. No se comparten con terceros ni se usan para fingerprinting.

= ¿Cómo funciona la propagación de UTMs a checkout? =

El pixel JS detecta links a dominios de checkout (Hotmart, CartPanda, Shopify, etc.) y les añade los UTMs actuales del visitante como query parameters. Esto asegura que la plataforma de pago también reciba la información de la campaña.

= ¿Afecta la velocidad del sitio? =

Mínimamente. El pixel JS se carga con `defer` para no bloquear el renderizado. Los envíos S2S usan `wp_remote_post` con `blocking: false` (fire-and-forget), por lo que el servidor no espera la respuesta antes de servir la página al visitante.

= ¿Dónde puedo ver los leads capturados? =

En reportes.adshouse.cloud → sección "Leads". Podés filtrar por cliente, plugin, UTM source y rango de fechas.

== Changelog ==

= 0.3.1 =
* Fix: el ZIP ahora se empaqueta con separadores '/' (antes usaba '\', lo que rompía la instalación en servidores Linux con un error fatal en los require_once)
* Fix: polyfills para str_contains/str_starts_with para compatibilidad real con PHP 7.4
* Fix: carga defensiva de archivos — si falta un archivo, muestra un aviso en el admin en vez de un error fatal
* Fix: "Enviar lead de prueba" ahora es bloqueante y reporta el código HTTP real (200/401/403/404) en vez de un éxito falso
* Fix: el mensaje del botón de prueba ahora siempre se muestra (corregido un conflicto de CSS)

= 0.3.0 =
* Extracción completa de campos: lead_name, lead_email, lead_phone por tipo de campo
* raw_fields: todos los campos del formulario sin filtrar (JSONB en la plataforma)
* Soporte mejorado para Elementor Pro (mapeo por tipo de widget)
* Soporte mejorado para CF7 (búsqueda exacta + substring)
* Soporte mejorado para Gravity Forms (campos nombre divididos .3/.6)
* Soporte mejorado para WPForms (mapeo por type + label fallback)
* Panel de admin rediseñado con guía de configuración integrada
* Detección automática de plugins de formulario instalados y activos
* Botón "Enviar lead de prueba" (AJAX) para verificar la integración
* Documentación completa embebida en todos los archivos del plugin

= 0.2.0 =
* Endpoint S2S autenticado con HMAC-SHA256
* Propagación automática de UTMs a links de checkout
* MutationObserver para links dinámicos (popups, modals de Elementor)
* Panel de admin con modo simple / avanzado
* Verificación de conexión al endpoint S2S

= 0.1.0 =
* Versión inicial
* Inyección del pixel JS report-utm-pixel.js
* Hooks básicos para CF7, GF, WPForms, Elementor Pro
* Panel de configuración básico

== Upgrade Notice ==

= 0.3.1 =
Corrige el error fatal de instalación causado por el empaquetado del ZIP. Si la versión anterior no se pudo activar, borrala y subí este ZIP nuevo.

= 0.3.0 =
Esta versión requiere que ejecutes la migración SQL 030_report_utm_lead_events.sql en Supabase Studio para crear la tabla lead_events. Sin esta migración, los leads se seguirán registrando en pixel_events pero no tendrán datos de contacto estructurados.
