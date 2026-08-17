/**
 * parts — sub-assemblies shared across the fleet.
 *
 * These are the pieces that make a hull read as a machine somebody built and
 * somebody maintains: nozzles you can see down, canopies with structural ribs and
 * a pilot inside, gun barrels that visibly attach to a mount, plated surfaces,
 * gear bays, RCS ports, turret batteries. Each function writes into a
 * ShipAssembler and, where relevant, registers the matching hardpoint.
 */
import * as THREE from 'three';
import {
  chamferedBox, plate, panelInset, nozzle, intakeDuct, tube, dome, ring, loft,
  rectProfile, ellipseProfile, scaleProfile, xform, mergeGeometries, revolve,
  mirrorX, shadeCavity, extrudeAlongPath, invertShell,
} from './geometryKit.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const Q = () => new THREE.Quaternion();

/**
 * Orientation that lays a part flat on a hull surface: local +Z becomes the
 * surface normal and local +Y follows `tangent`. The basis must be right-handed
 * (b × t = n) or the resulting quaternion is a reflection and the part lands
 * somewhere the geometry never intended.
 */
function surfaceFrame(normal, tangent) {
  const n = new THREE.Vector3(...normal).normalize();
  let t = new THREE.Vector3(...tangent).normalize();
  if (Math.abs(t.dot(n)) > 0.98) t = Math.abs(n.y) > 0.9 ? V(0, 0, -1) : V(0, 1, 0);
  const b = new THREE.Vector3().crossVectors(t, n).normalize();
  t = new THREE.Vector3().crossVectors(n, b).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(b, t, n));
}

// ------------------------------------------------------------------- engines

/**
 * Engine nozzle assembly: metal bell with a real interior, an emissive core deep
 * inside it, a mounting collar and a ring of afterburner slots. Registers the
 * engine hardpoint so vfx can hang the exhaust plume on it.
 */
export function engineNozzle(A, {
  pos, radius = 1.1, length = 1.9, glow, intensity = 16, dir = [0, 0, 1],
  collar = true, slots = 6,
}) {
  const p = new THREE.Vector3(...(pos.isVector3 ? [pos.x, pos.y, pos.z] : pos));
  const { shell, core } = nozzle(radius, length, { segments: A.fine ? 26 : 14, throat: 0.44 });
  A.add('metal', shell, { pos: p, tone: 0.86 });
  A.addEmissive(core, glow, intensity, { pos: p });

  if (collar && A.fine) {
    A.add('metal', ring(radius * 1.02, radius * 1.28, radius * 0.16, { segments: 20 }),
      { pos: [p.x, p.y, p.z + length * 0.12], tone: 0.7 });
  }
  // Afterburner slots — small emissive louvres around the bell mouth. Same
  // material as the core, dimmed through the vertex colour.
  if (A.fine && slots) {
    for (let i = 0; i < slots; i++) {
      const a = (i / slots) * Math.PI * 2 + 0.2;
      const r = radius * 1.02;
      A.addEmissive(plate(radius * 0.14, radius * 0.32, 0.02, 0.008), glow, intensity, {
        tone: 0.35,
        pos: [p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, p.z + length * 0.62],
        quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a)),
      });
    }
  }
  A.engineHp([p.x, p.y, p.z + length], radius * 0.9, dir);
  return A;
}

/**
 * Engine nacelle: a lofted pod with an intake at the front, a chamfered body,
 * a spine of greebles and a nozzle at the back.
 */
