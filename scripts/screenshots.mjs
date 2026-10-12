// Regenerates docs/screenshots/* from the production build in mock mode (dummy data only).
// Usage: npm run build && npx vite preview --port 5288 &  then  npx -p playwright node scripts/screenshots.mjs
import { chromium } from 'playwright';
const out = new URL('../docs/screenshots/', import.meta.url).pathname.replace(/\/$/, '');
const base = 'http://localhost:5288';
const b = await chromium.launch();
const errs = [];
const hideMockNote = (p) => p.evaluate(() => { const el = document.querySelector('.page-subtitle'); if (el) el.textContent = 'Options'; });
for (const scheme of ['light', 'dark']) {
  const sfx = scheme === 'dark' ? '-dark' : '';
  const ctx = await b.newContext({ colorScheme: scheme, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  // Popup: Claude.ai tab, Platform tab
  await p.setViewportSize({ width: 360, height: 620 });
  await p.goto(`${base}/popup/index.html`); await p.waitForTimeout(500);
  await p.screenshot({ path: `${out}/popup${sfx}.png` });
  await p.getByRole('tab', { name: /Platform/ }).click(); await p.waitForTimeout(250);
  await p.setViewportSize({ width: 360, height: 420 });
  await p.screenshot({ path: `${out}/popup-platform${sfx}.png` });
  await p.getByRole('tab', { name: /Claude\.ai/ }).click();
  // Options: top of page, rules, notifications
  await p.setViewportSize({ width: 1100, height: 900 });
  await p.goto(`${base}/options/index.html`); await p.waitForTimeout(500); await hideMockNote(p);
  await p.screenshot({ path: `${out}/options${sfx}.png` });
  await p.locator('section[aria-labelledby="sec-notify"]').screenshot({ path: `${out}/notifications${sfx}.png` });
  await ctx.close();
}
console.log('errors:', errs.join('; ') || 'none');
await b.close();
