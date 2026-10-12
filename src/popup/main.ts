// Switchboard popup entry point.
import '../ui/tokens.css';
import '../ui/shared.css';
import './popup.css';

import type { Account, Service, SwitchRule } from '../shared/types';
import { PLATFORM_ORIGIN_PATTERN, SERVICES, serviceOf } from '../shared/types';
import { call, getState, initStore, mockMode, onStateChange, reloadState } from '../ui/store';
import { initTheme } from '../ui/theme';
import { clear, h, icon } from '../ui/dom';
import { createUsageBar } from '../ui/usage-bar';
import {
  accountInitial,
  defaultAccountColor,
  displayBars,
  platformSpendText,
  isStale,
  primaryPercent,
  severityOf,
} from '../ui/format';

const app = document.getElementById('app') ?? document.body;
let statusTimer: number | null = null;

// Which product's accounts the popup shows. Remembered per browser as a convenience only.
const VIEW_KEY = 'switchboard.popup.view';
let view: Service = readView();

function readView(): Service {
  try {
    return localStorage.getItem(VIEW_KEY) === 'platform' ? 'platform' : 'claude';
  } catch {
    return 'claude';
  }
}

function setView(next: Service): void {
  view = next;
  try {
    localStorage.setItem(VIEW_KEY, next);
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
  render();
}

const GEAR_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.6"/><circle cx="6" cy="11.5" r="1.6"/></svg>';
const REFRESH_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66L20 8"/><path d="M20 4v4h-4"/></svg>';

// -- small helpers -----------------------------------------------------------

function showStatus(message: string, kind: 'info' | 'error' = 'info'): void {
  let toast = document.querySelector<HTMLDivElement>('.toast');
  if (!toast) {
    toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.className = `toast show${kind === 'error' ? ' error' : ''}`;
  if (statusTimer !== null) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => toast?.classList.remove('show'), 3000);
}

function setBusy(btn: HTMLButtonElement, busy: boolean): void {
  if (btn.classList.contains('btn-icon')) {
    btn.classList.toggle('busy', busy);
    btn.disabled = busy;
  } else if (busy) {
    btn.disabled = true;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent ?? '';
    btn.textContent = 'Working…';
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.label ?? btn.textContent;
  }
}

async function runAction(btn: HTMLButtonElement, fn: () => Promise<unknown>): Promise<void> {
  setBusy(btn, true);
  try {
    await fn();
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    setBusy(btn, false);
  }
}

// -- sections ----------------------------------------------------------------

function buildHeader(): HTMLElement {
  const refreshBtn = h(
    'button',
    {
      class: 'btn-icon',
      title: 'Refresh usage now',
      'aria-label': 'Refresh usage now',
      onclick: async function (this: HTMLButtonElement) {
        if (this.disabled) return;
        setBusy(this, true);
        try {
          await call({ type: 'refreshUsage' });
          if (!mockMode) showStatus('Usage refreshed');
        } catch (err) {
          showStatus(err instanceof Error ? err.message : String(err), 'error');
        } finally {
          setBusy(this, false);
        }
      },
    },
    icon(REFRESH_SVG),
  );

  const gearBtn = h(
    'button',
    {
      class: 'btn-icon',
      title: 'Options',
      'aria-label': 'Open options',
      onclick: () => {
        if (typeof chrome !== 'undefined' && chrome?.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
        else window.open('../options/index.html', '_blank');
      },
    },
    icon(GEAR_SVG),
  );

  return h(
    'header',
    { class: 'popup-header' },
    h('div', {},
      h('h1', { class: 'popup-title' }, 'Switchboard for Claude'),
      h('div', { class: 'popup-subtitle' }, 'Unofficial account switcher'),
    ),
    h('div', { class: 'popup-header-actions' }, refreshBtn, gearBtn),
  );
}

const OPEN_SVG =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 7.5 8.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>';

/** Focuses an open tab of `service`'s site, or opens one, then closes the popup. */
async function openService(service: Service): Promise<void> {
  const { origin } = SERVICES[service];
  const landing = service === 'platform' ? `${origin}/` : `${origin}/new`;
  if (mockMode) {
    window.open(landing, '_blank');
    return;
  }
  const [existing] = await chrome.tabs.query({ url: `${origin}/*`, currentWindow: true });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
  } else {
    await chrome.tabs.create({ url: landing });
  }
  window.close();
}

function buildOpenButton(service: Service): HTMLElement {
  const host = service === 'platform' ? 'platform.claude.com' : 'claude.ai';
  return h(
    'button',
    {
      class: 'btn-icon',
      title: `Open ${host}`,
      'aria-label': `Open ${host}`,
      onclick: () => void openService(service).catch((err: unknown) => showStatus(err instanceof Error ? err.message : String(err), 'error')),
    },
    icon(OPEN_SVG),
  );
}

function buildActiveCard(active: Account | undefined, index: number): HTMLElement {
  if (!active) return h('div', {});
  const color = active.color ?? defaultAccountColor(index);

  const stale = isStale(active, getState().settings.pollIntervalMinutes);
  const top = h(
    'div',
    { class: 'active-top' },
    h('div', { class: 'avatar', style: `background:${color}` }, accountInitial(active)),
    h(
      'div',
      { style: 'min-width:0' },
      h(
        'div',
        { class: 'active-name' },
        h('span', {}, active.label || active.displayName),
        serviceOf(active) === 'platform'
          ? active.orgName
            ? h('span', { class: 'chip' }, active.orgName)
            : null
          : h('span', { class: 'chip' }, active.plan),
      ),
      h('div', { class: 'active-email' }, active.email),
    ),
    h(
      'div',
      { class: 'active-actions' },
      stale ? h('span', { class: 'stale-badge' }, 'Stale') : null,
      buildOpenButton(serviceOf(active)),
    ),
  );

  const usageBox = h('div', { class: 'active-usage' });
  if (serviceOf(active) === 'platform') {
    // Platform support is account management; spend is a single informational line when known.
    const spend = platformSpendText(active);
    if (spend) usageBox.append(h('div', { class: 'usage-row' }, h('span', { class: 'usage-label' }, spend)));
    else usageBox.append(h('div', { class: 'empty-usage' }, 'API account'));
  } else if (!active.usage) {
    usageBox.append(h('div', { class: 'empty-usage' }, active.usageError ?? 'No usage data yet'));
  } else {
    for (const bar of displayBars(active, true)) usageBox.append(createUsageBar(bar));
    if (active.usageError) usageBox.append(h('div', { class: 'usage-meta' }, active.usageError));
  }
  return h('section', { class: 'active-card', 'aria-label': 'Active account' }, top, usageBox);
}

function buildAccountRow(acc: Account, _index: number): HTMLElement {
  const actionable = !(acc.sessionExpired || acc.paused);
  const tags: HTMLElement[] = [];
  if (acc.paused) tags.push(h('span', { class: 'tag' }, 'Paused'));
  if (acc.sessionExpired) tags.push(h('span', { class: 'tag expired' }, 'Session expired'));

  const side = h('div', { class: 'account-side' });
  if (actionable) {
    const mini = h('div', { class: 'mini-bars' });
    for (const { label, percent } of displayBars(acc, false).slice(0, 2)) {
      if (percent === null) continue;
      const pct = Math.max(0, Math.min(100, Math.round(percent)));
      const fill = h('div', { class: `mini-fill ${severityOf(pct)}` });
      fill.style.width = `${pct}%`;
      mini.append(
        h(
          'div',
          { class: 'mini-track', 'aria-hidden': 'true', title: `${label}: ${pct}%` },
          fill,
        ),
      );
    }
    side.append(mini);
    const p = primaryPercent(acc);
    const spend = serviceOf(acc) === 'platform' ? platformSpendText(acc) : null;
    if (spend) side.append(h('div', { class: 'switch-hint' }, spend));
    else if (p !== null) side.append(h('div', { class: 'switch-hint' }, `${Math.round(p)}% used`));
  }
  side.append(...tags);

  const row = h(
    'button',
    {
      class: `account-row${actionable ? '' : ' disabled-state'}`,
      role: 'menuitem',
      'aria-label': actionable
        ? `Switch to ${acc.label || acc.displayName}`
        : `${acc.label || acc.displayName} — sign in again`,
      onclick: function (this: HTMLButtonElement) {
        void runAction(this, async () => {
          if (acc.sessionExpired) {
            await call({ type: 'addAccountFlow', service: serviceOf(acc) });
          } else if (acc.paused) {
            await call({ type: 'updateAccount', accountId: acc.id, patch: { paused: false } });
            await call({ type: 'switchAccount', accountId: acc.id });
          } else {
            await call({ type: 'switchAccount', accountId: acc.id });
          }
        });
      },
    },
    h(
      'div',
      { class: 'account-row-main' },
      h(
        'div',
        { class: 'account-id' },
        h(
          'div',
          { class: `avatar small${actionable ? '' : ' pill'}`, style: `background:${acc.color ?? defaultAccountColor(_index)}` },
          accountInitial(acc),
        ),
        h(
          'div',
          { class: 'account-name' },
          (acc.label || acc.displayName) + ' ',
          actionable ? h('span', { class: 'switch-hint' }, 'Switch') : null,
        ),
      ),
      side,
    ),
  );
  return row;
}

function buildAddAccount(): HTMLElement {
  const btn = h(
    'button',
    {
      class: 'btn-primary',
      onclick: function (this: HTMLButtonElement) {
        void runAction(this, () => call({ type: 'addAccountFlow', service: view }));
      },
    },
    view === 'platform' ? '+ Add Platform account' : '+ Add account',
  );
  return h(
    'div',
    { class: 'add-account' },
    btn,
    h(
      'p',
      { class: 'add-explain' },
      `Signs you out of ${view === 'platform' ? 'platform.claude.com' : 'claude.ai'} in this browser so you can log in to another account, then saves it here.`,
    ),
  );
}

function buildFooter(): HTMLElement {
  const { settings, rules } = getState();
  if (view === 'platform') {
    return h('div', { class: 'footer' }, h('p', { class: 'footer-note' }, 'Auto-switch rules apply to Claude.ai accounts. Platform accounts are switched manually.'));
  }
  const toggle = h(
    'label',
    { class: 'switch', title: 'Enable automatic switching by rules' },
    h('input', {
      type: 'checkbox',
      'aria-label': 'Enable auto-switching',
      onchange: async function (this: HTMLInputElement) {
        try {
          await call({ type: 'saveSettings', settings: { autoSwitchEnabled: this.checked } });
        } catch (err) {
          showStatus(err instanceof Error ? err.message : String(err), 'error');
          this.checked = !this.checked;
        }
      },
    }) as HTMLInputElement,
    h('span', { class: 'switch-track' }),
  );
  (toggle.firstChild as HTMLInputElement).checked = settings.autoSwitchEnabled;

  const firstEnabled = settings.autoSwitchEnabled ? rules.find((r: SwitchRule) => r.enabled) : undefined;
  const hint = firstEnabled ? `Rule: ${firstEnabled.name}` : rules.length > 0 ? 'No active rule' : 'Define rules in Options';

  return h(
    'div',
    { class: 'footer' },
    toggle,
    h('span', { class: 'footer-label' }, 'Auto-switch'),
    h('span', { class: 'rule-hint' }, hint),
  );
}

function buildEmptyState(): HTMLElement {
  const s = getState();
  const hasUnsaved = view === 'platform' ? s.unsavedPlatformSessionDetected : s.unsavedSessionDetected;
  const site = view === 'platform' ? 'platform.claude.com' : 'claude.ai';
  const saveBtn = h(
    'button',
    {
      class: 'btn-primary',
      onclick: function (this: HTMLButtonElement) {
        void runAction(this, async () => {
          await call({ type: 'captureCurrentAccount', service: view });
          showStatus('Account saved');
        });
      },
    },
    'Save current account',
  );
  return h(
    'div',
    { class: 'empty-state' },
    h('h2', { class: 'empty-title' }, view === 'platform' ? 'No Platform accounts yet' : 'No accounts yet'),
    h(
      'ol',
      { class: 'empty-steps' },
      h('li', {}, `Sign in to ${site} in this browser.`),
      h('li', {}, hasUnsaved ? 'Click “Save current account” below.' : 'Come back here and click “Save current account”.'),
      h('li', {}, 'Repeat for each account you want to switch between.'),
    ),
    saveBtn,
  );
}

function buildBanner(): HTMLElement | null {
  const s = getState();
  const unsaved = view === 'platform' ? s.unsavedPlatformSessionDetected : s.unsavedSessionDetected;
  if (!unsaved) return null;
  const btn = h(
    'button',
    {
      class: 'banner-action',
      onclick: function (this: HTMLButtonElement) {
        void runAction(this, async () => {
          await call({ type: 'captureCurrentAccount', service: view });
          showStatus('Account saved');
        });
      },
    },
    'Save it',
  );
  return h(
    'div',
    { class: 'banner', role: 'alert' },
    h('p', {}, `You’re signed in to a ${SERVICES[view].label} account that isn’t saved.`),
    btn,
  );
}

/** Platform support needs the optional platform.claude.com host permission; ask for it here. */
function buildPlatformPermissionCard(): HTMLElement {
  const btn = h(
    'button',
    {
      class: 'btn-primary',
      onclick: () => {
        // permissions.request must run synchronously inside the click (user gesture).
        chrome.permissions
          .request({ origins: [PLATFORM_ORIGIN_PATTERN] })
          .then(async (granted) => {
            if (!granted) {
              showStatus('Access was not granted', 'error');
              return;
            }
            await reloadState();
            showStatus('Claude Platform enabled');
          })
          .catch((err: unknown) => showStatus(err instanceof Error ? err.message : String(err), 'error'));
      },
    },
    'Allow access to platform.claude.com',
  );
  return h(
    'div',
    { class: 'empty-state' },
    h('h2', { class: 'empty-title' }, 'Manage Claude Platform accounts'),
    h(
      'p',
      { class: 'add-explain' },
      'Switchboard needs permission to read and set your platform.claude.com session cookie. It is only used to save and switch your Platform accounts and to show this month’s spend.',
    ),
    btn,
  );
}

function buildTabs(): HTMLElement {
  const s = getState();
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Product' });
  for (const service of ['claude', 'platform'] as const) {
    const count = s.accounts.filter((a) => serviceOf(a) === service).length;
    const unsaved = service === 'platform' ? s.unsavedPlatformSessionDetected : s.unsavedSessionDetected;
    const tab = h(
      'button',
      {
        class: `tab${view === service ? ' selected' : ''}`,
        role: 'tab',
        'aria-selected': view === service ? 'true' : 'false',
        onclick: () => setView(service),
      },
      SERVICES[service].label,
      h('span', { class: 'tab-count' }, String(count)),
    );
    if (unsaved) tab.append(h('span', { class: 'tab-dot', title: 'Unsaved session detected' }));
    tabs.append(tab);
  }
  return tabs;
}

function render(): void {
  const s = getState();
  const activeId = view === 'platform' ? s.activePlatformAccountId : s.activeAccountId;
  const ordered = s.accounts.filter((a) => serviceOf(a) === view).sort((a, b) => {
    const ia = s.settings.accountOrder.indexOf(a.id);
    const ib = s.settings.accountOrder.indexOf(b.id);
    if (ia === -1 && ib === -1) return a.addedAt - b.addedAt;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  const active = ordered.find((a) => a.id === activeId) ?? ordered[0];
  const others = ordered.filter((a) => active && a.id !== active.id);

  clear(app);
  app.append(buildHeader());
  app.append(buildTabs());

  const banner = buildBanner();
  if (banner) app.append(banner);

  if (view === 'platform' && !s.platformPermission) {
    app.append(buildPlatformPermissionCard());
    return;
  }

  if (ordered.length === 0) {
    app.append(buildEmptyState());
    return;
  }

  app.append(buildActiveCard(active, ordered.indexOf(active as Account)));
  app.append(buildAddAccount());

  if (others.length > 0) {
    const list = h('div', { class: 'accounts', role: 'menu', 'aria-label': 'Other accounts' });
    others.forEach((acc) => list.append(buildAccountRow(acc, ordered.indexOf(acc))));
    app.append(list);
  }

  app.append(buildFooter());
}

async function main(): Promise<void> {
  try {
    await initStore();
  } catch (err) {
    app.append(
      h('div', { class: 'loading' }, `Could not load state: ${err instanceof Error ? err.message : String(err)}`),
    );
    return;
  }
  initTheme();
  render();
  onStateChange(render);
}

void main();
