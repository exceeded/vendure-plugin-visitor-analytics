import { Component, OnDestroy, OnInit, ChangeDetectorRef, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NotificationService } from '@vendure/admin-ui/core';

interface TopPage { url: string; title: string | null; views: number; uniqueVisitors: number; avgTimeMs: number; }
interface ExitPage { url: string; title: string | null; exits: number; }
interface FunnelStage { key: string; label: string; visitors: number; }
interface RecentVisitor {
    visitorId: string; customerId: number | null;
    firstSeenAt: string; lastSeenAt: string;
    sessions: number; pageviews: number;
    country: string | null; city: string | null;
    browser: string | null; os: string | null; device: string | null;
}
interface JourneyEvent {
    id: number; createdAt: string; type: string;
    url: string; title: string | null; referrer: string | null;
    timeOnPageMs: number | null; country: string | null;
    ip: string | null; city: string | null; browser: string | null; os: string | null;
    meta: string | null;
}
interface VisitorSession {
    sessionId: string; startedAt: string; endedAt: string;
    events: number; pageviews: number; timeMs: number; entryUrl: string | null;
}
interface VisitorProfile {
    visitorId: string; customerId: number | null;
    customer: { id: number; firstName: string; lastName: string; emailAddress: string } | null;
    firstSeenAt: string; lastSeenAt: string;
    totals: { sessions: number; pageviews: number; unloads: number; events: number; timeMs: number };
    ip: string | null; ipHash: string | null;
    userAgent: string | null;
    browser: string | null; browserVersion: string | null;
    os: string | null; osVersion: string | null; device: string | null;
    acceptLanguage: string | null;
    country: string | null; region: string | null; city: string | null; timezone: string | null;
    channelId: number;
}

