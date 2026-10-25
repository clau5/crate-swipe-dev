# Crate Swipe 3.0 implementation notes

Prepared 24 October 2026 against upstream commit `727198d23a5ce59c57baae710c015d79206ca1ea` (2.3.0). Local branch: `feat/crate-redesign-session`. No remote push or deployment was performed.

## Delivered

- Playback screen rebuilt from the supplied 402 × 874 Figma frame: filter pill, session action, release metadata, centered 300px artwork, 5% artwork crop, bounded blurred glow, artist/track, outline/filled heart, white seek bar and YouTube attribution.
- Agreed Inter substitution throughout. All icons and fonts are local files; artwork remains driven by release metadata. Figma download URLs are absent from runtime files.
- Filters, token setup, release details and a new session discoveries view share the visual language. Only the playback screen had an exact Figma reference; the other layouts are adaptations.
- Session discoveries persist per Discogs username across reloads, changed filters and revisits. Starting a new session clears this local view only.
- Heart, double tap and L retain immediate Discogs record-level add/remove semantics. Session replay does not change the wantlist. Removing a wanted record updates related session entries; alternate wanted pressings are not deleted implicitly.
- Playback identity/order is separate from the feed index. Replay updates titles, attribution, duration and seeking; closing the view restores the discovery track and position. Paused return positions are cued rather than autoplayed.
- Failed reads keep the wantlist status unknown; successful snapshots reconcile external removals. Failed writes retain their previous state, and independent successful writes are not rolled back.
- Shared player iframes retain their DOM parents during overlays and iOS sound-unlock handling.
- Static hosting remains unchanged: native ES modules and CSS, with no production dependencies or build step. pnpm/Playwright are for development tests only.

## Validation

The committed tests are reproducible using the README commands. Final results and screenshots are packaged with this handoff under `docs/screenshots/` and `docs/test-evidence/`.

- 18 Node logic checks cover matching/feed preservation, dry-run transport, immediate writes, persistence/reset, account isolation, same-record locking, alternate pressing removal, independent request failure, snapshot/write races, stale reads, storage failure and malformed cached wants.
- 14 browser scenarios pass in each of pinned Playwright Chromium and WebKit with simulated players and intercepted Discogs endpoints. They cover the reference geometry, local assets, likes, persistent session replay, auto-next isolation, filters, release replay/seek, session reset, write/read failure and retry, focus/Escape, small/large viewports, long text, missing artwork, uncertain matches, double tap/keyboard toggles and the normal production authentication/discovery entry path.
- Viewports: 402 × 874 reference, 320 × 568, 390 × 844 and 1440 × 900. Long titles wrap within bounded text blocks while artwork shrinks to the available height.
- Icons were checked as non-empty local SVGs and at their rendered dimensions: session/heart 24px and attribution play 14px. The heart has a 44px hit area. The seek bar has a larger invisible interaction target and native keyboard semantics.
- Automated browser fixtures block external traffic. The production-entry test intercepts identity/search/release/wantlist and player API requests; it uses a fake token and performs no real account mutations.
- Syntax and whitespace checks pass. GitHub Actions is included for the same local-fixture checks; it has not yet run on GitHub.

## Live verification boundary

The supplied Discogs key was used only for a read-only connection attempt, passed through hidden stdin and held in process memory. It was not added to the repository, fixtures, documentation, screenshots or package.

The API identity endpoint returned HTTP 200 **HTML**, with the title **“Blocked by Cloudflare Gateway”**, instead of Discogs API JSON. This is a gateway access block, not evidence of an invalid token. Requests stopped after identifying that layer. No live account authentication, search, playback or wantlist operation is claimed as verified; no real wantlist writes were attempted.

Desktop WebKit checks validate layout and the mocked playback state machine. Real YouTube audio, iOS user-gesture permission, player swaps, Premium behaviour and real Discogs mutations still need a live check on a permitted connection/device. Those checks are distinct from the automated results.

## Retained behaviour and limitations

