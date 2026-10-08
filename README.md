# EriTV Web

Unofficial, single-channel HLS viewer for the EriTV live stream. **No affiliation
with the broadcaster is asserted. Confirm stream and branding permissions before
any public launch.** The site must stay private / undeployed until that
confirmation is given.

Stream: `https://jmc-live.ercdn.net/eritreatv/eritreatv.m3u8`
(Master playlist verified live: 1080p / 720p / 360p variants, HTTPS, and the
server sends `Access-Control-Allow-Origin: *`. No proxy is used anywhere.)

## Player (`player.js`)

Engine selection, in order:

1. **Native HLS** — iOS Safari and macOS Safari report
   `canPlayType('application/vnd.apple.mpegurl')`; the stream URL is assigned to
   the `<video>` element directly and Safari's built-in HLS stack plays it.
2. **hls.js fallback** — Chrome, Edge, Firefox, Android Chrome. Loaded from
   jsDelivr with a pinned version and subresource-integrity hash
   (see the `<script>` tag in `index.html`).
3. **Unsupported panel** when neither engine is available.

Recovery:

- Errors and stalls (no playback progress for 45 s) trigger capped
  exponential-backoff retries: 3 s, 5 s, 8 s, 13 s, 20 s, then 30 s.
- After 10 minutes of continuous failure the offline panel appears and
  automatic retries stop; "Try again" restarts manually.
- Fatal hls.js errors destroy the hls.js instance and feed the same retry
  machinery; non-fatal hls.js errors are retried internally by hls.js.
- `play()` promise rejections are classified: `NotAllowedError` shows the
  "Tap to Watch" button (iOS Safari autoplay policy) instead of retrying;
  `AbortError` (superseded play) is ignored; `NotSupportedError` shows the
  unsupported panel.
- Returning to the tab / regaining connectivity reloads only when playback is
  not already healthy, so a good stream is never interrupted.

No HLS media (.m3u8 / .ts / .m4s) is ever cached by the service worker.

## Service worker (`sw.js`)

- App shell (HTML, JS, manifest, icons) cached for offline launch.
- Navigations: network-first with cached fallback; the fresh shell is stored so
  the offline copy stays current.
- Other same-origin GETs: stale-while-revalidate.
- Stream playlists/segments and all cross-origin requests bypass the worker.

## PWA

`manifest.webmanifest` (installable, standalone, black theme), 192/512 px PNG
icons plus a 180 px Apple touch icon. HTTPS is required for installability and
screen wake lock.

## Tests

`npm test`-style, dependency-free: `node tests/run-tests.mjs`

- Static checks: manifest, icons (valid PNG, correct sizes), HTML wiring.
- Service-worker routing logic (install caching, stream bypass, offline
  navigation fallback) against stubbed Cache APIs.
- Player logic: engine selection, autoplay-gesture flow, retry scheduling and
  backoff, recovery reset, hls.js fatal-error path, unsupported panel.
- `node tests/browser-smoke.mjs` (optional): loads the page in headless
  Chromium, asserts no JS errors, hls.js initializes, the confirmed manifest
  URL is requested, and the service worker registers. (Decoded-frame playback
  is not asserted: this sandbox's egress proxy intermittently stalls tunneled
  media requests, so manifest bytes can't be fetched deterministically here;
  the stream is verified independently via direct fetch.)

## Deployment

Static site; publish the repository root. GitHub Pages: Settings → Pages →
Deploy from branch → `main` / root. Or Cloudflare Pages with no build command
and `/` as the output directory. **Do not enable public hosting until stream
and branding permissions are confirmed.**

## Update stream

Edit `STREAM` in `player.js`, bump `CACHE` in `sw.js`, commit; redeploy
automatically if hosting is configured.
