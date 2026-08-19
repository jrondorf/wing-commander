#!/usr/bin/env node
/**
 * Playtest harness — drives the game the way a *player* does.
 *
 * `shoot.mjs` composes a scene and photographs it. That is the right tool for
 * judging art, and it is why the art is good; it is also why a set of pure
 * playability bugs sat in this build untouched. Every capture scenario builds
 * its own subject, points a camera at it, and never presses a key, so none of
 * them could ever have noticed that:
 *
 *   - the player spawned at zero throttle and never moved;
 *   - only the single locked target had any HUD symbology, so every other
 *     contact was a handful of dark pixels on a dark nebula;
 *   - tracers advanced 25–50 m per frame against a 12–26 m bolt, so a burst
 *     rendered as isolated dots and the guns looked inert;
 *   - the radar globe was scaled to the hull's 24 km detection range, which put
 *     an entire dogfight inside its boresight cross;
 *   - nothing anywhere in flight told the pilot where they were.
 *
 * This boots the real thing at `/`, plays through the menu and briefing with
 * Enter, then reports what the pilot can actually see: contact count, lock
 * state, live projectiles, nav publication, and whether the tactical plot opens.
 * It writes a cockpit frame and a plot frame next to the numbers.
 *
 *   node tools/playtest.mjs                    # full flow, m1 via the menu
 *   node tools/playtest.mjs --engage           # also spawn the mission's
 *                                              # hostiles and open fire
 *   node tools/playtest.mjs --w 1600 --h 900
 *
 * Under SwiftShader a rendered frame costs seconds, so once in flight the sim is
 * stepped deterministically at 1/60 rather than driven by wall-clock key holds —
 * held keys at 0.3 fps test the harness, not the game. Exits non-zero if the
 * page threw or the player never reached the cockpit.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'captures/playtest');
const CHROME = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.PLAYTEST_PORT || 5223);

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const W = Number(flag('w', 900));
const H = Number(flag('h', 506));
const engage = has('engage');

mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ dev server
const server = spawn(
  process.execPath,
  [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } },
);
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer(url, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok || r.status === 404) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`dev server never came up\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 350));
  }
}

const logs = [];
let browser;
let failed = false;

try {
  console.log(`[playtest] starting vite on :${PORT}`);
  await waitForServer(`http://127.0.0.1:${PORT}/`);

  browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(300_000);
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => { failed = true; logs.push(`[pageerror] ${e.message}\n${e.stack}`); });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  // `window.__GAME__` is published before init finishes; wait for the *last*
  // subsystem instead, or half the systems are still unregistered.
  await page.waitForFunction(() => window.__GAME__?.modules?.mission, null, { timeout: 300_000 });
  await page.waitForTimeout(1500);

  // ---- menu -> briefing -> cockpit, on Enter, like a player -----------------
  for (let i = 0; i < 8; i++) {
    if (await page.evaluate(() => !!window.__GAME__?.player)) break;
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
  }

  const launch = await page.evaluate(() => {
    const g = window.__GAME__;
    return {
      reachedCockpit: !!g.player,
      missing: g.missing,
      broken: g.broken,
      throttle: g.player?.body?.controls?.throttle ?? null,
      speed: +(g.player?.body?.speed ?? -1).toFixed(1),
      missionState: g.mission?.state ?? null,
    };
  });
  console.log('[playtest] launch  ', JSON.stringify(launch));
  if (!launch.reachedCockpit) throw new Error('player never reached the cockpit');
  if (launch.broken?.length) failed = true;
  // The whole point of the launch-throttle fix: a standing start is a bug.
  if (!(launch.speed > 1)) { failed = true; console.error('[playtest] FAIL: player is not moving'); }

  const report = await page.evaluate((doEngage) => {
    const g = window.__GAME__;
    const e = g.engine;
    e.stop();
    e.deterministic = true;
    e.fixedDt = 1 / 60;
    e.renderEnabled = false;

    if (doEngage) {
      // Bring on the mission's own hostiles rather than inventing any, then put
      // the first one in front so the cockpit frame shows a real engagement.
      g.mission.fireTrigger('nav2');
      for (let i = 0; i < 30; i++) e.step();
      const p = g.player;
      const foe = g.ships.find((s) => s !== p && s.faction !== 'confed' && s.alive !== false);
      if (foe) {
        const fwd = new (p.group.position.constructor)(0, 0, -1).applyQuaternion(p.group.quaternion);
        foe.group.position.copy(p.group.position).addScaledVector(fwd, 900);
        foe.group.position.y += 60;
        foe.body?.position?.copy?.(foe.group.position);
        g.combat?.setTarget?.(p, foe);
      }
      g.combat?.setPlayerFiring?.(true);
      for (let i = 0; i < 70; i++) { e.input.injectPress('fire'); e.step(); }
    } else {
      for (let i = 0; i < 60; i++) e.step();
    }
    e.renderEnabled = true;
    for (let i = 0; i < 6; i++) { if (doEngage) e.input.injectPress('fire'); e.step(); }

    const st = e.getSystem('cockpit')?.state ?? null;
    return {
      ships: g.ships.length,
      hostilesAlive: g.ships.filter((s) => s.faction !== 'confed' && s.alive !== false).length,
      contacts: st?.contacts?.length ?? null,
      contactList: (st?.contacts ?? []).map((c) => ({ m: Math.round(c.distance), hostile: c.hostile, target: c.isTarget, name: c.name })),
      target: st?.target ? { name: st.target.name, m: Math.round(st.target.distance) } : null,
      liveBolts: e.scene.getObjectByName('combat:bolts')?.count ?? null,
      boltStats: g.combat?.pool?.stats ?? null,
      nav: st?.nav ? { name: st.nav.name, m: Math.round(st.nav.distance), steerable: !!st.nav.position } : null,
    };
  }, engage);
  console.log('[playtest] cockpit ', JSON.stringify(report, null, 2));

  await page.screenshot({ path: resolve(OUT, 'cockpit.png'), timeout: 280_000 });

  // ---- tactical plot --------------------------------------------------------
  await page.keyboard.press('v');
  await page.evaluate(() => { const e = window.__GAME__.engine; for (let i = 0; i < 3; i++) e.step(); });
  const plot = await page.evaluate(() => {
    const n = document.querySelector('.wc-tacmap');
    if (!n) return { present: false };
    const r = n.getBoundingClientRect();
    return { present: true, open: getComputedStyle(n).display !== 'none', w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('[playtest] plot    ', JSON.stringify(plot));
  if (!plot.present || !plot.open || plot.w < 40) { failed = true; console.error('[playtest] FAIL: tactical plot did not open'); }
  await page.screenshot({ path: resolve(OUT, 'tacmap.png'), timeout: 280_000 });

  // ---- assertions the pilot's complaints map onto ---------------------------
  const problems = [];
  if (engage) {
    if (!(report.hostilesAlive > 0)) problems.push('no hostiles spawned');
    if (!(report.contacts > 0)) problems.push('no contacts resolved for the HUD/radar');
    if (!report.target) problems.push('no target locked');
    if (!(report.liveBolts > 0)) problems.push('guns produced no projectiles');
  }
  if (!report.nav?.steerable) problems.push('nav point has no world position — HUD cannot draw a waypoint');

  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify({ launch, report, plot, problems }, null, 2));
  writeFileSync(resolve(OUT, 'console.log'), logs.join('\n'));

  if (problems.length) {
    failed = true;
    console.error(`[playtest] ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  } else {
    console.log('[playtest] ok → captures/playtest/');
  }
} catch (err) {
  failed = true;
  console.error('[playtest] harness failed:', err.message);
  console.error(logs.filter((l) => !/GL Driver/.test(l)).join('\n'));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

process.exit(failed ? 1 : 0);
