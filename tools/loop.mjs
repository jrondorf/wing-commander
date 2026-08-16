#!/usr/bin/env node
/**
 * Critic-loop driver.
 *
 * One invocation = one iteration:
 *   1. archive the previous captures as iteration N-1
 *   2. re-capture every scenario
 *   3. build blind A/B composites of N-1 vs N so a critic can confirm the
 *      iteration actually improved the frame rather than just changed it
 *
 *   node tools/loop.mjs               # full pass
 *   node tools/loop.mjs --only hero-fighter,explosion
 *   node tools/loop.mjs --no-capture  # rebuild composites from what is on disk
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIO_IDS } from './scenarios.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CAP = join(ROOT, 'captures');
const ITER = join(CAP, 'iterations');
const CMP = join(CAP, 'compare');

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const only = flag('only') ? flag('only').split(',').map((s) => s.trim()) : SCENARIO_IDS;

mkdirSync(ITER, { recursive: true });
mkdirSync(CMP, { recursive: true });

// -------------------------------------------------------- iteration bookkeeping
const existing = readdirSync(ITER, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
  .map((d) => Number(d.name))
  .sort((a, b) => a - b);
const prevN = existing.length ? existing[existing.length - 1] : -1;
const thisN = prevN + 1;

// Snapshot whatever is currently in captures/ as the previous iteration.
const prevDir = join(ITER, String(thisN));
let archived = 0;
if (existsSync(CAP)) {
  mkdirSync(prevDir, { recursive: true });
  for (const f of readdirSync(CAP)) {
    if (f.endsWith('.png')) { copyFileSync(join(CAP, f), join(prevDir, f)); archived++; }
  }
}
console.log(`[loop] archived ${archived} frame(s) as iteration ${thisN}`);

// ------------------------------------------------------------------- recapture
if (!has('no-capture')) {
  for (const id of only) {
    const r = spawnSync(process.execPath, [join(__dirname, 'shoot.mjs'), '--scenario', id], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, SHOT_PORT: process.env.SHOT_PORT ?? '5199' },
    });
    if (r.status !== 0) console.log(`[loop] ${id} capture reported failure (see above)`);
  }
}

// -------------------------------------------------------- blind A/B composites
const built = [];
if (archived > 0) {
  for (const id of only) {
    const cur = join(CAP, `${id}.png`);
    const old = join(prevDir, `${id}.png`);
    if (!existsSync(cur) || !existsSync(old)) continue;
    const out = join(CMP, `${id}-iter${thisN}-vs-${thisN + 1}.png`);
    const r = spawnSync(process.execPath, [
      join(__dirname, 'compare.mjs'),
      '--ours', cur, '--ref', old, '--out', out, '--tag', `${id}:iter${thisN + 1}-vs-${thisN}`,
    ], { cwd: ROOT, stdio: 'inherit' });
    if (r.status === 0) built.push(out);
  }
}

const summary = {
  iteration: thisN + 1,
  previousIteration: thisN,
  scenarios: only,
  composites: built,
  when: new Date().toISOString(),
};
writeFileSync(join(CAP, 'loop-state.json'), JSON.stringify(summary, null, 2));

console.log(`\n[loop] iteration ${thisN + 1} ready`);
console.log(`[loop] current frames : captures/*.png`);
if (built.length) {
  console.log(`[loop] blind A/B      : ${built.length} composite(s) in captures/compare/`);
  console.log(`[loop] answer key     : captures/compare/ANSWER-KEY.jsonl  (do NOT show a critic)`);
}
