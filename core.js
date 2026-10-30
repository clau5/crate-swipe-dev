// Discovery and matching logic preserved from Crate Swipe 2.3.0.

// ---- Pure logic shared by the browser app and the node test harness ----
const GENRES=["Electronic","Hip Hop","Jazz","Rock","Funk / Soul","Pop","Latin","Reggae","Classical","Blues","Folk, World, & Country","Non-Music","Stage & Screen","Children's","Brass & Military"];
const STYLES=["Techno","House","Deep House","Tech House","Minimal","Minimal Techno","Electro","Acid","Acid House","Detroit Techno","Dub Techno","Ambient","Breakbeat","Breaks","Progressive House","Trance","Hard Trance","Garage House","UK Garage","Italo-Disco","Disco","Nu-Disco","Electro House","Hardcore","Jungle","Drum n Bass","IDM","Experimental","Leftfield","Downtempo","Trip Hop","Ghetto","Ghetto House","Juke","Hard House","Hard Techno","Industrial","EBM","Synth-pop","New Wave","Italodance","Euro House","Eurodance","Hi NRG","Balearic","Dub","Broken Beat","Bass Music","Dubstep","Grime","Footwork","Tribal","Tribal House","Freestyle","Miami Bass","Bleep","Gabber","Happy Hardcore","Speed Garage","Afro House","Afrobeat","Funk","Soul","Jazz-Funk","Boom Bap","Abstract","Instrumental"];

