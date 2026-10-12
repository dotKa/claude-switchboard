// Options page entry point.
import '../ui/tokens.css';
import '../ui/shared.css';
import './options.css';

import type { Account, SwitchRule, UsageMetric } from '../shared/types';
import type { NotificationSettings } from '../shared/types';
import { DEFAULT_NOTIFICATIONS, serviceOf } from '../shared/types';
import { call, getState, initStore, mockMode, onStateChange } from '../ui/store';
import { initTheme } from '../ui/theme';
import { clear, h, icon } from '../ui/dom';
import {
  ACCOUNT_COLOR_PALETTE,
  METRIC_LABELS,
  METRIC_ORDER,
  defaultAccountColor,
  downloadTextFile,
  formatDateTime,
} from '../ui/format';

const app = document.getElementById('app') ?? document.body;

let statusTimer: number | null = null;

/** Local, unsaved copy of the rules list (dirty until "Save rules"). */
let localRules: SwitchRule[] = [];
let rulesDirty = false;

// -- common bits -------------------------------------------------------------

function showStatus(message: string, kind: 'info' | 'error' = 'info'): void {
  let toast = document.querySelector<HTMLDivElement>('.toast');
  if (!toast) {
    toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.className = `toast show${kind === 'error' ? ' error' : ''}`;
  if (statusTimer !== null) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => toast?.classList.remove('show'), 3500);
}

async function runAction(fn: () => Promise<unknown>, okMessage?: string): Promise<void> {
  try {
    await fn();
    if (okMessage) showStatus(okMessage);
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

function makeSwitch(checked: boolean, ariaLabel: string, onToggle: (checked: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', 'aria-label': ariaLabel, onchange: () => onToggle(input.checked) });
  input.checked = checked;
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' }));
}

function overlay(onDismiss: () => void): { el: HTMLElement; dispose: () => void } {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dispose();
      onDismiss();
    }
  };
  const dispose = () => document.removeEventListener('keydown', onKey, true);
  document.addEventListener('keydown', onKey, true);
  const el = h('div', {
    class: 'overlay',
    onclick: () => {
      dispose();
      onDismiss();
    },
  });
  return { el, dispose };
}

function showConfirm(opts: { title: string; body: string; confirmLabel: string; danger?: boolean }, onConfirm: () => void): void {
  function closeAll(): void {
    ov.dispose();
    ov.el.remove();
    dlg.remove();
  }
  const ov = overlay(closeAll);
  const dlg = h(
    'div',
    { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': opts.title },
    h('div', { class: 'dialog-title' }, opts.title),
    h('p', { class: 'section-desc' }, opts.body),
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { onclick: () => closeAll() }, 'Cancel'),
      h(
        'button',
        { class: opts.danger ? 'btn-danger' : 'btn-primary', onclick: () => { closeAll(); onConfirm(); } },
        opts.confirmLabel,
      ),
    ),
  );
  document.body.append(ov.el, dlg);
}

// -- ordering ----------------------------------------------------------------

