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
 * Recovery: errors and prolonged stalls (>45 s without progress) trigger a
 * capped exponential-backoff retry (3 s ... 30 s). After 10 minutes of
 * continuous failure the offline panel is shown and automatic retries stop.
 * iOS Safari blocks autoplay with sound, so the first play() rejects with
 * NotAllowedError and a "Tap to Watch" button is shown instead of retrying.
 */
const STREAM = 'https://jmc-live.ercdn.net/eritreatv/eritreatv.m3u8';
const RETRY_DELAYS = [3000, 5000, 8000, 13000, 20000, 30000];
const GIVE_UP_AFTER_MS = 10 * 60 * 1000; // show offline panel after 10 min of failures
const NO_PROGRESS_MS = 45 * 1000;        // stall/freeze threshold
const HEALTHY_RESET_MS = 30 * 1000;      // reset backoff after 30 s of healthy playback

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
let healthySince = 0;
let requested = true;
let gestureRequired = false;
let wakeLock = null;

const OFFLINE_DEFAULT_MSG = offlineMsg.textContent;

function clearTimer() { if (timer !== null) { clearTimeout(timer); timer = null; } }
function status(text) { pill.textContent = text; pill.hidden = !text; }

function selectEngine() {
  if (video.canPlayType('application/vnd.apple.mpegurl') !== '') return 'native';
  if (typeof Hls !== 'undefined' && Hls.isSupported()) return 'hls';
  return null;
}

function detachStream() {
  if (hls) { try { hls.destroy(); } catch (e) { /* ignore */ } hls = null; }
  try { video.pause(); } catch (e) { /* ignore */ }
  video.removeAttribute('src');
  video.load();
}

function attachStream() {
  detachStream();
  lastProgress = Date.now();
  lastTime = -1;
  if (engine === 'hls') {
    hls = new Hls({ enableWorker: true, maxBufferLength: 30 });
    hls.on(Hls.Events.MANIFEST_PARSED, function () { play(); });
    hls.on(Hls.Events.ERROR, function (event, data) {
      if (data && data.fatal) {
        try { hls.destroy(); } catch (e) { /* ignore */ }
        hls = null;
        schedule('Stream error');
      }
      // Non-fatal hls.js errors are retried internally; ignore them here.
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
  status('');
  offline.hidden = true;
  attempts = 0;
  firstFailure = 0;
  healthySince = Date.now();
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
  try {
    await video.play();
    gestureRequired = false;
    start.hidden = true;
  } catch (e) {
    if (!e) return;
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

function schedule(reason) {
  if (!requested || document.hidden || gestureRequired || timer !== null ||
      (!video.paused && !video.seeking && video.readyState >= 3)) return;
  const now = Date.now();
  if (!firstFailure) firstFailure = now;
  if (now - firstFailure >= GIVE_UP_AFTER_MS) {
    status('');
    offlineMsg.textContent = OFFLINE_DEFAULT_MSG;
    retry.hidden = false;
    offline.hidden = false;
    return;
  }
  status('Reconnecting…');
  const delay = RETRY_DELAYS[Math.min(attempts++, RETRY_DELAYS.length - 1)];
  timer = setTimeout(function () {
    timer = null;
    if (!requested || document.hidden) return;
    if (!video.paused && video.readyState >= 3) { recovered(); return; }
    attachStream();
  }, delay);
}

function showUnsupported() {
  clearTimer();
  status('');
  offlineMsg.textContent = 'This browser cannot play the live stream. Please open this page in Safari on iPhone, iPad, or Mac.';
  retry.hidden = true;
  offline.hidden = false;
}

video.addEventListener('playing', function () { recovered(); start.hidden = true; });
video.addEventListener('timeupdate', function () {
  if (Math.abs(video.currentTime - lastTime) > 0.25) { lastTime = video.currentTime; lastProgress = Date.now(); }
});
video.addEventListener('waiting', function () {
  setTimeout(function () {
    if (!video.paused && video.readyState < 3 && !document.hidden) status('Buffering…');
  }, 8000);
});
video.addEventListener('error', function () { schedule('Media error'); });
video.addEventListener('ended', function () { schedule('Stream ended'); });
video.addEventListener('stalled', function () {
  if (Date.now() - lastProgress > NO_PROGRESS_MS) schedule('Stalled');
});

setInterval(function () {
  if (document.hidden || gestureRequired || !requested || engine === null) return;
  if (!video.paused && video.readyState >= 3) {
    if (Date.now() - lastProgress > NO_PROGRESS_MS) { video.pause(); schedule('Frozen stream'); }
    else if (Date.now() - healthySince > HEALTHY_RESET_MS) { attempts = 0; firstFailure = 0; }
  } else if (!timer && Date.now() - lastProgress > NO_PROGRESS_MS) {
    schedule('Timeout');
  }
}, 5000);

function userPlay() {
  if (engine === null) { showUnsupported(); return; }
  requested = true;
  gestureRequired = false;
  start.hidden = true;
  offline.hidden = true;
  clearTimer();
  attempts = 0;
  firstFailure = 0;
  attachStream();
}
start.addEventListener('click', userPlay);
retry.addEventListener('click', userPlay);

document.addEventListener('visibilitychange', function () {
  if (document.hidden) { clearTimer(); status(''); }
  else {
    lastProgress = Date.now();
    if (!gestureRequired) {
      if (video.error || video.ended) attachStream();
      else play();
    }
    requestWake();
  }
});

window.addEventListener('online', function () {
  if (document.hidden || gestureRequired || engine === null) return;
  clearTimer();
  const healthy = !video.paused && !video.seeking && video.readyState >= 3 && !video.error;
  if (healthy) { requestWake(); return; } // don't interrupt healthy playback on spurious online events
  attachStream();
});
window.addEventListener('offline', function () { status('Waiting for connection…'); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  });
}

engine = selectEngine();
if (engine === null) showUnsupported();
else attachStream();
