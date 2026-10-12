// Entry point for the background service worker (bundled as background.js).
//
// MV3 requires every chrome.* event listener to be registered synchronously during the worker's
// initial (sync) module evaluation — a listener added inside an awaited async callback can miss
// events that fire before it's attached. Each imported module below registers its own listeners
// as top-level, synchronous side effects, so plain static imports are enough to wire everything up
// before this file's own (async) startup logic runs.
import './session'; // chrome.cookies.onChanged — unsaved-login detection
import './scheduler'; // chrome.alarms.onAlarm, chrome.notifications.onButtonClicked, chrome.commands.onCommand
import './router'; // chrome.runtime.onMessage

import { clearLeftoverUsageOverrideRules } from './claudeApi';
import { broadcastState } from './router';
import { refreshUsage, schedulePolling, updateBadge } from './scheduler';
import { loadState } from './storage';
import { PLATFORM_ORIGIN_PATTERN } from '../shared/types';

async function initialize(): Promise<void> {
  const state = await loadState(); // persists the default record on first run
  await schedulePolling(state.settings.pollIntervalMinutes);
  await updateBadge();
  await clearLeftoverUsageOverrideRules(); // in case a prior service worker died mid-fetch
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

// chrome.alarms persist across service worker restarts, but re-running this on every wake keeps
// the alarm period and badge in sync in case settings changed while the worker was asleep.
void initialize();

// The optional platform.claude.com host permission is granted/revoked from the popup — reacting
// here (rather than in router.ts, which can't see scheduler.ts's refreshUsage without a circular
// import) keeps every tab's view of PublicState.platformPermission in sync immediately, and gets a
// fresh platform usage snapshot as soon as access is granted rather than waiting for the next poll.
chrome.permissions.onAdded.addListener((permissions) => {
  if (!permissions.origins?.includes(PLATFORM_ORIGIN_PATTERN)) return;
  void refreshUsage().then(() => broadcastState());
});

chrome.permissions.onRemoved.addListener((permissions) => {
  if (!permissions.origins?.includes(PLATFORM_ORIGIN_PATTERN)) return;
  void broadcastState();
});
