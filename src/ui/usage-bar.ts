// Shared usage bar component: label + track + % + reset time.
import { h } from './dom';
import type { DisplayBar } from './format';
import { formatResetAt, severityOf } from './format';

export function createUsageBar(bar: DisplayBar, opts: { className?: string } = {}): HTMLElement {
  const cls = ['usage', opts.className].filter(Boolean).join(' ');
  const left = h('span', { class: 'usage-label' }, bar.label);
  if (bar.percent === null) {
    return h('div', { class: cls }, h('div', { class: 'usage-row' }, left, h('span', { class: 'usage-num' }, '—')));
  }
  const pct = Math.max(0, Math.min(100, Math.round(bar.percent)));
  const fill = h('div', { class: `usage-fill ${severityOf(pct)}` });
  fill.style.width = `${pct}%`;
  const track = h(
    'div',
    {
      class: 'usage-bar',
      role: 'progressbar',
      'aria-label': `${bar.label} usage`,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(pct),
    },
    fill,
  );
  const el = h('div', { class: cls }, h('div', { class: 'usage-row' }, left, h('span', { class: 'usage-num' }, `${pct}%`)), track);
  if (bar.resetsAt) el.append(h('div', { class: 'usage-meta' }, `Resets in ${formatResetAt(bar.resetsAt)}`));
  return el;
}