export function engineNacelle(A, {
  x, y, zFront, zBack, r = 1.15, glow, intensity = 16, greebles = null, rng,
  intake = true, tone = 1,
}) {
  const len = zBack - zFront;
  const prof = rectProfile(r * 2.05, r * 1.9, r * 0.5);
  const body = loft([
    { pts: prof, z: zFront, sx: 0.72, sy: 0.72 },
    { pts: prof, z: zFront + len * 0.09, sx: 0.94, sy: 0.94, hard: true },
    { pts: prof, z: zFront + len * 0.45, sx: 1.0, sy: 1.0 },
    { pts: prof, z: zBack - len * 0.16, sx: 0.97, sy: 0.95 },
    { pts: prof, z: zBack - len * 0.02, sx: 0.86, sy: 0.86, hard: true },
  ], { capStart: true, capEnd: true });
  A.add('hull', body, { pos: [x, y, 0], tone });

  // Dorsal spine strake — breaks the tube and catches the key light.
  A.add('panel', chamferedBox(r * 0.42, r * 0.3, len * 0.62, r * 0.09), {
    pos: [x, y + r * 0.94, zFront + len * 0.5], tone: 1.06,
  });

  if (intake && A.fine) {
    const { lip, duct } = intakeDuct(r * 1.15, r * 0.95, r * 1.6, { wall: r * 0.13, c: r * 0.16 });
    A.add('metal', lip, { pos: [x, y, zFront + 0.02], tone: 0.8 });
    A.add('dark', shadeCavity(duct.clone(), 0.55, 'z'), { pos: [x, y, zFront + 0.02], tone: 0.6 });
  }

  engineNozzle(A, { pos: [x, y, zBack], radius: r * 0.86, length: r * 1.6, glow, intensity });

  // Machinery bedded into the flanks of the pod. Merged rather than instanced:
  // at fighter scale a dozen greebles is cheaper as buffer data than as a draw call.
  if (greebles?.length && A.fine && rng) {
    const parts = [];
    const n = 11;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const side = i % 2 ? 1 : -1;
      parts.push(xform(greebles[rng.int(0, greebles.length - 1)], {
        pos: [x + side * r * 0.94, y + rng.range(-r * 0.55, r * 0.55), zFront + len * (0.16 + t * 0.68)],
        rot: [rng.range(-0.2, 0.2), side * Math.PI / 2, rng.range(0, Math.PI * 2)],
        scale: rng.range(0.5, 0.95),
      }));
    }
    A.add('metal', mergeGeometries(parts), { tone: 0.76 });
  }
  return A;
}

// -------------------------------------------------------------------- canopy

/**
 * Canopy: glass shell, structural frame ribs, sill rail, cockpit tub, seat and a
 * pilot you can actually see through the glass. Registers the cockpit hardpoint.
 */
