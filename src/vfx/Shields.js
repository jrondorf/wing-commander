/**
 * Shield bubbles.
 *
 * A shield is only visible where energy is being dumped into it. The mesh is a
 * unit sphere scaled into an **ellipsoid fitted to the ship's own bounds**, so a
 * carrier's bubble is a long capsule and a fighter's is nearly round — a shared
 * sphere radius makes every ship look like it is inside the same beach ball.
 *
 * The hex lattice is triplanar, because a spherical-uv hex grid pinches to
 * nothing at the poles. Each impact launches a travelling wave packet measured
 * in **great-circle angle from the impact point**, which is what the
 * `shield:impact` payload's `point`/`normal` actually describe: the ripple runs
 * across the surface of the bubble, it is not a global pulse.
 *
 * Up to four concurrent hits per ship, four shield instances live at once. Each
 * needs its own uniform block, so each is its own draw call — but they exist
 * only while a ripple is running, which is a fraction of a second per hit.
 */

import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SOFT_DEPTH, SHIELD_VERT, SHIELD_FRAG } from './glsl.js';

const HITS = 4;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

const FACTION_TINT = {
  confed: { color: [0.16, 0.55, 1.0], hot: [0.75, 0.95, 1.0] },
  nephilim: { color: [0.45, 0.95, 0.28], hot: [0.9, 1.0, 0.6] },
  kilrathi: { color: [0.95, 0.55, 0.15], hot: [1.0, 0.92, 0.6] },
};

