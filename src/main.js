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
  // `?post=tonemap.exposure=3,streaks.intensity=0.15` writes dotted paths straight
  // into the post pipeline's live settings, so grading can be swept from the
  // capture harness instead of one code edit per experiment.
  if (params.has('post') && game.engine.post?.settings) {
    for (const pair of params.get('post').split(',')) {
      const [path, raw] = pair.split('=');
      if (!path || raw === undefined) continue;
      const keys = path.trim().split('.');
      let node = game.engine.post.settings;
      for (let i = 0; i < keys.length - 1; i++) node = node?.[keys[i]];
      if (!node) { console.warn(`[diag] no post setting "${path}"`); continue; }
      const value = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
      node[keys.at(-1)] = value;
      console.log(`[diag] post.${path} = ${value}`);
    }
  }

  if (params.has('nopost')) {
    game.engine.post?.dispose?.();
    game.engine.post = null;
    console.log('[diag] post-processing bypassed');
  }
  /**
   * `?flatmat=1` replaces every ship material with a neutral grey dielectric.
   * If the hull lights up, the bug is in texture/material authoring; if it stays
   * black, the bug is in the lighting or the pipeline. One capture, no guessing.
   */
  const applyFlatMaterials = () => {
    const flat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0, roughness: 0.5 });
    let swapped = 0;
    for (const ship of game.ships) {
      ship.group.traverse((c) => {
        if (c.isMesh && (c.material?.isMeshStandardMaterial || c.material?.isMeshPhysicalMaterial)) {
          c.material = flat;
          swapped++;
        }
      });
    }
    console.log(`[diag] flat material applied to ${swapped} mesh(es)`);
  };

  /**
   * `?dropmaps=map,aoMap` detaches named texture slots from every ship material,
   * bisecting which generated map is responsible for a bad-looking hull.
   * Also reports each dropped map's average colour, since a near-black albedo or
   * a black-cornered ORM map is the usual culprit and is invisible by inspection.
   */
  const dropMaps = (names) => {
    const seen = new Set();
    for (const ship of game.ships) {
      ship.group.traverse((c) => {
        const m = c.material;
        if (!c.isMesh || !(m?.isMeshStandardMaterial || m?.isMeshPhysicalMaterial)) return;
        if (seen.has(m.uuid)) return;
        seen.add(m.uuid);
        for (const slot of names) {
          const tex = m[slot];
          if (!tex) continue;
          console.log(`[diag]   dropping ${slot} from "${m.name}": ${describeTexture(tex)}`);
          m[slot] = null;
        }
        m.needsUpdate = true;
      });
    }
  };

  /** Average a texture's pixels by drawing it to a small 2D canvas. */
  const describeTexture = (tex) => {
    try {
      const src = tex.image;
      if (!src) return 'no image';
      const n = 32;
      const cv = document.createElement('canvas');
      cv.width = n; cv.height = n;
      const ctx2 = cv.getContext('2d', { willReadFrequently: true });
      if (src.data) {
        // DataTexture — sample the typed array directly.
        const { width: w, height: h, data } = src;
        let r = 0, g = 0, b = 0, count = 0;
        const stride = Math.max(1, Math.floor((w * h) / 4096));
        for (let i = 0; i < w * h; i += stride) {
          r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2]; count++;
        }
        const scale = data instanceof Uint8Array || data instanceof Uint8ClampedArray ? 1 : 255;
        return `${w}x${h} DataTexture avg rgb(${(r / count * scale).toFixed(0)},${(g / count * scale).toFixed(0)},${(b / count * scale).toFixed(0)}) cs=${tex.colorSpace}`;
      }
      ctx2.drawImage(src, 0, 0, n, n);
      const d = ctx2.getImageData(0, 0, n, n).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const px = (n * n);
      return `${src.width}x${src.height} avg rgb(${(r / px).toFixed(0)},${(g / px).toFixed(0)},${(b / px).toFixed(0)}) cs=${tex.colorSpace}`;
    } catch (err) { return `unreadable: ${err.message}`; }
  };

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
      onBeforeShot: () => {
        if (params.has('flatmat')) applyFlatMaterials();
        if (params.has('dropmaps')) dropMaps(params.get('dropmaps').split(',').map((s) => s.trim()));
        if (params.has('diag')) dumpDiag();
      },
    });
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
