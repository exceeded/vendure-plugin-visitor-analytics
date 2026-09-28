/** Pure helpers for the ingest path (kept decorator-free so unit tests can import them). */

/** hulo.js sends `location.href`; reports, funnels and goals expect a path (`/products/x?y=1`). */
export function normaliseUrl(raw: unknown): string {
    const u = String(raw || '');
    if (/^https?:\/\//i.test(u)) {
        try { const p = new URL(u); return (p.pathname + p.search).slice(0, 2048); } catch { return u.slice(0, 2048); }
    }
    return u.slice(0, 2048);
}

/** JSON for the `meta` TEXT column: never cut mid-document (a truncated cart snapshot is unparseable). */
export function boundedMeta(meta: any, max = 60_000): string {
    let s = JSON.stringify(meta);
    if (s.length <= max) return s;
    if (meta && typeof meta === 'object' && Array.isArray(meta.items)) {
        for (let n = 50; n >= 5; n = Math.floor(n / 2)) {
            s = JSON.stringify({ ...meta, items: meta.items.slice(0, n), itemsTruncated: true });
            if (s.length <= max) return s;
        }
    }
    return JSON.stringify({ truncated: true, type: meta?.eventType || meta?.type || null });
}

