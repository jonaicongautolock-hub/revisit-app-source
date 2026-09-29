// 電波の無い建物の中でも開けるように、アプリ本体を端末に置いておく。
// 中身を変えたら VERSION を上げる（上げないと iPhone は古い版を使い続ける）。
const VERSION = 'v0.1.0';
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles';
const MAX_TILES = 3000;
const FILES = [
  './', 'index.html', 'app.css', 'app.js', 'store.js', 'backup.js', 'muni.json', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
});

// 「更新する」を押したときだけ切り替える（入力の途中で勝手に読み直さない）
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// 見た地図の画像は取っておき、電波が無くても前に見た範囲は出るようにする。古い順に捨てる
async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'cyberjapandata.gsi.go.jp') {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // 地理院タイルは CORS 付きで取る（opaque だと 1枚ごとに大きく数えられて保存枠を食う）
      if (res.ok) { c.put(req, res.clone()); if (Math.random() < 0.05) trimTiles(); }
      return res;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;   // 住所検索などはそのまま通す

  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') return caches.match('index.html');
      throw err;
    }
  })());
});
