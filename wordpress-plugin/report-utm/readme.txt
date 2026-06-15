=== Report UTM — Ad House ===
Contributors: adshouse
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: Proprietary

Tracking UTM server-side para WordPress con atribución multi-touch. Capta leads y propaga UTMs a Hotmart, CartPanda, Shopify y más.

== Description ==

Report UTM conecta tu sitio WordPress con la plataforma de análisis de Ad House para que puedas saber exactamente qué campaña generó cada venta, aunque el comprador tarde días en decidirse.

= Características =

* **Pixel JS automático** — se inyecta en todo el sitio sin tocar código
* **Tracking S2S** — los envíos de formularios se registran desde el servidor, evitando ad blockers
* **Propagación de UTMs** — los links a páginas de pago reciben automáticamente los UTMs del visitante
* **Soporte para formularios:** Contact Form 7, Gravity Forms, WPForms, Elementor Pro
* **Multi-touch** — registra primer y último toque antes de la conversión
* **Sin cookies de terceros** — todo en cookies first-party de 90 días

= Configuración rápida =

1. Instalá el plugin
2. Andá a Ajustes → Report UTM
3. Ingresá tu Slug de cliente (te lo da Ad House)
4. Activá el plugin y guardá
5. ¡Listo! El pixel ya está activo

= Opciones avanzadas =

Para habilitar el tracking S2S (recomendado):
1. Activá el modo avanzado
2. Ingresá el S2S Token desde Report UTM → tu cliente → Integración S2S
3. Guardá

== Frequently Asked Questions ==

= ¿Necesito conocimientos técnicos? =

No. La configuración básica requiere solo tu Slug de cliente.

= ¿Funciona con page builders? =

Sí. El pixel JS usa MutationObserver para detectar links que se inyectan dinámicamente (Elementor, Divi, etc.).

= ¿Qué pasa si el visitante usa un ad blocker? =

Con el S2S Token configurado, los envíos de formularios se registran desde el servidor PHP, sin depender del navegador.

== Changelog ==

= 1.0.0 =
* Versión inicial.
* Pixel JS con propagación de UTMs.
* Hooks para CF7, Gravity Forms, WPForms y Elementor Pro.
* Envío S2S autenticado con HMAC-SHA256.
* Panel de administración simple + modo avanzado.
