import { Controller, Get, Post, Query, Param, Req, Res, Body, OnApplicationBootstrap } from '@nestjs/common';
import { Ctx, RequestContext, Allow, Permission } from '@vendure/core';
import { Request, Response } from 'express';
import { RateLimiter } from '@huloglobal/vendure-licence-sdk';
import { AbandonedCartService } from './abandoned-cart.service';
import { getRealIp } from './proxy-headers';
import { sanitiseOrderCode, verifyOptOutToken } from './recovery-tokens';

/**
 * Admin API for the Abandoned Cart feature.
 *
 * Endpoints:
 *   GET  /ees/abandoned-carts                — paginated list with filters
 *   GET  /ees/abandoned-carts/summary        — totals + top-value + recovery rate
 *   GET  /ees/abandoned-carts/:id            — detail incl. parsed items
 *   POST /ees/abandoned-carts/:id/recovery-link  — mint/reissue signed URL
 *                                               (body `{ resumeOrderCode? }` binds it to an order, 0.18.0)
 *   POST /ees/abandoned-carts/:id/status     — mark recovered/dismissed
 *   GET  /ees/abandoned-carts/export.csv     — CSV export
 *   GET  /ees/abandoned-carts/opt-outs       — opted-out addresses (0.18.0)
 *   POST /ees/abandoned-carts/opt-outs/remove — `{ email }` re-enable (0.18.0)
 *
 * Storefront-side (unauthenticated, rate-limited per IP):
 *   GET  /ees/recover-cart?t=...             — resolve a token → items (+ orderCode / resumable, 0.18.0)
 *   POST /ees/recover-cart/resume?t=...      — same, plus `resumeOrderCode` while the bound order is open (0.18.0)
 *   POST /ees/recover-cart/converted         — `{ t, orderCode }` attribution when the restored cart checks out (0.18.0)
 *   GET|POST /ees/abandoned-carts/opt-out?e= — email opt-out (RFC 8058 one-click on POST) (0.18.0)
 */
@Controller('ees')
export class AbandonedCartController implements OnApplicationBootstrap {
    private limiter: RateLimiter | null = null;

    constructor(private readonly service: AbandonedCartService) {}

    onApplicationBootstrap(): void {
        // One shared bucket map; the bucket name is part of the key so each
        // endpoint gets its own allowance. Capacity is the most generous of
        // the per-endpoint limits — `cost` scales the others down.
        this.limiter = new RateLimiter({ capacity: 60, windowMs: 60_000 });
    }

    /** True (and 429 already written) when the caller is over budget.
     *  `cost` = 60 / per-minute allowance, so cost 2 → 30/min, cost 6 → 10/min. */
    private rateLimited(req: Request, res: Response, bucket: string, cost: number): boolean {
        const ip = getRealIp(req) || '';
        if (!ip || !this.limiter) return false;
        if (!this.limiter.allow(`${bucket}|${ip}`, cost)) {
            res.setHeader('Retry-After', '60');
            res.status(429).json({ error: 'rate-limited' });
            return true;
        }
        return false;
    }

