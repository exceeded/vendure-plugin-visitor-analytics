import { describe, expect, it } from 'vitest';
import {
    buildSetupItems, EMPTY_STATS, isPublicBaseUrl, PREMIUM_FEATURES, setupTips, toDigestStats, topRecentStats, widgetStats,
} from './engagement-stats';

const facts = {
    hasRecentEvents: true, publicBaseUrl: 'https://shop.example.com', storefrontBaseUrlSet: true,
    goalsEnabled: 1, slackWebhookSet: false, recoverySecretSet: true,
};

describe('engagement stats', () => {
    it('maps every counter to a digest stat with the previous value', () => {
        const stats = toDigestStats({ ...EMPTY_STATS, pageViews: 120, recoveredValuePence: 4599 }, { ...EMPTY_STATS, pageViews: 100 });
        const pv = stats.find(s => s.key === 'pageViews')!;
        expect(pv.value).toBe(120);
        expect(pv.previous).toBe(100);
        expect(stats.find(s => s.key === 'recoveredValuePence')!.format).toBe('pence');
        expect(stats).toHaveLength(7);
    });

    it('picks the top non-zero figures, money first, and formats them', () => {
        const top = topRecentStats({ ...EMPTY_STATS, visitorsTracked: 1500, pageViews: 9000, recoveredValuePence: 123456, cartsRecovered: 3 });
        expect(top).toEqual([
            { label: 'of cart value recovered', value: '£1,234.56' },
            { label: 'carts recovered', value: '3' },
            { label: 'unique visitors tracked', value: '1,500' },
        ]);
        expect(topRecentStats(EMPTY_STATS)).toEqual([]);
    });

    it('widget always shows three figures', () => {
        expect(widgetStats(EMPTY_STATS).map(s => s.value)).toEqual(['0', '0', '0']);
    });

    it('premium features list is the published one', () => {
        expect(PREMIUM_FEATURES).toHaveLength(4);
        expect(PREMIUM_FEATURES[0]).toMatch(/100\/day/);
    });
});

describe('set-up checklist', () => {
    it('is complete when every real check passes', () => {
        const r = buildSetupItems(facts);
        expect(r.complete).toBe(true);
        expect(r.items.map(i => i.key)).toEqual(['tracking', 'publicBaseUrl', 'storefrontUrl', 'goal', 'alerts']);
    });

    it('flags the undone items and turns them into tips in order', () => {
        const r = buildSetupItems({ ...facts, hasRecentEvents: false, goalsEnabled: 0, recoverySecretSet: false });
        expect(r.complete).toBe(false);
        expect(r.items.filter(i => !i.done).map(i => i.key)).toEqual(['tracking', 'goal', 'alerts']);
        expect(r.items[0].hint).toContain('https://shop.example.com/ees/hulo.js');
        const tips = setupTips(r.items, 'https://shop.example.com/admin/extensions/visitors');
        expect(tips.map(t => t.title)).toEqual(['Tracking script receiving events', 'At least one conversion goal', 'Abandoned-cart alerts or recovery links enabled']);
        expect(tips[0].url).toBe('https://shop.example.com/admin/extensions/visitors');
        expect(setupTips(buildSetupItems({ ...facts, hasRecentEvents: false, storefrontBaseUrlSet: false, goalsEnabled: 0, slackWebhookSet: false, recoverySecretSet: false }).items)).toHaveLength(3);
    });

    it('treats loopback / unset public base URLs as not configured', () => {
        expect(isPublicBaseUrl('http://localhost:3000')).toBe(false);
        expect(isPublicBaseUrl('')).toBe(false);
        expect(isPublicBaseUrl('shop.example.com')).toBe(false);
        expect(isPublicBaseUrl('https://shop.example.com/')).toBe(true);
        expect(buildSetupItems({ ...facts, publicBaseUrl: 'http://127.0.0.1:3000' }).items[1].done).toBe(false);
    });
});