@Component({
    selector: 'ees-visitors',
    standalone: false,
    template: `
        <!-- ── HULO brand hero — shared pattern across every HULO plugin. -->
        <vdr-page-block>
            <div class="hulo-hero">
                <div class="hulo-hero-logo" aria-hidden="true">
                    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                        <rect width="64" height="64" rx="14" fill="#0f1419"/>
                        <rect x="14" y="34" width="7" height="14" rx="1.5" fill="#ffffff"/>
                        <rect x="24" y="28" width="7" height="20" rx="1.5" fill="#ffffff"/>
                        <rect x="34" y="22" width="7" height="26" rx="1.5" fill="#ffffff"/>
                        <rect x="44" y="16" width="7" height="32" rx="1.5" fill="#ffffff"/>
                        <polyline points="17.5,34 27.5,28 37.5,22 47.5,16" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                        <circle cx="47.5" cy="16" r="2.5" fill="#f59e0b"/>
                    </svg>
                </div>
                <div class="hulo-hero-text">
                    <h2 class="hulo-hero-title">Visitor journey</h2>
                    <p class="hulo-hero-sub">Live visitor count plus the funnel from landing → product → cart → checkout → order. Change the date range on the right.</p>
                </div>
                <div class="hulo-hero-actions">
                    <!-- Channel picker. Empty value = All channels
                         (aggregate). Sits before the date range so the
                         narrower filter comes first, matching Vendure
                         convention on other admin filters. -->
                    <select class="hulo-hero-select"
                            [ngModel]="channelId ?? ''"
                            (ngModelChange)="setChannel($event)"
                            aria-label="Channel">
                        <option [ngValue]="''">All channels</option>
                        <option *ngFor="let c of channels" [ngValue]="c.id">{{ c.code }}</option>
                    </select>
                    <span class="range">
                        <button class="btn btn-sm btn-link" *ngFor="let d of [7, 30, 90, 365]"
                            (click)="setDays(d)" [class.active]="days === d">{{ d }}d</button>
                    </span>
                    <button class="btn btn-link hulo-help-btn" (click)="helpOpen = !helpOpen" [attr.aria-expanded]="helpOpen">
                        <clr-icon shape="help"></clr-icon><span>Help</span>
                    </button>
                    <button class="btn btn-link" (click)="loadAll()" [disabled]="loading">
                        <clr-icon shape="refresh"></clr-icon> Refresh
                    </button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="licMeta?.update?.updateAvailable && !updateDismissed">
            <div class="lic-banner">
                <div>
                    <strong>⬆️ Update available</strong> —
                    <!--email_off-->v{{ licMeta.update.current }} → <strong>v{{ licMeta.update.latest }}</strong><!--/email_off-->.
                    Run <code class="upd-cmd">npm install &#64;huloglobal/vendure-plugin-visitor-analytics&#64;{{ licMeta.update.latest }}</code> and restart, or see the changelog.
                </div>
                <div class="lic-actions">
                    <button class="gbtn gbtn-primary gbtn-sm" *ngIf="licMeta?.selfUpdate?.allowed" (click)="runSelfUpdate()" [disabled]="updating">{{ updating ? updateProgress : 'Update now' }}</button>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="copyUpdateCmd()">{{ cmdCopied ? 'Copied ✓' : 'Copy command' }}</button>
                    <a href="https://huloglobal.com/vendure-plugins/visitor-analytics/changelog/" target="_blank" class="gbtn gbtn-outline gbtn-sm">What&rsquo;s new ↗</a>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="updateDismissed = true">Dismiss</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="licMeta && !licMeta.licensed">
            <div class="lic-banner">
                <div *ngIf="licMeta.tier === 'trial'">
                    <strong>⏳ Full-featured evaluation</strong> —
                    <ng-container *ngIf="licMeta.eval?.daysRemaining != null">
                        <strong>{{ licMeta.eval.daysRemaining }} day{{ licMeta.eval.daysRemaining === 1 ? '' : 's' }} left</strong> with everything enabled.
                    </ng-container>
                    <ng-container *ngIf="licMeta.eval?.daysRemaining == null">everything is enabled.</ng-container>
                    Afterwards the plugin drops to the free tier.
                </div>
                <div *ngIf="licMeta.tier !== 'trial'">
                    <strong>🔓 Free tier</strong> — premium features need a licence. Start your <strong>14-day free trial</strong> below (card required, nothing charged until day 15, cancel any time) or buy a lifetime licence. Premium features are paused; your configuration is kept and reactivates instantly with a key.
                </div>
                <div class="lic-actions">
                    <input class="lic-key" type="text" placeholder="Paste licence key (eyJhbGciOi…)" [(ngModel)]="licKeyInput" [disabled]="licActivating">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="activateLicence()" [disabled]="licActivating || !licKeyInput">{{ licActivating ? 'Verifying…' : 'Activate' }}</button>
                    <select [(ngModel)]="buyPlan" [disabled]="buying" style="padding:5px 9px;border:1px solid #d1d5db;border-radius:7px;font-size:12.5px;background:#fff;color:inherit"><option value="monthly">Monthly · 14-day free trial</option><option value="annual">Annual · 14-day free trial, 2 months free</option><option value="lifetime">Lifetime · one-off</option></select>
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLicence()" [disabled]="buying">{{ buying ? 'Opening checkout…' : (buyPlan === 'lifetime' ? 'Buy lifetime →' : 'Start 14-day free trial →') }}</button>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/visitor-analytics/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="helpOpen">
            <div class="hulo-help-drawer">
                <div class="hulo-help-grid">
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">1</div>
                        <h4>Add the one-liner script to your storefront</h4>
                        <p>Drop <code>&lt;script src="/ees/hulo.js"&gt;</code> in your site head. It handles session + page tracking automatically.</p>
                    </div>
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">2</div>
                        <h4>Watch the funnel</h4>
                        <p>Each stage shows visitors + drop-off %. Big gaps usually point to a specific broken UX or slow page.</p>
                    </div>
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">3</div>
                        <h4>Compare over time</h4>
                        <p>Change the 7d / 30d / 90d / 365d range in the header. All numbers, series and top-country lists follow.</p>
                    </div>
                </div>
                <div class="hulo-help-links">
                    <a href="https://huloglobal.com/vendure-plugins/visitor-analytics/docs/" target="_blank">Full docs ↗</a>
                    <a href="https://huloglobal.com/vendure-plugins/visitor-analytics/" target="_blank">Plugin page ↗</a>
                    <a href="mailto:support@huloglobal.com">Email support</a>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="updateBanner">
            <div class="update-banner" [class.major]="updateBanner.isMajor">
                <div>
                    <strong>📦 Update available</strong>
                    {{ updateBanner.packageName }} {{ updateBanner.current }} → <strong>{{ updateBanner.latest }}</strong>
                    <span *ngIf="updateBanner.isMajor" class="major-pill">major</span>
                </div>
                <div class="actions">
                    <a [href]="'https://github.com/exceeded/vendure-plugin-visitor-analytics/releases/tag/v' + updateBanner.latest" target="_blank" class="btn btn-sm btn-link">Release notes ↗</a>
                    <button class="btn btn-sm" (click)="dismissUpdate()">Dismiss</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="kpi-row">
                <div class="kpi live-kpi">
                    <div class="kpi-label">
                        <span class="live-dot" [class.connected]="liveConnected"></span>
                        Live now
                    </div>
                    <div class="kpi-num">{{ liveCount | number }}</div>
                    <div class="kpi-sub" *ngIf="liveUpdatedAt">refreshed {{ liveUpdatedAt | date:'HH:mm:ss' }}</div>
                </div>
                <div class="kpi">
                    <div class="kpi-label">Unique visitors</div>
                    <div class="kpi-num">{{ summary.visitors | number }}</div>
                    <div class="kpi-delta" [class.up]="delta('visitors') > 0" [class.down]="delta('visitors') < 0">
                        {{ deltaLabel('visitors') }}
                    </div>
                </div>
                <div class="kpi">
                    <div class="kpi-label">Sessions</div>
                    <div class="kpi-num">{{ summary.sessions | number }}</div>
                    <div class="kpi-delta" [class.up]="delta('sessions') > 0" [class.down]="delta('sessions') < 0">
                        {{ deltaLabel('sessions') }}
                    </div>
                </div>
                <div class="kpi">
                    <div class="kpi-label">Page views</div>
                    <div class="kpi-num">{{ summary.pageviews | number }}</div>
                    <div class="kpi-delta" [class.up]="delta('pageviews') > 0" [class.down]="delta('pageviews') < 0">
                        {{ deltaLabel('pageviews') }}
                    </div>
                </div>
                <div class="kpi">
                    <div class="kpi-label">Pages / session</div>
                    <div class="kpi-num">{{ pagesPerSession() }}</div>
                    <div class="kpi-sub">avg {{ humanTime(summary.avgTimeMs) }} on page</div>
                </div>
            </div>

            <div class="live-strip" *ngIf="liveRecent.length > 0">
                <div class="live-strip-title">
                    Currently viewing
                    <span class="muted" *ngIf="!liveConnected">— connection lost, reconnecting…</span>
                </div>
                <table class="table table-compact">
                    <thead>
                        <tr>
                            <th>Visitor</th>
                            <th>URL</th>
                            <th>Country</th>
                            <th class="num-col">Last seen</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let v of liveRecent" class="clickable" (click)="openProfile(v.visitorId)">
                            <td class="mono">{{ v.visitorId | slice:0:10 }}…</td>
                            <td><span class="url">{{ v.url }}</span></td>
                            <td>{{ v.country || '—' }}</td>
                            <td class="num-col">{{ v.secondsAgo }}s ago</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </vdr-page-block>

        <!-- ── Daily activity chart — line chart over the summary's daily
             series. Series toggles are multi-select (identity colors are
             fixed per series and never repaint on toggle); state persists
             in localStorage alongside the section collapse prefs. -->
        <vdr-page-block>
            <div class="card">
                <div class="card-block">
                    <button type="button" class="collapse-head" (click)="toggleSection('chart')" [attr.aria-expanded]="sectionOpen['chart']">
                        <h3 class="card-title">Daily activity <span class="muted">(last {{ days }} days)</span></h3>
                        <clr-icon shape="angle" [attr.dir]="sectionOpen['chart'] ? 'down' : 'right'"></clr-icon>
                    </button>
                    <ng-container *ngIf="sectionOpen['chart']">
                        <div class="series-toggles" role="group" aria-label="Chart series">
                            <button *ngFor="let sd of seriesDefs" type="button"
                                class="series-pill" [class.on]="seriesOn[sd.key]"
                                [attr.aria-pressed]="seriesOn[sd.key]"
                                (click)="toggleSeries(sd.key)">
                                <span class="series-chip" [style.background]="seriesOn[sd.key] ? sd.color : 'transparent'" [style.borderColor]="sd.color"></span>
                                {{ sd.label }}
                            </button>
                        </div>
                        <div *ngIf="!chart" class="muted pad">No data in this range.</div>
                        <div class="chart-wrap" *ngIf="chart">
                            <svg #dailySvg class="daily-chart" viewBox="0 0 800 240" preserveAspectRatio="none" role="img"
                                [attr.aria-label]="'Daily activity chart, ' + days + ' days'"
                                (mousemove)="onChartMove($event, dailySvg)" (mouseleave)="onChartLeave()">
                                <!-- recessive gridlines + y labels -->
                                <g *ngFor="let t of chart.ticks">
                                    <line [attr.x1]="chart.L" [attr.x2]="chart.R" [attr.y1]="t.y" [attr.y2]="t.y" class="gridline"/>
                                    <text [attr.x]="chart.L - 6" [attr.y]="t.y + 3" class="axis-label" text-anchor="end">{{ t.label }}</text>
                                </g>
                                <!-- x labels -->
                                <text *ngFor="let xl of chart.xlabels" [attr.x]="xl.x" y="236" class="axis-label" text-anchor="middle">{{ xl.label }}</text>
                                <!-- series lines: 2px, color fixed per series -->
                                <polyline *ngFor="let ln of chart.lines" [attr.points]="ln.points"
                                    fill="none" [attr.stroke]="ln.color" stroke-width="2"
                                    stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                                <!-- hover crosshair + markers -->
                                <g *ngIf="hoverIdx !== null && chart.xs[hoverIdx] !== undefined">
                                    <line [attr.x1]="chart.xs[hoverIdx]" [attr.x2]="chart.xs[hoverIdx]" y1="10" y2="216" class="crosshair"/>
                                    <circle *ngFor="let ln of chart.lines" [attr.cx]="chart.xs[hoverIdx]" [attr.cy]="ln.ys[hoverIdx]"
                                        r="4" [attr.fill]="ln.color" class="hover-dot"/>
                                </g>
                            </svg>
                            <!-- tooltip: text tokens carry the values; colored chips carry identity -->
                            <div class="chart-tip" *ngIf="hoverIdx !== null && chart.days[hoverIdx]"
                                [style.left.%]="(chart.xs[hoverIdx] / 800) * 100"
                                [class.flip]="chart.xs[hoverIdx] > 560">
                                <div class="tip-date">{{ chart.days[hoverIdx].label }}</div>
                                <div class="tip-row" *ngFor="let ln of chart.lines">
                                    <span class="series-chip" [style.background]="ln.color"></span>
                                    <span class="tip-name">{{ ln.label }}</span>
                                    <span class="tip-val">{{ chart.days[hoverIdx].values[ln.key] | number }}</span>
                                </div>
                            </div>
                        </div>
                    </ng-container>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="card">
                <div class="card-block">
                    <button type="button" class="collapse-head" (click)="toggleSection('funnel')" [attr.aria-expanded]="sectionOpen['funnel']">
                        <h3 class="card-title">Funnel <span class="muted">(last {{ days }} days)</span></h3>
                        <clr-icon shape="angle" [attr.dir]="sectionOpen['funnel'] ? 'down' : 'right'"></clr-icon>
                    </button>
                    <ng-container *ngIf="sectionOpen['funnel']">
                    <div *ngIf="funnel.length === 0" class="empty-note">No funnel data in this range yet.</div>
                    <ng-container *ngIf="funnel.length > 0">
                        <div class="funnel-headline" *ngIf="overallConversion() !== null">
                            <span class="funnel-headline-num">{{ overallConversion() }}%</span>
                            of visitors reach checkout confirmation
                        </div>
                        <div class="funnel">
                            <div class="funnel-row" *ngFor="let s of funnel; let i = index">
                                <div class="funnel-label">{{ s.label }}</div>
                                <div class="funnel-track">
                                    <div class="funnel-bar-fill" [style.width.%]="funnelPct(s)"></div>
                                </div>
                                <div class="funnel-num">
                                    <strong>{{ s.visitors | number }}</strong>
                                    <span class="funnel-pct" *ngIf="i > 0">{{ funnelPct(s) | number:'1.0-1' }}%</span>
                                </div>
                            </div>
                        </div>
                    </ng-container>
                    </ng-container>
                </div>
            </div>
        </vdr-page-block>

        <!-- ── Audience & acquisition: where visitors come from, what
             they use. Sources uses the existing (previously unsurfaced)
             endpoint; countries/devices use the new breakdown endpoint.
             All bars are one-hue magnitude encodings on the brand hue. -->
        <vdr-page-block>
            <div class="card">
                <div class="card-block">
                    <button type="button" class="collapse-head" (click)="toggleSection('audience')" [attr.aria-expanded]="sectionOpen['audience']">
                        <h3 class="card-title">Audience &amp; acquisition <span class="muted">(last {{ days }} days)</span></h3>
                        <clr-icon shape="angle" [attr.dir]="sectionOpen['audience'] ? 'down' : 'right'"></clr-icon>
                    </button>
                    <ng-container *ngIf="sectionOpen['audience']">
                    <div class="aud-grid">
                        <div class="aud-col">
                            <h4 class="aud-title">Traffic sources</h4>
                            <div *ngIf="sources.length === 0" class="empty-note">No source data yet.</div>
                            <div class="mini-row" *ngFor="let r of sources">
                                <span class="mini-label" [title]="r.source + ' / ' + r.medium">{{ r.source }}<span class="mini-medium"> · {{ r.medium }}</span></span>
                                <span class="mini-track"><span class="mini-fill" [style.width.%]="miniPct(r.visitors, sourcesMax)"></span></span>
                                <span class="mini-num">{{ r.visitors | number }}</span>
                            </div>
                        </div>
                        <div class="aud-col">
                            <h4 class="aud-title">Countries</h4>
                            <div *ngIf="breakdown.countries.length === 0" class="empty-note">No location data yet.</div>
                            <div class="mini-row" *ngFor="let r of breakdown.countries">
                                <span class="mini-label">{{ r.label }}</span>
                                <span class="mini-track"><span class="mini-fill" [style.width.%]="miniPct(r.visitors, breakdownMax('countries'))"></span></span>
                                <span class="mini-num">{{ r.visitors | number }}</span>
                            </div>
                        </div>
                        <div class="aud-col">
                            <h4 class="aud-title">Devices</h4>
                            <div *ngIf="breakdown.devices.length === 0" class="empty-note">No device data yet.</div>
                            <div class="mini-row" *ngFor="let r of breakdown.devices">
                                <span class="mini-label">{{ r.label }}</span>
                                <span class="mini-track"><span class="mini-fill" [style.width.%]="miniPct(r.visitors, breakdownMax('devices'))"></span></span>
                                <span class="mini-num">{{ r.visitors | number }}</span>
                            </div>
                        </div>
                    </div>
                    </ng-container>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="two-col">
                <div class="card">
                    <div class="card-block">
                        <button type="button" class="collapse-head" (click)="toggleSection('top')" [attr.aria-expanded]="sectionOpen['top']">
                            <h3 class="card-title">
                                Top pages
                                <span class="muted">{{ topTotal | number }} total</span>
                            </h3>
                            <clr-icon shape="angle" [attr.dir]="sectionOpen['top'] ? 'down' : 'right'"></clr-icon>
                        </button>
                        <ng-container *ngIf="sectionOpen['top']">
                        <div *ngIf="topPages.length === 0" class="muted pad">No data.</div>
                        <table class="table table-compact" *ngIf="topPages.length > 0">
                            <thead>
                                <tr><th>URL</th><th class="num-col">Views</th><th class="num-col">Unique</th><th class="num-col">Avg time</th></tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let p of topPages">
                                    <td>
                                        <div class="url">{{ p.url }}</div>
                                        <div class="help-text" *ngIf="p.title">{{ p.title }}</div>
                                    </td>
                                    <td class="num-col">{{ p.views | number }}</td>
                                    <td class="num-col">{{ p.uniqueVisitors | number }}</td>
                                    <td class="num-col">{{ humanTime(p.avgTimeMs) }}</td>
                                </tr>
                            </tbody>
                        </table>
                        <div class="pager" *ngIf="topTotal > topTake">
                            <button class="btn btn-sm" (click)="topPrev()" [disabled]="topSkip === 0">‹ Prev</button>
                            <span class="muted">{{ topSkip + 1 }}–{{ topSkip + topPages.length }} of {{ topTotal }}</span>
                            <button class="btn btn-sm" (click)="topNext()" [disabled]="topSkip + topTake >= topTotal">Next ›</button>
                        </div>
                        </ng-container>
                    </div>
                </div>

                <div class="card">
                    <div class="card-block">
                        <button type="button" class="collapse-head" (click)="toggleSection('exit')" [attr.aria-expanded]="sectionOpen['exit']">
                            <h3 class="card-title">
                                Exit pages
                                <span class="muted">{{ exitTotal | number }} total</span>
                            </h3>
                            <clr-icon shape="angle" [attr.dir]="sectionOpen['exit'] ? 'down' : 'right'"></clr-icon>
                        </button>
                        <ng-container *ngIf="sectionOpen['exit']">
                        <div *ngIf="exitPages.length === 0" class="muted pad">No data.</div>
                        <table class="table table-compact" *ngIf="exitPages.length > 0">
                            <thead>
                                <tr><th>URL</th><th class="num-col">Exits</th></tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let p of exitPages">
                                    <td>
                                        <div class="url">{{ p.url }}</div>
                                        <div class="help-text" *ngIf="p.title">{{ p.title }}</div>
                                    </td>
                                    <td class="num-col">{{ p.exits | number }}</td>
                                </tr>
                            </tbody>
                        </table>
                        <div class="pager" *ngIf="exitTotal > exitTake">
                            <button class="btn btn-sm" (click)="exitPrev()" [disabled]="exitSkip === 0">‹ Prev</button>
                            <span class="muted">{{ exitSkip + 1 }}–{{ exitSkip + exitPages.length }} of {{ exitTotal }}</span>
                            <button class="btn btn-sm" (click)="exitNext()" [disabled]="exitSkip + exitTake >= exitTotal">Next ›</button>
                        </div>
                        </ng-container>
                    </div>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="card">
                <div class="card-block">
                    <button type="button" class="collapse-head" (click)="toggleSection('visitors')" [attr.aria-expanded]="sectionOpen['visitors']">
                        <h3 class="card-title">
                            Visitors
                            <span class="muted">{{ recentTotal | number }} total · click a row for the full profile</span>
                        </h3>
                        <clr-icon shape="angle" [attr.dir]="sectionOpen['visitors'] ? 'down' : 'right'"></clr-icon>
                    </button>
                    <ng-container *ngIf="sectionOpen['visitors']">
                    <div *ngIf="recent.length === 0" class="muted pad">No visitors in this range.</div>
                    <table class="table table-compact" *ngIf="recent.length > 0">
                        <thead>
                            <tr>
                                <th>Visitor</th>
                                <th>Customer</th>
                                <th>Location</th>
                                <th>Browser · OS · device</th>
                                <th class="num-col">Sessions</th>
                                <th class="num-col">Pageviews</th>
                                <th>Last seen</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let v of recent" class="clickable" (click)="openProfile(v.visitorId)">
                                <td class="mono">{{ v.visitorId | slice:0:10 }}…</td>
                                <td>
                                    <a *ngIf="v.customerId" [routerLink]="['/customers', v.customerId]" (click)="$event.stopPropagation()">
                                        #{{ v.customerId }}
                                    </a>
                                    <span *ngIf="!v.customerId" class="muted">guest</span>
                                </td>
                                <td>
                                    <span *ngIf="v.country">{{ v.country }}<span *ngIf="v.city"> · {{ v.city }}</span></span>
                                    <span *ngIf="!v.country" class="muted">—</span>
                                </td>
                                <td>
                                    <span *ngIf="v.browser">{{ v.browser }}</span>
                                    <span *ngIf="v.os" class="muted"> · {{ v.os }}</span>
                                    <span *ngIf="v.device" class="muted"> · {{ v.device }}</span>
                                </td>
                                <td class="num-col">{{ v.sessions | number }}</td>
                                <td class="num-col">{{ v.pageviews | number }}</td>
                                <td>{{ v.lastSeenAt | date:'short' }}</td>
                                <td>
                                    <button class="btn btn-sm btn-link" (click)="openProfile(v.visitorId); $event.stopPropagation()">
                                        <clr-icon shape="eye"></clr-icon> View
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <div class="pager" *ngIf="recentTotal > recentTake">
                        <button class="btn btn-sm" (click)="recentPrev()" [disabled]="recentSkip === 0">‹ Prev</button>
                        <span class="muted">{{ recentSkip + 1 }}–{{ recentSkip + recent.length }} of {{ recentTotal }}</span>
                        <button class="btn btn-sm" (click)="recentNext()" [disabled]="recentSkip + recentTake >= recentTotal">Next ›</button>
                    </div>
                    </ng-container>
                </div>
            </div>
        </vdr-page-block>

        <!-- Visitor profile drawer -->
        <div class="drawer-overlay" *ngIf="selectedProfile || profileLoading" (click)="closeProfile()">
            <div class="drawer" (click)="$event.stopPropagation()">
                <div class="drawer-head">
                    <h3>Visitor profile</h3>
                    <button class="btn btn-link" (click)="closeProfile()">
                        <clr-icon shape="times"></clr-icon> Close
                    </button>
                </div>
                <div class="drawer-body" *ngIf="profileLoading">Loading…</div>
                <div class="drawer-body" *ngIf="selectedProfile">
                    <div class="profile-grid">
                        <div>
                            <div class="lbl">Visitor ID</div>
                            <div class="mono small">{{ selectedProfile.visitorId }}</div>
                        </div>
                        <div>
                            <div class="lbl">First seen</div>
                            <div>{{ selectedProfile.firstSeenAt | date:'medium' }}</div>
                        </div>
                        <div>
                            <div class="lbl">Last seen</div>
                            <div>{{ selectedProfile.lastSeenAt | date:'medium' }}</div>
                        </div>
                        <div>
                            <div class="lbl">Customer</div>
                            <div *ngIf="selectedProfile.customer">
                                <a [routerLink]="['/customers', selectedProfile.customer.id]">
                                    {{ selectedProfile.customer.firstName }} {{ selectedProfile.customer.lastName }}
                                </a>
                                <div class="help-text">{{ selectedProfile.customer.emailAddress }}</div>
                            </div>
                            <div *ngIf="!selectedProfile.customer" class="muted">Guest — never signed in</div>
                        </div>
                    </div>

                    <h4 class="section">Totals</h4>
                    <div class="profile-grid four">
                        <div><div class="lbl">Sessions</div><div class="big">{{ selectedProfile.totals.sessions }}</div></div>
                        <div><div class="lbl">Pageviews</div><div class="big">{{ selectedProfile.totals.pageviews }}</div></div>
                        <div><div class="lbl">Custom events</div><div class="big">{{ selectedProfile.totals.events }}</div></div>
                        <div><div class="lbl">Total time</div><div class="big">{{ humanTime(selectedProfile.totals.timeMs) }}</div></div>
                    </div>

                    <h4 class="section">Network</h4>
                    <div class="profile-grid">
                        <div>
                            <div class="lbl">IP address</div>
                            <div class="mono small">{{ selectedProfile.ip || '—' }}</div>
                            <div class="help-text">Hash: {{ selectedProfile.ipHash || '—' }}</div>
                        </div>
                        <div>
                            <div class="lbl">Country / Region / City</div>
                            <div>
                                <span *ngIf="selectedProfile.country">{{ selectedProfile.country }}</span>
                                <span *ngIf="selectedProfile.region"> / {{ selectedProfile.region }}</span>
                                <span *ngIf="selectedProfile.city"> / {{ selectedProfile.city }}</span>
                                <span *ngIf="!selectedProfile.country" class="muted">—</span>
                            </div>
                        </div>
                        <div>
                            <div class="lbl">Timezone</div>
                            <div>{{ selectedProfile.timezone || '—' }}</div>
                        </div>
                        <div>
                            <div class="lbl">Channel</div>
                            <div>#{{ selectedProfile.channelId }}</div>
                        </div>
                    </div>

                    <h4 class="section">Device</h4>
                    <div class="profile-grid">
                        <div>
                            <div class="lbl">Browser</div>
                            <div>{{ selectedProfile.browser || '—' }}<span *ngIf="selectedProfile.browserVersion"> {{ selectedProfile.browserVersion }}</span></div>
                        </div>
                        <div>
                            <div class="lbl">OS</div>
                            <div>{{ selectedProfile.os || '—' }}<span *ngIf="selectedProfile.osVersion"> {{ selectedProfile.osVersion }}</span></div>
                        </div>
                        <div>
                            <div class="lbl">Device type</div>
                            <div>{{ selectedProfile.device || '—' }}</div>
                        </div>
                        <div>
                            <div class="lbl">Accept-Language</div>
                            <div class="mono small">{{ selectedProfile.acceptLanguage || '—' }}</div>
                        </div>
                    </div>

                    <h4 class="section">User agent</h4>
                    <div class="ua-box">{{ selectedProfile.userAgent || '—' }}</div>

                    <h4 class="section">Sessions ({{ selectedSessions.length }})</h4>
                    <table class="table table-compact" *ngIf="selectedSessions.length > 0">
                        <thead>
                            <tr><th>Session</th><th>Started</th><th>Entry</th><th class="num-col">Events</th><th class="num-col">Pageviews</th><th class="num-col">Time</th></tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let s of selectedSessions">
                                <td class="mono small">{{ s.sessionId | slice:0:10 }}…</td>
                                <td class="small">{{ s.startedAt | date:'short' }}</td>
                                <td class="mono small">{{ s.entryUrl || '—' }}</td>
                                <td class="num-col">{{ s.events }}</td>
                                <td class="num-col">{{ s.pageviews }}</td>
                                <td class="num-col">{{ humanTime(s.timeMs) }}</td>
                            </tr>
                        </tbody>
                    </table>

                    <h4 class="section">Journey (every event)</h4>
                    <ol class="journey" *ngIf="journey.length > 0">
                        <li *ngFor="let e of journey" [ngClass]="'event-' + e.type">
                            <span class="event-time">{{ e.createdAt | date:'short' }}</span>
                            <span class="event-type">{{ e.type }}</span>
                            <span class="event-url">
                                {{ e.url }}
                                <span class="muted" *ngIf="e.title"> · {{ e.title }}</span>
                            </span>
                            <span class="event-time-on" *ngIf="e.timeOnPageMs">{{ humanTime(e.timeOnPageMs) }}</span>
                        </li>
                    </ol>
                    <div *ngIf="journey.length === 0" class="muted pad">No events.</div>
                </div>
            </div>
        </div>
    `,
    styles: [`
        .lic-banner { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:12px 16px; border-radius:10px; font-size:13px; background:var(--gb-tint-warn, #fef3c7); border:1px solid var(--gb-line-warn, #fcd34d); }
        .lic-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
        .upd-cmd { font-family: monospace; font-size: 12px; background: rgba(0,0,0,.06); padding: 2px 6px; border-radius: 5px; }
        [data-theme='dark'] .upd-cmd, :host-context([data-theme='dark']) .upd-cmd { background: rgba(255,255,255,.1); }
        .lic-key { padding:5px 9px; border:1px solid var(--gb-ui-border, #d1d5db); border-radius:7px; font-size:12.5px; min-width:280px; background:#fff; color:#0f172a; }

        :host { color: var(--color-text-100, inherit); display: block; }

        /* ── Unified card + table system ─────────────────────────── */
        .card {
            background: var(--color-component-bg-100, #fff);
            border: 1px solid var(--color-component-border-200, #e2e8f0);
            border-radius: 12px; overflow: hidden;
        }
        .card-block { padding: 18px 20px; }
        .card-title { font-size: 15px; font-weight: 700; color: var(--color-text-100, #0f172a); margin: 0; }
        .card-title .muted { font-weight: 500; font-size: 12px; }
        .muted { color: var(--color-component-color-300, #64748b); }
        .empty-note { padding: 20px 0; font-size: 13px; color: var(--color-component-color-300, #64748b); }
        .table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .table th {
            text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
            text-transform: uppercase; color: var(--color-component-color-300, #64748b);
            padding: 8px 10px; border-bottom: 1px solid var(--color-component-border-200, #e2e8f0);
        }
        .table td { padding: 9px 10px; border-bottom: 1px solid var(--color-component-border-100, #f1f5f9); color: var(--color-text-100, inherit); }
        .table tbody tr:hover { background: var(--color-component-bg-200, #f8fafc); }
        .table .num-col { text-align: right; font-variant-numeric: tabular-nums; }
        .table th.num-col { text-align: right; }
        .url { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
        .help-text { font-size: 11px; color: var(--color-component-color-300, #64748b); max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pager { display: flex; align-items: center; justify-content: center; gap: 12px; padding-top: 12px; font-size: 12px; }

        /* ── Audience & acquisition mini-bars (one-hue magnitude) ── */
        .aud-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 24px; }
        .aud-title {
            font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
            color: var(--color-component-color-300, #64748b); margin: 0 0 10px;
        }
        .mini-row { display: grid; grid-template-columns: minmax(90px, 140px) 1fr 48px; gap: 8px; align-items: center; padding: 3px 0; }
        .mini-label { font-size: 12px; color: var(--color-text-100, #0f172a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mini-medium { color: var(--color-component-color-300, #64748b); }
        .mini-track { height: 8px; background: var(--color-component-bg-200, #f1f5f9); border-radius: 999px; overflow: hidden; }
        .mini-fill { display: block; height: 100%; background: var(--color-primary-500, #f59e0b); border-radius: 999px; }
        .mini-num { font-size: 12px; text-align: right; color: var(--color-component-color-200, #475569); font-variant-numeric: tabular-nums; }

        /* ── Chart series colors — categorical identity, fixed order.
           Validated (scripts/validate_palette.js): light set passes all
           six checks on the light admin surface; dark steps pass on
           #1f2937. Colors follow the SERIES, never its toggle rank. */
        :host {
            --hulo-s1: #2a78d6; /* unique visitors — blue */
            --hulo-s2: #eb6834; /* sessions — orange */
            --hulo-s3: #1baf7a; /* page views — aqua */
            --hulo-s4: #eda100; /* events — yellow */
        }
        :host-context([data-theme='dark']),
        :host-context(.theme-dark) {
            --hulo-s1: #3987e5;
            --hulo-s2: #d95926;
            --hulo-s3: #199e70;
            --hulo-s4: #c98500;
        }

        /* ── Collapsible section headers ─────────────────────────── */
        .collapse-head {
            display: flex; align-items: center; justify-content: space-between;
            width: 100%; background: none; border: 0; padding: 0; cursor: pointer;
            text-align: left; color: inherit;
        }
        .collapse-head .card-title { margin-bottom: 0; }
        .collapse-head clr-icon { color: var(--color-component-color-300, #64748b); }
        .collapse-head:hover clr-icon { color: var(--color-primary-500, #f59e0b); }
        .collapse-head[aria-expanded='true'] .card-title { margin-bottom: 12px; }

        /* ── Daily activity chart ────────────────────────────────── */
        .series-toggles { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
        .series-pill {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 5px 12px; min-height: 30px; border-radius: 999px;
            border: 1px solid var(--color-component-border-200, #d1d5db);
            background: var(--color-component-bg-100, #fff);
            color: var(--color-component-color-200, #475569);
            font-size: 12px; font-weight: 600; cursor: pointer;
            transition: border-color 0.15s ease, color 0.15s ease;
        }
        .series-pill.on { color: var(--color-text-100, #0f172a); border-color: var(--color-component-border-300, #94a3b8); }
        .series-pill:hover { border-color: var(--color-primary-500, #f59e0b); }
        .series-chip {
            width: 10px; height: 10px; border-radius: 3px; display: inline-block;
            border: 1.5px solid transparent; flex: 0 0 auto;
        }
        .chart-wrap { position: relative; }
        .daily-chart { width: 100%; height: 240px; display: block; }
        .gridline { stroke: var(--color-component-border-100, #e2e8f0); stroke-width: 1; }
        .axis-label { fill: var(--color-component-color-300, #64748b); font-size: 10px; }
        .crosshair { stroke: var(--color-component-color-300, #94a3b8); stroke-width: 1; stroke-dasharray: 3 3; }
        .hover-dot { stroke: var(--color-component-bg-100, #fff); stroke-width: 2; }
        .chart-tip {
            position: absolute; top: 8px; transform: translateX(10px);
            background: var(--color-component-bg-100, #fff);
            border: 1px solid var(--color-component-border-200, #d1d5db);
            border-radius: 8px; padding: 8px 10px; pointer-events: none;
            box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12); z-index: 5;
            min-width: 150px;
        }
        .chart-tip.flip { transform: translateX(calc(-100% - 10px)); }
        .tip-date { font-size: 11px; font-weight: 700; color: var(--color-text-100, #0f172a); margin-bottom: 4px; }
        .tip-row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 1px 0; }
        .tip-name { color: var(--color-component-color-200, #475569); flex: 1; }
        .tip-val { font-weight: 700; color: var(--color-text-100, #0f172a); font-variant-numeric: tabular-nums; }

        /* ── HULO shared hero + help pattern ─────────────────────── */
        .hulo-hero {
            display: flex; align-items: center; gap: 18px;
            padding: 20px 22px; border-radius: 14px;
            background: linear-gradient(135deg, #0f1419 0%, #1e293b 100%);
            color: #fff;
            box-shadow: 0 1px 3px rgba(15,23,42,.15), 0 8px 24px rgba(15,23,42,.08);
        }
        .hulo-hero-logo { flex: 0 0 auto; width: 56px; height: 56px; }
        .hulo-hero-logo svg { width: 100%; height: 100%; display: block; }
        .hulo-hero-text { flex: 1 1 auto; min-width: 0; }
        .hulo-hero-title { color: #fff; font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
        .hulo-hero-sub { color: #cbd5e1; font-size: 13px; line-height: 1.5; margin: 4px 0 0; max-width: 640px; }
        .hulo-hero-actions { display: flex; gap: 6px; align-items: center; flex: 0 0 auto; }
        .hulo-hero-actions .btn { color: #f8fafc; }
        .hulo-hero-actions .btn:hover { color: #f59e0b; }
        .hulo-help-btn clr-icon { margin-right: 4px; }
        .hulo-help-drawer {
            background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px;
            padding: 20px 22px; color: #451a03;
        }
        .hulo-help-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
        .hulo-help-card { background: #ffffff; border-radius: 10px; padding: 16px; }
        .hulo-help-num { width: 24px; height: 24px; border-radius: 999px;
            background: #f59e0b; color: #fff; font-weight: 700; font-size: 13px;
            display: grid; place-items: center; margin-bottom: 8px; }
        .hulo-help-card h4 { margin: 0 0 4px; font-size: 14px; color: #0f172a; }
        .hulo-help-card p { margin: 0; font-size: 13px; line-height: 1.5; color: #475569; }
        .hulo-help-card code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
        .hulo-help-links { margin-top: 16px; padding-top: 14px; border-top: 1px solid #fde68a; display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; }
        .hulo-help-links a { color: #b45309; text-decoration: none; font-weight: 600; }
        .hulo-help-links a:hover { text-decoration: underline; }
        @media (max-width: 640px) {
            .hulo-hero { flex-wrap: wrap; }
            .hulo-hero-actions { width: 100%; justify-content: flex-end; }
        }

        .update-banner {
            display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap;
            padding: 12px 16px; border-radius: 8px;
            background: #ecfeff; border: 1px solid #67e8f9;
            color: #155e75; font-size: 13px;
        }
        .update-banner.major { background: #fef3c7; border-color: #fde68a; color: #92400e; }
        .update-banner strong { font-weight: 700; }
        .update-banner .major-pill { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 8px; background: #f59e0b; color: #fff; font-size: 10px; font-weight: 700; text-transform: uppercase; }
        .update-banner .actions { display: flex; gap: 8px; align-items: center; }

        /* Mobile under 768px */
        @media (max-width: 767px) {
            /* 44px tap targets on every interactive element in our component */
            :host button, :host .btn { min-height: 40px; }
            :host vdr-action-bar { flex-wrap: wrap; gap: 6px; }
            :host vdr-action-bar button { min-height: 40px; padding: 6px 12px; }
            /* Channel picker inside the HULO hero — dark chrome so it
               sits on the navy gradient without clashing. */
            .hulo-hero-select {
                background: rgba(255,255,255,0.08); color: #fff;
                border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;
                padding: 6px 10px; font-size: 13px; min-height: 34px; max-width: 200px;
            }
            .hulo-hero-select option { background: #0f172a; color: #fff; }
            .hulo-hero-select:focus { outline: none; border-color: #f59e0b;
                box-shadow: 0 0 0 3px rgba(245,158,11,0.25); }
            .range { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 8px 0; }
            .range .btn { min-height: 40px; min-width: 48px; padding: 6px 12px; font-size: 13px; }
            .kpi-row { gap: 8px; }
            .kpi { padding: 12px 14px; }
            .kpi-num { font-size: 20px; }
            .range { display: block; margin: 8px 0; }
            .two-col { grid-template-columns: 1fr; }
            .funnel-row { grid-template-columns: 1fr; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--color-component-border-200); }
            table { white-space: nowrap; }
            .profile-grid, .profile-grid.four { grid-template-columns: 1fr 1fr; }
            .drawer { width: 100% !important; max-width: 100% !important; }
            .update-banner { flex-direction: column; align-items: flex-start; }
            .update-banner .actions { width: 100%; justify-content: flex-end; }
        }
        @media (max-width: 380px) {
            .kpi-row { grid-template-columns: 1fr 1fr; }
        }

        .range { font-size: 12px; color: var(--color-component-color-300); margin-right: 8px; }
        .range .btn { padding: 2px 8px; min-width: 0; }
        .range .btn.active { font-weight: 700; color: var(--color-primary-500, #1d4ed8); }
        /* ── KPI stat tiles ─────────────────────────────────────── */
        .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
        .kpi {
            background: var(--color-component-bg-100, #fff);
            border: 1px solid var(--color-component-border-200, #e2e8f0);
            border-radius: 12px; padding: 16px 18px; min-width: 0;
        }
        .kpi-label {
            display: flex; align-items: center; gap: 6px;
            font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
            text-transform: uppercase; color: var(--color-component-color-300, #64748b);
        }
        .kpi-num {
            margin-top: 6px; font-size: 26px; font-weight: 700; line-height: 1.1;
            color: var(--color-text-100, #0f172a);
            font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
        }
        .kpi-delta { margin-top: 4px; font-size: 12px; font-weight: 600; color: var(--color-component-color-300, #64748b); }
        .kpi-delta.up { color: #047857; }
        .kpi-delta.down { color: #b91c1c; }
        .kpi-sub { margin-top: 4px; font-size: 12px; color: var(--color-component-color-300, #64748b); }
        .live-kpi { border-left: 4px solid #10b981; }
        .live-dot { width: 8px; height: 8px; border-radius: 999px; background: #9ca3af; display: inline-block; }
        .live-dot.connected { background: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,0.2); }
        @keyframes live-pulse {
            0%   { box-shadow: 0 0 0 0 rgba(239,68,68,.6); }
            70%  { box-shadow: 0 0 0 10px rgba(239,68,68,0); }
            100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
        }

        .live-strip {
            border: 1px solid var(--color-component-border-200);
            border-radius: 6px;
            background: var(--color-component-bg-100);
            padding: 12px;
        }
        .live-strip-title { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
        .card-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
        .card-title .muted { color: var(--color-component-color-300); font-weight: 400; font-size: 12px; margin-left: 8px; }
        .muted { color: var(--color-component-color-300); }
        .small { font-size: 11px; }
        .pad { padding: 24px; text-align: center; font-size: 13px; }

        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

        .table-compact th, .table-compact td { font-size: 12px; }
        .num-col { text-align: right; white-space: nowrap; }
        .url { font-family: var(--clr-font-family-monospace, monospace); font-size: 11px; word-break: break-all; }
        .help-text { font-size: 11px; color: var(--color-component-color-300); margin-top: 2px; }
        .mono { font-family: var(--clr-font-family-monospace, monospace); }
        tr.clickable { cursor: pointer; }
        tr.clickable:hover { background: var(--color-component-bg-200); }

        /* ── Funnel ─────────────────────────────────────────────── */
        .funnel-headline {
            display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px;
            font-size: 13px; color: var(--color-component-color-200, #475569);
        }
        .funnel-headline-num { font-size: 24px; font-weight: 700; color: var(--color-text-100, #0f172a); font-variant-numeric: tabular-nums; }
        .funnel { display: flex; flex-direction: column; gap: 10px; }
        .funnel-row { display: grid; grid-template-columns: 200px 1fr 130px; gap: 12px; align-items: center; }
        .funnel-label { font-size: 13px; font-weight: 600; color: var(--color-component-color-200, #475569); text-align: right; }
        .funnel-track { height: 22px; background: var(--color-component-bg-200, #f1f5f9); border-radius: 6px; overflow: hidden; }
        .funnel-bar-fill { height: 100%; background: var(--color-primary-500, #f59e0b); border-radius: 6px 4px 4px 6px; min-width: 2px; transition: width 0.3s ease; }
        .funnel-num { font-size: 13px; color: var(--color-text-100, #0f172a); font-variant-numeric: tabular-nums; white-space: nowrap; }
        .funnel-pct { margin-left: 8px; color: var(--color-component-color-300, #64748b); font-size: 12px; }
        @media (max-width: 640px) {
            .funnel-row { grid-template-columns: 1fr; gap: 4px; }
            .funnel-label { text-align: left; }
        }

        .pager {
            display: flex; align-items: center; justify-content: flex-end; gap: 8px;
            padding: 10px 0; font-size: 12px;
        }

        /* Profile drawer */
        .drawer-overlay {
            position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 1000;
            display: flex; justify-content: flex-end;
        }
        .drawer {
            background: var(--color-component-bg-100);
            width: 720px; max-width: 92vw; height: 100vh;
            overflow-y: auto; box-shadow: -4px 0 16px rgba(0,0,0,.18);
            display: flex; flex-direction: column;
        }
        .drawer-head {
            position: sticky; top: 0; background: var(--color-component-bg-100);
            display: flex; justify-content: space-between; align-items: center;
            padding: 16px 24px; border-bottom: 1px solid var(--color-component-border-200);
            z-index: 1;
        }
        .drawer-body { padding: 18px 24px 80px; }
        .section { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; margin: 22px 0 8px; color: var(--color-component-color-300); }
        .profile-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 14px 22px;
        }
        .profile-grid.four { grid-template-columns: repeat(4, 1fr); }
        .lbl { font-size: 11px; color: var(--color-component-color-300); text-transform: uppercase; margin-bottom: 2px; }
        .big { font-size: 18px; font-weight: 700; }
        .ua-box {
            font-family: var(--clr-font-family-monospace, monospace);
            font-size: 11px; padding: 10px;
            background: var(--color-component-bg-200);
            border: 1px solid var(--color-component-border-200);
            border-radius: 4px;
            word-break: break-all;
        }

        .journey { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
        .journey li {
            display: grid; grid-template-columns: 140px 70px 1fr auto; gap: 8px;
            padding: 6px 10px; border-radius: 4px; font-size: 12px;
            background: var(--color-component-bg-200);
            border-left: 3px solid var(--color-component-border-200);
        }
        .journey li.event-pageview { border-left-color: #3b82f6; }
        .journey li.event-unload   { border-left-color: #6b7280; }
        .journey li.event-event    { border-left-color: #10b981; }
        .event-time { color: var(--color-component-color-300); font-family: var(--clr-font-family-monospace, monospace); }
        .event-type { font-weight: 600; text-transform: uppercase; font-size: 10px; }
        .event-url { font-family: var(--clr-font-family-monospace, monospace); word-break: break-all; }
        .event-time-on { color: var(--color-component-color-300); }
    `],
})
export class VisitorsComponent implements OnInit, OnDestroy {
    loading = false;
    days = 30;