function norm(s){return (s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[’'`´]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function stripBrackets(s){return (s||'').replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g,' ');}
function bracketText(s){const m=(s||'').match(/\(([^)]*)\)|\[([^\]]*)\]/g)||[];return m.map(x=>x.slice(1,-1));}
function cleanArtist(n){return (n||'').replace(/\s*\(\d+\)$/,'').replace(/\*$/,'').trim();}
function artistString(arr){if(!arr||!arr.length)return '';let s='';arr.forEach((a,i)=>{s+=cleanArtist(a.anv||a.name);if(i<arr.length-1)s+=a.join&&a.join!==','?' '+a.join+' ':', ';});return s.replace(/\s+/g,' ').trim();}
function ytId(uri){const m=(uri||'').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);return m?m[1]:null;}
function parseDur(d){if(!d)return 0;const p=String(d).split(':').map(Number);if(p.some(isNaN))return 0;return p.reduce((a,b)=>a*60+b,0);}
function bigrams(s){s=s.replace(/ /g,'');const m=new Map();for(let i=0;i<s.length-1;i++){const g=s.slice(i,i+2);m.set(g,(m.get(g)||0)+1);}return m;}
function dice(a,b){if(!a||!b)return 0;if(a===b)return 1;if(a.length<2||b.length<2)return 0;const A=bigrams(a),B=bigrams(b);let inter=0,na=0,nb=0;A.forEach(v=>na+=v);B.forEach(v=>nb+=v);A.forEach((v,k)=>{if(B.has(k))inter+=Math.min(v,B.get(k));});return 2*inter/(na+nb);}
function sim(v,t){ // v = cleaned video title, t = normalized track title
  if(!v||!t)return 0; if(v===t)return 1;
  if(v.replace(/ /g,'')===t.replace(/ /g,''))return 0.97; // "pullover" vs "pull over"
  if(t.length>=3&&(' '+v+' ').includes(' '+t+' '))return 0.82+0.18*Math.min(1,t.length/v.length);
  return dice(v,t);
}
const NOISE=/\b(official|video|audio|music|hq|hd|4k|1080p|720p|vinyl|rip|12 ?inch|12|7|lp|ep|remaster(ed)?|reissue|full|track|new|exclusive|premiere|19[5-9]\d|20[0-3]\d)\b/g;
const MIXNOISE=/\b(the|by|mixed|remixed|rmix|mix|version|remix|rmx|edit|feat|ft|featuring|original|19[5-9]\d|20[0-3]\d|hq|hd|official|video|audio|vinyl|12|a\d|b\d|c\d|d\d|side)\b/g;
function cleanTitle(raw,names,labels){
  let s=' '+norm(raw)+' ';
  for(const n of names){const nn=norm(n);if(nn.length>1)s=s.split(' '+nn+' ').join(' ');}
  for(const l of labels){const nl=norm(l);if(nl.length>2)s=s.split(' '+nl+' ').join(' ');}
  return s.replace(NOISE,' ').replace(/\s+/g,' ').trim();
}
function mixName(title,names,labels){ // e.g. "Klaiff - So Good (Pitch Mix)" -> "pitch"
  const parts=bracketText(title).map(x=>cleanTitle(x,names,labels).replace(MIXNOISE,' ').replace(/\s+/g,' ').trim()).filter(x=>x.length>=3);
  return parts.join(' ');
}
const NON_SONG=/(full (album|ep|lp|vinyl|release|record)|all tracks|complete (album|ep)|dj set|live set|mix ?tape|minimix|megamix|continuous mix|(^|[^a-z])mixed by|boiler room|podcast|radio show|interview|unboxing|documentary)/i;
function songCheck(v){ // null if it looks like one song, else the reason
  const d=v.duration||0;
  if(d>900)return 'long';            // > 15 min: whole side / mix / album
  if(d>0&&d<30)return 'short';       // < 30 s: teaser / snippet
  if(NON_SONG.test(v.title||''))return 'nonsong';
  return null;
}
function flattenTracks(tl){const out=[];(tl||[]).forEach(t=>{if(t.type_==='index'&&t.sub_tracks)t.sub_tracks.forEach(s=>out.push(s));else if(!t.type_||t.type_==='track')out.push(t);});return out;}
const HIGH=0.85,LOW=0.6;
function matchTrack(video,release){
  const tracks=flattenTracks(release.tracklist);
  if(!tracks.length)return {track:null,score:0,conf:'none'};
  const names=[];const addA=a=>{names.push(a.name,cleanArtist(a.name));if(a.anv)names.push(a.anv);};
  (release.artists||[]).forEach(addA);tracks.forEach(t=>(t.artists||[]).forEach(addA));
  (release.extraartists||[]).forEach(a=>names.push(cleanArtist(a.name)));
  names.sort((a,b)=>b.length-a.length);
  const labels=[];(release.labels||[]).forEach(l=>{labels.push(cleanArtist(l.name));if(l.catno)labels.push(l.catno);});
  const vFull=cleanTitle(video.title,names,labels),vBase=cleanTitle(stripBrackets(video.title),names,labels);
  const vMix=mixName(video.title,names,labels);
  const vtNorm=' '+norm(video.title)+' ';
  const posCount={};tracks.forEach(t=>{const np=norm(t.position);posCount[np]=(posCount[np]||0)+1;});
  let best=null,bestS=0,posBest=null;
  for(const t of tracks){
    const tFull=norm(t.title),tBase=norm(stripBrackets(t.title));
    // full title (incl. mix name) counts fully; base title only (mix ignored) is capped lower
    let s=Math.max(sim(vFull,tFull),0.8*sim(vBase,tBase||tFull));
    const tMix=mixName(t.title,names,labels);
    if(vMix&&tMix){const ms=dice(vMix,tMix);if(ms>=0.6||vMix.includes(tMix)||tMix.includes(vMix))s+=0.15;else s-=0.25;} // different remix = different song
    const td=parseDur(t.duration),vd=video.duration||0;
    if(td&&vd){const df=Math.abs(td-vd);if(df<=4)s+=0.15;else if(df<=15)s+=0.06;else if(df>90)s-=0.12;}
    let posHit=false;
    if(t.position){const np=norm(t.position);
      if(np.length>=2&&np.length<=3&&/\d/.test(np)&&vtNorm.includes(' '+np+' ')){s+=posCount[np]===1?0.5:0.12;posHit=posCount[np]===1;} // "(SIDE B1)", "A2"
      else if(np.length===1&&vtNorm.includes(' side '+np+' ')){s+=posCount[np]===1?0.5:0.12;posHit=posCount[np]===1;}}
    if(posHit)posBest=t;
    if(s>bestS){bestS=s;best=t;}
  }
  if(tracks.length===1&&bestS<LOW)bestS=LOW; // single-track release: the video is almost surely that track
  // only a side/position token matched (e.g. "Sonic Experiments 001 ... A2"): accept as a probable match when the title also names this release's artist, title or catalog no.
  if(bestS<LOW&&posBest){const ctx=[...names,...labels.filter(x=>/\d/.test(x)),stripBrackets(release.title||'')].map(norm).filter(x=>x.length>=4);
    if(ctx.some(x=>vtNorm.includes(' '+x+' ')||vtNorm.replace(/ /g,'').includes(x.replace(/ /g,'')))){best=posBest;bestS=LOW;}}
  const conf=bestS>=HIGH?'high':bestS>=LOW?'low':'none';
  return {track:conf==='none'?null:best,score:+bestS.toFixed(3),conf};
}
// Turn one release into song objects, applying dedupe against shared state.
// state: {seenVid:Set, seenKey:Set, skipVid:{has(id)} (optional: seen earlier / known dead), stats:{}}
function releaseToSongs(rel,hit,state){
  const st=state.stats;const songs=[];const inc=k=>st[k]=(st[k]||0)+1;
  const vids=(rel.videos||[]);st.videos=(st.videos||0)+vids.length;
  const relArtist=artistString(rel.artists)||(hit&&hit.title||'').split(' - ')[0];
  const label=(rel.labels&&rel.labels[0])?cleanArtist(rel.labels[0].name)+(rel.labels[0].catno&&rel.labels[0].catno!=='none'?' · '+rel.labels[0].catno:''):((hit&&hit.label&&hit.label[0])||'');
  // cover art: the release's primary image (full-size uri) first, then the search result's cover_image
  const im=rel.images||[];const prim=(im.find(i=>i.type==='primary')||im[0]||{}).uri||'';
  const sc=(hit&&hit.cover_image&&!/spacer\.gif/.test(hit.cover_image))?hit.cover_image:'';
  const cover=prim||sc,cover2=prim&&sc&&sc!==prim?sc:'';
  for(const v of vids){
    const id=ytId(v.uri);
    if(!id){inc('notYoutube');continue;}
    if(v.embed===false){inc('noEmbed');continue;}
    const bad=songCheck(v);if(bad){inc('skip_'+bad);continue;}
    if(state.skipVid&&state.skipVid.has(id)){inc('skipKnown');continue;}
    if(state.seenVid.has(id)){inc('dupVideo');continue;}
    state.seenVid.add(id);
    const m=matchTrack(v,rel);
    const artist=m.track&&m.track.artists&&m.track.artists.length?artistString(m.track.artists):relArtist;
    if(m.conf==='high'){ // only confident matches collapse different uploads of the same song
      const key=norm(artist)+'|'+norm(m.track.title);
      if(state.seenKey.has(key)){inc('dupSong');if(state.dupLog)state.dupLog.push(key+'  <=  '+v.title);continue;}
      state.seenKey.add(key);
    }
    inc('songs');inc('conf_'+m.conf);
    songs.push({vid:id,videoTitle:v.title||'',duration:v.duration||0,trackTitle:m.track?m.track.title.trim():null,position:m.track?m.track.position:null,conf:m.conf,score:m.score,
      artist,releaseId:rel.id,masterId:rel.master_id||0,releaseTitle:rel.title,label,year:rel.year||(hit&&hit.year)||'',country:rel.country||'',cover,cover2,thumb:(hit&&hit.thumb)||cover,url:rel.uri||('https://www.discogs.com/release/'+rel.id)});
  }
  return songs;
}
function slimRelease(r){ // what we keep in the cache
  return {id:r.id,title:r.title,artists:(r.artists||[]).map(a=>({name:a.name,anv:a.anv,join:a.join})),labels:(r.labels||[]).map(l=>({name:l.name,catno:l.catno})),
    year:r.year,country:r.country,master_id:r.master_id,uri:r.uri,styles:r.styles,genres:r.genres,formats:(r.formats||[]).map(f=>({name:f.name,descriptions:f.descriptions})),
    images:(()=>{const im=r.images||[];const p=im.find(i=>i.type==='primary')||im[0];return p?[{uri:p.uri,type:p.type}]:[];})(),extraartists:(r.extraartists||[]).map(a=>({name:a.name})),
    tracklist:(r.tracklist||[]).map(t=>({position:t.position,title:t.title,duration:t.duration,type_:t.type_,artists:t.artists&&t.artists.map(a=>({name:a.name,anv:a.anv,join:a.join})),sub_tracks:t.sub_tracks&&t.sub_tracks.map(x=>({position:x.position,title:x.title,duration:x.duration,type_:x.type_}))})),
    videos:(r.videos||[]).map(v=>({uri:v.uri,title:v.title,duration:v.duration,embed:v.embed}))};
}
// ---- Feed order: never two songs from the same release/master back to back; spread release, master and artist >= gap cards apart when the pool allows ----
// keys: release, master (other pressings) and artist (not "Various")
function songKeys(s){const k=['r'+s.releaseId];if(s.masterId)k.push('m'+s.masterId);
  if(s.artist&&!/^various\b/i.test(s.artist)){const a=norm(s.artist);if(a)k.push('a'+a);}return k;}
