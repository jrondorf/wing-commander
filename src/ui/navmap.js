/**
 * src/ui/navmap.js — the briefing-room nav display.
 *
 * A plan-view plot of the mission's nav points and the legs between them, drawn
 * to fit whatever coordinates the mission hands over. The point of it is that a
 * pilot can read the *shape* of the mission before flying it: where the fight
 * is, how far out the turn-around is, and how long the run home will be.
 *
 * Drawn every frame because the sweep, the pulse on the selected point and the
 * range-ring shimmer are what stop the briefing looking like a print-out. It is
 * a few hundred primitives; at briefing time nothing else is competing for the
 * frame.
 */
import { fitCanvas, fmtDistance } from './dom.js';
import { hexA } from './backdrop.js';
import { PALETTE } from './theme.js';

const CY = PALETTE.cyan;
const AM = PALETTE.amber;
const RD = PALETTE.red;

export function createNavMap(canvas) {
  let mission = null;
  let t = 0;
  let selected = 0;
  /** Fitting sweeps 36 orientations; cache it per route + panel size. */
  let projCache = null;

  function setMission(m) { mission = m; selected = 0; projCache = null; }
  function setSelected(i) { selected = i | 0; }

  /**
   * Fit the route into the canvas.
   *
   * A patrol course is usually a long thin line, and a raw XZ plot of one drops
   * it down the middle of a landscape panel with the labels stacked on top of
   * each other and two thirds of the display empty. So the plot is *rotated*:
   * the route's principal axis (the first eigenvector of its 2×2 covariance) is
   * aligned with the panel's long edge before fitting. Tactical plots are
   * oriented to the mission, not to an arbitrary world axis, so this is what a
   * real display would do — and it triples the usable label room.
   */
  function project(w, h) {
    const pts = mission?.navPoints ?? [];
    if (!pts.length) return null;

    const key = `${w}x${h}|${pts.length}|${pts.map((p) => `${p.x},${p.y}`).join(';')}`;
    if (projCache && projCache.key === key) return projCache.proj;

    let cx = 0; let cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= pts.length; cy /= pts.length;

    // Generous margin: nav labels sit above and below every marker.
    const padX = w * 0.14;
    const padY = h * 0.17;

    // Sweep candidate orientations and keep the one that fits *largest*. For a
    // balanced route that lands on the principal axis anyway; for a near-linear
    // patrol it picks the panel diagonal, which is both bigger and far easier
    // to label than a line pinned across the middle.
    let best = null;
    const STEPS = 36;
    for (let k = 0; k < STEPS; k++) {
      const ang = (k / STEPS) * Math.PI;
      const ca = Math.cos(-ang); const sa = Math.sin(-ang);
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (const p of pts) {
        const dx = p.x - cx; const dy = p.y - cy;
        const rx = dx * ca - dy * sa;
        const ry = dx * sa + dy * ca;
        if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
      }
      const scale = Math.min((w - padX * 2) / Math.max(1, maxX - minX),
        (h - padY * 2) / Math.max(1, maxY - minY));
      if (!best || scale > best.scale) {
        best = { scale, ca, sa, ox: (minX + maxX) / 2, oy: (minY + maxY) / 2 };
      }
    }

    const { scale, ca, sa, ox, oy } = best;
    const proj = {
      scale,
      toXY: (p) => {
        const dx = p.x - cx; const dy = p.y - cy;
        return [
          w / 2 + (dx * ca - dy * sa - ox) * scale,
          h / 2 + (dx * sa + dy * ca - oy) * scale,
        ];
      },
    };
    projCache = { key, proj };
    return proj;
  }

  function draw(dt) {
    // 1.25 rather than native: the plot redraws every frame for the sweep, and
    // at 2x on a 900-line screen that alone halved the briefing's frame rate.
    const fit = fitCanvas(canvas, { maxDpr: 1.25 });
    if (!fit) return;
    const { ctx, w, h } = fit;
    t += dt;

    ctx.clearRect(0, 0, w, h);
    // Deep well behind the plot.
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
    bg.addColorStop(0, 'rgba(10,26,34,0.85)');
    bg.addColorStop(1, 'rgba(3,7,11,0.92)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    drawGrid(ctx, w, h);

    const proj = project(w, h);
    if (!proj) {
      ctx.fillStyle = hexA(CY, 0.4);
      ctx.font = `${Math.round(h * 0.06)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('NAV DATA UNAVAILABLE', w / 2, h / 2);
      return;
    }

    drawSweep(ctx, w, h, t);
    // Occupancy list for label placement, rebuilt every frame.
    const taken = [];
    const legLabels = [];
    drawLegs(ctx, w, h, proj, legLabels);
    drawPoints(ctx, w, h, proj, t, taken);
    // Leg distances yield to nav labels: knowing *where* a point is matters
    // more than knowing how long the leg to it was.
    ctx.font = `${Math.max(9, Math.round(h * 0.036))}px ui-monospace, 'DejaVu Sans Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const lfs = Math.max(9, Math.round(h * 0.036));
    for (const L of legLabels) {
      const lx = clampLabel(ctx, L.text, L.x, w);
      const ly = place(ctx, L.text, lx, [L.y, L.y + lfs * 1.3, L.y - lfs * 1.3], lfs, taken);
      if (ly == null) continue;
      plate(ctx, L.text, lx, ly);
      ctx.fillStyle = hexA(CY, 0.68);
      ctx.fillText(L.text, lx, ly);
    }
    drawScale(ctx, w, h, proj);
    drawFrame(ctx, w, h);
  }

  function drawGrid(ctx, w, h) {
    const step = Math.max(24, Math.round(Math.min(w, h) / 12));
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA(CY, 0.055);
    ctx.beginPath();
    for (let x = (w / 2) % step; x < w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    for (let y = (h / 2) % step; y < h; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
    // Ecliptic cross-hairs.
    ctx.strokeStyle = hexA(CY, 0.14);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h / 2) + 0.5); ctx.lineTo(w, Math.round(h / 2) + 0.5);
    ctx.moveTo(Math.round(w / 2) + 0.5, 0); ctx.lineTo(Math.round(w / 2) + 0.5, h);
    ctx.stroke();
    // Range rings, so distance is legible without reading a label.
    ctx.strokeStyle = hexA(CY, 0.08);
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, (Math.min(w, h) / 2) * (i / 4.2), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawSweep(ctx, w, h, time) {
    const a = (time * 0.55) % (Math.PI * 2);
    const R = Math.hypot(w, h) * 0.6;
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, R);
    g.addColorStop(0, hexA(CY, 0.055));
    g.addColorStop(1, hexA(CY, 0));
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, -0.5, 0);
    ctx.closePath();
    ctx.translate(-w / 2, -h / 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  /** Lines and chevrons only; the distance labels are placed last (see draw). */
  function drawLegs(ctx, w, h, proj, pending) {
    const pts = mission.navPoints;
    ctx.lineWidth = 1.4;
    for (const leg of mission.legs) {
      const a = pts[leg.from]; const b = pts[leg.to];
      if (!a || !b) continue;
      const [x0, y0] = proj.toXY(a);
      const [x1, y1] = proj.toXY(b);
      const hot = a.hostile || b.hostile;
      ctx.strokeStyle = hexA(hot ? AM : CY, 0.55);
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -(t * 14) % 13;
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.setLineDash([]);

      // Direction chevron + leg length at the midpoint.
      const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2;
      const ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(ang);
      ctx.strokeStyle = hexA(hot ? AM : CY, 0.85);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-5, -4); ctx.lineTo(4, 0); ctx.lineTo(-5, 4);
      ctx.stroke();
      ctx.restore();

      // Offset the leg length *perpendicular* to the leg, and defer the actual
      // draw until the nav labels have claimed their space.
      if (Math.hypot(x1 - x0, y1 - y0) < 64) continue;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      pending.push({
        text: fmtDistance(dist),
        x: mx - Math.sin(ang) * 24,
        y: my + Math.cos(ang) * 24,
      });
    }
  }

  function drawPoints(ctx, w, h, proj, time, taken) {
    const pts = mission.navPoints;
    const R = Math.max(6, Math.min(w, h) * 0.026);
    pts.forEach((p, i) => {
      const [x, y] = proj.toXY(p);
      const col = p.hostile ? RD : p.kind === 'base' ? PALETTE.green : CY;

      if (p.hostile) {
        // Threat bubble: dashed, slowly rotating, so hostile nav points read
        // as a *volume* rather than a dot.
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(time * 0.4);
        ctx.strokeStyle = hexA(RD, 0.32);
        ctx.setLineDash([4, 7]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, R * 3.1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        ctx.setLineDash([]);
        const g = ctx.createRadialGradient(x, y, 0, x, y, R * 3.1);
        g.addColorStop(0, hexA(RD, 0.16));
        g.addColorStop(1, hexA(RD, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, R * 3.1, 0, Math.PI * 2); ctx.fill();
      }

      ctx.strokeStyle = col;
      ctx.fillStyle = hexA(col, 0.16);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      if (p.kind === 'base') {
        ctx.rect(x - R * 0.78, y - R * 0.78, R * 1.56, R * 1.56);
      } else if (p.kind === 'jump') {
        ctx.arc(x, y, R * 0.85, 0, Math.PI * 2);
      } else {
        ctx.moveTo(x, y - R); ctx.lineTo(x + R, y); ctx.lineTo(x, y + R); ctx.lineTo(x - R, y);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      if (p.kind === 'jump') {
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
          ctx.moveTo(x + Math.cos(a) * R * 0.9, y + Math.sin(a) * R * 0.9);
          ctx.lineTo(x + Math.cos(a) * R * 1.5, y + Math.sin(a) * R * 1.5);
        }
        ctx.stroke();
      }

      // Selection pulse.
      if (i === selected) {
        const pr = R * (1.7 + 0.35 * Math.sin(time * 3));
        ctx.strokeStyle = hexA(AM, 0.75);
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, pr, 0, Math.PI * 2); ctx.stroke();
      }

      // Labels: index tag above, name below.
      const fs = Math.max(9, Math.round(h * 0.040));
      ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      // Nav names run wider than the marker; clamp so a point near the edge
      // does not print half a callsign off the panel.
      const name = p.name.toUpperCase();
      const lx = clampLabel(ctx, name, x, w);
      // Nav names must claim space in the occupancy list like everything else.
      // This block previously drew at a fixed offset and registered nothing, so
      // two nav points close together printed their callsigns straight through
      // each other, and leg distances had nothing to avoid.
      const ny = place(ctx, name, lx, [
        y - R * 1.5,
        y - R * 1.5 - fs * 1.35,
        y - R * 1.5 - fs * 2.7,
        y + R * 1.5 + fs * 1.9,
      ], fs, taken);
      if (ny != null) {
        plate(ctx, name, lx, ny - fs * 0.4);
        ctx.fillStyle = hexA(col, 0.95);
        ctx.fillText(name, lx, ny);
      }
      ctx.textBaseline = 'top';
      ctx.font = `${Math.round(fs * 0.82)}px ui-monospace, 'DejaVu Sans Mono', monospace`;
      // The name already carries the nav number; the sub-label says what kind
      // of place it is, which is the thing the plot cannot show by shape alone.
      const sub = p.hostile ? 'THREAT' : p.kind === 'base' ? 'FRIENDLY'
        : p.kind === 'jump' ? 'JUMP POINT' : 'WAYPOINT';
      const subFs = Math.round(fs * 0.82);
      const sx2 = clampLabel(ctx, sub, x, w);
      const sy = place(ctx, sub, sx2, [
        y + R * 1.5,
        y + R * 1.5 + subFs * 1.35,
        y + R * 1.5 + subFs * 2.7,
      ], subFs, taken);
      if (sy != null) {
        plate(ctx, sub, sx2, sy);
        ctx.fillStyle = hexA(col, 0.62);
        ctx.fillText(sub, sx2, sy);
      }
    });
  }

  /**
   * Darken a text's footprint before drawing it. The plot has a grid, a sweep
   * and threat bubbles behind the labels; without this, half of them sit on a
   * bright ring and cannot be read.
   */
  function plate(ctx, text, x, y) {
    const m = ctx.measureText(text);
    const pad = 4;
    const wpx = m.width + pad * 2;
    const asc = m.actualBoundingBoxAscent || 8;
    const desc = m.actualBoundingBoxDescent || 3;
    const hpx = asc + desc + pad;
    // Honour whatever baseline the caller set, or the box lands off the glyphs.
    const top = ctx.textBaseline === 'middle' ? y - hpx / 2
      : ctx.textBaseline === 'top' ? y - pad * 0.5
        : y - asc - pad * 0.5;
    ctx.save();
    ctx.fillStyle = 'rgba(3,8,12,0.72)';
    ctx.fillRect(x - wpx / 2, top, wpx, hpx);
    ctx.restore();
  }

  /** Keep a centre-aligned label's box inside the panel. */
  function clampLabel(ctx, text, x, w) {
    const half = ctx.measureText(text).width / 2 + 6;
    return Math.max(half, Math.min(w - half, x));
  }

  const overlaps = (a, b) => !(a.x1 <= b.x0 || a.x0 >= b.x1 || a.y1 <= b.y0 || a.y0 >= b.y1);

  /** Box a centre-aligned label would occupy at (x, y) for the current font. */
  function labelBox(ctx, text, x, y, size) {
    const half = ctx.measureText(text).width / 2 + 5;
    return { x0: x - half, x1: x + half, y0: y - size * 0.9, y1: y + size * 0.35 };
  }

  /**
   * Place a label at the first candidate y that does not collide with anything
   * already on the plot.
   *
   * Two nav points a few kilometres apart project a few pixels apart, and their
   * names are twenty characters long — without this they print on top of each
   * other and the plot becomes unreadable exactly where the mission is densest.
   * Returns the chosen y, or null if every candidate collides.
   */
  function place(ctx, text, x, candidates, size, taken) {
    for (const y of candidates) {
      const box = labelBox(ctx, text, x, y, size);
      if (!taken.some((b) => overlaps(box, b))) { taken.push(box); return y; }
    }
    return null;
  }

  function drawScale(ctx, w, h, proj) {
    // Pick a round distance that is roughly a fifth of the plot width.
    const target = (w * 0.2) / proj.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((k) => k * pow).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    const px = nice * proj.scale;
    const x0 = w - px - 14; const y0 = h - 16;
    ctx.strokeStyle = hexA(CY, 0.55);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 4);
    ctx.stroke();
    ctx.font = `${Math.max(8, Math.round(h * 0.034))}px ui-monospace, 'DejaVu Sans Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = hexA(CY, 0.65);
    ctx.fillText(fmtDistance(nice), x0 + px / 2, y0 - 5);
  }

  function drawFrame(ctx, w, h) {
    ctx.strokeStyle = hexA(CY, 0.22);
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    const L = Math.min(w, h) * 0.07;
    ctx.strokeStyle = hexA(CY, 0.7);
    ctx.lineWidth = 1.6;
    for (const [cx, cy, sx, sy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * L);
      ctx.stroke();
    }
  }

  return { draw, setMission, setSelected, get selected() { return selected; } };
}