function orderedAccounts(): Account[] {
  const s = getState();
  return [...s.accounts].sort((a, b) => {
    const ia = s.settings.accountOrder.indexOf(a.id);
    const ib = s.settings.accountOrder.indexOf(b.id);
    if (ia === -1 && ib === -1) return a.addedAt - b.addedAt;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

async function moveAccount(id: string, dir: -1 | 1 | { toIndex: number }): Promise<void> {
  const order = orderedAccounts().map((a) => a.id);
  const from = order.indexOf(id);
  if (from === -1) return;
  const to = typeof dir === 'number' ? from + dir : dir.toIndex;
  if (to < 0 || to >= order.length) return;
  const [moved] = order.splice(from, 1);
  if (moved === undefined) return;
  order.splice(to, 0, moved);
  await call({ type: 'saveSettings', settings: { accountOrder: order } });
}

// -- section: Accounts --------------------------------------------------------

function buildAccountsSection(): HTMLElement {
  const accounts = orderedAccounts();
  const section = h(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-accounts' },
    h('h2', { id: 'sec-accounts' }, 'Accounts'),
    h(
      'p',
      { class: 'section-desc' },
      'Rename, recolor, pause or reorder accounts. Order decides round-robin and “priority” rules.',
    ),
  );

  if (accounts.length === 0) {
    section.append(h('p', { class: 'empty-note' }, 'No accounts yet. Use the popup while signed in to claude.ai or platform.claude.com to save one.'));
    return section;
  }

  const table = h('div', { class: 'accounts-table' });
  accounts.forEach((acc, index) => {
    const swatchBtn = h('button', {
      class: 'btn-ghost',
      title: 'Change color',
      'aria-label': `Change color for ${acc.label || acc.displayName}`,
    });
    const swatch = h('span', { class: 'color-swatch' });
    swatch.style.background = acc.color ?? defaultAccountColor(index);
    swatchBtn.append(swatch);
    swatchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPalette(swatchBtn, acc);
    });

    const labelInput = h('input', {
      type: 'text',
      class: 'label-input',
      placeholder: acc.displayName,
      maxlength: '40',
      'aria-label': `Label for ${acc.email}`,
    });
    labelInput.value = acc.label ?? '';
    let debounceTimer: number | null = null;
    labelInput.addEventListener('input', () => {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      const value = labelInput.value.trim();
      debounceTimer = window.setTimeout(() => {
        void runAction(() =>
          call({ type: 'updateAccount', accountId: acc.id, patch: { label: value || undefined } }),
        );
      }, 400);
    });

    const flags = [
      acc.paused ? 'Paused' : null,
      acc.sessionExpired ? 'Session expired' : null,
    ].filter(Boolean);
    const kind = serviceOf(acc) === 'platform' ? `Platform${acc.orgName ? ` · ${acc.orgName}` : ''}` : `Claude.ai · ${acc.plan}`;
    const meta = h('span', { class: 'meta-text' }, `${kind} · ${acc.email}${flags.length ? ' · ' + flags.join(' · ') : ''}`);

    const up = h(
      'button',
      {
        class: 'order-btn',
        title: 'Move up',
        'aria-label': `Move ${acc.label || acc.displayName} up`,
        disabled: index === 0,
        onclick: () => void runAction(() => moveAccount(acc.id, -1)),
      },
      '▲',
    );
    const down = h(
      'button',
      {
        class: 'order-btn',
        title: 'Move down',
        'aria-label': `Move ${acc.label || acc.displayName} down`,
        disabled: index === accounts.length - 1,
        onclick: () => void runAction(() => moveAccount(acc.id, 1)),
      },
      '▼',
    );

    const pauseToggle = makeSwitch(!!acc.paused, `Pause ${acc.label || acc.displayName}`, (checked) => {
      void runAction(() => call({ type: 'updateAccount', accountId: acc.id, patch: { paused: checked } }));
    });

    const removeBtn = h(
      'button',
      {
        class: 'btn-ghost btn-danger',
        title: 'Remove account',
        onclick: () =>
          showConfirm(
            {
              title: 'Remove account?',
              body: `“${acc.label || acc.displayName}” and its stored session will be removed from this browser. This cannot be undone.`,
              confirmLabel: 'Remove',
              danger: true,
            },
            () => void runAction(() => call({ type: 'removeAccount', accountId: acc.id }), 'Account removed'),
          ),
      },
      'Remove',
    );

    const row = h(
      'div',
      { class: 'accounts-row', draggable: 'true', 'data-account-id': acc.id },
      up,
      down,
      swatchBtn,
      h('div', {}, labelInput, h('div', {}, meta)),
      h('div', { class: 'row-actions' }, h('span', { class: 'hint' }, 'Paused'), pauseToggle, removeBtn),
    );

    row.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer?.setData('text/plain', acc.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const draggedId = e.dataTransfer?.getData('text/plain');
      if (!draggedId || draggedId === acc.id) return;
      void runAction(() => moveAccount(draggedId, { toIndex: index }));
    });

    table.append(row);
  });

  section.append(table);
  return section;
}

function openPalette(anchor: HTMLElement, acc: Account): void {
  closePopovers();
  const current = acc.color ?? defaultAccountColor(0);
  const pop = h('div', { class: 'palette popover', role: 'listbox', 'aria-label': 'Account colors' });
  for (const color of ACCOUNT_COLOR_PALETTE) {
    const b = h('button', {
      class: color === current ? 'selected' : '',
      'aria-label': `Color ${color}`,
      onclick: () => {
        closePopovers();
        void runAction(() => call({ type: 'updateAccount', accountId: acc.id, patch: { color } }));
      },
    });
    b.style.background = color;
    pop.append(b);
  }
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 6 + window.scrollY}px`;
  pop.style.left = `${Math.max(8, rect.left + window.scrollX - 40)}px`;
  const dismiss = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node) && e.target !== anchor) {
      closePopovers();
      document.removeEventListener('mousedown', dismiss);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closePopovers();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('mousedown', dismiss);
  document.addEventListener('keydown', onKey, true);
}

function closePopovers(): void {
  document.querySelectorAll('.popover').forEach((el) => el.remove());
}

// -- section: Rules -----------------------------------------------------------

let ruleCounter = 0;

function newRule(): SwitchRule {
  ruleCounter += 1;
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rule-${Date.now()}-${ruleCounter}`,
    name: 'New rule',
    enabled: true,
    condition: { type: 'usageAbove', metric: 'maxAny', percent: 90 },
    target: { type: 'next' },
    targetMaxPercent: 80,
    cooldownMinutes: 30,
    confirm: false,
  };
}

