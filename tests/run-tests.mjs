#!/usr/bin/env node
/* EriTV Web automated tests — dependency-free (node >= 18).
 * Covers: project structure, manifest, icons, HTML wiring, service-worker
 * routing logic, and player logic (engine selection, autoplay gesture flow,
 * retry backoff, recovery, hls.js error paths, unsupported panel).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIRMED_STREAM = 'https://jmc-live.ercdn.net/eritreatv/eritreatv.m3u8';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + '\n    ' + String(e.message).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + '\n    ' + String(e.message).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function pngSize(path) {
  const d = readFileSync(join(ROOT, path));
  assert.equal(d.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', path + ' is not a PNG');
  const w = d.readUInt32BE(16), h = d.readUInt32BE(20);
  return { w, h, bytes: d.length };
}

/* ---------------- 1. project structure ---------------- */
console.log('[structure]');
const EXPECTED = ['index.html', 'player.js', 'sw.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'README.md'];
for (const f of EXPECTED) ok('file exists: ' + f, () => assert.ok(existsSync(join(ROOT, f))));

/* ---------------- 2. manifest ---------------- */
console.log('[manifest]');
const manifest = JSON.parse(read('manifest.webmanifest'));
ok('manifest parses with required fields', () => {
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']) assert.ok(manifest[k], k);
  assert.equal(manifest.display, 'standalone');
});
ok('manifest icons exist and match declared sizes', () => {
  for (const icon of manifest.icons) {
    const { w, h, bytes } = pngSize(icon.src);
    assert.ok(bytes > 500, icon.src + ' suspiciously small');
    assert.equal(icon.sizes, w + 'x' + h, icon.src);
  }
});
ok('apple-touch-icon is 180x180 PNG', () => {
  const { w, h } = pngSize('icons/apple-touch-icon.png');
  assert.equal(w, 180); assert.equal(h, 180);
});

/* ---------------- 3. HTML wiring ---------------- */
console.log('[html]');
const html = read('index.html');
for (const [name, needle] of [
  ['manifest link', 'manifest.webmanifest'],
  ['apple touch icon', 'apple-touch-icon'],
  ['playsinline', 'playsinline'],
  ['webkit-playsinline', 'webkit-playsinline'],
  ['hls.js CDN script', 'cdn.jsdelivr.net/npm/hls.js@'],
  ['hls.js integrity hash', 'integrity="sha384-'],
  ['player.js script', 'src="./player.js"'],
  ['offline message element', 'id="offlineMsg"'],
]) ok('html has ' + name, () => assert.ok(html.includes(needle), needle));

/* ---------------- 4. service worker routing ---------------- */
console.log('[service worker]');
{
  const SCOPE = 'https://example.test/app/';
  const abs = (u) => String(new URL(u, SCOPE));
  function makeCache() {
    const map = new Map();
    return {
      _map: map,
      addAll: async (assets) => { for (const a of assets) map.set(abs(a), new Response('cached:' + a)); },
      put: async (k, v) => { map.set(abs(typeof k === 'string' ? k : k.url), v); },
      match: async (k) => map.get(abs(typeof k === 'string' ? k : k.url)),
    };
  }
  const stores = new Map();
  const realCaches = globalThis.caches, realFetch = globalThis.fetch;
  let fetchImpl = async () => new Response('network', { status: 200 });
  globalThis.caches = {
    open: async (n) => { if (!stores.has(n)) stores.set(n, makeCache()); return stores.get(n); },
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
    match: async (r) => { const u = abs(typeof r === 'string' ? r : r.url); for (const c of stores.values()) { const hit = c._map.get(u); if (hit) return hit; } return undefined; },
  };
  globalThis.fetch = (...a) => fetchImpl(...a);
  try {
    const swListeners = {};
    const self = {
      addEventListener: (t, f) => { swListeners[t] = f; },
      location: new URL(SCOPE),
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
    };
    eval(read('sw.js')); // eslint-disable-line no-eval

    const req = (url, mode = 'no-cors') => ({ url: abs(url), method: 'GET', mode });
    const fireFetch = (request) => { let responded; swListeners.fetch({ request, respondWith: (p) => { responded = p; } }); return responded; };

    await okAsync('install caches every ASSET and bumped cache version', async () => {
      let p; swListeners.install({ waitUntil: (x) => { p = x; } });
      await p;
      const names = await globalThis.caches.keys();
      assert.ok(names.some((n) => n.startsWith('eritv-shell-')), 'versioned cache name');
      assert.ok(!names.includes('eritv-shell-v1'), 'old v1 cache name not reused');
      for (const a of ['./', './index.html', './player.js', './manifest.webmanifest',
        './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png']) {
        const hit = await globalThis.caches.match(a);
        assert.ok(hit, 'cached: ' + a);
      }
    });

    await okAsync('activate deletes old caches', async () => {
      await globalThis.caches.open('eritv-shell-v1');
      let p; swListeners.activate({ waitUntil: (x) => { p = x; } });
      await p;
      const names = await globalThis.caches.keys();
      assert.ok(!names.includes('eritv-shell-v1'));
      assert.equal(names.length, 1);
    });

    await okAsync('m3u8 playlist bypasses the worker', async () => {
      const r = fireFetch(req('https://jmc-live.ercdn.net/eritreatv/eritreatv.m3u8'));
      assert.equal(r, undefined, 'no respondWith for playlists');
    });
    await okAsync('ts segments bypass the worker', async () => {
      const r = fireFetch(req('https://jmc-live.ercdn.net/eritreatv/eritreatv_1080p-1.ts'));
      assert.equal(r, undefined);
    });
    await okAsync('cross-origin CDN bypasses the worker', async () => {
      const r = fireFetch(req('https://cdn.jsdelivr.net/npm/hls.js@1.6.5/dist/hls.min.js'));
      assert.equal(r, undefined);
    });
    await okAsync('offline navigation falls back to cached shell', async () => {
      fetchImpl = async () => { throw new Error('offline'); };
      const body = await fireFetch(req(SCOPE, 'navigate')).then((r) => r.text());
      assert.ok(body.startsWith('cached:./index.html'), body);
    });
    await okAsync('online navigation returns network and refreshes shell', async () => {
      fetchImpl = async () => new Response('fresh-shell', { status: 200 });
      const body = await fireFetch(req(SCOPE, 'navigate')).then((r) => r.text());
      assert.equal(body, 'fresh-shell');
      const cached = await globalThis.caches.match('./index.html').then((r) => r.text());
      assert.equal(cached, 'fresh-shell');
    });
    await okAsync('player JavaScript is network-first and remains available offline', async () => {
      fetchImpl = async () => new Response('fresh-player', { status: 200 });
      const fresh = await fireFetch(req('./player.js')).then((r) => r.text());
      assert.equal(fresh, 'fresh-player', 'player gets the current release');
      fetchImpl = async () => { throw new Error('offline'); };
      const cached = await fireFetch(req('./player.js')).then((r) => r.text());
      assert.equal(cached, 'fresh-player', 'offline fallback stays functional');
    });
    await okAsync('app-shell GET uses stale-while-revalidate', async () => {
      let netCalls = 0;
      fetchImpl = async () => { netCalls++; return new Response('v2', { status: 200 }); };
      const first = await fireFetch(req('./manifest.webmanifest')).then((r) => r.text());
      assert.ok(first.startsWith('cached:'), 'served stale immediately, got: ' + first);
      await new Promise((r) => setImmediate(r));
      assert.equal(netCalls, 1, 'background revalidation fired');
    });
  } finally {
    globalThis.caches = realCaches; globalThis.fetch = realFetch;
  }
}

/* ---------------- 5. player logic ---------------- */
console.log('[player]');
const playerSrc = read('player.js');
ok('confirmed stream URL is the only stream source', () => {
  assert.ok(playerSrc.includes("'" + CONFIRMED_STREAM + "'"));
  assert.ok(!/proxy|cors-anywhere|allorigins|thingproxy/i.test(playerSrc), 'no proxy workarounds');
});
ok('native HLS path checked before hls.js fallback', () => {
  const nativeIdx = playerSrc.indexOf("canPlayType('application/vnd.apple.mpegurl')");
  const hlsIdx = playerSrc.indexOf('Hls.isSupported()');
  assert.ok(nativeIdx > 0 && hlsIdx > nativeIdx, 'native check must come first');
});

function makeClock() {
  let now = 0, seq = 1; const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + ms, repeat: 0 }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => { const id = seq++; timers.set(id, { fn, at: now + ms, repeat: ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        let nextId = null, nextAt = Infinity;
        for (const [id, t] of timers) if (t.at <= end && t.at < nextAt) { nextId = id; nextAt = t.at; }
        if (nextId === null) break;
        const t = timers.get(nextId); now = t.at;
        if (t.repeat) t.at = now + t.repeat; else timers.delete(nextId);
        t.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}
function makeEl() {
  const listeners = {};
  return {
    hidden: true, textContent: '',
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatch: (t) => { (listeners[t] || []).forEach((f) => f({ type: t })); },
    click: () => { (listeners.click || []).forEach((f) => f({ type: 'click' })); },
  };
}
function makeVideo(canPlayNative, playBehavior) {
  const listeners = {};
  return {
    src: '', currentTime: 0, paused: true, readyState: 1, seeking: false,
    error: null, ended: false, playCalls: 0, loadCalls: 0, playBehavior,
    canPlayType: () => (canPlayNative ? 'probably' : ''),
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatch: (t) => { (listeners[t] || []).forEach((f) => f({ type: t })); },
    removeAttribute: function (a) { if (a === 'src') this.src = ''; },
    load: function () { this.loadCalls++; },
    pause: function () { this.paused = true; },
    play: function () {
      this.playCalls++;
      if (this.playBehavior === 'resolve') { this.paused = false; return Promise.resolve(); }
      return Promise.reject(this.playBehavior);
    },
  };
}
function makeHlsStub() {
  const cls = class {
    static isSupported() { return true; }
    constructor(opts) { cls.instances.push(this); this.opts = opts; this.handlers = {}; this.destroyed = false; }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    loadSource(url) { this.url = url; }
    attachMedia(v) { this.media = v; }
    destroy() { this.destroyed = true; }
    recoverMediaError() { this.recoverCalls = (this.recoverCalls || 0) + 1; }
    emit(ev, data) { (this.handlers[ev] || []).forEach((f) => f(ev, data)); }
  };
  cls.instances = [];
  cls.Events = { MANIFEST_PARSED: 'MANIFEST_PARSED', ERROR: 'ERROR', MEDIA_ATTACHED: 'MEDIA_ATTACHED', FRAG_LOADING: 'FRAG_LOADING', FRAG_BUFFERED: 'FRAG_BUFFERED' };
  return cls;
}
const tick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

async function loadPlayer({ native, playBehavior, withHls, android = false }) {
  const clock = makeClock();
  const video = makeVideo(native, playBehavior);
  const els = { '#video': video, '#start': makeEl(), '#pill': makeEl(), '#offline': makeEl(), '#offlineMsg': makeEl(), '#retry': makeEl() };
  els['#offlineMsg'].textContent = 'Stream temporarily unavailable';
  els['#start'].hidden = true; els['#pill'].hidden = true; els['#offline'].hidden = true; els['#retry'].hidden = false;
  const docListeners = {};
  const winListeners = {};
  const registeredSW = [];
  let pageReloads = 0;
  const sandbox = {
    document: {
      querySelector: (s) => els[s],
      hidden: false, visibilityState: 'visible',
      addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    },
    window: {
      addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
      location: { reload: () => { pageReloads++; } },
    },
    navigator: { userAgent: android ? 'Mozilla/5.0 (Linux; Android 16) Chrome/140' : 'Mozilla/5.0 (iPhone)', serviceWorker: { register: async (u) => { registeredSW.push(u); } } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    Date: { now: clock.now },
    console,
  };
  let Hls = null;
  if (withHls) { Hls = makeHlsStub(); sandbox.Hls = Hls; sandbox.window.Hls = Hls; }
  vm.createContext(sandbox);
  vm.runInContext(playerSrc, sandbox, { filename: 'player.js' });
  // fire window load -> service worker registration
  (winListeners.load || []).forEach((f) => f());
  await tick();
  return { clock, video, els, docListeners, winListeners, registeredSW, Hls, tick,
    pageReloads: () => pageReloads };
}

await okAsync('native engine: stream assigned, play attempted, SW registered', async () => {
  const t = await loadPlayer({ native: true, playBehavior: 'resolve', withHls: false });
  assert.equal(t.video.src, CONFIRMED_STREAM);
  assert.equal(t.video.playCalls, 1);
  assert.equal(t.els['#start'].hidden, true);
  assert.deepEqual(t.registeredSW, ['./sw.js']);
});

await okAsync('autoplay blocked: tap-to-watch shown, no retry storm', async () => {
  const t = await loadPlayer({ native: true, playBehavior: { name: 'NotAllowedError' }, withHls: false });
  assert.equal(t.els['#start'].hidden, false, 'tap button visible');
  assert.equal(t.els['#pill'].hidden, true, 'no reconnect pill while waiting for gesture');
  assert.equal(t.clock.pending(), 1, 'only the health interval pending, got ' + t.clock.pending());
  const beforeTapLoads = t.video.loadCalls;
  t.video.playBehavior = 'resolve';
  t.els['#start'].click();
  await t.tick();
  assert.equal(t.video.playCalls, 2, 'tap retries play');
  assert.equal(t.video.loadCalls, beforeTapLoads, 'tap does not reload native video, preserving iOS activation');
  assert.equal(t.els['#start'].hidden, true);
});

await okAsync('AbortError from superseded play() does not schedule a retry', async () => {
  const t = await loadPlayer({ native: true, playBehavior: { name: 'AbortError' }, withHls: false });
  await t.tick();
  assert.equal(t.clock.pending(), 1, 'no retry timer for AbortError');
});

await okAsync('native retries 3s then 5s and resets after 30s of real progress', async () => {
  const t = await loadPlayer({ native: true, playBehavior: 'resolve', withHls: false });
  t.video.dispatch('error');
  assert.equal(t.els['#pill'].hidden, false, 'reconnect pill shown');
  t.clock.advance(2999); await t.tick();
  assert.equal(t.video.playCalls, 1, 'no retry before 3s');
  t.clock.advance(1); await t.tick();
  assert.equal(t.video.playCalls, 2, 'first retry at 3s');
  t.video.dispatch('error');
  t.clock.advance(4999); await t.tick();
  assert.equal(t.video.playCalls, 2, 'no retry before 5s');
  t.clock.advance(1); await t.tick();
  assert.equal(t.video.playCalls, 3, 'second retry at 5s (backoff)');
  t.video.paused = false;
  t.video.readyState = 4;
  t.video.dispatch('playing'); await t.tick();
  t.video.currentTime = 1;
  t.video.dispatch('timeupdate');
  assert.equal(t.els['#pill'].hidden, true, 'pill clears only once playback moves');
  for (let i = 0; i < 7; i++) {
    t.clock.advance(5000);
    t.video.currentTime += 5;
    t.video.dispatch('timeupdate');
  }
  t.video.pause();
  t.video.dispatch('error');
  t.clock.advance(3000); await t.tick();
  assert.equal(t.video.playCalls, 4, 'backoff resets to 3s only after sustained playback');
});

await okAsync('10 minutes of failure shows offline panel and stops auto-retry', async () => {
  const t = await loadPlayer({ native: true, playBehavior: 'resolve', withHls: false });
  for (let i = 0; i < 25; i++) { t.video.dispatch('error'); t.clock.advance(31000); await t.tick(); }
  assert.equal(t.els['#offline'].hidden, false, 'offline panel shown');
  assert.equal(t.els['#retry'].hidden, false, 'manual retry available');
  assert.equal(t.clock.pending(), 1, 'no retry timers left, only health interval');
});

await okAsync('hls.js fallback: attaches media, plays on manifest, fatal error retries', async () => {
  const t = await loadPlayer({ native: false, playBehavior: 'resolve', withHls: true });
  assert.equal(t.Hls.instances.length, 1);
  const inst = t.Hls.instances[0];
  assert.equal(inst.url, CONFIRMED_STREAM);
  assert.equal(inst.media, t.video);
  assert.equal(t.video.src, '', 'native src not set on hls path');
  inst.emit('MANIFEST_PARSED', {});
  await t.tick();
  assert.equal(t.video.playCalls, 1, 'play on manifest parsed');
  inst.emit('ERROR', { fatal: false });
  await t.tick();
  assert.equal(t.clock.pending(), 1, 'non-fatal hls error ignored (internal retry)');
  inst.emit('ERROR', { fatal: true, type: 'networkError', details: 'manifestLoadError' });
  await t.tick();
  assert.equal(inst.destroyed, false, 'fatal error waits for backoff rather than prematurely destroying');
  t.clock.advance(3000); await t.tick();
  assert.equal(inst.destroyed, true, 'failed instance destroyed on actual retry');
  assert.equal(t.Hls.instances.length, 2, 'retry rebuilds hls.js');
  assert.equal(t.Hls.instances[1].url, CONFIRMED_STREAM);
});

await okAsync('hls.js uses supported loading policies, bounded retries and adaptive levels', async () => {
  const t = await loadPlayer({ native: false, playBehavior: 'resolve', withHls: true });
  const c = t.Hls.instances[0].opts;
  assert.equal(c.startLevel, 0, 'non-Android initial level remains unchanged');
  assert.equal(c.capLevelToPlayerSize, true, 'avoid unnecessary high resolution');
  assert.ok(c.maxBufferLength >= 30 && c.maxMaxBufferLength >= c.maxBufferLength);
  for (const name of ['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy']) {
    const p = c[name].default;
    assert.ok(p.maxTimeToFirstByteMs >= 10000, name);
    assert.ok(p.maxLoadTimeMs <= 60000, name);
    assert.ok(p.errorRetry.maxNumRetry >= 2 && p.errorRetry.maxNumRetry <= 6, name);
    assert.ok(p.timeoutRetry.maxNumRetry <= 3, name);
  }
  assert.equal(c.fragLoadingTimeOut, undefined, 'use policy APIs, not deprecated timeout');
  assert.ok(c.liveMaxLatencyDurationCount > c.liveSyncDurationCount);
});

await okAsync('hls.js does not interrupt healthy video on a fatal network report', async () => {
  const t = await loadPlayer({ native: false, playBehavior: 'resolve', withHls: true });
  const inst = t.Hls.instances[0];
  inst.emit('MANIFEST_PARSED', {});
  await t.tick();
  t.video.paused = false;
  t.video.readyState = 4;
  t.video.currentTime = 10;
  t.video.dispatch('timeupdate');
  inst.emit('ERROR', { fatal: true, type: 'networkError', details: 'fragLoadError' });
  assert.equal(inst.destroyed, false, 'buffered video kept alive');
  assert.equal(t.Hls.instances.length, 1, 'no needless source rebuild');
  assert.equal(t.clock.pending(), 1, 'only regular watchdog');
});

await okAsync('hls.js gives fatal media error exactly one in-place recovery', async () => {
  const t = await loadPlayer({ native: false, playBehavior: 'resolve', withHls: true });
  const inst = t.Hls.instances[0];
  inst.emit('ERROR', { fatal: true, type: 'mediaError', details: 'bufferStalledError' });
  assert.equal(inst.recoverCalls, 1, 'recover MSE media source without reloading');
  assert.equal(t.Hls.instances.length, 1);
  inst.emit('ERROR', { fatal: true, type: 'mediaError', details: 'bufferStalledError' });
  assert.equal(inst.recoverCalls, 1, 'do not spin on repeated decoder errors');
  t.clock.advance(3000); await t.tick();
  assert.equal(t.Hls.instances.length, 2, 'subsequent fatal error uses bounded full reload');
});

await okAsync('native HLS error classification does not present a technical error code', async () => {
  const t = await loadPlayer({ native: true, playBehavior: 'resolve', withHls: false });
  t.video.error = { code: 2 };
  for (let i = 0; i < 25; i++) {
    t.video.dispatch('error');
    t.clock.advance(31000);
    await t.tick();
  }
  assert.ok(/connection/i.test(t.els['#offlineMsg'].textContent));
  assert.equal(t.els['#offline'].hidden, false);
});

await okAsync('Android hls.js autoplay rejection recovers from the same player after a tap', async () => {
  const t = await loadPlayer({ native: false, playBehavior: { name: 'NotAllowedError' }, withHls: true });
  const inst = t.Hls.instances[0];
  inst.emit('MANIFEST_PARSED', {});
  await t.tick();
  assert.equal(t.els['#start'].hidden, false, 'user is prompted to tap');
  const loads = t.video.loadCalls;
  t.video.playBehavior = 'resolve';
  t.els['#start'].click();
  await t.tick();
  assert.equal(t.video.playCalls, 2);
  assert.equal(t.video.loadCalls, loads, 'no new media source is created on gesture');
  assert.equal(t.Hls.instances.length, 1, 'hls.js instance preserved');
  assert.equal(t.els['#start'].hidden, true);
});

await okAsync('native and MSE watchdogs recover from a frozen playing stream', async () => {
  for (const native of [true, false]) {
    const t = await loadPlayer({ native, playBehavior: 'resolve', withHls: !native });
    if (!native) { t.Hls.instances[0].emit('MANIFEST_PARSED', {}); await t.tick(); }
    t.video.paused = false;
    t.video.readyState = 4;
    t.clock.advance(95000);
    assert.equal(t.els['#pill'].hidden, false, 'watchdog schedules retry for ' + (native ? 'Safari' : 'MSE'));
    t.clock.advance(3000);
    await t.tick();
    assert.equal(native ? t.video.playCalls : t.Hls.instances.length, 2,
      'frozen stream rebuilt after backoff');
  }
});

await okAsync('Android: initial connection reports actual startup stages', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: true });
  t.els['#start'].click();
  const inst = t.Hls.instances[0];
  assert.match(t.els['#pill'].textContent, /loading playlist/);
  inst.emit('FRAG_LOADING', {});
  assert.match(t.els['#pill'].textContent, /loading video/);
  inst.emit('FRAG_BUFFERED', {});
  assert.match(t.els['#pill'].textContent, /decoding video/);
  inst.emit('MANIFEST_PARSED', {});
  assert.match(t.els['#pill'].textContent, /starting video/);
});

await okAsync('Android: 25-second first-frame timeout initiates a new attempt', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: true });
  t.els['#start'].click();
  t.clock.advance(25000);
  assert.match(t.els['#pill'].textContent, /Retrying/);
  t.clock.advance(3000);
  assert.equal(t.Hls.instances.length, 2);
});

