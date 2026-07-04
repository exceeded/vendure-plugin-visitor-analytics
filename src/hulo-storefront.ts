/**
 * The single-file storefront helper the plugin serves at /ees/hulo.js.
 *
 * Written as a string constant (not a bundled module) because:
 *   - It's tiny (< 6kB minified) — a bundler adds more than the code
 *   - It ships to the browser verbatim, no compile step
 *   - Customers can inspect / audit it without a source map
 *   - It has ZERO npm dependencies at runtime
 *
 * The controller wraps this in a small template that injects the
 * public base URL and a default channel id, so a storefront paste
 * of `<script src="https://backend/ees/hulo.js"></script>` Just Works
 * with no config. Advanced users can call `hulo.configure({ ... })`
 * to override.
 */
export const HULO_STOREFRONT_JS = (backendBaseUrl: string, defaultChannelId = 1): string => `
// hulo storefront helper — @huloglobal/vendure-plugin-visitor-analytics
// Public domain when served from your own store; do not resell.
(function (global) {
  var CONFIG = {
    endpoint: ${JSON.stringify(backendBaseUrl.replace(/\/$/, '') + '/ees/track')},
    recoverEndpoint: ${JSON.stringify(backendBaseUrl.replace(/\/$/, '') + '/ees/recover-cart')},
    channelId: ${defaultChannelId},
    debug: false,
    autoRageClick: true,
    autoDeadClick: true,
    autoScroll: false,   // not implemented yet — flag reserved
  };

  // ── queue + batched send ─────────────────────────────────────────
  // Every helper below pushes into a queue. Flush on requestIdleCallback
  // or 2s max. Coalesces bursts of events into one HTTP roundtrip.
  var QUEUE = [];
  var FLUSH_TIMER = null;
  function enqueue(event) {
    event.url = event.url || location.href;
    event.channelId = event.channelId || CONFIG.channelId;
    QUEUE.push(event);
    scheduleFlush();
    if (CONFIG.debug) console.log('[hulo]', event);
  }
  function scheduleFlush() {
    if (FLUSH_TIMER) return;
    FLUSH_TIMER = setTimeout(flush, 1500);
  }
  function flush() {
    FLUSH_TIMER = null;
    if (!QUEUE.length) return;
    var batch = QUEUE.splice(0, QUEUE.length);
    var payload = JSON.stringify({ events: batch });
    // Prefer sendBeacon on unload (survives page transitions) and
    // fall back to fetch keepalive for normal calls.
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon(CONFIG.endpoint, blob)) return;
      }
    } catch (_e) {}
    try {
      fetch(CONFIG.endpoint, {
        method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: payload,
      }).catch(function () { /* silent */ });
    } catch (_e) {}
  }
  // Flush before the page dies.
  window.addEventListener('pagehide', flush, { capture: true });
  window.addEventListener('beforeunload', flush, { capture: true });

  // ── public API ───────────────────────────────────────────────────
  var hulo = {
    configure: function (opts) { Object.assign(CONFIG, opts || {}); },
    flush: flush,

    /** Fire once per pageview. Optional — the ingest endpoint infers
     *  pageviews from the referrer / URL, but calling this explicitly
     *  captures the title too. */
    pageview: function (extra) {
      enqueue(Object.assign({ type: 'pageview', title: document.title }, extra || {}));
    },

    /** Product detail viewed. Store the product id you would use to
     *  fetch the product server-side (Vendure product.id). If your
     *  storefront uses variants primarily, pass variantId too. */
    productView: function (productId, productVariantId) {
      if (!productId && productId !== 0) return;
      enqueue({
        type: 'event',
        meta: JSON.stringify({
          eventType: 'product_view',
          productId: Number(productId),
          productVariantId: productVariantId != null ? Number(productVariantId) : undefined,
        }),
      });
    },

    /** Item added to cart. Fire on every add — not just the first. */
    addToCart: function (variantId, qty, unitPriceMinor) {
      enqueue({
        type: 'event',
        meta: JSON.stringify({
          eventType: 'add_to_cart',
          variantId: variantId != null ? Number(variantId) : undefined,
          qty: qty != null ? Number(qty) : 1,
          unitPriceMinor: unitPriceMinor != null ? Number(unitPriceMinor) : undefined,
        }),
      });
    },

    /** Cart snapshot — fire on every cart change (add / remove / qty).
     *  The abandonment scanner reads only this event, so fire it
     *  liberally. Payload shape:
     *   { currency, totalMinor, itemCount, items: [{ variantId, name, qty, unitPriceMinor }], email? } */
    cartSnapshot: function (cart) {
      if (!cart || !cart.items || !cart.items.length) return;
      enqueue({
        type: 'event',
        meta: JSON.stringify({
          eventType: 'cart_snapshot',
          currency: (cart.currency || 'GBP').toUpperCase().slice(0, 3),
          totalMinor: Number(cart.totalMinor || 0),
          itemCount: Number(cart.itemCount || cart.items.length),
          items: cart.items.map(function (i) {
            return {
              variantId: i.variantId != null ? Number(i.variantId) : undefined,
              productId: i.productId != null ? Number(i.productId) : undefined,
              name: i.name != null ? String(i.name).slice(0, 200) : undefined,
              qty: Number(i.qty != null ? i.qty : (i.quantity != null ? i.quantity : 1)),
              unitPriceMinor: Number(i.unitPriceMinor != null ? i.unitPriceMinor : (i.unitPrice != null ? i.unitPrice : 0)),
              sku: i.sku != null ? String(i.sku).slice(0, 100) : undefined,
            };
          }).slice(0, 100),
          email: cart.email || undefined,
          countryCode: cart.countryCode || undefined,
        }),
      });
    },

    /** Storefront site search executed. Pass the raw query + the
     *  resulting hit count so no-result queries can be aggregated. */
    search: function (query, resultsCount) {
      var q = String(query || '').trim();
      if (!q) return;
      enqueue({
        type: 'event',
        meta: JSON.stringify({
          eventType: 'search',
          query: q.slice(0, 200),
          resultsCount: Math.max(0, Number(resultsCount || 0)),
        }),
      });
    },

    /** Checkout finished — fires the counter that closes any open
     *  abandoned-cart row for this session. Call from your thank-you
     *  page. Optionally pass the order code + total. */
    checkoutCompleted: function (orderCode, totalMinor) {
      enqueue({
        type: 'event',
        meta: JSON.stringify({
          eventType: 'checkout_completed',
          orderCode: orderCode ? String(orderCode).slice(0, 64) : undefined,
          totalMinor: totalMinor != null ? Number(totalMinor) : undefined,
        }),
      });
      flush(); // don't wait — the visitor may close the tab immediately
    },

    /** Rage-click event — fire it yourself if you have a better signal
     *  than the built-in detector. */
    rageClick: function (selector, extraMeta) {
      enqueue({
        type: 'event',
        meta: JSON.stringify(Object.assign({
          eventType: 'rage_click',
          selector: selector ? String(selector).slice(0, 200) : undefined,
        }, extraMeta || {})),
      });
    },

    /** Click landed on a non-interactive element. */
    deadClick: function (selector, extraMeta) {
      enqueue({
        type: 'event',
        meta: JSON.stringify(Object.assign({
          eventType: 'dead_click',
          selector: selector ? String(selector).slice(0, 200) : undefined,
        }, extraMeta || {})),
      });
    },

    /**
     * Restore a cart from a signed recovery token. Fetches the items
     * from the backend and returns them. Your storefront is responsible
     * for calling its own Vendure order API to actually re-add them,
     * because different storefronts frame that call differently.
     */
    restoreCart: function (token) {
      var t = String(token || '').trim();
      if (!t) return Promise.reject(new Error('missing-token'));
      return fetch(CONFIG.recoverEndpoint + '?t=' + encodeURIComponent(t), {
        credentials: 'include',
      }).then(function (r) { return r.json(); });
    },
  };

  // ── auto rage-click detector ─────────────────────────────────────
  // Any pointerdown ≥ 3 within 500ms in a 20x20px zone counts.
  if (CONFIG.autoRageClick) {
    var recent = [];
    document.addEventListener('pointerdown', function (e) {
      var now = Date.now();
      recent = recent.filter(function (r) { return now - r.t < 500; });
      recent.push({ t: now, x: e.clientX, y: e.clientY, target: e.target });
      var close = recent.filter(function (r) {
        return Math.abs(r.x - e.clientX) < 20 && Math.abs(r.y - e.clientY) < 20;
      });
      if (close.length >= 3) {
        hulo.rageClick(cssPathOf(e.target));
        recent = []; // reset so we don't fire again on the 4th, 5th, etc.
      }
    }, { capture: true, passive: true });
  }

  // ── auto dead-click detector ─────────────────────────────────────
  // A click that lands on an element with no href / not a button /
  // not a form control and doesn't produce a navigation within 400ms.
  if (CONFIG.autoDeadClick) {
    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || target.nodeType !== 1) return;
      if (isInteractive(target)) return;
      var beforeUrl = location.href;
      var beforeScroll = window.scrollY;
      setTimeout(function () {
        if (location.href !== beforeUrl) return;
        if (Math.abs(window.scrollY - beforeScroll) > 50) return;
        // Was there an ancestor with a click handler? Best-effort:
        // walk up and check for onclick, role='button', tabindex.
        var node = target;
        for (var i = 0; i < 4 && node; i++) {
          if (isInteractive(node) || node.onclick) return;
          node = node.parentElement;
        }
        hulo.deadClick(cssPathOf(target));
      }, 400);
    }, { capture: true, passive: true });
  }

  function isInteractive(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select'
        || tag === 'textarea' || tag === 'label' || tag === 'summary'
        || tag === 'details') return true;
    if (el.getAttribute && (el.getAttribute('role') === 'button'
        || el.getAttribute('role') === 'link'
        || el.hasAttribute('tabindex'))) return true;
    return false;
  }

  function cssPathOf(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      var p = el.tagName.toLowerCase();
      if (el.id) { p += '#' + el.id; parts.unshift(p); break; }
      if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
        if (cls) p += '.' + cls;
      }
      parts.unshift(p);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  global.hulo = hulo;
  // Auto pageview on load — most callers want it.
  if (document.readyState === 'complete') hulo.pageview();
  else window.addEventListener('load', function () { hulo.pageview(); });
})(window);
`;
