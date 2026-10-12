import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock } from './chromeMock';
import { hasPlatformPermission } from '../../src/background/permissions';

let mocks: ReturnType<typeof installChromeMock>;

beforeEach(() => {
  mocks = installChromeMock();
});

describe('hasPlatformPermission', () => {
  it('returns true when chrome.permissions.contains resolves true', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(true);
    await expect(hasPlatformPermission()).resolves.toBe(true);
    expect(mocks.chromeMock.permissions.contains).toHaveBeenCalledWith({ origins: ['https://platform.claude.com/*'] });
  });

  it('returns false when chrome.permissions.contains resolves false', async () => {
    mocks.chromeMock.permissions.contains.mockResolvedValue(false);
    await expect(hasPlatformPermission()).resolves.toBe(false);
  });

  it('returns false (never throws) if chrome.permissions.contains itself rejects', async () => {
    mocks.chromeMock.permissions.contains.mockRejectedValue(new Error('boom'));
    await expect(hasPlatformPermission()).resolves.toBe(false);
  });
});