await okAsync('Android: HLS error details are exposed on the small reconnect pill', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: true });
  t.els['#start'].click();
  const inst = t.Hls.instances[0];
  inst.emit('ERROR', { type: 'networkError', details: 'fragLoadError', response: { code: 403 }, fatal: true });
  assert.match(t.els['#pill'].textContent, /fragLoadError HTTP 403/);
});

await okAsync('Android: no stream, retries, or background requests before Play tap', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: true });
  assert.equal(t.Hls.instances.length, 0, 'hls.js must not initialize before tap');
  assert.equal(t.video.playCalls, 0);
  assert.equal(t.els['#start'].hidden, false, 'Play must be visible');
  assert.match(t.els['#start'].textContent, /Play EriTV/);
  assert.equal(t.els['#pill'].hidden, true, 'no premature reconnect loop');
  t.clock.advance(130000);
  assert.equal(t.Hls.instances.length, 0, 'watchdog must ignore non-started viewer');
  assert.equal(t.clock.pending(), 1);
  (t.winListeners.online || []).forEach((fn) => fn());
  assert.equal(t.Hls.instances.length, 0, 'online event must not start playback');
  (t.docListeners.visibilitychange || []).forEach((fn) => fn());
  assert.equal(t.Hls.instances.length, 0, 'tab focus must not start playback');
  (t.winListeners.offline || []).forEach((fn) => fn());
  assert.equal(t.els['#pill'].hidden, true, 'offline status stays hidden until Play');
});

