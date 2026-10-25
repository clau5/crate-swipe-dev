// Share links: one exact track, never the sharer's dig. ?share=<Discogs release id>&yt=<YouTube id>
// Both IDs are public catalogue identifiers already on every card; no token or filter goes in the link.
import {GENRES, releaseToSongs} from './core.js';

const RELEASE = /^[1-9]\d{0,11}$/, VIDEO = /^[A-Za-z0-9_-]{11}$/;

export function shareURL(base, song) {
  const url = new URL(base); url.search = ''; url.hash = '';
  url.searchParams.set('share', String(song.releaseId)); url.searchParams.set('yt', song.vid);
  return url.href;
}

// null: not a share link. {invalid:true}: a share link we can't use. Otherwise {releaseId, vid}.
export function parseShare(search) {
  const p = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  if (!p.has('share')) return null;
  const id = (p.get('share') || '').trim(), vid = (p.get('yt') || '').trim();
  if (!RELEASE.test(id) || !VIDEO.test(vid)) return {invalid:true};
  return {releaseId:Number(id), vid};
}

// The shared card's song, built with the same matching as the feed. null if the video is gone from the release.
export function sharedSong(rel, vid) {
  if (!rel) return null;
  return releaseToSongs(rel, null, {seenVid:new Set(), seenKey:new Set(), stats:{}}).find(s => s.vid === vid) || null;
}

// Soft hint for the recipient's own dig: the release year if known, otherwise its genre. Never both.
export function sharePrefill(rel) {
  const year = Number(rel?.year);
  if (Number.isInteger(year) && year >= 1900 && year <= new Date().getFullYear() + 1) return {y1:String(year)};
  const genre = (rel?.genres || []).find(g => GENRES.includes(g));
  return genre ? {genre} : {};
}

// The filters a share recipient starts from: blank dig fields plus the one hint above.
// Playback preferences (skip intro, hide seen, auto-next, mode) are the recipient's own.
export function shareFilters(opts, prefill) {
  return {...opts, genre:'', style:'', label:'', country:'', y1:'', y2:'', ...prefill};
}
