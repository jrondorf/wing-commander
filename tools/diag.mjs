import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, executablePath:'/opt/pw-browsers/chromium',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport:{width:1600,height:900} });
const errs=[];
p.on('console', m => { const t=m.text(); if(!/404 \(Not Found\)/.test(t)) console.log(`[${m.type()}]`, t.slice(0,300)); });
p.on('pageerror', e => { errs.push(e.message); console.log('[pageerror]', e.message.slice(0,400)); });
const url = process.argv[2];
await p.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
try { await p.waitForFunction(()=>window.__READY__===true||window.__FATAL__, null, {timeout:300000, polling:500}); }
catch(e){ console.log('WAIT FAILED:', e.message.slice(0,200)); }
const s = await p.evaluate(()=>({ fatal:window.__FATAL__??null, stats:window.__SHOT_STATS__??null }));
console.log(JSON.stringify(s,null,2));
await p.screenshot({ path: process.argv[3] });
await b.close();
