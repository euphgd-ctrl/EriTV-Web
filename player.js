'use strict';
/* EriTV Web player.
 *
 * Playback engine selection (in order):
 *  1. Native HLS -- iOS Safari and macOS Safari report support for
 *     'application/vnd.apple.mpegurl' via canPlayType(). The stream URL is
 *     assigned to the <video> element directly and Safari's built-in HLS
 *     stack handles playlists, segments, and buffering.
 *  2. hls.js (MSE) fallback -- every other modern browser (Chrome, Edge,
 *     Firefox, Android Chrome). Loaded from CDN in index.html.
 *  3. Unsupported panel when neither engine is available.
 *
 * Recovery: errors and prolonged stalls (>90 s without progress) trigger a
 * capped exponential-backoff retry (3 s ... 30 s). After 10 minutes of
 * continuous failure the offline panel is shown and automatic retries stop.
 * iOS Safari blocks autoplay with sound, so the first play() rejects with
 * NotAllowedError and a "Tap to Watch" button is shown instead of retrying.
 */
const STREAM = 'https://jmc-live.ercdn.net/eritreatv/eritreatv.m3u8';
const RETRY_DELAYS = [3000, 5000, 8000, 13000, 20000, 30000];
const GIVE_UP_AFTER_MS = 10 * 60 * 1000; // show offline panel after 10 min of failures
const NO_PROGRESS_MS = 90 * 1000;        // stall/freeze threshold
const HEALTHY_RESET_MS = 30 * 1000;      // reset backoff after 30 s of healthy playback
const BUFFERING_HINT_MS = 8000;
const STARTUP_TIMEOUT_MS = 65 * 1000; // no actual playback progress after an attempt
const RECENT_PROGRESS_MS = 12 * 1000; // buffered data alone is not proof playback works
const ANDROID_STARTUP_TIMEOUT_MS = 25000;
const ANDROID_STARTUP_RETRY_LIMIT = 4;

const video = document.querySelector('#video');
const start = document.querySelector('#start');
const pill = document.querySelector('#pill');
const offline = document.querySelector('#offline');
const offlineMsg = document.querySelector('#offlineMsg');
const retry = document.querySelector('#retry');

let engine = null; // 'native' | 'hls' | null
let hls = null;
let timer = null;
let attempts = 0;
let firstFailure = 0;
let lastProgress = Date.now();
let lastTime = -1;
let startedAt = Date.now();
let hasProgress = false;
let playGeneration = 0;
let healthySince = 0;
let requested = true;
let gestureRequired = false;
let wakeLock = null;
let failureReason = 'Stream temporarily unavailable';
let mediaRecoveryTried = false;
let retriesExpired = false;
const isAndroid = /Android/i.test(navigator.userAgent || '');
let startupStage = 'idle';
let startupIssue = '';
let startupRetryCount = 0;
let startupRecoveryTimer = null;
let startupSession = 0;
let startupVariant = 0;

const OFFLINE_DEFAULT_MSG = offlineMsg.textContent;

function clearTimer() { if (timer !== null) { clearTimeout(timer); timer = null; } }
function clearStartupTimer() { if (startupRecoveryTimer !== null) { clearTimeout(startupRecoveryTimer); startupRecoveryTimer = null; } }
function setStage(stage) { startupStage = stage; }
function startupFailureLabel() { return startupIssue || startupStage; }
function showStartupState() {
  if (!isAndroid || hasProgress || engine !== 'hls') return;
  status('Connecting: ' + startupStage + ' · Tap to retry');
}
function startupTimeout() {
  if (!isAndroid || engine !== 'hls' || !requested || document.hidden || hasProgress ||
      gestureRequired || retriesExpired || timer !== null) return;
  startupIssue = startupFailureLabel();
  if (startupRetryCount >= ANDROID_STARTUP_RETRY_LIMIT) {
    clearStartupTimer();
    status('Could not start (' + startupIssue + ') · Tap to retry');
    return;
  }
  startupRetryCount++;
  // Initial HLS requests must not leave the viewer black for a full minute.
  schedule('Startup stalled at ' + startupIssue);
}
function status(text) { pill.textContent = text; pill.hidden = !text; }
function healthyPlayback() {
  return hasProgress && !video.paused && !video.seeking && !video.error &&
    Date.now() - lastProgress < RECENT_PROGRESS_MS;
}