    /** Channel filter — null = All channels (aggregate). Populated by
     *  `loadChannels()` on init. Every API call carries `channelId`
     *  when set. */
    channelId: number | null = null;
    channels: Array<{ id: number; code: string }> = [];

    // ── Daily-activity chart ────────────────────────────────────────
    // Series colors are FIXED per series (identity), validated for
    // CVD separation + lightness on both admin surfaces — see the
    // :host CSS vars. Toggling a series never repaints the others.
    daily: Array<{ day: string; visitors: number; sessions: number; events: number; pageviews: number }> = [];
    seriesDefs = [
        { key: 'visitors', label: 'Unique visitors', color: 'var(--hulo-s1)' },
        { key: 'sessions', label: 'Sessions', color: 'var(--hulo-s2)' },
        { key: 'pageviews', label: 'Page views', color: 'var(--hulo-s3)' },
        { key: 'events', label: 'Events', color: 'var(--hulo-s4)' },
    ];
    seriesOn: Record<string, boolean> = { visitors: true, sessions: true, pageviews: false, events: false };
    chart: {
        L: number; R: number;
        ticks: Array<{ y: number; label: string }>;
        xlabels: Array<{ x: number; label: string }>;
        lines: Array<{ key: string; label: string; color: string; points: string; ys: number[] }>;
        xs: number[];
        days: Array<{ label: string; values: Record<string, number> }>;
    } | null = null;
    hoverIdx: number | null = null;

