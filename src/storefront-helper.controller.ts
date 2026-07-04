import { Controller, Get, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { HULO_STOREFRONT_JS } from './hulo-storefront';
import { getOptions } from './plugin';

/**
 * Serves the storefront helper at `/ees/hulo.js`. Storefronts embed
 * one script tag and every helper (cartSnapshot, productView, search,
 * rageClick+deadClick auto-detectors, checkoutCompleted, restoreCart)
 * is available on `window.hulo`.
 *
 * Cache: 10-minute browser TTL + 24-hour SWR. The file's content is
 * a function of plugin options; storefronts don't need to bust the
 * cache to see config changes because the URL stays stable and 10
 * minutes is short enough that dashboard tweaks propagate promptly.
 */
@Controller('ees')
export class StorefrontHelperController {
    @Get('hulo.js')
    hulo(@Req() req: Request, @Res() res: Response) {
        const opts = getOptions();
        const base = (opts as any).publicBaseUrl
            || `https://${req.headers.host || 'localhost'}`;
        const js = HULO_STOREFRONT_JS(base, 1);
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.setHeader('cache-control', 'public, max-age=600, stale-while-revalidate=86400');
        // Storefront lives on a different origin from the backend —
        // static-JS CORS is safe (no credentials) but be explicit.
        res.setHeader('access-control-allow-origin', '*');
        res.send(js);
    }
}
