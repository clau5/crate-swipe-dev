import {GENRES, STYLES, Explorer, Discogs, primaryPick, chooseNext, adaptiveGap, poolVariety, flattenTracks, matchTrack, ytId, artistString, releaseToSongs, slimRelease} from './core.js';
import {SessionDiscoveries, GuestDiscoveries, guestStatus, trackKey} from './session.js';
import {VideoAvailability} from './video-availability.js';
import {CatalogueClient} from './catalogue-client.js';
import {sharedCatalogueToken} from './config.js';
import {PLAYLIST_MAX, playlistWindow, playlistMove, shouldRefresh, playlistJump} from './playlist.js';
import {shareURL, parseShare, sharedSong, sharePrefill, shareFilters} from './share.js';

const $ = selector => document.querySelector(selector);
const storage = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
};
const params = new URLSearchParams(location.search);
// Test/demo data can only run on a local server, never on the public Pages site.
const fixture = params.has('fixture') && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const dryRun = params.has('dryrun');
const defaults = {genre:'Electronic',style:'Techno',label:'',country:'',y1:'1995',y2:'',startAt:'0',hideSeen:true,autoNext:true,playMode:'explore'};
let opts = {...defaults, ...storage.get('dx_opts', {})};
let seen = new Set(storage.get('dx_seen', []));
let stats = storage.get('dx_stats', {played:0, dead:0, codes:{}, deadIds:[]});
let deadIds = new Set(stats.deadIds || []);
const catalogue = new CatalogueClient(sharedCatalogueToken,{dryRun});
let api, accountAPI, model, guestSession, explorer, fixtureData, connecting = false;
const discoveryClient = {get:(...args)=>api.get(...args)};
let videoAvailability = new VideoAvailability({storage});
let feedGeneration = 0, recoveringAt = null, discoveryError = false, guestServiceUnavailable = false, lastDiscoveryNotice = 0;
let pool = [], reserve = [], cards = [], active = -1, gap = 15, buffer = 30;
let currentModal = null, returnPlayback = null, setupReturn = null, noticeTimer, opener;
let releaseSong = null;
let playing = {source:'feed', song:null, list:[], index:-1};
// Share links (?share=<release>&yt=<video>): the shared track is pinned as card 0 for the whole visit.
// shareGate stays true until the recipient applies their own filters; until then the card after
// card 0 is a "start your own dig" gate that opens Filters, and Filters start from sharePrefill only.
const share = parseShare(params);
let sharedCard = null, gate = null, shareGate = false, digLoading = false, sharePrefillOpts = {};
// One YouTube player for the whole session. iOS grants sound to the iframe that received the
// first tap; reusing that iframe (loadVideoById) keeps the permission for every later swipe.
const players = [null], ready = [false], loaded = [null];
const unlocked = [false];
let current = 0, soundOn = false, playRequested = false, startTimer, verifyTimer, soundTimer, endTimer, seekDragging = false;
// Feed playback hands YouTube a playlist so the player itself starts the next song, even while iOS
// suspends this page. playlistIds mirrors what the player holds; pending until it reports the first item.
let playlistIds = null, playlistPending = false;
// Explore mode (default): one video per swipe via loadVideoById, the fastest start; auto-next runs
// from page JS, so it only works while the page is visible. Run mode: the player-held playlist
// above, so songs keep chaining with the phone locked; swipes inside the queue use playVideoAt.
const runMode = () => opts.playMode === 'run' && opts.autoNext !== false;
let awaitVid = null, pendingSeek = null;
const wrap = () => $('#pA');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const https = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } };
function fmt(value) { const t = Math.max(0, Math.floor(value || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
function notify(message, duration = 6000) {
  clearTimeout(noticeTimer); $('#status').textContent = message;
  if (duration) noticeTimer = setTimeout(() => { $('#status').textContent = ''; }, duration);
}
function saveStats() { stats.deadIds = [...deadIds].slice(-5000); storage.set('dx_stats', stats); }

// Same IndexedDB cache schema as v2, so existing release/search caches remain usable.
const cache = {
  async open() {
    if (!this.promise) this.promise = new Promise(resolve => {
      try {
        const req = indexedDB.open('crateswipe', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv', {keyPath:'k'}).createIndex('t', 't');
        req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return this.promise;
  },
  async get(key) {
    const db = await this.open(); if (!db) return null;
    return new Promise(resolve => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => resolve(q.result || null); q.onerror = () => resolve(null); });
  },
  async put(key, value) {
    const db = await this.open(); if (!db) return;
    await new Promise(resolve => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({k:key,v:value,t:Date.now()}); tx.oncomplete = tx.onerror = () => resolve(); });
    this.puts = (this.puts || 0) + 1;
    if (this.puts % 50 === 0) {
      const n = await this.count(); let remove = n - 3600;
      if (n > 4000) { const q = db.transaction('kv', 'readwrite').objectStore('kv').index('t').openCursor(); q.onsuccess = () => { const c = q.result; if (c && remove-- > 0) { c.delete(); c.continue(); } }; }
    }
  },
  async count() { const db = await this.open(); if (!db) return 0; return new Promise(resolve => { const q = db.transaction('kv').objectStore('kv').count(); q.onsuccess = () => resolve(q.result); q.onerror = () => resolve(0); }); }
};

function show(dialog) {
  if (currentModal === dialog) return;
  if (currentModal) hide({restorePlayback:false,returnSetup:false});
  opener = document.activeElement;
  currentModal = dialog;
  document.body.classList.add('overlay');
  $('#veil').hidden = false;
  for (const el of [$('#feed'),$('#bar'),$('#empty')]) el.inert = true;
  if (dialog === $('#session') || dialog === $('#release')) { dialog.append($('#dock')); dialog.classList.toggle('with-player',!!playing.song); }
  else $('#dock').hidden = true;
  dialog.setAttribute('aria-modal','true');
  // Non-top-layer dialog keeps the original YouTube iframe nodes stable during iOS sound unlock.
  dialog.show();
  updateSound();
  requestAnimationFrame(syncGeometry);
}
function hide(options) {
  if (currentModal === $('#setup') && setupReturn && options?.returnSetup !== false) {
    const back = setupReturn; setupReturn = null;
    hide({restorePlayback:false,returnSetup:false}); show(back); return;
  }
  const old = currentModal; if (!old) return;
  currentModal = null; old.close();
  // Closing Filters without a dig: back to the shared track instead of sitting on the gate.
  if (old === $('#pick') && shareGate && sharedCard && cards[active] === sharedCard) $('#feed').scrollTop = sharedCard.el.offsetTop;
  $('#dockHome').after($('#dock')); document.body.classList.remove('overlay');
  $('#veil').hidden = true;
  for (const el of [$('#feed'),$('#bar'),$('#empty')]) el.inert = false;
  if (returnPlayback && options?.restorePlayback !== false) {
    const saved = returnPlayback; returnPlayback = null;
    if (saved.source === 'feed' && deadIds.has(saved.song.vid)) {
      playing = saved; discardUnavailable(saved.song.vid);
      if (saved.paused && playing.song) pausePlayback();
    } else play(saved.song, saved.source, saved.list, saved.index, saved.time, saved.paused);
  }
  renderDock();
  updateSound();
  requestAnimationFrame(syncGeometry);
  opener?.isConnected && opener.focus();
}
$('#veil').onclick = hide;
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('cancel', event => { event.preventDefault(); hide(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && event.clientX < dialog.getBoundingClientRect().left) hide(); });
});
for (const [id, fn] of [['closeSetup',hide],['closePick',hide],['closeSession',hide]]) $('#' + id).onclick = fn;

GENRES.forEach(value => $('#genre').add(new Option(value, value)));
STYLES.forEach(value => { const o = document.createElement('option'); o.value = value; $('#styles').append(o); });
async function openPick() {
  const values = shareGate ? shareFilters(opts,sharePrefillOpts) : opts;
  for (const k of ['genre','style','label','country','y1','y2','startAt']) $('#' + k).value = values[k] ?? '';
  $('#hideSeen').checked = opts.hideSeen !== false; $('#autoNext').checked = opts.autoNext !== false; $('#playMode').value = opts.playMode === 'run' ? 'run' : 'explore';
  $('#seenCount').textContent = `${seen.size.toLocaleString()} songs seen on this device.`;
  const s = explorer?.state.stats || {};
  $('#stats').textContent = `Songs played: ${stats.played}\nUnavailable videos skipped: ${stats.dead}\nYouTube errors: ${JSON.stringify(stats.codes)}\nThis dig: ${explorer?.fetched || 0} releases, ${s.songs || 0} songs\nHigh / probable / unmatched: ${s.conf_high || 0} / ${s.conf_low || 0} / ${s.conf_none || 0}\nAPI requests: ${api?.count || 0}\nCached records: ${await cache.count()} (cap 4000)`;
  show($('#pick'));
}
$('#chip').onclick = openPick;
function openSetup() {
  setupReturn = currentModal;
  $('#saveTok').textContent = guestSession?.session.items.length ? 'Connect & save finds' : 'Connect Discogs';
  $('#err').textContent = ''; show($('#setup'));
}
$('#emptyAction').onclick = () => $('#emptyAction').dataset.connect ? openSetup() : openPick();
$('#resetSeen').onclick = () => { seen.clear(); storage.set('dx_seen', []); $('#seenCount').textContent = 'Seen songs cleared.'; };
$('#resetStats').onclick = () => { stats = {played:0,dead:0,codes:{},deadIds:[]}; deadIds.clear(); videoAvailability.clear(); saveStats(); openPick(); };
$('#changeTok').onclick = () => { if (connecting || model?.pending.size || guestSession?.syncing) return notify('Wait for your save to finish.'); openSetup(); };
$('#useGuest').onclick = () => {
  if (connecting || model?.pending.size || guestSession?.syncing) return;
  try { localStorage.removeItem('dx_token'); localStorage.removeItem('dx_user'); } catch {}
  model = guestSession; api = catalogue; accountAPI = null; hide(); renderDock(); renderSession();
  if (!playing.song) openPick();
};
$('#goBtn').onclick = () => {
  const values = Object.fromEntries(['genre','style','label','country','y1','y2','startAt'].map(k => [k, $('#' + k).value.trim()]));
  for (const k of ['y1','y2']) if (values[k] && (!/^\d{4}$/.test(values[k]) || +values[k] < 1900 || +values[k] > new Date().getFullYear() + 1)) return notify('Enter a valid four-digit year.');
  if (values.y1 && values.y2 && Math.abs(+values.y2 - +values.y1) > 60) return notify('Choose a year range of 60 years or less.');
  opts = {...values,hideSeen:$('#hideSeen').checked,autoNext:$('#autoNext').checked,playMode:$('#playMode').value === 'run' ? 'run' : 'explore'}; storage.set('dx_opts', opts);
  if (shareGate) {
    shareGate = false;
    // The link did its job: a reload now resumes this dig (card 0 stays pinned until then).
    const clean = new URLSearchParams(location.search); clean.delete('share'); clean.delete('yt');
    try { history.replaceState(null,'',location.pathname + (clean.size ? '?' + clean : '') + location.hash); } catch {}
  }
  hide(); start();
};
// Switching Explore/Run applies right away and keeps the dig and the current song where they are.
$('#playMode').onchange = () => {
  opts = {...opts,playMode:$('#playMode').value === 'run' ? 'run' : 'explore'}; storage.set('dx_opts', opts);
  fill();
  if (playing.source === 'feed' && playing.song && ready[current]) { const snap = snapshot(); play(snap.song,'feed',[],active,snap.time,snap.paused); }
};
function connect(token, username) {
  const client = new Discogs(token, {dryRun, onAuthError:() => {
    if (accountAPI !== client) return;
    if (model) { model.health = 'unknown'; model.changed(); }
    notify('Your Discogs token was rejected. Reconnect in filters.', 10000);
  }, onRateLimit:wait => {
    if (accountAPI !== client || (cards.length && recoveringAt === null)) return;
    // With no feed yet, explain the delay inline instead of raising a repeated toast.
    if (wait) $('#emptyMsg').textContent = 'Discogs is reconnecting. Retrying…';
    else if ($('#emptyMsg').textContent.startsWith('Discogs is reconnecting.')) $('#emptyMsg').textContent = 'Digging through Discogs…';
  }});
  api = client; accountAPI = client;
  model = new SessionDiscoveries(username, storage, (...args) => client.req(...args), () => { renderDock(); renderSession(); });
  const account = model; renderDock(); renderSession();
  return loadWants().then(()=>account);
}
async function loadWants() {
  const account = model, client = accountAPI; if (!account || account.isGuest || !client) return;
  await account.refresh(async () => {
    const records = []; let page = 1, pages = 1;
    do {
      const d = await client.get('/users/' + encodeURIComponent(account.username) + '/wants?per_page=100&page=' + page, 2);
      pages = d.pagination?.pages || 1;
      for (const w of d.wants || []) records.push({id:w.id,masterId:w.basic_information?.master_id || 0});
      page++;
    } while (page <= pages);
    return records;
  });
  if (account === model && account.health === 'unknown') notify('Wantlist unavailable. Open “This session” to retry.',10000);
  else if (account === model && $('#status').textContent.startsWith('Wantlist unavailable.')) notify('');
}
$('#tokenForm').onsubmit = async event => {
  event.preventDefault(); if (connecting || model?.pending.size || guestSession?.syncing) return notify('Wait for your save to finish.');
  const token = $('#tok').value.trim(); if (!token) return;
  connecting = true; $('#saveTok').disabled = true; $('#err').textContent = 'Checking your token…';
  try {
    const response = await fetch('https://api.discogs.com/oauth/identity', {headers:{Authorization:'Discogs token=' + token},signal:AbortSignal.timeout(15000)});
    const identity = await response.json();
    if (!response.ok || !identity.username) throw Error('identity');
    let remembered = true;
    try { localStorage.setItem('dx_token', token); remembered = storage.set('dx_user', identity.username); } catch { remembered = false; }
    $('#tok').value = ''; $('#err').textContent = 'Saving to @' + identity.username + '…';
    const account = await connect(token, identity.username);
    if (account.health === 'ready' && guestSession.unsaved(account.username).length) await guestSession.syncTo(account);
    hide({restorePlayback:false,returnSetup:false}); setupReturn = null;
    if (playing.song || reviewItems().length) { show($('#session')); renderSession(); } else openPick();
    if (!remembered) notify('Connected for this visit. This browser couldn’t remember your token.',10000);
  } catch { $('#err').textContent = 'Couldn’t connect to Discogs. Check your token and connection, then try again.'; }
  finally { connecting = false; $('#saveTok').disabled = false; }
};

function artHTML(song) {
  const src = https(song.cover || song.cover2);
  return `<div class="ph"><b>${esc(song.artist)}</b><span>${esc(song.releaseTitle)}</span></div>${src || (fixture && song.cover?.startsWith('tests/')) ? `<img src="${esc(src || song.cover)}" data-alt="${esc(https(song.cover2))}" alt="${esc(song.releaseTitle)} cover" decoding="async">` : ''}`;
}
function wireArt(root) {
  const img = root.querySelector('img'); if (!img) return;
  img.onerror = () => { if (img.dataset.alt && img.src !== img.dataset.alt) { img.src = img.dataset.alt; img.dataset.alt = ''; } else img.remove(); };
}
function setBackdrop(song) {
  const src = https(song?.cover || song?.cover2) || (fixture ? song?.cover : '');
  $('#backdrop').style.backgroundImage = src ? `url("${src.replace(/["\\\n\r]/g, '')}")` : 'none';
}
async function start() {
  if (!model) return;
  if (explorer) explorer.stopped = true;
  const generation = ++feedGeneration; recoveringAt = null; discoveryError = false; guestServiceUnavailable = false;
  observer.disconnect();
  const keep = sharedCard, keepPlaying = !!keep && playing.source === 'feed' && playing.song?.vid === keep.song.vid;
  if (!keepPlaying) { stopPlayers(); playing = {source:'feed',song:null,list:[],index:-1}; }
  pool = []; reserve = []; cards = keep ? [keep] : []; active = keep ? 0 : -1; gap = 15; buffer = model.isGuest ? 5 : 30;
  $('#feed').replaceChildren(); gate = null; digLoading = !!keep; renderDock();
  const from = Number(opts.y1), to = Number(opts.y2); let years = [null];
  if (from && to) { const lo = Math.min(from,to), hi = Math.max(from,to); years = Array.from({length:hi-lo+1}, (_,i) => lo+i); } else if (from || to) years = [from || to];
  const yearLabel = years[0] === null ? 'Any year' : years.length > 1 ? `${years[0]}–${years.at(-1)}` : years[0];
  $('#chip').textContent = [opts.style || opts.genre || 'All vinyl',yearLabel,opts.label,opts.country].filter(Boolean).join(' · ');
  $('#empty').hidden = false; $('#spin').hidden = false; $('#emptyAction').hidden = true; $('#emptyAction').dataset.connect = ''; $('#emptyAction').textContent = 'Choose genre & year'; $('#emptyMsg').textContent = 'Digging through Discogs…';
  if (keep) {
    // Card 0 stays; the dig loads behind a gate card that shows progress, then card 1 takes over.
    $('#feed').append(keep.el); observer.observe(keep.el); addGate(); setGate('Digging through Discogs…',true);
    $('#empty').hidden = true; $('#feed').scrollTop = gate.offsetTop;
  }
  if (fixture) {
    const checks = await Promise.all(fixtureData.songs.map(s => videoAvailability.check(s.vid)));
    if (generation !== feedGeneration) return;
    fixtureData.songs.forEach((s,i) => { if (checks[i] !== false && !deadIds.has(s.vid) && s.vid !== sharedCard?.song.vid) addCard({...s}); });
    fill(); $('#spin').hidden = true;
    if (digLoading && cards.length < 2) setGate('No playable tracks for this dig. Try another filter or reset seen songs.');
    return;
  }
  const next = new Explorer(discoveryClient, {...opts, years, cache,hitTarget:model.isGuest?30:300, skipVid:{has:id => deadIds.has(id) || id === sharedCard?.song.vid || (opts.hideSeen !== false && seen.has(id))},
    checkVideo:id => videoAvailability.check(id),
    shouldPause:() => Math.max(0,cards.length-active-1) + poolVariety(pool,cards.slice(-gap).map(c=>c.song),gap) >= buffer,
    onSongs:(songs, x) => { if (explorer !== x) return; guestServiceUnavailable = false; const choice = primaryPick(songs); pool.push(choice.pick); reserve.push(...choice.rest); fill(); },
    onProgress:(x, error) => {
      if (explorer !== x || x.stopped) return;
      if (x.total) { gap = adaptiveGap(x.total,x.fetched,x.withSongs); buffer = model.isGuest ? 5 : Math.max(10,2*gap); }
      if (x.done && reserve.length) { pool.push(...reserve); reserve = []; }
      if (x.done) fill();
      if (error) {
        discoveryError = true;
        if (model.isGuest && !digCount()) {
          guestServiceUnavailable = true;
          if (digLoading) setGate('Guest discovery is unavailable right now. Swipe up to keep listening, or try again shortly.');
          $('#emptyMsg').textContent = 'Guest discovery is unavailable right now. Connect your Discogs account to keep digging.';
          $('#emptyAction').hidden = false; $('#emptyAction').textContent = 'Connect Discogs'; $('#emptyAction').dataset.connect = '1';
        }
        // Background retries stay quiet while there are tracks to browse.
        if ((!digCount() || recoveringAt !== null) && Date.now()-lastDiscoveryNotice > 60000) {
          lastDiscoveryNotice = Date.now(); notify('Can’t load tracks right now. Retrying…',10000);
        }
      } else discoveryError = false;
      if (params.has('debug')) $('#stats').textContent = JSON.stringify({fetched:x.fetched,stats:x.state.stats,gap,buffer,pool:pool.length},null,2);
      if (x.done && digLoading && !digCount() && !guestServiceUnavailable) setGate(x.total ? 'No playable tracks for this dig. Try another filter or reset seen songs.' : 'No vinyl records found. Try another style or year.');
      if (x.done && !cards.length && !guestServiceUnavailable) { $('#spin').hidden = true; $('#emptyAction').hidden = false; $('#emptyMsg').textContent = x.total ? 'No playable tracks for this dig. Try another filter or reset seen songs.' : 'No vinyl records found. Try another style or year.'; }
    }});
  explorer = next; next.run().catch(() => notify('Discovery stopped. Change your filters to try again.'));
}
function fill() {
  while (pool.length && cards.length-active <= (runMode() ? PLAYLIST_MAX : 3)) {
    const index = chooseNext(pool,cards.slice(-gap).map(c=>c.song),{gap,ahead:cards.length-active-1});
    if (index < 0) break;
    addCard(pool.splice(index,1)[0]);
    if (reserve.length && Math.random() < .15) pool.push(reserve.splice(Math.floor(Math.random()*reserve.length),1)[0]);
  }
  if (recoveringAt !== null && cards[recoveringAt]) {
    const index = recoveringAt; recoveringAt = null;
    $('#feed').scrollTop = cards[index].el.offsetTop; activate(index);
  }
  if (cards.length && recoveringAt === null) { $('#empty').hidden = true; if (active < 0) activate(0); }
  // First dig card after Apply: drop the gate and land on card 1. Card 0 stays one swipe up.
  if (digLoading && cards.length > 1 && recoveringAt === null && cards[0] === sharedCard) {
    digLoading = false; observer.unobserve(gate); gate.remove(); gate = null;
    $('#feed').scrollTop = cards[1].el.offsetTop; activate(1); return;
  }
  preload();
}
const digCount = () => cards.length - (sharedCard && cards[0] === sharedCard ? 1 : 0);
function addGate() {
  gate = document.createElement('section'); gate.className = 'card gate'; gate.setAttribute('aria-label','Start your own dig');
  gate.innerHTML = `<div class="gate-copy"><div class="spin" hidden></div><p class="eyebrow">YOUR TURN</p><h2>Start your own dig</h2><p class="small gate-msg">Pick a genre or a year. Swipe up any time to hear the shared track again.</p><button class="pill">Choose your dig</button></div>`;
  gate.querySelector('button').onclick = openPick;
  $('#feed').append(gate); observer.observe(gate);
}
function setGate(message, loading = false) {
  if (!gate) return;
  gate.querySelector('.spin').hidden = !loading; gate.querySelector('.gate-msg').textContent = message;
  gate.querySelector('h2').textContent = loading ? 'Digging…' : 'Start your own dig';
  gate.querySelector('button').hidden = loading;
}
async function loadRelease(id) {
  if (fixture) return fixtureData.releases.get(id) || null;
  const hit = await cache.get('r:'+id); if (hit?.v) return hit.v;
  const raw = await Promise.race([api.get('/releases/'+id,3),new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),20000))]);
  const rel = slimRelease(raw); cache.put('r:'+id,rel); return rel;
}
// Open a share link: that exact track as card 0, no filters applied; the recipient picks their own dig.
async function startShared() {
  shareGate = true; ++feedGeneration;
  $('#chip').textContent = 'Pick your dig…';
  $('#empty').hidden = false; $('#spin').hidden = false; $('#emptyAction').hidden = true; $('#emptyMsg').textContent = 'Loading the shared track…';
  let rel = null, song = null;
  if (!share.invalid) {
    try { rel = await loadRelease(share.releaseId); } catch {}
    song = sharedSong(rel,share.vid);
    if (song && (deadIds.has(song.vid) || await videoAvailability.check(song.vid) === false)) song = null;
  }
  sharePrefillOpts = sharePrefill(rel); $('#spin').hidden = true;
  if (!song) return shareMissing();
  addCard(song); sharedCard = cards[0]; addGate(); fill();
}
function shareMissing() {
  $('#empty').hidden = false; $('#spin').hidden = true;
  $('#emptyMsg').textContent = 'Couldn’t find that track.'; $('#emptyAction').hidden = false; $('#emptyAction').dataset.connect = ''; $('#emptyAction').textContent = 'Start your own dig';
  notify('Couldn’t find that track. Pick a genre or year to start digging.',10000); openPick();
}
function addCard(song) {
  const el = document.createElement('section'); el.className = 'card'; el.setAttribute('aria-label',song.trackTitle || song.videoTitle);
  el.innerHTML = `<div class="composition"><button class="release-meta" aria-label="Explore ${esc(song.releaseTitle)}"><b>${esc(song.releaseTitle)}</b><span>${esc([song.label,song.year,song.country].filter(Boolean).join(' · '))}</span></button><div class="cover-stage"><div class="art">${artHTML(song)}</div></div></div>`;
  wireArt(el.querySelector('.art'));
  el.querySelector('.release-meta').onclick = event => { event.stopPropagation(); openRelease(song); };
  let lastTap = 0, tapTimer;
  el.addEventListener('click', event => {
    if (event.target.closest('button,a')) return;
    const now = Date.now();
    if (now-lastTap < 300) { clearTimeout(tapTimer); lastTap = 0; like(song); return; }
    lastTap = now;
    if (cards[active]?.el !== el) return;
    // Safari needs play/unmute in the original gesture. Only defer pausing for double-tap likes.
    if (!soundOn || !ready[current] || players[current].getPlayerState() !== 1) togglePlay();
    else tapTimer = setTimeout(() => { if (cards[active]?.el === el) pausePlayback(); },300);
  });
  if (gate?.isConnected) gate.before(el); else $('#feed').append(el);
  cards.push({el,song}); observer.observe(el);
}
const observer = new IntersectionObserver(entries => {
  if (currentModal) return;
  for (const e of entries) if (e.intersectionRatio > .7) {
    // First swipe down from the shared track opens Filters; card 0 keeps playing meanwhile.
    if (e.target === gate) { if (shareGate) openPick(); continue; }
    const i = cards.findIndex(c=>c.el===e.target); if (i >= 0 && i !== active) activate(i);
  }
}, {root:$('#feed'),threshold:[.7]});
function activate(index) {
  active = index; const song = cards[index]?.song; if (!song) return;
  if (deadIds.has(song.vid)) return discardUnavailable(song.vid);
  if (!seen.has(song.vid)) { seen.add(song.vid); storage.set('dx_seen',[...seen].slice(-20000)); }
  play(song,'feed',[],index); fill();
}
function go(direction) {
  let index = active + direction;
  while (cards[index]?.song.dead) index += direction;
  if (cards[index]) cards[index].el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  else if (direction > 0 && gate) gate.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  else if (direction > 0) notify(discoveryError ? 'Discovery is reconnecting. Please try again shortly.' : explorer?.done || fixture ? 'You’ve reached the end of this dig.' : 'Still digging for the next track…');
}

