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
