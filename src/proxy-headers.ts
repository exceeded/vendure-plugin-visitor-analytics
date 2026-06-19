import { Request } from 'express';

/**
 * Reverse-proxy aware visitor IP extraction.
 *
 * Order of precedence:
 *   1. Cloudflare's `CF-Connecting-IP` (always the real client IP,
 *      regardless of how many proxies sit in front of the worker).
 *   2. `True-Client-IP` (Akamai / Cloudflare Enterprise).
 *   3. `X-Real-IP` (nginx / Caddy default when proxying).
 *   4. First entry in `X-Forwarded-For` (RFC 7239 ancestor; the
 *      left-most entry is the original client when the upstream proxy
 *      is trusted).
 *   5. Express's `req.ip` — only useful when `app.set('trust proxy', ...)`
 *      has been set on the Vendure host, otherwise this is the socket
 *      address of the last hop.
 *
 * Returns `null` if none of the headers are populated and `req.ip`
 * isn't available — the caller should treat this as "unknown" and
 * skip IP-dependent enrichment rather than fail.
 */
export function getRealIp(req: Request): string | null {
    const headers = req.headers || {};
    const cfIp = String(headers['cf-connecting-ip'] || '').trim();
    if (cfIp) return cfIp;

    const trueClient = String(headers['true-client-ip'] || '').trim();
    if (trueClient) return trueClient;

    const realIp = String(headers['x-real-ip'] || '').trim();
    if (realIp) return realIp;

    const xff = String(headers['x-forwarded-for'] || '').trim();
    if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
    }

    return (req as any).ip || null;
}

/**
 * Cloudflare / Akamai populate the visitor's resolved country on the
 * inbound request when the corresponding feature is enabled. Reading
 * the upstream value avoids a per-request GeoIP lookup. Returns the
 * ISO 3166-1 alpha-2 country code or `null` if no proxy header is
 * present.
 */
export function getResolvedCountry(req: Request): string | null {
    const headers = req.headers || {};
    const cf = String(headers['cf-ipcountry'] || '').trim().toUpperCase();
    if (cf && cf !== 'XX' && cf !== 'T1') return cf;

    const akamai = String(headers['x-akamai-edgescape'] || '').trim();
    if (akamai) {
        const m = akamai.match(/country_code=([A-Z]{2})/i);
        if (m) return m[1].toUpperCase();
    }

    const fastly = String(headers['x-country-code'] || '').trim().toUpperCase();
    if (fastly && /^[A-Z]{2}$/.test(fastly)) return fastly;

    return null;
}

/**
 * Cloudflare's `cf-region-code` carries the ISO 3166-2 subdivision
 * (e.g. `ENG`, `SCT`, `CA`) when the "Send subdivision data" option is
 * enabled in the dashboard. Returns the bare code without the country
 * prefix, or `null` if unavailable.
 */
export function getResolvedRegion(req: Request): string | null {
    const headers = req.headers || {};
    const cf = String(headers['cf-region-code'] || '').trim().toUpperCase();
    if (cf && /^[A-Z0-9]{1,4}$/.test(cf)) return cf;
    return null;
}