export function canopy(A, {
  zFront, zBack, width, height, yBase, yLift = 0, tone = 1,
}) {
  const len = zBack - zFront;
  const cz = (zFront + zBack) * 0.5;

  // Glass shell — a flat-bottomed dome section, faceted the way a real canopy is.
  const glassProf = [];
  const seg = 12;
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI - (i / seg) * Math.PI;
    glassProf.push([Math.cos(a) * width * 0.5, Math.max(0, Math.sin(a)) * height, i === 0 || i === seg ? 1 : 0]);
  }
  glassProf.push([width * 0.5, -height * 0.22, 1]);
  glassProf.push([-width * 0.5, -height * 0.22, 1]);
  const sect = (z, s, yo) => ({ pts: glassProf, z, sx: s, sy: s, y: yBase + yo });
  const shell = loft([
    sect(zFront, 0.30, yLift * 0.15),
    sect(zFront + len * 0.16, 0.72, yLift * 0.55),
    sect(zFront + len * 0.42, 0.99, yLift),
    sect(zFront + len * 0.72, 0.97, yLift * 0.95),
    sect(zBack, 0.66, yLift * 0.5),
  ], { capStart: true, capEnd: true });
  A.add('glass', shell, { tone: 1, jitter: 0 });

  // Frame: sill rails down both sides plus arch ribs over the top.
  const railProf = rectProfile(width * 0.09, height * 0.16, width * 0.02);
  const rail = loft([
    { pts: railProf, z: zFront, sx: 0.4 },
    { pts: railProf, z: zFront + len * 0.2, sx: 0.95, hard: true },
    { pts: railProf, z: zBack, sx: 0.85 },
  ]);
  A.addPair('metal', xform(rail, { pos: [width * 0.47, yBase - height * 0.1, 0] }), { tone: 0.82 });

  if (A.fine) {
    const ribs = [0.16, 0.44, 0.74];
    for (const t of ribs) {
      const z = zFront + len * t;
      const s = t < 0.2 ? 0.72 : t < 0.5 ? 1.0 : 0.97;
      const arch = [];
      const rs = 10;
      for (let i = 0; i <= rs; i++) {
        const a = Math.PI - (i / rs) * Math.PI;
        arch.push(V(Math.cos(a) * width * 0.5 * s, yBase + yLift * (t < 0.2 ? 0.6 : 1) + Math.max(0, Math.sin(a)) * height * s, z));
      }
      const ribGeo = extrudeAlongPath(rectProfile(width * 0.055, width * 0.045, width * 0.012), arch, { capStart: true, capEnd: true });
      A.add('metal', ribGeo, { tone: 0.78 });
    }
    // Forward windscreen bow — the heavy frame that carries the HUD combiner.
    A.add('metal', chamferedBox(width * 0.9, height * 0.1, width * 0.1, width * 0.02), {
      pos: [0, yBase + yLift * 0.62, zFront + len * 0.14], tone: 0.72,
    });
  }

  // ---- interior: tub, console, seat, pilot ---------------------------------
  const tub = chamferedBox(width * 0.86, height * 0.7, len * 0.82, width * 0.08);
  A.add('dark', shadeCavity(tub, 0.45, 'y'), { pos: [0, yBase - height * 0.28, cz], tone: 0.8 });

  if (A.mid) {
    // Instrument coaming with emissive readouts.
    A.add('dark', chamferedBox(width * 0.72, height * 0.26, len * 0.16, width * 0.04), {
      pos: [0, yBase - height * 0.02, zFront + len * 0.26], tone: 0.7,
    });
    A.glow(plate(width * 0.5, height * 0.1, 0.01, 0.004), 0.20, {
      pos: [0, yBase + height * 0.06, zFront + len * 0.235],
      quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.9, 0, 0)),
    });

    // Ejection seat.
    A.add('dark', chamferedBox(width * 0.42, height * 0.5, len * 0.1, width * 0.03), {
      pos: [0, yBase + height * 0.08, cz + len * 0.16], tone: 0.55,
    });
    A.add('dark', chamferedBox(width * 0.5, height * 0.08, len * 0.26, width * 0.03), {
      pos: [0, yBase - height * 0.14, cz + len * 0.02], tone: 0.55,
    });
    // Pilot: helmet, shoulders, arms. A silhouette is enough behind glass, but
    // an *empty* canopy instantly reads as a toy.
    const helmet = dome(width * 0.15, { segments: 10, rows: 5, squash: 1.15 });
    A.add('panel', helmet, { pos: [0, yBase + height * 0.3, cz + len * 0.05], tone: 0.75 });
    A.add('dark', chamferedBox(width * 0.34, height * 0.3, len * 0.09, width * 0.03), {
      pos: [0, yBase + height * 0.12, cz + len * 0.06], tone: 0.5,
    });
    A.addPair('dark', chamferedBox(width * 0.08, height * 0.09, len * 0.2, width * 0.02), {
      pos: [width * 0.19, yBase + height * 0.06, cz - len * 0.04], tone: 0.5,
    });
  }

  A.cockpit([0, yBase + height * 0.34, cz + len * 0.02], Q());
  return A;
}

// --------------------------------------------------------------------- guns

/**
 * A gun that visibly exists: recoil housing bolted to the hull, barrel with a
 * muzzle collar, soot-dark shroud. Registers the gun hardpoint at the muzzle.
 */