    @Get('abandoned-carts')
    @Allow(Permission.ReadCustomer)
    async list(
        @Ctx() ctx: RequestContext,
        @Query('take') takeRaw?: string,
        @Query('skip') skipRaw?: string,
        @Query('status') status?: string,
        @Query('minValue') minValueRaw?: string,
        @Query('email') email?: string,
    ) {
        const take = Math.min(Math.max(1, parseInt(takeRaw || '25', 10) || 25), 200);
        const skip = Math.max(0, parseInt(skipRaw || '0', 10) || 0);
        const where: string[] = [];
        const params: any[] = [];
        if (status) { where.push('status = ?'); params.push(status); }
        if (minValueRaw) {
            const v = parseInt(minValueRaw, 10);
            if (Number.isFinite(v)) { where.push('totalMinor >= ?'); params.push(v); }
        }
        if (email) {
            where.push('LOWER(email) LIKE ?');
            params.push(`%${email.toLowerCase()}%`);
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const conn = (this.service as any).connection.rawConnection;
        const [rows, totalRow] = await Promise.all([
            conn.query(
                // itemsJson included so the list can render a preview of the
                // first few item names alongside the count. Slightly heavier
                // than the previous SELECT but capped by LIMIT and paginated,
                // so the payload growth stays proportional to the page size.
                `SELECT id, sessionId, visitorId, customerId, currency, totalMinor, itemCount,
                        itemsJson, email, status, abandonedAt, recoveredAt, notificationSent,
                        resumeOrderCode, recoveryStep, convertedAt, convertedOrderId, convertedOrderCode,
                        utmSource, utmMedium, utmCampaign, countryCode, regionCode, city,
                        ip, ipHash, userAgent, browser, deviceType,
                        landingUrl, lastKnownUrl, lastKnownReferrer,
                        pageViews, dwellSeconds,
                        firstName, lastName, phone,
                        firstSnapshotAt, lastSnapshotAt
                 FROM abandoned_cart
                 ${clause}
                 ORDER BY abandonedAt DESC
                 LIMIT ? OFFSET ?`,
                [...params, take, skip],
            ),
            conn.query(`SELECT COUNT(*) AS c FROM abandoned_cart ${clause}`, params),
        ]);
        // Enrich each row with:
        //   - items: parsed array (never null; empty array if malformed)
        //   - itemsPreview: short human-readable summary
        //     ("Windows 11 Pro, Office 2021 +1 more")
        // The preview is a rendering aid — sorted by qty desc so the
        // biggest lines lead, truncated at 3 names + "+N more".
        for (const r of rows) {
            let items: any[] = [];
            try { items = JSON.parse(r.itemsJson || '[]'); } catch {}
            r.items = items;
            r.itemsPreview = this.buildItemsPreview(items);
            // Drop the raw JSON blob from the list response so the payload
            // stays lean — clients that need it can hit the detail endpoint.
            delete r.itemsJson;
        }
        return {
            items: rows,
            total: Number(totalRow?.[0]?.c || 0),
            take, skip,
        };
    }

    /** Short human summary of a parsed itemsJson array. */
    private buildItemsPreview(items: any[]): string {
        if (!Array.isArray(items) || !items.length) return '';
        // Sort a shallow copy so we don't mutate the response body.
        const sorted = [...items].sort(
            (a, b) => Number(b?.qty || 0) - Number(a?.qty || 0),
        );
        const named = sorted
            .map(i => String(i?.name || '').trim())
            .filter(Boolean);
        if (!named.length) return `${items.length} item(s)`;
        const head = named.slice(0, 3).join(', ');
        const remaining = named.length - 3;
        return remaining > 0 ? `${head} +${remaining} more` : head;
    }

    @Get('abandoned-carts/summary')
    @Allow(Permission.ReadCustomer)
    async summary(@Ctx() ctx: RequestContext, @Query('days') daysRaw?: string) {
        const days = Math.min(Math.max(1, parseInt(daysRaw || '30', 10) || 30), 365);
        const since = new Date(Date.now() - days * 86400_000);
        const conn = (this.service as any).connection.rawConnection;
        const rows: any[] = await conn.query(
            `SELECT
                COUNT(*) AS total,
                SUM(status = 'abandoned') AS openCount,
                SUM(status = 'recovered') AS recoveredCount,
                SUM(status = 'converted') AS convertedCount,
                SUM(status = 'expired')   AS expiredCount,
                SUM(status = 'dismissed') AS dismissedCount,
                SUM(totalMinor) AS totalValueMinor,
                SUM(CASE WHEN status IN ('recovered','converted') THEN totalMinor ELSE 0 END) AS recoveredValueMinor,
                AVG(totalMinor) AS avgValueMinor
             FROM abandoned_cart
             WHERE abandonedAt >= ?`,
            [since],
        );
        const s = rows?.[0] || {};
        const total = Number(s.total || 0);
        const rec = Number(s.recoveredCount || 0) + Number(s.convertedCount || 0);
        const attribution = await this.service.attributionSummary(since);
        return {
            windowDays: days,
            attribution,
            total,
            openCount: Number(s.openCount || 0),
            recoveredCount: Number(s.recoveredCount || 0),
            convertedCount: Number(s.convertedCount || 0),
            expiredCount: Number(s.expiredCount || 0),
            dismissedCount: Number(s.dismissedCount || 0),
            recoveryRatePct: total ? Math.round((rec / total) * 1000) / 10 : 0,
            totalValueMinor: Number(s.totalValueMinor || 0),
            recoveredValueMinor: Number(s.recoveredValueMinor || 0),
            avgValueMinor: Math.round(Number(s.avgValueMinor || 0)),
        };
    }

    @Get('abandoned-carts/export.csv')
    @Allow(Permission.ReadCustomer)
    async exportCsv(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('days') daysRaw?: string) {
        const days = Math.min(Math.max(1, parseInt(daysRaw || '30', 10) || 30), 365);
        const since = new Date(Date.now() - days * 86400_000);
        const conn = (this.service as any).connection.rawConnection;
        const rows: any[] = await conn.query(
            `SELECT id, sessionId, visitorId, customerId, currency, totalMinor, itemCount,
                    email, status, abandonedAt, recoveredAt, utmSource, utmMedium, utmCampaign, countryCode
             FROM abandoned_cart
             WHERE abandonedAt >= ?
             ORDER BY abandonedAt DESC
             LIMIT 50000`,
            [since],
        );
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition',
            `attachment; filename="abandoned-carts-${new Date().toISOString().slice(0,10)}.csv"`);
        const esc = (v: any) => {
            const s = v == null ? '' : String(v);
            return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const cols = ['id','sessionId','visitorId','customerId','currency','totalMinor','itemCount',
                      'email','status','abandonedAt','recoveredAt','utmSource','utmMedium','utmCampaign','countryCode'];
        res.write(cols.join(',') + '\n');
        for (const r of rows) {
            res.write(cols.map(c => esc(r[c])).join(',') + '\n');
        }
        res.end();
    }

    /**
     * Email opt-out. Public, token-bound (`e=` is an HMAC of the address —
     * see `buildOptOutToken`). GET renders a tiny confirmation page for
     * humans clicking the footer link; POST is the RFC 8058 one-click form
     * mail clients send when the user hits their native "Unsubscribe".
     * Both are idempotent.
     */
    @Get('abandoned-carts/opt-out')
    async optOutGet(@Req() req: Request, @Res() res: Response, @Query('e') tokenRaw?: string) {
        if (this.rateLimited(req, res, 'opt-out', 6)) return;
        const result = await this.applyOptOut(req, tokenRaw);
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.status(result.ok ? 200 : 400).send(this.optOutPage(result.ok));
    }

    @Post('abandoned-carts/opt-out')
    async optOutPost(@Req() req: Request, @Res() res: Response, @Query('e') tokenRaw?: string, @Body() body?: any) {
        if (this.rateLimited(req, res, 'opt-out', 6)) return;
        const token = tokenRaw || body?.e || (typeof body === 'string' ? '' : undefined);
        const result = await this.applyOptOut(req, token);
        res.setHeader('cache-control', 'no-store');
        res.status(result.ok ? 200 : 400).json(result);
    }

    private async applyOptOut(req: Request, tokenRaw?: string): Promise<{ ok: true } | { ok: false; error: string }> {
        const secret = this.service.getOptOutSecret();
        if (!secret) return { ok: false, error: 'opt-out-disabled' };
        const email = verifyOptOutToken(tokenRaw, secret);
        if (!email) return { ok: false, error: 'invalid-token' };
        await this.service.optOut(email, { source: 'link', ip: getRealIp(req) });
        return { ok: true };
    }

    private optOutPage(ok: boolean): string {
        const title = ok ? 'You have been unsubscribed' : 'This link is not valid';
        const body = ok
            ? 'We will not send you any more reminders about items left in your basket. You can close this page.'
            : 'The unsubscribe link is incomplete or has been altered. Please use the link exactly as it appears in the email.';
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
            + `<meta name="robots" content="noindex"><title>${title}</title>`
            + `<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1b1f24;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}`
            + `main{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:32px 36px;max-width:440px;box-shadow:0 2px 12px rgba(0,0,0,.05)}h1{font-size:20px;margin:0 0 12px}p{margin:0;line-height:1.5;color:#4b5563}</style>`
            + `</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
    }

    @Get('abandoned-carts/opt-outs')
    @Allow(Permission.ReadCustomer)
    async listOptOuts(@Ctx() ctx: RequestContext, @Query('take') takeRaw?: string, @Query('skip') skipRaw?: string) {
        const take = Math.min(Math.max(1, parseInt(takeRaw || '50', 10) || 50), 500);
        const skip = Math.max(0, parseInt(skipRaw || '0', 10) || 0);
        const { items, total } = await this.service.listOptOuts(take, skip);
        return { items, total, take, skip };
    }

    @Post('abandoned-carts/opt-outs/remove')
    @Allow(Permission.UpdateCustomer)
    async removeOptOut(@Ctx() ctx: RequestContext, @Body() body: { email?: string }) {
        const ok = await this.service.optIn(String(body?.email || ''));
        return ok ? { ok: true } : { error: 'not-found' };
    }

    @Get('abandoned-carts/:id')
    @Allow(Permission.ReadCustomer)
    async detail(@Ctx() ctx: RequestContext, @Param('id') idRaw: string) {
        const id = parseInt(idRaw, 10);
        const conn = (this.service as any).connection.rawConnection;
        const rows: any[] = await conn.query(
            `SELECT * FROM abandoned_cart WHERE id = ? LIMIT 1`,
            [id],
        );
        if (!rows?.length) return { error: 'not-found' };
        const r = rows[0];
        let items: any[] = [];
        try { items = JSON.parse(r.itemsJson || '[]'); } catch {}
        // Fill in missing product/variant names by looking them up in
        // Vendure. The storefront snapshot usually captures `name`
        // already; this is a fallback for older data, snapshots taken
        // before the product had a translation, or third-party
        // integrations that fire cart_snapshot without a name field.
        const enrichedItems = await this.enrichItemsWithNames(items);
        const optedOut = r.email ? await this.service.isOptedOut(r.email) : false;
        return {
            ...r,
            items: enrichedItems,
            itemsPreview: this.buildItemsPreview(enrichedItems),
            optedOut,
        };
    }

    /**
     * Fill in missing `name` (and, when possible, `productId`) on each
     * cart item by looking up the variant / product from Vendure.
     * Untouched if the item already has a name — the storefront's
     * snapshot at cart time is usually more accurate than a live
     * catalog lookup (a name in Vendure may have changed since the
     * cart was abandoned).
     */
    private async enrichItemsWithNames(items: any[]): Promise<any[]> {
        if (!Array.isArray(items) || !items.length) return items || [];
        const conn = (this.service as any).connection.rawConnection;
        const variantIds = new Set<number>();
        const productIds = new Set<number>();
        for (const it of items) {
            if (it?.name) continue;
            const vid = Number(it?.variantId);
            const pid = Number(it?.productId);
            if (Number.isFinite(vid) && vid > 0) variantIds.add(vid);
            if (Number.isFinite(pid) && pid > 0) productIds.add(pid);
        }
        const variantNames = new Map<number, { name: string; productId: number }>();
        const productNames = new Map<number, string>();
        if (variantIds.size) {
            try {
                const vids = Array.from(variantIds);
                const ph = vids.map(() => '?').join(',');
                const rows: any[] = await conn.query(
                    `SELECT pv.id AS variantId, pv.productId AS productId, pvt.name AS name
                     FROM product_variant pv
                     LEFT JOIN product_variant_translation pvt ON pvt.baseId = pv.id
                     WHERE pv.id IN (${ph})
                     ORDER BY pv.id, pvt.languageCode = 'en' DESC`,
                    vids,
                );
                for (const row of rows) {
                    const vid = Number(row.variantId);
                    if (variantNames.has(vid)) continue;
                    variantNames.set(vid, {
                        name: String(row.name || ''),
                        productId: Number(row.productId),
                    });
                }
            } catch { /* fail-open */ }
        }
        if (productIds.size) {
            try {
                const pids = Array.from(productIds);
                const ph = pids.map(() => '?').join(',');
                const rows: any[] = await conn.query(
                    `SELECT baseId AS productId, name FROM product_translation
                     WHERE baseId IN (${ph})
                     ORDER BY baseId, languageCode = 'en' DESC`,
                    pids,
                );
                for (const row of rows) {
                    const pid = Number(row.productId);
                    if (productNames.has(pid)) continue;
                    productNames.set(pid, String(row.name || ''));
                }
            } catch { /* fail-open */ }
        }
        return items.map(it => {
            if (it?.name) return it;
            const vid = Number(it?.variantId);
            const vinfo = variantNames.get(vid);
            if (vinfo?.name) {
                return {
                    ...it,
                    name: vinfo.name,
                    productId: it.productId || vinfo.productId,
                };
            }
            const pid = Number(it?.productId);
            const pname = productNames.get(pid);
            if (pname) return { ...it, name: pname };
            return it;
        });
    }

    @Post('abandoned-carts/:id/recovery-link')
    @Allow(Permission.UpdateCustomer)
    async issueRecoveryLink(
        @Ctx() ctx: RequestContext,
        @Param('id') idRaw: string,
        @Body() body?: { resumeOrderCode?: string | null },
    ) {
        const id = parseInt(idRaw, 10);
        const options = body && body.resumeOrderCode !== undefined
            ? { resumeOrderCode: body.resumeOrderCode === null ? null : sanitiseOrderCode(body.resumeOrderCode) || null }
            : {};
        const url = await this.service.issueRecoveryLink(id, options);
        if (!url) return { error: 'recovery-disabled-or-not-found', hint: 'Set abandonment.recoveryLinkSecret in plugin options' };
        return { ok: true, url };
    }

    @Post('abandoned-carts/:id/status')
    @Allow(Permission.UpdateCustomer)
    async setStatus(
        @Ctx() ctx: RequestContext,
        @Param('id') idRaw: string,
        @Body() body: { status?: string },
    ) {
        const id = parseInt(idRaw, 10);
        const status = String(body?.status || '') as any;
        if (!['recovered', 'dismissed', 'abandoned'].includes(status)) {
            return { error: 'invalid-status' };
        }
        const ok = await this.service.markStatus(id, status as any);
        return ok ? { ok: true } : { error: 'not-found' };
    }

    /**
     * Public storefront endpoint — decodes a recovery token into a set
     * of cart items the storefront can restore. Rate-limited by the
     * plugin's usual ingest limiter (same origin as the tracker).
     */
    @Get('recover-cart')
    async recover(@Req() req: Request, @Res() res: Response, @Query('t') token?: string) {
        if (this.rateLimited(req, res, 'recover', 2)) return;
        res.setHeader('cache-control', 'no-store');
        const t = String(token || '').trim();
        if (!t) { res.status(400).json({ error: 'missing-token' }); return; }
        const result = await this.service.findByRecoveryToken(t);
        if (!result) { res.json({ error: 'expired-or-invalid' }); return; }
        res.json({ ok: true, ...result });
    }

    /**
     * Resume the exact order the link was bound to. Same payload as
     * `recover-cart` plus `resumeOrderCode` — non-null only while that
     * order is still `AddingItems` / `ArrangingPayment`. The storefront
     * cannot adopt an order anonymously through the Shop API, so it
     * should treat `resumeOrderCode` as a hint (e.g. sign-in prompt for
     * the owner, or "your order S2BZ… is waiting") and fall back to
     * re-adding `items` — which always works.
     */
    @Post('recover-cart/resume')
    async resume(@Req() req: Request, @Res() res: Response, @Query('t') tokenQ?: string, @Body() body?: any) {
        if (this.rateLimited(req, res, 'recover', 2)) return;
        res.setHeader('cache-control', 'no-store');
        const t = String(tokenQ || body?.t || '').trim();
        if (!t) { res.status(400).json({ error: 'missing-token' }); return; }
        const result = await this.service.resumeByRecoveryToken(t);
        if (!result) { res.json({ error: 'expired-or-invalid' }); return; }
        res.json({ ok: true, ...result });
    }

    /**
     * Attribution — the restored cart checked out. Token-bound, so a
     * stranger cannot mark carts converted; the order must exist and be
     * past `AddingItems`. Idempotent.
     */
    @Post('recover-cart/converted')
    async converted(@Req() req: Request, @Res() res: Response, @Query('t') tokenQ?: string, @Body() body?: any) {
        if (this.rateLimited(req, res, 'converted', 6)) return;
        res.setHeader('cache-control', 'no-store');
        const t = String(tokenQ || body?.t || '').trim();
        const orderCode = sanitiseOrderCode(body?.orderCode);
        if (!t || !orderCode) { res.status(400).json({ error: 'missing-token-or-order-code' }); return; }
        const result = await this.service.markConvertedByToken(t, orderCode);
        res.status(result.ok ? 200 : 400).json(result);
    }
}