export function createShieldSystem(engine, { capacity = 4 } = {}) {
  const geo = new THREE.IcosahedronGeometry(1, 3);
  const group = new THREE.Group();
  group.name = 'vfx:shields';
  group.matrixAutoUpdate = false;
  group.userData.noVelocity = true;

  const slots = [];
  for (let i = 0; i < capacity; i++) {
    const uniforms = {
      uHitDir: { value: [] },
      uHitParam: { value: [] },
      uColor: { value: new THREE.Color(0.16, 0.55, 1.0) },
      uHotColor: { value: new THREE.Color(0.8, 0.95, 1.0) },
      uIntensity: { value: 4.5 },
      uAmbientGlow: { value: 0.035 },
      uCell: { value: 9 },
      uTime: { value: 0 },
      uSoft: { value: 2.5 },
      tSceneDepth: { value: null },
      uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uCameraFar: { value: 8e6 },
      uCameraNear: { value: 1 },
      uHasDepth: { value: 0 },
    };
    for (let h = 0; h < HITS; h++) {
      uniforms.uHitDir.value.push(new THREE.Vector4(0, 1, 0, 0));
      uniforms.uHitParam.value.push(new THREE.Vector4(0, 0, 0, 0));
    }
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: GLSL_COMMON + SHIELD_VERT,
      fragmentShader: GLSL_COMMON + GLSL_SOFT_DEPTH + SHIELD_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `vfx:shield:${i}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    mesh.visible = false;
    mesh.userData.noVelocity = true;
    group.add(mesh);
    slots.push({
      mesh, uniforms, ship: null,
      half: new THREE.Vector3(1, 1, 1),
      centre: new THREE.Vector3(),
      hits: [0, 0, 0, 0].map(() => ({ life: 0, age: 0 })),
      lastUse: -1e9,
    });
  }

  function fitTo(slot, ship) {
    const ud = ship?.group?.userData ?? {};
    const bounds = ud.bounds;
    const r = ud.radius ?? ship?.body?.boundsRadius ?? 12;
    if (bounds?.isBox3 && !bounds.isEmpty()) {
      bounds.getSize(_v);
      // 0.62 of the box half-extent plus a fixed standoff: shields sit just off
      // the hull, not skin-tight and not a hangar door away.
      slot.half.set(_v.x * 0.62 + 1.5, _v.y * 0.62 + 1.5, _v.z * 0.60 + 1.5);
      slot.centre.copy(ud.center ?? _v.set(0, 0, 0));
    } else {
      slot.half.setScalar(r * 1.25);
      slot.centre.set(0, 0, 0);
    }
    const tint = FACTION_TINT[ship?.faction] ?? FACTION_TINT.confed;
    slot.uniforms.uColor.value.setRGB(tint.color[0], tint.color[1], tint.color[2]);
    slot.uniforms.uHotColor.value.setRGB(tint.hot[0], tint.hot[1], tint.hot[2]);
    // Cell count scales with size so a carrier's hexes are not city-block sized.
    const span = Math.max(slot.half.x, slot.half.z);
    slot.uniforms.uCell.value = THREE.MathUtils.clamp(span * 0.55, 6, 26);
    slot.uniforms.uSoft.value = Math.max(1.5, span * 0.12);
  }

  function slotFor(ship, time) {
    for (const s of slots) if (s.ship === ship) return s;
    let best = null;
    for (const s of slots) {
      if (!s.ship) { best = s; break; }
      if (!best || s.lastUse < best.lastUse) best = s;
    }
    if (!best) return null;
    if (best.ship !== ship) {
      best.ship = ship;
      for (const h of best.hits) { h.life = 0; h.age = 0; }
      fitTo(best, ship);
    }
    best.lastUse = time;
    return best;
  }

  /**
   * @param {{ship, point?:THREE.Vector3, position?:THREE.Vector3,
   *          normal?:THREE.Vector3, strength?:number, damage?:number,
   *          fraction?:number}} p
   */
  function impact(p, time) {
    const ship = p.ship ?? p.target;
    if (!ship?.group) return;
    const slot = slotFor(ship, time);
    if (!slot) return;

    // Impact direction in the ellipsoid's own frame.
    const world = p.point ?? p.position;
    if (world) {
      _v.copy(world).sub(ship.group.position);
      _q.copy(ship.group.quaternion).invert();
      _v.applyQuaternion(_q).sub(slot.centre);
      _v.set(_v.x / slot.half.x, _v.y / slot.half.y, _v.z / slot.half.z);
    } else if (p.normal) {
      _v.copy(p.normal).negate();
    } else {
      _v.set(0, 0, 1);
    }
    if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1);
    _v.normalize();

    // Reuse the oldest slot so a burst of cannon fire keeps overwriting the
    // faded ripples rather than dropping the new ones.
    let idx = 0, oldest = -1;
    for (let i = 0; i < HITS; i++) {
      const h = slot.hits[i];
      if (h.life <= 0) { idx = i; oldest = 1e9; break; }
      const remain = h.life - h.age;
      if (oldest < 0 || remain < oldest) { oldest = remain; idx = i; }
    }

    const strength = THREE.MathUtils.clamp(
      p.strength ?? (p.damage != null ? p.damage / 40 : 0.6), 0.12, 2.4,
    );
    const h = slot.hits[idx];
    h.life = 0.55 + strength * 0.35;
    h.age = 0;
    slot.uniforms.uHitDir.value[idx].set(_v.x, _v.y, _v.z, 0);
    // speed (rad/s), falloff sharpness, life
    slot.uniforms.uHitParam.value[idx].set(strength, 5.2, 9.0, h.life);
    slot.mesh.visible = true;
  }

  function update(dt, time) {
    for (const s of slots) {
      if (!s.ship) { s.mesh.visible = false; continue; }
      let any = false;
      for (let i = 0; i < HITS; i++) {
        const h = s.hits[i];
        if (h.life <= 0) continue;
        h.age += dt;
        if (h.age >= h.life) { h.life = 0; s.uniforms.uHitParam.value[i].w = 0; continue; }
        s.uniforms.uHitDir.value[i].w = h.age;
        any = true;
      }
      s.uniforms.uTime.value = time;
      if (!any) { s.mesh.visible = false; s.ship = null; continue; }
      const g = s.ship.group;
      if (!g || s.ship.alive === false) { s.mesh.visible = false; s.ship = null; continue; }
      s.mesh.position.copy(s.centre).applyQuaternion(g.quaternion).add(g.position);
      s.mesh.quaternion.copy(g.quaternion);
      s.mesh.scale.copy(s.half);
      s.mesh.visible = true;
      s.mesh.updateMatrix();
      s.mesh.updateMatrixWorld(true);
    }
  }

  return {
    object3D: group,
    impact,
    update,
    uniformsList: slots.map((s) => s.uniforms),
    clear() { for (const s of slots) { s.ship = null; s.mesh.visible = false; for (const h of s.hits) h.life = 0; } },
    dispose() {
      group.removeFromParent();
      for (const s of slots) s.mesh.material.dispose();
      geo.dispose();
    },
  };
}