    // ── Collapsible sections (persisted) ────────────────────────────
    sectionOpen: Record<string, boolean> = { chart: true, funnel: true, audience: true, top: true, exit: true, visitors: true };
    private readonly prefsKey = 'hulo-visitor-journey-prefs';

    private restorePrefs(): void {
        try {
            const p = JSON.parse(localStorage.getItem(this.prefsKey) || '{}');
            if (p.series && typeof p.series === 'object') Object.assign(this.seriesOn, p.series);
            if (p.sections && typeof p.sections === 'object') Object.assign(this.sectionOpen, p.sections);
            // Never restore into a state with zero visible series.
            if (!this.seriesDefs.some(sd => this.seriesOn[sd.key])) this.seriesOn['visitors'] = true;
        } catch { /* corrupted prefs — fall back to defaults */ }
    }

    private savePrefs(): void {
        try {
            localStorage.setItem(this.prefsKey, JSON.stringify({ series: this.seriesOn, sections: this.sectionOpen }));
        } catch { /* storage full/blocked — non-fatal */ }
    }

    toggleSection(key: string): void {
        this.sectionOpen[key] = !this.sectionOpen[key];
        this.savePrefs();
        this.cdr.markForCheck();
    }

    toggleSeries(key: string): void {
        // Keep at least one series visible.
        const activeCount = this.seriesDefs.filter(sd => this.seriesOn[sd.key]).length;
        if (this.seriesOn[key] && activeCount <= 1) return;
        this.seriesOn[key] = !this.seriesOn[key];
        this.savePrefs();
        this.rebuildChart();
        this.cdr.markForCheck();
    }