function relKeys(s){return songKeys(s).filter(k=>k[0]!=='a');}
// recent = songs already in the feed (most recent last). Picks uniformly among eligible songs (the pool holds ~1 song per release, so ~uniform over releases).
function pickNext(pool,recent,gap,rnd,keys){rnd=rnd||Math.random;keys=keys||songKeys;
  const block=new Set();if(gap>0)recent.slice(-gap).forEach(s=>keys(s).forEach(k=>block.add(k)));
  const ok=[];pool.forEach((s,i)=>{if(!keys(s).some(k=>block.has(k)))ok.push(i);});
  return ok.length?ok[Math.floor(rnd()*ok.length)]:-1;}
// Choose the next card. With a cushion of cards ahead we wait for more variety instead of relaxing the gap; the gap is relaxed only
// as the viewer is about to run out of cards, and never to 0: two songs of one release are never back to back.
// At each gap the artist spacing is dropped before the release/master spacing is. o.info (optional) receives the gap actually used.
function chooseNext(pool,recent,o){const G=o.gap||6;const floor=o.ahead>=2?G:o.ahead===1?Math.min(3,G):1;
  let i=-1,g=G,art=true;for(;g>=floor;g--){i=pickNext(pool,recent,g,o.rnd,songKeys);if(i>=0){art=true;break;}i=pickNext(pool,recent,g,o.rnd,relKeys);if(i>=0){art=false;break;}}
  if(o.info){o.info.gap=i>=0?g:null;o.info.artist=i>=0?art:null;}
  return i;}