export function gunMount(A, {
  pos, dir = [0, 0, -1], length = 2.0, radius = 0.16, type = 'laser', housing = true, mirror = true,
}) {
  const p = new THREE.Vector3(...(pos.isVector3 ? [pos.x, pos.y, pos.z] : pos));
  const build = (sx) => {
    const parts = [];
    const b = tube(radius, length, { segments: A.fine ? 10 : 6, rEnd: radius * 0.82 });
    parts.push(xform(b, { pos: [0, 0, -length] }));
    if (A.fine) {
      parts.push(xform(ring(radius * 0.9, radius * 1.5, radius * 0.5, { segments: 10 }), { pos: [0, 0, -length + radius * 0.5] }));
      parts.push(xform(ring(radius * 0.95, radius * 1.32, radius * 0.4, { segments: 10 }), { pos: [0, 0, -length * 0.55] }));
    }
    if (housing) parts.push(xform(chamferedBox(radius * 3.0, radius * 2.6, length * 0.55, radius * 0.6), { pos: [0, 0, -length * 0.16] }));
    const g = mergeGeometries(parts);
    return xform(g, { pos: [p.x * sx, p.y, p.z], scale: [sx, 1, 1] });
  };
  A.add('metal', build(1), { tone: 0.72 });
  if (mirror && Math.abs(p.x) > 1e-4) A.add('metal', build(-1), { tone: 0.72 });

  const d = new THREE.Vector3(...(dir.isVector3 ? [dir.x, dir.y, dir.z] : dir)).normalize();
  A.gun([p.x, p.y, p.z - length], d, type);
  if (mirror && Math.abs(p.x) > 1e-4) A.gun([-p.x, p.y, p.z - length], d, type);
  return A;
}

/** Under-wing missile rail with the ordnance actually hanging off it. */
export function missileRail(A, {
  pos, count = 2, spacing = 0.55, length = 1.8, radius = 0.13, type = 'IR', mirror = true,
}) {
  const p = new THREE.Vector3(...(pos.isVector3 ? [pos.x, pos.y, pos.z] : pos));
  const build = (sx) => {
    const parts = [];
    parts.push(chamferedBox(spacing * count * 1.15, radius * 0.9, length * 1.1, radius * 0.25));
    for (let i = 0; i < count; i++) {
      const ox = (i - (count - 1) / 2) * spacing;
      const body = tube(radius, length, { segments: A.fine ? 9 : 5 });
      parts.push(xform(body, { pos: [ox, -radius * 1.5, -length * 0.5] }));
      // Nose cone and cruciform fins.
      const nose = tube(radius, radius * 2.2, { segments: A.fine ? 9 : 5, rEnd: radius * 0.12 });
      parts.push(xform(nose, { pos: [ox, -radius * 1.5, -length * 0.5 - radius * 2.2] }));
      if (A.fine) {
        for (let f = 0; f < 4; f++) {
          const a = (f / 4) * Math.PI * 2 + Math.PI / 4;
          parts.push(xform(plate(radius * 1.5, radius * 0.06, radius * 1.1, radius * 0.03), {
            pos: [ox + Math.cos(a) * radius * 1.1, -radius * 1.5 + Math.sin(a) * radius * 1.1, length * 0.42],
            rot: [0, 0, a],
          }));
        }
      }
    }
    const g = mergeGeometries(parts);
    return xform(g, { pos: [p.x * sx, p.y, p.z], scale: [sx, 1, 1] });
  };
  A.add('metal', build(1), { tone: 0.9 });
  if (mirror && Math.abs(p.x) > 1e-4) A.add('metal', build(-1), { tone: 0.9 });
  A.missile([p.x, p.y - radius * 1.5, p.z - length * 0.5], [0, 0, -1], count, type);
  if (mirror && Math.abs(p.x) > 1e-4) A.missile([-p.x, p.y - radius * 1.5, p.z - length * 0.5], [0, 0, -1], count, type);
  return A;
}

// ------------------------------------------------------------ surface detail

/**
 * RCS thruster port: a recessed cluster of four cones in a chamfered surround.
 * Registers the attitude-thruster hardpoint so vfx can puff it on control input.
 */
