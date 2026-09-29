// 再訪問ノート — 個人の再訪問を iPhone の中だけで管理する。
// 記録は Store（IndexedDB）に置き、どこにも送らない。外へ出るのは地図の画像（地理院タイル）と、
// 位置を選んだときの住所の問い合わせ（座標だけ）、住所検索の語だけ。
(() => {
  'use strict';

  const APP_VERSION = '0.1.0';
  const STAGES = {
    interest: { label: '関心あり', color: '#d9822b' },
    rv: { label: '再訪問', color: '#2f7fc1' },
    study: { label: '聖書レッスン', color: '#2e9e5b' },
  };
  const RESULTS = { met: '会えた', absent: '留守' };
  const GAVE_CHIPS = ['冊子', '雑誌', 'パンフレット', 'トラクト', 'コンタクトカード', '動画', '聖句'];
  const LANGS = ['日本語', '英語', '中国語', '韓国語', 'ベトナム語', 'タガログ語', 'ネパール語', 'ポルトガル語', 'スペイン語', 'タイ語', 'インドネシア語', 'ミャンマー語'];
  const DEFAULT_CENTER = [33.8834, 130.8752]; // 小倉。記録も現在地も無いときだけ使う
  const BACKUP_REMIND_DAYS = 14;
  const TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
  const LEAFLET_PREFIX = '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>';
  const TILE_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

  const S = {
    people: [], visits: [], meta: {},
    byPerson: new Map(),            // personId → 訪問（新しい順）
    filter: { cong: '', q: '', showArchived: false },
    view: 'list', personId: null, focusId: null,
  };

  // ---------------------------------------------------------------- 小道具
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const todayStr = () => stamp().slice(0, 10);
  const stampSec = () => stamp() + ':' + pad(new Date().getSeconds());
  const addDays = (s, n) => { const d = new Date(s.length > 10 ? s : s + 'T00:00'); d.setDate(d.getDate() + n); return stamp(d); };
  const WD = '日月火水木金土';
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  function fmtDate(s) {
    const d = new Date(s.slice(0, 10) + 'T00:00');
    const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}/` : '';
    return `${y}${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  }
  const fmtDateTime = s => (s.length > 10 ? `${fmtDate(s)} ${s.slice(11, 16)}` : fmtDate(s));
  function relDay(s) {
    const t = todayStr(), d = s.slice(0, 10), time = s.length > 10 ? ' ' + s.slice(11, 16) : '';
    if (d === t) return '今日' + time;
    if (d === addDays(t, 1).slice(0, 10)) return '明日' + time;
    if (d === addDays(t, -1).slice(0, 10)) return '昨日' + time;
    return fmtDateTime(s);
  }
  const daysSince = s => Math.floor((new Date(todayStr() + 'T00:00') - new Date(s.slice(0, 10) + 'T00:00')) / 864e5);

  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動く */ } };

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
  }

  // ---------------------------------------------------------------- データ
  function reindex() {
    S.byPerson = new Map();
    for (const v of S.visits) {
      if (!S.byPerson.has(v.personId)) S.byPerson.set(v.personId, []);
      S.byPerson.get(v.personId).push(v);
    }
    const key = v => v.at + '|' + (v.createdAt || '');
    for (const arr of S.byPerson.values()) arr.sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
  }
  const visitsOf = id => S.byPerson.get(id) || [];
  const lastVisit = id => visitsOf(id)[0] || null;
  const personById = id => S.people.find(p => p.id === id) || null;
  const congregations = () => [...new Set(S.people.map(p => (p.congregation || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  const placeLine = p => [p.placeName, p.room].filter(Boolean).join(' ');

  async function reload() {
    const d = await Store.loadAll();
    S.people = d.people;
    S.visits = d.visits;
    S.meta = d.meta;
    reindex();
  }

  // 端末の保存を「消されにくい」扱いにしてもらう（Safari 17 以降。断られても動作は同じ）
  let persistAsked = false;
  function askPersist() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  async function savePerson(p) {
    p.updatedAt = stampSec();
    await Store.putPerson(p);
    const i = S.people.findIndex(x => x.id === p.id);
    if (i >= 0) S.people[i] = p; else S.people.push(p);
    askPersist();
  }
  async function savePersonAndVisit(p, v) {
    const now = stampSec();
    p.updatedAt = now;
    v.updatedAt = now;
    await Store.putPersonAndVisit(p, v);
    const i = S.people.findIndex(x => x.id === p.id);
    if (i >= 0) S.people[i] = p; else S.people.push(p);
    const j = S.visits.findIndex(x => x.id === v.id);
    if (j >= 0) S.visits[j] = v; else S.visits.push(v);
    reindex();
    askPersist();
  }

  // ---------------------------------------------------------------- 画面の切り替え
  function route() {
    const h = location.hash || '#/list';
    const m = h.match(/^#\/p\/(.+)$/);
    if (m) show('person', decodeURIComponent(m[1]));
    else if (h === '#/map') show('map');
    else if (h === '#/settings') show('settings');
    else show('list');
  }

  function show(view, arg) {
    S.view = view;
    if (view === 'person') S.personId = arg;
    for (const el of $$('.view')) el.classList.toggle('active', el.id === 'view-' + view);
    const tab = view === 'person' ? (S.personFrom || 'list') : view;
    for (const b of $$('#tabs [data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
    render();
  }

  function render() {
    if (S.view === 'list') renderList();
    else if (S.view === 'map') renderMap();
    else if (S.view === 'person') renderPerson();
    else if (S.view === 'settings') renderSettings();
  }

  function goPerson(id) {
    S.personFrom = S.view === 'person' ? S.personFrom : S.view;
    location.hash = '#/p/' + encodeURIComponent(id);
  }

  // ---------------------------------------------------------------- 一覧
  function congOptions(sel) {
    const list = congregations();
    if (S.filter.cong && !list.includes(S.filter.cong)) S.filter.cong = '';
    sel.innerHTML = `<option value="">すべての会衆</option>` +
      list.map(c => `<option value="${esc(c)}"${c === S.filter.cong ? ' selected' : ''}>${esc(c)}</option>`).join('');
    sel.hidden = list.length < 2 && !S.filter.cong;
  }

  function filtered() {
    const q = S.filter.q.trim().toLowerCase();
    return S.people.filter(p => {
      if (S.filter.cong && (p.congregation || '').trim() !== S.filter.cong) return false;
      if (!q) return true;
      return [p.name, p.placeName, p.room, p.address, p.congregation, p.language, p.note, p.nextTopic]
        .some(x => (x || '').toLowerCase().includes(q));
    });
  }

  function backupNotice() {
    if (!S.people.length) return '';
    const last = S.meta.lastBackupAt;
    if (last && daysSince(last) < BACKUP_REMIND_DAYS) return '';
    const msg = last ? `最後のバックアップから ${daysSince(last)} 日たちました。` : 'まだバックアップがありません。';
    return `<div class="notice"><span>💾 ${msg}記録はこの iPhone の中だけにあります。</span>
      <button class="link" data-nav="#/settings">作る</button></div>`;
  }

  function renderList() {
    const el = $('#view-list');
    if (!el.dataset.built) {
      el.dataset.built = '1';
      el.innerHTML = `
        <div class="vhead"><h1>再訪問ノート</h1><span class="count" id="list-count"></span></div>
        <div class="toolbar">
          <input type="search" id="list-q" placeholder="名前・場所・メモで探す" enterkeyhint="search">
          <select id="list-cong" aria-label="会衆で絞る"></select>
        </div>
        <div id="list-body"></div>`;
      $('#list-q', el).addEventListener('input', e => { S.filter.q = e.target.value; renderListBody(); });
      $('#list-cong', el).addEventListener('change', e => { S.filter.cong = e.target.value; renderListBody(); });
    }
    congOptions($('#list-cong', el));
    renderListBody();
  }

  function row(p) {
    const st = STAGES[p.stage] || STAGES.interest;
    const lv = lastVisit(p.id);
    const sub = [placeLine(p), p.congregation].filter(Boolean).join(' · ');
    const overdue = p.nextAt && p.nextAt.slice(0, 10) < todayStr();
    return `<button class="row${p.archived ? ' archived' : ''}" data-open="${esc(p.id)}">
      <span class="bar" style="background:${p.archived ? 'var(--muted)' : st.color}"></span>
      <span class="main">
        <span class="name">${esc(p.name)}</span>
        ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
        ${p.nextTopic ? `<span class="topic">次に: ${esc(p.nextTopic)}</span>` : ''}
      </span>
      <span class="side">
        <span class="badge" style="--c:${st.color}">${st.label}</span>
        ${p.nextAt ? `<span class="next${overdue ? ' over' : ''}">${esc(relDay(p.nextAt))}</span>` : ''}
        <span class="last">${lv ? `前回 ${esc(fmtDate(lv.at))}` : '訪問の記録なし'}</span>
      </span>
    </button>`;
  }

  function renderListBody() {
    const body = $('#list-body');
    const all = filtered();
    const active = all.filter(p => !p.archived);
    const archived = all.filter(p => p.archived);
    $('#list-count').textContent = `${S.people.filter(p => !p.archived).length}人`;

    if (!S.people.length) {
      body.innerHTML = `<div class="empty">
        <p class="big">まだ誰も登録されていません</p>
        <p>話した相手を、下の <b>＋</b> から登録します。<br>その場で「今日会って話した」も一緒に残せます。</p></div>`;
      return;
    }

    const t = todayStr(), wk = addDays(t, 7).slice(0, 10);
    const g = { over: [], today: [], week: [], later: [], none: [] };
    for (const p of active) {
      const d = p.nextAt ? p.nextAt.slice(0, 10) : '';
      if (!d) g.none.push(p);
      else if (d < t) g.over.push(p);
      else if (d === t) g.today.push(p);
      else if (d <= wk) g.week.push(p);
      else g.later.push(p);
    }
    const byNext = (a, b) => (a.nextAt > b.nextAt ? 1 : -1);
    ['over', 'today', 'week', 'later'].forEach(k => g[k].sort(byNext));
    // 約束の無い人は、前の訪問が古い順（放っておいている人が上に来る）
    const lastAt = p => (lastVisit(p.id) || {}).at || p.createdAt || '';
    g.none.sort((a, b) => (lastAt(a) > lastAt(b) ? 1 : -1));

    const sec = (title, list, cls = '') => (list.length
      ? `<section class="group ${cls}"><h2>${title}<span>${list.length}</span></h2>${list.map(row).join('')}</section>` : '');
    let html = backupNotice();
    html += sec('約束の日が過ぎた', g.over, 'warn');
    html += sec('今日', g.today, 'today');
    html += sec('7日以内', g.week);
    html += sec('その先', g.later);
    html += sec('約束なし（前の訪問が古い順）', g.none);
    if (!active.length) html += `<p class="empty">条件に合う人はいません</p>`;
    if (archived.length) {
      html += S.filter.showArchived
        ? sec('訪問を終えた人', archived, 'done') + `<button class="link center" data-act="hide-archived">終えた人を隠す</button>`
        : `<button class="link center" data-act="show-archived">訪問を終えた人（${archived.length}人）を表示</button>`;
    }
    body.innerHTML = html;
  }

  // ---------------------------------------------------------------- 相手の詳細
  function renderPerson() {
    const el = $('#view-person');
    const p = personById(S.personId);
    if (!p) { el.innerHTML = `<div class="vhead"><button class="back" data-act="back">‹ 戻る</button></div><p class="empty">見つかりません</p>`; return; }
    const st = STAGES[p.stage] || STAGES.interest;
    const vs = visitsOf(p.id);
    const hasLoc = Number.isFinite(p.lat) && Number.isFinite(p.lng);
    const meta = [p.congregation, p.language, p.bestTime && `都合: ${p.bestTime}`].filter(Boolean);
    el.innerHTML = `
      <div class="vhead"><button class="back" data-act="back">‹ ${S.personFrom === 'map' ? '地図' : '一覧'}</button>
        <span class="grow"></span><button class="link" data-act="edit-person">編集</button></div>
      <div class="person">
        <h1>${esc(p.name)}</h1>
        <div class="tags"><span class="badge" style="--c:${p.archived ? 'var(--muted)' : st.color}">${p.archived ? '訪問を終えた' : st.label}</span>
          ${meta.map(m => `<span class="tag">${esc(m)}</span>`).join('')}</div>
        ${placeLine(p) || p.address ? `<p class="place">📍 ${esc(placeLine(p))}${placeLine(p) && p.address ? '<br>' : ''}<span class="addr">${esc(p.address || '')}</span></p>` : ''}
        <div class="actions">
          ${hasLoc ? `<button data-act="show-on-map">🗺 地図で見る</button>
          <a class="btn" href="https://maps.apple.com/?daddr=${p.lat},${p.lng}&dirflg=w" target="_blank" rel="noopener">🚶 経路</a>` : `<button data-act="edit-person">📍 位置を登録</button>`}
          ${p.contact ? `<span class="contact">☎ ${esc(p.contact)}</span>` : ''}
        </div>
        ${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}

        <div class="card next-card">
          <h2>次の約束</h2>
          ${p.nextAt ? `<p class="when${p.nextAt.slice(0, 10) < todayStr() ? ' over' : ''}">${esc(relDay(p.nextAt))}</p>` : '<p class="muted">決まっていません</p>'}
          ${p.nextTopic ? `<p>次に話すこと: ${esc(p.nextTopic)}</p>` : ''}
          ${p.nextAt ? `<button class="small" data-act="ics">📅 iPhone のカレンダーに入れる</button>` : ''}
        </div>

        <button class="primary block big" data-act="record">✍ 訪問を記録する</button>

        <h2 class="sec">訪問の記録 <span>${vs.length}回</span></h2>
        ${vs.length ? vs.map(v => `
          <div class="visit" data-visit="${esc(v.id)}">
            <div class="vtop"><b>${esc(fmtDateTime(v.at))}</b><span class="vres ${v.result}">${RESULTS[v.result] || ''}</span>
              <button class="link" data-act="edit-visit" data-id="${esc(v.id)}">直す</button></div>
            ${v.talked ? `<p>${esc(v.talked)}</p>` : ''}
            ${v.gave ? `<p class="gave">渡した: ${esc(v.gave)}</p>` : ''}
            ${v.nextTopic ? `<p class="muted">次に: ${esc(v.nextTopic)}</p>` : ''}
          </div>`).join('') : '<p class="muted">まだ記録がありません</p>'}

        <div class="foot">
          <button data-act="handover">📋 引き継ぎ文を作る</button>
          <button data-act="archive">${p.archived ? '↩ 訪問を再開する' : '訪問を終える（一覧の下へ）'}</button>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- 地図
  let map = null, pinLayer = null, meLayer = null, mapFitted = false;

  function ensureMap() {
    if (map) return;
    const el = $('#view-map');
    el.innerHTML = `
      <div id="map"></div>
      <div class="map-top">
        <select id="map-cong" aria-label="会衆で絞る"></select>
        <span class="grow"></span>
        <button id="map-all" title="全員が入るように">全員</button>
        <button id="map-me" title="現在地">📍</button>
      </div>
      <div class="map-note" id="map-note" hidden></div>`;
    const saved = (() => { try { return JSON.parse(lsGet('mapView')); } catch (e) { return null; } })();
    map = L.map('map', { zoomControl: false, attributionControl: true })
      .setView(saved ? saved.c : DEFAULT_CENTER, saved ? saved.z : 15);
    L.tileLayer(TILE_URL, { maxZoom: 19, maxNativeZoom: 18, minZoom: 5, attribution: TILE_ATTR, crossOrigin: true }).addTo(map);
    map.attributionControl.setPrefix(LEAFLET_PREFIX);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    const labels = () => $('#map').classList.toggle('show-labels', map.getZoom() >= 16);
    map.on('zoomend', labels);
    labels();
    map.on('moveend', () => lsSet('mapView', JSON.stringify({ c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() })));
    $('#map-cong').addEventListener('change', e => { S.filter.cong = e.target.value; drawPins(); fitAll(); });
    $('#map-all').addEventListener('click', fitAll);
    $('#map-me').addEventListener('click', locateMe);
    mapFitted = !!saved;
  }

  function mapPeople() {
    return S.people.filter(p => !p.archived && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
      (!S.filter.cong || (p.congregation || '').trim() === S.filter.cong));
  }

  function drawPins() {
    pinLayer.clearLayers();
    const list = mapPeople();
    for (const p of list) {
      const st = STAGES[p.stage] || STAGES.interest;
      const m = L.circleMarker([p.lat, p.lng], { radius: 9, color: '#fff', weight: 2, fillColor: st.color, fillOpacity: 1 });
      m.bindTooltip(esc(p.name), { permanent: true, direction: 'right', offset: [8, 0], className: 'pin-label' });
      const lv = lastVisit(p.id);
      m.bindPopup(`<div class="pop"><b>${esc(p.name)}</b>
        ${placeLine(p) ? `<div>${esc(placeLine(p))}</div>` : ''}
        <div class="muted">${p.nextAt ? '約束 ' + esc(relDay(p.nextAt)) : lv ? '前回 ' + esc(fmtDate(lv.at)) : ''}</div>
        <button data-open="${esc(p.id)}">開く</button></div>`);
      m.personId = p.id;
      m.addTo(pinLayer);
    }
    const noLoc = S.people.filter(p => !p.archived && !(Number.isFinite(p.lat) && Number.isFinite(p.lng)) &&
      (!S.filter.cong || (p.congregation || '').trim() === S.filter.cong)).length;
    const note = $('#map-note');
    note.hidden = !noLoc;
    note.textContent = `位置が未登録: ${noLoc}人`;
  }

  function fitAll() {
    const list = mapPeople();
    if (!list.length) return;
    if (list.length === 1) map.setView([list[0].lat, list[0].lng], 17);
    else map.fitBounds(L.latLngBounds(list.map(p => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 17 });
  }

  function renderMap() {
    ensureMap();
    congOptions($('#map-cong'));
    drawPins();
    setTimeout(() => {
      map.invalidateSize();
      if (S.focusId) {
        const p = personById(S.focusId);
        S.focusId = null;
        if (p && Number.isFinite(p.lat)) {
          map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17));
          pinLayer.eachLayer(l => { if (l.personId === p.id) l.openPopup(); });
        }
      } else if (!mapFitted) {
        mapFitted = true;
        if (mapPeople().length) fitAll(); else locateMe();
      }
    }, 0);
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('この端末では現在地が使えません')); return; }
      navigator.geolocation.getCurrentPosition(
        pos => resolve(pos.coords),
        err => reject(new Error(err.code === 1
          ? '位置情報が許可されていません（設定 → プライバシー → 位置情報サービス → Safari の Web サイト）'
          : '現在地が取れませんでした')),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
    });
  }

  async function locateMe() {
    try {
      const c = await getPosition();
      if (!meLayer) meLayer = L.layerGroup().addTo(map);
      meLayer.clearLayers();
      L.circle([c.latitude, c.longitude], { radius: c.accuracy, color: '#3478f6', weight: 1, fillOpacity: 0.08 }).addTo(meLayer);
      L.circleMarker([c.latitude, c.longitude], { radius: 7, color: '#fff', weight: 2, fillColor: '#3478f6', fillOpacity: 1 }).addTo(meLayer);
      map.setView([c.latitude, c.longitude], Math.max(map.getZoom(), 17));
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- 住所（国土地理院）
  let muniTable = null;
  async function reverseGeocode(lat, lng) {
    try {
      if (!muniTable) muniTable = await (await fetch('muni.json')).json();
      const r = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`);
      const j = await r.json();
      if (!j || !j.results) return '';
      const town = j.results.lv01Nm && j.results.lv01Nm !== '－' ? j.results.lv01Nm : '';
      return (muniTable[String(+j.results.muniCd)] || '') + town;
    } catch (e) { return ''; }
  }
  async function searchAddress(q) {
    const r = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    return (j || []).slice(0, 8).map(x => ({ title: x.properties.title, lng: x.geometry.coordinates[0], lat: x.geometry.coordinates[1] }));
  }

  // ---------------------------------------------------------------- シート（全画面の入力欄）
  function openSheet(html, cls = '') {
    const root = document.createElement('div');
    root.className = 'sheet ' + cls;
    root.innerHTML = html;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('open'));
    const close = () => { root.classList.remove('open'); setTimeout(() => root.remove(), 220); };
    return { root, close };
  }

  function confirmSheet(message, okLabel = 'はい', danger = false) {
    return new Promise(resolve => {
      const { root, close } = openSheet(`<div class="dialog"><p>${message}</p>
        <div class="row2"><button data-v="0">やめる</button><button data-v="1" class="${danger ? 'danger' : 'primary'}">${esc(okLabel)}</button></div></div>`, 'modal');
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-v]');
        if (!b && e.target !== root) return;
        close();
        resolve(!!b && b.dataset.v === '1');
      });
    });
  }

  function passwordSheet(title, message, twice) {
    return new Promise(resolve => {
      const { root, close } = openSheet(`<form class="dialog"><h3>${esc(title)}</h3><p>${message}</p>
        <input type="password" name="p1" autocomplete="new-password" placeholder="パスワード">
        ${twice ? '<input type="password" name="p2" autocomplete="new-password" placeholder="もう一度">' : ''}
        <p class="err" hidden></p>
        <div class="row2"><button type="button" data-v="cancel">やめる</button><button class="primary">決定</button></div></form>`, 'modal');
      const f = $('form', root);
      f.addEventListener('submit', e => {
        e.preventDefault();
        const p1 = f.p1.value;
        if (twice && p1 !== f.p2.value) { const er = $('.err', f); er.hidden = false; er.textContent = '2つが一致しません'; return; }
        close();
        resolve(p1);
      });
      $('[data-v="cancel"]', f).addEventListener('click', () => { close(); resolve(null); });
      setTimeout(() => f.p1.focus(), 250);
    });
  }

  function chipsHtml(name) {
    return `<div class="chips" data-for="${name}">${GAVE_CHIPS.map(c => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
  }
  function wireChips(form) {
    form.addEventListener('click', e => {
      const b = e.target.closest('[data-chip]');
      if (!b) return;
      const input = form.elements[b.parentElement.dataset.for];
      const cur = input.value.trim();
      input.value = cur ? `${cur}、${b.dataset.chip}` : b.dataset.chip;
    });
  }
  function nextPresetHtml() {
    return `<div class="chips"><button type="button" data-next="1">明日</button><button type="button" data-next="7">1週間後</button>
      <button type="button" data-next="14">2週間後</button><button type="button" data-next="clear">約束なし</button></div>`;
  }
  // 「1週間後」は訪問の日時から数える（同じ曜日・同じ時刻に行くことが多い）
  function wireNextPresets(form, baseField) {
    form.addEventListener('click', e => {
      const b = e.target.closest('[data-next]');
      if (!b) return;
      if (b.dataset.next === 'clear') { form.nextAt.value = ''; return; }
      const base = (baseField && form[baseField] && form[baseField].value) || stamp();
      const d = addDays(base, +b.dataset.next);
      form.nextAt.value = d.slice(0, 14) + (d.slice(14, 16) < '30' ? '00' : '30');
    });
  }

  function datalists() {
    return `<datalist id="dl-cong">${congregations().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="dl-lang">${LANGS.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`;
  }

  function stageRadios(cur) {
    return `<div class="seg">${Object.entries(STAGES).map(([k, s]) =>
      `<label><input type="radio" name="stage" value="${k}"${k === cur ? ' checked' : ''}><span style="--c:${s.color}">${s.label}</span></label>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------- 相手の登録・編集
  function openPersonForm(existing) {
    const isNew = !existing;
    const p = existing ? { ...existing } : {
      id: uid(), name: '', stage: 'interest', congregation: S.meta.lastCongregation || '',
      createdAt: stampSec(), archived: false,
    };
    const { root, close } = openSheet(`
      <div class="sheet-head"><button data-act="cancel">キャンセル</button><h2>${isNew ? '新しい相手' : '相手を編集'}</h2><button data-act="save" class="primary">保存</button></div>
      <form class="sheet-body" autocomplete="off">
        ${datalists()}
        <label>呼び名 <em>必須</em><input name="name" value="${esc(p.name)}" placeholder="例: 花屋の店主（60代の男性）"></label>
        <p class="hint">本名が分からなくても、あとで見て思い出せる呼び方で。</p>
        <div class="field"><span class="lbl">段階</span>${stageRadios(p.stage)}</div>
        <label>場所の名前（店・建物）<input name="placeName" value="${esc(p.placeName || '')}" placeholder="例: ○○フラワー"></label>
        <label>部屋・階<input name="room" value="${esc(p.room || '')}" placeholder="例: 2F / 305号"></label>
        <div class="field"><span class="lbl">地図の位置</span>
          <div class="loc"><span class="locstate"></span>
            <button type="button" data-act="here">📍 今いる場所</button><button type="button" data-act="pick">🗺 地図で選ぶ</button></div>
          <p class="hint addr-hint" hidden></p></div>
        <label>住所<input name="address" value="${esc(p.address || '')}" placeholder="位置を決めると町名まで入ります"></label>
        <label>会衆<input name="congregation" list="dl-cong" value="${esc(p.congregation || '')}" placeholder="例: 城内"></label>
        <label>言語<input name="language" list="dl-lang" value="${esc(p.language || '')}"></label>
        <label>都合のよい時間<input name="bestTime" value="${esc(p.bestTime || '')}" placeholder="例: 平日の14時ごろ（店が空く）"></label>
        <label>連絡先<input name="contact" value="${esc(p.contact || '')}" placeholder="本人の了承があるときだけ"></label>
        <label>メモ（人柄・関心・家族など）<textarea name="note" rows="3">${esc(p.note || '')}</textarea></label>
        ${isNew ? `
        <fieldset class="first">
          <label class="check"><input type="checkbox" name="firstVisit" checked> 今日会って話した（最初の訪問として記録）</label>
          <div class="first-body">
            <label>話したこと<textarea name="talked" rows="3" placeholder="例: 家族の健康を心配。詩編 37:29 を読んだ"></textarea></label>
            <label>渡したもの<input name="gave"></label>${chipsHtml('gave')}
          </div>
        </fieldset>` : ''}
        <label>次に話すこと<input name="nextTopic" value="${esc(p.nextTopic || '')}"></label>
        <label>次の約束<input type="datetime-local" name="nextAt" value="${esc(p.nextAt || '')}"></label>${nextPresetHtml()}
        <button class="primary block">保存</button>
        ${isNew ? '' : '<button type="button" class="danger block" data-act="delete">この人を削除する</button>'}
      </form>`, 'full');
    const f = $('form', root);
    wireChips(f);
    wireNextPresets(f, null);

    const locState = () => {
      const has = Number.isFinite(p.lat) && Number.isFinite(p.lng);
      $('.locstate', root).textContent = has ? '✔ 登録済み' : '未登録';
      $('.locstate', root).classList.toggle('ok', has);
    };
    locState();
    const setLoc = async (lat, lng) => {
      p.lat = lat; p.lng = lng; locState();
      const addr = await reverseGeocode(lat, lng);
      if (!addr) return;
      if (!f.address.value.trim()) f.address.value = addr;
      else if (!f.address.value.startsWith(addr)) {
        const h = $('.addr-hint', root);
        h.hidden = false;
        h.innerHTML = `この位置の住所: ${esc(addr)} <button type="button" class="link" data-act="use-addr">住所欄に入れる</button>`;
        h.dataset.addr = addr;
      }
    };

    if (isNew) {
      const tog = () => $('.first-body', root).classList.toggle('off', !f.firstVisit.checked);
      f.firstVisit.addEventListener('change', tog);
    }

    const save = async () => {
      const name = f.elements.name.value.trim();
      if (!name) { toast('呼び名を入れてください'); f.elements.name.focus(); return; }
      Object.assign(p, {
        name, stage: f.stage.value || 'interest',
        placeName: f.placeName.value.trim(), room: f.room.value.trim(), address: f.address.value.trim(),
        congregation: f.congregation.value.trim(), language: f.language.value.trim(),
        bestTime: f.bestTime.value.trim(), contact: f.contact.value.trim(), note: f.note.value.trim(),
        nextTopic: f.nextTopic.value.trim(), nextAt: f.nextAt.value || '',
      });
      try {
        if (isNew && f.firstVisit.checked) {
          const v = { id: uid(), personId: p.id, at: stamp(), result: 'met',
            talked: f.talked.value.trim(), gave: f.gave.value.trim(), nextTopic: p.nextTopic, createdAt: stampSec() };
          await savePersonAndVisit(p, v);
        } else {
          await savePerson(p);
        }
        if (p.congregation && p.congregation !== S.meta.lastCongregation) {
          S.meta.lastCongregation = p.congregation;
          Store.setMeta('lastCongregation', p.congregation);
        }
      } catch (e) { toast('保存できませんでした: ' + e.message); return; }
      close();
      toast('保存しました');
      if (isNew) goPerson(p.id); else render();
    };

    f.addEventListener('submit', e => { e.preventDefault(); save(); });
    root.addEventListener('click', async e => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const act = a.dataset.act;
      if (act === 'cancel') close();
      else if (act === 'save') save();
      else if (act === 'here') {
        a.disabled = true;
        try { const c = await getPosition(); await setLoc(c.latitude, c.longitude); toast('今いる場所を登録しました'); }
        catch (err) { toast(err.message); }
        a.disabled = false;
      } else if (act === 'pick') {
        const start = Number.isFinite(p.lat) ? [p.lat, p.lng] : null;
        const r = await openPicker(start, f.address.value.trim());
        if (r) await setLoc(r.lat, r.lng);
      } else if (act === 'use-addr') {
        const h = $('.addr-hint', root);
        f.address.value = h.dataset.addr;
        h.hidden = true;
      } else if (act === 'delete') {
        const n = visitsOf(p.id).length;
        if (!await confirmSheet(`「${esc(p.name)}」と訪問の記録 ${n}件を削除します。元に戻せません。<br>訪問をやめるだけなら「訪問を終える」を使うと、記録は残ります。`, '削除する', true)) return;
        await Store.deletePerson(p.id);
        S.people = S.people.filter(x => x.id !== p.id);
        S.visits = S.visits.filter(v => v.personId !== p.id);
        reindex();
        close();
        toast('削除しました');
        location.hash = '#/' + (S.personFrom || 'list');
      }
    });
    if (isNew) setTimeout(() => f.elements.name.focus(), 250);
  }

  // ---------------------------------------------------------------- 位置を選ぶ（十字に合わせる）
  function openPicker(start, query) {
    return new Promise(resolve => {
      const { root, close } = openSheet(`
        <div class="sheet-head"><button data-act="cancel">キャンセル</button><h2>位置を選ぶ</h2><button data-act="ok" class="primary">ここに決める</button></div>
        <form class="picker-search"><input type="search" name="q" value="${esc(query || '')}" placeholder="住所や地名で探す" enterkeyhint="search"><button>探す</button></form>
        <div class="picker-results" hidden></div>
        <div class="picker-map"><div id="pickmap"></div><div class="cross"></div>
          <button type="button" class="picker-me" data-act="me">📍</button></div>
        <p class="picker-hint">地図を動かして、十字を建物の入口に合わせます</p>`, 'full picker');
      const saved = (() => { try { return JSON.parse(lsGet('mapView')); } catch (e) { return null; } })();
      const pm = L.map($('#pickmap', root), { zoomControl: false })
        .setView(start || (saved ? saved.c : DEFAULT_CENTER), start ? 18 : 17);
      L.tileLayer(TILE_URL, { maxZoom: 19, maxNativeZoom: 18, minZoom: 5, attribution: TILE_ATTR, crossOrigin: true }).addTo(pm);
      pm.attributionControl.setPrefix(LEAFLET_PREFIX);
      for (const p of S.people) {
        if (Number.isFinite(p.lat) && !p.archived) L.circleMarker([p.lat, p.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#999', fillOpacity: 1 }).addTo(pm);
      }
      setTimeout(() => pm.invalidateSize(), 250);
      const done = v => { pm.remove(); close(); resolve(v); };
      const results = $('.picker-results', root);
      $('.picker-search', root).addEventListener('submit', async e => {
        e.preventDefault();
        const q = e.target.q.value.trim();
        if (!q) return;
        results.hidden = false;
        results.innerHTML = '<p class="muted">探しています…</p>';
        try {
          const list = await searchAddress(q);
          results.innerHTML = list.length
            ? list.map((r, i) => `<button type="button" data-i="${i}">${esc(r.title)}</button>`).join('')
            : '<p class="muted">見つかりません。町名から入れてみてください</p>';
          results.onclick = ev => {
            const b = ev.target.closest('[data-i]');
            if (!b) return;
            const r = list[+b.dataset.i];
            pm.setView([r.lat, r.lng], 18);
            results.hidden = true;
          };
        } catch (err) { results.innerHTML = '<p class="muted">検索できませんでした（電波を確認）</p>'; }
      });
      root.addEventListener('click', async e => {
        const a = e.target.closest('[data-act]');
        if (!a) return;
        if (a.dataset.act === 'cancel') done(null);
        else if (a.dataset.act === 'ok') { const c = pm.getCenter(); done({ lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6) }); }
        else if (a.dataset.act === 'me') {
          try { const c = await getPosition(); pm.setView([c.latitude, c.longitude], 18); } catch (err) { toast(err.message); }
        }
      });
    });
  }

  // ---------------------------------------------------------------- 訪問の記録
  function openVisitForm(p, existing) {
    const isNew = !existing;
    const v = existing ? { ...existing } : { id: uid(), personId: p.id, at: stamp(), result: 'met', createdAt: stampSec() };
    // 約束がこの訪問より後なら残す（留守で出直すときなど）。過ぎた約束は空にして出す
    const keepNext = p.nextAt && p.nextAt > v.at ? p.nextAt : '';
    const { root, close } = openSheet(`
      <div class="sheet-head"><button data-act="cancel">キャンセル</button><h2>${isNew ? '訪問を記録' : '記録を直す'}</h2><button data-act="save" class="primary">保存</button></div>
      <form class="sheet-body" autocomplete="off">
        <p class="who">${esc(p.name)}${placeLine(p) ? ` <span class="muted">${esc(placeLine(p))}</span>` : ''}</p>
        <label>日時<input type="datetime-local" name="at" value="${esc(v.at)}"></label>
        <div class="seg res">${Object.entries(RESULTS).map(([k, l]) =>
          `<label><input type="radio" name="result" value="${k}"${k === v.result ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <label>話したこと・様子<textarea name="talked" rows="4">${esc(v.talked || '')}</textarea></label>
        <label>渡したもの<input name="gave" value="${esc(v.gave || '')}"></label>${chipsHtml('gave')}
        <label>次に話すこと<input name="nextTopic" value="${esc(isNew ? (p.nextTopic || '') : (v.nextTopic || ''))}"></label>
        ${isNew ? `
          <label>次の約束<input type="datetime-local" name="nextAt" value="${esc(keepNext)}"></label>${nextPresetHtml()}
          <div class="field"><span class="lbl">段階</span>${stageRadios(p.stage)}</div>` : ''}
        <button class="primary block">保存</button>
        ${isNew ? '' : '<button type="button" class="danger block" data-act="delete">この記録を消す</button>'}
      </form>`, 'full');
    const f = $('form', root);
    wireChips(f);
    if (isNew) wireNextPresets(f, 'at');

    const save = async () => {
      if (!f.at.value) { toast('日時を入れてください'); return; }
      Object.assign(v, { at: f.at.value, result: f.result.value, talked: f.talked.value.trim(),
        gave: f.gave.value.trim(), nextTopic: f.nextTopic.value.trim() });
      const np = { ...p };
      if (isNew) {
        np.nextAt = f.nextAt.value || '';
        np.nextTopic = v.nextTopic;
        np.stage = f.stage.value || np.stage;
        if (np.archived) np.archived = false;
      }
      try { await savePersonAndVisit(np, v); } catch (e) { toast('保存できませんでした: ' + e.message); return; }
      close();
      toast('記録しました');
      render();
    };
    f.addEventListener('submit', e => { e.preventDefault(); save(); });
    root.addEventListener('click', async e => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'cancel') close();
      else if (a.dataset.act === 'save') save();
      else if (a.dataset.act === 'delete') {
        if (!await confirmSheet(`${esc(fmtDateTime(v.at))} の記録を消します。`, '消す', true)) return;
        await Store.deleteVisit(v.id);
        S.visits = S.visits.filter(x => x.id !== v.id);
        reindex();
        close();
        render();
      }
    });
  }

  // ---------------------------------------------------------------- 引き継ぎ文
  // 巡回訪問の週が終わるとき、その会衆の奉仕者へ渡す文章。連絡先は既定で入れない
  function handoverText(p, opt) {
    const st = STAGES[p.stage] || STAGES.interest;
    const L = ['【再訪問の引き継ぎ】', `相手: ${p.name}`];
    if (placeLine(p)) L.push(`場所: ${placeLine(p)}`);
    if (p.address) L.push(`住所: ${p.address}`);
    if (Number.isFinite(p.lat)) L.push(`地図: https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`);
    if (p.language) L.push(`言語: ${p.language}`);
    if (p.bestTime) L.push(`都合のよい時間: ${p.bestTime}`);
    if (opt.contact && p.contact) L.push(`連絡先: ${p.contact}`);
    L.push(`段階: ${st.label}`);
    const vs = visitsOf(p.id).slice().reverse();
    if (vs.length) {
      L.push('', 'これまでの訪問:');
      for (const v of vs) {
        const parts = [v.talked, v.gave && `渡したもの: ${v.gave}`].filter(Boolean).join(' / ');
        L.push(`・${fmtDate(v.at)} ${RESULTS[v.result] || ''}${parts ? ' — ' + parts : ''}`);
      }
    }
    if (p.nextTopic) L.push('', `次に話すこと: ${p.nextTopic}`);
    if (opt.note && p.note) L.push(`メモ: ${p.note}`);
    return L.join('\n');
  }

  function openHandover(p) {
    const { root, close } = openSheet(`
      <div class="sheet-head"><button data-act="cancel">閉じる</button><h2>引き継ぎ文</h2><span class="spacer"></span></div>
      <div class="sheet-body">
        <p class="hint">その会衆の奉仕者に渡す文章です。送る前に中身を直せます。</p>
        <label class="check"><input type="checkbox" name="note" checked> メモ（人柄・関心など）を入れる</label>
        ${p.contact ? '<label class="check"><input type="checkbox" name="contact"> 連絡先を入れる（本人の了承があるときだけ）</label>' : ''}
        <textarea class="handover" rows="14"></textarea>
        <div class="row2"><button data-act="copy">コピー</button><button data-act="share" class="primary">送る…</button></div>
      </div>`, 'full');
    const ta = $('textarea', root);
    const gen = () => { ta.value = handoverText(p, { note: $('[name=note]', root).checked, contact: !!($('[name=contact]', root) || {}).checked }); };
    gen();
    root.addEventListener('change', e => { if (e.target.type === 'checkbox') gen(); });
    root.addEventListener('click', async e => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'cancel') close();
      else if (a.dataset.act === 'copy') {
        try { await navigator.clipboard.writeText(ta.value); toast('コピーしました'); }
        catch (err) { ta.select(); toast('選択しました。長押しでコピーしてください'); }
      } else if (a.dataset.act === 'share') {
        if (navigator.share) { try { await navigator.share({ text: ta.value }); } catch (err) { /* 取り消し */ } }
        else { try { await navigator.clipboard.writeText(ta.value); toast('コピーしました'); } catch (err) { /* */ } }
      }
    });
  }

  // ---------------------------------------------------------------- カレンダー（.ics）
  function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m); }
  function icsFor(p) {
    const dt = p.nextAt.replace(/[-:]/g, '') + '00';                 // 端末の時刻のまま（浮動時刻）
    const end = addDays(p.nextAt, 0);
    const endD = new Date(end); endD.setMinutes(endD.getMinutes() + 30);
    const dtEnd = stamp(endD).replace(/[-:]/g, '') + '00';
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//revisit-notes//JA', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT', `UID:${p.id}-${dt}@revisit-notes`, `DTSTAMP:${now}`,
      `DTSTART:${dt}`, `DTEND:${dtEnd}`, `SUMMARY:${icsEscape('再訪問: ' + p.name)}`,
      `LOCATION:${icsEscape([placeLine(p), p.address].filter(Boolean).join(' '))}`,
      `DESCRIPTION:${icsEscape(p.nextTopic ? '次に話すこと: ' + p.nextTopic : '')}`,
      'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:再訪問', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
  }
  async function saveFile(name, type, text) {
    const file = new File([text], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });          // 取り消されたら AbortError で投げる
      return true;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  }

  // ---------------------------------------------------------------- 設定・バックアップ
  async function renderSettings() {
    const el = $('#view-settings');
    const last = S.meta.lastBackupAt;
    let persisted = null;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { /* */ }
    el.innerHTML = `
      <div class="vhead"><h1>設定</h1></div>
      <div class="settings">
        <section class="card">
          <h2>💾 バックアップ</h2>
          <p>記録はこの iPhone の中だけにあります。機種変更・紛失に備えて、ときどきファイルに書き出して「ファイル」アプリ（iCloud Drive）に保存してください。</p>
          <p class="warn-text">ホーム画面の「再訪問」のアイコンを削除すると、記録も一緒に消えます。</p>
          <p class="state">最後のバックアップ: <b>${last ? esc(fmtDate(last)) + `（${daysSince(last)}日前）` : 'まだありません'}</b></p>
          <button class="primary block" data-act="export">バックアップを作る</button>
          <button class="block" data-act="import">バックアップから戻す</button>
          <input type="file" id="import-file" accept=".json,application/json" hidden>
        </section>
        <section class="card">
          <h2>記録の件数</h2>
          <p>相手 ${S.people.length}人（訪問を終えた ${S.people.filter(p => p.archived).length}人を含む）・訪問 ${S.visits.length}件</p>
          ${persisted === false ? `<p class="muted">この iPhone がしばらく使わない記録を整理するとき、消されないように頼めます。</p>
            <button class="block" data-act="persist">消されにくくする</button>` : ''}
          ${persisted === true ? '<p class="muted">✔ 消されにくい保存になっています</p>' : ''}
        </section>
        <section class="card">
          <h2>このアプリについて</h2>
          <p>名前・メモ・訪問の記録は、この iPhone の外へは送りません。インターネットを使うのは、地図の画像と住所の検索（国土地理院）だけです。位置から住所を出すときは座標だけを送ります。</p>
          <p class="muted">再訪問ノート ${APP_VERSION}</p>
        </section>
      </div>`;
  }

  async function doExport() {
    const pw = await passwordSheet('バックアップを作る',
      'パスワードを付けると、ファイルを開くのにそのパスワードが要ります（忘れると戻せません）。付けないときは空のまま「決定」。', true);
    if (pw === null) return;
    const now = stamp();
    const text = await Backup.build({ exportedAt: now, people: S.people, visits: S.visits }, pw);
    const name = `再訪問ノート_${now.slice(0, 10).replace(/-/g, '')}.json`;
    // 共有シートはタップの直後にしか開けない。暗号化の計算を待つ間にその効力が切れることがあるので、
    // 出来上がってからもう一度押してもらう
    const { root, close } = openSheet(`<div class="dialog"><h3>バックアップの準備ができました</h3>
      <p>「保存する」を押し、出てきた画面で <b>「"ファイル"に保存」</b> を選んで iCloud Drive に保存します。</p>
      <p class="muted">${esc(name)}${pw ? '（パスワード付き）' : ''}</p>
      <div class="row2"><button data-v="cancel">やめる</button><button data-v="save" class="primary">保存する</button></div></div>`, 'modal');
    root.addEventListener('click', async e => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      if (b.dataset.v === 'cancel') { close(); return; }
      try {
        await saveFile(name, 'application/json', text);
      } catch (err) {
        toast(err && err.name === 'AbortError' ? '取り消しました' : '書き出せませんでした: ' + err.message);
        return;
      }
      close();
      S.meta.lastBackupAt = now;
      await Store.setMeta('lastBackupAt', now);
      toast('バックアップを作りました');
      render();
    });
  }

  async function doImport(file) {
    try {
      const text = await file.text();
      let r = await Backup.parse(text);
      if (r.needsPassword) {
        const pw = await passwordSheet('パスワード', 'このバックアップにはパスワードが付いています。', false);
        if (pw === null) return;
        r = await Backup.parse(text, pw);
      }
      const ok = await confirmSheet(`${r.exportedAt ? esc(fmtDateTime(r.exportedAt)) + ' の' : ''}バックアップ（相手 ${r.people.length}人・訪問 ${r.visits.length}件）を読み込みます。<br>
        この iPhone にある記録は消えません。同じ記録は新しい方を残します。`, '読み込む');
      if (!ok) return;
      const res = await Store.merge(r.people, r.visits);
      await reload();
      toast(`読み込みました（追加 ${res.added}・更新 ${res.updated}）`);
      render();
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- ホーム画面に追加の案内（iPhone の Safari）
  // Safari とホーム画面のアプリは保存場所が別。Safari で記録を始めると、あとでホーム画面から開いたとき
  // 記録が見えない。しかも Safari はしばらく開かないサイトの保存を消すことがある。だから Safari では使わせない。
  function needsInstall() {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    return ios && !standalone;
  }
  function showInstallGate() {
    document.body.classList.add('gated');
    $('#gate').hidden = false;
  }

  // ---------------------------------------------------------------- 新しい版
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // 読み直すのは「更新する」を押したときだけ。初回の登録でも clients.claim() で controllerchange が
    // 起きるので、無条件に読み直すと最初の入力の途中で画面が白紙に戻る
    let updating = false;
    navigator.serviceWorker.register('sw.js').then(reg => {
      const offer = w => {
        const bar = $('#update-bar');
        bar.hidden = false;
        bar.querySelector('button').onclick = () => { updating = true; w.postMessage('skipWaiting'); };
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!updating) return;
      updating = false;
      location.reload();
    });
  }

  // ---------------------------------------------------------------- 操作の受け口
  document.addEventListener('click', async e => {
    const open = e.target.closest('[data-open]');
    if (open) { goPerson(open.dataset.open); return; }
    const nav = e.target.closest('[data-nav]');
    if (nav) { location.hash = nav.dataset.nav; return; }
    const tab = e.target.closest('#tabs [data-tab]');
    if (tab) {
      if (tab.dataset.tab === 'add') openPersonForm(null);
      else location.hash = '#/' + tab.dataset.tab;
      return;
    }
    const a = e.target.closest('.view [data-act]');
    if (!a) return;
    const act = a.dataset.act;
    const p = personById(S.personId);
    if (act === 'show-archived' || act === 'hide-archived') { S.filter.showArchived = act === 'show-archived'; renderListBody(); }
    else if (act === 'back') { location.hash = '#/' + (S.personFrom || 'list'); }
    else if (act === 'edit-person' && p) openPersonForm(p);
    else if (act === 'record' && p) openVisitForm(p, null);
    else if (act === 'edit-visit' && p) { const v = S.visits.find(x => x.id === a.dataset.id); if (v) openVisitForm(p, v); }
    else if (act === 'handover' && p) openHandover(p);
    else if (act === 'show-on-map' && p) { S.focusId = p.id; S.personFrom = 'map'; location.hash = '#/map'; }
    else if (act === 'archive' && p) {
      const np = { ...p, archived: !p.archived };
      if (np.archived && !await confirmSheet(`「${esc(p.name)}」の訪問を終えて、一覧の下（終えた人）へ移します。記録は残ります。`, '終える')) return;
      await savePerson(np);
      toast(np.archived ? '訪問を終えました' : '再開しました');
      render();
    } else if (act === 'ics' && p) {
      try { await saveFile(`再訪問_${p.nextAt.slice(0, 10)}.ics`, 'text/calendar', icsFor(p)); }
      catch (err) { if (!err || err.name !== 'AbortError') toast('作れませんでした'); }
    } else if (act === 'export') doExport();
    else if (act === 'import') $('#import-file').click();
    else if (act === 'persist') {
      const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
      toast(ok ? '消されにくくしました' : 'この iPhone では設定できませんでした');
      renderSettings();
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'import-file' && e.target.files[0]) {
      doImport(e.target.files[0]);
      e.target.value = '';
    }
  });

  // ---------------------------------------------------------------- 起動
  async function start() {
    if (needsInstall()) { showInstallGate(); return; }
    registerSW();
    try { await reload(); }
    catch (e) {
      $('#views').innerHTML = `<p class="empty">記録を読み込めませんでした: ${esc(e.message)}</p>`;
      return;
    }
    window.addEventListener('hashchange', route);
    route();
    // 日付をまたいで開きっぱなしのとき「今日」の区切りを直す
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.view !== 'map') render(); });
  }
  start();
})();