function selectEngine() {
  if (video.canPlayType('application/vnd.apple.mpegurl') !== '') return 'native';
  if (typeof Hls !== 'undefined' && Hls.isSupported()) return 'hls';
  return null;
}

function detachStream() {
  clearStartupTimer();
  startupSession++;
  playGeneration++; // ignore late play() resolutions from an obsolete source
  if (hls) { try { hls.destroy(); } catch (e) { /* ignore */ } hls = null; }
  try { video.pause(); } catch (e) { /* ignore */ }
  video.removeAttribute('src');
  video.load();
}

function attachStream() {
  detachStream();
  lastProgress = Date.now();
  startedAt = lastProgress;
  lastTime = -1;
  hasProgress = false;
  healthySince = 0;
  mediaRecoveryTried = false;
  if (engine === 'hls') {
    setStage('loading playlist');
    showStartupState();
    const session = startupSession;
    if (isAndroid) startupRecoveryTimer = setTimeout(function () {
      if (session === startupSession) startupTimeout();
    }, ANDROID_STARTUP_TIMEOUT_MS);
    if (!isAndroid) status('Connecting… · Tap to retry');
    hls = new Hls({
      enableWorker: true,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
      // Android: use hls.js automatic initial quality selection, like
      // ExoPlayer. Forcing level 0 may pin a broken/unsuitable rendition.
      startLevel: isAndroid ? -1 : 0,
      capLevelToPlayerSize: true,
      // hls.js 1.6: LoadPolicies replace deprecated *LoadingTimeOut/*MaxRetry.
      // Longer first-byte allowance handles mobile radios waking/slow DNS.
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 15000, maxLoadTimeMs: 30000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 5000 },
          errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
        }
      },
      playlistLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 15000, maxLoadTimeMs: 30000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 5000 },
          errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
        }
      },
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 20000, maxLoadTimeMs: 60000,
          timeoutRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 12000 }
        }
      },
      // If the viewer falls far behind a sliding live playlist, rejoin live.
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 12
    });
    const instance = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      if (instance !== hls) return;
      setStage('starting video');
      showStartupState();
      play();
    });
    if (Hls.Events.MEDIA_ATTACHED) hls.on(Hls.Events.MEDIA_ATTACHED, function () {
      if (instance === hls && !hasProgress) { setStage('loading playlist'); showStartupState(); }
    });
    if (Hls.Events.FRAG_LOADING) hls.on(Hls.Events.FRAG_LOADING, function () {
      if (instance === hls && !hasProgress) { setStage('loading video'); showStartupState(); }
    });
    if (Hls.Events.FRAG_BUFFERED) hls.on(Hls.Events.FRAG_BUFFERED, function () {
      if (instance === hls && !hasProgress) { setStage('decoding video'); showStartupState(); }
    });
    hls.on(Hls.Events.ERROR, function (event, data) {
      if (instance !== hls || !data) return;
      if (!hasProgress && isAndroid) {
        const code = data.response && data.response.code;
        const details = String(data.details || data.type || 'unknown');
        startupIssue = details + (code ? ' HTTP ' + code : '');
        if (data.fatal) status('Error: ' + startupIssue + ' · Tap to retry');
      }
      if (!data.fatal) return;
      // Non-fatal errors are already handled by hls.js. For fatal decoder
      // errors give MSE one recovery attempt before a full source reload.
      if (data.type === 'mediaError' && !mediaRecoveryTried &&
          typeof instance.recoverMediaError === 'function') {
        mediaRecoveryTried = true;
        try { instance.recoverMediaError(); return; } catch (e) { /* fall through */ }
      }
      // A playlist error can arrive while previously fetched video is still
      // progressing. Never destroy healthy buffered playback prematurely.
      if (healthyPlayback()) return;
      schedule(classifyHlsError(data));
    });
    hls.loadSource(STREAM);
    hls.attachMedia(video);
  } else {
    video.src = STREAM;
    video.load();
    play();
  }
}

function recovered() {
  clearTimer();
  clearStartupTimer();
  startupRetryCount = 0;
  startupIssue = '';
  status('');
  offline.hidden = true;
  if (!healthySince) healthySince = Date.now();
  lastProgress = Date.now();
  requestWake();
}

async function requestWake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !video.paused && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    }
  } catch (e) { /* wake lock is best-effort */ }
}

