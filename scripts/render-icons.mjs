// Rasterize public/icons/*.svg to the PNG sizes the manifest uses.
// Needs Playwright (not a project dependency): `npx -p playwright node scripts/render-icons.mjs`.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const dir = new URL('../public/icons/', import.meta.url);
const jobs = [
  { src: 'icon-16.svg', size: 16 },
  { src: 'icon.svg', size: 32 },
  { src: 'icon.svg', size: 48 },
  { src: 'icon.svg', size: 128 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { src, size } of jobs) {
  const svg = readFileSync(new URL(src, dir), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: new URL(`icon-${size}.png`, dir).pathname, omitBackground: true });
  console.log(`icon-${size}.png`);
}
await browser.close();
