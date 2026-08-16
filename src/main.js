import { Game } from './Game.js';
import { setupShot } from './shot/ShotRunner.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('viewport');
const boot = document.getElementById('boot');

const shot = params.get('shot');
const seed = Number(params.get('seed') ?? 1337);

async function main() {
  const game = new Game({ canvas, seed });
  window.__GAME__ = game;

  await game.loadShips();
  await game.init();

  if (shot) {
    // Deterministic capture path — no rAF, no wall clock. ShotRunner frames the
    // scene, pumps fixed steps with rasterization off, then renders the money frame.
    await setupShot(game, {
      id: shot,
      seconds: Number(params.get('t') ?? 5),
      seed,
    });
    boot?.classList.add('hidden');
    return;
  }

  boot?.classList.add('hidden');
  await game.modules.ui?.showMainMenu?.();
  game.start();
}

main().catch((err) => {
  console.error('[fatal]', err);
  window.__FATAL__ = `${err?.message ?? err}\n${err?.stack ?? ''}`;
  window.__READY__ = true; // let the harness capture the failure state rather than hang
  if (boot) {
    boot.textContent = 'FLIGHT SYSTEM FAILURE';
    boot.style.color = '#ff6b5c';
  }
});
