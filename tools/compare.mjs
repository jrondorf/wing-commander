#!/usr/bin/env node
/**
 * Blind A/B composite builder for the critic loop.
 *
 * Takes one of our captures and one reference frame, scales both to a common
 * height, and lays them out side by side labelled only "A" and "B" — with the
 * side assignment chosen by a coin flip that is recorded in a manifest the critic
 * never sees. The critic reads the composite, picks a winner, and only afterwards
 * does the lead decode which panel was ours.
 *
 *   node tools/compare.mjs --ours captures/hero-fighter.png \
 *                          --ref  /path/to/reference.png \
 *                          --out  /path/to/compare/hero-fighter.png \
 *                          --tag  hero-fighter
 *
 * Reference frames deliberately live outside the repository — they are third-party
 * game screenshots used transiently for evaluation and are never committed.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const oursPath = flag('ours');
const refPath = flag('ref');
const outPath = flag('out');
const tag = flag('tag', basename(oursPath ?? 'shot', '.png'));
const panelH = Number(flag('height', 900));

if (!oursPath || !refPath || !outPath) {
  console.error('usage: compare.mjs --ours <png> --ref <png> --out <png> [--tag name] [--height px]');
  process.exit(2);
}
for (const p of [oursPath, refPath]) {
  if (!existsSync(p)) { console.error(`missing input: ${p}`); process.exit(2); }
}

const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

// Unbiased coin flip — a predictable alternation would let a critic learn the pattern.
const oursIsLeft = randomBytes(1)[0] < 128;
const left = oursIsLeft ? oursPath : refPath;
const right = oursIsLeft ? refPath : oursPath;

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#101012;}
  .wrap{display:flex;gap:14px;padding:14px;align-items:flex-start;}
  .panel{position:relative;flex:0 0 auto;}
  .panel img{display:block;height:${panelH}px;width:auto;border:1px solid #2a2a30;}
  .lab{position:absolute;top:10px;left:10px;font:700 26px/1 ui-monospace,Menlo,monospace;
       color:#fff;background:rgba(0,0,0,.72);padding:7px 14px;border-radius:4px;letter-spacing:.08em;}
</style><div class="wrap">
  <div class="panel"><img src="${dataUri(left)}"><div class="lab">A</div></div>
  <div class="panel"><img src="${dataUri(right)}"><div class="lab">B</div></div>
</div>`;

const browser = await chromium.launch({
  headless: true,
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 3400, height: panelH + 40 } });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
const el = await page.$('.wrap');
mkdirSync(dirname(outPath), { recursive: true });
await el.screenshot({ path: outPath });
await browser.close();

// The answer key. Written next to the composite but never shown to the critic.
const manifestPath = resolve(dirname(outPath), 'ANSWER-KEY.jsonl');
const record = { tag, out: outPath, ours: oursIsLeft ? 'A' : 'B', reference: oursIsLeft ? 'B' : 'A', oursPath, refPath, when: new Date().toISOString() };
appendFileSync(manifestPath, JSON.stringify(record) + '\n');

console.log(`[compare] ${tag} → ${outPath}`);
console.log(`[compare] answer key appended to ${manifestPath}`);
