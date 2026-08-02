import { describe, expect, it } from 'vitest';
import { matchUrl } from './url-pattern';

describe('matchUrl', () => {
    it('matches exact literals case-insensitively', () => {
        expect(matchUrl('/checkout/success', '/checkout/success')).toBe(true);
        expect(matchUrl('/Checkout/Success', '/checkout/success')).toBe(true);
        expect(matchUrl('/checkout/success', '/checkout/fail')).toBe(false);
    });

    it('single * matches within a segment but not across /', () => {
        expect(matchUrl('/product/*', '/product/widget')).toBe(true);
        expect(matchUrl('/product/*', '/product/')).toBe(true);
        expect(matchUrl('/product/*', '/product/widget/reviews')).toBe(false);
        expect(matchUrl('/p/*/buy', '/p/123/buy')).toBe(true);
        expect(matchUrl('/p/*/buy', '/p/123/456/buy')).toBe(false);
    });

    it('double ** matches across segments', () => {
        expect(matchUrl('/shop/**', '/shop/a/b/c')).toBe(true);
        expect(matchUrl('/shop/**', '/shop/')).toBe(true);
        expect(matchUrl('/**/checkout', '/a/b/checkout')).toBe(true);
        expect(matchUrl('**', '/anything/at/all')).toBe(true);
    });

    it('escapes regex metacharacters in the literal parts', () => {
        expect(matchUrl('/price.list', '/price.list')).toBe(true);
        expect(matchUrl('/price.list', '/priceXlist')).toBe(false); // . is literal, not "any char"
        expect(matchUrl('/a(b)+', '/a(b)+')).toBe(true);
    });

    it('anchors the whole string', () => {
        expect(matchUrl('/cart', '/cart/extra')).toBe(false);
        expect(matchUrl('/cart', 'x/cart')).toBe(false);
    });

    it('returns false for empty pattern or url', () => {
        expect(matchUrl('', '/x')).toBe(false);
        expect(matchUrl('/x', '')).toBe(false);
        expect(matchUrl('', '')).toBe(false);
    });
});
