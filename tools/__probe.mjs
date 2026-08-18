/**
 * Throwaway cockpit-only probe (agent-cockpit). Renders engine.cockpitScene with
 * a hand-placed cockpit camera and no post stack, so geometry/UV/HUD problems can
 * be seen in ~15 s instead of a 90 s full capture. Delete before hand-off.
 */
import { chromium } from 'playwright';

const b = await chromium.launch({
  headless: true, executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('console', (m) => { const t = m.text(); if (!/404 \(Not Found\)/.test(t)) console.log(`[${m.type()}]`, t.slice(0, 400)); });
p.on('pageerror', (e) => console.log('[pageerror]', (e.stack || e.message).slice(0, 1500)));
await p.goto('http://127.0.0.1:5232/', { waitUntil: 'domcontentloaded', timeout: 60000 });

const HIDE = (process.argv[3] ?? '').split(',').filter(Boolean);
const r = await p.evaluate(async (HIDE) => {
  const THREE = await import('/src/cockpit/__three.js');
  const { Engine } = await import('/src/core/Engine.js');
  const { Events } = await import('/src/core/Events.js');
  const eng = new Engine({ canvas: document.getElementById('viewport'), pixelRatio: 1 });
  eng.events = new Events();
  eng.game = { ships: [], viewMode: 'cockpit' };
  const geo = await import('/src/cockpit/geometry.js');
  const L = await import('/src/cockpit/layout.js');
  const post = await import('/src/render/PostProcessing.js');
  eng.post = post.createPostPipeline(eng, {});
  const m = await import('/src/cockpit/CockpitSystem.js');
  const sys = m.createCockpitSystem(eng);
  // A key light in the world scene so the god-ray/exposure passes behave as they
  // do in a real shot; the cockpit brings its own.
  const sun = new THREE.DirectionalLight(0xcfe0ff, 4.2);
  sun.position.set(0.6, 0.4, -0.7).multiplyScalar(1000);
  eng.scene.add(sun);

  const cam = eng.cockpitCamera;
  cam.position.set(0, 0, 0);
  cam.quaternion.identity();
  cam.fov = 58;
  cam.aspect = 1600 / 900;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

  for (let i = 0; i < 4; i++) {
    sys.update(1 / 60, eng);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  }

  for (const n of HIDE) { const o = eng.cockpitScene.getObjectByName(n); if (o) o.visible = false; }
  const info = eng.renderer.info;
  const usePost = !HIDE.includes('post');
  for (let i = 0; i < 3; i++) {
    sys.update(1 / 60, eng);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    if (usePost) eng.post.render(1 / 60);
  }
  info.reset();
  sys.update(1 / 60, eng);
  if (usePost) {
    eng.post.render(1 / 60);
  } else {
    // Probe-only: the renderer normally never tone maps (the post stack does),
    // but for an isolated look we need the same 3.2 exposure + ACES.
    eng.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    eng.renderer.toneMappingExposure = 3.2;
    eng.renderer.setRenderTarget(null);
    eng.renderer.setClearColor(0x000000, 1);
    eng.renderer.clear(true, true, false);
    if (!HIDE.includes('flat')) eng.renderer.render(eng.cockpitScene, cam);
    else {
      eng.cockpitScene.overrideMaterial = new THREE.MeshNormalMaterial();
      eng.renderer.render(eng.cockpitScene, cam);
      eng.cockpitScene.overrideMaterial = null;
    }
  }

  // Read the backbuffer in the same task as the render — the context has no
  // preserveDrawingBuffer, so yielding first returns a cleared frame.
  const gl = eng.renderer.getContext();
  const W = gl.drawingBufferWidth;
  const Hh = gl.drawingBufferHeight;
  const px = new Uint8Array(W * Hh * 4);
  gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = Hh;
  const c2 = cv.getContext('2d');
  const img = c2.createImageData(W, Hh);
  for (let y = 0; y < Hh; y++) {
    const src = (Hh - 1 - y) * W * 4;
    img.data.set(px.subarray(src, src + W * 4), y * W * 4);
  }
  // The context is created with alpha:false; readPixels still hands back an
  // alpha channel, and on SwiftShader it comes back zero. Force it opaque or
  // the PNG is transparent and every viewer paints it white.
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  c2.putImageData(img, 0, 0);
  const dataUrl = cv.toDataURL('image/png');
  const at = (x, y) => { const d2 = c2.getImageData(x, y, 1, 1).data; return [d2[0], d2[1], d2[2]]; };
  const samples = {
    corner: at(30, 30), skyTop: at(800, 60), coaming: at(800, 520),
    panel: at(800, 690), mfdL: at(351, 742), radar: at(800, 733), console: at(150, 850),
  };

  // Landmarks, projected to screen fractions.
  const proj = (v) => {
    const q = v.clone().project(cam);
    return [+((q.x * 0.5 + 0.5) * 1600).toFixed(0), +((1 - (q.y * 0.5 + 0.5)) * 900).toFixed(0)];
  };
  const marks = {
    panelCentre: proj(geo.panelPoint(0, 0, 0)),
    panelTop: proj(geo.panelPoint(0, L.PANEL.h / 2, 0)),
    mfdLeftC: proj(geo.panelPoint(L.MFD.leftX, L.MFD.y, 0)),
    mfdLeftTop: proj(geo.panelPoint(L.MFD.leftX, L.MFD.y + L.MFD.size / 2, 0)),
    mfdRightC: proj(geo.panelPoint(L.MFD.rightX, L.MFD.y, 0)),
    radar: proj(geo.panelPoint(L.RADAR.x, L.RADAR.y, L.RADAR.globeRelief)),
    coamNear: proj(new THREE.Vector3(0, L.COAMING.nearY, L.COAMING.nearZ)),
    coamFar: proj(new THREE.Vector3(0, L.COAMING.farY, L.COAMING.farZ)),
    coamCorner: proj(new THREE.Vector3(L.COAMING.halfWidth, L.COAMING.nearY + L.COAMING.cornerRise, L.COAMING.nearZ)),
    bowApex: proj(geo.bowPoint(0)),
    bowSill: proj(geo.bowPoint(1)),
  };

  // Is the HUD canvas actually carrying ink?
  const hudMesh = eng.cockpitScene.getObjectByName('hud');
  let hudInk = -1;
  let hudSize = null;
  if (hudMesh?.material?.map?.image) {
    const c = hudMesh.material.map.image;
    hudSize = [c.width, c.height];
    const g2 = c.getContext('2d');
    const d = g2.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) lit++;
    hudInk = lit;
  }

  const boxOf = (o) => {
    const bb = new THREE.Box3().setFromObject(o);
    return bb.isEmpty() ? null : [bb.min.toArray().map((n) => +n.toFixed(2)), bb.max.toArray().map((n) => +n.toFixed(2))];
  };
  const root = eng.cockpitScene.getObjectByName('cockpit-root');
  const parts = {};
  root.traverse((o) => { if (o.isMesh || o.isLineSegments) parts[o.name || o.type] = boxOf(o); });

  return {
    dataUrl,
    draws: info.render.calls,
    tris: info.render.triangles,
    tubTris: sys.stats,
    marks, hudInk, hudSize,
    hudScale: hudMesh ? hudMesh.scale.toArray().map((n) => +n.toFixed(3)) : null,
    hudVisible: hudMesh?.visible,
    rootPos: root.position.toArray(),
    parts,
    samples,
  };
}, HIDE);
import { writeFileSync } from 'node:fs';
const url = r.dataUrl;
delete r.dataUrl;
console.log(JSON.stringify(r, null, 1));
writeFileSync(process.argv[2] ?? 'captures/__probe.png', Buffer.from(url.split(',')[1], 'base64'));
await b.close();
