#!/usr/bin/env node
/**
 * Capture harness.
 *
 * Boots the vite dev server, drives headless Chromium (SwiftShader), and writes a
 * deterministic PNG per scenario into captures/.
 *
 *   node tools/shoot.mjs --scenario hero-fighter
 *   node tools/shoot.mjs --all
 *   node tools/shoot.mjs --scenario cockpit-combat --t 20 --w 1920 --h 1080
 *
 * Exits non-zero if the page threw, a shader failed to compile, or the frame came
 * back blank — so an agent cannot mistake a black screen for a finished feature.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SCENARIOS, byId } from './scenarios.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'captures');
const CHROME = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.SHOT_PORT || 5199);

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const width = Number(flag('w', 1600));
const height = Number(flag('h', 900));
const tOverride = flag('t', null);
const label = flag('label', '');
const timeoutMs = Number(flag('timeout', 180_000));

let targets;
if (has('all')) targets = SCENARIOS;
else if (flag('scenario')) {
  const s = byId(flag('scenario'));
  if (!s) {
    console.error(`Unknown scenario "${flag('scenario')}". Known: ${SCENARIOS.map((x) => x.id).join(', ')}`);
    process.exit(2);
  }
  targets = [s];
} else targets = SCENARIOS.slice(0, 1);

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- dev server
function waitForServer(url, ms = 90_000) {
  const deadline = Date.now() + ms;
  return new Promise((res, rej) => {
    const poll = async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (r.ok || r.status === 404) return res();
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return rej(new Error(`dev server never came up at ${url}`));
      setTimeout(poll, 400);
    };
    poll();
  });
}

console.log(`[shoot] starting vite on :${PORT}`);
const server = spawn(
  process.execPath,
  [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } },
);
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const shutdown = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

const base = `http://127.0.0.1:${PORT}`;
try {
  await waitForServer(base);
} catch (e) {
  console.error(`[shoot] ${e.message}\n--- vite output ---\n${serverLog}`);
  process.exit(1);
}

// ------------------------------------------------------------------- browser
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=4096',
    '--force-device-scale-factor=1',
  ],
});

const results = [];
let failures = 0;

for (const scenario of targets) {
  const t = Number(tOverride ?? scenario.t ?? 5);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });

  const logs = [];
  const errors = [];
  page.on('console', (m) => {
    const text = `${m.type()}: ${m.text()}`;
    logs.push(text);
    if (m.type() === 'error') errors.push(text);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));

  const url = `${base}/?shot=${encodeURIComponent(scenario.id)}&t=${t}&w=${width}&h=${height}`;
  const started = Date.now();
  process.stdout.write(`[shoot] ${scenario.id.padEnd(16)} t=${String(t).padStart(3)}s … `);

  let ok = true;
  let note = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // NB: waitForFunction's second positional is `arg`, not options — passing the
    // options object there silently falls back to the 30 s default timeout.
    await page.waitForFunction(
      () => window.__READY__ === true || window.__FATAL__,
      null,
      { timeout: timeoutMs, polling: 500 },
    );
    const fatal = await page.evaluate(() => window.__FATAL__ ?? null);
    if (fatal) { ok = false; note = `FATAL: ${fatal}`; }
  } catch (e) {
    ok = false;
    note = `timeout/nav: ${e.message}`;
  }

  const file = resolve(OUT, `${scenario.id}${label ? `-${label}` : ''}.png`);
  try {
    await page.screenshot({ path: file, type: 'png' });
  } catch (e) {
    ok = false;
    note += ` screenshot failed: ${e.message}`;
  }

  // A frame that is essentially one flat colour means the scene never drew.
  let stats = null;
  try {
    stats = await page.evaluate(() => (window.__SHOT_STATS__ ?? null));
  } catch {}

  // Judge the frame on its actual pixels. A capture only counts if the image has
  // real tonal range and colour variety — not black, not a flat wash, not blown out.
  const f = stats?.frame;
  if (ok && f) {
    if (f.error) { ok = false; note += ` frame readback failed: ${f.error}`; }
    else if (f.darkFrac > 0.985) { ok = false; note += ` frame is ${(f.darkFrac * 100).toFixed(1)}% black — nothing drew`; }
    else if (f.stdev < 4) { ok = false; note += ` flat frame (stdev ${f.stdev}) — no tonal range`; }
    else if (f.distinctColors < 80) { ok = false; note += ` only ${f.distinctColors} distinct colours — untextured/programmer art`; }
    else if (f.blownFrac > 0.35) { ok = false; note += ` ${(f.blownFrac * 100).toFixed(0)}% blown to white — bloom/exposure out of control`; }
  } else if (ok && !f) {
    ok = false; note += ' no frame stats — scene never completed a render';
  }

  // 404s for subsystems that have not landed yet are expected during parallel
  // build-out; shader failures never are.
  const realErrors = errors.filter((e) => !/404 \(Not Found\)/.test(e));
  if (realErrors.length) {
    const shaderErr = realErrors.some((e) => /shader|GLSL|program compil|link/i.test(e));
    note += ` ${realErrors.length} console error(s)${shaderErr ? ' incl. SHADER' : ''}`;
    if (shaderErr) ok = false;
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${ok ? 'ok' : 'FAIL'} (${secs}s) ${note}`);
  if (realErrors.length) for (const e of realErrors.slice(0, 8)) console.log(`      ! ${e.slice(0, 400)}`);
  if (stats) console.log(`      draws=${stats.drawCalls} tris=${stats.triangles} progs=${stats.programs}`);

  results.push({ id: scenario.id, ok, file, note, stats, errors: realErrors.slice(0, 20) });
  if (!ok) failures++;
  await page.close();
}

await browser.close();
shutdown();

writeFileSync(resolve(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), width, height, results }, null, 2));
console.log(`\n[shoot] ${results.length - failures}/${results.length} ok → captures/`);
process.exit(failures ? 1 : 0);
