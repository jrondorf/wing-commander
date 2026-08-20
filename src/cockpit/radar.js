/**
 * Tactical radar globe.
 *
 * Prophecy's sphere was a genuinely good piece of interface design: a contact's
 * *direction* is read straight off the surface of a ball whose axes are the
 * ship's own, and its *range* off how far in from the shell it sits. This is a
 * real 3D globe standing proud of the panel — not a picture of one — so it
 * parallaxes against the dashboard as the pilot's head moves, which is most of
 * why the original read as a physical instrument.
 *
 * Contacts arrive already in ship-local space from `state.js`, and the globe is
 * mounted un-rotated relative to the cockpit, so the mapping is the identity:
 * a bandit dead ahead sits on the far pole, one on your six on the near pole.
 */

import * as THREE from 'three';
import { RADAR } from './layout.js';
import { panelPoint } from './geometry.js';

const MAX_BLIPS = 28;

/**
 * How deep the glass is scaled, in metres. Not a sensor range — see `update`.
 *
 * The old code scaled the ball to the hull's `radarRange`, 24 km on a Vampire and
 * 120 km on a carrier, which is why the instrument read as empty. A dogfight
 * lives between 200 m and 3 km; against a 24 km shell that whole fight collapsed
 * into the innermost fifth of the globe, which is also where the boresight cross
 * was drawn — contacts and furniture were competing for the same pixels. 8 km is
 * about a fighter's useful tactical picture and puts a knife fight out where it
 * can be read.
 */
const DEFAULT_SCOPE = 8000;
/** Radius the innermost contact sits at, as a fraction of the globe. */
const INNER = 0.20;
/** Radius the contact at full scope range sits at. */
const OUTER = 0.94;
/** Compression exponent: <1 pushes near contacts outward. */
const CURVE = 0.55;

