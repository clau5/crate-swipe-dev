// Real startup/session UI with deterministic endpoints. No real credentials or remote writes.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {FakePlayer,songs,releases} from './fixture.js';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const base=process.env.BASE_URL || 'http://127.0.0.1:4173';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Tests require localhost');
const browser=await (process.env.BROWSER==='webkit'?webkit:chromium).launch({headless:true});
const output='test-results/'+(process.env.BROWSER==='webkit'?'webkit/':'');await mkdir(output,{recursive:true});
const results=[],errors=[],shared=new Set();
async function check(name,fn){await fn();results.push(name);console.log('PASS '+name);}
async function setup({existing=false,unavailable=false,dry=false}={}) {
  const context=await browser.newContext({viewport:{width:402,height:874},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(15000);
  const accounts=new Map([['alice',new Map(existing?[[11001,501],[1003,503]]:[])],['bob',new Map()]]),writes=[],personalReads=[],fail=new Set();
  page.on('pageerror',e=>errors.push(e.message));
  if(existing)await context.addInitScript(item=>{
    const key='crate_session_v1:alice';if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,started:1,items:[{...item,wantedReleaseId:item.releaseId}]}));
  },songs[2]);
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());let body,status=200;
    if(url.origin===new URL(base).origin && url.pathname==='/config.js')return route.fulfill({contentType:'text/javascript',body:"export const sharedCatalogueToken='test-shared-token';"});
    else if(url.origin===new URL(base).origin && url.pathname.startsWith('/api/'))throw Error('Static guest flow must not require a backend');
    else if(request.url().startsWith(base))return route.continue();
    else if(url.hostname==='www.youtube.com'&&url.pathname==='/iframe_api')return route.fulfill({contentType:'text/javascript',body:`window.YT={Player:class extends (${FakePlayer.toString()}){constructor(id,options){super(options.events)}}};window.onYouTubeIframeAPIReady&&window.onYouTubeIframeAPIReady();`});
    else if(url.hostname==='www.youtube.com'&&url.pathname==='/oembed')body={type:'video'};
    else if(url.hostname==='images.example.test')return route.fulfill({contentType:'image/png',body:await readFile(new URL('./reference-cover.png',import.meta.url))});
    else if(url.hostname==='api.discogs.com') {
      const token=request.headers().authorization?.replace('Discogs token=',''),user=token==='token-alice'?'alice':token==='token-bob'?'bob':null;
      if(token==='test-shared-token') {
        if(url.pathname==='/database/search') {
          if(unavailable)return route.fulfill({status:403,contentType:'application/json',body:'{}'});
          body={pagination:{pages:1,items:2},results:songs.slice(0,2).map(s=>({id:s.releaseId,master_id:s.masterId,type:'release',title:s.artist+' - '+s.releaseTitle,cover_image:'https://images.example.test/cover.png'}))};
        } else if(url.pathname.startsWith('/releases/'))body=releases.get(Number(url.pathname.split('/').at(-1)));
        else if(url.pathname==='/oauth/identity')body={username:'throwaway'};
        else if(/^\/users\/throwaway\/wants\/\d+$/.test(url.pathname)) {assert.equal(request.method(),'PUT');shared.add(Number(url.pathname.split('/').at(-1)));body={};}
        else throw Error('Guest requested an unsupported shared account endpoint');
      }
      else if(url.pathname==='/oauth/identity') {body=user?{username:user}:{};status=user?200:401;}
      else {
        assert.ok(user,'personal requests require a verified personal token');
        assert.ok(url.pathname.startsWith('/users/'+user+'/'),'token cannot target a different account');
        if(request.method()==='GET') {personalReads.push(url.pathname);body={pagination:{pages:1},wants:[...accounts.get(user)].map(([id,master_id])=>({id,basic_information:{master_id}}))};}
        else {
          const id=Number(url.pathname.split('/').at(-1));writes.push({method:request.method(),user,id});
          if(fail.has(id)) {status=403;body={};}
          else {if(request.method()==='PUT')accounts.get(user).set(id,releases.get(id)?.master_id || 0);else accounts.get(user).delete(id);body={};}
        }
      }
    } else return route.abort();
    return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(base+(dry?'/?dryrun=1':''));await page.locator('#pick').waitFor({state:'visible'});
  return {context,page,accounts,writes,personalReads,fail};
}
async function dig(page){await page.locator('#goBtn').click();await page.locator('#dock').waitFor({state:'visible'});await page.locator('#heart:not(:disabled)').waitFor();}
async function likeTwo(page){
  await dig(page);await page.waitForFunction(()=>document.querySelectorAll('.card').length===2);
  await page.locator('#heart').click();const before=await page.locator('#track').innerText();
  await page.locator('body').click({position:{x:5,y:5}});await page.keyboard.press('ArrowDown');
  await page.waitForFunction(before=>document.querySelector('#track').textContent!==before,before);
  await page.locator('#heart').click();await page.locator('#sessionButton').click();await page.locator('[data-play="1"]').waitFor();
}
async function connect(page,token){await page.locator('#syncGuest').click();await page.locator('#tok').fill(token);await page.locator('#saveTok').click();}
try {
  await check('guest startup, local persistence, filter changes and cancel keep the same finds/playback',async()=>{
    const t=await setup(),{page}=t;
    try {
      assert.equal(await page.locator('#setup').isVisible(),false);await dig(page);await page.locator('#heart').click();
      await page.locator('#sessionButton').click();assert.equal(await page.locator('[data-play]').count(),1);assert.equal(t.personalReads.length,0);
      await page.locator('[data-play="0"]').click();await page.locator('#seek').fill('500');
      const track=await page.locator('#track').innerText(),time=await page.locator('#elapsed').innerText();
      await page.locator('#syncGuest').click();await page.locator('#closeSetup').click();
      assert.equal(await page.locator('#session').isVisible(),true);assert.equal(await page.locator('#track').innerText(),track);assert.equal(await page.locator('#elapsed').innerText(),time);
      await page.screenshot({path:output+'guest-review-mobile.png'});
      await page.reload();await page.locator('#dock').waitFor({state:'visible'});await page.locator('#sessionButton').click();assert.equal(await page.locator('[data-play]').count(),1);
      await page.locator('#closeSession').click();await page.locator('#chip').click();await page.locator('#y1').fill('2002');await page.locator('#goBtn').click();
      await page.locator('#dock').waitFor({state:'visible'});await page.locator('#sessionButton').click();assert.equal(await page.locator('[data-play]').count(),1);
      assert.equal(t.writes.length,0);assert.equal(t.personalReads.length,0);
    } finally {await t.context.close();}
  });
  await check('a second guest does not inherit communal likes or the first visitor’s session',async()=>{
    const t=await setup();try{await dig(t.page);assert.equal(await t.page.locator('#heart').getAttribute('aria-pressed'),'false');await t.page.locator('#sessionButton').click();assert.equal(await t.page.locator('[data-play]').count(),0);assert.equal(t.personalReads.length,0);}finally{await t.context.close();}
  });
  await check('personal connection merges existing wants/session, keeps alternate pressings and never deletes during import',async()=>{
    const t=await setup({existing:true}),{page}=t;
    try {
      await likeTwo(page);await connect(page,'bad-token');await page.locator('#saveTok:not(:disabled)').waitFor();assert.equal(await page.locator('#setup').isVisible(),true);assert.equal(t.writes.length,0);
      await page.locator('#tok').fill('token-alice');await page.locator('#saveTok').click();await page.locator('#session').waitFor({state:'visible'});
      assert.equal(await page.locator('[data-play]').count(),3);assert.equal(await page.locator('#syncGuest').isVisible(),false);
      assert.deepEqual(t.writes,[{method:'PUT',user:'alice',id:1002}]);assert.equal(t.accounts.get('alice').has(11001),true);
      await page.reload();await page.locator('#sessionButton').click();await page.waitForFunction(()=>document.querySelectorAll('[data-play]').length===3);
      await page.screenshot({path:output+'guest-synced-mobile.png'});
      await page.locator('#closeSession').click();await page.locator('#chip').click();await page.locator('#changeTok').click();await page.locator('#tok').fill('token-bob');await page.locator('#saveTok').click();
      await page.locator('#session').waitFor({state:'visible'});
      await page.waitForFunction(()=>document.querySelector('#sessionConnection').textContent==='Connected as @bob');
      await page.locator('#syncGuest').waitFor({state:'hidden'});
      assert.equal(await page.locator('[data-play]').count(),2);assert.deepEqual([...t.accounts.get('bob').keys()].sort(),[1001,1002]);
      assert.ok(t.writes.every(w=>w.method==='PUT'));
    } finally {await t.context.close();}
  });
  await check('partial personal sync survives reload and retries only failed records',async()=>{
    const t=await setup(),{page}=t;t.fail.add(1002);
    try {
      await likeTwo(page);await connect(page,'token-alice');await page.locator('#session').waitFor({state:'visible'});
      assert.equal(await page.locator('[data-play]').count(),2);assert.equal(await page.locator('#syncGuest').isVisible(),true);
      assert.match(await page.locator('#sessionRows').innerText(),/Not saved/);
      await page.reload();await page.locator('#sessionButton').click();await page.waitForFunction(()=>document.querySelectorAll('[data-play]').length===2);
      t.fail.clear();await page.locator('#syncGuest').click();await page.locator('#syncGuest').waitFor({state:'hidden'});
      assert.equal(t.writes.filter(w=>w.id===1001).length,1);assert.equal(t.writes.filter(w=>w.id===1002).length,2);assert.ok(t.writes.every(w=>w.method==='PUT'));
      await page.locator('#newSession').click();assert.equal(await page.locator('[data-play]').count(),0);assert.equal(t.accounts.get('alice').size,2);
    } finally {await t.context.close();}
  });
  await check('unavailable shared access gives an actionable connection path without erasing finds',async()=>{
    const t=await setup({unavailable:true}),{page}=t;
    try{await page.locator('#goBtn').click();await page.locator('#emptyAction').waitFor({state:'visible'});assert.equal(await page.locator('#emptyAction').innerText(),'Connect Discogs');assert.match(await page.locator('#emptyMsg').innerText(),/Guest discovery is unavailable/);await page.locator('#emptyAction').click();assert.equal(await page.locator('#setup').isVisible(),true);}finally{await t.context.close();}
  });
  assert.deepEqual(errors,[]);
  await writeFile(output+'guest-browser-report.json',JSON.stringify({browser:process.env.BROWSER||'chromium',results,errors},null,2));
  console.log(`${results.length} guest browser checks passed.`);
} finally {await browser.close();}
