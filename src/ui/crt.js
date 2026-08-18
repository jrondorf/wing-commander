/**
 * src/ui/crt.js — the tube.
 *
 * Five stacked passes, all CSS (see theme.js for the rules):
 *   grille   aperture-grille RGB triad, screen-blended
 *   lines    scanlines, multiplied
 *   sweep    slow vertical refresh band
 *   flicker  mains-hum brightness jitter
 *   glass    curvature edge highlight, corner falloff and one off-axis reflection
 *
 * Order matters: the glass reflection must sit *above* the scanlines or the
 * screen looks like a printed transparency rather than something behind glass.
 */
import { el } from './dom.js';

export function createCRT() {
  return el('div.wc-crt', {}, [
    el('div.wc-crt__grille'),
    el('div.wc-crt__lines'),
    el('div.wc-crt__sweep'),
    el('div.wc-crt__flicker'),
    el('div.wc-crt__vignette'),
    el('div.wc-crt__glass'),
  ]);
}
