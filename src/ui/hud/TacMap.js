/**
 * src/ui/hud/TacMap.js — the in-flight tactical map.
 *
 * The briefing has a nav plot (`src/ui/navmap.js`), but it was the only map in
 * the game: once the canopy closed, the pilot's entire picture of a 70 km
 * mission was one line of text reading `NAV 1 · BUOY 4  21.0Km`. There was no
 * way to see where you were, which way the course ran, what was behind you, or
 * how the fight was arranged around you. That is the gap this fills.
 *
 * It is deliberately *not* the briefing map with live data poured in:
 *
 *   - it is **ego-centric**, always centred on the player, because the question
 *     in flight is "what is around me", not "what shape is the mission";
 *   - it is **auto-ranged** on a fixed ladder, so the scale is a number the
 *     pilot learns rather than a value that slides under them frame to frame;
 *   - it plots the **XZ plane** with an explicit vertical-separation cue per
 *     contact, because a plan view that silently flattens 4 km of altitude
 *     difference lies about the tactical picture.
 *
 * It sits over the **dashboard**, bottom-left, not over the windscreen. The sim
 * keeps running while the map is up, so the one thing the overlay must never do
 * is take the canopy: it covers the left MFD, which the pilot chose to give up
 * by opening it, and leaves every degree of sky and the whole HUD clear.
 */
import { el, fitCanvas, fmtDistance } from '../dom.js';
import { PALETTE } from '../theme.js';

const CY = PALETTE.cyan;
const CY_DIM = PALETTE.cyanDim;
const AM = PALETTE.amber;
const RD = PALETTE.red;
const GR = PALETTE.green;

/**
 * Scale ladder, metres from centre to the edge of the plot.
 *
 * A fixed ladder rather than a continuous fit: a scale that slid smoothly with
 * the furthest contact meant the plot silently rescaled every time a bandit
 * died, and nothing on it could be judged by eye twice running.
 */
const RANGES = [1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000, 250_000];

/** Hysteresis on the auto-range so a contact hovering on a boundary can't flap. */
const RANGE_GROW = 0.92;
const RANGE_SHRINK = 0.34;

/**
 * Ceiling on what a *contact* may pull the scale out to.
 *
 * Measured on mission 1: a scout group spawns at nav 2, 49 km down the course.
 * With every ship allowed to drive the range, one straggler out there took the
 * plot to a 100 km scale and the fight the pilot was actually in — a wingman at
 * 200 m and a bandit at 500 m — collapsed onto the ownship marker. Contacts
 * beyond this do not move the scale; they pin to the rim instead.
 */
const CONTACT_SCOPE_CAP = 12_000;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * @param {import('../../core/Engine.js').Engine} engine
 */