function describeRule(rule: SwitchRule, accounts: Account[]): string {
  let condition = '';
  if (rule.condition.type === 'usageAbove') {
    condition = `When ${METRIC_LABELS[rule.condition.metric]} ≥ ${rule.condition.percent}%`;
  } else if (rule.condition.type === 'limitReached') {
    condition = 'When a rate limit is hit';
  } else {
    condition = `Daily at ${rule.condition.cron}`;
  }

  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? accounts.find((a) => a.id === id)?.displayName ?? 'removed account';
  let target = '';
  if (rule.target.type === 'next') target = 'switch to next account';
  else if (rule.target.type === 'lowestUsage') target = `switch to lowest ${METRIC_LABELS[rule.target.metric]}`;
  else if (rule.target.type === 'specific') target = `switch to ${nameOf(rule.target.accountId)}`;
  else target = 'switch to first in priority order';

  const extras: string[] = [];
  if (rule.targetMaxPercent !== undefined) extras.push(`targets must be < ${rule.targetMaxPercent}%`);
  extras.push(`cooldown ${rule.cooldownMinutes}m`);
  if (rule.confirm) extras.push('ask first');

  return `${condition} → ${target} (${extras.join(', ')})`;
}

function openRuleEditor(rule: SwitchRule, isNew: boolean, onCommit: (saved: SwitchRule) => void, onCancel?: () => void): void {
  const draft: SwitchRule = JSON.parse(JSON.stringify(rule)) as SwitchRule;
  // Rules only ever switch claude.ai accounts; Platform accounts are switched manually.
  const accounts = getState().accounts.filter((a) => serviceOf(a) === 'claude');

  const ov = overlay(() => {
    closeEditor();
    onCancel?.();
  });

  // Condition fields (re-rendered on condition-type change)
  const conditionBox = h('div', {});
  // Target fields (re-rendered on target-type change)
  const targetBox = h('div', {});

  function renderCondition(): void {
    clear(conditionBox);
    if (draft.condition.type === 'usageAbove') {
      const metricSel = h(
        'select',
        { 'aria-label': 'Metric', onchange: () => { (draft.condition as { metric: UsageMetric }).metric = metricSel.value as UsageMetric; } },
        ...METRIC_ORDER.map((m) => h('option', { value: m }, METRIC_LABELS[m])),
      );
      metricSel.value = draft.condition.metric;
      const pct = h('input', { type: 'number', min: '1', max: '100', step: '1', 'aria-label': 'Percent' });
      pct.value = String(draft.condition.percent);
      pct.addEventListener('input', () => {
        (draft.condition as { percent: number }).percent = Number(pct.value);
      });
      conditionBox.append(
        h('div', { class: 'field-row' }, metricSel, h('span', { class: 'field-suffix' }, 'usage is at or above'), pct, h('span', { class: 'field-suffix' }, '%')),
      );
    } else if (draft.condition.type === 'limitReached') {
      conditionBox.append(h('p', { class: 'hint' }, 'Fires when claude.ai returns a hard rate limit for the active account.'));
    } else {
      const time = h('input', { type: 'time', 'aria-label': 'Time of day' });
      time.value = /^\d{2}:\d{2}$/.test(draft.condition.cron) ? draft.condition.cron : '09:00';
      time.addEventListener('input', () => {
        (draft.condition as { cron: string }).cron = time.value;
      });
      conditionBox.append(h('div', { class: 'field-row' }, h('span', { class: 'field-suffix' }, 'Every day at'), time));
    }
  }

  function renderTarget(): void {
    clear(targetBox);
    if (draft.target.type === 'lowestUsage') {
      const metricSel = h(
        'select',
        { 'aria-label': 'Metric', onchange: () => { (draft.target as { metric: UsageMetric }).metric = metricSel.value as UsageMetric; } },
        ...METRIC_ORDER.map((m) => h('option', { value: m }, METRIC_LABELS[m])),
      );
      metricSel.value = draft.target.metric;
      targetBox.append(h('div', { class: 'field-row' }, h('span', { class: 'field-suffix' }, 'Pick the account with the lowest'), metricSel));
    } else if (draft.target.type === 'specific') {
      const sel = h(
        'select',
        { 'aria-label': 'Account', onchange: () => { (draft.target as { accountId: string }).accountId = sel.value; } },
        ...accounts.map((a) => h('option', { value: a.id }, `${a.label || a.displayName} (${a.email})`)),
      );
      if (accounts.some((a) => a.id === (draft.target as { accountId: string }).accountId)) {
        sel.value = (draft.target as { accountId: string }).accountId;
      } else if (accounts[0]) {
        sel.value = accounts[0].id;
        (draft.target as { accountId: string }).accountId = accounts[0].id;
      }
      targetBox.append(h('div', { class: 'field-row' }, h('span', { class: 'field-suffix' }, 'Switch to'), sel));
    } else if (draft.target.type === 'priority') {
      targetBox.append(h('p', { class: 'hint' }, 'Switches to the first eligible account in your Accounts order above.'));
    } else {
      targetBox.append(h('p', { class: 'hint' }, 'Round-robins through eligible accounts.'));
    }
  }

  const conditionType = h(
    'select',
    {
      'aria-label': 'Condition type',
      onchange: () => {
        if (conditionType.value === 'usageAbove') draft.condition = { type: 'usageAbove', metric: 'maxAny', percent: 90 };
        else if (conditionType.value === 'limitReached') draft.condition = { type: 'limitReached' };
        else draft.condition = { type: 'schedule', cron: '09:00' };
        renderCondition();
      },
    },
    h('option', { value: 'usageAbove' }, 'Usage above threshold'),
    h('option', { value: 'limitReached' }, 'Rate limit reached'),
    h('option', { value: 'schedule' }, 'Daily schedule'),
  );
  conditionType.value = draft.condition.type;

  const targetType = h(
    'select',
    {
      'aria-label': 'Target type',
      onchange: () => {
        if (targetType.value === 'next') draft.target = { type: 'next' };
        else if (targetType.value === 'lowestUsage') draft.target = { type: 'lowestUsage', metric: 'maxAny' };
        else if (targetType.value === 'specific') draft.target = { type: 'specific', accountId: accounts[0]?.id ?? '' };
        else draft.target = { type: 'priority' };
        renderTarget();
      },
    },
    h('option', { value: 'next' }, 'Next account (round-robin)'),
    h('option', { value: 'lowestUsage' }, 'Lowest usage'),
    h('option', { value: 'specific' }, 'A specific account'),
    h('option', { value: 'priority' }, 'First in priority order'),
  );
  targetType.value = draft.target.type;
  renderCondition();
  renderTarget();

  const nameInput = h('input', { type: 'text', maxlength: '60' });
  nameInput.value = draft.name;
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; });

  const maxPct = h('input', { type: 'number', min: '1', max: '100', step: '1', 'aria-label': 'Maximum usage percent for target accounts' });
  maxPct.value = draft.targetMaxPercent !== undefined ? String(draft.targetMaxPercent) : '';
  maxPct.placeholder = 'no limit';
  maxPct.addEventListener('input', () => {
    draft.targetMaxPercent = maxPct.value === '' ? undefined : Number(maxPct.value);
  });

  const cooldown = h('input', { type: 'number', min: '1', step: '1', 'aria-label': 'Cooldown in minutes' });
  cooldown.value = String(draft.cooldownMinutes);
  cooldown.addEventListener('input', () => { draft.cooldownMinutes = Math.max(1, Number(cooldown.value) || 1); });

  const confirmChk = h('input', { type: 'checkbox' });
  confirmChk.checked = draft.confirm;
  confirmChk.addEventListener('change', () => { draft.confirm = confirmChk.checked; });

  function closeEditor(): void {
    ov.dispose();
    ov.el.remove();
    editor.remove();
  }

  const saveBtn = h('button', {
    class: 'btn-primary',
    onclick: () => {
      draft.name = draft.name.trim() || describeRule(draft, accounts) + ' rule';
      if (draft.condition.type === 'usageAbove' && (!Number.isFinite(draft.condition.percent) || draft.condition.percent < 1 || draft.condition.percent > 100)) {
        showStatus('Percent must be between 1 and 100.', 'error');
        return;
      }
      if (draft.condition.type === 'schedule' && !/^\d{2}:\d{2}$/.test(draft.condition.cron)) {
        showStatus('Schedule must be a valid time.', 'error');
        return;
      }
      closeEditor();
      onCommit(draft);
    },
  }, isNew ? 'Add rule' : 'Save rule');

  const editor = h(
    'div',
    { class: 'rule-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'Add rule' : 'Edit rule' },
    h('h3', {}, isNew ? 'Add rule' : 'Edit rule'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), nameInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Condition'), conditionType, conditionBox),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Target'), targetType, targetBox),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Eligible targets'), h('div', { class: 'field-row' }, h('span', { class: 'field-suffix' }, 'Only accounts below'), maxPct, h('span', { class: 'field-suffix' }, '% usage'))),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Cooldown'), h('div', { class: 'field-row' }, h('span', { class: 'field-suffix' }, 'Wait at least'), cooldown, h('span', { class: 'field-suffix' }, 'minutes between runs'))),
    h('label', { class: 'check-line field' }, confirmChk, h('span', {}, 'Ask before switching (notification) instead of switching silently')),
    h('div', { class: 'dialog-actions' }, h('button', { onclick: () => { closeEditor(); onCancel?.(); } }, 'Cancel'), saveBtn),
  );

  document.body.append(ov.el, editor);
  nameInput.focus();
  nameInput.select();
}

