// Applies settings.theme ('system' | 'light' | 'dark') to the document.
// 'system' removes the override so prefers-color-scheme media queries win.
import type { Settings } from '../shared/types';
import { onStateChange, getState } from './store';

export function applyTheme(theme: Settings['theme']): void {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function initTheme(): void {
  applyTheme(getState().settings.theme);
  onStateChange(() => applyTheme(getState().settings.theme));
}