export function createTacMap(engine) {
  const canvas = el('canvas.wc-tacmap__canvas');
  const root = el('div.wc-tacmap', {
    style: { display: 'none' },
  }, [
    canvas,
    el('div.wc-tacmap__hint', { text: 'V · CLOSE' }),
  ]);

  let open = false;
  let time = 0;
  let rangeIdx = 3;
  /** Fed by `nav:changed` so a course advance is visible without polling. */
  let flash = 0;

  const offs = [];
  if (engine?.events?.on) {
    offs.push(engine.events.on('nav:changed', () => { flash = 1; }));
    offs.push(engine.events.on('nav:arrive', () => { flash = 1; }));
  }

  // ---------------------------------------------------------------- geometry
  /**
   * Auto-range: the smallest ladder step that still contains everything worth
   * showing — live contacts and the active nav point, not the whole course, or
   * a 70 km leg would pin every dogfight to a single pixel at the centre.
   */
  function chooseRange(reach) {
    const cur = RANGES[rangeIdx];
    if (reach > cur * RANGE_GROW) {
      while (rangeIdx < RANGES.length - 1 && reach > RANGES[rangeIdx] * RANGE_GROW) rangeIdx++;
    } else if (reach < cur * RANGE_SHRINK) {
      while (rangeIdx > 0 && reach < RANGES[rangeIdx - 1] * RANGE_GROW * 0.9) rangeIdx--;
    }
    return RANGES[rangeIdx];
  }

  // ------------------------------------------------------------------- paint
  function draw(dt) {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx, w, h } = fit;
    time += dt;
    flash = Math.max(0, flash - dt * 1.4);

    const game = engine?.game ?? null;
    const player = game?.player ?? engine?.player ?? null;
    const ships = game?.ships ?? [];
    const mission = game?.mission ?? null;

    ctx.clearRect(0, 0, w, h);

    // The panel ground and its border are CSS on the host element (see theme.js).
    // Painted here as a full-canvas fillRect they composited nowhere near the
    // requested alpha and the dashboard showed through the plot.

    const cx = w * 0.5;
    const cy = h * 0.5 + h * 0.02;
    const plotR = Math.min(w, h) * 0.40;

    if (!player?.group) {
      label(ctx, 'NO TELEMETRY', cx, cy, { color: CY_DIM, size: 13, align: 'center' });
      return;
    }

    const pp = player.group.position;
    // Heading in the XZ plane. -Z is forward for every hull in the game, so a
    // ship pointing down -Z must read as "up the page" on a north-up plot.
    const fwd = _fwd(player);
    const heading = Math.atan2(fwd.x, -fwd.z);

    const navs = safeNavs(mission);
    const active = navs.find((n) => n.active) ?? null;

    // ---- range -----------------------------------------------------------
    /*
     * Two modes, one rule: when anything is on the scope, scale on the *fight*;
     * when nothing is, scale on the leg being flown. Scaling on the leg while a
     * bandit is at 500 m puts the whole engagement inside the ownship marker,
     * and scaling on the fight while cruising empty space gives a 1 km plot of
     * nothing — each is right exactly when the other is wrong.
     */
    let reach = 0;
    for (const s of ships) {
      if (!s?.group || s === player || s.alive === false) continue;
      const d = flat(s.group.position, pp);
      if (d <= CONTACT_SCOPE_CAP) reach = Math.max(reach, d * 1.25);
    }
    const navFlat = active ? flat(active.position, pp) : 0;
    if (reach <= 0) reach = navFlat;
    const range = chooseRange(Math.max(600, reach));
    const scale = plotR / range;

    // ---- range rings -----------------------------------------------------
    ctx.save();
    ctx.strokeStyle = 'rgba(127,228,255,0.13)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, plotR * (i / 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    // Cardinal cross, dimmer still — the plot is north-up, not heading-up, so
    // these are a fixed world reference the pilot can turn against.
    ctx.strokeStyle = 'rgba(127,228,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(cx - plotR, cy); ctx.lineTo(cx + plotR, cy);
    ctx.moveTo(cx, cy - plotR); ctx.lineTo(cx, cy + plotR);
    ctx.stroke();
    ctx.restore();

    // Ring labels hang *inside* the outer ring. Placed outside they ran off the
    // panel edge and landed on top of whatever contact label was to the right.
    label(ctx, fmtDistance(range), cx + plotR - 3, cy - 4,
      { color: CY_DIM, size: 9, align: 'right' });
    label(ctx, fmtDistance(range / 2), cx + plotR * 0.5 - 3, cy - 4,
      { color: CY_DIM, size: 9, align: 'right', alpha: 0.6 });

    const toScreen = (p, out) => {
      out.x = cx + (p.x - pp.x) * scale;
      out.y = cy + (p.z - pp.z) * scale;
      return out;
    };
    const pt = { x: 0, y: 0 };

    /**
     * Clamp a plotted point onto the rim, reporting whether it had to move.
     *
     * Off-scale marks are pinned rather than dropped. Culling them meant that
     * the moment the scale tightened onto a dogfight, the nav point you were
     * flying to and the wing 20 km behind you both silently ceased to exist —
     * the plot looked authoritative and was lying by omission.
     */
    const pinToRim = (q) => {
      const dx = q.x - cx;
      const dy = q.y - cy;
      const d = Math.hypot(dx, dy);
      if (d <= plotR) return false;
      const k = plotR / (d || 1);
      q.x = cx + dx * k;
      q.y = cy + dy * k;
      return true;
    };

    // ---- nav course ------------------------------------------------------
    if (navs.length) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,176,74,0.42)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      let started = false;
      for (const n of navs) {
        if (!n.revealed && !n.active && !n.visited) continue;
        toScreen(n.position, pt);
        // The route is drawn unpinned and simply runs off the panel: bending a
        // leg onto the rim would draw a course the ship is not flying.
        if (started) ctx.lineTo(pt.x, pt.y); else { ctx.moveTo(pt.x, pt.y); started = true; }
      }
      ctx.stroke();
      ctx.restore();

      for (const n of navs) {
        if (!n.revealed && !n.active && !n.visited) continue;
        toScreen(n.position, pt);
        const navOff = pinToRim(pt);
        const on = n.active;
        const col = on ? AM : n.visited ? CY_DIM : 'rgba(255,176,74,0.55)';
        const r = on ? 7 : 5;
        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineWidth = on ? 1.8 : 1.2;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y - r); ctx.lineTo(pt.x + r, pt.y);
        ctx.lineTo(pt.x, pt.y + r); ctx.lineTo(pt.x - r, pt.y);
        ctx.closePath();
        ctx.stroke();
        if (on) {
          const pulse = 0.5 + 0.5 * Math.sin(time * 4);
          ctx.globalAlpha = 0.25 + pulse * 0.45 + flash * 0.3;
          ctx.fillStyle = AM;
          ctx.fill();
        }
        ctx.restore();
        // On the rim the label would hang off the panel; the NAV row along the
        // bottom already carries the name and range for the active point.
        if (!navOff) {
          label(ctx, String(n.name ?? `NAV ${n.index}`).toUpperCase(), pt.x + r + 4, pt.y + 3,
            { color: col, size: 10 });
        }
      }
    }

    // ---- contacts --------------------------------------------------------
    const hostileOf = game?.isHostile
      ? (s) => !!game.isHostile(player, s)
      : (s) => (s.faction ?? 'confed') !== (player.faction ?? 'confed');

    for (const s of ships) {
      if (!s?.group || s === player) continue;
      const dead = s.alive === false;
      toScreen(s.group.position, pt);
      const offScale = pinToRim(pt);
      const hostile = hostileOf(s);
      const col = dead ? 'rgba(120,140,150,0.5)' : hostile ? RD : GR;
      const dy = s.group.position.y - pp.y;
      const cap = isCapital(s);
      const r = offScale ? 2.8 : cap ? 6 : 3.6;

      ctx.save();
      ctx.globalAlpha = dead ? 0.45 : offScale ? 0.5 : 1;
      // Vertical separation, drawn as a stalk toward the plane the contact is
      // actually on. Without it a bandit 3 km above you plots as a merge.
      if (Math.abs(dy) > range * 0.02) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = 1;
        const stalk = clamp(dy * scale, -plotR * 0.5, plotR * 0.5);
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x, pt.y - stalk);
        ctx.stroke();
        ctx.globalAlpha = dead ? 0.45 : offScale ? 0.5 : 1;
      }
      ctx.fillStyle = col;
      if (hostile && !dead) {
        // Hostiles are a triangle, friendlies a disc: on a small plot in the
        // corner of a fight, shape survives where colour alone does not.
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y - r * 1.25);
        ctx.lineTo(pt.x + r * 1.1, pt.y + r * 0.85);
        ctx.lineTo(pt.x - r * 1.1, pt.y + r * 0.85);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      if (!offScale && (cap || (!dead && hostile && flat(s.group.position, pp) < range * 0.5))) {
        const name = String(s.callsign ?? s.name ?? s.classId ?? '').toUpperCase();
        if (name) label(ctx, name, pt.x + r + 3, pt.y + 3, { color: col, size: 9, alpha: 0.8 });
      }
    }

    // ---- own ship --------------------------------------------------------
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(heading);
    ctx.fillStyle = CY;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // ---- readouts --------------------------------------------------------
    const pad = 10;
    label(ctx, 'TACTICAL PLOT', pad, 17, { color: CY, size: 12, track: 2 });
    // Tracked text measures wider than its nominal width, so the title and a
    // right-aligned scale on the same baseline overprinted at panel widths under
    // ~260 px. The scale gets its own line.
    label(ctx, `SCALE ${fmtDistance(range)}`, pad, 30, { color: CY_DIM, size: 9, track: 1 });

    const hdg = ((heading * 180) / Math.PI + 360) % 360;
    const rows = [
      ['POS', `${fmtCoord(pp.x)}  ${fmtCoord(pp.y)}  ${fmtCoord(pp.z)}`],
      ['HDG', `${hdg.toFixed(0).padStart(3, '0')}°`],
    ];
    if (active) {
      rows.push(['NAV', `${String(active.name ?? '').toUpperCase()}  ${fmtDistance(dist3(active.position, pp))}`]);
    }
    let ry = h - pad - (rows.length - 1) * 14;
    for (const [k, v] of rows) {
      label(ctx, k, pad, ry, { color: CY_DIM, size: 10, track: 1 });
      label(ctx, v, pad + 34, ry, { color: PALETTE.text, size: 10, mono: true });
      ry += 14;
    }
  }

  // ------------------------------------------------------------------- utils
  const _f = { x: 0, y: 0, z: 0 };
  function _fwd(ship) {
    const q = ship.group.quaternion;
    // (0,0,-1) rotated by q, expanded so this costs no allocation per frame.
    const { x, y, z, w } = q;
    _f.x = -(2 * (x * z + w * y));
    _f.y = -(2 * (y * z - w * x));
    _f.z = -(1 - 2 * (x * x + y * y));
    return _f;
  }

  function flat(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
  function dist3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  function fmtCoord(v) {
    const km = v / 1000;
    return `${km >= 0 ? '+' : '-'}${Math.abs(km).toFixed(1)}`;
  }

  function isCapital(s) {
    const id = String(s?.classId ?? '');
    return /carrier|cruiser|destroyer|corvette|frigate|dreadnought|station|transport|leviathan|drayman/i.test(id)
      || (s?.stats?.length ?? 0) > 120;
  }

  /** Mission may be absent, mid-load, or throwing; the map must survive all three. */
  function safeNavs(mission) {
    try {
      const list = mission?.navPoints;
      if (!Array.isArray(list)) return [];
      return list.filter((n) => n?.position && Number.isFinite(n.position.x));
    } catch { return []; }
  }

  function label(ctx, str, x, y, { color = CY, size = 11, align = 'left', alpha = 1, track = 0, mono = false } = {}) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.font = `${mono ? 500 : 600} ${size}px ${mono ? 'ui-monospace, "SF Mono", Menlo, monospace' : '"Barlow Condensed", "Oswald", system-ui, sans-serif'}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    if (track > 0 && align === 'left') {
      let cxp = x;
      for (const ch of String(str)) {
        ctx.fillText(ch, cxp, y);
        cxp += ctx.measureText(ch).width + track;
      }
    } else {
      ctx.fillText(String(str), x, y);
    }
    ctx.restore();
  }

  // --------------------------------------------------------------------- api
  return {
    root,
    get isOpen() { return open; },
    toggle() { open = !open; root.style.display = open ? 'block' : 'none'; return open; },
    close() { open = false; root.style.display = 'none'; },
    update(dt) { if (open) draw(dt); },
    dispose() {
      for (const off of offs) { try { off(); } catch { /* already detached */ } }
      offs.length = 0;
      root.remove();
    },
  };
}
