// Builds the Chrome Web Store assets in docs/store/ from the production build in mock mode
// (dummy data only). Usage:
//   npm run build && npx vite preview --port 5288 &
//   npx -p playwright node scripts/store-assets.mjs
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const out = (name) => new URL(`docs/store/${name}`, root).pathname;
const base = 'http://localhost:5288';
const dataUrl = (buf, type = 'image/png') => `data:${type};base64,${buf.toString('base64')}`;
const iconSvg = readFileSync(new URL('public/icons/icon.svg', root), 'utf8');

const browser = await chromium.launch();

// 1. Source captures (2x) of the real UI with mock data.
async function capture(scheme, path, setup, target) {
  const ctx = await browser.newContext({ colorScheme: scheme, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await setup(p);
  await p.goto(`${base}${path}`);
  await p.waitForTimeout(500);
  await p.evaluate(() => { const el = document.querySelector('.page-subtitle'); if (el) el.textContent = 'Options'; });
  const buf = await target(p);
  await ctx.close();
  return buf;
}
const popupSize = (h) => async (p) => p.setViewportSize({ width: 360, height: h });
const optionsSize = async (p) => p.setViewportSize({ width: 860, height: 900 });
const src = {
  popupLight: await capture('light', '/popup/index.html', popupSize(620), (p) => p.screenshot()),
  popupDark: await capture('dark', '/popup/index.html', popupSize(620), (p) => p.screenshot()),
  platform: await capture('light', '/popup/index.html', popupSize(440), async (p) => {
    await p.getByRole('tab', { name: /Platform/ }).click();
    await p.waitForTimeout(200);
    return p.screenshot();
  }),
  rules: await capture('light', '/options/index.html', optionsSize, (p) => p.locator('section[aria-labelledby="sec-rules"]').screenshot()),
  notify: await capture('light', '/options/index.html', optionsSize, (p) => p.locator('section[aria-labelledby="sec-notify"]').screenshot()),
};

// 2. Composition.
const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&display=swap" rel="stylesheet">';
const css = `
  :root { --charcoal:#262624; --ink:#1c1b19; --bone:#efe9e1; --muted:#a8a097; --clay:#d97757; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--charcoal); color:var(--bone); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; overflow:hidden; }
  h1 { font-family:"Bricolage Grotesque",system-ui,sans-serif; font-weight:700; letter-spacing:-0.025em; line-height:1.02; }
  .lede { color:var(--muted); line-height:1.5; }
  .shot { display:block; border-radius:18px; box-shadow:0 30px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06); }
  /* The one bold element: an oversized toggle switch, knob = your account. */
  .toggle { position:absolute; border-radius:999px; background:var(--clay); }
  .toggle::before { content:""; position:absolute; border-radius:50%; border:solid rgba(243,214,203,.55); }
  .toggle::after { content:""; position:absolute; border-radius:50%; background:#fff; }
  .mark { display:flex; align-items:center; gap:14px; }
  .mark svg { width:44px; height:44px; }
  .mark span { font-family:"Bricolage Grotesque",system-ui,sans-serif; font-weight:700; font-size:22px; letter-spacing:-0.01em; }
`;
function toggleCss(sel, w, h) {
  const r = h / 2;
  return `${sel}{width:${w}px;height:${h}px}
  ${sel}::before{width:${r * 1.0}px;height:${r * 1.0}px;left:${r * 0.5}px;top:${r * 0.5}px;border-width:${Math.max(3, r * 0.1)}px}
  ${sel}::after{width:${r * 1.45}px;height:${r * 1.45}px;right:${r * 0.275}px;top:${r * 0.275}px}`;
}

async function render(name, width, height, html, type = 'jpeg') {
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setViewportSize({ width, height });
  await p.setContent(`<!doctype html><html><head>${fonts}<style>${css}</style></head><body style="width:${width}px;height:${height}px">${html}</body></html>`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: out(name), type, ...(type === 'jpeg' ? { quality: 92 } : { omitBackground: true }) });
  await ctx.close();
  console.log(name);
}

function screenshot1280(title, lede, img, imgWidth) {
  return `
  <style>${toggleCss('.t1', 760, 380)} .t1{right:-150px;bottom:-120px;opacity:.95}</style>
  <div class="toggle t1"></div>
  <div style="position:absolute;left:88px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center;gap:22px">
    <div class="mark">${iconSvg}<span>Switchboard for Claude</span></div>
    <h1 style="font-size:60px">${title}</h1>
    <p class="lede" style="font-size:21px;max-width:28ch">${lede}</p>
  </div>
  <div style="position:absolute;right:96px;top:0;bottom:0;display:flex;align-items:center">
    <img class="shot" src="${dataUrl(img)}" style="width:${imgWidth}px">
  </div>`;
}

const shots = [
  ['screenshot-1-switch.jpg', 'Every Claude account, one click away.', 'Save each claude.ai account once, then switch from the toolbar. Your open tabs follow along.', src.popupLight, 370],
  ['screenshot-2-limits.jpg', 'See your limits before you hit them.', 'Session, weekly and per-model limits for every account, with reset times and a toolbar badge.', src.popupDark, 370],
  ['screenshot-3-rules.jpg', 'Let a rule pick the next account.', 'Switch automatically when usage passes a threshold, a limit is reached, or at a set time.', src.rules, 560],
  ['screenshot-4-platform.jpg', 'Claude Platform accounts, too.', 'Keep your platform.claude.com organizations next to your chat accounts and switch between them.', src.platform, 380],
  ['screenshot-5-notify.jpg', 'Notifications you choose, per product.', 'Usage thresholds, limits and expired sessions for claude.ai; spend and API status for Claude Platform.', src.notify, 600],
];
for (const [name, title, lede, img, w] of shots) await render(name, 1280, 800, screenshot1280(title, lede, img, w));

// Small promo tile 440x280.
await render('promo-small-440x280.jpg', 440, 280, `
  <style>${toggleCss('.t2', 300, 150)} .t2{right:-60px;bottom:-40px}</style>
  <div class="toggle t2"></div>
  <div style="position:absolute;left:30px;top:30px;right:30px">
    <h1 style="font-size:40px">Switchboard</h1>
    <p class="lede" style="font-size:17px;margin-top:6px">for Claude</p>
    <p style="font-size:15px;margin-top:28px;max-width:20ch;line-height:1.4">Switch accounts. Watch your limits.</p>
  </div>`);

// Marquee 1400x560.
await render('promo-marquee-1400x560.jpg', 1400, 560, `
  <style>${toggleCss('.t3', 820, 410)} .t3{right:-120px;bottom:-200px}</style>
  <div class="toggle t3"></div>
  <div style="position:absolute;left:96px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center;gap:20px">
    <div class="mark">${iconSvg}<span>Switchboard for Claude</span></div>
    <h1 style="font-size:68px">Switch Claude accounts. Watch your limits.</h1>
  </div>
  <div style="position:absolute;right:160px;top:38px">
    <img class="shot" src="${dataUrl(src.popupLight)}" style="width:280px">
  </div>`);

// Store icon: 96px artwork centered in a 128px transparent canvas.
await render('store-icon-128.png', 128, 128, `<div style="position:absolute;inset:16px">${iconSvg.replace('<svg ', '<svg width="96" height="96" ')}</div>`, 'png');

await browser.close();
