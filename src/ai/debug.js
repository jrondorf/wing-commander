/**
 * src/ai/debug.js — optional AI visualiser.
 *
 * Off by default and never imported unless it is needed: AISystem dynamically
 * imports this module the first time `engine.game.debugAI` goes true, and
 * disposes it when the flag goes false. Nothing here affects simulation.
 *
 * What it draws, per pilot:
 *   · a line to the current target, coloured by state group
 *     (green = offensive, amber = defensive, blue = idle)
 *   · a short spur to the predicted intercept point, with a cross marker
 *   · a line to the ship the pilot considers the threat (dim red)
 *   · a floating label: callsign · state · manoeuvre · skill
 *
 * Everything lives in three objects (one LineSegments, one Points, one label
 * pool) so switching it on costs a handful of draw calls, not one per pilot.
 */
import * as THREE from 'three';

const COLORS = {
  offense: new THREE.Color(0x66ff9a),
  defense: new THREE.Color(0xffb03a),
  idle: new THREE.Color(0x5ec8ff),
  threat: new THREE.Color(0xff4a5c),
  lead: new THREE.Color(0xfff27a),
};

const GROUP_OF = {
  patrol: 'idle', formUp: 'idle', regroup: 'idle',
  pursue: 'offense', attackRun: 'offense', dogfight: 'offense',
  strafeCapital: 'offense', taunt: 'offense',
  evade: 'defense', breakOff: 'defense', defend: 'defense', flee: 'defense',
};

const MAX_PILOTS = 64;
const SEGS_PER_PILOT = 3; // target line, lead spur, threat line

export function createAIDebug(engine) {
  const scene = engine.scene;
  const root = new THREE.Group();
  root.name = 'ai-debug';
  root.renderOrder = 999;
  scene.add(root);

  const vertCount = MAX_PILOTS * SEGS_PER_PILOT * 2;
  const linePos = new Float32Array(vertCount * 3);
  const lineCol = new Float32Array(vertCount * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  root.add(lines);

  const ptPos = new Float32Array(MAX_PILOTS * 3);
  const ptCol = new Float32Array(MAX_PILOTS * 3);
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
  ptGeo.setAttribute('color', new THREE.BufferAttribute(ptCol, 3));
  const ptMat = new THREE.PointsMaterial({
    size: 14,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(ptGeo, ptMat);
  points.frustumCulled = false;
  root.add(points);

  /** Label sprites, pooled and keyed by text so the canvas work is cached. */
  const labelPool = [];
  const texCache = new Map();

  function labelTexture(text) {
    let t = texCache.get(text);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 64);
    g.font = '600 30px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.55)';
    const w = Math.min(508, g.measureText(text).width + 16);
    g.fillRect(2, 10, w, 44);
    g.fillStyle = '#bff3ff';
    g.fillText(text, 10, 33);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    // Bound the cache: labels churn as states change.
    if (texCache.size > 220) {
      const first = texCache.keys().next().value;
      texCache.get(first)?.dispose();
      texCache.delete(first);
    }
    texCache.set(text, t);
    return t;
  }

  function getLabel(i) {
    let s = labelPool[i];
    if (!s) {
      const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false });
      s = new THREE.Sprite(mat);
      s.scale.set(120, 15, 1);
      s.frustumCulled = false;
      labelPool[i] = s;
      root.add(s);
    }
    return s;
  }

  const _p = new THREE.Vector3();
  const _q = new THREE.Vector3();

  function seg(idx, ax, ay, az, bx, by, bz, color) {
    const o = idx * 6;
    linePos[o] = ax; linePos[o + 1] = ay; linePos[o + 2] = az;
    linePos[o + 3] = bx; linePos[o + 4] = by; linePos[o + 5] = bz;
    lineCol[o] = color.r; lineCol[o + 1] = color.g; lineCol[o + 2] = color.b;
    lineCol[o + 3] = color.r; lineCol[o + 4] = color.g; lineCol[o + 5] = color.b;
  }

  return {
    update(ai) {
      if (!ai) return;
      const pilots = ai.pilots;
      let s = 0;
      let np = 0;
      let nl = 0;

      for (let i = 0; i < pilots.length && np < MAX_PILOTS; i++) {
        const p = pilots[i];
        const body = ai.bodyOf(p.ship);
        if (!body) continue;
        _p.copy(body.position);
        const col = COLORS[GROUP_OF[p.state] ?? 'idle'];

        if (p.target) {
          const tb = ai.bodyOf(p.target);
          if (tb) seg(s++, _p.x, _p.y, _p.z, tb.position.x, tb.position.y, tb.position.z, col);
        }
        if (p.aimPoint) {
          seg(s++, _p.x, _p.y, _p.z, p.aimPoint.x, p.aimPoint.y, p.aimPoint.z, COLORS.lead);
          const o = np * 3;
          ptPos[o] = p.aimPoint.x; ptPos[o + 1] = p.aimPoint.y; ptPos[o + 2] = p.aimPoint.z;
          ptCol[o] = COLORS.lead.r; ptCol[o + 1] = COLORS.lead.g; ptCol[o + 2] = COLORS.lead.b;
          np++;
        }
        if (p.threat && p.threat !== p.target) {
          const hb = ai.bodyOf(p.threat);
          if (hb) seg(s++, _p.x, _p.y, _p.z, hb.position.x, hb.position.y, hb.position.z, COLORS.threat);
        }

        const label = getLabel(nl++);
        const text = `${p.profile.callsign} ${p.state}${p.mv.id ? ' · ' + p.mv.id : ''} [${p.profile.skill}]`;
        if (label.userData.text !== text) {
          label.userData.text = text;
          label.material.map = labelTexture(text);
          label.material.needsUpdate = true;
        }
        label.position.copy(_p).y += 26;
        label.visible = true;

        if (s >= MAX_PILOTS * SEGS_PER_PILOT - 1) break;
      }

      // Collapse unused segments to a degenerate point rather than resizing.
      for (let k = s; k < MAX_PILOTS * SEGS_PER_PILOT; k++) seg(k, 0, 0, 0, 0, 0, 0, COLORS.idle);
      for (let k = np; k < MAX_PILOTS; k++) {
        const o = k * 3;
        ptPos[o] = 0; ptPos[o + 1] = 0; ptPos[o + 2] = 0;
        ptCol[o] = 0; ptCol[o + 1] = 0; ptCol[o + 2] = 0;
      }
      for (let k = nl; k < labelPool.length; k++) labelPool[k].visible = false;

      lineGeo.attributes.position.needsUpdate = true;
      lineGeo.attributes.color.needsUpdate = true;
      ptGeo.attributes.position.needsUpdate = true;
      ptGeo.attributes.color.needsUpdate = true;
    },

    dispose() {
      scene.remove(root);
      lineGeo.dispose();
      lineMat.dispose();
      ptGeo.dispose();
      ptMat.dispose();
      for (const s of labelPool) {
        s.material.map = null;
        s.material.dispose();
      }
      labelPool.length = 0;
      for (const t of texCache.values()) t.dispose();
      texCache.clear();
    },
  };
}

export default createAIDebug;