export function rcsPort(A, { pos, normal = [0, 1, 0], size = 0.34, mirror = false, glow = '#9fd8ff' }) {
  const place = (sx) => {
    const p = [pos[0] * sx, pos[1], pos[2]];
    const n = new THREE.Vector3(normal[0] * sx, normal[1], normal[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), n);
    if (A.fine) {
      A.add('metal', panelInset(size * 2, size * 1.5, size * 0.4, size * 0.16), { pos: p, quat: q, tone: 0.7 });
      for (let i = 0; i < 4; i++) {
        const ox = (i % 2 ? 1 : -1) * size * 0.42;
        const oy = (i < 2 ? 1 : -1) * size * 0.3;
        const local = new THREE.Vector3(ox, oy, -size * 0.18).applyQuaternion(q);
        const cone = tube(size * 0.2, size * 0.22, { segments: 6, rEnd: size * 0.3 });
        A.add('dark', cone, { pos: [p[0] + local.x, p[1] + local.y, p[2] + local.z], quat: q, tone: 0.5 });
      }
    }
    A.thruster(p, n.clone().negate());
  };
  place(1);
  if (mirror) place(-1);
  return A;
}

/**
 * Plated patch: a grid of raised armour plates with random skips and size
 * variation. Applied to fuselage tops, wing surfaces and capital ship flanks so
 * the eye reads panelling as geometry, not just texture.
 */
export function platePatch(A, {
  center, normal = [0, 1, 0], tangent = [0, 0, -1], w, h, cols = 3, rows = 4,
  thickness = 0.05, gap = 0.06, rng, bucket = 'panel', skip = 0.18, tone = 1.05,
}) {
  if (!A.fine) return A;
  const q = surfaceFrame(normal, tangent);
  const c = new THREE.Vector3(...center);
  const cw = w / cols, ch = h / rows;
  const parts = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (rng.bool(skip)) continue;
      const px = -w / 2 + cw * (i + 0.5);
      const py = -h / 2 + ch * (j + 0.5);
      const pw = cw - gap, ph = ch - gap;
      const g = plate(pw * rng.range(0.86, 1.0), ph * rng.range(0.86, 1.0), thickness * rng.range(0.7, 1.3), thickness * 0.4);
      parts.push(xform(g, { pos: [px, py, thickness * 0.5] }));
    }
  }
  if (!parts.length) return A;
  A.add(bucket, mergeGeometries(parts), { pos: c, quat: q, tone });
  return A;
}

/** A row of recessed panels — hatches, access bays, service covers. */
export function recessRow(A, {
  center, normal = [0, 1, 0], tangent = [0, 0, -1], w, h, count = 3, depth = 0.1, rng, bucket = 'hull',
}) {
  if (!A.fine) return A;
  const q = surfaceFrame(normal, tangent);
  const parts = [];
  const step = h / count;
  for (let i = 0; i < count; i++) {
    const g = panelInset(w * rng.range(0.8, 1.0), step * 0.78, depth, Math.min(w, step) * 0.09);
    parts.push(xform(g, { pos: [0, -h / 2 + step * (i + 0.5), 0.01] }));
  }
  const merged = mergeGeometries(parts);
  shadeCavity(merged, 0.4, 'z');
  A.add(bucket, merged, { pos: new THREE.Vector3(...center), quat: q, tone: 0.93 });
  return A;
}

/** Sensor dome / avionics blister. */
export function sensorDome(A, { pos, r = 0.5, normal = [0, 1, 0], bucket = 'panel', tone = 1.0 }) {
  const n = new THREE.Vector3(...normal).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), n);
  A.add(bucket, dome(r, { segments: A.fine ? 18 : 8, rows: A.fine ? 7 : 3, squash: 0.72 }), { pos, quat: q, tone });
  if (A.fine) A.add('metal', ring(r * 0.98, r * 1.18, r * 0.16, { segments: 16 }), { pos, quat: new THREE.Quaternion().multiplyQuaternions(q, new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))), tone: 0.7 });
  return A;
}