await okAsync('Android: Play tap creates HLS engine, and manifest starts playback', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: true });
  t.els['#start'].click();
  assert.equal(t.Hls.instances.length, 1, 'initializes in the user click handler');
  assert.equal(t.Hls.instances[0].url, CONFIRMED_STREAM);
  assert.equal(t.Hls.instances[0].opts.startLevel, -1, 'Android initial quality is automatic');
  assert.equal(t.els['#start'].hidden, true);
  assert.equal(t.els['#pill'].hidden, false, 'shows connecting status');
  t.Hls.instances[0].emit('MANIFEST_PARSED', {});
  await t.tick();
  assert.equal(t.video.playCalls, 1, 'tries play when manifest is ready');
});

await okAsync('Android: a ready-but-frozen video is NOT considered recovered', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: true });
  t.els['#start'].click();
  const inst = t.Hls.instances[0];
  inst.emit('MANIFEST_PARSED', {});
  await t.tick();
  t.video.paused = false;
  t.video.readyState = 4; // buffered frames do not prove that playback advances
  inst.emit('ERROR', { type: 'networkError', details: 'levelLoadTimeout', fatal: true });
  assert.equal(t.els['#pill'].hidden, false, 'reconnecting must be visible');
  t.clock.advance(3000);
  await t.tick();
  assert.equal(t.Hls.instances.length, 2, 'retry replaces frozen MSE session');
  assert.equal(inst.destroyed, true);
});

