import * as THREE from 'three';
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

  // Diagnostic switches. `?nopost=1` bypasses the post stack entirely so a black
  // frame can be attributed to the scene or to the pipeline, not guessed at.
  if (params.has('nopost')) {
    game.engine.post?.dispose?.();
    game.engine.post = null;
    console.log('[diag] post-processing bypassed');
  }
  const dumpDiag = () => {
    const e = game.engine;
    const fmt = (v) => v.toArray().map((n) => n.toFixed(1)).join(',');
    console.log('[diag] modules:', Object.keys(game.modules).join('|'), '| missing:', game.missing.join('|'));
    console.log('[diag] camera pos', fmt(e.camera.position), 'near/far', e.camera.near, e.camera.far,
      '| background:', e.scene.background?.constructor?.name ?? 'none',
      '| environment:', e.scene.environment?.constructor?.name ?? 'none');
    const walk = (obj, depth = 0, out = []) => {
      for (const c of obj.children) {
        const box = c.isMesh || c.isPoints ? '' : '';
        out.push(`${'  '.repeat(depth)}${c.type}${c.name ? `#${c.name}` : ''}` +
          `${c.isMesh ? ` mat=${c.material?.type ?? '?'} vis=${c.visible} frustumCull=${c.frustumCulled}` : ''}` +
          `${c.isLight ? ` intensity=${c.intensity} color=${c.color?.getHexString?.()}` : ''}` +
          `${c.position.lengthSq() > 0 ? ` @${fmt(c.position)}` : ''}${box}`);
        if (depth < 2) walk(c, depth + 1, out);
      }
      return out;
    };
    console.log('[diag] world graph:\n' + walk(e.scene).slice(0, 60).join('\n'));

    // Ship framing check: a hull that renders black and a hull that is 2 m long
    // look identical in a screenshot, so measure it rather than guessing.
    for (const ship of game.ships) {
      const box = new THREE.Box3().setFromObject(ship.group);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const camDist = e.camera.position.distanceTo(centre);
      const fovRad = (e.camera.fov * Math.PI) / 180;
      const frameH = 2 * camDist * Math.tan(fovRad / 2);
      let meshes = 0, lit = 0;
      ship.group.traverse((c) => {
        if (!c.isMesh) return;
        meshes++;
        const m = c.material;
        if (m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) lit++;
      });
      ship.group.traverse((c) => {
        if (!c.isMesh || !(c.material?.isMeshStandardMaterial || c.material?.isMeshPhysicalMaterial)) return;
        if (c.userData.__logged || meshes > 900) return;
        const m = c.material;
        if (!m.__diagLogged) {
          m.__diagLogged = true;
          console.log(`[diag]   mat "${m.name || c.name}": color=#${m.color.getHexString()}` +
            ` metal=${m.metalness} rough=${m.roughness} envInt=${m.envMapIntensity}` +
            ` emissive=#${m.emissive?.getHexString?.() ?? '-'}x${m.emissiveIntensity ?? 1}` +
            ` maps[${['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']
              .filter((k) => m[k]).join(',') || 'NONE'}]`);
        }
      });
      console.log(`[diag] ship ${ship.classId}: size=${size.toArray().map((n) => n.toFixed(1)).join('x')}m` +
        ` centre=${centre.toArray().map((n) => n.toFixed(1)).join(',')} camDist=${camDist.toFixed(1)}m` +
        ` framedHeight=${frameH.toFixed(1)}m → fills ~${((size.y / frameH) * 100).toFixed(0)}% of frame height;` +
        ` meshes=${meshes} pbrMeshes=${lit}`);
    }
  };

  if (shot) {
    // Must happen before setupShot: that call sets window.__READY__, and the
    // harness screenshots the moment it sees the flag.
    if (boot) boot.style.display = 'none';
    // Deterministic capture path — no rAF, no wall clock. ShotRunner frames the
    // scene, pumps fixed steps with rasterization off, then renders the money frame.
    await setupShot(game, {
      id: shot,
      seconds: Number(params.get('t') ?? 5),
      seed,
    });
    if (params.has('diag')) dumpDiag();
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