/** Landing gear bay: a recessed well with two split doors sitting slightly proud. */
export function gearBay(A, { pos, w, l, depth = 0.4, normal = [0, -1, 0], mirror = false }) {
  if (!A.fine) return A;
  const place = (sx) => {
    const p = [pos[0] * sx, pos[1], pos[2]];
    const n = new THREE.Vector3(normal[0] * sx, normal[1], normal[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), n);
    const well = panelInset(w, l, depth, Math.min(w, l) * 0.06);
    A.add('dark', shadeCavity(well, 0.6, 'z'), { pos: p, quat: q, tone: 0.55 });
    // Door halves with a visible split line and hinge fairings.
    for (const s of [-1, 1]) {
      const d = plate(w * 0.47, l * 0.96, depth * 0.16, depth * 0.06);
      const local = new THREE.Vector3(s * w * 0.25, 0, depth * 0.06).applyQuaternion(q);
      A.add('panel', d, { pos: [p[0] + local.x, p[1] + local.y, p[2] + local.z], quat: q, tone: 1.04 });
    }
  };
  place(1);
  if (mirror) place(-1);
  return A;
}

// -------------------------------------------------------------- capital ship

/**
 * Turret geometry for instancing on capital ships: barbette ring, traversing
 * housing, elevating trunnion and twin barrels. Returned as one merged buffer so
 * a carrier's whole battery is a single InstancedMesh.
 */
export function turretGeometry(size = 4, { fine = true } = {}) {
  const s = size;
  const parts = [];
  const base = revolve([
    [s * 0.72, 0, 1], [s * 0.72, s * 0.16, 1], [s * 0.62, s * 0.22, 1], [s * 0.62, s * 0.3, 1], [0, s * 0.3, 1],
  ], { segments: fine ? 16 : 8 });
  parts.push(base);
  parts.push(xform(chamferedBox(s * 1.05, s * 0.52, s * 0.9, s * 0.13), { pos: [0, s * 0.55, 0] }));
  parts.push(xform(chamferedBox(s * 0.55, s * 0.42, s * 0.55, s * 0.1), { pos: [0, s * 0.72, -s * 0.42] }));
  for (const sx of [-1, 1]) {
    const barrel = tube(s * 0.1, s * 1.5, { segments: fine ? 8 : 5, rEnd: s * 0.085 });
    parts.push(xform(barrel, { pos: [sx * s * 0.2, s * 0.6, -s * 1.9] }));
    if (fine) parts.push(xform(ring(s * 0.1, s * 0.17, s * 0.1, { segments: 8 }), { pos: [sx * s * 0.2, s * 0.6, -s * 1.75] }));
  }
  if (fine) {
    parts.push(xform(chamferedBox(s * 0.3, s * 0.2, s * 0.3, s * 0.05), { pos: [s * 0.4, s * 0.85, s * 0.25] }));
  }
  return mergeGeometries(parts);
}

/** Antenna / sensor mast cluster — thin verticals that break a capital silhouette. */
export function antennaArray(A, { pos, height = 14, rng, bucket = 'metal' }) {
  if (!A.mid) return A;
  const parts = [];
  const mast = tube(height * 0.035, height, { segments: 6, rEnd: height * 0.012 });
  mast.rotateX(-Math.PI / 2);
  parts.push(mast);
  const rungs = A.fine ? 5 : 2;
  for (let i = 1; i <= rungs; i++) {
    const t = i / (rungs + 1);
    const w = height * 0.34 * (1 - t * 0.6);
    parts.push(xform(chamferedBox(w, height * 0.018, height * 0.02, height * 0.006), { pos: [0, height * t, 0] }));
  }
  if (A.fine) {
    parts.push(xform(dome(height * 0.1, { segments: 10, rows: 4, squash: 0.6 }), { pos: [0, height * 0.42, 0] }));
    parts.push(xform(revolve([[0, 0, 1], [height * 0.13, height * 0.1, 0], [height * 0.14, height * 0.11, 1], [0, height * 0.02, 1]], { segments: 12 }),
      { pos: [height * 0.1, height * 0.72, 0], rot: [0.6, 0, 0.5] }));
  }
  A.add(bucket, mergeGeometries(parts), { pos, tone: 0.72 });
  return A;
}

