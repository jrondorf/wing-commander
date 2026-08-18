import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:1600,height:900} });
p.on('pageerror', e => console.log('[pageerror]', e.message.slice(0,300)));
p.on('console', m => { if (m.type()==='error' && !/404/.test(m.text())) console.log('[err]', m.text().slice(0,240)); });
await p.goto(process.argv[2], { waitUntil:'domcontentloaded', timeout:60000 });
// Menu path has no __READY__; wait for the UI root to gain children.
await p.waitForFunction(() => {
  const r = document.getElementById('ui-root');
  return r && r.children.length > 0;
}, null, { timeout: 240000, polling: 500 }).catch(e => console.log('WAIT:', e.message.slice(0,120)));
await new Promise(r=>setTimeout(r,2500));
// Optional key sequence, e.g. --keys Enter,Enter — drives the menu into a screen.
const ki = process.argv.indexOf('--keys');
if (ki > 0 && process.argv[ki+1]) {
  for (const k of process.argv[ki+1].split(',')) {
    await p.keyboard.press(k.trim());
    await new Promise(r=>setTimeout(r,2200));
  }
}
await new Promise(r=>setTimeout(r,2500));
console.log('ui-root children:', await p.evaluate(()=>document.getElementById('ui-root')?.children.length));
await p.screenshot({ path: process.argv[3] });
await b.close();