- Discovery and fuzzy matching logic were extracted from the original implementation with exports adapted to native modules. The UI's accidentally commented-out error handling was replaced by visible error reporting.
- Original search-page/release cache TTLs, vinyl-only selection, random candidate sampling, master dedupe and adaptive spacing remain in place.
- The existing matcher can mark a song key before excluding a previously seen video, potentially suppressing another upload of that song. That discovery-engine behaviour was identified in planning and left outside this redesign.
- The persistent session is local to this browser/origin and username; it does not sync between devices. Existing Discogs wants from before the session are not automatically imported.
- Runtime errors are rendered as text; no token is logged. No corporate design-library dependency or proprietary Aeonik font is included.

## Review and publish

Review the diff, screenshots and tests before pushing the feature branch to the existing GitHub repository. Serve the repository root through GitHub Pages. No credentials or environment variables are needed in GitHub.

Rollback is a revert to the upstream static files. New session storage keys can remain unused; the existing options, seen history, token and IndexedDB cache were not migrated destructively.

### Final browser receipts

| Engine | Version | Passed |
| --- | --- | --- |
| chromium | 151.0.7922.34 | 14 |
| webkit | 26.5 | 14 |

See `test-evidence/summary.json`, `test-evidence/chromium.json` and `test-evidence/webkit.json`.

## 3.0.1 (iPhone playback fixes)

- One YouTube player for the whole session. iOS grants sound to the iframe that received the first tap; 3.0 alternated between two iframes, so the never-tapped one was refused sound and the fallback turned sound off (`soundOn = false`), leaving every later card muted until tapped. Swipes and auto-next now call `loadVideoById` on the same unlocked player, and sound is never turned off automatically — only pause and mute are user controls.
- The player is never visible. An opaque shield always covers it (it previously showed through between cards while swiping), and the rare iOS "tap once for sound" fallback is now a fully transparent iframe over the cover artwork instead of the exposed YouTube tile.
- Trade-off: no second iframe pre-buffers the next song, so a swipe may take a moment longer to start.
- Embed host stays `https://www.youtube.com` (not youtube-nocookie). Premium in embeds depends on the browser's YouTube sign-in cookies being available to third-party iframes; that is a Safari/Home Screen storage setting, not app code.

## 3.0.3 (quiet recovery and video preflight)

- Routine Discogs retry/rate-limit messages stay out of the toast. Initial loading explains a reconnect inline; authentication, failed saves and exhausted discovery still show actionable errors.
- Before discovery emits cards, public YouTube oEmbed metadata rejects missing/private videos (401/404/410). The preflight sends no credentials, uses at most three requests at once, and caches results locally (six hours for positive metadata, 24 hours for negative metadata).
- Timeouts, network failures, 403, rate limits and server errors mean unknown availability, not a dead video. A 30-second cooldown prevents repeated probes during an outage. Unknown candidates remain usable.
- Playback-confirmed missing/non-embeddable videos (100/101/150) are remembered and removed from the feed quietly. A dead upload cannot consume a track's deduplication key and hide a working alternate upload. HTML5/network and client-identification errors are retryable and never blacklist videos or trigger a rapid skip chain.
- Metadata is not proof of playback in every region/device. Some restrictions are only reported by the player; those still use the quiet runtime recovery path. The single audible iframe is unchanged.

## 3.1.1 (handset visual polish)

