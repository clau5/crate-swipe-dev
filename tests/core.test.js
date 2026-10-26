import test from 'node:test';
import assert from 'node:assert/strict';
import {matchTrack, chooseNext, Explorer, releaseToSongs, Discogs} from '../core.js';
test('a confidently matched linked video retains track/release metadata',()=>{
  const rel={id:7,master_id:70,title:'Record',artists:[{name:'Example'}],tracklist:[{title:'Night drive',position:'A1',duration:'4:00'}],videos:[{title:'Example - Night drive',uri:'https://youtu.be/aaaaaaaaaaa',duration:240}]};
  assert.equal(matchTrack(rel.videos[0],rel).conf,'high');const songs=releaseToSongs(rel,null,{seenVid:new Set(),seenKey:new Set(),stats:{}});assert.equal(songs[0].releaseId,7);assert.equal(songs[0].trackTitle,'Night drive');
});
test('feed never immediately repeats the same master',()=>{
  const last={releaseId:1,masterId:10,artist:'A'},pool=[{releaseId:2,masterId:10,artist:'B'},{releaseId:3,masterId:11,artist:'C'}];
  assert.equal(chooseNext(pool,[last],{gap:15,ahead:0,rnd:()=>0}),1);
});
test('explorer builds vinyl searches with bounded year and filter parameters',()=>{
  const ex=new Explorer({}, {genre:'Electronic',style:'Minimal Techno',label:'Morris / Audio',country:'Switzerland'});const u=new URL(ex.qs(2001,2),'https://api.discogs.com');
  assert.equal(u.searchParams.get('format'),'Vinyl');assert.equal(u.searchParams.get('year'),'2001');assert.equal(u.searchParams.get('style'),'Minimal Techno');assert.equal(u.searchParams.get('page'),'2');
});
test('dry-run writes never invoke fetch',async()=>{
  const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('should not fetch');};
  try {const api=new Discogs('not-a-key',{dryRun:true});await api.req('PUT','/users/test/wants/1');await api.req('DELETE','/users/test/wants/1');assert.equal(api.dryLog.length,2);assert.equal(api.count,0);} finally{globalThis.fetch=original;}
});
test('a known dead upload does not hide a working upload of the same track',()=>{
  const rel={id:7,artists:[{name:'Example'}],tracklist:[{title:'Night drive',position:'A1'}],videos:['aaaaaaaaaaa','bbbbbbbbbbb'].map(id=>({title:'Example - Night drive',uri:'https://youtu.be/'+id,duration:240}))};
  const songs=releaseToSongs(rel,null,{seenVid:new Set(),seenKey:new Set(),skipVid:new Set(['aaaaaaaaaaa']),stats:{}});
  assert.deepEqual(songs.map(s=>s.vid),['bbbbbbbbbbb']);
});
test('discovery checks candidates before emitting cards and can use an alternate upload',async()=>{
  const rel={id:7,artists:[{name:'Example'}],tracklist:[{title:'Night drive',position:'A1'}],videos:['aaaaaaaaaaa','bbbbbbbbbbb'].map(id=>({title:'Example - Night drive',uri:'https://youtu.be/'+id,duration:240}))};
  const emitted=[];
  const ex=new Explorer({get:async path=>path.startsWith('/database')?{pagination:{pages:1,items:1},results:[{id:7,type:'release'}]}:rel}, {maxReleases:1,checkVideo:async id=>id!=='aaaaaaaaaaa',onSongs:songs=>emitted.push(...songs)});
  await ex.run();assert.deepEqual(emitted.map(s=>s.vid),['bbbbbbbbbbb']);
});
test('3.1.9: Discogs client bursts the first calls in parallel, then paces to one per gap, writes alone',async()=>{
  const original=globalThis.fetch;let inflight=0,peak=0;const starts=[];const t0=Date.now();
  globalThis.fetch=async(url,{method})=>{starts.push([method,Date.now()-t0]);inflight++;peak=Math.max(peak,inflight);await new Promise(r=>setTimeout(r,20));inflight--;return {ok:true,status:200,text:async()=>'{}'};};
  try{
    const api=new Discogs('k',{gap:100,burst:3,parallel:3});
    await Promise.all([1,2,3,4].map(i=>api.get('/releases/'+i)));
    assert.equal(peak,3);assert.ok(starts[2][1]<50,'burst starts immediately');assert.ok(starts[3][1]>=80,'4th call waits for a token');
    inflight=0;peak=0;await Promise.all([api.get('/releases/5'),api.req('PUT','/users/u/wants/5'),api.get('/releases/6')]);
    assert.equal(peak,1,'a write never overlaps other calls');
  } finally{globalThis.fetch=original;}
});
test('3.1.9: a fresh page 1 feeds the first release directly; warm-up scans up to 3 releases at once',async()=>{
  const calls=[];let inflight=0,peak=0;
  const results=Array.from({length:100},(_,i)=>({id:i+1,type:'release'}));
  const api={get:async path=>{calls.push(path);if(path.startsWith('/database'))return {pagination:{pages:50,items:5000},results};
    inflight++;peak=Math.max(peak,inflight);await new Promise(r=>setTimeout(r,10));inflight--;return {id:Number(path.split('/').pop()),videos:[]};}};
  const ex=new Explorer(api,{maxReleases:3});await ex.run();
  assert.equal(calls.filter(c=>c.startsWith('/database')).length,1,'no second search before the first releases');
  assert.equal(peak,3);
});
