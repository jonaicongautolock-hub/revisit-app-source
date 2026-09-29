// 公開の前の点検（ブラウザを使わない、すぐ終わるもの）。 npm run check
//  1) sw.js の VERSION と app.js の APP_VERSION が同じ番号か
//  2) index.html が読むファイルが、sw.js の控えの一覧（FILES）に全部入っているか（漏れると電波の無い所で開けない）
//  3) 引数に比べる元（git のコミット）を渡したとき: アプリのファイルが変わったのに VERSION が上がっていなければ止める
//     （上げ忘れると iPhone は古い版を使い続け、「更新する」も出ない）
//       node tools/check-version.js <比べる元のコミット>
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const problems = [];

const swVersion = (read('sw.js').match(/const VERSION = '([^']+)'/) || [])[1];
const appVersion = (read('app.js').match(/const APP_VERSION = '([^']+)'/) || [])[1];
if (!swVersion || !appVersion) problems.push('sw.js の VERSION か app.js の APP_VERSION が見つかりません');
else if (swVersion !== 'v' + appVersion) problems.push(`版の番号がそろっていません（sw.js: ${swVersion} / app.js: ${appVersion}）。sw.js は "v" + app.js の番号にします`);

const filesBlock = (read('sw.js').match(/const FILES = \[([\s\S]*?)\];/) || [])[1] || '';
const cached = new Set([...filesBlock.matchAll(/'([^']+)'/g)].map(m => m[1]));
const html = read('index.html');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|data:|#|mailto:)/.test(u));
for (const r of refs) if (!cached.has(r)) problems.push(`index.html が読む ${r} が sw.js の FILES に入っていません`);
for (const f of cached) if (f !== './' && !fs.existsSync(path.join(ROOT, f))) problems.push(`sw.js の FILES にある ${f} がありません`);

const base = process.argv[2];
if (base && !/^0+$/.test(base)) {
  const APP_FILES = /^(index\.html|app\.js|app\.css|store\.js|backup\.js|sw\.js|muni\.json|manifest\.webmanifest|icons\/|vendor\/)/;
  let changed = [];
  try { changed = execSync(`git diff --name-only ${base} HEAD`, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch (e) { console.log('比べる元のコミットが読めないので、版の上げ忘れの点検は飛ばします'); }
  const appChanged = changed.filter(f => APP_FILES.test(f));
  if (appChanged.length) {
    let before = '';
    try { before = (execSync(`git show ${base}:sw.js`, { cwd: ROOT, encoding: 'utf8' }).match(/const VERSION = '([^']+)'/) || [])[1]; } catch (e) { /* 前は無かった */ }
    if (before && before === swVersion) {
      problems.push(`アプリのファイルが変わったのに版の番号が ${swVersion} のままです（${appChanged.join(', ')}）。sw.js と app.js の番号を上げてください`);
    }
  }
}

if (problems.length) {
  console.log('✗ 点検で止まりました');
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}
console.log(`✓ 点検 OK（版 ${swVersion}）`);