const SHELL_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SHELL_FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, 2.6);
  gl_FragColor = vec4(uColor * (rim * uIntensity + 0.018), 1.0);
}`;

function ringPoints(r, axis, n = 64, offset = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    for (const a of [a0, a1]) {
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      if (axis === 'y') pts.push(c, offset, s);
      else if (axis === 'x') pts.push(offset, c, s);
      else pts.push(c, s, offset);
    }
  }
  return pts;
}

export function createRadarGlobe(engine, { color = '#7fe4ff' } = {}) {
  const group = new THREE.Group();
  group.name = 'radar-globe';
  group.position.copy(panelPoint(RADAR.x, RADAR.y, RADAR.globeRelief));

  const R = RADAR.globe;
  const base = new THREE.Color(color);

  // ---- glass shell --------------------------------------------------------
  const shellGeo = new THREE.SphereGeometry(R, 28, 20);
  const shellMat = new THREE.ShaderMaterial({
    name: 'radar-shell',
    uniforms: {
      uColor: { value: base.clone() },
      uIntensity: { value: 0.20 },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const shell = new THREE.Mesh(shellGeo, shellMat);
  group.add(shell);

  // ---- graticule ----------------------------------------------------------
  const wire = [];
  // Latitude rings.
  for (const lat of [-0.62, -0.32, 0.32, 0.62]) {
    const y = Math.sin(lat) * R;
    const rr = Math.cos(lat) * R;
    wire.push(...ringPoints(rr, 'y', 40, y));
  }
  // Meridians, tilted around the vertical so the ball reads as a ball.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI;
    const pts = ringPoints(R, 'x', 40, 0);
    for (let k = 0; k < pts.length; k += 3) {
      const x = pts[k];
      const z = pts[k + 2];
      wire.push(x * Math.cos(a) - z * Math.sin(a), pts[k + 1], x * Math.sin(a) + z * Math.cos(a));
    }
  }
  const wireGeo = new THREE.BufferGeometry();
  wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
  // The graticule is a *ruler*, not a subject. At 0.34 x 0.85 it was brighter
  // than the contacts it exists to measure, and the ball read as a solid glowing
  // sphere with nothing on it. Everything structural here is deliberately held
  // well under the blips.
  const wireMat = new THREE.LineBasicMaterial({
    color: base.clone().multiplyScalar(0.16), transparent: true, opacity: 0.55,
    depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
  });
  group.add(new THREE.LineSegments(wireGeo, wireMat));

  // Equator, brighter — it is the reference plane every stalk is measured from.
  const eqGeo = new THREE.BufferGeometry();
  eqGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringPoints(R * 1.002, 'y', 72, 0), 3));
  const eqMat = new THREE.LineBasicMaterial({
    color: base.clone().multiplyScalar(0.62), transparent: true, opacity: 0.8,
    depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
  });
  group.add(new THREE.LineSegments(eqGeo, eqMat));

  // Boresight: a short spine out of the front pole so "ahead" is unambiguous.
  // The centre cross used to reach R*0.16 — further out than the closest contact
  // could ever plot — so a bandit at knife range was drawn inside the crosshair
  // and disappeared into it. It is now well inside INNER.
  const spineGeo = new THREE.BufferGeometry();
  spineGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, -R * 0.70, 0, 0, -R * 1.22,
    -R * 0.10, 0, -R * 1.05, 0, 0, -R * 1.22,
    R * 0.10, 0, -R * 1.05, 0, 0, -R * 1.22,
    -R * 0.07, 0, 0, R * 0.07, 0, 0,
    0, -R * 0.07, 0, 0, R * 0.07, 0,
  ], 3));
  group.add(new THREE.LineSegments(spineGeo, new THREE.LineBasicMaterial({
    color: base.clone().multiplyScalar(0.9), transparent: true, opacity: 1,
    depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
  })));

  // ---- contacts -----------------------------------------------------------
  const blipGeo = new THREE.OctahedronGeometry(R * 0.125, 0);
  const blipMat = new THREE.MeshBasicMaterial({
    toneMapped: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const blips = new THREE.InstancedMesh(blipGeo, blipMat, MAX_BLIPS);
  blips.frustumCulled = false;
  blips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  blips.count = 0;
  group.add(blips);

  // Altitude stalks down to the equatorial plane — the depth cue that makes a
  // 2D projection of a sphere readable at a glance.
  const stalkPos = new Float32Array(MAX_BLIPS * 6);
  const stalkCol = new Float32Array(MAX_BLIPS * 6);
  const stalkGeo = new THREE.BufferGeometry();
  stalkGeo.setAttribute('position', new THREE.BufferAttribute(stalkPos, 3).setUsage(THREE.DynamicDrawUsage));
  stalkGeo.setAttribute('color', new THREE.BufferAttribute(stalkCol, 3).setUsage(THREE.DynamicDrawUsage));
  stalkGeo.setDrawRange(0, 0);
  const stalks = new THREE.LineSegments(stalkGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false,
    toneMapped: false, blending: THREE.AdditiveBlending,
  }));
  stalks.frustumCulled = false;
  group.add(stalks);

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _c = new THREE.Color();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  let time = 0;

  // Held near 2.0, not 4.8. Blips are additive and then go through bloom and the
  // ACES curve; at the old values every contact clipped to the same white smear
  // and friend, foe and target were indistinguishable on the glass. These sit
  // above the graticule but below the shoulder, so the hue survives.
  const HOSTILE = new THREE.Color(2.1, 0.30, 0.20);
  const FRIEND = new THREE.Color(0.24, 1.75, 0.62);
  const TARGET = new THREE.Color(2.3, 1.55, 0.30);
  const NEUTRAL = new THREE.Color(0.75, 1.35, 1.9);

  function update(dt, st) {
    time += dt;
    const contacts = st?.contacts ?? [];
    // Two different ranges, which the old code conflated into one. `detect` is how
    // far the sensors reach — a ship's stat, up to 120 km on a carrier. `scope` is
    // how deep the *glass* is scaled, and it has to stay short or a dogfight is a
    // dot. Anything between the two pins just inside the shell, dimmed: "out
    // there somewhere" is still information, and it costs the fight no space.
    const detect = Math.max(2000, st?.player?.stats?.radarRange ?? DEFAULT_SCOPE);
    const scope = DEFAULT_SCOPE;
    let n = 0;
    for (let i = 0; i < contacts.length && n < MAX_BLIPS; i++) {
      const c = contacts[i];
      if (c.alive === false) continue;
      if (c.distance > detect) continue;            // outside the sensor envelope
      const beyond = c.distance > scope;
      // Compressed radial scale. A contact never plots inside INNER, which keeps
      // the whole close-in fight clear of the boresight cross at the centre.
      const f = Math.pow(Math.min(1, c.distance / scope), CURVE);
      _p.copy(c.dir).multiplyScalar(R * (INNER + f * (OUTER - INNER)));
      const pulse = c.isTarget ? 1.45 + Math.sin(time * 9) * 0.4 : 1;
      // Hostiles read a little larger than friendlies: on a 130 px instrument
      // colour alone is not enough separation, so size carries the same message
      // a second time.
      const cls = c.capital ? 1.9 : c.hostile ? 1.18 : 0.92;
      const size = cls * pulse;
      _q.identity();
      _s.set(size, size, size);
      _m.compose(_p, _q, _s);
      blips.setMatrixAt(n, _m);
      _c.copy(c.isTarget ? TARGET : c.hostile ? HOSTILE : c.faction === 'neutral' ? NEUTRAL : FRIEND);
      if (beyond) _c.multiplyScalar(0.45);
      blips.setColorAt(n, _c);

      const o = n * 6;
      stalkPos[o] = _p.x; stalkPos[o + 1] = 0; stalkPos[o + 2] = _p.z;
      stalkPos[o + 3] = _p.x; stalkPos[o + 4] = _p.y; stalkPos[o + 5] = _p.z;
      for (let k = 0; k < 2; k++) {
        stalkCol[o + k * 3] = _c.r * 0.45;
        stalkCol[o + k * 3 + 1] = _c.g * 0.45;
        stalkCol[o + k * 3 + 2] = _c.b * 0.45;
      }
      n++;
    }
    blips.count = n;
    blips.instanceMatrix.needsUpdate = true;
    if (blips.instanceColor) blips.instanceColor.needsUpdate = true;
    stalkGeo.setDrawRange(0, n * 2);
    stalkGeo.getAttribute('position').needsUpdate = true;
    stalkGeo.getAttribute('color').needsUpdate = true;

    // The shell breathes very slightly with the sweep, so the instrument is
    // never a still image.
    shellMat.uniforms.uIntensity.value = 0.18 + Math.sin(time * 1.7) * 0.035;
  }

  function dispose() {
    group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material && o.material !== blipMat) o.material.dispose?.();
    });
    blipMat.dispose();
  }

  void engine;
  return { object3D: group, update, dispose, maxBlips: MAX_BLIPS };
}