function buildRulesSection(): HTMLElement {
  const s = getState();
  const section = h(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-rules' },
    h('h2', { id: 'sec-rules' }, 'Auto-switch rules'),
    h('p', { class: 'section-desc' }, 'Rules run only while “Auto-switch” is enabled above (or in the popup).'),
  );

  if (localRules.length === 0) {
    section.append(h('p', { class: 'empty-note' }, 'No rules yet. Add one to switch accounts automatically when limits get tight.'));
  }

  for (const rule of localRules) {
    const toggle = makeSwitch(rule.enabled, `Enable rule ${rule.name}`, (checked) => {
      rule.enabled = checked;
      rulesDirty = true;
      render();
    });
    section.append(
      h(
        'div',
        { class: 'rule-row' },
        h('div', {}, h('div', { class: 'rule-name' }, rule.name), h('div', { class: 'rule-desc' }, describeRule(rule, s.accounts))),
        h(
          'div',
          { class: 'rule-actions' },
          toggle,
          h('button', { class: 'btn-ghost', onclick: () => openRuleEditor(rule, false, (saved) => { Object.assign(rule, saved); rulesDirty = true; render(); }) }, 'Edit'),
          h('button', {
            class: 'btn-ghost',
            onclick: () => {
              const copy: SwitchRule = JSON.parse(JSON.stringify(rule)) as SwitchRule;
              copy.id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rule-${Date.now()}`;
              copy.name = `${copy.name} (copy)`;
              copy.enabled = false;
              localRules.splice(localRules.indexOf(rule) + 1, 0, copy);
              rulesDirty = true;
              render();
            },
          }, 'Duplicate'),
          h('button', {
            class: 'btn-ghost btn-danger',
            onclick: () =>
              showConfirm(
                { title: 'Delete rule?', body: `“${rule.name}” will be deleted.`, confirmLabel: 'Delete', danger: true },
                () => {
                  localRules = localRules.filter((r) => r.id !== rule.id);
                  rulesDirty = true;
                  render();
                },
              ),
          }, 'Delete'),
        ),
      ),
    );
  }

  const addBtn = h('button', {
    class: 'btn-primary',
    onclick: () => {
      const rule = newRule();
      openRuleEditor(rule, true, (saved) => {
        localRules.push(saved);
        rulesDirty = true;
        render();
      });
    },
  }, '+ Add rule');

  section.append(h('div', { class: 'row', style: 'margin-top: 12px' }, addBtn));

  if (rulesDirty) {
    section.append(
      h(
        'div',
        { class: 'row', style: 'margin-top: 12px' },
        h('button', {
          class: 'btn-primary',
          onclick: () => void runAction(async () => {
            await call({ type: 'saveRules', rules: localRules });
            rulesDirty = false;
            showStatus('Rules saved');
            render();
          }),
        }, 'Save rules'),
        h('button', {
          onclick: () => {
            localRules = JSON.parse(JSON.stringify(getState().rules)) as SwitchRule[];
            rulesDirty = false;
            render();
          },
        }, 'Discard changes'),
        h('span', { class: 'hint' }, 'You have unsaved rule changes.'),
      ),
    );
  }

  return section;
}

// -- section: Notifications ------------------------------------------------------

function saveNotifications(patch: (n: NotificationSettings) => NotificationSettings): void {
  const current = getState().settings.notifications ?? DEFAULT_NOTIFICATIONS;
  const next = patch(structuredClone(current));
  void runAction(() => call({ type: 'saveSettings', settings: { notifications: next } }));
}

/** A labelled on/off row inside a notification group. */
function notifyRow(label: string, hint: string, checked: boolean, disabled: boolean, onToggle: (v: boolean) => void): HTMLElement {
  const sw = makeSwitch(checked, label, onToggle);
  if (disabled) sw.querySelector('input')?.setAttribute('disabled', '');
  return h('div', { class: `notify-row${disabled ? ' muted' : ''}` },
    h('div', {}, h('div', { class: 'notify-label' }, label), h('div', { class: 'hint' }, hint)),
    sw);
}

/** Parse "50, 100, 250.5" (dollars) into sorted, unique cents. */
function parseDollarList(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const cents = parts.map((p) => Math.round(Number(p.replace(/^\$/, '')) * 100));
  if (cents.some((c) => !Number.isFinite(c) || c <= 0)) return null;
  return [...new Set(cents)].sort((a, b) => a - b);
}

function buildNotificationsSection(): HTMLElement {
  const n = getState().settings.notifications ?? DEFAULT_NOTIFICATIONS;
  const section = h(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-notify' },
    h('h2', { id: 'sec-notify' }, 'Notifications'),
    h('p', { class: 'section-desc' }, 'Desktop notifications, set separately for each product. Each one fires once per crossing, not on every check.'),
  );

  // Claude.ai
  const c = n.claude;
  const chipset = h('div', { class: 'chipset' });
  for (const pct of [50, 80, 90, 95]) {
    const on = c.usageThresholds.includes(pct);
    chipset.append(h('button', {
      class: on ? 'btn-primary' : '',
      'aria-pressed': String(on),
      disabled: !c.enabled,
      onclick: () => saveNotifications((x) => {
        x.claude.usageThresholds = on ? x.claude.usageThresholds.filter((v) => v !== pct) : [...x.claude.usageThresholds, pct].sort((a, b) => a - b);
        return x;
      }),
    }, `${pct}%`));
  }
  const claudeGroup = h('div', { class: 'notify-group' },
    h('div', { class: 'notify-head' },
      h('h3', {}, 'Claude.ai'),
      makeSwitch(c.enabled, 'Claude.ai notifications', (v) => saveNotifications((x) => { x.claude.enabled = v; return x; }))),
    h('div', { class: `field${c.enabled ? '' : ' muted'}` }, h('span', { class: 'field-label' }, 'Usage reaches…'), chipset,
      h('p', { class: 'hint' }, 'Applies to the active account’s highest limit (session or weekly).')),
    notifyRow('Limit reached', 'A usage limit hit 100% and claude.ai is blocking messages.', c.limitReached, !c.enabled, (v) => saveNotifications((x) => { x.claude.limitReached = v; return x; })),
    notifyRow('Auto-switch happened', 'A rule switched you to another account.', c.autoSwitch, !c.enabled, (v) => saveNotifications((x) => { x.claude.autoSwitch = v; return x; })),
    notifyRow('Session expired', 'A saved account needs you to sign in again.', c.sessionExpired, !c.enabled, (v) => saveNotifications((x) => { x.claude.sessionExpired = v; return x; })),
  );

  // Claude Platform
  const p = n.platform;
  const spendInput = h('input', {
    type: 'text',
    inputmode: 'decimal',
    placeholder: 'e.g. 50, 100, 250',
    'aria-label': 'Monthly spend thresholds in US dollars',
    disabled: !p.enabled,
  });
  spendInput.value = p.spendThresholdsCents.map((ct) => String(ct / 100)).join(', ');
  spendInput.addEventListener('change', () => {
    const parsed = spendInput.value.trim() === '' ? [] : parseDollarList(spendInput.value);
    if (!parsed) {
      showStatus('Use dollar amounts separated by commas, e.g. 50, 100', 'error');
      return;
    }
    saveNotifications((x) => { x.platform.spendThresholdsCents = parsed; return x; });
  });
  const platformGroup = h('div', { class: 'notify-group' },
    h('div', { class: 'notify-head' },
      h('h3', {}, 'Claude Platform'),
      makeSwitch(p.enabled, 'Claude Platform notifications', (v) => saveNotifications((x) => { x.platform.enabled = v; return x; }))),
    h('div', { class: `field${p.enabled ? '' : ' muted'}` }, h('span', { class: 'field-label' }, 'Monthly spend passes…'),
      h('div', { class: 'field-row' }, h('span', { class: 'field-suffix' }, '$'), spendInput),
      h('p', { class: 'hint' }, 'Active Platform account, current month. Leave empty for none.')),
    notifyRow('API disabled', 'The organization’s API access was turned off, e.g. it ran out of credits.', p.apiDisabled, !p.enabled, (v) => saveNotifications((x) => { x.platform.apiDisabled = v; return x; })),
    notifyRow('Session expired', 'A saved Platform account needs you to sign in again.', p.sessionExpired, !p.enabled, (v) => saveNotifications((x) => { x.platform.sessionExpired = v; return x; })),
  );

  section.append(h('div', { class: 'notify-grid' }, claudeGroup, platformGroup));
  return section;
}

// -- section: Polling & appearance -----------------------------------------------

function buildPrefsSection(): HTMLElement {
  const { settings } = getState();
  const section = h(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-prefs' },
    h('h2', { id: 'sec-prefs' }, 'Polling & appearance'),
    h('p', { class: 'section-desc' }, 'How often usage is checked and how the extension looks.'),
  );

  // Poll interval
  const poll = h('input', { type: 'number', min: '1', step: '1', 'aria-label': 'Poll interval in minutes' });
  poll.value = String(settings.pollIntervalMinutes);
  poll.addEventListener('change', () => {
    const value = Math.max(1, Math.round(Number(poll.value)) || settings.pollIntervalMinutes);
    poll.value = String(value);
    void runAction(() => call({ type: 'saveSettings', settings: { pollIntervalMinutes: value } }), 'Saved');
  });
  section.append(
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Usage polling'),
      h('div', { class: 'field-row' }, h('span', { class: 'field-suffix' }, 'Check every'), poll, h('span', { class: 'field-suffix' }, 'minutes'))),
  );

  // Badge
  const badgeToggle = makeSwitch(settings.showBadge, 'Show badge on the toolbar icon', (checked) => {
    void runAction(() => call({ type: 'saveSettings', settings: { showBadge: checked } }));
  });
  const badgeMetric = h(
    'select',
    { 'aria-label': 'Badge metric', onchange: () => void runAction(() => call({ type: 'saveSettings', settings: { badgeMetric: badgeMetric.value as UsageMetric } })) },
    ...METRIC_ORDER.map((m) => h('option', { value: m }, METRIC_LABELS[m])),
  );
  badgeMetric.value = settings.badgeMetric;
  section.append(
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Toolbar badge'),
      h('div', { class: 'field-row' }, badgeToggle, h('span', { class: 'field-suffix' }, 'Show usage % of the'), badgeMetric, h('span', { class: 'field-suffix' }, 'window'))),
  );

  // Theme
  const themeSel = h(
    'select',
    { 'aria-label': 'Theme', onchange: () => void runAction(() => call({ type: 'saveSettings', settings: { theme: themeSel.value as 'system' | 'light' | 'dark' } })) },
    h('option', { value: 'system' }, 'Match system'),
    h('option', { value: 'light' }, 'Light'),
    h('option', { value: 'dark' }, 'Dark'),
  );
  themeSel.value = settings.theme;
  section.append(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Theme'), themeSel));

  return section;
}

// -- section: History -----------------------------------------------------------

function buildHistorySection(): HTMLElement {
  const s = getState();
  const rulesById = new Map(s.rules.map((r) => [r.id, r.name]));
  const nameOf = (id: string | null) => {
    if (!id) return '—';
    const acc = s.accounts.find((a) => a.id === id);
    return acc ? acc.label || acc.displayName : '(removed account)';
  };

  const section = h(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-history' },
    h('h2', { id: 'sec-history' }, 'Switch history'),
    h('p', { class: 'section-desc' }, 'The last 200 account switches, newest first.'),
  );

  if (s.history.length === 0) {
    section.append(h('p', { class: 'empty-note' }, 'No switches recorded yet.'));
    return section;
  }

  const tbody = h('tbody', {});
  for (const ev of s.history.slice(0, 200)) {
    const reason =
      ev.reason === 'rule' && ev.ruleId
        ? `Rule: ${rulesById.get(ev.ruleId) ?? '(deleted rule)'}`
        : ev.reason === 'shortcut'
          ? 'Keyboard shortcut'
          : 'Manual';
    tbody.append(
      h('tr', {},
        h('td', {}, formatDateTime(ev.at)),
        h('td', {}, ev.service === 'platform' ? 'Platform' : 'Claude.ai'),
        h('td', {}, nameOf(ev.fromAccountId)),
        h('td', {}, nameOf(ev.toAccountId)),
        h('td', {}, reason)),
    );
  }
  section.append(
    h('div', { class: 'history-wrap' },
      h('table', { class: 'history-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Product'), h('th', {}, 'From'), h('th', {}, 'To'), h('th', {}, 'Reason'))),
        tbody)),
  );
  return section;
}

// -- section: Backup ----------------------------------------------------------

function buildBackupSection(): HTMLElement {
  const section = h(
    'section',
    { class: 'section', 'aria-labelledby': 'sec-backup' },
    h('h2', { id: 'sec-backup' }, 'Backup'),
    h('p', { class: 'section-desc' }, 'Exports are plain JSON. They never leave this machine unless you move the file yourself.'),
  );

  // Export
  const exportPass = h('input', { type: 'password', placeholder: 'Passphrase', 'aria-label': 'Passphrase for encrypted secret export' });
  const exportBtn = (withSecrets: boolean) =>
    h('button', {
      class: withSecrets ? 'btn-danger' : '',
      onclick: () => void runAction(async () => {
        const passphrase = withSecrets ? exportPass.value : undefined;
        if (withSecrets && !passphrase) {
          showStatus('Enter a passphrase first.', 'error');
          return;
        }
        const { payload } = await call({ type: 'exportData', includeSecrets: withSecrets, passphrase });
        const stamp = new Date().toISOString().slice(0, 10);
        downloadTextFile(`switchboard-backup-${withSecrets ? 'full' : 'safe'}-${stamp}.json`, payload);
        showStatus('Export downloaded');
      }),
    }, withSecrets ? 'Export with secrets' : 'Export (without secrets)');

  section.append(
    h('div', { class: 'stack' },
      h('div', { class: 'row' }, exportBtn(false)),
      h('p', { class: 'hint' }, 'Safe exports contain accounts (without session cookies), rules, settings and history.'),
      h('div', { class: 'secret-warning' },
        'Full exports contain your claude.ai and Claude Platform session keys. Anyone with the file and passphrase can use your accounts. ' +
          'Store it like a password, and revoke sessions on claude.ai if you ever lose one.'),
      h('div', { class: 'row' }, exportPass, exportBtn(true)),
    ),
  );

  // Import
  const importText = h('textarea', {
    id: 'import-payload',
    placeholder: 'Paste an export here, or pick a file…',
    'aria-label': 'Import payload',
  });
  exportPass.value = '';

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Choose export file' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then((text) => { importText.value = text; });
  });

  const importPass = h('input', { type: 'password', placeholder: 'Passphrase (if exported with secrets)', 'aria-label': 'Import passphrase' });
  const importBtn = h('button', {
    class: 'btn-primary',
    onclick: () => void runAction(async () => {
      if (!importText.value.trim()) {
        showStatus('Paste an export or pick a file first.', 'error');
        return;
      }
      await call({ type: 'importData', payload: importText.value, passphrase: importPass.value || undefined });
      importText.value = '';
      showStatus('Import complete');
    }),
  }, 'Import');

  section.append(
    h('div', { class: 'stack', style: 'margin-top: 14px' },
      h('span', { class: 'field-label' }, 'Import'),
      importText,
      h('div', { class: 'row' }, fileInput),
      h('div', { class: 'row' }, importPass, importBtn)),
  );

  return section;
}

// -- section: About -----------------------------------------------------------

function buildAboutSection(): HTMLElement {
  return h(
    'section',
    { class: 'section about', 'aria-labelledby': 'sec-about' },
    h('h2', { id: 'sec-about' }, 'About'),
    h('p', {},
      h('strong', {}, 'Switchboard for Claude'),
      ' is an unofficial, open-source browser extension. It is not affiliated with, endorsed by, or sponsored by Anthropic. ' +
        'Anthropic does not review or support this extension — use of claude.ai remains subject to Anthropic’s terms of service.',
    ),
    h('p', {},
      h('strong', {}, 'Privacy: '),
      'all data — accounts, session cookies, rules, settings and history — is stored only in this browser’s local extension storage. ' +
        'Nothing is sent anywhere except requests from your browser to claude.ai itself, exactly as if you were logged in. ' +
        'There is no telemetry, no analytics and no third-party servers.',
    ),
    h('p', {},
      h('a', { href: 'https://github.com/dotKa/claude-switchboard', target: '_blank', rel: 'noreferrer' }, 'github.com/dotKa/claude-switchboard'),
    ),
  );
}

// -- render -------------------------------------------------------------------

function render(): void {
  const s = getState();
  clear(app);
  const page = h('main', { class: 'page' });
  page.append(
    h('header', { class: 'page-header' },
      h('h1', {}, 'Switchboard for Claude'),
      h('p', { class: 'page-subtitle' }, `Options${mockMode ? ' · mock data (not running in the extension)' : ''}`)),
  );
  // Auto-switch master toggle mirrors the popup footer.
  page.append(
    h('section', { class: 'section' },
      h('div', { class: 'row' },
        makeSwitch(s.settings.autoSwitchEnabled, 'Enable auto-switching', (checked) => {
          void runAction(() => call({ type: 'saveSettings', settings: { autoSwitchEnabled: checked } }));
        }),
        h('div', {},
          h('h2', {}, 'Auto-switch'),
          h('p', { class: 'section-desc', style: 'margin-bottom: 0' }, 'When on, enabled rules below may switch your account automatically.'))),
    ),
  );
  page.append(buildAccountsSection());
  page.append(buildRulesSection());
  page.append(buildNotificationsSection());
  page.append(buildPrefsSection());
  page.append(buildHistorySection());
  page.append(buildBackupSection());
  page.append(buildAboutSection());
  app.append(page);
}

async function main(): Promise<void> {
  try {
    await initStore();
  } catch (err) {
    app.append(h('div', { class: 'loading' }, `Could not load state: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  initTheme();
  localRules = JSON.parse(JSON.stringify(getState().rules)) as SwitchRule[];
  rulesDirty = false;
  render();
  onStateChange(() => {
    // If rules changed in the background and we have no local edits, resync silently.
    if (!rulesDirty) localRules = JSON.parse(JSON.stringify(getState().rules)) as SwitchRule[];
    render();
  });
}

void main();

// `icon` is imported by other pages via dom.ts; keep this module focused.
void icon;
