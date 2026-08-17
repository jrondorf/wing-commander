// Capture the silhouette harness. node src/ships/_silcap.mjs <out.png> [query]
import { chromium } from 'playwright';

const out = process.argv[2] || '/tmp/sil.png';
const query = process.argv[3] || '';
const url = `http://127.0.0.1:5230/src/ships/silhouette.html${query ? `?${query}` : ''}`;

const b = await chromium.launch({
  headless: true, executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 1800, height: 1400 } });
p.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 2000)));
p.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 600)));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await p.waitForFunction(() => window.__READY__ === true, null, { timeout: 300000, polling: 400 });
} catch (e) { console.log('WAIT FAILED:', e.message.slice(0, 200)); }
await p.screenshot({ path: out, fullPage: true });
await b.close();
console.log('wrote', out);
