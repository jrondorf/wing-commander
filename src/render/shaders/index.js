/**
 * Barrel for the post-processing shader library.
 *
 * Every chunk is a plain template string, so anything in the project can compose
 * them (a cockpit MFD that wants the same ACES curve, a VFX pass that wants the
 * same YCoCg helpers) without importing the pipeline itself.
 *
 * Composition order matters — GLSL has no forward declarations:
 *   GLSL_COMMON  ->  GLSL_CATMULL_ROM  ->  GLSL_TONEMAP  ->  GLSL_GRADE  ->  pass
 */

export { FULLSCREEN_VERT, GLSL_COMMON, GLSL_CATMULL_ROM } from './common.glsl.js';
export { GLSL_TONEMAP, GLSL_GRADE } from './tonemap.glsl.js';
export { BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG } from './bloom.glsl.js';
export { TAA_FRAG } from './taa.glsl.js';
export { FXAA_FRAG } from './fxaa.glsl.js';
export { TILE_MAX_FRAG, NEIGHBOR_MAX_FRAG, MOTION_BLUR_FRAG } from './motionBlur.glsl.js';
export { VELOCITY_VERT, VELOCITY_FRAG, VELOCITY_BACKGROUND_FRAG } from './velocity.glsl.js';
export { GODRAY_MASK_FRAG, GODRAY_BLUR_FRAG } from './godrays.glsl.js';
export { STREAK_PREFILTER_FRAG, STREAK_BLUR_FRAG } from './streaks.glsl.js';
export { COMPOSITE_FRAG, DEBUG_VIEW_FRAG } from './composite.glsl.js';
export { generateLensDirtTexture } from './lensDirt.js';
