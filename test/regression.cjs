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
function setup(customFetch) {
  let now = 0, id = 0;
  const timers = new Map(), intervals = new Map(), logs = [], calls = [];
  class XHR {
    constructor() { this.events = new Map(); this.status = 200; this.responseType = 'json'; }
    open() {} send() {}
    addEventListener(k, fn) { this.events.set(k, fn); }
    removeEventListener(k) { this.events.delete(k); }
    finish(value) { this.response = value; this.events.get('load')?.(); this.events.get('loadend')?.(); }
  }
  const sandbox = {
    URL, URLSearchParams, AbortController, TextDecoder, XMLHttpRequest: XHR,
    document: {readyState: 'complete', addEventListener() {}},
    localStorage: {getItem: k => k === '_tx_s' || k === '_tx_translate' ? '0' : null},
    console: {log: s => logs.push(s), info() {}, warn() {}},
    setTimeout(fn, delay) { timers.set(++id, {fn, due: now + delay}); return id; },
    clearTimeout(key) { timers.delete(key); },
    setInterval(fn, delay) { intervals.set(delay, fn); },
  };
  const response = {ok: true, json: async () => ({display_name: 'Example Village, Example Region', address: {}}), arrayBuffer: async () => Buffer.from('{}')};
  sandbox.window = {location: {href: origin + '/fixture', origin}, fetch: async (url, options) => {
    calls.push(String(url)); return customFetch ? customFetch(String(url), options, response) : response;
  }};
  vm.runInNewContext(code, sandbox);
  const start = path => { const xhr = new XHR(); xhr.open('GET', origin + path); xhr.send(); return xhr; };
  async function tick(to) {
    while (true) {
      const event = [...timers].filter(([, t]) => t.due <= to).sort((a,b) => a[1].due - b[1].due)[0];
      if (!event) break;
      now = event[1].due; timers.delete(event[0]); event[1].fn(); await flush();
    }
    now = to; await flush();
  }
  return {start, tick, logs, calls, intervals};
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
    e.start(meta).finish(pano(2)); await e.intervals.get(2000)(); await e.tick(1000);
    assert.equal(e.logs.length, 2); assert(e.logs[1].includes('test-2'));
    await e.intervals.get(2000)(); await e.tick(1500); assert.equal(e.logs.length, 2);
    console.log('PASS same-page round sync without duplicate lookups');
  }
  console.log('All 6 regression scenarios passed.');
})().catch(e => {console.error(e); process.exitCode = 1;});
