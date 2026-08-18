#!/usr/bin/env node
/**
 * Node runner for the audio self-test.
 *
 * Web Audio does not exist in Node, so the render happens where it will actually
 * run: inside Chromium, through OfflineAudioContext. This boots vite, opens
 * `src/audio/__selftest.html`, waits for the report and prints it.
 *
 *   node src/audio/selftest.mjs
 *   AUDIO_TEST_PORT=5311 node src/audio/selftest.mjs --verbose
 *
 * Exits non-zero if any sound is silent, clipping, NaN-poisoned or out of its
 * expected level window.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const CHROME = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.AUDIO_TEST_PORT || 5311);
const VERBOSE = process.argv.includes('--verbose');

function waitForServer(url, ms = 60_000) {
  const deadline = Date.now() + ms;
  return new Promise((res, rej) => {
    const poll = async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (r.ok || r.status === 404) return res();
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return rej(new Error(`dev server never came up at ${url}`));
      setTimeout(poll, 300);
    };
    poll();
  });
}

console.log(`[audio-test] starting vite on :${PORT}`);
const server = spawn(
  process.execPath,
  [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } },
);
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const shutdown = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } };
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

const base = `http://127.0.0.1:${PORT}`;
try {
  await waitForServer(base);
} catch (e) {
  console.error(`[audio-test] ${e.message}\n--- vite output ---\n${serverLog}`);
  process.exit(1);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (VERBOSE) console.log(`  [page] ${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));

let report = null;
try {
  await page.goto(`${base}/src/audio/__selftest.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__AUDIO_TEST__ != null, { timeout: 240_000, polling: 250 });
  report = await page.evaluate(() => window.__AUDIO_TEST__);
} catch (e) {
  console.error(`[audio-test] ${e.message}`);
}

await browser.close();
shutdown();

if (!report) {
  console.error('[audio-test] no report produced');
  for (const e of errors) console.error(e);
  process.exit(1);
}
if (report.error) {
  console.error(`[audio-test] harness error: ${report.error}`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('sound', 26)}${pad('peak', 9)}${pad('rms', 10)}${pad('dc', 10)}clip`);
console.log('-'.repeat(64));
for (const r of report.results) {
  const flag = r.ok ? ' ' : '!';
  console.log(`${flag}${pad(r.name, 25)}${pad(r.peak ?? '-', 9)}${pad(r.rms ?? '-', 10)}${pad(r.dc ?? '-', 10)}${r.clipped ?? '-'}`);
  if (!r.ok) for (const e of r.errors ?? []) console.log(`   -> ${e}`);
}
console.log('-'.repeat(64));
console.log(`[audio-test] ${report.passed}/${report.total} passed in ${report.ms} ms`);
for (const e of errors) console.error(`[audio-test] page error: ${e}`);
process.exit(report.ok && errors.length === 0 ? 0 : 1);
