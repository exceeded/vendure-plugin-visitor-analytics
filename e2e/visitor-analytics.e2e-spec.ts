import { mergeConfig, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import * as path from 'path';
import { initialData } from '../../../e2e-shared/initial-data';
import { VisitorEvent } from '../src/visitor-event.entity';
import { VisitorAnalyticsPlugin } from '../src/plugin';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const PORT = 3062;

describe('@huloglobal/vendure-plugin-visitor-analytics', () => {
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        plugins: [
            VisitorAnalyticsPlugin.init({
                publicBaseUrl: `http://localhost:${PORT}`,
            }),
        ],
    });
    const { server } = createTestEnvironment(config);

    beforeAll(async () => {
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
    }, 60_000);

    afterAll(async () => {
        await server.destroy();
    });

    it('POST /ees/track persists an event and issues visitor + session cookies', async () => {
        const res = await fetch(`http://localhost:${PORT}/ees/track`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'jest-test/1.0' },
            body: JSON.stringify({
                channelId: 1,
                events: [{ type: 'pageview', url: '/test', title: 'Test' }],
            }),
        });
        expect([200, 201]).toContain(res.status);
        const body = await res.json();
        expect(body.stored).toBe(1);
        expect(body.visitorId).toMatch(/^[a-f0-9]{16,64}$/);
        expect(body.sessionId).toMatch(/^[a-f0-9]{16,64}$/);
        expect(body.issuedVisitor).toBe(true);
        expect(body.issuedSession).toBe(true);

        const setCookie = res.headers.get('set-cookie') || '';
        expect(setCookie).toContain('ees_vid=');
        expect(setCookie).toContain('ees_sid=');

        // Verify the row in DB
        const conn: TransactionalConnection = (server as any).app.get(TransactionalConnection);
        const repo = conn.rawConnection.getRepository(VisitorEvent);
        const rows = await repo.find();
        expect(rows.length).toBe(1);
        expect(rows[0].type).toBe('pageview');
        expect(rows[0].url).toBe('/test');
    });

    it('custom events round-trip through /ees/track with meta JSON', async () => {
        const res = await fetch(`http://localhost:${PORT}/ees/track`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                channelId: 2,
                events: [{ type: 'add_to_cart', url: '/p/x', meta: { productVariantId: '99', quantity: 3 } }],
            }),
        });
        expect([200, 201]).toContain(res.status);
        const body = await res.json();
        expect(body.stored).toBe(1);

        const conn: TransactionalConnection = (server as any).app.get(TransactionalConnection);
        const repo = conn.rawConnection.getRepository(VisitorEvent);
        const row = await repo.findOne({ where: { type: 'add_to_cart' } });
        expect(row).toBeDefined();
        expect(row?.channelId).toBe(2);
        const meta = JSON.parse(row?.meta || '{}');
        expect(meta.productVariantId).toBe('99');
        expect(meta.quantity).toBe(3);
    });

    it('admin /ees/visitors/live rejects anonymous', async () => {
        const res = await fetch(`http://localhost:${PORT}/ees/visitors/live`);
        expect([401, 403]).toContain(res.status);
    });

    it('honors Do-Not-Track when option enabled (default)', async () => {
        const res = await fetch(`http://localhost:${PORT}/ees/track`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'dnt': '1' },
            body: JSON.stringify({ channelId: 1, events: [{ type: 'pageview', url: '/dnt' }] }),
        });
        expect([200, 201]).toContain(res.status);
        const body = await res.json();
        expect(body.stored).toBe(0);
        expect(body.skipped).toBe('dnt');
    });

    it('flags bot user-agents with isBot=true', async () => {
        await fetch(`http://localhost:${PORT}/ees/track`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
            body: JSON.stringify({ channelId: 1, events: [{ type: 'pageview', url: '/botted' }] }),
        });
        const { TransactionalConnection } = require('@vendure/core');
        const conn = (server as any).app.get(TransactionalConnection);
        const repo = conn.rawConnection.getRepository(VisitorEvent);
        const row = await repo.findOne({ where: { url: '/botted' } });
        expect(row?.isBot).toBe(true);
    });
});
