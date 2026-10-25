import test from 'node:test';
import assert from 'node:assert/strict';
import {shareURL, parseShare, sharedSong, sharePrefill, shareFilters} from '../share.js';
import {releases} from './fixture.js';

test('share link carries only the release and video id, never filters or tokens',()=>{
  const url = shareURL('https://clau5.github.io/crate-swipe-dev/?g=techno&y1=1995&fixture=1#x',{releaseId:1001,vid:'aaaaaaaaaaa',artist:'A',style:'Techno',token:'secret'});
  assert.equal(url,'https://clau5.github.io/crate-swipe-dev/?share=1001&yt=aaaaaaaaaaa');
});
test('share links parse strictly',()=>{
  assert.equal(parseShare(''),null); assert.equal(parseShare('?fixture=1'),null);
  assert.deepEqual(parseShare('?share=1001&yt=aaaaaaaaaaa'),{releaseId:1001,vid:'aaaaaaaaaaa'});
  assert.deepEqual(parseShare(new URLSearchParams('share=42&yt=dQw4w9WgXcQ&utm=x')),{releaseId:42,vid:'dQw4w9WgXcQ'});
  for (const q of ['?share=','?share=0&yt=aaaaaaaaaaa','?share=12a&yt=aaaaaaaaaaa','?share=1001','?share=1001&yt=short','?share=1001&yt=aaaaaaaaaaa"><'])
    assert.deepEqual(parseShare(q),{invalid:true},q);
});
test('shared song is found by video id; a video no longer on the release fails soft',()=>{
  const rel = releases.get(1003);
  const s = sharedSong(rel,'eeeeeeeeeee'); assert.equal(s.vid,'eeeeeeeeeee'); assert.equal(s.releaseId,1003); assert.equal(s.trackTitle,'Second thoughts');
  assert.equal(sharedSong(rel,'zzzzzzzzzzz'),null); assert.equal(sharedSong(null,'aaaaaaaaaaa'),null);
});
test('prefill is the year when known, else the genre, never both',()=>{
  assert.deepEqual(sharePrefill({year:1998,genres:['Electronic']}),{y1:'1998'});
  assert.deepEqual(sharePrefill({year:0,genres:['Made up','Jazz']}),{genre:'Jazz'});
  assert.deepEqual(sharePrefill({}),{});
  const f = shareFilters({genre:'Electronic',style:'Detroit Techno',label:'Tresor',country:'Germany',y1:'1991',y2:'1994',startAt:'30',playMode:'run'},{y1:'1998'});
  assert.deepEqual(f,{genre:'',style:'',label:'',country:'',y1:'1998',y2:'',startAt:'30',playMode:'run'});
});
