/**
 * src/ai/formations.js — squadrons, formation geometry and station keeping.
 *
 * Three jobs:
 *   1. Formation *shapes* — slot offsets in the leader's body frame.
 *   2. Slot *assignment* — stable, and greedy-nearest when a formation re-forms
 *      after a fight so nobody crosses the whole flight to reach their number.
 *   3. Station *keeping* — a critically-damped spring on position with explicit
 *      velocity matching, because a pure position spring makes wingmen porpoise.
 *
 * Plus the social layer: elements (fighting pairs), mutual-support requests, and
 * formation dissolution the moment anybody calls a contact. A flight that holds
 * a parade formation while being shot at is the most common tell of cheap AI.
 *
 * Body-frame convention for slot offsets: +x right, +y up, +z **behind** the
 * leader (forward is −z).
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothRange } from './aimath.js';

/**
 * Slot generators. Each returns an offset in leader body units, scaled by
 * `spacing` (metres between adjacent aircraft).
 */
export const FORMATIONS = {
  /** Classic V. Leader at the point, pairs stepping back left and right. */
  wedge(i, n, s) {
    if (i === 0) return { x: 0, y: 0, z: 0 };
    const rank = Math.ceil(i / 2);
    const side = i % 2 === 1 ? -1 : 1;
    return { x: side * rank * s * 0.95, y: side * s * 0.06, z: rank * s * 0.8 };
  },

  /**
   * Finger-four: two mutually-supporting pairs, offset so no two aircraft share
   * a line of sight. The reason it survived from 1938 to now.
   */
  fingerFour(i, n, s) {
    const t = [
      { x: 0, y: 0, z: 0 },
      { x: -0.95, y: -0.12, z: 0.85 },
      { x: 1.5, y: 0.1, z: 1.0 },
      { x: 2.5, y: -0.05, z: 1.9 },
    ];
    const k = t[i % 4];
    const wave = Math.floor(i / 4);
    return { x: (k.x + wave * 3.4) * s, y: k.y * s, z: (k.z + wave * 1.2) * s };
  },

  /** Line abreast — maximum mutual visual coverage, used on a sweep. */
  lineAbreast(i, n, s) {
    return { x: (i - (n - 1) / 2) * s * 1.15, y: 0, z: Math.abs(i - (n - 1) / 2) * s * 0.12 };
  },

  echelonRight(i, n, s) {
    return { x: i * s * 0.9, y: -i * s * 0.06, z: i * s * 0.75 };
  },

  echelonLeft(i, n, s) {
    return { x: -i * s * 0.9, y: -i * s * 0.06, z: i * s * 0.75 };
  },

  /** Trail — for threading debris, minefields or a carrier approach. */
  trail(i, n, s) {
    return { x: Math.sin(i * 1.9) * s * 0.14, y: i * s * 0.1, z: i * s * 1.25 };
  },
};

export const FORMATION_IDS = Object.keys(FORMATIONS);

/** Where a wingman sits when their leader is engaged: behind, high, offset. */
export function coverOffset(side, spacing) {
  return { x: side * spacing * 0.55, y: spacing * 0.32, z: spacing * 1.5 };
}

const _off = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _err = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _lv = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * A squadron: a named group flying together under one leader.
 *
 * `intact` is the formation-dissolution flag. It drops the instant anyone has a
 * live contact and only comes back after `reformDelay` quiet seconds, at which
 * point slots are re-assigned greedily so the re-form looks like pilots sliding
 * back into place rather than a teleport.
 */
export class Squadron {
  constructor(id, faction, opts = {}) {
    this.id = id;
    this.faction = faction;
    this.members = [];
    this.leader = null;
    this.formation = opts.formation ?? 'fingerFour';
    this.spacing = opts.spacing ?? 90;
    this.intact = true;
    this.quietFor = 0;
    this.reformDelay = opts.reformDelay ?? 6;
    this.helpQueue = [];
    this._dirty = true;
  }

  add(pilot) {
    if (this.members.includes(pilot)) return;
    this.members.push(pilot);
    pilot.squadron = this;
    this._dirty = true;
  }

  remove(pilot) {
    const i = this.members.indexOf(pilot);
    if (i >= 0) this.members.splice(i, 1);
    if (pilot.squadron === this) pilot.squadron = null;
    if (this.leader === pilot) this.leader = null;
    for (const m of this.members) {
      if (m.leader === pilot) m.leader = null;
      if (m.element?.lead === pilot || m.element?.wing === pilot) m.element = null;
    }
    this._dirty = true;
  }

