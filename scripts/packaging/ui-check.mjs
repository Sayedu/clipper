// Clicks through the dashboard's Post kits page in headless Chrome: ticks one
// render, presses "Make post kits", waits for the kit card, then checks the
// cover image and every download link.
//
//   node scripts/packaging/ui-check.mjs [source id] [--base http://localhost:3100]
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:3100';
const source = args.find((a) => !a.startsWith('--') && !a.startsWith('http')) ?? null;
const out = (msg) => console.log(msg);

const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let ok = true;
try {
  await page.goto(`${base}/postkits`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForSelector('input[type=checkbox]', { timeout: 60000 });
  const before = await page.locator('section:last-of-type li').count();
  const label = source ? page.locator('label', { hasText: source }) : page.locator('label').filter({ hasNot: page.getByText('has a kit') }).first();
  const picked = (await label.innerText()).replace(/\s+/g, ' ');
  await label.locator('input').check();
  out(`picked: ${picked}`);
  await page.getByRole('button', { name: /Make post kits \(1\)/ }).click();
  await page.getByText(/Packaging 1 of 1/).waitFor({ timeout: 30000 });
  out('task started (progress banner shown)');
  await page.getByText(/Packaging 1 of 1/).waitFor({ state: 'detached', timeout: 600000 });
  await page.waitForTimeout(1500);
  const after = await page.locator('section:last-of-type li').count();
  out(`kit cards: ${before} -> ${after}`);
  if (after !== before + 1) { ok = false; out('FAIL: no new kit card'); }
  const card = page.locator('section:last-of-type li').first();
  const img = card.locator('img');
  const nat = await img.evaluate((el) => el.naturalWidth);
  out(`cover image naturalWidth ${nat}`);
  if (!nat) ok = false;
  for (const name of ['Video', 'SFX only', 'Cover', 'caption.txt', 'pinned_comment.txt']) {
    const href = await card.getByRole('link', { name, exact: true }).getAttribute('href');
    const res = await page.request.get(`${base}${href}`);
    out(`${name}: ${res.status()} ${res.headers()['content-type']} ${(await res.body()).length} bytes`);
    if (res.status() !== 200) ok = false;
  }
  out(`caption on card: ${(await card.locator('p.whitespace-pre-line').innerText()).replace(/\n/g, ' / ')}`);
  await page.screenshot({ path: 'post-kits/_verify/ui-postkits.png', fullPage: false });
} catch (err) {
  ok = false;
  out(`FAIL: ${err.message}`);
} finally {
  if (errors.length) { ok = false; out(`page errors: ${errors.join('; ')}`); }
  await browser.close();
}
out(ok ? 'UI CHECK PASS' : 'UI CHECK FAIL');
process.exit(ok ? 0 : 1);
