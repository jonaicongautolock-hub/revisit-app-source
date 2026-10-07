// 手元で開いて見るための静的サーバー。 node tools/serve.js → http://localhost:5181/
// PC の Chrome で開くと「ホーム画面に追加」の案内は出ない（iPhone のときだけ出る）。
// Claude デスクトップの確かめ用の画面（Browser）もこれを使う（.claude/launch.json）。
//
// 手元では本物の sw.js の代わりに「控えを使わない sw.js」を渡す。本物は一度読んだファイルを控えから出すので、
// 直したのに画面が変わらない（版の番号を上げて「更新する」を押すまで古いまま）ということが起きるため。
// 本物の控えの動きを試したいときだけ node tools/serve.js --sw で起動する。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = +process.env.PORT || 5181;
const REAL_SW = process.argv.includes('--sw');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

// 前に本物の sw.js が入っていても、これに入れ替わって控えを全部消す。fetch を受けないので毎回いまのファイルを読む
const DEV_SW = `// 手元の確かめ用（tools/serve.js が渡す）。控えを使わない
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(() => self.clients.claim())));
`;

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/sw.js' && !REAL_SW) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(DEV_SW);
    return;
  }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}/` + (REAL_SW ? '（本物の sw.js）' : '（控えを使わない確かめ用）')));