await okAsync('Android: no first frame by 65 seconds triggers bounded reconnection', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: true });
  t.els['#start'].click();
  const inst = t.Hls.instances[0];
  inst.emit('MANIFEST_PARSED', {});
  await t.tick();
  t.video.paused = false;
  t.video.readyState = 4;
  t.video.dispatch('playing');
  t.clock.advance(60000);
  assert.equal(t.Hls.instances.length, 1);
  assert.match(t.els['#pill'].textContent, /Tap to retry/);
  t.clock.advance(5000);
  assert.match(t.els['#pill'].textContent, /Retrying/);
  t.clock.advance(3000);
  await t.tick();
  assert.equal(t.Hls.instances.length, 2, 'no perpetual unresponsive MSE');
});

await okAsync('Android: tapping small reconnect pill performs an immediate hard reset', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: true });
  t.els['#start'].click();
  const first = t.Hls.instances[0];
  first.emit('ERROR', { fatal: true, type: 'networkError', details: 'manifestLoadError' });
  assert.match(t.els['#pill'].textContent, /Retrying/);
  t.els['#pill'].click();
  assert.equal(first.destroyed, true, 'stuck session discarded immediately');
  assert.equal(t.Hls.instances.length, 2);
  t.clock.advance(3000);
  assert.equal(t.Hls.instances.length, 2, 'old retry timer was cancelled');
});

