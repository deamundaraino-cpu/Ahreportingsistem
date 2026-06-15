/*!
 * Report-UTM Pixel · v1.0
 *
 * Instalación:
 *   <script>
 *     window.RUTM_CONFIG = { cliente: 'mi-cliente-slug' };
 *   </script>
 *   <script async src="https://reportes.adshouse.cloud/report-utm-pixel.js"></script>
 *
 * API:
 *   rutm('track', 'lead', { plan: 'pro' });
 *   rutm('track', 'addtocart', { value: 99.9 });
 *   rutm('pageview');  // se dispara automáticamente
 */
(function () {
    'use strict';

    var config = window.RUTM_CONFIG || {};
    var slug = config.cliente || config.client_slug || config.slug;

    if (!slug) {
        if (window.console) console.warn('[rutm] missing window.RUTM_CONFIG.cliente — pixel inactive');
        return;
    }

    var endpoint = (config.endpoint || resolveEndpoint()) + '/api/report-utm/pixel/event';

    function resolveEndpoint() {
        var scripts = document.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
            var src = scripts[i].src || '';
            var m = src.match(/^(https?:\/\/[^/]+)\/report-utm-pixel\.js/);
            if (m) return m[1];
        }
        return location.origin;
    }

    // ── Cookies helpers ─────────────────────────────────────────
    function readCookie(name) {
        var pairs = document.cookie ? document.cookie.split('; ') : [];
        for (var i = 0; i < pairs.length; i++) {
            var idx = pairs[i].indexOf('=');
            if (idx === -1) continue;
            if (pairs[i].slice(0, idx) === name) {
                return decodeURIComponent(pairs[i].slice(idx + 1));
            }
        }
        return null;
    }

    function writeCookie(name, value, days) {
        var expires = '';
        if (days) {
            var d = new Date();
            d.setTime(d.getTime() + days * 86400000);
            expires = '; expires=' + d.toUTCString();
        }
        document.cookie =
            name + '=' + encodeURIComponent(value) + expires + '; path=/; SameSite=Lax';
    }

    function uuid32() {
        var s = '';
        for (var i = 0; i < 32; i++) {
            s += Math.floor(Math.random() * 16).toString(16);
        }
        return s;
    }

    function getOrCreateVisitorId() {
        var v = readCookie('rutm_vid');
        if (v && /^[a-f0-9]{32}$/.test(v)) return v;
        v = uuid32();
        writeCookie('rutm_vid', v, 90);
        return v;
    }

    function getOrCreateSessionId() {
        var s = readCookie('rutm_sid');
        if (s && /^[a-f0-9]{16}$/.test(s)) return s;
        s = uuid32().slice(0, 16);
        writeCookie('rutm_sid', s, 0); // session cookie
        return s;
    }

    // ── URL parsing ─────────────────────────────────────────────
    function getQueryParam(name) {
        try {
            var sp = new URLSearchParams(location.search);
            return sp.get(name);
        } catch (e) {
            return null;
        }
    }

    function captureFirstTouch() {
        var existing = readCookie('rutm_ft');
        if (existing) return;

        var touch = {
            source: getQueryParam('utm_source'),
            medium: getQueryParam('utm_medium'),
            campaign: getQueryParam('utm_campaign'),
            content: getQueryParam('utm_content'),
            term: getQueryParam('utm_term'),
            click_id:
                getQueryParam('fbclid') ||
                getQueryParam('gclid') ||
                getQueryParam('ttclid') ||
                getQueryParam('click_id'),
            ts: new Date().toISOString(),
            referrer: document.referrer || null,
        };

        var hasSignal = touch.source || touch.campaign || touch.click_id || touch.medium;
        if (hasSignal) {
            writeCookie('rutm_ft', JSON.stringify(touch), 90);
            writeCookie('rutm_lt', JSON.stringify(touch), 90);
        }
    }

    captureFirstTouch();

    var visitorId = getOrCreateVisitorId();
    var sessionId = getOrCreateSessionId();

    // ── UTM propagation a links de checkout ─────────────────────
    // Propaga UTMs y visitor_id a links que apunten a plataformas de checkout
    // para que no se pierdan cuando el usuario hace clic en "Comprar".
    // Se puede desactivar con: window.RUTM_CONFIG = { propagate_utms: false }
    var CHECKOUT_DOMAINS = config.checkout_domains || [
        'pay.hotmart.com',
        'go.hotmart.com',
        'hotmart.product.',
        'checkout.cartpanda.com',
        'pay.cartpanda.com',
        'pay.kiwify.com.br',
        'checkout.kiwify.com.br',
        'pay.monetizze.com.br',
    ];

    function isCheckoutLink(href) {
        if (!href) return false;
        try {
            for (var i = 0; i < CHECKOUT_DOMAINS.length; i++) {
                if (href.indexOf(CHECKOUT_DOMAINS[i]) !== -1) return true;
            }
        } catch (e) {}
        return false;
    }

    function buildUTMsForPropagation() {
        var utms = {};
        var params = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
        var hasPageUtms = false;
        for (var i = 0; i < params.length; i++) {
            var v = getQueryParam(params[i]);
            if (v) { utms[params[i]] = v; hasPageUtms = true; }
        }
        // Fallback: leer del cookie last-touch si la página no tiene UTMs propios
        if (!hasPageUtms) {
            try {
                var lt = readCookie('rutm_lt');
                if (lt) {
                    var touch = JSON.parse(lt);
                    if (touch.source)   utms['utm_source']   = touch.source;
                    if (touch.medium)   utms['utm_medium']   = touch.medium;
                    if (touch.campaign) utms['utm_campaign']  = touch.campaign;
                    if (touch.content)  utms['utm_content']  = touch.content;
                    if (touch.term)     utms['utm_term']     = touch.term;
                }
            } catch (e) {}
        }
        return utms;
    }

    function decorateCheckoutLinks(root) {
        var utms = buildUTMsForPropagation();
        var links = (root || document).getElementsByTagName('a');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var href = a.getAttribute('href') || '';
            if (!isCheckoutLink(href)) continue;
            try {
                var url = new URL(href, location.origin);
                var keys = Object.keys(utms);
                for (var k = 0; k < keys.length; k++) {
                    if (!url.searchParams.has(keys[k])) {
                        url.searchParams.set(keys[k], utms[keys[k]]);
                    }
                }
                // src = visitor_id para Hotmart y param adicional para CartPanda
                if (!url.searchParams.has('src')) {
                    url.searchParams.set('src', visitorId);
                }
                a.setAttribute('href', url.toString());
            } catch (e) {}
        }
    }

    if (config.propagate_utms !== false) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { decorateCheckoutLinks(); });
        } else {
            decorateCheckoutLinks();
        }
        // Observar inserciones dinámicas (popups, Elementor, etc.)
        try {
            var observer = new MutationObserver(function (mutations) {
                for (var i = 0; i < mutations.length; i++) {
                    var added = mutations[i].addedNodes;
                    for (var j = 0; j < added.length; j++) {
                        if (added[j].nodeType === 1) decorateCheckoutLinks(added[j]);
                    }
                }
            });
            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true,
            });
        } catch (e) {}
    }

    // ── Send ────────────────────────────────────────────────────
    function send(eventType, eventName, customData) {
        var payload = {
            cliente_slug: slug,
            event_type: eventType,
            event_name: eventName || null,
            visitor_id: visitorId,
            session_id: sessionId,
            page_url: location.href,
            page_title: document.title,
            referrer: document.referrer || null,
            utm_source: getQueryParam('utm_source'),
            utm_medium: getQueryParam('utm_medium'),
            utm_campaign: getQueryParam('utm_campaign'),
            utm_content: getQueryParam('utm_content'),
            utm_term: getQueryParam('utm_term'),
            click_id:
                getQueryParam('fbclid') ||
                getQueryParam('gclid') ||
                getQueryParam('ttclid') ||
                getQueryParam('click_id'),
            custom_data: customData || null,
        };

        var json = JSON.stringify(payload);

        // Preferir sendBeacon (no bloquea unload)
        if (navigator.sendBeacon) {
            try {
                var blob = new Blob([json], { type: 'application/json' });
                if (navigator.sendBeacon(endpoint, blob)) return;
            } catch (e) {
                /* fallback */
            }
        }

        try {
            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: json,
                keepalive: true,
                mode: 'cors',
                credentials: 'omit',
            }).catch(function () {});
        } catch (e) {
            /* swallow */
        }
    }

    // ── Public API ──────────────────────────────────────────────
    function rutm() {
        var args = Array.prototype.slice.call(arguments);
        var cmd = args[0];

        if (cmd === 'track') {
            send('custom', args[1], args[2]);
        } else if (cmd === 'pageview') {
            send('pageview', null, args[1]);
        } else if (cmd === 'identify') {
            // Reservado para futuro: send('identify', null, { userId: args[1] });
        } else if (window.console) {
            console.warn('[rutm] unknown command:', cmd);
        }
    }

    // Drenar cola previa (si el pixel se cargó después de la primera llamada)
    var queued = window.rutm && window.rutm.q ? window.rutm.q : [];
    window.rutm = rutm;
    for (var i = 0; i < queued.length; i++) {
        try {
            rutm.apply(null, queued[i]);
        } catch (e) {}
    }

    // Auto pageview (excepto si se desactiva explícito)
    if (config.autoPageview !== false) {
        send('pageview', null, null);
    }
})();
