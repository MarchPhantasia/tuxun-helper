// ==UserScript==
// @name         图寻辅助（题目匹配修复版）
// @namespace    local.tuxun.round-fixed
// @version      1.4.1
// @description  题目面板、中外文对照及华为底图辅助标点；支持挑战与排位模式
// @match        *://tuxun.fun/*
// @run-at       document-start
// @grant        none
// @author       Yu; local bugfix
// @license      AGPL-3.0
// ==/UserScript==
// Based on https://github.com/YU-1021/tuxunScript (user supplied v1.1).
// Verified authorities: challenge/getGameInfo and solo/get (rank/solo modes).
// Shows the round's starting location, including in rounds that allow movement.
// Unknown game modes wait for an authoritative round instead of guessing a pano.
(function () {
    'use strict';
    const nativeFetch = window.fetch.bind(window);
    const GAME = new Set(['/api/v0/tuxun/challenge/getGameInfo', '/api/v0/tuxun/solo/get']);
    const META = /\/mapProxy\/(getQQPanoInfo|getPanoInfo)$/;
    const cache = new Map();
    const requests = new WeakMap();
    let sequence = 0, latestGameRequest = 0, target = null, location = null;
    let revision = 0, job = 0, timer, controller;
    let page = window.location.href;
    let gameInfoUrl = null, syncing = false;
    const translations = new Map();
    let mapMark = null;
    let pendingMapFocus = null;
    let mapEnabled = localStorage.getItem('_tx_map_marker') === '1';
    let mapMessage = '开启后在右下角地图显示辅助标点';
    let panel = null;
    function mapStatus(message) {
        if (message === mapMessage) return;
        mapMessage = message;
        if (panel) panel.root.getElementById('map-status').textContent = message;
    }
    function clearMapMarker() {
        if (!mapMark) return;
        const { map, layer, draw, container, positioned } = mapMark;
        for (const event of ['render', 'move', 'resize']) {
            try { map.off(event, draw); } catch {}
        }
        layer.remove();
        if (positioned && container.style.position === 'relative') container.style.position = '';
        mapMark = null;
    }
    function findMap() {
        // The captured React Map component uses id="map" and a petal raster
        // source. Limit discovery to its React context/refs; do not alter handlers.
        const canvas = document.querySelector('#map canvas.maplibregl-canvas, #map canvas.mapboxgl-canvas');
        if (!canvas) return null;
        const queue = [], visited = new WeakSet();
        let element = canvas;
        for (let n = 0; element && n < 6; n++, element = element.parentElement) {
            for (const key of Object.keys(element)) {
                if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) queue.push(element[key]);
            }
        }
        const keys = ['return', 'child', 'sibling', 'memoizedProps', 'memoizedState', 'dependencies', 'firstContext',
            'memoizedValue', 'next', 'ref', 'current', 'value', 'map', '_map', 'maps'];
        for (let index = 0; index < queue.length && index < 2500; index++) {
            const value = queue[index];
            if (!value || typeof value !== 'object' || visited.has(value)) continue;
            visited.add(value);
            try {
                if (typeof value.getContainer === 'function' && typeof value.getCanvas === 'function' &&
                    typeof value.project === 'function' && typeof value.on === 'function' && typeof value.off === 'function' &&
                    value.getCanvas() === canvas) return value;
                if (typeof value.getMap === 'function') queue.push(value.getMap());
                for (const key of keys) {
                    const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    if (descriptor && 'value' in descriptor && descriptor.value && typeof descriptor.value === 'object') queue.push(descriptor.value);
                }
                if (Array.isArray(value)) queue.push(...value.slice(0, 20));
            } catch { /* A stale React ref is ignored. */ }
        }
        return null;
    }
    function refreshMapMarker() {
        if (!mapEnabled) return;
        if (!target || !location) { clearMapMarker(); mapStatus('等待当前题目坐标'); return; }
        if (mapMark && (!mapMark.container.isConnected || mapMark.layer.isConnected === false ||
            mapMark.canvas.isConnected === false || mapMark.map.getCanvas() !== mapMark.canvas)) clearMapMarker();
        if (mapMark) { mapMark.draw(); applyPendingMapFocus(); return; }
        const map = findMap();
        if (!map) { mapStatus(pendingMapFocus ? '请展开右下角地图，连接后将自动定位' : '尚未连接地图，请展开右下角地图后重试'); return; }
        try {
            const container = map.getContainer();
            const positioned = getComputedStyle(container).position === 'static';
            if (positioned) container.style.position = 'relative';
            const layer = document.createElement('div');
            layer.className = 'tx-helper-marker-layer';
            layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:4;';
            const root = layer.attachShadow({ mode: 'open' });
            root.innerHTML = `<style>:host{pointer-events:none}.pin{position:absolute;left:0;top:0;display:none;pointer-events:none;font:12px/1.4 "Microsoft YaHei",sans-serif}.label{position:absolute;bottom:16px;left:0;transform:translateX(-50%);background:#162937;color:#e8fff9;border:1px solid #64d9b7;border-radius:6px;padding:4px 7px;white-space:nowrap;box-shadow:0 2px 8px #0006}.point{position:absolute;left:-8px;top:-8px;width:16px;height:16px;border-radius:50%;box-sizing:border-box;background:#26d4aa;border:3px solid white;box-shadow:0 0 0 5px #26d4aa55,0 2px 6px #0008}</style><div class="pin"><span class="label"></span><span class="point"></span></div>`;
            const pin = root.querySelector('.pin'), label = root.querySelector('.label');
            const draw = () => {
                try {
                    if (!location || !target) { pin.style.display = 'none'; return; }
                    if (!container.clientWidth || !container.clientHeight) {
                        pin.style.display = 'none';
                        mapStatus('地图已收起，展开后恢复标点');
                        return;
                    }
                    let lng = location.lng;
                    const center = map.getCenter?.();
                    if (Number.isFinite(center?.lng)) lng += Math.round((center.lng - lng) / 360) * 360;
                    const point = map.project([lng, location.lat]);
                    const visible = Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x <= container.clientWidth && point.y <= container.clientHeight;
                    pin.style.display = visible ? 'block' : 'none';
                    pin.style.transform = `translate(${point.x}px,${point.y}px)`;
                    label.textContent = `第 ${target.round} 题起点 · 辅助`;
                    mapStatus(visible ? '辅助标点已显示（不提交答案）' : '标点在视野外，点击“定位标记”查看');
                } catch { pin.style.display = 'none'; mapStatus('地图已变化，请关闭后重新开启标点'); }
            };
            container.appendChild(layer);
            mapMark = { map, layer, draw, container, positioned, canvas: map.getCanvas() };
            for (const event of ['render', 'move', 'resize']) map.on(event, draw);
            draw();
            applyPendingMapFocus();
        } catch (e) {
            clearMapMarker();
            mapStatus('地图接入失败，可关闭后重试');
        }
    }
    function focusMarker() {
        if (!target || !location) { mapStatus('等待当前题目坐标'); return; }
        if (!mapEnabled) {
            mapEnabled = true;
            localStorage.setItem('_tx_map_marker', '1');
            renderPanel();
        }
        pendingMapFocus = { revision, lat: location.lat, lng: location.lng };
        refreshMapMarker();
    }
    function applyPendingMapFocus() {
        if (!pendingMapFocus || !mapMark) return;
        if (pendingMapFocus.revision !== revision) { pendingMapFocus = null; return; }
        if (!mapMark.container.clientWidth || !mapMark.container.clientHeight) return;
        const point = pendingMapFocus;
        pendingMapFocus = null;
        try {
            const map = mapMark.map;
            map.resize?.();
            const currentZoom = map.getZoom?.() ?? 1;
            map.easeTo({ center: [point.lng, point.lat], zoom: Math.min(map.getMaxZoom?.() ?? 17, Math.max(currentZoom, 11)), duration: 400 });
        } catch { mapStatus('无法移动地图视野，请手动缩放查看标点'); }
    }
    let view = { status: '等待题目数据', round: null, id: '', coords: '', address: '', detail: '', addressZh: '', detailZh: '', translation: '' };
    const autoTranslate = () => localStorage.getItem('_tx_translate') !== '0';
    function show(patch) { Object.assign(view, patch); renderPanel(); }
    function clearView(status = '等待当前题目数据') {
        view = { status, round: null, id: '', coords: '', address: '', detail: '', addressZh: '', detailZh: '', translation: '' };
        renderPanel();
    }
    function renderPanel() {
        if (!panel) return;
        const put = (id, text) => { panel.root.getElementById(id).textContent = text; };
        put('round', view.round ? `第 ${view.round} 题 · 起点` : '等待题目');
        put('status', view.status);
        put('original', view.address || '识别题目后自动显示');
        put('chinese', view.addressZh || (view.address ? (autoTranslate() ? '正在翻译…' : '自动翻译已关闭') : '—'));
        put('detail-original', view.detail);
        put('detail-chinese', view.detailZh || (autoTranslate() ? '正在翻译…' : '自动翻译已关闭'));
        put('translation-status', view.translation);
        put('coords', view.coords || '—');
        put('pano', view.id || '—');
        panel.root.getElementById('detail-block').hidden = !view.detail;
        panel.root.getElementById('translate').checked = autoTranslate();
        panel.root.getElementById('copy').disabled = !view.id;
        panel.root.getElementById('map-mark').checked = mapEnabled;
        panel.root.getElementById('map-focus').disabled = !location;
        put('map-status', mapMessage);
    }
    function mountPanel() {
        if (panel || !document.documentElement) return;
        const host = document.createElement('div');
        host.id = 'tuxun-helper-panel';
        host.style.cssText = 'position:fixed;top:96px;right:20px;z-index:2147483647;display:block;max-width:calc(100vw - 20px);color-scheme:dark;';
        const root = host.attachShadow({ mode: 'open' });
        // Only static markup goes into innerHTML. All remote strings use textContent.
        root.innerHTML = `
          <style>
            :host{font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8edf4;text-align:left}
            *{box-sizing:border-box} [hidden]{display:none!important}
            .panel{width:348px;max-width:calc(100vw - 20px);background:#141b27;border:1px solid #354154;border-radius:16px;box-shadow:0 16px 48px #0006;overflow:hidden}
            header{display:flex;align-items:center;gap:10px;padding:13px 15px;cursor:grab;touch-action:none;user-select:none;background:#1c2635}
            header:active{cursor:grabbing}.mark{width:29px;height:29px;border:1px solid #507f77;border-radius:9px;display:grid;place-items:center;color:#86e0cb;font-size:19px}
            .heading{flex:1;min-width:0}.title{font-size:14px;font-weight:650;letter-spacing:.5px}.round{font-size:11px;color:#a7b7cc}
            button{font:inherit;color:#dde7f3;background:#263449;border:1px solid #40516b;border-radius:8px;padding:6px 10px;cursor:pointer}
            button:hover{background:#334761}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #91e6d1;outline-offset:2px}
            button:disabled{opacity:.45;cursor:default}.collapse{font-size:19px;line-height:18px;padding:4px 9px}
            .body{padding:0 15px 14px;max-height:calc(100vh - 160px);overflow:auto;overscroll-behavior:contain}
            .status{display:flex;gap:7px;align-items:flex-start;color:#a8d9cc;font-size:12px;padding:12px 0}.dot{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:#75cfb8;margin-top:7px}
            .card{background:#1b2534;border:1px solid #2f3c50;border-radius:10px;padding:11px 12px;margin-bottom:10px}
            .label{font-size:10px;color:#9baec5;font-weight:600;letter-spacing:1px;margin-bottom:5px}.chinese{font-size:16px;line-height:1.6;color:#f1f5fa;overflow-wrap:anywhere;white-space:pre-wrap}
            .divider{height:1px;background:#344257;margin:10px 0}.original{font-size:12px;color:#b7c6d8;overflow-wrap:anywhere;white-space:pre-wrap}
            .translation-note{font-size:11px;color:#a3b3c8;min-height:18px;margin:5px 0 10px;overflow-wrap:anywhere}
            .toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.toggle{display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px}.toggle input{accent-color:#80d5bf;margin:0}
            .actions{display:flex;gap:6px}details{margin-top:12px;border-top:1px solid #303e52;padding-top:9px;color:#9fb0c6;font-size:11px}summary{cursor:pointer}
            dl{margin:8px 0}dt{color:#849bb6;margin-top:6px}dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace;color:#cbd7e7}
            .foot{margin-top:10px;display:flex;justify-content:space-between;gap:8px;color:#849bb6;font-size:10px}.link{padding:0;border:0;background:none;color:#b7cddd;font-size:11px}.link:hover{background:none;text-decoration:underline}
            .folded{width:235px}.folded .body{display:none}
          </style>
          <section class="panel" aria-label="图寻辅助面板">
            <header id="drag"><span class="mark" aria-hidden="true">⌖</span><div class="heading"><div class="title">图寻辅助</div><div class="round" id="round">等待题目</div></div><button class="collapse" id="collapse" aria-label="折叠面板" aria-expanded="true">−</button></header>
            <div class="body">
              <div class="status" role="status"><span class="dot"></span><span id="status"></span></div>
              <div class="card"><div class="label">中文 · 地址</div><div class="chinese" id="chinese"></div><div class="divider"></div><div class="label">原文 · 地址服务返回</div><div class="original" id="original"></div></div>
              <div class="card" id="detail-block" hidden><div class="label">中文 · 街景描述</div><div class="chinese" id="detail-chinese"></div><div class="divider"></div><div class="label">原文 · 街景描述</div><div class="original" id="detail-original"></div></div>
              <div class="translation-note" id="translation-status" role="status"></div>
              <div class="toolbar"><label class="toggle" title="将地址和街景描述发送到 Google 翻译；不会发送账号或题目数据"><input type="checkbox" id="translate">自动中文翻译</label><div class="actions"><button id="refresh" title="重新查询当前题目（I）">刷新</button><button id="copy">复制</button></div></div>
              <div class="toolbar" style="margin-top:12px"><label class="toggle"><input type="checkbox" id="map-mark">地图辅助标点</label><button id="map-focus">定位标记</button></div>
              <div class="translation-note" id="map-status" role="status"></div>
              <details><summary>坐标与街景 ID</summary><dl><dt>纬度，经度</dt><dd id="coords"></dd><dt>Pano ID</dt><dd id="pano"></dd></dl></details>
              <div class="foot"><span>题目起点 · 拖动标题栏移动</span><button class="link" id="settings">地图源设置</button></div>
            </div>
          </section>`;
        document.documentElement.appendChild(host);
        panel = { host, root };
        const section = root.querySelector('section');
        const collapse = root.getElementById('collapse');
        const fold = value => {
            section.classList.toggle('folded', value);
            collapse.textContent = value ? '+' : '−';
            collapse.setAttribute('aria-expanded', String(!value));
            collapse.setAttribute('aria-label', value ? '展开面板' : '折叠面板');
            localStorage.setItem('_tx_panel_fold', value ? '1' : '0');
        };
        fold(localStorage.getItem('_tx_panel_fold') === '1');
        const place = (x, y) => {
            const rect = host.getBoundingClientRect();
            const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
            const top = Math.max(8, Math.min(y, window.innerHeight - 58));
            host.style.left = left + 'px'; host.style.top = top + 'px'; host.style.right = 'auto';
            root.querySelector('.body').style.maxHeight = Math.max(100, window.innerHeight - top - 78) + 'px';
            return { left, top };
        };
        try { const p = JSON.parse(localStorage.getItem('_tx_panel_pos')); if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) place(p.left, p.top); } catch {}
        collapse.addEventListener('click', () => { fold(!section.classList.contains('folded')); const r = host.getBoundingClientRect(); place(r.left, r.top); });
        const header = root.getElementById('drag');
        let drag = null;
        header.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target.closest('button')) return;
            const r = host.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            header.setPointerCapture(e.pointerId); e.preventDefault();
        });
        header.addEventListener('pointermove', e => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy); });
        const endDrag = () => {
            if (!drag) return;
            drag = null;
            const r = host.getBoundingClientRect();
            localStorage.setItem('_tx_panel_pos', JSON.stringify({ left: r.left, top: r.top }));
        };
        header.addEventListener('pointerup', endDrag); header.addEventListener('pointercancel', endDrag);
        window.addEventListener('resize', () => { const r = host.getBoundingClientRect(); place(r.left, r.top); });
        for (const event of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel', 'keydown', 'keyup']) host.addEventListener(event, e => e.stopPropagation());
        root.getElementById('refresh').addEventListener('click', async () => { await syncRound(); clearTimeout(timer); update(); });
        root.getElementById('settings').addEventListener('click', resetSource);
        root.getElementById('map-mark').addEventListener('change', e => {
            mapEnabled = e.target.checked;
            localStorage.setItem('_tx_map_marker', mapEnabled ? '1' : '0');
            if (mapEnabled) refreshMapMarker();
            else { pendingMapFocus = null; clearMapMarker(); mapStatus('地图辅助标点已关闭'); }
        });
        root.getElementById('map-focus').addEventListener('click', focusMarker);
        root.getElementById('translate').addEventListener('change', e => {
            localStorage.setItem('_tx_translate', e.target.checked ? '1' : '0');
            clearTimeout(timer); update();
        });
        root.getElementById('copy').addEventListener('click', async () => {
            const text = [`第 ${view.round} 题起点`, `中文：${view.addressZh || '暂无译文'}`, `原文：${view.address}`, view.detail && `街景：${view.detailZh || view.detail}`, `坐标：${view.coords}`, `pano：${view.id}`].filter(Boolean).join('\n');
            const button = root.getElementById('copy');
            try { await navigator.clipboard.writeText(text); button.textContent = '已复制'; }
            catch { button.textContent = '复制失败'; }
            setTimeout(() => { button.textContent = '复制'; }, 1500);
        });
        renderPanel();
    }

    function invalidate() {
        pendingMapFocus = null;
        revision++;
        job++;
        clearTimeout(timer);
        controller?.abort();
        controller = null;
        location = null;
        clearMapMarker();
        if (mapEnabled) mapStatus('等待当前题目坐标');
        clearView();
    }
    function checkPage() {
        if (page !== window.location.href) {
            page = window.location.href;
            invalidate();
            target = null;
            cache.clear();
            gameInfoUrl = null;
            latestGameRequest = ++sequence;
        }
    }
    function kind(url) {
        const u = new URL(url, window.location.href);
        if (u.origin === window.location.origin && GAME.has(u.pathname)) return 'game';
        if (u.origin === window.location.origin && META.test(u.pathname)) {
            return u.pathname.endsWith('/getQQPanoInfo') ? 't' : 'b';
        }
        if (u.pathname.includes('GetMetadata')) return 'g';
        return null;
    }
    function begin(url) {
        checkPage();
        const type = kind(url);
        if (!type) return null;
        const request = { type, page, seq: ++sequence };
        if (type === 'game') {
            gameInfoUrl = new URL(url, window.location.href).href;
            latestGameRequest = request.seq;
            // Suspend old output as soon as a round refresh starts.
            invalidate();
            target = null;
        }
        return request;
    }
    function panoKey(p, id) { return p + ':' + id; }
    // Some next-round transitions do not call getGameInfo. Recheck the known
    // read-only endpoint; never infer a new round from an unrelated pano.
    async function syncRound() {
        checkPage();
        if (!gameInfoUrl || syncing || document.hidden) return;
        const url = gameInfoUrl, activePage = page, stamp = latestGameRequest;
        syncing = true;
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 8000);
        try {
            const response = await nativeFetch(url, { signal: abort.signal, credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) return;
            const data = await response.json();
            checkPage();
            if (activePage !== page || url !== gameInfoUrl || stamp !== latestGameRequest) return;
            const game = data?.success === true ? data.data : null;
            if (!game) return;
            const round = game.rounds?.find(r => r.round === game.currentRound);
            if (target && target.game === game.id && target.round === game.currentRound &&
                target.id === String(round?.panoId) && target.source === round?.source) return;
            consume(begin(url), data);
        } catch (e) {
            if (e.name !== 'AbortError') console.info('[图寻辅助] 题目同步失败，将重试。');
        } finally {
            clearTimeout(timeout);
            syncing = false;
        }
    }
    function useCachedLocation() {
        if (!target) return;
        const item = cache.get(panoKey(target.p, target.id));
        if (!item) return;
        if (location && location.lat === item.lat && location.lng === item.lng && location.str === item.str) return;
        invalidate();
        location = { ...item };
        show({ status: '正在查询地址', round: target.round, id: target.id, coords: `${item.lat}, ${item.lng}` });
        refreshMapMarker();
        timer = setTimeout(update, 500);
    }
    function consume(request, data) {
        checkPage();
        if (!request || request.page !== page) return;
        if (request.type === 'game') {
            if (request.seq !== latestGameRequest) return;
            const game = data?.success === true ? data.data : null;
            const round = game?.rounds?.find(r => r.round === game.currentRound);
            if (!round?.panoId) return;
            const p = { qq_pano: 't', baidu_pano: 'b', google: 'g', google_pano: 'g' }[round.source];
            if (!p) {
                show({ status: `暂未适配街景来源：${round.source}` });
                console.info('[图寻辅助] 当前街景来源尚未验证，暂停查询：', round.source);
                return;
            }
            target = { id: String(round.panoId), p, source: round.source, round: game.currentRound, game: game.id };
            show({ status: '等待匹配的街景数据', round: target.round, id: target.id });
            useCachedLocation();
            return;
        }
        let item;
        if (request.type === 'g') {
            const m = data?.[1]?.[0];
            item = { id: m?.[1]?.[1], lat: m?.[5]?.[0]?.[1]?.[0]?.[2], lng: m?.[5]?.[0]?.[1]?.[0]?.[3], p: 'g', str: m?.[3]?.[2]?.[0]?.[0] ?? '' };
        } else {
            if (data?.success !== true || !data.data) return;
            const d = data.data;
            item = { id: d.pano, lat: d.lat, lng: d.lng, p: request.type, str: '' };
        }
        if (!item.id || typeof item.lat !== 'number' || typeof item.lng !== 'number' ||
            !Number.isFinite(item.lat) || !Number.isFinite(item.lng) || Math.abs(item.lat) > 90 || Math.abs(item.lng) > 180) return;
        item.id = String(item.id);
        if (typeof item.str !== 'string') item.str = '';
        const key = panoKey(item.p, item.id);
        const previous = cache.get(key);
        if (previous && previous.seq > request.seq) return;
        cache.delete(key);
        cache.set(key, { ...item, seq: request.seq });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        if (target && target.p === item.p && target.id === item.id) useCachedLocation();
    }

    // Install hooks before configuration dialogs or page requests.
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        const result = originalOpen.call(this, method, url, ...rest);
        requests.set(this, { url: String(url) });
        return result;
    };
    XMLHttpRequest.prototype.send = function (...args) {
        const info = requests.get(this);
        let request;
        try { request = info && begin(info.url); } catch (e) { console.warn('[图寻辅助] 请求识别失败', e); }
        if (request) {
            const onLoad = () => {
                try {
                    if (this.status < 200 || this.status >= 300) return;
                    const d = this.responseType === 'json' ? this.response :
                        (!this.responseType || this.responseType === 'text') ? JSON.parse(this.responseText) : null;
                    if (d) consume(request, d);
                } catch (e) { console.warn('[图寻辅助] 元数据解析失败', e); }
            };
            this.addEventListener('load', onLoad, { once: true });
            this.addEventListener('loadend', () => this.removeEventListener('load', onLoad), { once: true });
        }
        return originalSend.apply(this, args);
    };
    window.fetch = function (input, init) {
        let request;
        try { request = begin(typeof input === 'string' || input instanceof URL ? String(input) : input.url); }
        catch (e) { console.warn('[图寻辅助] 请求识别失败', e); }
        const promise = nativeFetch(input, init);
        if (request) promise.then(response => {
            if (response.ok) response.clone().json().then(data => consume(request, data))
                .catch(e => console.warn('[图寻辅助] 元数据解析失败', e));
        }, () => {});
        return promise;
    };

    async function json(url, signal) {
        const response = await nativeFetch(url, { signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
    }
    async function address(s, signal) {
        const key = localStorage.getItem('_tx_k');
        if (localStorage.getItem('_tx_s') === '1' && key) {
            const d = await json('https://restapi.amap.com/v3/geocode/regeo?' + new URLSearchParams({ output: 'json', location: `${s.lng},${s.lat}`, key, radius: '100' }), signal);
            if (d.status !== '1') throw new Error(d.info || '高德查询失败');
            return d.regeocode?.formatted_address || '未知地址';
        }
        const d = await json('https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({ format: 'json', lat: s.lat, lon: s.lng, 'accept-language': '' }), signal);
        if (!d.display_name) throw new Error(d.error || '未找到地址');
        const postcode = String(d.address?.postcode ?? '');
        return d.display_name.split(',').map(x => x.trim()).filter(x => x && x !== postcode).join(' · ');
    }
    async function translate(text, signal) {
        if (!text) return '';
        if (translations.has(text)) return translations.get(text);
        // Best-effort Google web translation. Unavailable/limited service leaves
        // the original visible; no claim of an official Cloud Translation SLA.
        const data = await json('https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({
            client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: text
        }), signal);
        if (!Array.isArray(data?.[0])) throw new Error('翻译响应格式异常');
        const result = data[0].map(part => typeof part?.[0] === 'string' ? part[0] : '').join('').trim();
        if (!result) throw new Error('未返回译文');
        translations.set(text, result);
        if (translations.size > 100) translations.delete(translations.keys().next().value);
        return result;
    }
    async function description(s, signal) {
        if (s.p === 'b') return (await json(`https://mapsv0.bdimg.com/?qt=sdata&sid=${encodeURIComponent(s.id)}`, signal)).content?.[0]?.Rname || '';
        if (s.p === 't') {
            const r = await nativeFetch(`https://sv.map.qq.com/sv?svid=${encodeURIComponent(s.id)}&output=json`, { signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return JSON.parse(new TextDecoder('gbk').decode(await r.arrayBuffer()))?.detail?.basic?.append_addr || '';
        }
        return s.str;
    }
    async function update() {
        checkPage();
        if (!target || !location) {
            show({ status: '等待当前题目及匹配的街景数据' });
            console.info('[图寻辅助] 等待当前题目及匹配的街景数据；必要时刷新页面。');
            return;
        }
        controller?.abort();
        const abort = new AbortController();
        controller = abort;
        const token = ++job, version = revision, activePage = page;
        const s = { ...location, round: target.round };
        show({ status: '正在查询地址', round: s.round, id: s.id, coords: `${s.lat}, ${s.lng}`, address: '', detail: '', addressZh: '', detailZh: '', translation: '' });
        const timeout = setTimeout(() => abort.abort(), 12000);
        let translationTimeout;
        const current = () => {
            checkPage();
            return version === revision && token === job && activePage === page;
        };
        try {
            const results = await Promise.allSettled([address(s, abort.signal), description(s, abort.signal)]);
            if (!current()) return;
            clearTimeout(timeout);
            const [a, d] = results;
            const text = a.status === 'fulfilled' ? a.value : `地址查询失败：${a.reason?.message || '网络错误'}`;
            const detail = d.status === 'fulfilled' ? d.value : '';
            const original = a.status === 'fulfilled' ? a.value : '';
            show({ status: a.status === 'fulfilled' ? '已匹配当前题目' : text, address: original, detail,
                addressZh: a.status === 'rejected' ? '地址暂不可用，请稍后刷新' : '',
                translation: autoTranslate() ? '正在自动翻译为简体中文…' : '自动翻译已关闭，原文仍会自动更新。' });
            console.log(`[图寻辅助] 第 ${s.round} 题起点：${text}${detail ? '（' + detail + '）' : ''}\npano: ${s.id}\n坐标: ${s.lat}, ${s.lng}`);
            if (!autoTranslate()) return;
            translationTimeout = setTimeout(() => abort.abort(), 8000);
            const translated = await Promise.allSettled([translate(original, abort.signal), translate(detail, abort.signal)]);
            if (!current()) return;
            const [ta, td] = translated;
            const failed = translated.some(r => r.status === 'rejected');
            show({ addressZh: original ? (ta.status === 'fulfilled' ? ta.value : '翻译暂不可用，请参考下方原文') : '地址暂不可用，请稍后刷新',
                detailZh: td.status === 'fulfilled' ? td.value : '翻译暂不可用，请参考下方原文',
                translation: failed ? 'Google 翻译连接失败或受限；已保留原文，可点击刷新重试。' :
                    (original || detail ? 'Google 自动翻译 · 地名请结合原文核对' : '暂无可翻译的文本') });
        } finally {
            clearTimeout(timeout);
            clearTimeout(translationTimeout);
            if (controller === abort) controller = null;
        }
    }
    function configure() {
        if (!localStorage.getItem('_tx_s')) {
            localStorage.setItem('_tx_s', confirm('选择地址查询服务：\n确定：高德（需要 Web 服务 Key）\n取消：OSM') ? '1' : '0');
        }
        if (localStorage.getItem('_tx_s') === '1' && !localStorage.getItem('_tx_k')) {
            const key = prompt('请输入高德 Web 服务 Key（32 位），取消则使用 OSM：', '')?.trim();
            if (key && /^[a-zA-Z0-9]{32}$/.test(key)) localStorage.setItem('_tx_k', key);
            else localStorage.setItem('_tx_s', '0');
        }
    }
    function resetSource() {
        controller?.abort();
        job++;
        localStorage.removeItem('_tx_s');
        localStorage.removeItem('_tx_k');
        configure();
        if (location) { clearTimeout(timer); timer = setTimeout(update, 500); }
    }
    document.addEventListener('keydown', e => {
        if (panel && e.composedPath().includes(panel.host)) return;
        if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName) || e.target?.isContentEditable) return;
        if (e.key.toLowerCase() === 'i') { clearTimeout(timer); update(); }
        if (e.key.toLowerCase() === 'r') resetSource();
    }, true);
    setInterval(checkPage, 250);
    setInterval(syncRound, 2000);
    setInterval(refreshMapMarker, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncRound(); });
    const ready = () => { mountPanel(); configure(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
})();
