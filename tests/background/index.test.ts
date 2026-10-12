import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './chromeMock';

vi.mock('../../src/background/session', () => ({}));
vi.mock('../../src/background/router', () => ({
  broadcastState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/background/scheduler', () => ({
  schedulePolling: vi.fn().mockResolvedValue(undefined),
  updateBadge: vi.fn().mockResolvedValue(undefined),
  refreshUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/background/claudeApi', () => ({
  clearLeftoverUsageOverrideRules: vi.fn().mockResolvedValue(undefined),
}));

let mocks: ReturnType<typeof installChromeMock>;
let scheduler: typeof import('../../src/background/scheduler');
let claudeApi: typeof import('../../src/background/claudeApi');
let router: typeof import('../../src/background/router');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks = installChromeMock();
  await import('../../src/background/index');
  scheduler = await import('../../src/background/scheduler');
  claudeApi = await import('../../src/background/claudeApi');
  router = await import('../../src/background/router');
});

describe('background entry point', () => {
  it('schedules polling and updates the badge on startup', async () => {
    await vi.waitFor(() => expect(scheduler.schedulePolling).toHaveBeenCalled());
    expect(scheduler.updateBadge).toHaveBeenCalled();
  });

  it('re-schedules polling on onInstalled using the stored poll interval', async () => {
    const { localData } = mocks;
    localData.state = { settings: { pollIntervalMinutes: 30 } };
    vi.mocked(scheduler.schedulePolling).mockClear();

    const onInstalledListener = mocks.listeners.onInstalled[0]!;
    onInstalledListener();

    await vi.waitFor(() => expect(scheduler.schedulePolling).toHaveBeenCalledWith(30));
  });

  it('clears any leftover usage-override DNR session rules on startup', async () => {
    await vi.waitFor(() => expect(claudeApi.clearLeftoverUsageOverrideRules).toHaveBeenCalled());
  });
});

describe('chrome.permissions.onAdded/onRemoved wiring', () => {
  it('granting the platform permission refreshes platform usage and broadcasts the new state', async () => {
    const onAdded = mocks.listeners.onPermissionsAdded[0]!;
    onAdded({ origins: ['https://platform.claude.com/*'], permissions: [] });

    await vi.waitFor(() => expect(router.broadcastState).toHaveBeenCalled());
    expect(scheduler.refreshUsage).toHaveBeenCalled();
  });

  it('revoking the platform permission only broadcasts — no refresh of an access it no longer has', async () => {
    const onRemoved = mocks.listeners.onPermissionsRemoved[0]!;
    onRemoved({ origins: ['https://platform.claude.com/*'], permissions: [] });

    await vi.waitFor(() => expect(router.broadcastState).toHaveBeenCalled());
    expect(scheduler.refreshUsage).not.toHaveBeenCalled();
  });

  it('ignores a permission change unrelated to platform.claude.com', async () => {
    const onAdded = mocks.listeners.onPermissionsAdded[0]!;
    onAdded({ origins: ['https://example.com/*'], permissions: [] });

    await Promise.resolve(); // let any microtasks flush
    expect(scheduler.refreshUsage).not.toHaveBeenCalled();
    expect(router.broadcastState).not.toHaveBeenCalled();
  });
});
