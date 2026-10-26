import {chromium, webkit} from 'playwright' // usage: node docs/test-evidence/measure-cold-open.mjs <url> chromium|webkit returning  (env LAT=150 RELOAD=1 LOG=1);
const url = process.argv[2], engine = process.argv[3]||'chromium', mode = process.argv[4]||'returning';
const b = await (engine==='webkit'?webkit:chromium).launch();
const ctx = await b.newContext();
if (mode==='returning') await ctx.addInitScript(()=>{ if(!localStorage.getItem('dx_opts')) localStorage.setItem('dx_opts', JSON.stringify({genre:'Electronic',style:'Techno',y1:'1995',y2:'',startAt:'0',hideSeen:true,autoNext:true,playMode:'explore'})); });
const p = await ctx.newPage(); let t0 = Date.now(); const log = [];
if (process.env.LAT && engine==='chromium') { const c = await ctx.newCDPSession(p); await c.send('Network.emulateNetworkConditions',{offline:false,latency:Number(process.env.LAT),downloadThroughput:1.5e6/8*8,uploadThroughput:7.5e5}); }
p.on('request', r => { const u=r.url(); if (/discogs|oembed|iframe_api|www-widgetapi|embed\/|\.js$|ytimg/.test(u)) log.push([Date.now()-t0,'REQ',u.slice(0,110)]); });
p.on('requestfinished', r => { const u=r.url(); if (/discogs|oembed/.test(u)) log.push([Date.now()-t0,'DONE',u.slice(0,110)]); });
await p.goto(url, {waitUntil:'commit'});
const marks = {};
const poll = async (name, fn) => { const s=Date.now(); while(Date.now()-s<40000){ if (await p.evaluate(fn).catch(()=>false)) { marks[name]=Date.now()-t0; return; } await p.waitForTimeout(50);} marks[name]='timeout'; };
await Promise.all([
  poll('booted', ()=>window.crateBooted),
  poll('firstCard', ()=>document.querySelector('#feed .card:not(.gate)')),
  poll('dock', ()=>!document.getElementById('dock').hidden),
  poll('ytIframe', ()=>document.querySelector('#pA iframe')),
]);
await p.waitForTimeout(500);
console.log(engine, mode, 'cold', JSON.stringify(marks));
if (process.env.RELOAD) { await p.waitForTimeout(4000); await p.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));dispatchEvent(new Event('pagehide'));}); t0=Date.now(); await p.reload({waitUntil:'commit'}); for (const k in marks) delete marks[k];
  await Promise.all([poll('booted', ()=>window.crateBooted), poll('firstCard', ()=>document.querySelector('#feed .card:not(.gate)')), poll('dock', ()=>!document.getElementById('dock').hidden)]);
  console.log(engine, mode, 'reload', JSON.stringify(marks)); }
if (process.env.LOG) for (const l of log) console.log(l.join(' '));
await b.close();
