# EriTV Web

Minimal, one-channel live HLS viewer for EriTV on iPhone and Android, hosted at
https://euphgd-ctrl.github.io/EriTV-Web/ .

This is an **unofficial** viewer and does not claim broadcaster affiliation.
Any redistribution, use of the broadcaster's stream, name or imagery must comply
with the broadcaster's permissions and applicable law.

## Playback

- **iPhone / iPad Safari:** native HLS via `video.canPlayType`. Sound-on
  autoplay may require tapping **Tap to Watch**, and the tap must call
  `video.play()` on the existing element without tearing down its source.
- **Android Chrome / desktop Chrome / Firefox / Edge:** hls.js **1.6.5** using
  Media Source Extensions (MSE), loaded from jsDelivr with a pinned SRI hash.
  Uses adaptive levels with an initial low-bandwidth level, a buffer target,
  bounded manifest/playlist/segment load policies, and a defined live window.
- **Both engines:** 90-second stall watchdog, buffering hint after 8 seconds,
  3/5/8/13/20/30-second capped exponential reconnects, an offline panel after
  10 minutes of continuous failure, and manual retry. Healthy video is **never
  reset merely because of a transient network status change**.
- hls.js media errors receive a single in-place media-source recovery before
  the full reconnect mechanism. hls.js internally handles nonfatal errors.

The single channel source URL is stored in `player.js`:
`https://jmc-live.ercdn.net/eritreatv/eritreatv.m3u8`.

Browser buffering is **not identical** to Android Media3 ExoPlayer. Apple's
native HLS engine chooses its own buffering, variant and live-edge behavior;
JavaScript has no reliable API to change Safari's internal HLS buffer.
The publisher's sliding live playlist also limits how much future video can
be buffered, regardless of configured target lengths. The viewer cannot
bypass ISP/CDN restrictions or guarantee the third-party stream stays online.

## Progressive web app (PWA)

- HTTPS GitHub Pages, standalone manifest, iPhone/Android icons.
- Service worker caches **only the app shell**; HLS media and CDN resources
  bypass it completely, preventing stale live playlists/segments.
- HTML navigation and `player.js` use network-first with offline fallback,
  ensuring bug fixes are served on the next online reload.
- All other same-origin app-shell assets use stale-while-revalidate.
- Screen wake lock is requested where browser support and permissions allow it.

## Tests and publishing

```sh
node --check player.js
node --check sw.js
node tests/run-tests.mjs
```

GitHub Actions runs the syntax and regression tests on pushes and pull requests
(`.github/workflows/player-tests.yml`). Coverage includes native and MSE
engine selection, Safari autoplay gesture, recoveries, retry policy and timing,
offline PWA routing, icons and manifest. `tests/browser-smoke.mjs` is an optional
sandbox-specific Chromium network smoke test, **not** a substitute for actual
iPhone/Android playback checks.

GitHub Pages publishes from `main` (repository root). Development changes
should first pass on a branch before merging; GitHub Pages then deploys the
same static files. No build step is required.
