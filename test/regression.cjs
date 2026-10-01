// Synthetic fixtures only: no HAR exports, real game IDs, or account data.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const code = fs.readFileSync(require('node:path').join(__dirname, '../tuxun-helper.user.js'), 'utf8');
const origin = 'https://tuxun.fun';
const endpoints = ['/api/v0/tuxun/challenge/getGameInfo', '/api/v0/tuxun/solo/get'];
const meta = '/api/v0/tuxun/mapProxy/getQQPanoInfo';
const game = (round = 1) => ({success: true, data: {id: 'synthetic-game', currentRound: round, rounds: [{round, source: 'qq_pano', panoId: 'test-' + round}]}});
const pano = (round = 1) => ({success: true, data: {pano: 'test-' + round, lat: 20 + round, lng: 100 + round}});
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(customFetch, {quiet = false, hidden = false, storageBroken = false, probe = false} = {}) {
  let now = 0, id = 0;
  const timers = new Map(), intervals = new Map(), logs = [], calls = [];
  function events() {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(k, fn) {if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k).add(fn);},
      removeEventListener(k, fn) {listeners.get(k)?.delete(fn);},
      emit(k, event) {for (const fn of [...(listeners.get(k) || [])]) fn(event);}
    };
  }
  const docEvents = events(), windowEvents = events();
  const preferences = new Map([['_tx_s', '0'], ['_tx_translate', '0']]);
  if (!quiet) preferences.set('_tx_quiet', '0');
  class XHR {
    constructor() { this.events = new Map(); this.status = 200; this.responseType = 'json'; }
    open() {} send() {}
    addEventListener(k, fn) { this.events.set(k, fn); }
    removeEventListener(k) { this.events.delete(k); }
    finish(value) { this.response = value; this.events.get('load')?.(); this.events.get('loadend')?.(); }
  }
  const sandbox = {
    URL, URLSearchParams, AbortController, TextDecoder, XMLHttpRequest: XHR, Date: {now: () => now},
    document: {readyState: 'complete', hidden, ...docEvents},
    localStorage: {
      getItem(k) {if (storageBroken) throw Error('storage blocked'); return preferences.get(k) ?? null;},
      setItem(k,v) {if (storageBroken) throw Error('storage blocked'); preferences.set(k,v);},
      removeItem(k) {if (storageBroken) throw Error('storage blocked'); preferences.delete(k);}
    },
    console: {log: s => logs.push(s), info() {}, warn() {}},
    setTimeout(fn, delay) { timers.set(++id, {fn, due: now + delay}); return id; },
    clearTimeout(key) { timers.delete(key); },
    setInterval(fn, delay) { intervals.set(delay, fn); },
  };
  const response = {ok: true, json: async () => ({display_name: 'Example Village, Example Region', address: {}}), arrayBuffer: async () => Buffer.from('{}')};
  sandbox.window = {...windowEvents, location: {href: origin + '/fixture', origin}, fetch: async (url, options) => {
    calls.push(String(url)); return customFetch ? customFetch(String(url), options, response) : response;
  }};
  sandbox.window.history = {
    pushState(state, unused, path) {sandbox.window.location.href = new URL(path, origin).href; return 'site-history-result';},
    replaceState(state, unused, path) {sandbox.window.location.href = new URL(path, origin).href;}
  };
  const originals = {fetch: sandbox.window.fetch, open: XHR.prototype.open, send: XHR.prototype.send, pushState: sandbox.window.history.pushState};
  // Test-only closure access; no debug/global API is shipped in the userscript.
  const testCode = probe ? code.replace(/\}\)\(\);\s*$/, 'window.probe = {pause, resume, requestSync, setTranslation, timers, cleanups, pendingXHR, getView: () => view};\n})();') : code;
  vm.runInNewContext(testCode, sandbox);
  const start = path => { const xhr = new XHR(); xhr.open('GET', origin + path); xhr.send(); return xhr; };
  async function tick(to) {
    while (true) {
      const event = [...timers].filter(([, t]) => t.due <= to).sort((a,b) => a[1].due - b[1].due)[0];
      if (!event) break;
      now = event[1].due; timers.delete(event[0]); event[1].fn(); await flush();
    }
    now = to; await flush();
  }
  return {start, tick, logs, calls, intervals, timers, sandbox, originals, preferences,
    visibility: async hidden => {sandbox.document.hidden = hidden; docEvents.emit('visibilitychange'); await flush();}};
}
(async () => {
  for (const endpoint of endpoints) {
    const e = setup();
    e.start(endpoint).finish(game()); e.start(meta).finish(pano()); e.start(meta).finish(pano(9));
    await e.tick(1000);
    assert.equal(e.logs.length, 1); assert(e.logs[0].includes('test-1'));
    assert.equal(new URL(e.calls.find(x => x.includes('/reverse?'))).searchParams.get('lat'), '21');
    console.log('PASS current pano selection: ' + endpoint);
  }
  {
    const e = setup(); e.start(meta).finish(pano()); await e.tick(1000); assert.equal(e.calls.length, 0);
    e.start(endpoints[0]).finish(game()); await e.tick(2000); assert.equal(e.logs.length, 1);
    console.log('PASS metadata before game, no unconfirmed lookup');
  }
  {
    const e = setup(), old = e.start(endpoints[0]), newer = e.start(endpoints[0]);
    newer.finish(game(2)); old.finish(game()); e.start(meta).finish(pano()); e.start(meta).finish(pano(2));
    await e.tick(1000); assert.equal(e.logs.length, 1); assert(e.logs[0].includes('test-2'));
    console.log('PASS stale game response rejected');
  }
  {
    const deferred = [];
    const e = setup((url, options, fallback) => url.includes('/reverse?') ? new Promise(resolve => deferred.push(resolve)) : fallback);
    e.start(endpoints[0]).finish(game()); e.start(meta).finish(pano()); await e.tick(500);
    e.start(endpoints[0]).finish(game(2)); e.start(meta).finish(pano(2)); await e.tick(1000);
    deferred[1]({ok: true, json: async () => ({display_name: 'NEW'})}); await flush();
    deferred[0]({ok: true, json: async () => ({display_name: 'OLD'})}); await flush();
    assert.equal(e.logs.length, 1); assert(e.logs[0].includes('NEW'));
    console.log('PASS late address response cannot overwrite new round');
  }
  {
    const e = setup((url, options, fallback) => url.includes('/solo/get') ? {ok: true, json: async () => game(2)} : fallback);
    e.start(endpoints[1]).finish(game()); e.start(meta).finish(pano()); await e.tick(500);
    e.start(meta).finish(pano(2)); await e.tick(1500);
    assert.equal(e.logs.length, 2); assert(e.logs[1].includes('test-2'));
    e.start(endpoints[1]).finish(game(2)); await e.tick(2500); assert.equal(e.logs.length, 2);
    assert.equal(e.calls.filter(x=>x.includes('/reverse?')).length, 2);
    console.log('PASS same-page round sync without duplicate lookups');
  }
  {
    const e = setup(undefined, {quiet: true});
    e.start(endpoints[0]).finish(game()); e.start(meta).finish(pano()); await e.tick(1000);
    assert.equal(e.logs.length, 0); assert(e.calls.some(x => x.includes('/reverse?')));
    console.log('PASS quiet default suppresses output while still retrieving address');
  }
  {
    const e = setup((url, options, fallback) => url.includes('/solo/get') ? {ok: true, json: async () => game()} : fallback, {hidden: true});
    e.start(endpoints[1]).finish(game()); e.start(meta).finish(pano()); await e.tick(1000);
    await e.tick(30000); assert.equal(e.calls.length, 0);
    await e.visibility(false); await e.tick(31000);
    assert.equal(e.calls.filter(x=>x.includes('/reverse?')).length, 1);
    assert.equal(e.logs.length, 1);
    console.log('PASS hidden tab defers address and sync; foreground resumes once');
  }
  {
    const deferred = [], signals = [];
    const e = setup((url, options, fallback) => {
      if (url.includes('/reverse?')) {signals.push(options.signal); return new Promise(resolve => deferred.push(resolve));}
      if (url.includes('/solo/get')) return {ok: true, json: async () => game()};
      return fallback;
    });
    e.start(endpoints[1]).finish(game()); e.start(meta).finish(pano()); await e.tick(500);
    await e.visibility(true); assert(signals[0].aborted);
    deferred[0]({ok: true, json: async () => ({display_name: 'CANCELLED'})}); await flush(); assert.equal(e.logs.length, 0);
    await e.visibility(false);
    deferred[1]({ok: true, json: async () => ({display_name: 'RESUMED'})}); await flush();
    assert.equal(e.logs.length, 1); assert(e.logs[0].includes('RESUMED'));
    assert.equal(e.sandbox.window.history.pushState({}, '', '/home'), 'site-history-result');
    const count = e.calls.length; await e.tick(60000); assert.equal(e.calls.length, count);
    console.log('PASS hidden tab aborts requests, ignores late results, and leaving game stops sync');
  }
  {
    const e = setup((url, options, fallback) => url.includes('/solo/get') ? {ok: true, json: async () => game()} : fallback);
    e.start(endpoints[1]).finish(game()); e.start(meta).finish(pano()); await e.tick(1000);
    for (let i=0; i<10; i++) e.start(meta).finish(pano(9));
    await e.tick(2000);
    assert.equal(e.calls.filter(x=>x.includes('/solo/get')).length, 1);
    assert.equal(e.calls.filter(x=>x.includes('/reverse?')).length, 1);
    await e.tick(29999); assert.equal(e.calls.filter(x=>x.includes('/solo/get')).length, 1);
    await e.tick(30001); assert.equal(e.calls.filter(x=>x.includes('/solo/get')).length, 2);
    assert.equal(e.intervals.size, 0);
    console.log('PASS metadata bursts coalesce; only a 30-second fallback remains');
  }
  {
    const pending = [], signals = [];
    const e = setup((url, options, fallback) => {
      if (url.includes('/reverse?')) {signals.push(options.signal); return new Promise(resolve => pending.push(resolve));}
      if (url.includes('/solo/get')) return {ok:true, json:async()=>game(2)};
      return fallback;
    }, {probe:true});
    const p = e.sandbox.window.probe;
    e.start(endpoints[1]).finish(game()); e.start(meta).finish(pano()); await e.tick(500);
    const late = e.start(meta);
    p.pause();
    assert(signals[0].aborted);
    assert.equal(e.timers.size, 0); assert.equal(p.pendingXHR.size, 0); assert.equal(p.cleanups.size, 0);
    assert.equal(late.events.size, 0);
    assert.equal(e.sandbox.window.fetch, e.originals.fetch);
    assert.equal(e.sandbox.XMLHttpRequest.prototype.open, e.originals.open);
    assert.equal(e.sandbox.XMLHttpRequest.prototype.send, e.originals.send);
    assert.equal(e.sandbox.window.history.pushState, e.originals.pushState);
    const count = e.calls.length;
    await e.tick(60000); assert.equal(e.calls.length, count);
    p.resume(); await flush(); e.start(meta).finish(pano(2)); await e.tick(61000);
    pending[0]({ok:true, json:async()=>({display_name:'OLD PAUSED REQUEST'})}); await flush();
    assert.equal(e.logs.length, 0);
    pending[1]({ok:true, json:async()=>({display_name:'RESUMED ROUND'})}); await flush();
    assert.equal(e.logs.length, 1); assert(e.logs[0].includes('test-2'));
    p.pause(); p.resume(); await flush(); p.pause(); assert.equal(e.timers.size, 0);
    console.log('PASS pause removes hooks/listeners/timers, aborts work, and rejects old-session results');
  }
  {
    const e = setup(undefined, {probe:true});
    const p = e.sandbox.window.probe;
    const own = e.sandbox.window.fetch;
    const laterWrapper = (...args) => own(...args);
    e.sandbox.window.fetch = laterWrapper;
    p.pause(); assert.equal(e.sandbox.window.fetch, laterWrapper);
    p.resume();
    e.start(endpoints[0]).finish(game()); e.start(meta).finish(pano()); await e.tick(1000);
    assert.equal(e.logs.length, 1);
    console.log('PASS pause preserves later third-party wrappers; previous hook stays inert');
  }
  {
    const response = {ok:true, clone() {throw Error('clone failed');}, json:async()=>game()};
    const e = setup(()=>response, {storageBroken:true, probe:true});
    const returned = e.sandbox.window.fetch(origin+endpoints[0]);
    assert.equal(await returned, response); await flush();
    // A response clone error must not alter the page response or reject its promise.
    e.sandbox.window.probe.pause(); assert.equal(e.timers.size, 0);
    console.log('PASS storage/response-observation failures preserve website fetch response');
  }
  {
    let pausedRound = 1;
    const e = setup((url, options, fallback) => {
      if (url.includes('/solo/get')) return {ok:true, json:async()=>game(pausedRound)};
      if (url.includes(meta)) return {ok:true, json:async()=>pano(pausedRound)};
      return fallback;
    }, {probe:true});
    e.start(endpoints[1]).finish(game()); e.start(meta).finish(pano()); await e.tick(1000);
    e.sandbox.window.probe.pause(); pausedRound = 2;
    e.sandbox.window.probe.resume(); await flush(); await e.tick(2000);
    assert(e.logs[1].includes('test-2'));
    assert.equal(e.calls.filter(x=>x.includes(meta)).length, 1);
    e.sandbox.window.probe.pause(); e.sandbox.window.probe.resume(); await flush(); await e.tick(3000);
    assert.equal(e.calls.filter(x=>x.includes(meta)).length, 1);
    console.log('PASS resume recovers missed QQ metadata and reuses confirmed cached metadata');
  }
  {
    const waiting = [], signals = [];
    const e = setup((url, options, fallback) => {
      if (url.includes('translate.googleapis')) {signals.push(options.signal); return new Promise(resolve=>waiting.push(resolve));}
      return fallback;
    }, {probe:true});
    e.start(endpoints[0]).finish(game()); e.start(meta).finish(pano()); await e.tick(1000);
    const p = e.sandbox.window.probe;
    p.setTranslation(true); await flush(); p.setTranslation(false);
    assert(signals[0].aborted);
    assert.equal(e.timers.size, 1); // Only the game fallback remains.
    waiting[0]({ok:true,json:async()=>[[['LATE TRANSLATION']]]}); await flush();
    assert.equal(p.getView().addressZh, '');
    assert.equal(e.calls.filter(x=>x.includes('/reverse?')).length, 1);
    p.pause(); assert.equal(e.timers.size, 0);
    console.log('PASS disabling translation aborts its request/timer without repeating address lookup');
  }
  console.log('All 15 regression scenarios passed.');
})().catch(e => {console.error(e); process.exitCode = 1;});