async function play() {
  if (!requested || document.hidden || engine === null) return;
  const generation = playGeneration;
  try {
    await video.play();
    if (generation !== playGeneration) return;
    gestureRequired = false;
    start.hidden = true;
  } catch (e) {
    if (generation !== playGeneration || !e) return;
    if (e.name === 'NotAllowedError') {
      // Safari / mobile autoplay policy: wait for an explicit tap.
      gestureRequired = true;
      start.hidden = false;
      status('');
      return;
    }
    if (e.name === 'AbortError') return; // superseded by a newer load; recovery already in flight
    if (e.name === 'NotSupportedError') { showUnsupported(); return; }
    schedule('Playback interrupted');
  }
}

function classifyHlsError(data) {
  if (navigator.onLine === false) return 'No internet connection. Check Wi-Fi or mobile data.';
  const code = data && data.response && data.response.code;
  if (code === 403 || code === 404) return 'The TV stream is unavailable at the source right now.';
  if (code >= 500) return 'The TV stream server is having trouble right now.';
  const details = String(data && (data.details || data.type) || '');
  if (/manifest|level|frag|network|timeout|load/i.test(details)) {
    return 'Cannot reach the TV stream. Check your connection, VPN or Private DNS.';
  }
  return 'Playback was interrupted. Trying again…';
}

function classifyNativeError() {
  if (navigator.onLine === false) return 'No internet connection. Check Wi-Fi or mobile data.';
  const code = video.error && video.error.code;
  if (code === 2) return 'The connection to the TV stream was interrupted.';
  if (code === 3) return 'The video could not be decoded. Trying again…';
  return 'The TV stream could not be loaded. Trying again…';
}

function schedule(reason) {
  if (!requested || document.hidden || gestureRequired || retriesExpired ||
      timer !== null || !offline.hidden || healthyPlayback()) return;
  failureReason = reason || failureReason;
  healthySince = 0;
  if (navigator.onLine === false) failureReason = 'No internet connection. Check Wi-Fi or mobile data.';
  const now = Date.now();
  if (!firstFailure) firstFailure = now;
  if (now - firstFailure >= GIVE_UP_AFTER_MS) {
    retriesExpired = true;
    status('');
    offlineMsg.textContent = failureReason === 'Stream temporarily unavailable' ? OFFLINE_DEFAULT_MSG : failureReason;
    retry.hidden = false;
    offline.hidden = false;
    return;
  }
  status(navigator.onLine === false
    ? 'Waiting for connection · Tap to retry'
    : isAndroid && !hasProgress
      ? 'Retrying (' + startupFailureLabel() + ') · Tap to retry'
      : 'Reconnecting… · Tap to retry');
  const delay = RETRY_DELAYS[Math.min(attempts++, RETRY_DELAYS.length - 1)];
  timer = setTimeout(function () {
    timer = null;
    if (!requested || document.hidden || retriesExpired) return;
    if (healthyPlayback()) { recovered(); return; }
    attachStream();
  }, delay);
}

function showUnsupported() {
  clearTimer();
  status('');
  if (typeof Hls === 'undefined' && /Android/i.test(navigator.userAgent || '')) {
    // On Android, a missing Hls library usually means the CDN script failed.
    // Don't incorrectly tell a Chrome user that only Safari is supported.
    offlineMsg.textContent = 'Could not load the video player. Check your connection, then reload.';
    retry.textContent = 'Reload player';
    retry.hidden = false;
  } else {
    offlineMsg.textContent = 'This browser cannot play the live stream. Please try an up-to-date Chrome or Safari browser.';
    retry.hidden = true;
  }
  offline.hidden = false;
}

video.addEventListener('playing', function () {
  // A 'playing' event does not prove frames are moving. Only hide the
  // connecting UI once timeupdate actually advances the picture.
  if (hasProgress) recovered();
  start.hidden = true;
});
video.addEventListener('timeupdate', function () {
  if (!video.paused && Math.abs(video.currentTime - lastTime) > 0.25) {
    lastTime = video.currentTime;
    lastProgress = Date.now();
    if (!hasProgress) {
      hasProgress = true;
      healthySince = lastProgress; // 30 seconds of real progress, not just 'playing'
      recovered();
    } else if (healthySince && Date.now() - healthySince >= HEALTHY_RESET_MS) {
      attempts = 0;
      firstFailure = 0;
    }
  }
});
video.addEventListener('waiting', function () {
  setTimeout(function () {
    if (!video.paused && video.readyState < 3 && !document.hidden && !timer &&
        !retriesExpired) status('Buffering…');
  }, BUFFERING_HINT_MS);
});
video.addEventListener('error', function () {
  // A fatal MSE decoder error may still be recoverable by hls.js.
  if (engine === 'hls' && hls && !mediaRecoveryTried &&
      video.error && video.error.code === 3 &&
      typeof hls.recoverMediaError === 'function') {
    mediaRecoveryTried = true;
    try { hls.recoverMediaError(); return; } catch (e) { /* fall through */ }
  }
  schedule(engine === 'native' ? classifyNativeError() : 'Playback error. Trying again…');
});
video.addEventListener('ended', function () { schedule('The live stream ended unexpectedly.'); });
video.addEventListener('stalled', function () {
  if (Date.now() - lastProgress > NO_PROGRESS_MS) schedule('Stalled');
});