    /** Nice ceiling for the y-axis: 1/2/5 × 10^n at or above v. */
    private niceCeil(v: number): number {
        if (v <= 0) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(v)));
        for (const m of [1, 2, 5, 10]) {
            if (m * mag >= v) return m * mag;
        }
        return 10 * mag;
    }

    private rebuildChart(): void {
        const days = this.daily || [];
        const active = this.seriesDefs.filter(sd => this.seriesOn[sd.key]);
        if (days.length === 0 || active.length === 0) { this.chart = null; this.hoverIdx = null; return; }
        const L = 44, R = 788, T = 10, B = 216;
        const maxVal = Math.max(1, ...days.map(d => Math.max(...active.map(sd => Number((d as any)[sd.key]) || 0))));
        const yMax = this.niceCeil(maxVal);
        const x = (i: number) => (days.length === 1 ? (L + R) / 2 : L + (i * (R - L)) / (days.length - 1));
        const y = (v: number) => B - (v / yMax) * (B - T);
        const fmtDay = (raw: string) => {
            const d = new Date(raw);
            return isNaN(d.getTime()) ? String(raw).slice(5) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        };
        const xs = days.map((_, i) => Math.round(x(i) * 10) / 10);
        const lines = active.map(sd => {
            const ys = days.map(d => Math.round(y(Number((d as any)[sd.key]) || 0) * 10) / 10);
            return {
                key: sd.key, label: sd.label, color: sd.color, ys,
                points: xs.map((px, i) => px + ',' + ys[i]).join(' '),
            };
        });
        const ticks = [0, 0.5, 1].map(f => ({
            y: Math.round(y(yMax * f) * 10) / 10,
            label: String(Math.round(yMax * f)),
        }));
        const labelEvery = Math.max(1, Math.ceil(days.length / 6));
        const xlabels = days
            .map((d, i) => ({ i, d }))
            .filter(({ i }) => i % labelEvery === 0 || i === days.length - 1)
            .map(({ i, d }) => ({ x: xs[i], label: fmtDay(d.day) }));
        this.chart = {
            L, R, ticks, xlabels, lines, xs,
            days: days.map(d => ({
                label: fmtDay(d.day),
                values: {
                    visitors: Number(d.visitors) || 0,
                    sessions: Number(d.sessions) || 0,
                    pageviews: Number(d.pageviews) || 0,
                    events: Number(d.events) || 0,
                },
            })),
        };
    }

    onChartMove(ev: MouseEvent, svg: SVGSVGElement): void {
        if (!this.chart || this.chart.xs.length === 0) return;
        const rect = svg.getBoundingClientRect();
        const vx = ((ev.clientX - rect.left) / rect.width) * 800;
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < this.chart.xs.length; i++) {
            const d = Math.abs(this.chart.xs[i] - vx);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        if (this.hoverIdx !== best) { this.hoverIdx = best; this.cdr.markForCheck(); }
    }

    onChartLeave(): void {
        if (this.hoverIdx !== null) { this.hoverIdx = null; this.cdr.markForCheck(); }
    }

    // ── KPI deltas vs the previous period ───────────────────────────
    previous: { visitors: number; sessions: number; pageviews: number; avgTimeMs: number } | null = null;

    delta(key: 'visitors' | 'sessions' | 'pageviews'): number {
        const prev = this.previous?.[key] ?? 0;
        const cur = (this.summary as any)[key] ?? 0;
        if (!prev) return 0;
        return Math.round(((cur - prev) / prev) * 100);
    }

    deltaLabel(key: 'visitors' | 'sessions' | 'pageviews'): string {
        const prev = this.previous?.[key] ?? 0;
        if (!prev) return 'no prior data';
        const d = this.delta(key);
        const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '—';
        return `${arrow} ${Math.abs(d)}% vs previous ${this.days}d`;
    }

    pagesPerSession(): string {
        const s = this.summary.sessions || 0;
        if (!s) return '—';
        return (this.summary.pageviews / s).toFixed(1);
    }

    // ── Funnel derived numbers ──────────────────────────────────────
    overallConversion(): string | null {
        if (this.funnel.length < 2 || !this.funnel[0].visitors) return null;
        const last = this.funnel[this.funnel.length - 1];
        return ((last.visitors / this.funnel[0].visitors) * 100).toFixed(1);
    }

    // ── Audience & acquisition ──────────────────────────────────────
    sources: Array<{ source: string; medium: string; visitors: number }> = [];
    sourcesMax = 1;
    breakdown: { countries: Array<{ label: string; visitors: number }>; devices: Array<{ label: string; visitors: number }>; browsers: Array<{ label: string; visitors: number }> } = { countries: [], devices: [], browsers: [] };

    miniPct(v: number, max: number): number {
        return max > 0 ? Math.max(2, (v / max) * 100) : 0;
    }

    breakdownMax(key: 'countries' | 'devices' | 'browsers'): number {
        return Math.max(1, ...this.breakdown[key].map(r => r.visitors));
    }

    private loadAudience(): void {
        this.http.get<any>(`/ees/visitors/sources?${this.q()}&take=6`).subscribe({
            next: (r) => {
                this.sources = (r?.sources || []).slice(0, 6);
                this.sourcesMax = Math.max(1, ...this.sources.map((x) => x.visitors));
                this.cdr.markForCheck();
            },
            error: () => { /* panel shows empty-note */ },
        });
        this.http.get<any>(`/ees/visitors/breakdown?${this.q()}`).subscribe({
            next: (r) => {
                this.breakdown = {
                    countries: r?.countries || [],
                    devices: r?.devices || [],
                    browsers: r?.browsers || [],
                };
                this.cdr.markForCheck();
            },
            error: () => { /* panel shows empty-note */ },
        });
    }

    summary = { visitors: 0, sessions: 0, pageviews: 0, avgTimeMs: 0 };
    funnel: FunnelStage[] = [];

    // Live-now SSE state.
    private liveSource: EventSource | null = null;
    liveCount = 0;
    liveConnected = false;
    liveUpdatedAt: Date | null = null;
    liveRecent: Array<{ visitorId: string; url: string; country: string | null; secondsAgo: number }> = [];

    topPages: TopPage[] = [];
    topTotal = 0;
    topTake = 25;
    topSkip = 0;

    exitPages: ExitPage[] = [];
    exitTotal = 0;
    exitTake = 25;
    exitSkip = 0;

    recent: RecentVisitor[] = [];
    recentTotal = 0;
    recentTake = 25;
    recentSkip = 0;

    // Drawer
    selectedProfile: VisitorProfile | null = null;
    selectedSessions: VisitorSession[] = [];
    journey: JourneyEvent[] = [];
    profileLoading = false;

    updateBanner: { packageName: string; current: string; latest: string; isMajor: boolean } | null = null;
    /** Toggles the shared HULO help drawer under the hero. */
    helpOpen = false;
    private dismissKey = 'huloglobal-visitor-analytics-update-dismissed';

    constructor(
        private http: HttpClient,
        private notify: NotificationService,
        private cdr: ChangeDetectorRef,
        private zone: NgZone,
    ) {}

    licMeta: any = null;
    updating = false;
    updateProgress = 'Updating…';

    runSelfUpdate() {
        const target = this.licMeta?.update?.latest;
        if (!target || this.updating) return;
        this.updating = true;
        this.updateProgress = 'Installing…';
        this.cdr.markForCheck();
        this.http.post<any>('/ees/update/run', { version: target }).subscribe({
            next: r => {
                if (r?.restartScheduled) {
                    this.updateProgress = 'Restarting…';
                    this.notify.success(r.message || 'Updated — server restarting');
                    this.pollAfterRestart(target);
                } else {
                    this.updating = false;
                    this.notify.success(r?.message || 'Installed — restart the server to load it');
                }
                this.cdr.markForCheck();
            },
            error: e => {
                this.updating = false;
                this.notify.error(e?.error?.message || 'Update failed — nothing was changed');
                this.cdr.markForCheck();
            },
        });
    }

    private pollAfterRestart(target: string, attempt = 0) {
        if (attempt > 40) {
            this.updating = false;
            this.notify.error('The server has not come back yet — check your process manager');
            this.cdr.markForCheck();
            return;
        }
        setTimeout(() => {
            this.http.get<any>('/ees/licence/status').subscribe({
                next: m => {
                    const v = m?.version || m?.update?.current;
                    if (v === target) {
                        this.updating = false;
                        this.licMeta = m;
                        this.notify.success(`Now running v${target}`);
                        this.cdr.markForCheck();
                    } else {
                        this.pollAfterRestart(target, attempt + 1);
                    }
                },
                error: () => this.pollAfterRestart(target, attempt + 1),
            });
        }, 3000);
    }
    licKeyInput = '';
    licActivating = false;
    updateDismissed = false;
    cmdCopied = false;

    copyUpdateCmd() {
        const cmd = `npm install &#64;huloglobal/vendure-plugin-visitor-analytics@${this.licMeta?.update?.latest || 'latest'}`;
        navigator.clipboard?.writeText(cmd).then(() => {
            this.cmdCopied = true;
            this.cdr.markForCheck();
            setTimeout(() => { this.cmdCopied = false; this.cdr.markForCheck(); }, 2500);
        });
    }

    loadLicMeta() {
        this.http.get<any>('/ees/licence/status').subscribe({
            next: m => { this.licMeta = m; this.cdr.markForCheck(); },
            error: () => undefined,
        });
    }

    // Buy-from-admin: opens HULO checkout in a new tab; the licence server
    // binds the purchase to this install and the key installs itself.
    buyPlan: 'monthly' | 'annual' | 'lifetime' = 'monthly';
    buying = false;
    claim: any = null;
    private claimTimer: any = null;
    buyLicence() {
        this.buying = true;
        this.http.post<any>('/ees/licence/purchase-link', { plan: this.buyPlan }).subscribe({
            next: r => {
                this.buying = false;
                if (r?.url) {
                    window.open(r.url, '_blank', 'noopener');
                    this.claim = { state: 'pending' };
                    this.startClaimPoll();
                }
                this.cdr.markForCheck();
            },
            error: e => { this.buying = false; this.notify.error(e?.error?.message || 'Could not start checkout — try again shortly'); this.cdr.markForCheck(); },
        });
    }
    checkClaim(force = false) {
        this.http.get<any>('/ees/licence/claim-status' + (force ? '?check=1' : '')).subscribe({
            next: r => {
                const wasPending = this.claim?.state === 'pending';
                this.claim = r;
                if (r?.state === 'pending') { if (!this.claimTimer) this.startClaimPoll(); }
                else this.stopClaimPoll();
                if (r?.licensed && (wasPending || r?.state === 'installed') && !this.licMeta?.licensed) {
                    this.notify.success('Licence installed — all features enabled');
                    this.http.get<any>('/ees/licence/status').subscribe({ next: m => { this.licMeta = m; this.cdr.markForCheck(); }, error: () => undefined });
                }
                this.cdr.markForCheck();
            },
            error: () => undefined,
        });
    }
    private startClaimPoll() { this.stopClaimPoll(); this.claimTimer = setInterval(() => this.checkClaim(false), 15000); }
    private stopClaimPoll() { if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; } }


    activateLicence() {
        const key = (this.licKeyInput || '').trim();
        if (!key) return;
        this.licActivating = true;
        this.http.post<any>('/ees/licence/activate', { key }).subscribe({
            next: r => {
                this.licActivating = false;
                this.licKeyInput = '';
                this.notify.success(r?.message || 'Licence activated — all features enabled');
                this.loadLicMeta();
                this.cdr.markForCheck();
            },
            error: e => {
                this.licActivating = false;
                this.notify.error(e?.error?.message || 'That key did not validate — check it was copied completely');
                this.cdr.markForCheck();
            },
        });
    }

    ngOnInit() {
        this.checkClaim(false);
        this.loadLicMeta();
        this.restorePrefs();
        this.loadChannels();
        this.loadAll();
        this.connectLive();
        this.loadStatus();
    }

    loadStatus() {
        this.http.get<any>('/ees/visitors/status').subscribe({
            next: (s) => {
                const u = s?.update;
                if (!u?.updateAvailable || !u.latest) return;
                let dismissed = '';
                try { dismissed = localStorage.getItem(this.dismissKey) || ''; } catch {}
                if (dismissed === u.latest) return;
                this.updateBanner = { packageName: u.packageName, current: u.current, latest: u.latest, isMajor: !!u.isMajor };
                this.cdr.markForCheck();
            },
            error: () => { /* nice-to-have */ },
        });
    }

    dismissUpdate() {
        if (!this.updateBanner) return;
        try { localStorage.setItem(this.dismissKey, this.updateBanner.latest); } catch {}
        this.updateBanner = null;
    }

    ngOnDestroy() {
        this.stopClaimPoll();
        this.disconnectLive();
    }

    /** Open the live-now SSE stream. Angular's zone has no idea events
     *  are arriving from EventSource, so we hop back inside it before
     *  mutating state — otherwise the view won't refresh. */
    private connectLive(): void {
        if (typeof EventSource === 'undefined') return;
        try {
            this.liveSource = new EventSource('/ees/visitors/live' + (this.channelId != null ? `?channelId=${this.channelId}` : ''), { withCredentials: true } as any);
        } catch {
            return;
        }
        this.liveSource.onopen = () => this.zone.run(() => {
            this.liveConnected = true;
            this.cdr.markForCheck();
        });
        this.liveSource.onerror = () => this.zone.run(() => {
            this.liveConnected = false;
            this.cdr.markForCheck();
        });
        this.liveSource.onmessage = (ev) => this.zone.run(() => {
            try {
                const data = JSON.parse(ev.data);
                this.liveCount = data.activeCount || 0;
                this.liveRecent = Array.isArray(data.recent) ? data.recent : [];
                this.liveUpdatedAt = new Date(data.ts || Date.now());
                this.liveConnected = true;
                this.cdr.markForCheck();
            } catch {
                // ignore malformed frame
            }
        });
    }

    private disconnectLive(): void {
        if (this.liveSource) {
            this.liveSource.close();
            this.liveSource = null;
        }
    }

    setDays(d: number) {
        this.days = d;
        this.topSkip = 0; this.exitSkip = 0; this.recentSkip = 0;
        this.loadAll();
    }

    /** Called when the operator picks a channel from the hero
     *  picker. `null` / empty string = All channels. Reloads every
     *  panel + rewires the SSE stream so the live-now count is
     *  channel-scoped too. */
    setChannel(id: number | '' | null) {
        this.channelId = (id === '' || id == null) ? null : Number(id);
        this.topSkip = 0; this.exitSkip = 0; this.recentSkip = 0;
        this.disconnectLive();
        this.connectLive();
        this.loadAll();
    }

    /** Build the shared `?days=&channelId=` fragment. Omits
     *  channelId when null so aggregated queries stay short. */
    private q(): string {
        return `days=${this.days}` +
            (this.channelId != null ? `&channelId=${this.channelId}` : '');
    }

    /** Fetch the list of channels the current admin can see, once
     *  at init. Cheap read (one row per channel). */
    private loadChannels(): void {
        this.http.get<any>('/ees/visitors/channels').subscribe({
            next: (r) => {
                this.channels = Array.isArray(r?.channels) ? r.channels : [];
                this.cdr.markForCheck();
            },
            error: () => { /* leave as empty — picker still shows All */ },
        });
    }

    loadAll() {
        this.loading = true;
        this.loadAudience();
        Promise.all([
            this.http.get<any>(`/ees/visitors/summary?${this.q()}`).toPromise(),
            this.http.get<any>(`/ees/visitors/funnel?${this.q()}`).toPromise(),
            this.fetchTop(),
            this.fetchExit(),
            this.fetchRecent(),
        ]).then(([summaryRes, funnelRes]) => {
            this.summary = summaryRes?.totals || this.summary;
            this.daily = Array.isArray(summaryRes?.daily) ? summaryRes.daily : [];
            this.previous = summaryRes?.previous || null;
            this.rebuildChart();
            this.funnel = funnelRes?.stages || [];
            this.loading = false;
            this.cdr.markForCheck();
        }).catch(() => {
            this.loading = false;
            this.notify.error('Failed to load visitor data');
        });
    }

    fetchTop(): Promise<void> {
        return this.http.get<any>(`/ees/visitors/top-pages?${this.q()}&take=${this.topTake}&skip=${this.topSkip}`).toPromise()
            .then((res: any) => {
                this.topPages = res?.pages || [];
                this.topTotal = res?.total || 0;
                this.cdr.markForCheck();
            });
    }
    topPrev() { this.topSkip = Math.max(0, this.topSkip - this.topTake); this.fetchTop(); }
    topNext() { this.topSkip += this.topTake; this.fetchTop(); }

    fetchExit(): Promise<void> {
        return this.http.get<any>(`/ees/visitors/exit-pages?${this.q()}&take=${this.exitTake}&skip=${this.exitSkip}`).toPromise()
            .then((res: any) => {
                this.exitPages = res?.exitPages || [];
                this.exitTotal = res?.total || 0;
                this.cdr.markForCheck();
            });
    }
    exitPrev() { this.exitSkip = Math.max(0, this.exitSkip - this.exitTake); this.fetchExit(); }
    exitNext() { this.exitSkip += this.exitTake; this.fetchExit(); }

    fetchRecent(): Promise<void> {
        return this.http.get<any>(`/ees/visitors/recent?${this.q()}&take=${this.recentTake}&skip=${this.recentSkip}`).toPromise()
            .then((res: any) => {
                this.recent = res?.visitors || [];
                this.recentTotal = res?.total || 0;
                this.cdr.markForCheck();
            });
    }
    recentPrev() { this.recentSkip = Math.max(0, this.recentSkip - this.recentTake); this.fetchRecent(); }
    recentNext() { this.recentSkip += this.recentTake; this.fetchRecent(); }

    funnelPct(s: FunnelStage): number {
        const base = this.funnel[0]?.visitors || 1;
        return base ? (s.visitors / base) * 100 : 0;
    }

    openProfile(visitorId: string) {
        this.profileLoading = true;
        this.selectedProfile = null;
        this.selectedSessions = [];
        this.journey = [];
        Promise.all([
            this.http.get<any>(`/ees/visitors/profile/${visitorId}`).toPromise(),
            this.http.get<any>(`/ees/visitors/journey/${visitorId}`).toPromise(),
        ]).then(([p, j]) => {
            this.selectedProfile = p?.visitor || null;
            this.selectedSessions = p?.sessions || [];
            this.journey = j?.events || [];
            this.profileLoading = false;
            this.cdr.markForCheck();
        }).catch(() => {
            this.profileLoading = false;
            this.notify.error('Failed to load visitor profile');
        });
    }

    closeProfile() {
        this.selectedProfile = null;
        this.selectedSessions = [];
        this.journey = [];
    }

    humanTime(ms: number): string {
        if (!ms || ms < 1000) return ms ? '<1s' : '—';
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const rs = s % 60;
        if (m < 60) return `${m}m ${rs}s`;
        const h = Math.floor(m / 60);
        const rm = m % 60;
        return `${h}h ${rm}m`;
    }
}
