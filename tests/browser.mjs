// End-to-end checks against the localhost fixture only. No real credentials or remote writes.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {FakePlayer, releases, songs} from './fixture.js';
const {chromium, webkit} = createRequire(import.meta.url)('playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:4173';
if (!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('Browser tests require localhost');
const output = process.env.BROWSER==='webkit' ? 'test-results/webkit' : 'test-results'; await mkdir(output,{recursive:true});
const options = {headless:true};
if (process.env.CHROME_PATH) options.executablePath=process.env.CHROME_PATH;
const browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch(options);
const results = [], errors = [], requests = [];
const context = await browser.newContext({viewport:{width:402,height:874},reducedMotion:'reduce'});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(15000);
page.on('pageerror',e=>errors.push(e.message));
page.on('request',request=>{if(!request.url().startsWith(base)) requests.push(request.url());});
await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
async function check(name,fn){await fn();results.push(name);console.log('PASS '+name);}
async function open(query='fixture=1') {await page.goto(base+'/?'+query);await page.waitForFunction(()=>!!window.crateFixture?.playing.song);await page.evaluate(()=>document.fonts.ready);}
async function calls(){return page.evaluate(()=>window.crateFixture.api.calls.filter(c=>c.method!=='GET'));}
try {
  await check('unavailable videos are filtered before their cards enter the feed',async()=>{
    await open('fixture=1&unavailable=aaaaaaaaaaa,bbbbbbbbbbb');
    assert.equal(await page.locator('.card').count(),2);
    assert.equal(await page.locator('#track').innerText(),'Somewhere new');
    assert.equal(await page.locator('.card[aria-label="Tried and true"]').count(),0);
    assert.equal(await page.locator('.card[aria-label="A quiet place"]').count(),0);
    assert.equal(await page.locator('#status').innerText(),'');
  });
  await check('a metadata outage keeps usable tracks without a warning or a false blacklist',async()=>{
    await open('fixture=1&probe=offline');assert.equal(await page.locator('.card').count(),4);
    assert.equal(await page.locator('#track').innerText(),'Tried and true');assert.equal(await page.locator('#status').innerText(),'');
  });
  await check('late unavailability removes the failed card quietly and remembers it on reload',async()=>{
    await open();await page.locator('#sound').click();
    await page.evaluate(()=>window.crateFixture.players[0].events.onError({data:100}));
    await page.waitForFunction(()=>window.crateFixture.playing.song?.vid==='bbbbbbbbbbb');
    assert.equal(await page.locator('.card').count(),3);assert.equal(await page.locator('.card[aria-label="Tried and true"]').count(),0);
    assert.equal(await page.locator('#status').innerText(),'');assert.equal((await calls()).length,0);
    // DOM indices changed: the new active card still responds to a pause tap.
    await page.locator('.card .art').first().click();await page.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===2);
    await page.reload();await page.waitForFunction(()=>!!window.crateFixture?.playing.song);
    assert.equal(await page.locator('.card[aria-label="Tried and true"]').count(),0);
    await page.evaluate(()=>localStorage.removeItem('dx_stats'));
  });
  await check('temporary or configuration playback errors do not blacklist tracks or jump the feed',async()=>{
    await open();
    for(const code of [5,153]) {
      await page.evaluate(code=>window.crateFixture.players[0].events.onError({data:code}),code);
      assert.equal(await page.locator('#track').innerText(),'Tried and true');assert.equal(await page.locator('.card').count(),4);
      assert.match(await page.locator('#status').innerText(),/couldn’t play/);
    }
    await page.reload();await page.waitForFunction(()=>!!window.crateFixture?.playing.song);
    assert.equal(await page.locator('.card').count(),4);await page.evaluate(()=>localStorage.removeItem('dx_stats'));
  });
  await check('an exhausted playable feed stops cleanly instead of cycling through dead cards',async()=>{
    await open('fixture=1&unavailable=bbbbbbbbbbb,ccccccccccc,ddddddddddd');
    await page.evaluate(()=>window.crateFixture.players[0].events.onError({data:100}));
    assert.equal(await page.locator('.card').count(),0);assert.equal(await page.locator('#dock').isVisible(),false);
    assert.match(await page.locator('#emptyMsg').innerText(),/No more playable/);assert.equal(await page.locator('#status').innerText(),'');
    await page.evaluate(()=>localStorage.removeItem('dx_stats'));
  });
  await open();
  await check('a paused feed stays paused after repeated release previews',async()=>{
    await page.locator('#sound').click();
    await page.locator('.card .art').first().click();
    await page.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===2);
    for(let i=0;i<2;i++) {
      await page.locator('.release-meta').first().click();
      await page.locator('[data-track="1"]').click();
      await page.waitForFunction(()=>window.crateFixture.playing.source==='release');
      await page.locator('#closeRelease').click();
      assert.equal(await page.evaluate(()=>[2,5].includes(window.crateFixture.players[0].getPlayerState())),true,'preview must restore a paused feed');
      // The real API sends a later CUED event after restoring a paused track.
      await page.evaluate(()=>window.crateFixture.players[0].emitState(5));
      assert.equal(await page.locator('#paused').isVisible(),true,'cued paused track keeps its pause indicator');
    }
    await open();
  });
  await check('one sound tap, then every swipe and auto-next autoplays with sound (iOS gesture model)',async()=>{
    // Model iOS: unmuted playback is refused unless this player saw a real user gesture once.
    await page.evaluate(()=>{
      const players=window.crateFixture.players;
      window.crateIOS={refused:0,playerCount:players.filter(Boolean).length};
      for(const q of players.filter(Boolean)) {
        q.gestureOK=false;
        const allowed=()=>q.muted||q.gestureOK||!!navigator.userActivation?.isActive;
        q.playVideo=function(){if(!allowed()){window.crateIOS.refused++;return this.emitState(2);}if(!this.muted)this.gestureOK=true;this.emitState(1);};
        q.loadVideoById=function({videoId,startSeconds=0}){const ok=allowed();if(ok&&!this.muted)this.gestureOK=true;if(!ok)window.crateIOS.refused++;this.vid=videoId;this.time=startSeconds;queueMicrotask(()=>this.emitState(ok?1:2));};
        q.playVideoAt=function(i){const ok=allowed();if(!ok)window.crateIOS.refused++;this.idx=i;this.vid=this.list[i];this.time=0;queueMicrotask(()=>this.emitState(ok?1:2));};
        q.loadPlaylist=function({playlist,index=0,startSeconds=0}){const ok=allowed();if(ok&&!this.muted)this.gestureOK=true;if(!ok)window.crateIOS.refused++;this.loads++;this.list=[...playlist];this.idx=index;this.vid=this.list[index];this.time=startSeconds;queueMicrotask(()=>this.emitState(ok?1:2));};
      }
    });
    assert.equal(await page.evaluate(()=>window.crateIOS.playerCount),1,'exactly one YouTube player');
    await page.locator('#sound').click();
    const expectSound=async i=>{
      await page.waitForFunction(i=>window.crateFixture.active===i,i);
      await page.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===1);
      const state=await page.evaluate(()=>{const p=window.crateFixture.players[0];return {vid:p.vid,song:window.crateFixture.playing.song.vid,muted:p.isMuted()};});
      assert.equal(state.vid,state.song);assert.equal(state.muted,false);
      assert.equal(await page.locator('#sound').isVisible(),false,'no per-card sound button');
      assert.equal(await page.locator('.unlock').count(),0);assert.equal(await page.locator('#hint').isVisible(),false);
    };
    await expectSound(0);
    for(const i of [1,2]) {await page.locator('#feed').evaluate((el,i)=>el.scrollTop=874*i,i);await page.waitForTimeout(150);await expectSound(i);}
    // A track ending moves to the next card on its own, still with sound.
    await page.evaluate(()=>window.crateFixture.players[0].emitState(0));await expectSound(3);
    await page.locator('#feed').evaluate(el=>el.scrollTop=874);await page.waitForTimeout(150);await expectSound(1);
    assert.equal(await page.evaluate(()=>window.crateIOS.refused),0,'iOS never refused sound after the first tap');
    await open();
  });
  await check('explore mode (default): each swipe loads one video and auto-next still runs from the page',async()=>{
    await page.locator('#sound').click();
    await page.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===1);
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].getPlaylist()),null,'no queue in explore mode');
    assert.ok(await page.locator('.card').count()<=4,'explore keeps the light 4-card buffer');
    await page.locator('#feed').evaluate(el=>el.scrollTop=874);await page.waitForFunction(()=>window.crateFixture.active===1);
    await page.waitForFunction(()=>window.crateFixture.players[0].vid==='bbbbbbbbbbb');
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].history.at(-1)),'v:bbbbbbbbbbb');
    await page.evaluate(()=>window.crateFixture.players[0].emitState(0));
    await page.waitForFunction(()=>window.crateFixture.active===2);
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].vid),'ccccccccccc');
    // Switching to Run in the filters sheet keeps the song and the dig, and hands the player a queue.
    await page.locator('#chip').click();await page.locator('#playMode').selectOption('run');
    await page.waitForFunction(()=>window.crateFixture.players[0].getPlaylist()?.[0]==='ccccccccccc');
    assert.equal(await page.evaluate(()=>window.crateFixture.active),2);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dx_opts')).playMode),'run');
    await page.locator('#closePick').click();
    await page.evaluate(()=>localStorage.removeItem('dx_opts'));await open();
  });
  await check('feed auto-next is chained by the player playlist, not by a reload (background-safe)',async()=>{
    await page.evaluate(()=>localStorage.setItem('dx_opts',JSON.stringify({playMode:'run'})));await open();
    await page.locator('#sound').click();
    await page.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===1);
    const ids=await page.evaluate(()=>window.crateFixture.players[0].getPlaylist());
    assert.deepEqual(ids,['aaaaaaaaaaa','bbbbbbbbbbb','ccccccccccc','ddddddddddd'],'one playlist: current card then upcoming cards');
    const loads=await page.evaluate(()=>window.crateFixture.players[0].loads);
    for(const [i,vid,title] of [[1,'bbbbbbbbbbb','A quiet place'],[2,'ccccccccccc','Somewhere new']]) {
      await page.evaluate(()=>window.crateFixture.players[0].emitState(0));
      await page.waitForFunction(i=>window.crateFixture.active===i,i);
      assert.equal(await page.evaluate(()=>window.crateFixture.playing.song.vid),vid);
      assert.equal(await page.locator('#track').innerText(),title);
      assert.equal(await page.evaluate(()=>window.crateFixture.players[0].isMuted()),false);
      assert.match(await page.evaluate(()=>document.querySelector('#backdrop').style.backgroundImage),/reference-cover/);
      assert.equal(await page.evaluate(vid=>JSON.parse(localStorage.getItem('dx_seen')).includes(vid),vid),true);
      const offset=await page.evaluate(i=>Math.abs(document.querySelector('#feed').scrollTop-document.querySelectorAll('.card')[i].offsetTop),i);
      assert.ok(offset<=1,'feed scrolled to the playing card');
    }
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].loads),loads,'player advanced itself; the app never reloaded it: '+await page.evaluate(()=>JSON.stringify(window.crateFixture.players[0].history)));
    assert.equal(await page.evaluate(()=>window.crateFixture.active),2,'no double advance');
    // A swipe to a card already in the queue jumps there (playVideoAt) instead of rebuilding it.
    await page.locator('#feed').evaluate(el=>el.scrollTop=0);await page.waitForFunction(()=>window.crateFixture.active===0);
    await page.waitForFunction(()=>window.crateFixture.players[0].vid==='aaaaaaaaaaa');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.crateFixture.active),0,'a stale report from the old song must not pull the feed back');
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].loads),loads,'in-queue swipe: no reload');
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].history.at(-1)),'at:aaaaaaaaaaa');
    assert.deepEqual(await page.evaluate(()=>window.crateFixture.players[0].getPlaylist()),ids);
    // The chain keeps running from the jumped-to card.
    await page.evaluate(()=>window.crateFixture.players[0].emitState(0));await page.waitForFunction(()=>window.crateFixture.active===1);
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].loads),loads);
    // A swipe with too little queue left behind the target rebuilds it from that card.
    await page.locator('#feed').evaluate(el=>el.scrollTop=874*3);await page.waitForFunction(()=>window.crateFixture.active===3);
    await page.waitForFunction(()=>window.crateFixture.players[0].getPlaylist()?.[0]==='ddddddddddd');
    await page.evaluate(()=>localStorage.removeItem('dx_opts'));await open();
  });
  await check('returning from the background syncs a moved chain or restarts an ended one',async()=>{
    await page.evaluate(()=>localStorage.setItem('dx_opts',JSON.stringify({playMode:'run'})));await open();
    await page.locator('#sound').click();await page.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===1);
    // JS was suspended: the player moved two songs on without any event reaching the page.
    await page.evaluate(()=>{const p=window.crateFixture.players[0];p.idx=2;p.vid=p.list[2];p.state=1;document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>window.crateFixture.active===2);
    assert.equal(await page.locator('#track').innerText(),'Somewhere new');
    // The chain ran dry while hidden: pageshow restarts playback on the next card.
    await page.evaluate(()=>{const p=window.crateFixture.players[0];p.list=null;p.state=0;window.dispatchEvent(new Event('pageshow'));});
    await page.waitForFunction(()=>window.crateFixture.active===3);
    await page.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===1);
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].vid),'ddddddddddd');
    await page.evaluate(()=>localStorage.removeItem('dx_opts'));await open();
  });
  await check('turning auto-next off keeps single-video playback with no queue',async()=>{
    await page.evaluate(()=>{localStorage.setItem('dx_opts',JSON.stringify({autoNext:false}));});await open();
    await page.locator('#sound').click();await page.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===1);
    assert.equal(await page.evaluate(()=>window.crateFixture.players[0].getPlaylist()),null);
    await page.evaluate(()=>window.crateFixture.players[0].emitState(0));await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.crateFixture.active),0);
    await page.evaluate(()=>localStorage.removeItem('dx_opts'));await open();
  });
  await check('the YouTube player is never visible: playing, paused, buffering, ended, error, mid-swipe, unlock',async()=>{
    // Paint the player area magenta through a stand-in iframe, then look for magenta pixels on screen.
    await page.evaluate(()=>{const f=document.createElement('iframe');f.srcdoc='<body style="margin:0;background:#f0f"></body>';document.querySelector('#yt0').append(f);});
    await page.locator('#pA iframe').evaluate(f=>new Promise(r=>f.contentDocument?.readyState==='complete'?r():f.addEventListener('load',r,{once:true})));
    const magenta=async label=>{
      const shot=(await page.screenshot()).toString('base64');
      return page.evaluate(async b64=>{const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();
        const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);
        const d=x.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4) if(d[i]>200&&d[i+1]<60&&d[i+2]>200) n++;return n;},shot);
    };
    const visible=async label=>assert.ok(await magenta()<20,'player visible while '+label);
    // Sanity: the detector does see the player when it is exposed.
    await page.addStyleTag({content:'#pA.expose{z-index:99!important}#pA.expose .shield{display:none}'});
    await page.evaluate(()=>document.querySelector('#pA').classList.add('expose'));
    assert.ok(await magenta()>1000,'detector should see an exposed player');
    await page.evaluate(()=>document.querySelector('#pA').classList.remove('expose'));
    const p='window.crateFixture.players[0]';
    await page.locator('#sound').click();await visible('playing');
    for(const [state,label] of [[2,'paused'],[3,'buffering'],[-1,'unstarted'],[5,'cued']]) {await page.evaluate(`${p}.emitState(${state})`);await visible(label);}
    await page.locator('#feed').evaluate(el=>el.scrollTop=437);await page.waitForTimeout(100);await visible('mid-swipe');
    await page.locator('#feed').evaluate(el=>el.scrollTop=874);await page.waitForFunction(()=>window.crateFixture.active===1);await visible('next card');
    await page.evaluate(`${p}.events.onError({data:150})`);await page.waitForTimeout(100);await visible('error');
    await page.evaluate(`${p}.emitState(0)`);await page.waitForTimeout(100);await visible('ended');
    // iOS refusing sound arms the transparent tap target over the cover: still no video.
    await page.evaluate(`${p}.playVideo=function(){this.emitState(2);};${p}.loadVideoById=function({videoId}){this.vid=videoId;queueMicrotask(()=>this.emitState(2));};${p}.loadPlaylist=function({playlist}){this.list=[...playlist];this.idx=0;this.vid=playlist[0];queueMicrotask(()=>this.emitState(2));};`);
    await page.evaluate(()=>window.crateFixture.players[0].events.onStateChange({data:2}));
    await page.locator('#feed').evaluate(el=>el.scrollTop=0);await page.waitForFunction(()=>window.crateFixture.active===0);
    await page.locator('.unlock').waitFor();await visible('waiting for the sound tap');
    await page.screenshot({path:output+'/never-visible-unlock.png'});
    await page.evaluate(()=>localStorage.removeItem('dx_stats'));
    await open();
  });
  await check('pause during sound verification never reveals the YouTube tile',async()=>{
    await page.locator('#sound').click();
    await page.locator('.card .art').first().click();
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(()=>window.crateFixture.players.find(p=>p.vid===window.crateFixture.playing.song.vid).getPlayerState()),2);
    assert.equal(await page.locator('.unlock').count(),0);
    assert.equal(await page.locator('#hint').isVisible(),false);
    await page.screenshot({path:output+'/mobile-paused.png'});
    // Resuming must reach the player in the click handler, without a delayed gesture.
    await page.locator('.card .art').first().click();
    assert.equal(await page.evaluate(()=>window.crateFixture.players.find(p=>p.vid===window.crateFixture.playing.song.vid).getPlayerState()),1);
    await page.screenshot({path:output+'/mobile-pause-resume.png'});
    await open();
  });
  await check('first-time blocked sound can still unlock over the active cover',async()=>{
    await page.locator('#feed').evaluate(el=>el.scrollTop=874);
    await page.waitForFunction(()=>window.crateFixture.active===1);
    await page.evaluate(()=>{
      const p=window.crateFixture.players.find(p=>p.vid===window.crateFixture.playing.song.vid);
      p.playVideo=function(){this.emitState(2);};
    });
    await page.locator('#sound').click();await page.locator('.unlock').waitFor();
    const tile=await page.locator('.unlock').boundingBox(), cover=await page.locator('.card .art').nth(1).boundingBox();
    assert.ok(Math.abs(tile.y-cover.y)<1 && Math.abs(tile.height-cover.height)<1,JSON.stringify({tile,cover}));
    await page.evaluate(()=>window.crateFixture.players.find(p=>p.vid===window.crateFixture.playing.song.vid).emitState(1));
    assert.equal(await page.locator('.unlock').count(),0);
    assert.equal(await page.locator('#hint').isVisible(),false);
    await open();
  });
  await check('buffering during sound verification does not reveal the YouTube tile',async()=>{
    await page.evaluate(()=>{
      const p=window.crateFixture.players.find(p=>p.vid===window.crateFixture.playing.song.vid);
      p.playVideo=function(){this.emitState(3);};
    });
    await page.locator('#sound').click();await page.waitForTimeout(1200);
    assert.equal(await page.locator('.unlock').count(),0);
    await page.evaluate(()=>window.crateFixture.players.find(p=>p.vid===window.crateFixture.playing.song.vid).emitState(1));
    assert.equal(await page.locator('#sound').isVisible(),false);
    await open();
  });
  await check('reference screen geometry and local assets',async()=>{
    assert.equal(await page.locator('#track').innerText(),'Tried and true');
    const cover=await page.locator('.card .art').first().boundingBox(),bar=await page.locator('#bar').boundingBox(),dock=await page.locator('#dock').boundingBox();
    assert.equal(cover.width,300);assert.ok(Math.abs(cover.x-52)<1);assert.ok(Math.abs(cover.y-271)<2,JSON.stringify(cover));
    assert.ok(Math.abs(bar.y-39)<1);assert.ok(Math.abs(dock.y-701)<2,JSON.stringify(dock));
    // 3.1.1: circular cover, smaller handset type, tight 300px-blur glow sitting slightly above the cover's centre.
    const look=await page.evaluate(()=>{const cs=e=>getComputedStyle(document.querySelector(e));const b=document.querySelector('#backdrop').getBoundingClientRect();
      return {radius:cs('.card .art').borderRadius,artist:cs('#dock .artist').fontSize,track:cs('#dock .track').fontSize,blur:cs('#backdrop').filter,glow:{w:b.width,h:b.height,cy:b.y+b.height/2}};});
    assert.equal(look.radius,'50%');assert.equal(look.artist,'16px');assert.equal(look.track,'18px');assert.equal(look.blur,'blur(150px)');
    assert.ok(look.glow.w<=cover.width&&look.glow.w>=cover.width*.8,JSON.stringify(look));
    assert.ok(look.glow.cy<cover.y+cover.height/2-20&&look.glow.cy>cover.y,JSON.stringify({look,cover}));
    assert.equal(await page.locator('img').evaluateAll(images=>images.filter(i=>i.offsetParent!==null).every(i=>i.complete&&i.naturalWidth>0)),true);
    await page.locator('#sound').click();await page.locator('#seek').fill('840');
    await page.screenshot({path:output+'/playback-mobile.png'});
  });
  await check('heart writes immediately and records the discovery',async()=>{
    await page.locator('#heart').click();await page.waitForFunction(()=>window.crateFixture.model.session.items.length===1);
    assert.equal((await calls())[0].method,'PUT');assert.equal(await page.locator('#heart').getAttribute('aria-pressed'),'true');
    await page.locator('#sessionButton').click();await page.locator('[data-play="0"]').waitFor();
    assert.match(await page.locator('#sessionSummary').innerText(),/1 track · 1 record/);
    await page.locator('#status').waitFor({state:'hidden'});await page.screenshot({path:output+'/session-mobile.png'});
  });
  await check('session replay and auto-next leave the feed index intact',async()=>{
    await page.locator('#closeSession').click();
    await page.locator('#feed').evaluate(el=>el.scrollTop=874);await page.waitForFunction(()=>window.crateFixture.active===1);
    await page.locator('#sessionButton').click();await page.locator('[data-play="0"]').focus();await page.locator('[data-play="0"]').press('Enter');
    await page.waitForFunction(()=>window.crateFixture.playing.source==='session');
    assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-play')),true);
    assert.equal(await page.locator('#track').innerText(),'Tried and true');assert.match(await page.locator('#youtube').getAttribute('href'),/aaaaaaaaaaa/);
    await page.evaluate(()=>window.crateFixture.players.find(p=>p.getPlayerState()===1)?.emitState(0));
    assert.equal(await page.evaluate(()=>window.crateFixture.active),1);
    await page.locator('#closeSession').click();assert.equal(await page.locator('#track').innerText(),'A quiet place');
    assert.equal((await calls()).length,1);
  });
  await check('session survives reload and changed filters',async()=>{
    await page.reload();await page.waitForFunction(()=>!!window.crateFixture);await page.locator('#sessionButton').click();assert.equal(await page.locator('[data-play]').count(),1);
    await page.locator('#closeSession').click();await page.locator('#chip').click();await page.locator('#style').fill('House');await page.locator('#goBtn').click();
    await page.locator('#sessionButton').click();assert.equal(await page.locator('[data-play]').count(),1);await page.locator('#closeSession').click();
  });
  await check('release replay updates the playing identity and YouTube link',async()=>{
    await page.locator('.release-meta').first().click();await page.locator('[data-track="1"]').click();
    assert.equal(await page.locator('#track').innerText(),'Second thoughts');assert.match(await page.locator('#youtube').getAttribute('href'),/eeeeeeeeeee/);
    await page.locator('#seek').fill('500');await page.waitForFunction(()=>window.crateFixture.players.some(p=>p.getCurrentTime()===130));
    await page.screenshot({path:output+'/release-mobile.png'});await page.locator('#closeRelease').click();assert.equal(await page.locator('#track').innerText(),'Tried and true');
  });
  await check('new session clears the local view without deleting remote wants',async()=>{
    await page.locator('#sessionButton').click();const before=(await calls()).length;await page.locator('#newSession').click();
    assert.equal(await page.locator('[data-play]').count(),0);assert.equal((await calls()).length,before);
    assert.equal(await page.evaluate(()=>window.crateFixture.model.wanted.has(1001)),true);
    await page.locator('#closeSession').click();await page.locator('#heart').click();await page.waitForFunction(()=>!window.crateFixture.model.wanted.has(1001));
    assert.equal((await calls()).at(-1).method,'DELETE');
  });
  await check('failed add/removal leaves a retryable and consistent UI',async()=>{
    await open('fixture=1&fail=add');await page.locator('#heart').click();await page.waitForFunction(()=>!!window.crateFixture.model.error);
    assert.equal(await page.locator('#heart').getAttribute('aria-pressed'),'false');assert.equal(await page.evaluate(()=>window.crateFixture.model.session.items.length),0);
    await page.locator('#heart').click();await page.waitForFunction(()=>window.crateFixture.model.session.items.length===1);
    await open('fixture=1&fail=remove');await page.locator('#sessionButton').click();await page.locator('[data-remove="0"]').click();await page.waitForFunction(()=>!!window.crateFixture.model.error);
    assert.equal(await page.locator('[data-remove]').count(),1);await page.locator('[data-remove="0"]').click();await page.waitForFunction(()=>window.crateFixture.model.session.items.length===0);
    assert.equal(await page.locator('[data-remove]').count(),0);await page.locator('#closeSession').click();
  });
  await check('failed wantlist refresh preserves session and can recover',async()=>{
    await page.locator('#heart').click();await page.waitForFunction(()=>window.crateFixture.model.session.items.length===1);
    await open('fixture=1&fail=refresh');await page.locator('#sessionButton').click();assert.equal(await page.locator('[data-play]').count(),1);
    assert.equal(await page.locator('[data-remove]').isDisabled(),true);await page.locator('#retryWants').click();await page.waitForFunction(()=>window.crateFixture.model.health==='ready');
    assert.equal(await page.locator('[data-remove]').isDisabled(),false);await page.locator('#closeSession').click();
  });
  await check('modal focus is contained, Escape closes it and icons keep their intended sizes',async()=>{
    await page.locator('#sessionButton').click();
    await page.locator('#youtube').focus();await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'closeSession');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#session').isVisible(),false);
    assert.equal(await page.locator('#sessionButton img').evaluate(el=>el.getBoundingClientRect().width),24);
    assert.equal(await page.locator('#heart img').evaluate(el=>el.getBoundingClientRect().width),24);
    assert.equal(await page.locator('#youtube img').evaluate(el=>el.getBoundingClientRect().width),14);
  });
  await check('responsive geometry: small phone, standard phone, desktop and long titles',async()=>{
    for(const [width,height] of [[320,568],[390,844],[1440,900]]) {
      await page.setViewportSize({width,height});await page.waitForTimeout(100);
      const bounds=await page.locator('#dock').boundingBox(),cover=await page.locator('.card .art').first().boundingBox();
      assert.ok(bounds.y+ bounds.height<=height+.5);assert.ok(cover.y+cover.height<bounds.y,JSON.stringify({width,bounds,cover}));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:output+`/playback-${width}x${height}.png`});
    }
    await page.setViewportSize({width:320,height:568});
    await page.evaluate(()=>{const s=window.crateFixture.playing.song;s.artist='An exceptionally long artist name with collaborators';s.trackTitle='A very long track title that needs more than one line on a small screen';});
    // A real view transition rerenders the same data without a special production test hook.
    await page.locator('#sessionButton').click();await page.locator('#closeSession').click();await page.waitForTimeout(100);
    const bounds=await page.locator('#dock').boundingBox(),cover=await page.locator('.card .art').first().boundingBox();
    assert.ok(cover.y+cover.height<=bounds.y+1,JSON.stringify({bounds,cover}));
    if(await page.locator('#sound').isVisible()) {
      const sound=await page.locator('#sound').boundingBox();assert.ok(sound.y>=cover.y && sound.y+sound.height<=cover.y+cover.height+1,JSON.stringify({sound,cover}));
    }
    await page.screenshot({path:output+'/long-title-small-phone.png'});
  });
  await check('onboarding and filters render without credentials or external requests',async()=>{
    await page.setViewportSize({width:402,height:874});await page.locator('#chip').click();await page.screenshot({path:output+'/filters-mobile.png'});
    await page.locator('#changeTok').click();await page.screenshot({path:output+'/onboarding-mobile.png'});
    assert.equal(await page.locator('#tok').inputValue(),'');assert.equal(requests.length,0);
  });
  await check('missing artwork and uncertain matching stay usable',async()=>{
    await page.locator('#closeSetup').click();
    if (await page.locator('#pick').isVisible()) await page.locator('#closePick').click();
    await page.evaluate(async()=>{const fixture=await import('./tests/fixture.js');fixture.songs[0].cover='';fixture.songs[0].conf='none';fixture.songs[0].trackTitle=null;});
    await page.locator('#chip').click();await page.locator('#goBtn').click();
    assert.equal(await page.locator('.card .art img').first().getAttribute('src'),'tests/reference-cover.png');
    assert.equal(await page.locator('.card').first().locator('.art img').count(),0);
    assert.match(await page.locator('#matchWarning').innerText(),/unmatched/);await page.screenshot({path:output+'/missing-artwork.png'});
  });
  await check('double-tap and keyboard likes use the same immediate record toggle',async()=>{
    const before=await page.evaluate(()=>window.crateFixture.model.has(window.crateFixture.playing.song));
    const count=(await calls()).length;
    await page.locator('.card .art').first().dblclick();
    await page.waitForFunction(expected=>window.crateFixture.model.has(window.crateFixture.playing.song)!==expected,before);
    assert.equal((await calls()).length,count+1);
    await page.locator('body').click({position:{x:8,y:8}});await page.keyboard.press('l');
    await page.waitForFunction(expected=>window.crateFixture.model.has(window.crateFixture.playing.song)===expected,before);
    assert.equal((await calls()).length,count+2);
  });
  await check('production entry: connect, discover, like, reload, replay and remove with mocked endpoints',async()=>{
    const isolated=await browser.newContext({viewport:{width:402,height:874},reducedMotion:'reduce'}), live=await isolated.newPage();
    live.setDefaultTimeout(15000); const remote=new Map(),writes=[];let releaseRequests=0,retrying=false;
    live.on('pageerror',error=>errors.push(error.message));
    await live.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.url().startsWith(base)) return route.continue();
      if(url.hostname==='www.youtube.com' && url.pathname==='/iframe_api') return route.fulfill({contentType:'text/javascript',body:`window.YT={Player:class extends (${FakePlayer.toString()}){constructor(id,options){super(options.events)}}};window.onYouTubeIframeAPIReady();`});
      if(url.hostname==='www.youtube.com' && url.pathname==='/oembed') return route.fulfill({contentType:'application/json',body:JSON.stringify({type:'video'})});
      if(url.hostname!=='api.discogs.com') return route.abort();
      assert.equal(request.headers().authorization,'Discogs token=local-test-token');
      let body;
      if(url.pathname==='/oauth/identity') body={username:'browser-test'};
      else if(url.pathname==='/database/search') body={pagination:{pages:1,items:4},results:songs.map(s=>({id:s.releaseId,master_id:s.masterId,type:'release',title:s.artist+' - '+s.releaseTitle}))};
      else if(url.pathname.startsWith('/releases/')) {
        if (++releaseRequests===2) {retrying=true;return route.fulfill({status:429,contentType:'application/json',body:'{}'});}
        body=releases.get(Number(url.pathname.split('/').at(-1)));
      }
      else if(request.method()==='GET' && url.pathname.includes('/wants')) body={pagination:{pages:1},wants:[...remote].map(([id,master_id])=>({id,basic_information:{master_id}}))};
      else if(['PUT','DELETE'].includes(request.method()) && url.pathname.includes('/wants/')) {
        const id=Number(url.pathname.split('/').at(-1));writes.push(request.method());
        if(request.method()==='PUT')remote.set(id,releases.get(id).master_id);else remote.delete(id);body={};
      } else throw Error('Unexpected mock request '+request.method()+' '+url.pathname);
      return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(body)});
    });
    try {
      await live.goto(base);await live.locator('#pick').waitFor({state:'visible'});
      assert.equal(await live.locator('#setup').isVisible(),false);await live.locator('#changeTok').click();
      await live.locator('#tok').fill('local-test-token');await live.locator('#saveTok').click();await live.locator('#pick').waitFor({state:'visible'});
      await live.locator('#goBtn').click();await live.locator('#dock').waitFor({state:'visible'});await live.locator('#heart:not(:disabled)').waitFor();
      for(let i=0;i<50&&!retrying;i++) await live.waitForTimeout(100);
      assert.equal(retrying,true);assert.doesNotMatch(await live.locator('#status').innerText(),/retrying|interrupted|rate limit/i);
      await live.locator('#heart').click();await live.waitForFunction(()=>document.querySelector('#heart').getAttribute('aria-pressed')==='true');
      assert.deepEqual(writes,['PUT']);await live.reload();await live.locator('#sessionButton').click();await live.locator('[data-play="0"]').waitFor();
      await live.locator('[data-play="0"]').click();await live.locator('[data-remove="0"]:not(:disabled)').waitFor();await live.locator('[data-remove="0"]').click();
      await live.waitForFunction(()=>document.querySelectorAll('[data-remove]').length===0);assert.deepEqual(writes,['PUT','DELETE']);
    } finally {await isolated.close();}
  });
  await check('share: link pins that exact track as card 0, first swipe down opens Filters, apply digs from card 1, swipe up returns',async()=>{
    const context=await browser.newContext({viewport:{width:402,height:874},reducedMotion:'reduce'}), sp=await context.newPage();sp.setDefaultTimeout(15000);
    sp.on('pageerror',e=>errors.push(e.message));
    sp.on('request',request=>{if(!request.url().startsWith(base)) requests.push(request.url());});
    await sp.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await context.addInitScript(()=>{
      Object.defineProperty(Navigator.prototype,'share',{configurable:true,value:function(data){window.__shared=data;return Promise.resolve();}});
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>{window.__copied=text;return Promise.resolve();}}});
    });
    try {
      const fx=()=>sp.evaluate(()=>({cards:window.crateFixture.cards,active:window.crateFixture.active,vid:window.crateFixture.players[0].vid,playing:window.crateFixture.playing.song?.vid,gate:window.crateFixture.gate,shareGate:window.crateFixture.shareGate}));
      // Sharer side: the share sheet gets a link with only the release and video ids.
      await sp.goto(base+'/?fixture=1');await sp.waitForFunction(()=>!!window.crateFixture?.playing.song);
      await sp.locator('#share').click();await sp.waitForFunction(()=>!!window.__shared);
      assert.deepEqual(await sp.evaluate(()=>window.__shared),{title:'Geoff White – Tried and true',url:base+'/?share=1001&yt=aaaaaaaaaaa'});
      await sp.evaluate(()=>{delete Navigator.prototype.share;});await sp.locator('#share').click();
      await sp.waitForFunction(()=>!!window.__copied);assert.equal(await sp.evaluate(()=>window.__copied),base+'/?share=1001&yt=aaaaaaaaaaa');
      assert.equal(await sp.locator('#status').innerText(),'Link copied');
      assert.equal(await sp.locator('#share img').evaluate(el=>el.getBoundingClientRect().width),24);
      // Recipient: a track that is not in any dig, with the sharer's filters nowhere in the link.
      await sp.goto(base+'/?fixture=1&share=1003&yt=eeeeeeeeeee');
      await sp.waitForFunction(()=>window.crateFixture?.playing.song?.vid==='eeeeeeeeeee');
      let s=await fx();assert.deepEqual(s.cards,['eeeeeeeeeee']);assert.equal(s.active,0);assert.equal(s.gate,true);assert.equal(s.shareGate,true);
      assert.equal(await sp.locator('#track').innerText(),'Second thoughts');assert.equal(await sp.locator('#chip').innerText(),'Pick your dig…');
      assert.equal(await sp.locator('#pick').isVisible(),false);
      await sp.locator('#sound').click();await sp.waitForFunction(()=>window.crateFixture.players[0].getPlayerState()===1);
      await sp.screenshot({path:output+'/share-card0.png'});
      // First swipe down: Filters, prefilled with the release year only. Card 0 keeps playing.
      await sp.locator('#feed').evaluate(el=>el.scrollTop=874);await sp.locator('#pick').waitFor({state:'visible'});
      assert.equal(await sp.locator('#y1').inputValue(),'2001');
      for(const id of ['genre','style','label','country','y2']) assert.equal(await sp.locator('#'+id).inputValue(),'',id);
      s=await fx();assert.equal(s.active,0);assert.equal(s.vid,'eeeeeeeeeee');
      await sp.screenshot({path:output+'/share-filters.png'});
      // Closing without applying goes back to the shared track.
      await sp.locator('#closePick').click();await sp.waitForFunction(()=>document.querySelector('#feed').scrollTop===0);
      assert.equal((await fx()).active,0);await sp.waitForTimeout(200);
      // Swipe down again, apply: the dig starts at card 1; the link is consumed.
      await sp.locator('#feed').evaluate(el=>el.scrollTop=874);await sp.locator('#pick').waitFor({state:'visible'});
      await sp.locator('#goBtn').click();
      await sp.waitForFunction(()=>window.crateFixture.active===1 && window.crateFixture.players[0].vid!=='eeeeeeeeeee');
      s=await fx();assert.equal(s.cards[0],'eeeeeeeeeee');assert.ok(s.cards.length>=4,JSON.stringify(s));assert.equal(s.gate,false);assert.equal(s.shareGate,false);
      assert.equal(s.cards.filter(v=>v==='eeeeeeeeeee').length,1);assert.equal(s.vid,s.cards[1]);
      assert.match(await sp.locator('#chip').innerText(),/2001/);assert.equal(new URL(sp.url()).searchParams.has('share'),false);
      assert.equal(await sp.locator('#pick').isVisible(),false);
      // Swipe up: the shared track again.
      await sp.locator('#feed').evaluate(el=>el.scrollTop=0);
      await sp.waitForFunction(()=>window.crateFixture.active===0 && window.crateFixture.players[0].vid==='eeeeeeeeeee');
      assert.equal(await sp.locator('#track').innerText(),'Second thoughts');
      // Further down is the dig, not the Filters gate.
      await sp.locator('#feed').evaluate(el=>el.scrollTop=874*2);await sp.waitForFunction(()=>window.crateFixture.active===2);
      assert.equal(await sp.locator('#pick').isVisible(),false);
      // Fail soft: video gone from the release, or a malformed link.
      for(const [query,year] of [['share=1003&yt=zzzzzzzzzzz','2001'],['share=abc','']]) {
        await sp.goto(base+'/?fixture=1&'+query);await sp.locator('#pick').waitFor({state:'visible'});
        assert.match(await sp.locator('#status').innerText(),/Couldn’t find that track/);assert.equal(await sp.locator('#y1').inputValue(),year);
        assert.equal(await sp.evaluate(()=>window.crateFixture.cards.length),0);
      }
      await sp.locator('#goBtn').click();await sp.waitForFunction(()=>window.crateFixture.active===0 && !!window.crateFixture.playing.song);
      assert.equal(await sp.evaluate(()=>window.crateFixture.cards[0]),'aaaaaaaaaaa');
      // The shared video turning out dead on play also falls back to Filters.
      await sp.goto(base+'/?fixture=1&share=1003&yt=eeeeeeeeeee');await sp.waitForFunction(()=>window.crateFixture?.playing.song?.vid==='eeeeeeeeeee');
      await sp.evaluate(()=>window.crateFixture.players[0].events.onError({data:150}));await sp.locator('#pick').waitFor({state:'visible'});
      assert.match(await sp.locator('#status').innerText(),/Couldn’t find that track/);
    } finally {await context.close();}
  });
  assert.deepEqual(errors,[]);
  await writeFile(output+'/browser-report.json',JSON.stringify({browser:process.env.BROWSER||'chromium',version:browser.version(),results,errors,externalRequests:requests},null,2));
  console.log(`${results.length} browser checks passed; no browser errors or external requests.`);
} finally {await browser.close();}
