/**
 * Silhouette test harness — the honest judge of ship geometry.
 *
 * Renders every fighter as a pure black shape on white from three angles (side,
 * hero three-quarter, top). No texture, no lighting, no post: if two ships are
 * hard to tell apart here, or a shape is not striking here, the geometry is not
 * finished, and no amount of paint will save it.
 *
 * Served by the dev server:  /src/ships/silhouette.html
 *   ?ships=confed_vampire,alien_manta   pick classes (default: the four fighters)
 *   ?w=1800&h=340                       canvas width / row height
 *   ?grey=1                             flat grey lit shading instead of black
 *
 * Not part of the game bundle; nothing in src/ imports it.
 */
import * as THREE from 'three';
import { Registry } from '../core/Registry.js';
import { buildShip, SHIP_CLASSES } from './Ships.js';

const q = new URLSearchParams(location.search);
const IDS = (q.get('ships') || 'confed_vampire,confed_panther,confed_devastator,alien_manta').split(',');
const W = +(q.get('w') || 1760);
const ROW_H = +(q.get('h') || 330);
const GREY = q.get('grey') === '1';
const PAD = 18;

const VIEWS = [
  // dir: unit vector from the ship toward the camera. up: screen-up in world.
  { name: 'side', dir: [-1, 0.04, 0], up: [0, 1, 0] },
  { name: 'three-quarter', dir: [-0.78, 0.34, -0.95], up: [0, 1, 0] },
  { name: 'top', dir: [0, 1, 0.001], up: [0, 0, -1] },
];

const canvas = document.getElementById('sil');
const wrap = document.getElementById('wrap');
const H = ROW_H * IDS.length;
canvas.width = W; canvas.height = H;
canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
wrap.style.width = `${W}px`; wrap.style.height = `${H}px`;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.setClearColor(0xffffff, 1);
renderer.autoClear = false;
renderer.shadowMap.enabled = false;

// A minimal engine surface — exactly what materials.js and Ships.js touch.
const engine = {
  renderer,
  registry: new Registry(),
  scene: new THREE.Scene(),
  maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
};

const scene = new THREE.Scene();
const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
const grey = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });
scene.overrideMaterial = GREY ? grey : black;
if (GREY) {
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(-0.6, 1.0, -0.8);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.45));
}

function label(text, x, y, cls) {
  const d = document.createElement('div');
  d.className = `lbl ${cls}`;
  d.textContent = text;
  d.style.left = `${x}px`;
  d.style.top = `${y}px`;
  wrap.appendChild(d);
}

/** Frame an orthographic camera onto a Box3 from a given direction. */
function frame(cam, box, dir, up, aspect) {
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() * 0.5;
  const d = new THREE.Vector3(...dir).normalize();
  cam.position.copy(c).addScaledVector(d, r * 4 + 10);
  cam.up.set(...up);
  cam.lookAt(c);
  cam.updateMatrixWorld();
  // Project the eight corners into camera space to get a tight fit.
  const inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    v.applyMatrix4(inv);
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  const m = 1.06;
  let hw = ((maxX - minX) * 0.5) * m, hh = ((maxY - minY) * 0.5) * m;
  if (hw / hh < aspect) hw = hh * aspect; else hh = hw / aspect;
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5;
  cam.left = cx - hw; cam.right = cx + hw;
  cam.bottom = cy - hh; cam.top = cy + hh;
  cam.near = 0.1; cam.far = r * 10 + 40;
  cam.updateProjectionMatrix();
}

const report = [];
renderer.clear();

for (let row = 0; row < IDS.length; row++) {
  const id = IDS[row];
  const group = buildShip(engine, id, { seed: 1 });
  const lod0 = group.userData.lods[0].object;
  scene.add(lod0);

  const box = new THREE.Box3().setFromObject(lod0);
  const size = box.getSize(new THREE.Vector3());
  report.push({
    id,
    name: SHIP_CLASSES[id]?.name ?? id,
    dims: [size.x, size.y, size.z].map((n) => +n.toFixed(1)),
    tris: group.userData.lods.map((l) => l.tris),
    draws: group.userData.draws,
    hardpoints: {
      guns: group.userData.hardpoints.guns.length,
      missiles: group.userData.hardpoints.missiles.length,
      engines: group.userData.hardpoints.engines.length,
      thrusters: group.userData.hardpoints.thrusters.length,
      turrets: group.userData.hardpoints.turrets.length,
      cockpit: group.userData.hardpoints.cockpit
        ? group.userData.hardpoints.cockpit.pos.toArray().map((n) => +n.toFixed(2)) : null,
    },
    radius: +group.userData.radius.toFixed(1),
  });

  const cellW = Math.floor((W - PAD * 2) / VIEWS.length);
  const cellH = ROW_H - PAD;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

  for (let col = 0; col < VIEWS.length; col++) {
    const x = PAD + col * cellW;
    const yTop = row * ROW_H + PAD * 0.6;
    const y = H - (yTop + cellH); // GL origin is bottom-left
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, cellW, cellH);
    renderer.setScissor(x, y, cellW, cellH);
    frame(cam, box, VIEWS[col].dir, VIEWS[col].up, cellW / cellH);
    renderer.render(scene, cam);
    if (row === 0) label(VIEWS[col].name, x + 6, 2, 'dim');
  }
  renderer.setScissorTest(false);

  label(report[row].name, PAD + 6, row * ROW_H + PAD * 0.6 + 14, 'name');
  label(`${report[row].dims.join(' x ')} m   ${report[row].tris[0]} tris / ${report[row].draws} draws`,
    PAD + 6, row * ROW_H + PAD * 0.6 + 34, 'dim');

  scene.remove(lod0);
}

window.__SIL__ = report;
window.__SHOT_STATS__ = report;
console.log('[sil] ' + JSON.stringify(report));
window.__READY__ = true;