// Playback identity is independent of the feed index: session/panel replay never advances the hidden feed.
function snapshot() { return {...playing,time:ready[current] ? players[current].getCurrentTime() : 0,paused:!playRequested || (ready[current] && [2,5].includes(players[current].getPlayerState()))}; }
function replay(song, source, list, index) {
  if (playing.source === source && playing.song?.vid === song.vid) return togglePlay();
  if (!returnPlayback && playing.song) returnPlayback = snapshot();
  play(song,source,list,index);
  if (!soundOn) soundTap();
}
function play(song, source = 'feed', list = [], index = -1, time = null, paused = false) {
  if (!song) return;
  playing = {source,song,list,index}; setBackdrop(song); renderDock();
  requestAnimationFrame(syncGeometry);
  clearPlaybackTimers(); playRequested = !paused; $('#paused').style.display = 'none';
  clearUnlock();
  if (!ready[current]) return;
  const player = players[current];
  const offset = time ?? ((song.duration && Number(opts.startAt) > song.duration-30) ? 0 : Number(opts.startAt) || 0);
  // Same iframe every time: never swap players, so the first sound tap stays valid on iOS.
  if (soundOn) { player.unMute(); player.setVolume(100); } else player.mute();
  loaded[current] = song.vid; awaitVid = null; pendingSeek = null;
  const queue = source === 'feed' && runMode() && !!player.loadPlaylist;
  // Run mode swipe to a card the player already holds: jump inside the queue, no rebuild.
  const at = queue && !paused && time === null && player.playVideoAt ? playlistJump(playlistIds,song.vid,playlistPending) : -1;
  if (at >= 0) {
    awaitVid = song.vid; if (offset > 0) pendingSeek = {vid:song.vid,offset};
    player.playVideoAt(at);
    startTimer = setTimeout(() => { if (player.getPlayerState() === 2) needTap(); },3500);
    updateSound(); return;
  }
  // Run mode: queue this card and the upcoming ones in the same player (never a new iframe).
  const ids = queue ? playlistWindow(cards,index,isDead) : null;
  playlistIds = ids; playlistPending = !!ids;
  if (paused) {
    if (ids) player.cuePlaylist({playlist:ids,index:0,startSeconds:offset}); else player.cueVideoById({videoId:song.vid,startSeconds:offset});
    $('#paused').style.display = 'block';
  } else {
    if (ids) player.loadPlaylist({playlist:ids,index:0,startSeconds:offset}); else player.loadVideoById({videoId:song.vid,startSeconds:offset});
    startTimer = setTimeout(() => {
      // Only paused (2) means Safari refused playback. Unstarted/cued is still loading — don't flash the cover hint.
      const state = player.getPlayerState(); if (state === 2) needTap();
    },3500);
  }
  updateSound();
}
const isDead = vid => deadIds.has(vid);
function reportedVid(player) {
  try { const id = player.getVideoData?.()?.video_id; if (id) return id; } catch {}
  try { const id = new URL(player.getVideoUrl()).searchParams.get('v'); if (id) return id; } catch {}
  const i = player.getPlaylistIndex?.(); return i >= 0 ? playlistIds?.[i] : null;
}
// The player advanced its own playlist: bring the feed, dock, seen set and glow in step without
// loading anything (a load would reset the chain). Returns true when the UI moved.
function syncPlaylist() {
  if (!playlistIds || playing.source !== 'feed' || !ready[current] || !playing.song) return false;
  const player = players[current], vid = reportedVid(player);
  // Ignore reports from the previous queue until the player shows the playlist we just loaded.
  if (playlistPending) {
    let list = null; try { list = player.getPlaylist?.(); } catch {}
    if (vid === playlistIds[0] || (Array.isArray(list) && list.join() === playlistIds.join())) playlistPending = false;
    else return false;
  }
  // After a playVideoAt jump, ignore the previous song's reports until the target shows up.
  if (awaitVid) { if (vid !== awaitVid) return false; awaitVid = null; }
  const pos = playlistMove(playlistIds,vid,playing.song.vid); if (pos < 0) return false;
  let index = cards.findIndex((c,i)=>i > active && c.song.vid === vid);
  if (index < 0) index = cards.findIndex(c=>c.song.vid === vid);
  // The card was removed meanwhile: drop the chain and let the normal recovery path take over.
  if (index < 0) { playlistIds = null; return false; }
  clearTimeout(endTimer); clearPlaybackTimers();
  const song = cards[index].song; active = index;
  if (!seen.has(song.vid)) { seen.add(song.vid); storage.set('dx_seen',[...seen].slice(-20000)); }
  playing = {source:'feed',song,list:[],index}; loaded[current] = song.vid;
  setBackdrop(song); renderDock();
  // Instant scroll: the observer sees the already-active card and does not reload it.
  const feed = $('#feed'); if (Math.abs(feed.scrollTop-cards[index].el.offsetTop) > 1) feed.scrollTop = cards[index].el.offsetTop;
  requestAnimationFrame(syncGeometry); fill();
  const upcoming = cards.slice(index+1).filter(c=>!c.song.dead && !isDead(c.song.vid)).length;
  if (shouldRefresh(playlistIds,pos,upcoming,document.hidden)) {
    const ids = playlistWindow(cards,index,isDead); playlistIds = ids; playlistPending = true;
    player.loadPlaylist({playlist:ids,index:0,startSeconds:player.getCurrentTime() || 0});
  }
  return true;
}
function nextSong() {
  if (playing.source === 'feed') return cards.slice(active+1).find(c=>!c.song.dead)?.song;
  return playing.list.slice(playing.index+1).find(s=>!deadIds.has(s.vid));
}
function preload() {} // Single-player mode: nothing to preload into a second iframe.
function advance() {
  if (playing.source === 'feed') {
    // Activate directly: IntersectionObserver and smooth scrolling do not run while the page is hidden.
    let index = active+1; while (cards[index] && (cards[index].song.dead || isDead(cards[index].song.vid))) index++;
    // The shared track ended before a dig exists: stop there; the gate is one swipe away.
    if (!cards[index] && gate) return;
    if (!cards[index]) return go(1);
    activate(index); cards[index].el.scrollIntoView({behavior:document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    return;
  }
  const song = nextSong();
  if (song) play(song,playing.source,playing.list,playing.list.indexOf(song));
  else { players[current]?.pauseVideo(); notify('End of this selection.'); }
}
function onState(k, event) {
  if (k === current && event.data !== 0) syncPlaylist();
  if (k !== current || !playing.song || loaded[k] !== playing.song.vid) return;
  // Restoring a paused track cues it (state 5); it stays paused until the user resumes.
  $('#paused').style.display = event.data === 2 || (event.data === 5 && !playRequested) ? 'block' : 'none';
  // Paused without the user asking (iOS refused sound): offer the one-time tap again, never a muted fallback.
  if (event.data === 2 && playRequested && soundOn && !unlocked[k]) needTap();
  if (event.data === 1) {
    clearTimeout(startTimer);
    if (pendingSeek && reportedVid(players[k]) === pendingSeek.vid) { const s = pendingSeek; pendingSeek = null; if ((players[k].getCurrentTime() || 0) < s.offset-2) players[k].seekTo(s.offset,true); }
    if (soundOn && players[k].isMuted()) players[k].unMute();
    if (!players[k].isMuted()) { soundOn = true; unlocked[k] = true; clearUnlock(); }
    if (!playing.counted) { playing.counted = true; stats.played++; saveStats(); }
    updateSound();
  }
  if (event.data === 0 && opts.autoNext !== false) {
    clearTimeout(endTimer);
    const pos = playlistIds && playing.source === 'feed' ? playlistIds.indexOf(playing.song.vid) : -1;
    // Mid-playlist the player chains by itself; only step in if it has not moved shortly after.
    if (pos >= 0 && pos < playlistIds.length-1) endTimer = setTimeout(() => { if (ready[current] && players[current].getPlayerState() === 0 && !syncPlaylist()) advance(); },2500);
    else advance();
  }
  renderSession();
}
function onError(k, event) {
  if (k === current) syncPlaylist();
  const vid = loaded[k]; if (!vid) return;
  stats.codes[event.data] = (stats.codes[event.data] || 0)+1;
  if (![100,101,150].includes(event.data)) {
    // HTML5/network and embed-configuration failures do not prove the video was deleted.
    saveStats(); clearPlaybackTimers();
    if (k === current) notify('YouTube couldn’t play this track. Tap the cover to retry or open its YouTube link.',10000);
    return;
  }
  if (!deadIds.has(vid)) stats.dead++;
  deadIds.add(vid); videoAvailability.remember(vid, false); saveStats(); loaded[k] = null;
  const failedFeed = playing.source === 'feed' && playing.song?.vid === vid;
  discardUnavailable(vid);
  if (!failedFeed && k === current && playing.song?.vid === vid) { renderDock(); advance(); }
}
function discardUnavailable(vid) {
  // The shared track turned out unplayable before any dig: fail soft into Filters.
  if (sharedCard?.song.vid === vid && digCount() === 0 && playing.source === 'feed') {
    observer.disconnect(); stopPlayers(); sharedCard = null; gate = null; digLoading = false; cards = []; active = -1;
    playing = {source:'feed',song:null,list:[],index:-1}; $('#feed').replaceChildren(); renderDock();
    if (shareGate) return shareMissing();
    return start();
  }
  const currentEl = cards[active]?.el, failed = cards[active]?.song.vid === vid;
  // Keep a covered feed's active slot stable until closing its preview restores the feed.
  if (failed && playing.source !== 'feed') return;
  const nextIndex = cards.slice(0,active).filter(c=>c.song.vid !== vid).length;
  cards = cards.filter(card => {
    if (card.song.vid !== vid) return true;
    observer.unobserve(card.el); card.el.remove(); return false;
  });
  if (sharedCard && !cards.includes(sharedCard)) sharedCard = null;
  if (!failed) { active = cards.findIndex(c=>c.el === currentEl); fill(); return; }
  active = nextIndex-1; recoveringAt = nextIndex;
  stopPlayers(); playing = {source:'feed',song:null,list:[],index:-1}; renderDock();
  $('#empty').hidden = false; $('#spin').hidden = !!(explorer?.done || fixture);
  $('#emptyMsg').textContent = explorer?.done || fixture ? 'No more playable tracks in this dig.' : 'Finding another playable track…';
  fill();
}
function needTap() {
  if (!ready[current] || !playRequested) return;
  if (currentModal && !['session','release'].includes(currentModal.id)) return;
  // Sound stays on: the user only ever turns it off with mute. If nothing has been unlocked yet,
  // show the plain "turn sound on" button; otherwise arm the invisible tap target over the cover.
  if (!soundOn) { updateSound(); return; }
  syncGeometry();
  players[current].unMute(); wrap(current).classList.add('unlock');
  // Keep the iframe in place: reparenting it can reload the player and lose Safari sound permission.
  // The iframe is fully transparent; the user sees and taps the cover artwork only.
  $('#hint').hidden = false; $('#sound').hidden = true;
}
function clearUnlock() { wrap(current).classList.remove('unlock'); $('#hint').hidden = true; }
function updateSound() { $('#sound').hidden = (currentModal && !['session','release'].includes(currentModal.id)) || !playing.song || soundOn || !ready[current] || wrap(current).classList.contains('unlock'); }
function soundTap() {
  if (!ready[current]) return;
  clearTimeout(soundTimer); clearUnlock();
  const k = current; playRequested = true; soundOn = true; players[k].unMute(); players[k].setVolume(100); players[k].playVideo();
  soundTimer = setTimeout(() => {
    if (k !== current || !playRequested) return;
    const state = players[k].getPlayerState();
    if (state === 1 && !players[k].isMuted()) unlocked[k] = true;
    // Paused after an unmute attempt: iOS blocked sound. Still loading (unstarted/cued) is fine.
    else if (state === 2) needTap();
    updateSound();
  },1000); updateSound();
}
function clearPlaybackTimers() {
  clearTimeout(startTimer); clearTimeout(verifyTimer); clearTimeout(soundTimer);
}
function pausePlayback() {
  playRequested = false; clearPlaybackTimers(); clearUnlock();
  players[current].pauseVideo(); updateSound();
}
function togglePlay() {
  if (!ready[current]) return;
  if (soundOn && playRequested && players[current].getPlayerState() === 1) return pausePlayback();
  if (!soundOn) return soundTap();
  playRequested = true; players[current].playVideo();
}
function stopPlayers() {
  playRequested = false; clearPlaybackTimers();
  clearUnlock(); if (ready[current]) players[current].stopVideo(); loaded[current] = null; playlistIds = null; awaitVid = null; pendingSeek = null; clearTimeout(endTimer);
  $('#sound').hidden = true; $('#hint').hidden = true; $('#paused').style.display = 'none';
}
$('#sound').onclick = soundTap;
// Returning from the background: catch up with a chain that moved, or restart one that ran out.
function resumeSync() {
  if (document.hidden || !ready[current] || !playing.song) return;
  if (syncPlaylist()) return;
  if (players[current].getPlayerState() === 0 && playRequested && opts.autoNext !== false) { clearTimeout(endTimer); advance(); return; }
  const card = playing.source === 'feed' && !currentModal && cards[active];
  if (card && card.song.vid === playing.song.vid && Math.abs($('#feed').scrollTop-card.el.offsetTop) > 1) $('#feed').scrollTop = card.el.offsetTop;
  renderDock(); requestAnimationFrame(syncGeometry);
}
document.addEventListener('visibilitychange',resumeSync);
window.addEventListener('pageshow',resumeSync);
function attachPlayers(factory) {
  const k = 0; players[k] = factory(k, {
    onReady:() => { ready[k] = true; if (playing.song) play(playing.song,playing.source,playing.list,playing.index); },
    onStateChange:e => onState(k,e), onError:e => onError(k,e)
  });
}
function initYouTube() {
  window.onYouTubeIframeAPIReady = () => attachPlayers((k,events) => new YT.Player('yt'+k, {
    host:'https://www.youtube.com',width:'100%',height:'100%',
    playerVars:{playsinline:1,autoplay:0,mute:1,controls:0,cc_load_policy:0,iv_load_policy:3,fs:0,rel:0,disablekb:1,enablejsapi:1,origin:location.origin},events
  }));
  const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = () => notify('YouTube couldn’t load. Check your connection or open the video link.',10000); document.head.append(script);
}

function renderDock() {
  $('#changeTok').textContent = model?.isGuest ? 'Connect Discogs' : 'Change account';
  const releaseButton = $('#releaseLike');
  if (releaseButton && releaseSong && model) {
    const target = actionModel(releaseSong);
    releaseButton.textContent = target.has(releaseSong) ? target.isGuest ? 'Remove from session' : 'Remove from wantlist' : target.isGuest ? 'Save to session' : 'Add to wantlist';
    releaseButton.disabled = target.health !== 'ready' || target.busy(releaseSong) || guestSession?.syncing;
  }
  const song = playing.song; $('#dock').hidden = !song || (currentModal && !['session','release'].includes(currentModal.id));
  if (!song) return;
  $('#artist').textContent = song.artist; $('#track').textContent = song.trackTitle || song.videoTitle;
  $('#youtube').href = 'https://www.youtube.com/watch?v=' + song.vid; $('#videoTitle').textContent = song.videoTitle;
  const target = model && actionModel(song);
  const wanted = !!target?.has(song), busy = !!target?.busy(song) || !!guestSession?.syncing;
  $('#heart').classList.toggle('on',wanted); $('#heart').setAttribute('aria-pressed',String(wanted)); $('#heart').setAttribute('aria-busy',String(busy));
  $('#heart').setAttribute('aria-label',target?.isGuest ? wanted ? 'Remove track from session' : 'Save track to session' : wanted ? 'Remove record from wantlist' : 'Add record to wantlist');
  $('#heart').disabled = !target || target.health !== 'ready' || busy;
  const warning = deadIds.has(song.vid) ? 'Video unavailable · open in YouTube or try another track' : song.conf === 'low' ? 'Probable track match' : song.conf === 'none' ? 'Track unmatched · showing the YouTube title' : '';
  $('#matchWarning').textContent = warning; $('#matchWarning').hidden = !warning;
}
$('#heart').onclick = () => like(playing.song);
$('#share').onclick = () => shareTrack(playing.song);
// Native share sheet when the browser has one (iPhone), otherwise copy the link.
async function shareTrack(song) {
  if (!song) return;
  const url = shareURL(location.origin + location.pathname,song);
  const title = [song.artist,song.trackTitle || song.videoTitle].filter(Boolean).join(' – ');
  if (navigator.share) { try { await navigator.share({title,url}); return; } catch (error) { if (error?.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); notify('Link copied'); } catch { notify(url,15000); }
}
async function like(song) {
  if (!song || !model) return;
  const target = actionModel(song), result = await target.toggle(song);
  if (result) notify(target.isGuest ? result.adding ? 'Saved to this session' : 'Removed from this session' : dryRun && !fixture ? 'Dry run: no Discogs change sent.' : result.adding ? 'Added to wantlist · saved in this session' : 'Removed record from wantlist');
  if (target.error) notify(target.error,10000);
  if (playing.source === 'session') {
    playing.list = reviewItems(); playing.index = playing.list.findIndex(s=>trackKey(s)===trackKey(playing.song));
  }
}
function unsentGuest(song) {
  return !model?.isGuest && guestSession?.has(song) && guestStatus(guestSession.session.items.find(s=>trackKey(s)===trackKey(song)), model.username) !== 'saved'
    && !model.session.items.some(s=>trackKey(s)===trackKey(song));
}
function actionModel(song) { return model.isGuest || unsentGuest(song) ? guestSession : model; }
function reviewItems() {
  if (!model) return [];
  if (model.isGuest) return model.session.items.slice();
  return [...new Map([...guestSession.unsaved(model.username),...model.session.items].map(s=>[trackKey(s),s])).values()];
}
function syncGeometry() {
  const rect = !currentModal && cards[active]?.el.querySelector('.art').getBoundingClientRect();
  const size = rect ? rect.width : Math.min(240,innerWidth-56);
  const center = rect ? rect.y+rect.height/2 : innerHeight*.42;
  document.documentElement.style.setProperty('--player-center-y',center+'px');
  document.documentElement.style.setProperty('--player-art-size',size+'px');
}
new ResizeObserver(() => {
  if (!currentModal) document.documentElement.style.setProperty('--dock-h',$('#dock').offsetHeight+'px');
  requestAnimationFrame(syncGeometry);
}).observe($('#dock'));
window.addEventListener('resize',()=>requestAnimationFrame(syncGeometry));
let geometryFrame;
$('#feed').addEventListener('scroll',()=>{
  cancelAnimationFrame(geometryFrame); geometryFrame = requestAnimationFrame(syncGeometry);
},{passive:true});
function updateSeek() {
  if (!playing.song || !ready[current] || seekDragging) return;
  const total = players[current].getDuration() || playing.song.duration || 0, time = players[current].getCurrentTime() || 0;
  $('#seek').disabled = !total; $('#seek').value = total ? Math.min(1000,time/total*1000) : 0;
  $('#seekFill').style.width = (total ? Math.min(100,time/total*100) : 0)+'%';
  $('#elapsed').textContent = fmt(time); $('#duration').textContent = fmt(total); $('#seek').setAttribute('aria-valuetext',`${fmt(time)} of ${fmt(total)}`);
}
$('#seek').addEventListener('input', () => {
  seekDragging = true; const total = players[current]?.getDuration() || 0, time = Number($('#seek').value)/1000*total;
  $('#seekFill').style.width = Number($('#seek').value)/10+'%'; $('#elapsed').textContent = fmt(time);
});
$('#seek').addEventListener('change', () => {
  const total = players[current]?.getDuration() || 0; players[current]?.seekTo(Number($('#seek').value)/1000*total,true); seekDragging = false; updateSeek();
});
$('#seek').addEventListener('pointercancel', () => { seekDragging = false; updateSeek(); });
setInterval(updateSeek,250);

function renderSession() {
  if (!model) return;
  const items = reviewItems(), records = new Set(items.map(s=>s.wantedReleaseId || s.releaseId)).size;
  const remaining = model.isGuest ? items.length : guestSession.unsaved(model.username).length;
  $('#sessionConnection').textContent = model.isGuest ? 'Guest session · saved on this device' : 'Connected as @' + model.username;
  $('#sessionCopy').textContent = model.isGuest ? 'Your finds stay in this browser. Releases may also be saved to Crate’s shared wantlist. Add your own token to save these finds to your Discogs.' : remaining ? 'Your guest finds are kept here until they can be saved to your account.' : 'Saved to your Discogs wantlist. Listen again, or remove a record.';
  $('#syncGuest').hidden = !remaining;
  $('#syncGuest').textContent = model.isGuest ? 'Save to my Discogs' : guestSession.syncing ? 'Saving finds…' : 'Save remaining guest finds';
  $('#syncGuest').disabled = guestSession.syncing || model.health === 'loading';
  $('#sessionButton').setAttribute('aria-label',`Open this session, ${items.length} tracks`);
  $('#sessionSummary').textContent = items.length ? `${items.length} ${items.length===1?'track':'tracks'} · ${records} ${records===1?'record':'records'}` : 'Your next favourite is still out there.';
  $('#sessionError').textContent = guestSession.error || model.error || (model.health === 'loading' ? 'Refreshing your Discogs wantlist…' : model.health === 'unknown' ? 'Wantlist status is unverified. Retry before making changes.' : '');
  $('#sessionError').hidden = !$('#sessionError').textContent;
  $('#retryWants').hidden = model.health !== 'unknown'; $('#newSession').disabled = model.pending.size > 0 || guestSession.syncing;
  if (currentModal !== $('#session')) return;
  // Keep focused controls stable while playback events update the row state.
  const signature = JSON.stringify([items.map(s=>[trackKey(s),actionModel(s).busy(s),actionModel(s).has(s),s.sync]),model.health,model.username,guestSession.syncing,playing.song?.vid,playing.source,ready[current] ? players[current].getPlayerState() : 0]);
  if ($('#sessionRows').dataset.signature === signature) return;
  const focused = $('#sessionRows').contains(document.activeElement) ? document.activeElement : null;
  const focusKind = focused?.hasAttribute('data-play') ? 'data-play' : focused?.hasAttribute('data-remove') ? 'data-remove' : null;
  const focusIndex = focusKind ? focused.getAttribute(focusKind) : null;
  $('#sessionRows').dataset.signature = signature;
  if (!items.length) {
    $('#sessionRows').innerHTML = '<div class="empty-state"><b>A good find starts with a listen.</b><p>Tap a heart while digging. Your discoveries will be waiting here.</p><button class="pill back-to-dig">Back to digging</button></div>';
    $('#sessionRows button').onclick = hide;
    if (focused) $('#sessionRows button').focus({preventScroll:true});
    return;
  }
  $('#sessionRows').innerHTML = items.map((song,index) => {
    const target = actionModel(song), shared = target.isGuest ? 0 : items.filter(s=>s.wantedReleaseId===song.wantedReleaseId).length;
    const status = target.isGuest && !model.isGuest ? guestStatus(song,model.username) === 'failed' ? 'Not saved · retry available' : 'Waiting to save' : '';
    const isPlaying = playing.source==='session' && playing.song?.vid===song.vid && ready[current] && players[current].getPlayerState()===1;
    return `<div class="find-row"><button class="find-play ${isPlaying?'playing':''}" data-play="${index}" aria-label="${isPlaying?'Pause':'Replay'} ${esc(song.trackTitle||song.videoTitle)}"><span class="find-art">${https(song.cover) || (fixture && song.cover?.startsWith('tests/')) ? `<img src="${esc(song.cover)}" alt="" loading="lazy">` : ''}<span class="replay-badge">${isPlaying?'Ⅱ':'<img src="assets/icons/play.svg" width="14" height="14" alt="">'}</span></span><span class="find-info"><b>${esc(song.trackTitle||song.videoTitle)}</b><span>${esc(song.artist)}</span><span>${esc(song.releaseTitle)}</span>${status?`<span class="record-note">${status}</span>`:''}${shared>1?`<span class="record-note">${shared} tracks share this record · removal affects all of them</span>`:''}</span></button><button class="like on" data-remove="${index}" aria-label="Remove ${esc(song.releaseTitle)} from ${target.isGuest?'this session':'wantlist'}" aria-busy="${target.busy(song)}" ${target.busy(song)||target.health!=='ready'||guestSession.syncing?'disabled':''}><img src="assets/icons/heart-filled.svg" width="24" height="24" alt=""></button></div>`;
  }).join('');
  $('#sessionRows').querySelectorAll('[data-play]').forEach(button => { button.onclick = () => { const list=reviewItems(),index=Number(button.dataset.play); replay(list[index],'session',list,index); renderSession(); }; });
  $('#sessionRows').querySelectorAll('[data-remove]').forEach(button => { button.onclick = () => like(reviewItems()[Number(button.dataset.remove)]); });
  if (focusKind) {
    const target = $(`#sessionRows [${focusKind}="${focusIndex}"]:not(:disabled)`) || $(`#sessionRows [data-play="${focusIndex}"]`) || $('#closeSession');
    target.focus({preventScroll:true});
  }
}
$('#sessionButton').onclick = () => { if (!model) return; show($('#session')); renderSession(); };
$('#retryWants').onclick = loadWants;
$('#syncGuest').onclick = async () => {
  if (model.isGuest) return openSetup();
  if (guestSession.syncing) return;
  await loadWants(); if (model.health === 'ready') await guestSession.syncTo(model);
  renderDock(); renderSession();
};
$('#newSession').onclick = () => { if (guestSession.syncing || !model?.reset()) return; if (!model.isGuest) guestSession.reset(); if (playing.source==='session') { playing.list=[]; playing.index=-1; } renderSession(); notify('New session started. Your wantlist is unchanged.'); };

async function openRelease(song) {
  releaseSong = song;
  let rel = fixture ? fixtureData.releases.get(song.releaseId) : explorer?.releases.get(song.releaseId)?.rel;
  if (!rel) rel = (await cache.get('r:'+song.releaseId))?.v;
  if (!rel) { notify('Loading release…'); try { rel = await api.get('/releases/'+song.releaseId,3); } catch { return notify('Couldn’t load this release. Try again.'); } }
  const tracks = flattenTracks(rel.tracklist), candidates = (rel.videos || []).map(v=>({v,id:ytId(v.uri),match:matchTrack(v,rel)})).filter(v=>v.id&&v.v.embed!==false);
  const songs = releaseToSongs(rel,null,{seenVid:new Set(),seenKey:new Set(),stats:{}});
  const rows = tracks.map(track => {
    const video = candidates.find(v=>v.match.track===track);
    const matched = video && songs.find(s=>s.vid===video.id);
    return {track,song:matched};
  });
  const used = new Set(rows.filter(r=>r.song).map(r=>r.song.vid));
  rows.push(...songs.filter(s=>!used.has(s.vid)).map(s=>({track:{title:s.videoTitle,position:'',duration:fmt(s.duration)},song:s})));
  const list = rows.filter(r=>r.song).map(r=>r.song);
  $('#releaseContent').innerHTML = `<div class="sheet-heading"><div><p class="eyebrow">BEHIND THE TRACK</p><h2>Explore the record</h2></div><button class="close" id="closeRelease" aria-label="Close release details">×</button></div><div class="release-head"><div class="art">${artHTML(song)}</div><div class="release-copy"><h3>${esc(artistString(rel.artists))}</h3><p>${esc(rel.title)}</p><p>${esc([song.label,rel.year,rel.country].filter(Boolean).join(' · '))}</p><p>${esc((rel.styles||rel.genres||[]).join(', '))}</p></div></div><div class="release-actions"><button class="pill" id="releaseLike">${model.has(song)?'Remove from wantlist':'Add to wantlist'}</button><a href="${esc(https(rel.uri)||'https://www.discogs.com/release/'+song.releaseId)}" target="_blank" rel="noopener noreferrer">Open on Discogs ↗</a></div><ul class="tracklist">${rows.map((row,index)=>`<li>${row.song?`<button data-track="${index}" class="${playing.song?.vid===row.song.vid?'now':''}">`:'<div class="unavailable">'}<span class="pos">${esc(row.track.position)}</span><span class="track-title">${esc(row.track.title)}</span><span class="time">${esc(row.track.duration||'')}</span>${row.song?'<img src="assets/icons/play.svg" width="14" height="14" alt="">':''}${row.song?'</button>':'</div>'}</li>`).join('')}</ul>${!list.length?'<p class="small">No playable videos linked on this release.</p>':''}`;
  wireArt($('#releaseContent .art')); show($('#release'));
  renderDock();
  $('#closeRelease').onclick = hide;
  $('#releaseLike').onclick = async () => { await like(song); renderDock(); };
  $('#releaseContent').querySelectorAll('[data-track]').forEach(button => { button.onclick = () => {
    const s = rows[Number(button.dataset.track)].song; replay(s,'release',list,list.indexOf(s));
    $('#releaseContent').querySelectorAll('[data-track]').forEach(b=>b.classList.toggle('now',b===button));
  }; });
}
document.addEventListener('keydown', event => {
  if (currentModal && event.key === 'Escape') { event.preventDefault(); hide(); return; }
  if (currentModal && event.key === 'Tab') {
    const controls = [...currentModal.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select,summary')].filter(el=>el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !currentModal.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !currentModal.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    return;
  }
  if (event.target.matches('input,select,textarea,button,a') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === ' ') { event.preventDefault(); togglePlay(); }
  else if (event.key.toLowerCase() === 'l') like(playing.song);
  else if (event.key.toLowerCase() === 'm' && ready[current]) { soundOn=!soundOn; soundOn?players[current].unMute():players[current].mute(); updateSound(); }
  else if (!currentModal && ['ArrowDown','j'].includes(event.key)) { event.preventDefault(); go(1); }
  else if (!currentModal && ['ArrowUp','k'].includes(event.key)) { event.preventDefault(); go(-1); }
  else if (!currentModal && event.key.toLowerCase() === 'e' && playing.song) openRelease(playing.song);
});

async function boot() {
  guestSession = new GuestDiscoveries(storage, id=>dryRun ? Promise.resolve({dryRun:true}) : catalogue.addShared(id), ()=>{renderDock();renderSession();});
  if (fixture) {
    fixtureData = await import('./tests/fixture.js'); opts = {...opts,genre:'Electronic',style:'Minimal techno',y1:'2000',y2:'2001'};
    videoAvailability = new VideoAvailability({fetcher:url => fixtureData.probeVideo(url, params)});
    api = fixtureData.createAPI(params); accountAPI = api;
    if (params.has('guest')) { guestSession.mirror = async()=>{}; model = guestSession; }
    else model = new SessionDiscoveries('local-demo',storage,(...args)=>accountAPI.req(...args),()=>{renderDock();renderSession();});
    await loadWants(); attachPlayers((k,events)=>new fixtureData.FakePlayer(events)); if (share) startShared(); else start();
    // Read-only diagnostics and synthetic player events exist only in the localhost fixture.
    window.crateFixture = {model,api,players,get playlist(){return playlistIds;},get playing(){return playing;},get active(){return active;},
      get cards(){return cards.map(c=>c.song.vid);},get shared(){return sharedCard?.song.vid || null;},get gate(){return !!gate;},get shareGate(){return shareGate;}};
    return;
  }
  initYouTube(); api = catalogue; model = guestSession; renderSession();
  const token = localStorage.getItem('dx_token'), username = storage.get('dx_user','');
  if (token && username) connect(token,username);
  if (share) startShared();
  else if (token && username) { if (opts.style || opts.genre || opts.label) start(); else openPick(); }
  else if (storage.get('dx_opts', null)) start(); else openPick();
  if (dryRun) notify('Dry run: wantlist changes are simulated.',10000);
}
boot().catch(() => notify('Couldn’t start Crate. Reload to try again.',10000));