// One song per release goes into the feed pool (a confident track match if there is one); the rest go to a reserve that drips back in.
function primaryPick(songs,rnd){rnd=rnd||Math.random;const hi=songs.filter(s=>s.conf==='high'),from=hi.length?hi:songs;
  const pick=from[Math.floor(rnd()*from.length)];return {pick,rest:songs.filter(s=>s!==pick)};}
// Spacing target from the size of the dig: ~ a quarter of the releases we expect to be playable, between 4 and 15.
// total = search matches, fetched/withSongs = releases fetched so far / those that gave songs.
function adaptiveGap(total,fetched,withSongs,max){max=max||15;if(!total)return max;
  const est=total*((withSongs||0)+1)/((fetched||0)+2);return Math.max(4,Math.min(max,Math.floor(est/4)));}
// how much usable variety the pool holds: distinct releases not used in the last `gap` cards (a release with many songs counts as 2).
// Used to decide when to keep fetching, so the dig never pauses while the pool only holds songs we can't place yet.
function poolVariety(pool,recent,gap){const block=new Set();(recent||[]).slice(-(gap||0)).forEach(s=>songKeys(s).forEach(k=>block.add(k)));
  const c=new Map();pool.forEach(s=>{if(songKeys(s).some(k=>block.has(k)))return;c.set(s.releaseId,(c.get(s.releaseId)||0)+1);});let n=0;for(const v of c.values())n+=Math.min(v,2);return n;}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