  get alive() {
    return this.members.filter((m) => m.ship?.alive !== false);
  }

  /**
   * Slot assignment. Explicit leader first (the highest-ranked survivor), then
   * greedy nearest-slot for everyone else so a re-form does not shuffle the
   * whole flight.
   */
  assignSlots(ai) {
    const live = this.alive;
    if (!live.length) return;

    // A player-led flight pins the leader to the player's virtual pilot, who is
    // not a member (we do not fly them) and never takes a slot.
    if (this.lockedLeader && this.lockedLeader.ship?.alive !== false) {
      this.leader = this.lockedLeader;
    } else if (!this.leader || this.leader.ship?.alive === false || !live.includes(this.leader)) {
      // Promote: best pilot, ties broken by lowest id so it is deterministic.
      this.leader = live.reduce((best, m) => {
        if (!best) return m;
        if (m.profile.rank !== best.profile.rank) return m.profile.rank > best.profile.rank ? m : best;
        return m.id < best.id ? m : best;
      }, null);
      this.leader.leader = null;
    }

    const gen = FORMATIONS[this.formation] ?? FORMATIONS.fingerFour;
    const others = live.filter((m) => m !== this.leader);
    // The leader occupies slot 0 whether or not we fly them, so a player-led
    // flight of three wingmen still needs four slots.
    const n = others.length + 1;

    // Candidate slots 1..n-1 in leader frame → world, then greedy nearest.
    const lb = ai.bodyOf(this.leader.ship);
    const slots = [];
    for (let i = 1; i < n; i++) {
      const o = gen(i, n, this.spacing);
      const world = new THREE.Vector3(o.x, o.y, o.z);
      if (lb) world.applyQuaternion(lb.quaternion).add(lb.position);
      slots.push({ index: i, world, taken: false });
    }

    const pool = others.slice();
    for (const slot of slots) {
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < pool.length; k++) {
        const b = ai.bodyOf(pool[k].ship);
        const d = b ? b.position.distanceToSquared(slot.world) : k;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      if (best < 0) break;
      const m = pool.splice(best, 1)[0];
      m.slot = slot.index;
      m.leader = this.leader;
    }
    for (const m of pool) {
      m.slot = 0;
      m.leader = this.leader;
    }

    // Fighting pairs: slot 0+1, 2+3, ... A wingman's first duty is their leader.
    const ordered = [this.leader, ...others.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))];
    for (let i = 0; i < ordered.length; i += 2) {
      const lead = ordered[i];
      const wing = ordered[i + 1] ?? null;
      const el = { lead, wing };
      lead.element = el;
      if (wing) wing.element = el;
    }
    this._dirty = false;
  }

  update(dt, ai) {
    const live = this.alive;
    if (!live.length) return;

    // Dissolution: any live contact and the parade is over.
    const contact = live.some((m) => m.target || m.underAttackFor > 0.2 || m.incoming);
    if (contact) {
      this.intact = false;
      this.quietFor = 0;
    } else {
      this.quietFor += dt;
      if (!this.intact && this.quietFor > this.reformDelay) {
        this.intact = true;
        this._dirty = true;
      }
    }

    if (this._dirty || !this.leader || this.leader.ship?.alive === false) this.assignSlots(ai);

    // Expire help requests older than a few seconds — a call for help nobody
    // answered in 6 s is no longer actionable, it is just noise.
    for (let i = this.helpQueue.length - 1; i >= 0; i--) {
      if (ai.time - this.helpQueue[i].t > 6) this.helpQueue.splice(i, 1);
    }
  }

  /** A member is defensive and wants somebody to peel their attacker off. */
  requestHelp(pilot, time) {
    if (this.helpQueue.some((h) => h.pilot === pilot)) return;
    this.helpQueue.push({ pilot, t: time });
  }

  /**
   * Who should answer? The wingman of the caller's element first (that is what a
   * wingman is *for*), otherwise the nearest disciplined member not currently
   * defensive themselves.
   */
  responderFor(call, ai) {
    const caller = call.pilot;
    const partner = caller.element?.lead === caller ? caller.element?.wing : caller.element?.lead;
    const usable = (m) =>
      m &&
      m !== caller &&
      m.ship?.alive !== false &&
      m.state !== 'evade' &&
      m.state !== 'flee' &&
      !m.incoming;
    if (usable(partner)) return partner;

    let best = null;
    let bestScore = -Infinity;
    const cb = ai.bodyOf(caller.ship);
    for (const m of this.alive) {
      if (!usable(m)) continue;
      const mb = ai.bodyOf(m.ship);
      const d = cb && mb ? cb.position.distanceTo(mb.position) : 5000;
      const score = m.profile.discipline * 2600 - d;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  /** World position of a pilot's formation slot. */
  slotWorld(pilot, ai, out) {
    const leader = pilot.leader ?? this.leader;
    if (!leader || leader === pilot) return null;
    const lb = ai.bodyOf(leader.ship);
    if (!lb) return null;
    const n = Math.max(2, this.alive.length);
    const gen = FORMATIONS[this.formation] ?? FORMATIONS.fingerFour;

    let o;
    if (!this.intact && leader.state && leader.state !== 'patrol' && leader.state !== 'formUp') {
      // Leader is fighting: fall back to the cover position, not the parade slot.
      const side = (pilot.slot ?? 1) % 2 === 1 ? -1 : 1;
      o = coverOffset(side, this.spacing);
    } else {
      o = gen(clamp(pilot.slot ?? 1, 0, 15), n, this.spacing);
    }
    _off.set(o.x, o.y, o.z).applyQuaternion(lb.quaternion);
    return out.copy(lb.position).add(_off);
  }
}

/**
 * Formation station keeping.
 *
 * Spring–damper on the slot: desired velocity = leader velocity + kP·error −
 * kD·(relative velocity). Velocity matching is what makes a wingman look
 * *attached* instead of chasing. `discipline` sets the gains and the slop, so a
 * reckless rookie visibly wanders and a disciplined veteran sits welded on.
 */
export function stationKeep(ctx, dt) {
  const { pilot, ai, intent } = ctx;
  const sq = pilot.squadron;
  const leaderShip = pilot.leader?.ship ?? null;
  if (!sq || !leaderShip || leaderShip.alive === false) {
    // Nothing to form on: hold heading and cruise.
    intent.aim.copy(ctx.fwd);
    intent.throttle = 0.55;
    intent.ab = 0;
    return;
  }

  const target = sq.slotWorld(pilot, ai, _desired);
  const lb = ai.bodyOf(leaderShip);
  if (!target || !lb) {
    intent.aim.copy(ctx.fwd);
    intent.throttle = 0.55;
    return;
  }

  const disc = pilot.profile.discipline;
  const kP = lerp(0.55, 1.5, disc);
  const kD = lerp(0.45, 1.15, disc);
  const maxSpeed = Math.max(80, pilot.maxSpeed);

  _err.copy(target).sub(ctx.pos);
  const dist = _err.length();

  if (lb.velocity) _lv.copy(lb.velocity);
  else _lv.set(0, 0, 0);

  // desiredVel = leaderVel + kP·positionError − kD·relativeVelocity
  _vel.copy(_lv).addScaledVector(_err, kP);
  _tmp.copy(ctx.vel).sub(_lv);
  _vel.addScaledVector(_tmp, -kD);

  const want = _vel.length();
  if (want > maxSpeed * 1.6) _vel.multiplyScalar((maxSpeed * 1.6) / want);
  const speedWant = _vel.length();

  // Close in: stop chasing a velocity vector and just fly the leader's heading,
  // otherwise wingmen visibly wobble around the slot.
  const blend = smoothRange(dist, lerp(14, 6, disc), lerp(120, 60, disc));
  const lfwd = _off.set(0, 0, -1).applyQuaternion(lb.quaternion);
  if (speedWant < 1e-4) _vel.copy(lfwd);
  else _vel.multiplyScalar(1 / speedWant);
  intent.aim.copy(lfwd).lerp(_vel, blend).normalize();
  intent.throttle = clamp01(speedWant / maxSpeed);
  // Afterburner only to catch up from a long way back — and only if they have the
  // discipline to then throttle down again.
  intent.ab = dist > 320 && ctx.vel.length() < speedWant * 0.9 ? clamp01((dist - 320) / 900) * pilot.abAvailable : 0;
  intent.brake = dist < 25 && ctx.vel.length() > _lv.length() * 1.15 ? 0.4 : 0;
  intent.levelWeight = 0.35;

  // Slop: undisciplined pilots let the slot drift, which is what stops four
  // fighters looking like one rigid object.
  const slop = lerp(0.22, 0.02, disc);
  if (slop > 0.01) {
    const t = ctx.time * 0.37 + pilot.id * 2.1;
    intent.aim.x += Math.sin(t) * slop * 0.05;
    intent.aim.y += Math.sin(t * 1.31 + 1.1) * slop * 0.05;
    intent.aim.normalize();
  }
}
