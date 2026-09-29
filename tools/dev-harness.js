// 動作試験: ヘッドレス Chrome を iPhone の画面サイズ・ホーム画面モードにして、ひと通り操作し、結果を判定する。
//   npm test                     … 画面写真と report.json を test-output/ に書く
//   node tools/dev-harness.js <出力先フォルダ>
// 最後に「合格」か「不合格」を出す。不合格なら終了コード 1（GitHub の自動公開もここで止まる）。
// 本物の端末の記録には触れない（毎回まっさらな Chrome のプロファイルで動かす）。
//
// 地図の画像・住所の検索は国土地理院に取りに行くので、電波やあちらの都合で失敗することがある。
// それらは「注意」として出すだけで、不合格にはしない。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'test-output'));
const PORT = 5180, CDP_PORT = 9340;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
fs.mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = {
    win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  }[process.platform] || [];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execSync(`command -v ${name}`, { encoding: 'utf8' }).trim(); } catch (e) { /* 次へ */ }
  }
  throw new Error('Google Chrome が見つかりません。入れるか、環境変数 CHROME に場所を書いてください');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__blank') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><link rel="icon" href="data:,"><title>blank</title>'); return; }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) { return new Promise((res, rej) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej)); }

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.wait = new Map(); this.handlers = []; ws.on('message', m => this.onMsg(JSON.parse(m))); }
  onMsg(m) {
    if (m.id && this.wait.has(m.id)) { const { res, rej } = this.wait.get(m.id); this.wait.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const h of this.handlers) h(m);
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.wait.set(id, { res, rej })); }
  on(h) { this.handlers.push(h); }
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'revisit-prof-'));
  const args = ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check'];
  if (process.env.CI) args.push('--no-sandbox');
  const chrome = spawn(findChrome(), [...args, 'about:blank'], { stdio: 'ignore' });
  const report = { steps: [], failures: [], warnings: [], errors: [] };
  const expect = (ok, msg) => { if (!ok) { report.failures.push(msg); console.log('  ✗', msg); } };
  let cdp;
  try {
    let targets = [];
    for (let i = 0; i < 60; i++) { try { targets = await getJSON(`http://127.0.0.1:${CDP_PORT}/json/list`); if (targets.some(t => t.type === 'page')) break; } catch (e) { /* 起動待ち */ } await sleep(250); }
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('Chrome が起動しませんでした');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise(r => ws.on('open', r));
    cdp = new CDP(ws);
    cdp.on(m => {
      let msg = null;
      if (m.method === 'Runtime.exceptionThrown') msg = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text;
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') msg = m.params.args.map(a => a.value || a.description).join(' ');
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') msg = m.params.entry.text + ' ' + (m.params.entry.url || '');
      if (!msg) return;
      if (/gsi\.go\.jp/.test(msg)) report.warnings.push('国土地理院への通信: ' + msg); else report.errors.push(msg);
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    const origin = `http://localhost:${PORT}`;
    await cdp.send('Browser.grantPermissions', { origin, permissions: ['geolocation'] }).catch(() => {});
    await cdp.send('Emulation.setGeolocationOverride', { latitude: 33.88455, longitude: 130.87605, accuracy: 15 });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });

    const size = async (w, h) => cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    const load = async url => {
      const done = new Promise(r => { const h = m => { if (m.method === 'Page.loadEventFired') r(); }; cdp.on(h); });
      await cdp.send('Page.navigate', { url });
      await done; await sleep(500);
    };
    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async name => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    };
    const step = (name, value) => { report.steps.push({ name, value }); console.log('•', name, JSON.stringify(value)); return value; };
    // 電波しだいの手順。失敗しても注意にとどめる
    const soft = async (name, fn) => {
      try { return await fn(); } catch (e) { report.warnings.push(`${name}: ${e.message.split('\n')[0]}`); console.log('  ⚠', name, e.message.split('\n')[0]); return null; }
    };
    const HELP = `const sleep = ms => new Promise(r => setTimeout(r, ms));
      const $ = s => document.querySelector(s);
      const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('待ちきれず: ' + fn); };
      const set = (f, n, v) => { f.elements[n].value = v; };`;

    // 1) Safari のまま → ホーム画面に追加の案内だけが出る
    await size(390, 844);
    await load(origin + '/');
    const g = step('Safari で開いたとき', await ev(`return { gate: !document.getElementById('gate').hidden, tabs: getComputedStyle(document.getElementById('tabs')).display }`));
    expect(g.gate && g.tabs === 'none', 'Safari で開くと「ホーム画面に追加」の案内だけが出ること');
    await shot('01-gate');

    // 2) 初版（DB の版 1）で作られた記録を置いてから開く — 新しい版でも前の記録が読めることの確認。
    //    store.js の DB の版や保存の形を変えたとき、ここが落ちたら「更新すると記録が消える」ということ
    await load(origin + '/__blank');
    await ev(`await new Promise((res, rej) => {
        const r = indexedDB.open('revisit-notes', 1);
        r.onupgradeneeded = () => { const db = r.result;
          db.createObjectStore('people', { keyPath: 'id' });
          db.createObjectStore('visits', { keyPath: 'id' }).createIndex('personId', 'personId');
          db.createObjectStore('meta', { keyPath: 'key' }); };
        r.onsuccess = () => { const db = r.result; const tx = db.transaction(['people', 'visits'], 'readwrite');
          tx.objectStore('people').put({ id: 'p-v1', name: '初版で登録した人', stage: 'rv', congregation: '城内', placeName: '初版の店',
            nextAt: '', nextTopic: '初版の話題', createdAt: '2026-09-01T10:00:00', updatedAt: '2026-09-01T10:00:00', archived: false });
          tx.objectStore('visits').put({ id: 'v-v1', personId: 'p-v1', at: '2026-09-01T10:00', result: 'met', talked: '初版の記録',
            createdAt: '2026-09-01T10:00:00', updatedAt: '2026-09-01T10:00:00' });
          tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
        r.onerror = () => rej(r.error); }); return true;`);

    // 3) ホーム画面から開いた状態にする
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });` });
    await load(origin + '/');
    const s0 = step('ホーム画面から開いたとき', await ev(`${HELP} await waitFor(() => document.querySelector('.view.active') || !document.getElementById('gate').hidden);
      return { gate: !document.getElementById('gate').hidden, view: (document.querySelector('.view.active') || {}).id,
        v1: [...document.querySelectorAll('#list-body .row .name')].map(n => n.textContent) };`));
    expect(!s0.gate && s0.view === 'view-list', 'ホーム画面から開くと一覧が出ること');
    expect(s0.v1.includes('初版で登録した人'), '初版（DB の版 1）の記録が新しい版でも読めること');
    await shot('02-first');

    // 4) ＋ → 新しい相手（今いる場所・最初の訪問・1週間後の約束）
    const a = step('新しい相手を入力', await ev(`${HELP}
      $('#tabs [data-tab=add]').click(); await sleep(400);
      const f = $('.sheet form');
      set(f, 'name', 'フラワーショップの店主（60代の男性）');
      set(f, 'placeName', 'テスト花店'); set(f, 'room', '1F');
      set(f, 'congregation', '城内'); set(f, 'language', '日本語'); set(f, 'bestTime', '平日の14時ごろ');
      set(f, 'note', '奥さんが入院中。孫の話をよくする');
      set(f, 'talked', '家族の健康を心配していた。詩編 37:29 を読んだ');
      f.querySelector('[data-chip="冊子"]').click();
      set(f, 'nextTopic', '死んだ人に希望はあるか');
      f.querySelector('[data-next="7"]').click();
      $('.sheet [data-act=here]').click();
      await waitFor(() => $('.sheet .locstate').textContent.includes('登録済み'));
      return { gave: f.elements.gave.value, nextAt: f.elements.nextAt.value, loc: $('.sheet .locstate').textContent };`));
    expect(a.loc.includes('登録済み'), '「今いる場所」で位置が入ること');
    expect(a.gave === '冊子', '渡したもののボタンで欄に入ること');
    expect(/T\d\d:(00|30)$/.test(a.nextAt), '「1週間後」の約束が30分単位になること');
    const addr = await soft('位置から住所を出す（国土地理院）', () => ev(`${HELP} const f = $('.sheet form'); await waitFor(() => f.elements.address.value, 8000); return f.elements.address.value;`));
    if (addr !== null) step('自動で入った住所', addr);
    await shot('03-person-form');
    const sv = step('保存', await ev(`${HELP}
      $('.sheet [data-act=save]').click(); await sleep(700);
      return { hash: location.hash, sheets: document.querySelectorAll('.sheet').length, title: $('#view-person h1').textContent, visits: document.querySelectorAll('#view-person .visit').length };`));
    expect(sv.hash.startsWith('#/p/') && sv.sheets === 0, '保存すると相手の画面に移ること');
    expect(sv.visits === 1, '「今日会って話した」で最初の訪問が1件できること');
    await shot('04-person');

    // 5) 2回目の訪問を記録（段階を再訪問へ）
    const rv = step('2回目の訪問を記録', await ev(`${HELP}
      $('#view-person [data-act=record]').click(); await sleep(400);
      const f = $('.sheet form');
      const pre = { nextAt: f.elements.nextAt.value, nextTopic: f.elements.nextTopic.value };
      set(f, 'talked', '復活の希望について話した。とても喜んでいた');
      f.querySelector('[data-chip="パンフレット"]').click();
      set(f, 'nextTopic', '神の王国とは');
      f.querySelector('input[name=stage][value=rv]').checked = true;
      $('.sheet [data-act=save]').click(); await sleep(700);
      return { pre, visits: document.querySelectorAll('#view-person .visit').length, badge: $('#view-person .badge').textContent,
        first: document.querySelector('#view-person .visit p').textContent };`));
    expect(rv.pre.nextTopic === '死んだ人に希望はあるか', '記録の画面に前回の「次に話すこと」が入っていること');
    expect(rv.visits === 2 && rv.badge === '再訪問', '訪問が2件になり、段階が「再訪問」に変わること');
    expect(rv.first.startsWith('復活'), '訪問の記録は新しい順に並ぶこと');
    await shot('05-person-2visits');

    // 6) 一覧の並びを見るため、ほかの人を直接入れる（約束が過ぎた人・今日・約束なし・別の会衆・終えた人）
    await ev(`${HELP}
      const pad = n => String(n).padStart(2, '0');
      const st = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      const day = (n, h = 14) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, 0, 0, 0); return st(d); };
      const P = (id, o) => Object.assign({ id, stage: 'interest', congregation: '城内', createdAt: day(-30), updatedAt: day(-1) + ':00', archived: false }, o);
      const people = [
        P('p-over', { name: 'ベトナムの方（技能実習生）', placeName: '京町の寮', language: 'ベトナム語', nextAt: day(-2, 19), nextTopic: '家族', lat: 33.8861, lng: 130.8793, stage: 'study' }),
        P('p-today', { name: '喫茶店のママ', placeName: 'テスト喫茶', nextAt: day(0, 15), nextTopic: '祈り', lat: 33.8826, lng: 130.8771, stage: 'rv' }),
        P('p-none', { name: '時計店のご主人', placeName: 'テスト時計店', lat: 33.8840, lng: 130.8732 }),
        P('p-other', { name: '八幡の美容師さん', placeName: 'テスト美容室', congregation: '八幡東', nextAt: day(10, 11), lat: 33.8657, lng: 130.8117, stage: 'rv' }),
        P('p-noloc', { name: '駅で話した学生', congregation: '城内' }),
        P('p-done', { name: '引っ越した方', congregation: '城内', archived: true }),
      ];
      const visits = [
        { id: 'v1', personId: 'p-none', at: day(-40, 10), result: 'met', talked: '時計の修理の話から聖書の話に', createdAt: day(-40), updatedAt: day(-40) + ':00' },
        { id: 'v2', personId: 'p-today', at: day(-7, 15), result: 'absent', createdAt: day(-7), updatedAt: day(-7) + ':00' },
        { id: 'v3', personId: 'p-over', at: day(-9, 19), result: 'met', talked: 'ベトナム語の動画を見せた', gave: '動画', createdAt: day(-9), updatedAt: day(-9) + ':00' },
      ];
      await Store.merge(people, visits);
      location.hash = '#/list'; location.reload(); return true;`);
    await sleep(1500);
    const li = step('一覧', await ev(`return { groups: [...document.querySelectorAll('#list-body .group h2')].map(h => h.firstChild.textContent), notice: !!document.querySelector('.notice') };`));
    expect(JSON.stringify(li.groups) === JSON.stringify(['約束の日が過ぎた', '今日', '7日以内', 'その先', '約束なし（前の訪問が古い順）']), '一覧が約束の日で5つに分かれること');
    expect(li.notice, 'バックアップが無いと知らせが出ること');
    await shot('06-list');
    const fl = step('会衆で絞る', await ev(`${HELP} const s = $('#list-cong'); s.value = '八幡東'; s.dispatchEvent(new Event('change')); await sleep(100);
      const r = [...document.querySelectorAll('#list-body .row .name')].map(n => n.textContent); s.value = ''; s.dispatchEvent(new Event('change')); return r;`));
    expect(JSON.stringify(fl) === JSON.stringify(['八幡の美容師さん']), '会衆で絞れること');
    const se = step('探す', await ev(`${HELP} const q = $('#list-q'); q.value = '時計'; q.dispatchEvent(new Event('input')); await sleep(100);
      const r = [...document.querySelectorAll('#list-body .row .name')].map(n => n.textContent); q.value = ''; q.dispatchEvent(new Event('input')); return r;`));
    expect(JSON.stringify(se) === JSON.stringify(['時計店のご主人']), '名前・場所で探せること');
    const ar = step('訪問を終えた人', await ev(`${HELP} $('[data-act=show-archived]').click(); await sleep(100); return [...document.querySelectorAll('#list-body .group.done .name')].map(n => n.textContent);`));
    expect(JSON.stringify(ar) === JSON.stringify(['引っ越した方']), '訪問を終えた人は別に出ること');

    // 7) 地図
    await ev(`location.hash = '#/map'; return true;`);
    await sleep(3500);
    const mp = step('地図', await ev(`return { pins: document.querySelectorAll('#map path.leaflet-interactive').length, tiles: document.querySelectorAll('#map .leaflet-tile-loaded').length, note: document.getElementById('map-note').textContent };`));
    expect(mp.pins === 5, '位置のある人（終えた人を除く）が地図に出ること');
    expect(mp.note === '位置が未登録: 2人', '位置が未登録の人数が出ること');
    if (!mp.tiles) report.warnings.push('地図の画像が読めませんでした（電波か国土地理院の都合）');
    await shot('07-map');
    const pp = step('地図から開く', await ev(`${HELP}
      const pin = [...document.querySelectorAll('#map path.leaflet-interactive')][0];
      pin.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })); await sleep(400);
      $('.leaflet-popup-content [data-open]').click(); await sleep(400);
      return { hash: location.hash, back: $('#view-person .back').textContent };`));
    expect(pp.hash.startsWith('#/p/') && pp.back === '‹ 地図', '地図の吹き出しから相手を開けて、戻り先が地図になること');

    // 8) 引き継ぎ文・カレンダー
    await ev(`location.hash = '#/list'; return true;`); await sleep(300);
    await ev(`const p = [...document.querySelectorAll('#list-body .row')].find(r => r.textContent.includes('フラワー')); p.click(); await new Promise(r => setTimeout(r, 400)); return true;`);
    const ho = step('引き継ぎ文', await ev(`${HELP} $('#view-person [data-act=handover]').click(); await sleep(400); return $('.sheet textarea').value;`));
    expect(ho.startsWith('【再訪問の引き継ぎ】') && ho.includes('地図: https://www.google.com/maps/'), '引き継ぎ文に地図のリンクが入ること');
    expect(ho.indexOf('家族の健康') < ho.indexOf('復活の希望'), '引き継ぎ文の訪問は古い順に並ぶこと');
    await shot('08-handover');
    await ev(`${HELP} $('.sheet [data-act=cancel]').click(); await sleep(300); return true;`);
    const ic = step('カレンダー', await ev(`${HELP}
      navigator.canShare = () => true; navigator.share = async d => { window.__shared = d; };
      $('#view-person [data-act=ics]').click(); await sleep(300);
      const f = window.__shared.files[0]; return { name: f.name, type: f.type, text: await f.text() };`));
    expect(ic.type === 'text/calendar' && /DTSTART:\d{8}T\d{6}\r\n/.test(ic.text) && ic.text.includes('BEGIN:VALARM'), 'カレンダーのファイル（.ics）ができること');

    // 9) バックアップ（パスワード付き）→ 読み戻し
    await ev(`location.hash = '#/settings'; return true;`); await sleep(400);
    const ex = step('バックアップを作る', await ev(`${HELP}
      window.__shared = null;
      $('#view-settings [data-act=export]').click(); await sleep(400);
      const f = $('.sheet form'); f.elements.p1.value = 'kaeru'; f.elements.p2.value = 'kaeru';
      f.requestSubmit(); await waitFor(() => document.querySelector('.sheet [data-v=save]'), 8000);
      $('.sheet [data-v=save]').click(); await sleep(500);
      const file = window.__shared.files[0]; const text = await file.text(); window.__backup = text;
      const all = await Store.loadAll();
      return { name: file.name, encrypted: JSON.parse(text).encrypted, hasPlainName: text.includes('フラワー'), state: $('#view-settings .state').textContent,
        people: all.people.length, visits: all.visits.length };`));
    expect(ex.encrypted && !ex.hasPlainName, 'パスワード付きのバックアップは中身が読めない形になること');
    expect(!ex.state.includes('まだありません'), 'バックアップを作ると最後の日付が記録されること');
    await shot('10-settings');
    const pw = step('パスワード', await ev(`
      const t = window.__backup; let wrong;
      try { await Backup.parse(t, 'x'); wrong = '開けてしまった'; } catch (e) { wrong = e.message; }
      const need = await Backup.parse(t); const ok = await Backup.parse(t, 'kaeru');
      return { wrong, needsPassword: need.needsPassword, people: ok.people.length, visits: ok.visits.length };`));
    expect(pw.wrong === 'パスワードが違います' && pw.needsPassword, '違うパスワードでは開けないこと');
    expect(pw.people === ex.people && pw.visits === ex.visits, 'バックアップに全員・全訪問が入っていること');
    const mg = step('読み込みは新しい方を残す', await ev(`
      const ok = await Backup.parse(window.__backup, 'kaeru');
      const p = ok.people.find(x => x.id === 'p-none'); p.name = '時計店のご主人（名前を直した）'; p.updatedAt = '2099-01-01T00:00:00';
      const q = ok.people.find(x => x.id === 'p-today'); q.name = '古い名前'; q.updatedAt = '2000-01-01T00:00:00';
      const r = await Store.merge(ok.people, ok.visits);
      const all = await Store.loadAll();
      return { r, none: all.people.find(x => x.id === 'p-none').name, today: all.people.find(x => x.id === 'p-today').name };`));
    expect(mg.none.includes('直した') && mg.today === '喫茶店のママ', '読み込みでは同じ記録の新しい方が残ること');

    // 10) 小さい iPhone（SE）で入力画面、暗い画面で一覧
    await size(375, 667);
    await ev(`location.hash = '#/p/p-today'; await new Promise(r => setTimeout(r, 300)); document.querySelector('#view-person [data-act=record]').click(); await new Promise(r => setTimeout(r, 400)); return true;`);
    await shot('11-se-visit-form');
    const sm = step('SE の入力画面', await ev(`const h = document.querySelector('.sheet-head').getBoundingClientRect(); const s = document.querySelector('.sheet-head [data-act=save]').getBoundingClientRect(); return { top: h.top, saveRight: s.right, width: innerWidth };`));
    expect(sm.top === 0 && sm.saveRight <= sm.width, 'SE の大きさでも保存ボタンが画面に収まること');
    await ev(`document.querySelector('.sheet [data-act=cancel]').click(); await new Promise(r => setTimeout(r, 300)); return true;`);
    await size(390, 844);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await ev(`location.hash = '#/list'; return true;`); await sleep(400);
    await shot('12-list-dark');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    // 11) 位置を選ぶ画面（住所検索は国土地理院）
    await ev(`location.hash = '#/p/p-noloc'; await new Promise(r => setTimeout(r, 300)); document.querySelector('#view-person [data-act=edit-person]').click(); await new Promise(r => setTimeout(r, 400)); document.querySelector('.sheet [data-act=pick]').click(); return true;`);
    await sleep(2500);
    await shot('13-picker');
    const pk = await soft('住所で探す（国土地理院）', () => ev(`${HELP}
      const f = document.querySelectorAll('.sheet')[1].querySelector('.picker-search'); f.elements.q.value = '北九州市小倉北区京町3丁目'; f.requestSubmit();
      await waitFor(() => document.querySelector('.picker-results button'), 8000);
      document.querySelector('.picker-results button').click(); await sleep(800);
      document.querySelectorAll('.sheet')[1].querySelector('[data-act=ok]').click(); await sleep(300);
      return { loc: document.querySelector('.sheet .locstate').textContent };`));
    if (pk) { step('位置を選ぶ', pk); expect(pk.loc.includes('登録済み'), '地図で選んだ位置が入ること'); }
    await ev(`document.querySelectorAll('.sheet').forEach(s => s.remove()); return true;`);

    // 12) 訪問を終える → 一覧から外れる → 再開
    const at = step('訪問を終える', await ev(`${HELP}
      location.hash = '#/p/p-today'; await sleep(300);
      $('#view-person [data-act=archive]').click(); await sleep(300);
      $('.sheet [data-v="1"]').click(); await sleep(500);
      const badge = $('#view-person .badge').textContent;
      location.hash = '#/list'; await sleep(300);
      const inList = [...document.querySelectorAll('#list-body .group:not(.done) .name')].some(n => n.textContent === '喫茶店のママ');
      location.hash = '#/p/p-today'; await sleep(300);
      $('#view-person [data-act=archive]').click(); await sleep(500);
      return { badge, inList, after: $('#view-person .badge').textContent };`));
    expect(at.badge === '訪問を終えた' && !at.inList && at.after === '再訪問', '訪問を終えると一覧から外れ、再開で戻ること');

    // 13) 削除（訪問の記録ごと）
    const dl = step('削除', await ev(`${HELP}
      location.hash = '#/p/p-none'; await sleep(300);
      $('#view-person [data-act=edit-person]').click(); await sleep(400);
      $('.sheet [data-act=delete]').click(); await sleep(300);
      $('.sheet.modal [data-v="1"]').click(); await sleep(600);
      const all = await Store.loadAll();
      return { person: all.people.some(p => p.id === 'p-none'), visits: all.visits.some(v => v.personId === 'p-none') };`));
    expect(!dl.person && !dl.visits, '削除すると訪問の記録も一緒に消えること');

    // 14) ファイルから読み戻す（パスワード付き）→ 消した人が戻る
    const im = step('バックアップから戻す', await ev(`${HELP}
      location.hash = '#/settings'; await sleep(400);
      const input = $('#import-file'); const dt = new DataTransfer();
      dt.items.add(new File([window.__backup], 'backup.json', { type: 'application/json' }));
      input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => document.querySelector('.sheet form input[name=p1]'));
      const f = $('.sheet form'); f.elements.p1.value = 'kaeru'; f.requestSubmit();
      await waitFor(() => [...document.querySelectorAll('.sheet.modal [data-v="1"]')].find(b => b.textContent === '読み込む'), 8000);
      [...document.querySelectorAll('.sheet.modal [data-v="1"]')].find(b => b.textContent === '読み込む').click(); await sleep(800);
      const all = await Store.loadAll();
      return { back: all.people.some(p => p.id === 'p-none') };`));
    expect(im.back, 'バックアップのファイルから、消した人が戻ること');

    // 15) サービスワーカー（電波が無くても開けるか）
    const sw = step('オフライン用の控え', await ev(`const r = await navigator.serviceWorker.getRegistration(); const keys = await caches.keys(); const shell = keys.find(k => k.startsWith('shell-')); const n = shell ? (await (await caches.open(shell)).keys()).length : 0; return { active: !!(r && r.active), shellFiles: n };`));
    expect(sw.active && sw.shellFiles >= 10, 'アプリ本体が端末に控えられること（電波が無くても開ける）');

    expect(report.errors.length === 0, '画面にエラーが出ないこと: ' + report.errors.join(' / '));
  } catch (e) {
    report.fatal = e.stack || String(e);
    report.failures.push('試験が途中で止まりました: ' + String(e.message || e).split('\n')[0]);
    console.error(e);
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log('');
    for (const w of report.warnings) console.log('⚠ 注意:', w);
    if (report.failures.length) {
      console.log(`✗ 不合格（${report.failures.length}件）`);
      for (const f of report.failures) console.log('  -', f);
    } else {
      console.log('✓ 合格');
    }
    console.log('画面写真:', OUT);
    try { await cdp?.send('Browser.close'); } catch (e) { /* */ }
    chrome.kill();
    server.close();
    setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* */ } process.exit(report.failures.length ? 1 : 0); }, 800);
  }
})();