// Rate-limited Discogs client: 60 req/min authenticated -> one request every 1.1 s, with priorities.
class Discogs{
  // 3.1.9: token bucket instead of a fixed 1.1 s gap before every call. A cold open may burst a few
  // requests (search + first releases) back to back and up to 3 GETs run in parallel; the long-run
  // rate stays at one call per `gap` (Discogs allows 60/min). Writes run alone, in queue order.
  constructor(token,opts={}){this.token=token;this.gap=opts.gap||1100;this.burst=opts.burst??6;this.parallel=opts.parallel||3;
    this.tokens=this.burst;this.refilled=Date.now();this.active=0;this.writing=false;this.timer=null;this.q=[];this.dry=!!opts.dryRun;this.ua=opts.userAgent;this.count=0;this.dryLog=[];
    this.onAuthError=opts.onAuthError||(()=>{});this.onRateLimit=opts.onRateLimit||(()=>{});}
  req(method,path,prio=1){return new Promise((res,rej)=>{this.q.push({method,path,prio,res,rej});this.q.sort((a,b)=>b.prio-a.prio);this._pump();});}
  get(p,prio){return this.req('GET',p,prio);}
  _take(){const now=Date.now();this.tokens=Math.min(this.burst,this.tokens+(now-this.refilled)/this.gap);this.refilled=now;
    if(this.tokens>=1){this.tokens--;return 0;}return Math.ceil((1-this.tokens)*this.gap);}
  _pump(){
    while(this.q.length&&!this.timer&&!this.writing&&this.active<this.parallel){
      const job=this.q[0];
      if(this.dry&&job.method!=='GET'){this.q.shift();this.dryLog.push(job.method+' '+job.path);job.res({dryRun:true,method:job.method,path:job.path});continue;}
      const write=job.method!=='GET';if(write&&this.active)return;
      const wait=this._take();if(wait>0){this.timer=setTimeout(()=>{this.timer=null;this._pump();},wait);return;}
      this.q.shift();this.active++;if(write)this.writing=true;
      this._run(job).finally(()=>{this.active--;if(write)this.writing=false;this._pump();});
    }
  }
  async _run(job){
      let tries=0;
      for(;;){
        this.count++;
        try{
          const h={'Authorization':'Discogs token='+this.token};
          if(this.ua)h['User-Agent']=this.ua;
          const r=await fetch('https://api.discogs.com'+job.path,{method:job.method,headers:h});
          if(r.status===429&&tries<6){tries++;this.tokens=0;const w=10000*tries;this.onRateLimit(w);await new Promise(x=>setTimeout(x,w));continue;}
          if(r.status===401||r.status===403&&job.path.startsWith('/oauth')){this.onAuthError(r.status);job.rej(Object.assign(new Error('auth '+r.status),{status:r.status}));break;}
          if(r.status>=500&&tries<2){tries++;await new Promise(x=>setTimeout(x,3000));continue;}
          const txt=await r.text();let body={};try{body=txt?JSON.parse(txt):{};}catch(e){}
          if(!r.ok){job.rej(Object.assign(new Error('HTTP '+r.status+(body.message?': '+body.message:'')),{status:r.status,body}));break;}
          if(tries)this.onRateLimit(0);
          job.res(body);break;
        }catch(e){
          // Discogs sends 401 (and possibly 429) without CORS headers, so the browser only sees a network error.
          // Back off like a rate limit (10 s, 20 s, 30 s) and tell the UI, then give up.
          if(tries<3){tries++;this.tokens=0;const w=10000*tries;this.onRateLimit(w,true);await new Promise(x=>setTimeout(x,w));continue;}
          job.rej(e);break;}
      }
  }
}

