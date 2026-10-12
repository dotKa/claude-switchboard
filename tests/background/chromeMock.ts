// Minimal in-memory chrome.* mock shared by background unit tests. Only implements what the
// background modules under test actually call.
import { vi } from 'vitest';

export function installChromeMock() {
  const localData: Record<string, unknown> = {};
  const sessionData: Record<string, unknown> = {};
  const listeners = {
    onMessage: [] as Array<(msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void>,
    onCookiesChanged: [] as Array<(info: unknown) => void>,
    onAlarm: [] as Array<(alarm: unknown) => void>,
    onInstalled: [] as Array<() => void>,
    onCommand: [] as Array<(cmd: string) => void>,
    onNotificationButtonClicked: [] as Array<(id: string, buttonIndex: number) => void>,
    onNotificationClosed: [] as Array<(id: string, byUser: boolean) => void>,
    onPermissionsAdded: [] as Array<(permissions: chrome.permissions.Permissions) => void>,
    onPermissionsRemoved: [] as Array<(permissions: chrome.permissions.Permissions) => void>,
  };

  const chromeMock = {
    storage: {
      local: {
        get: vi.fn((keys?: string | string[] | null) => {
          if (!keys) return Promise.resolve({ ...localData });
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in localData) out[k] = localData[k];
          return Promise.resolve(out);
        }),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(localData, items);
          return Promise.resolve();
        }),
      },
      session: {
        get: vi.fn((keys?: string | string[] | null) => {
          if (!keys) return Promise.resolve({ ...sessionData });
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in sessionData) out[k] = sessionData[k];
          return Promise.resolve(out);
        }),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(sessionData, items);
          return Promise.resolve();
        }),
      },
    },
    cookies: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      onChanged: { addListener: vi.fn((cb) => listeners.onCookiesChanged.push(cb)) },
    },
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
      onMessage: { addListener: vi.fn((cb) => listeners.onMessage.push(cb)) },
      onInstalled: { addListener: vi.fn((cb) => listeners.onInstalled.push(cb)) },
    },
    tabs: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      query: vi.fn().mockResolvedValue([]),
      reload: vi.fn().mockResolvedValue(undefined),
      // Defaults to "already parked" (complete, on the switching page) so the park-and-wait helper
      // resolves on its first check without a real chrome.tabs.onUpdated event — tests for the
      // parking sequence itself don't need to simulate tab load timing.
      update: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ status: 'complete', url: 'chrome-extension://test-extension-id/switching/index.html' }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      TAB_ID_NONE: -1,
    },
    browsingData: {
      remove: vi.fn().mockResolvedValue(undefined),
    },
    alarms: {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(undefined),
      onAlarm: { addListener: vi.fn((cb) => listeners.onAlarm.push(cb)) },
    },
    notifications: {
      create: vi.fn(),
      clear: vi.fn(),
      onButtonClicked: { addListener: vi.fn((cb) => listeners.onNotificationButtonClicked.push(cb)) },
      onClosed: { addListener: vi.fn((cb) => listeners.onNotificationClosed.push(cb)) },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    commands: {
      onCommand: { addListener: vi.fn((cb) => listeners.onCommand.push(cb)) },
    },
    declarativeNetRequest: {
      updateSessionRules: vi.fn().mockResolvedValue(undefined),
      getSessionRules: vi.fn().mockResolvedValue([]),
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
    },
    // Defaults to granted so existing tests (written before the optional-permission flow existed)
    // keep exercising the normal "platform works" path; tests for the ungranted case set this false.
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
      request: vi.fn().mockResolvedValue(true),
      onAdded: { addListener: vi.fn((cb) => listeners.onPermissionsAdded.push(cb)) },
      onRemoved: { addListener: vi.fn((cb) => listeners.onPermissionsRemoved.push(cb)) },
    },
  };

  (globalThis as Record<string, unknown>).chrome = chromeMock;
  return { chromeMock, localData, sessionData, listeners };
}
