import { describe, expect, it } from 'vitest';
import { boundedMeta, normaliseUrl } from './visitor-tracking.service';
import { getRealIp } from './proxy-headers';

describe('normaliseUrl', () => {
    it('reduces hulo.js absolute URLs to path + query and leaves paths alone', () => {
        expect(normaliseUrl('https://shop.example/products/widget?x=1#top')).toBe('/products/widget?x=1');
        expect(normaliseUrl('/checkout/confirmation/ABC')).toBe('/checkout/confirmation/ABC');
        expect(normaliseUrl('')).toBe('');
    });
});

describe('boundedMeta', () => {
    it('keeps small payloads verbatim and shrinks a huge cart snapshot without cutting the JSON', () => {
        expect(boundedMeta({ a: 1 })).toBe('{"a":1}');
        const items = Array.from({ length: 400 }, (_, i) => ({ sku: `SKU-${i}`, name: 'x'.repeat(200), qty: 1 }));
        const out = boundedMeta({ eventType: 'cart_snapshot', items }, 20_000);
        const parsed = JSON.parse(out);
        expect(out.length).toBeLessThanOrEqual(20_000);
        expect(parsed.itemsTruncated).toBe(true);
        expect(parsed.items.length).toBeGreaterThan(0);
    });
});

describe('getRealIp', () => {
    const req = (headers: Record<string, string>, ip = '10.0.0.9') => ({ headers, ip } as any);
    it('ignores proxy headers unless trusted', () => {
        expect(getRealIp(req({ 'x-forwarded-for': '198.51.100.1' }))).toBe('10.0.0.9');
        expect(getRealIp(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.9' }), ['x-forwarded-for'])).toBe('198.51.100.1');
        expect(getRealIp(req({}, '::ffff:198.51.100.7'))).toBe('198.51.100.7');
    });
});
