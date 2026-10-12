// Whether the optional `https://platform.claude.com/*` host permission (see public/manifest.json
// and src/shared/types.ts's `PLATFORM_ORIGIN_PATTERN`) is currently granted. It's requested from the
// popup — `chrome.permissions.request()` requires a user gesture, which a background service worker
// never has — when the user opts into Claude Platform support.
//
// Every platform-service operation elsewhere in src/background checks this FIRST and fails soft
// (skip silently for background polling, or a clear "Allow access to platform.claude.com first"
// error for a user-initiated action) rather than letting a `chrome.cookies`/`fetch` call throw its
// much less helpful "No host permissions for ... at url: https://platform.claude.com/" error.
import { PLATFORM_ORIGIN_PATTERN } from '../shared/types';

export async function hasPlatformPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [PLATFORM_ORIGIN_PATTERN] });
  } catch {
    // Be conservative: if we can't even ask, assume we don't have it.
    return false;
  }
}
