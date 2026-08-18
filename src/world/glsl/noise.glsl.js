/**
 * GPU-side siblings of `src/procgen/noise.js`.
 *
 * `noise.js` is the canonical kernel set and every CPU generator in this module
 * calls it directly (asteroid displacement, starfield distribution, ring bands,
 * debris shapes). But a fragment shader cannot call JavaScript, and the nebula
 * cubemap alone is 6.3 M texels of multi-octave 3D noise — three orders of
 * magnitude more work than the CPU can absorb at load time.
 *
 * So this file mirrors the same fractal *family* — quintic-faded gradient noise,
 * fbm / ridged / billow with identical parameter semantics (octaves, gain 0.5,
 * lacunarity ~2, per-octave decorrelation offset) — using a simplex basis, which
 * evaluates 4 gradient corners in 3D instead of 8 and is roughly twice as fast on
 * a GPU for the same visual character. Anything baked on the CPU still goes
 * through `noise.js` so the two stay in the same visual family.
 *
 * Basis: Ashima Arts / Stefan Gustavson simplex noise (public domain, MIT).
 */

export const NOISE_GLSL = /* glsl */ `
vec3 wcMod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 wcMod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 wcPermute(vec4 x){ return wcMod289(((x * 34.0) + 1.0) * x); }
vec4 wcTaylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

/** 3D simplex gradient noise, ~[-1,1]. */
float wcNoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = wcMod289(i);
  vec4 p = wcPermute(wcPermute(wcPermute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = wcTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/** Fractional Brownian motion — mirrors fbm3() in procgen/noise.js. ~[-1,1]. */
float wcFbm(vec3 p, int oct) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += amp * wcNoise(p);
    norm += amp;
    amp *= 0.5;
    p = p * 2.03 + vec3(17.13, 9.71, 23.37);
  }
  return sum / norm;
}

/** Ridged multifractal — sharp creases. Mirrors ridged3(). [0,1]. */
float wcRidged(vec3 p, int oct, float sharpness) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(wcNoise(p));
    n = pow(n, 1.0 + sharpness);
    sum += amp * n;
    norm += amp;
    amp *= 0.5;
    p = p * 2.11 + vec3(31.7, 13.3, 7.9);
  }
  return sum / norm;
}

/** Billow — puffy inverse of ridged. Mirrors billow2()'s character in 3D. [0,1]. */
float wcBillow(vec3 p, int oct) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += amp * abs(wcNoise(p));
    norm += amp;
    amp *= 0.5;
    p = p * 2.07 + vec3(11.9, 27.3, 5.1);
  }
  return sum / norm;
}

vec3 wcHash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

/** 3D cellular noise. x = F1, y = F2, z = per-cell random value. */
vec3 wcWorley(vec3 x) {
  vec3 ip = floor(x), fp = fract(x);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 g = vec3(float(i), float(j), float(k));
        vec3 o = wcHash33(ip + g);
        vec3 r = g + o - fp;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; id = o.x; }
        else if (d < f2) { f2 = d; }
      }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

float wcSat(float x) { return clamp(x, 0.0, 1.0); }
vec3  wcSat(vec3 x)  { return clamp(x, 0.0, 1.0); }
`;

/** Rotation-by-euler helper shared by the generators. */
export const ROT_GLSL = /* glsl */ `
mat3 wcRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 wcRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
`;
