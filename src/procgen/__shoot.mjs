#!/usr/bin/env node
/**
 * Private capture harness for the procgen preview page.
 *
 * `tools/shoot.mjs` drives whole game scenarios; this drives just the texture
 * stack, so this agent can iterate on hull detail without waiting on ships/,
 * world/ or the post pipeline to land.
 *
 *   node src/procgen/__shoot.mjs --style confed --size 2048 --seed 7
 *   node src/procgen/__shoot.mjs --all
 *
 * Output: captures/procgen-<style>.png
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const OUT = resolve(ROOT, 'captures');
const CHROME = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.SHOT_PORT || 5311);

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const styles = has('all')
  ? ['confed', 'kilrathi', 'alien', 'capital', 'civilian']
  : [flag('style', 'confed')];
const size = flag('size', '2048');
const seed = flag('seed', '7');
const wear = flag('wear', '0.55');
const shape = flag('shape', 'panel');
const panelScale = flag('panelScale', '1');
const width = Number(flag('w', 1720));
const height = Number(flag('h', 1000));

mkdirSync(OUT, { recursive: true });

const server = spawn(
  process.execPath,
  [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } },
);
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const shutdown = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

const base = `http://127.0.0.1:${PORT}`;
const deadline = Date.now() + 60000;
for (;;) {
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(2500) });
    if (r.ok || r.status === 404) break;
  } catch {}
  if (Date.now() > deadline) { console.error(`vite never came up\n${log}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=4096', '--force-device-scale-factor=1',
  ],
});

let fail = 0;
const report = [];
for (const style of styles) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));

  const url = `${base}/src/procgen/__preview.html?style=${style}&size=${size}&seed=${seed}`
    + `&wear=${wear}&shape=${shape}&panelScale=${panelScale}`;
  const t0 = Date.now();
  let ok = true, note = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__READY__ === true || window.__FATAL__, { timeout: 240000, polling: 250 });
    const fatal = await page.evaluate(() => window.__FATAL__ ?? null);
    if (fatal) { ok = false; note = `FATAL ${fatal}`; }
  } catch (e) { ok = false; note = `timeout: ${e.message}`; }

  const file = resolve(OUT, `procgen-${style}.png`);
  await page.screenshot({ path: file, type: 'png' });
  const stats = await page.evaluate(() => window.__PREVIEW_STATS__ ?? null);
  if (errors.length) { note += ` | ${errors.length} console error(s)`; ok = false; }
  console.log(`[procgen] ${style.padEnd(10)} ${ok ? 'ok ' : 'FAIL'} ${((Date.now() - t0) / 1000).toFixed(1)}s ${note}`);
  for (const e of errors.slice(0, 5)) console.log(`    ! ${e.slice(0, 500)}`);
  if (stats) {
    console.log(`    gen ${stats.genMs.toFixed(0)}ms  ${Object.entries(stats.timings).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(' ')}`);
    console.log(`    rough sd=${stats.roughness.sd.toFixed(4)} mean=${stats.roughness.mean.toFixed(3)}  metal mean=${stats.metalness.mean.toFixed(3)}  ao mean=${stats.ao.mean.toFixed(3)}`);
  }
  report.push({ style, ok, note, stats });
  if (!ok) fail++;
  await page.close();
}

await browser.close();
shutdown();
writeFileSync(resolve(OUT, 'procgen-report.json'), JSON.stringify(report, null, 2));
process.exit(fail ? 1 : 0);