- Feed cover is a full circle (`.art` and the transparent unlock tile use `border-radius: 50%`) so vinyl labels cut cleanly; the release-sheet thumbnail stays square (4px).
- Glow (`#backdrop`) is 90% of the cover's rendered size, tracks the cover via `--player-art-size` / `--player-center-y`, sits 14% of the cover size above its centre, and uses `filter: blur(150px)` at full opacity. Figma's layer blur 300 corresponds to CSS `blur(150px)` (Figma's value is twice the CSS radius).
- Artist / track type reduced for real devices: 16/20 and 18/22 (14/18 and 16/20 on screens ≤650px tall and in the release sheet's mini dock).
- Browser geometry check updated: cover y 271, dock y 701 on 402 × 874, plus computed radius, font sizes, blur, glow size and glow-above-centre assertions.


## 3.1.4-dev — hide pause glyph on sheets

- The big centered pause mark (`#paused`) is for the feed cover only.
- While a sheet is open (`body.overlay`), it is hidden so it no longer sits on top of This session / release lists. The dock still shows playback state.
- Dev-only. Production stays on 3.1.1.

## 3.1.3-dev — quieter cover sound hint

- The “Tap the cover once…” unlock hint only arms when the YouTube player is **paused** after play was requested (Safari refused sound).
- Slow loads that sit in unstarted/cued past 3.5s no longer flash that hint and then clear it when buffering starts.
- Same rule for the post–sound-tap 1s check. The real paused-without-unlock path in `onState` is unchanged.
- Dev-only (`crate-swipe-dev`). Production `crate-swipe` stays on 3.1.1.

## 3.1.2-dev (background auto-next via the player playlist)

Dev-only build, published from `clau5/crate-swipe-dev` (https://clau5.github.io/crate-swipe-dev/). Production stays on 3.1.1.

- **iOS limitation.** When Safari is backgrounded or the phone is locked, iOS suspends or throttles page JS and stops rendering. The YouTube iframe's audio can keep going, but 3.1.1 chained songs from page JS: ENDED → `go(1)` → smooth scroll → IntersectionObserver → `loadVideoById`. Observers and smooth scrolling never run on a hidden page, so the next song never started.
- **Playlist chain.** With auto-next on, feed playback calls `loadPlaylist` (`cuePlaylist` when restoring a paused track) on the same single `#yt0` player: the chosen card plus up to 11 upcoming playable cards (`playlist.js`). The player advances on its own when a song ends, without page JS. The iOS sound unlock is unchanged: one iframe, never swapped or reparented.
- **Sync.** On every player state change (and on errors) the app reads the player's current video (`getVideoData` / `getVideoUrl`, falling back to `getPlaylistIndex`). If it moved forward inside our queue, the app updates the active card, dock, seen set and glow, and instantly scrolls the card into view. It never reloads the player, because a reload would reset the chain. Reports from a previous queue are ignored until the player shows the new playlist.
- **Refresh.** The feed keeps up to 12 cards ahead. At a song boundary, if more cards are waiting than the queue holds, the queue is rebuilt from the playing song. While visible, this happens once fewer than 6 songs remain. While hidden, it only happens on the last song, so the running chain isn't put at risk.
- **Fallbacks.** If a mid-queue ENDED is not followed by the player moving within 2.5 s, or at the end of the queue, the old path runs. `advance()` now activates the next card directly rather than relying on the observer. `visibilitychange` / `pageshow` catch the UI up to a chain that moved while hidden, or restart playback if the player ended while JS was asleep.
- **Unchanged.** Session and release-list playback still use `loadVideoById` + ENDED → `advance()`. With auto-next off, no queue is loaded. `startAt` applies only to the first song of each queue; songs the player chains start from 0.
- **Caveat.** Locked-phone chaining is best effort. It depends on iOS letting the already-playing YouTube iframe start its next playlist item in the background. That can't be verified on desktop WebKit, so a real iPhone check is still needed. A video that fails inside the queue while the page is asleep may stop the chain until the page is reopened.

## 3.1.6-dev — Explore / Run listening modes (instant swipes vs locked-phone auto-next)

Dev-only. Production is untouched (3.1.4 + GoatCounter 3.1.5 are prod-side work; this build does not include the GoatCounter tag).

- **Why swipes got slower in 3.1.2-dev.** There never was a second preloading iframe after 3.0.1 (one player keeps the iOS sound unlock). 3.1.1 felt instant because each swipe was a single `loadVideoById`. 3.1.2-dev made every swipe call `loadPlaylist` with up to 12 IDs, so the player had to resolve the whole queue before the first note, and it threw that queue away and rebuilt it on the next swipe. The feed also built 13 cards ahead instead of 4, so more covers and availability checks competed with the first video on each dig.
- **Can both coexist?** Partly. A second hidden "preload" player is not an option: on iOS only the iframe that got the first tap may play with sound, and the background chain only works if that same iframe holds the playlist. Switching to the playlist only when the page hides is unreliable too, because iOS may refuse a new load once the page is hidden. So the build does two things:
  - **Explore (default).** Exactly the 3.1.1 path: `loadVideoById` per swipe, a 4-card buffer, and auto-next from page JS (ENDED → `advance()`). Auto-next works while the screen is on. With the phone locked, the current song finishes and playback stops.
  - **Run.** The 3.1.2-dev player playlist (chains with the phone locked), plus a swipe to a card already in the queue now calls `playVideoAt(i)` instead of rebuilding the queue (`playlistJump` in `playlist.js`). The queue is only rebuilt when the target isn't queued, the queue is still loading, or fewer than 2 songs would stay queued behind the target. After a jump, the old song's state reports are ignored until the player reports the target (`awaitVid`), so a stale event can't pull the feed back. "Skip intro" is applied with a seek on the first PLAYING after a jump.
- **UI.** Filters sheet → "Listening mode" (Explore · instant swipes / Run · keeps playing with the phone locked). The setting is stored in `dx_opts.playMode` and applies right away: the dig and current song stay, and only the way it plays switches. "Go to the next song when one ends" still turns auto-next off in both modes.
- **Tests.** Fixture player gains `playVideoAt`. Browser checks cover Explore single-video swipes plus JS auto-next, Run playlist chaining, in-queue swipe jumps (no reload, no stale pull-back), queue rebuild near the end, the mode switch keeping the dig, and background resync. The unit test covers `playlistJump`. Real iPhone timing still has to be checked by hand, because headless browsers don't play real YouTube.


## 3.1.7-dev — share a track

Dev-only (`clau5/crate-swipe-dev`). Production is untouched.

- **Share control.** A share icon sits next to the heart in the now-playing dock (same 24 px outline icon language, no counts or popularity). It shares whatever is playing: the native share sheet (`navigator.share`) when there is one, as on iPhone, otherwise the link is copied to the clipboard ("Link copied").
- **URL shape.** `https://clau5.github.io/crate-swipe-dev/?share=<Discogs release id>&yt=<YouTube video id>`, e.g. `?share=1001&yt=aaaaaaaaaaa`. Prod would use the same path shape. Those are the two IDs every card already has (`song.releaseId`, `song.vid`), which means one song. The link never carries the sharer's filters, tokens, or the `fixture`/`debug` params. `share.js` builds the link and parses it strictly (positive integer release id, 11-character YouTube id).
- **Opening a link.** The app loads that release (IndexedDB cache, then the guest catalogue client or your own Discogs client) and finds the video with the normal matching (`releaseToSongs`). That track becomes **card 0**, with no dig filters applied. The chip reads "Pick your dig…".
- **Filters gate.** Behind card 0 is a "Start your own dig" gate card. Swiping onto it (or pressing ↓) opens Filters while card 0 keeps playing. Closing Filters without applying scrolls back to card 0. Before Apply, the shared song ending does not auto-advance into the gate.
- **Pre-fill: year, not genre.** Share-mode Filters start blank (genre, style, label, country, years). Only **Year from** is filled in, from the shared release's year. Genre is used only when the release has no year (the first of its Discogs genres that is in our genre list). The two are never both filled in. Year was picked because every release has at most one year, while a release often lists several genres and styles. Playback preferences (skip intro, hide seen, auto-next, Explore/Run) stay the recipient's own.
- **After Apply.** The dig loads behind card 0: the gate shows "Digging…", then the first dig card becomes card 1 and starts playing. The gate is removed and the `share`/`yt` params are stripped from the URL, so a reload resumes the recipient's dig. Swiping up from card 1 always returns to the shared track. Card 0 stays pinned for the rest of the visit, including later re-digs. The shared video is excluded from the dig, so it never appears twice.
- **Fail soft.** If the link is malformed, the release can't be loaded, the video is no longer on the release, availability says it's gone, or YouTube reports it dead while it's card 0 before any dig, the app shows "Couldn’t find that track. Pick a genre or year to start digging." and opens Filters (still pre-filled with the year when the release loaded). Apply starts a normal dig.
- **Tests.** `tests/share.test.js` covers link building (no filters or tokens), strict parsing, video lookup or missing video, and the year-else-genre prefill. A browser check (Chromium and WebKit) covers the share sheet and copy fallback, card 0 pinning, the Filters gate on the first swipe down, close-returns-to-card-0, dig from card 1 after Apply, swipe up back to the shared track, URL cleanup, and the three fail-soft paths.
