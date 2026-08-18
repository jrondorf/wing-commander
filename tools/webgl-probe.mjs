import { chromium } from 'playwright';
const args = ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox','--no-sandbox'];
const b = await chromium.launch({ headless: true, args, executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('console', m => console.log('[console]', m.text()));
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.setContent(`<canvas id=c width=640 height=360></canvas><script>
const gl = document.getElementById('c').getContext('webgl2');
window.__info = gl ? {
  version: gl.getParameter(gl.VERSION),
  renderer: gl.getParameter(gl.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
  maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  floatLinear: !!gl.getExtension('OES_texture_float_linear'),
  colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
  aniso: !!gl.getExtension('EXT_texture_filter_anisotropic'),
  msaaMax: gl.getParameter(gl.MAX_SAMPLES),
} : null;
</script>`);
console.log(JSON.stringify(await p.evaluate(()=>window.__info), null, 2));
await b.close();