// Explorer: pulls search pages in random order into a ~300-release candidate buffer, draws releases from it at random,
// skips masters that already gave songs, fetches releases (cache first), emits songs.
class Explorer{
  constructor(api,opts){
    this.api=api;this.o=opts;this.cache=opts.cache||null;this.state={seenVid:new Set(),seenKey:new Set(),skipVid:opts.skipVid||null,stats:{}};
    this.seenMaster=new Set();this.pending=[];this.yearsLeft=shuffle((opts.years||[null]).slice());this.hits=[];
    this.releases=new Map();this.stopped=false;this.total=0;this.scanned=0;this.fetched=0;this.cacheHits=0;this.done=false;this.wantIds=opts.wantIds||new Set();
    this.exhausted=false;this.withSongs=0;this.page1=new Map();this.hitTarget=opts.hitTarget||300;
    this.onSongs=opts.onSongs||(()=>{});this.onProgress=opts.onProgress||(()=>{});this.maxReleases=opts.maxReleases||Infinity;this.shouldPause=opts.shouldPause||(()=>false);
  }
  qs(year,page){const p=new URLSearchParams({type:'release',format:'Vinyl',per_page:'100',page:String(page)});
    for(const k of ['genre','style','label','country'])if(this.o[k])p.set(k,this.o[k]);if(year)p.set('year',String(year));return '/database/search?'+p.toString();}
  async _cached(key,ttlDays,fetcher,slim){
    if(this.cache){try{const c=await this.cache.get(key);if(c&&Date.now()-c.t<ttlDays*864e5){this.cacheHits++;return c.v;}}catch(e){}}
    const v=await fetcher();const sv=slim?slim(v):v;
    if(this.cache){try{await this.cache.put(key,sv);}catch(e){}}
    return sv;
  }
  async _page(year,page){
    const path=this.qs(year,page);
    const before=this.cacheHits;
    const d=await this._cached('s:'+path,7,()=>this.api.get(path,1),d=>({pagination:d.pagination,results:(d.results||[]).filter(r=>r.type==='release').map(r=>({id:r.id,type:r.type,master_id:r.master_id,title:r.title,year:r.year,label:r.label,cover_image:r.cover_image,thumb:r.thumb,country:r.country,in_wantlist:r.user_data&&r.user_data.in_wantlist}))}));
    if(page===1&&!this.page1.has(year)){
      const pages=Math.min(d.pagination?d.pagination.pages:1,100); // Discogs search stops at 10,000 results (100 pages x 100)
      this.total+=d.pagination?d.pagination.items:0;
      for(let p=2;p<=pages;p++)this.pending.push([year,p]);
      // page 1 is always the same 100 releases for a dig: with more than 3 pages, file it as just another page (drawn at random later, no extra call)
      // 3.1.9: when page 1 was just fetched for the first dig, use it now instead of spending another
      // search call on a random page before the first release (a cached page 1 keeps the random draw).
      if(pages>3&&this.cacheHits!==before){this.page1.set(year,d);this.pending.push([year,1]);return;}
      this.page1.set(year,null);
    }
    const rs=d.results||[];
    rs.forEach(r=>{if(r.in_wantlist)this.wantIds.add(r.id);});
    for(const r of rs){if(r.master_id&&this.seenMaster.has(r.master_id)){this.state.stats.sameMaster=(this.state.stats.sameMaster||0)+1;continue;}this.hits.push(r);}
  }
  async _nextHits(){
    if(this.yearsLeft.length&&(!this.pending.length||Math.random()<0.5)){const y=this.yearsLeft.pop();return this._page(y,1);}
    if(this.pending.length){const i=Math.floor(Math.random()*this.pending.length);const [y,p]=this.pending.splice(i,1)[0];
      if(p===1&&this.page1.get(y)){const d=this.page1.get(y);this.page1.set(y,null);return this._use(d);}
      return this._page(y,p);}
    this.exhausted=true;
  }
  _use(d){const rs=d.results||[];rs.forEach(r=>{if(r.in_wantlist)this.wantIds.add(r.id);});
    for(const r of rs){if(r.master_id&&this.seenMaster.has(r.master_id)){this.state.stats.sameMaster=(this.state.stats.sameMaster||0)+1;continue;}this.hits.push(r);}}
  async run(){
    while(!this.stopped){
      if(this.shouldPause()){await new Promise(r=>setTimeout(r,400));continue;}
      if(this.fetched>=this.maxReleases){this.done=true;break;}
      // keep a large candidate buffer (only 1 release needed during the first few, so the first song isn't delayed), then draw at random
      const target=this.fetched<8?1:this.hitTarget;
      if(this.hits.length<target&&!this.exhausted){try{await this._nextHits();}catch(e){this.onProgress(this,e);if(e.status===401)break;await new Promise(r=>setTimeout(r,3000));}
        continue;}
      if(!this.hits.length)break;
      // 3.1.9: until the first song is found, scan up to 3 releases at once (many have no videos),
      // so the first card doesn't wait on a chain of video-less releases.
      const n=this.withSongs===0?Math.min(3,this.hits.length,this.maxReleases-this.fetched):1,batch=[];
      while(batch.length<n&&this.hits.length){
        const hit=this.hits.splice(Math.floor(Math.random()*this.hits.length),1)[0];
        // another pressing of a record that already gave songs: skip before any release call
        if(hit.master_id&&this.seenMaster.has(hit.master_id)){this.state.stats.sameMaster=(this.state.stats.sameMaster||0)+1;continue;}
        batch.push(hit);
      }
      if(!batch.length)continue;
      await Promise.all(batch.map(hit=>this._scan(hit)));
    }
    this.done=true;this.onProgress(this);
  }
  async _scan(hit){
      this.scanned++;
      let rel;try{rel=await this._cached('r:'+hit.id,90,()=>this.api.get('/releases/'+hit.id,1),slimRelease);}catch(e){this.onProgress(this,e);return;}
      if(this.stopped)return;
      this.fetched++;
      if(rel.videos&&rel.videos.length)this.state.stats.releasesWithVideos=(this.state.stats.releasesWithVideos||0)+1;
      this.releases.set(rel.id,{rel,hit});
      // Check before deduplication: a dead upload must not claim the track's key and hide a working upload.
      let playable=rel;
      if(this.o.checkVideo){
        const videos=rel.videos||[];
        // 3.1.10: until the first song, don't hold the first card behind every oEmbed probe of a release
        // (a release can link 40+ videos, probed 3 at a time). Probes still running at the deadline count
        // as unknown, like a transport failure: kept, and a dead one is skipped by the player as usual.
        const cap=this.withSongs===0?(this.o.firstCheckMs??700):0,deadline=cap>0?new Promise(r=>setTimeout(()=>r(null),cap)):null;
        const checks=await Promise.all(videos.map(v=>{const id=ytId(v.uri);if(!(id&&v.embed!==false&&!this.state.skipVid?.has(id)))return true;const c=this.o.checkVideo(id);return deadline?Promise.race([c,deadline]):c;}));
        if(this.stopped)return;
        playable={...rel,videos:videos.filter((v,i)=>checks[i]!==false)};
      }
      const m=rel.master_id||hit.master_id;
      if(m&&this.seenMaster.has(m)){this.state.stats.sameMaster=(this.state.stats.sameMaster||0)+1;this.onProgress(this);return;}
      const songs=releaseToSongs(playable,hit,this.state);
      if(songs.length){this.withSongs++;if(m)this.seenMaster.add(m);this.onSongs(songs,this);}
      this.onProgress(this);
  }
}
export {songKeys,relKeys,pickNext,chooseNext,primaryPick,adaptiveGap,poolVariety,norm,cleanTitle,mixName,matchTrack,songCheck,releaseToSongs,slimRelease,flattenTracks,ytId,parseDur,dice,artistString,Discogs,Explorer,shuffle,GENRES,STYLES};
