/**
 * Cheap URL glob matcher used by ConversionGoal.
 *
 *   `*`  — match zero or more chars within a path segment
 *   `**` — match zero or more segments (the `/` separator inclusive)
 *   anything else is a literal character (case-insensitive)
 *
 * Patterns are compiled to a RegExp once and cached so the matcher is
 * cheap on the hot ingest path.
 */
const cache = new Map<string, RegExp>();
const STAR_STAR = '__DOUBLE_STAR__';

function compile(pattern: string): RegExp {
    const cached = cache.get(pattern);
    if (cached) return cached;
    let s = pattern.replace(/\*\*/g, STAR_STAR);
    s = s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(/\*/g, '[^/]*');
    s = s.split(STAR_STAR).join('.*');
    const re = new RegExp(`^${s}$`, 'i');
    cache.set(pattern, re);
    return re;
}

export function matchUrl(pattern: string, url: string): boolean {
    if (!pattern || !url) return false;
    try {
        return compile(pattern).test(url);
    } catch {
        return false;
    }
}
