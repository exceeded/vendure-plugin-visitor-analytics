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
        <vdr-page-block>
            <vdr-action-bar>
                <vdr-ab-left><h2>Visitor journey</h2></vdr-ab-left>
                <vdr-ab-right>
                    <span class="range">
                        Range:
                        <button class="btn btn-sm btn-link" *ngFor="let d of [7, 30, 90, 365]"
                            (click)="setDays(d)" [class.active]="days === d">{{ d }}d</button>
                    </span>
                    <button class="btn btn-link" (click)="loadAll()" [disabled]="loading">
                        <clr-icon shape="refresh"></clr-icon> Refresh
                    </button>
                </vdr-ab-right>
            </vdr-action-bar>
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
            <div class="summary-row">
                <div class="summary-card live-card">
                    <div class="num">
                        <span class="live-dot" [class.connected]="liveConnected"></span>
                        {{ liveCount | number }}
                    </div>
                    <div class="lbl">Live now <span class="live-meta" *ngIf="liveUpdatedAt">· refreshed {{ liveUpdatedAt | date:'HH:mm:ss' }}</span></div>
                </div>
                <div class="summary-card">
                    <div class="num">{{ summary.visitors | number }}</div>
                    <div class="lbl">Unique visitors</div>
                </div>
                <div class="summary-card">
                    <div class="num">{{ summary.sessions | number }}</div>
                    <div class="lbl">Sessions</div>
                </div>
                <div class="summary-card">
                    <div class="num">{{ summary.pageviews | number }}</div>
                    <div class="lbl">Page views</div>
                </div>
                <div class="summary-card">
                    <div class="num">{{ humanTime(summary.avgTimeMs) }}</div>
                    <div class="lbl">Avg time on page</div>
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

        <vdr-page-block>
            <div class="card">
                <div class="card-block">
                    <h3 class="card-title">Funnel <span class="muted">(last {{ days }} days)</span></h3>
                    <div *ngIf="funnel.length === 0" class="muted pad">No data yet.</div>
                    <div class="funnel" *ngIf="funnel.length > 0">
                        <div class="funnel-row" *ngFor="let s of funnel">
                            <div class="funnel-label">{{ s.label }}</div>
                            <div class="funnel-bar">
                                <div class="funnel-bar-fill" [style.width.%]="funnelPct(s)"></div>
                            </div>
                            <div class="funnel-num">
                                <strong>{{ s.visitors | number }}</strong>
                                <span class="muted" *ngIf="s !== funnel[0]"> ({{ funnelPct(s) | number:'1.0-1' }}%)</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="two-col">
                <div class="card">
                    <div class="card-block">
                        <h3 class="card-title">
                            Top pages
                            <span class="muted">{{ topTotal | number }} total</span>
                        </h3>
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
                    </div>
                </div>

                <div class="card">
                    <div class="card-block">
                        <h3 class="card-title">
                            Exit pages
                            <span class="muted">{{ exitTotal | number }} total</span>
                        </h3>
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
                    </div>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="card">
                <div class="card-block">
                    <h3 class="card-title">
                        Visitors
                        <span class="muted">{{ recentTotal | number }} total · click a row for the full profile</span>
                    </h3>
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
        :host { color: var(--color-text-100, inherit); display: block; }

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
            .summary-row { gap: 8px; }
            .summary-card { min-width: 0; flex-basis: calc(50% - 4px); padding: 12px 14px; }
            .summary-card .num { font-size: 20px; }
            .range { display: block; margin: 8px 0; }
            .two-col { grid-template-columns: 1fr; }
            .funnel-row { grid-template-columns: 1fr; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--color-component-border-200); }
            table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; white-space: nowrap; }
            .profile-grid, .profile-grid.four { grid-template-columns: 1fr 1fr; }
            .drawer { width: 100% !important; max-width: 100% !important; }
            .update-banner { flex-direction: column; align-items: flex-start; }
            .update-banner .actions { width: 100%; justify-content: flex-end; }
        }
        @media (max-width: 380px) {
            .summary-card { flex-basis: 100%; }
        }

        .range { font-size: 12px; color: var(--color-component-color-300); margin-right: 8px; }
        .range .btn { padding: 2px 8px; min-width: 0; }
        .range .btn.active { font-weight: 700; color: var(--color-primary-500, #1d4ed8); }
        .summary-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
        .summary-card {
            flex: 1; min-width: 130px; padding: 16px 20px;
            border: 1px solid var(--color-component-border-200);
            border-radius: 6px;
            background: var(--color-component-bg-100);
        }
        .summary-card .num { font-size: 24px; font-weight: 700; }
        .summary-card .lbl { font-size: 11px; color: var(--color-component-color-300); margin-top: 4px; }

        .live-card { border-left: 3px solid #ef4444; }
        .live-card .num { display: inline-flex; align-items: center; gap: 8px; }
        .live-dot {
            display: inline-block; width: 10px; height: 10px; border-radius: 50%;
            background: #9ca3af; box-shadow: 0 0 0 0 rgba(156,163,175,.4);
        }
        .live-dot.connected {
            background: #ef4444;
            animation: live-pulse 1.6s ease-in-out infinite;
        }
        .live-meta { color: var(--color-component-color-300); font-size: 10px; font-weight: 400; }
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

        .funnel { display: flex; flex-direction: column; gap: 8px; }
        .funnel-row { display: grid; grid-template-columns: 200px 1fr 140px; gap: 12px; align-items: center; }
        .funnel-label { font-size: 13px; font-weight: 500; }
        .funnel-bar {
            height: 24px; background: var(--color-component-bg-200);
            border-radius: 4px; overflow: hidden;
            border: 1px solid var(--color-component-border-200);
        }
        .funnel-bar-fill { height: 100%; background: linear-gradient(90deg, #1d4ed8, #3b82f6); }
        .funnel-num { font-size: 13px; }

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
    private dismissKey = 'huloglobal-visitor-analytics-update-dismissed';

    constructor(
        private http: HttpClient,
        private notify: NotificationService,
        private cdr: ChangeDetectorRef,
        private zone: NgZone,
    ) {}

    ngOnInit() {
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
        this.disconnectLive();
    }

    /** Open the live-now SSE stream. Angular's zone has no idea events
     *  are arriving from EventSource, so we hop back inside it before
     *  mutating state — otherwise the view won't refresh. */
    private connectLive(): void {
        if (typeof EventSource === 'undefined') return;
        try {
            this.liveSource = new EventSource('/ees/visitors/live', { withCredentials: true } as any);
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

    loadAll() {
        this.loading = true;
        Promise.all([
            this.http.get<any>(`/ees/visitors/summary?days=${this.days}`).toPromise(),
            this.http.get<any>(`/ees/visitors/funnel?days=${this.days}`).toPromise(),
            this.fetchTop(),
            this.fetchExit(),
            this.fetchRecent(),
        ]).then(([summaryRes, funnelRes]) => {
            this.summary = summaryRes?.totals || this.summary;
            this.funnel = funnelRes?.stages || [];
            this.loading = false;
            this.cdr.markForCheck();
        }).catch(() => {
            this.loading = false;
            this.notify.error('Failed to load visitor data');
        });
    }

    fetchTop(): Promise<void> {
        return this.http.get<any>(`/ees/visitors/top-pages?days=${this.days}&take=${this.topTake}&skip=${this.topSkip}`).toPromise()
            .then((res: any) => {
                this.topPages = res?.pages || [];
                this.topTotal = res?.total || 0;
                this.cdr.markForCheck();
            });
    }
    topPrev() { this.topSkip = Math.max(0, this.topSkip - this.topTake); this.fetchTop(); }
    topNext() { this.topSkip += this.topTake; this.fetchTop(); }

    fetchExit(): Promise<void> {
        return this.http.get<any>(`/ees/visitors/exit-pages?days=${this.days}&take=${this.exitTake}&skip=${this.exitSkip}`).toPromise()
            .then((res: any) => {
                this.exitPages = res?.exitPages || [];
                this.exitTotal = res?.total || 0;
                this.cdr.markForCheck();
            });
    }
    exitPrev() { this.exitSkip = Math.max(0, this.exitSkip - this.exitTake); this.fetchExit(); }
    exitNext() { this.exitSkip += this.exitTake; this.fetchExit(); }

    fetchRecent(): Promise<void> {
        return this.http.get<any>(`/ees/visitors/recent?days=${this.days}&take=${this.recentTake}&skip=${this.recentSkip}`).toPromise()
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