/** A run of running lights along an edge — the scale cue that sells a capital ship. */
export function runningLights(A, { from, to, count, color = '#ffffff', intensity = 5, size = 0.5, normal = [0, 1, 0], mirror = false }) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const p = a.clone().lerp(b, t);
    A.navLight([p.x, p.y, p.z], color, intensity, size, normal);
    if (mirror) A.navLight([-p.x, p.y, p.z], color, intensity, size, [-normal[0], normal[1], normal[2]]);
  }
  return A;
}

/**
 * Hangar bay: a deep recess with a lit interior, deck stripes, an approach-light
 * ladder and a shimmering atmosphere-containment field across the mouth.
 */
export function hangarBay(A, {
  pos, w, h, depth, glow = '#ffb44a', fieldColor = '#5ec8ff', dir = [0, 0, -1], rng,
}) {
  const p = new THREE.Vector3(...pos);
  const d = new THREE.Vector3(...dir).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, -1), d);

  // The bay itself — an open box whose inside faces the viewer.
  const outer = rectProfile(w, h, Math.min(w, h) * 0.08);
  const inner = scaleProfile(outer, 0.92, 0.86);
  const box = loft([
    { pts: inner, z: 0 },
    { pts: inner, z: depth * 0.5 },
    { pts: scaleProfile(inner, 0.86, 0.8), z: depth },
  ], { capStart: false, capEnd: true });
  invertShell(box);
  A.add('dark', shadeCavity(box, 0.35, 'z'), { pos: p, quat: q, tone: 1.0 });

  // Mouth surround: heavy chamfered lip so the opening has thickness.
  const lipGeo = loft([
    { pts: outer, z: -h * 0.06 },
    { pts: outer, z: 0, hard: true },
    { pts: inner, z: h * 0.05, hard: true },
    { pts: inner, z: h * 0.14 },
  ], { capStart: false, capEnd: false });
  A.add('metal', lipGeo, { pos: p, quat: q, tone: 0.78 });

  // Interior lighting: ceiling strips and deck edge lights. This is the whole
  // point of a hangar — a hot pocket of warm light inside a cold grey hull.
  const strips = A.fine ? 6 : 3;
  const GLOW_I = 7;
  for (let i = 0; i < strips; i++) {
    const z = depth * (0.12 + 0.82 * (i / Math.max(1, strips - 1)));
    const local = new THREE.Vector3(0, h * 0.4, z).applyQuaternion(q);
    A.addEmissive(plate(w * 0.72, 0.1, 0.08, 0.03), glow, GLOW_I, {
      tone: 0.92, pos: [p.x + local.x, p.y + local.y, p.z + local.z], quat: q,
    });
    const l2 = new THREE.Vector3(0, -h * 0.42, z).applyQuaternion(q);
    A.addEmissive(plate(w * 0.5, 0.1, 0.08, 0.03), glow, GLOW_I, {
      tone: 0.42, pos: [p.x + l2.x, p.y + l2.y, p.z + l2.z], quat: q,
    });
  }
  // Deck: a lit floor plane so the light has something to land on.
  const deck = new THREE.Vector3(0, -h * 0.44, depth * 0.5).applyQuaternion(q);
  A.add('panel', plate(w * 0.86, depth * 0.94, 0.16, 0.06), {
    pos: [p.x + deck.x, p.y + deck.y, p.z + deck.z],
    quat: new THREE.Quaternion().multiplyQuaternions(q, new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))),
    tone: 0.8,
  });
  // Approach lights framing the mouth.
  const cols = A.fine ? 7 : 4;
  for (let i = 0; i < cols; i++) {
    const t = i / (cols - 1);
    const x = (-0.5 + t) * w * 0.9;
    for (const sy of [-1, 1]) {
      const local = new THREE.Vector3(x, sy * h * 0.47, h * 0.02).applyQuaternion(q);
      A.navLight([p.x + local.x, p.y + local.y, p.z + local.z], i % 2 ? '#ffd0a0' : fieldColor, 7, 0.42, [d.x, d.y, d.z]);
    }
  }
  A.hangar([p.x, p.y, p.z], [w, h], [d.x, d.y, d.z]);
  return A;
}