setInterval(function () {
  if (document.hidden || gestureRequired || !requested || engine === null || retriesExpired) return;
  const now = Date.now();
  if (healthyPlayback()) {
    if (healthySince && now - healthySince >= HEALTHY_RESET_MS) {
      attempts = 0;
      firstFailure = 0;
    }
    return;
  }
  // A resolved play() promise or HAVE_FUTURE_DATA may still be a frozen image.
  // Allow slow mobile manifests / segments time to load, but never wait forever.
  const stalled = hasProgress
    ? now - lastProgress >= NO_PROGRESS_MS
    : now - startedAt >= STARTUP_TIMEOUT_MS;
  if (stalled && timer === null && !(isAndroid && !hasProgress && startupRetryCount >= ANDROID_STARTUP_RETRY_LIMIT)) {
    try { video.pause(); } catch (e) { /* ignore */ }
    schedule(hasProgress ? 'The picture stopped. Trying again…'
      : 'The stream is taking too long to start. Trying again…');
  } else if (!hasProgress && now - startedAt >= BUFFERING_HINT_MS && timer === null &&
      engine === 'hls') {
    showStartupState();
  }
}, 5000);

function prepareUserAttempt() {
  requested = true;
  gestureRequired = false;
  retriesExpired = false;
  failureReason = OFFLINE_DEFAULT_MSG;
  start.hidden = true;
  offline.hidden = true;
  clearTimer();
  attempts = 0;
  firstFailure = 0;
  startupRetryCount = 0;
  startupIssue = '';
}
function userPlay() {
  if (engine === null) { showUnsupported(); return; }
  prepareUserAttempt();
  // Never reset an already attached native source on a Safari gesture.
  // For initial Android entry, attach hls.js only after the user taps Play.
  if (video.error || (!video.src && engine === 'native') || (engine === 'hls' && !hls)) {
    attachStream();
  } else {
    play();
  }
}
function userRetry() {
  if (engine === null) {
    if (typeof Hls === 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    } else showUnsupported();
    return;
  }
  prepareUserAttempt();
  // Unlike an autoplay gesture, explicit 'retry' means restart the network,
  // not play() on the same dead MSE buffer.
  attachStream();
}
start.addEventListener('click', userPlay);
retry.addEventListener('click', userRetry);
pill.addEventListener('click', userRetry);

document.addEventListener('visibilitychange', function () {
  if (document.hidden) { clearTimer(); clearStartupTimer(); status(''); healthySince = 0; }
  else {
    lastProgress = Date.now();
    if (!requested) return; // returning to the tab must not bypass Android's Play button
    if (isAndroid && engine === 'hls' && !hasProgress) { attachStream(); return; }
    if (!gestureRequired) {
      if (video.error || video.ended || (engine === 'hls' && !hls)) attachStream();
      else play();
    }
    requestWake();
  }
});

window.addEventListener('online', function () {
  if (!requested || document.hidden || gestureRequired || engine === null || retriesExpired) return;
  clearTimer();
  if (healthyPlayback()) { requestWake(); return; } // don't interrupt healthy playback on spurious online events
  attachStream();
});
window.addEventListener('offline', function () {
  if (requested && !retriesExpired && offline.hidden) status('Waiting for connection…');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}

engine = selectEngine();
if (engine === null) showUnsupported();
else if (engine === 'hls' && isAndroid) {
  // Android Chrome starts more reliably after an explicit user gesture. Do
  // not open the manifest, MSE session or retry loop until Play is tapped.
  requested = false;
  start.textContent = '▶ Play EriTV';
  start.hidden = false;
} else attachStream();