await okAsync('Android: autoplay policy fallback Tap to Watch keeps same HLS session', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: { name: 'NotAllowedError' }, withHls: true });
  t.els['#start'].click();
  const inst = t.Hls.instances[0];
  inst.emit('MANIFEST_PARSED', {});
  await t.tick();
  assert.equal(t.els['#start'].hidden, false);
  const loads = t.video.loadCalls;
  t.video.playBehavior = 'resolve';
  t.els['#start'].click();
  await t.tick();
  assert.equal(t.Hls.instances.length, 1, 'does not rebuild on an autoplay prompt');
  assert.equal(t.video.loadCalls, loads);
  assert.equal(t.video.playCalls, 2);
});

await okAsync('iPhone: native HLS retains autoplay attempt and Safari gesture fallback', async () => {
  const t = await loadPlayer({ native: true, android: false, playBehavior: 'resolve', withHls: true });
  assert.equal(t.video.src, CONFIRMED_STREAM);
  assert.equal(t.video.playCalls, 1);
  assert.equal(t.Hls.instances.length, 0, 'Safari must never use MSE');
  assert.equal(t.els['#start'].hidden, true);
});

await okAsync('Android: failed player-library CDN shows an actionable reload', async () => {
  const t = await loadPlayer({ native: false, android: true, playBehavior: 'resolve', withHls: false });
  assert.equal(t.els['#offline'].hidden, false);
  assert.equal(t.els['#retry'].hidden, false);
  assert.match(t.els['#offlineMsg'].textContent, /video player/);
  assert.equal(t.els['#retry'].textContent, 'Reload player');
  t.els['#retry'].click();
  assert.equal(t.pageReloads(), 1);
});

await okAsync('no engine: unsupported panel shown, retry hidden', async () => {
  const t = await loadPlayer({ native: false, playBehavior: 'resolve', withHls: false });
  assert.equal(t.els['#offline'].hidden, false);
  assert.equal(t.els['#retry'].hidden, true);
  assert.ok(/Safari/.test(t.els['#offlineMsg'].textContent));
});

console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' (with failures)' : ''));
