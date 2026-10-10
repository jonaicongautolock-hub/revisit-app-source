// 公開リポジトリに個人の情報（訪問先の方の名前・電話・住所、書き出したバックアップ、端末の画面写真）が
// 入るのを機械的に止める。記録は端末の IndexedDB の中だけにあるもので、git に入ってよい理由は無い。
// 一度 push すると履歴からは消せない（fork や各種の控えにも残る）ので、commit の時点で止める。
//   node tools/check-private.js --staged         これから commit する中身（pre-commit フック）
//   node tools/check-private.js --msg <ファイル>  commit のメッセージ（commit-msg フック）
//   node tools/check-private.js --tree           いま git に入っているファイル全部（npm run check）
// 止まったら、入れてしまったファイルを `git restore --staged <ファイル>` で index から外す。
// 人が自分の判断で通すときだけ `git commit --no-verify`（AI には .claude/settings.json で禁じてある）。
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28, encoding: 'utf8', ...opts });

const problems = [];   // これがあると止める
const warnings = [];   // 知らせるだけ（止めない）

// バックアップの中身を見分ける印（backup.js の FORMAT と同じ）
const BACKUP_FORMAT = 'revisit-notes-backup';

// 名前だけで分かるもの
const BACKUP_NAME = /(^|\/)(再訪問ノート_.*\.json|.*バックアップ.*\.json|.*\.backup\.json|backup.*\.json)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff?|pdf)$/i;

// 中身は調べないファイル（機械が作るもの・同梱のライブラリ・この点検そのもの）
const skipContent = p =>
  p === 'package-lock.json' || p === 'muni.json' ||
  p === 'tools/check-private.js' || /^(vendor|icons)\//.test(p);

// --- 文字の中から探すもの ---

// 電話番号らしい並び。数字だけにして 10 桁（固定）か 11 桁（携帯）で、先頭が 0 のときだけ。
// 日付（2026-10-14）や版の番号（0.34.5）に当たらないよう、桁数で絞っている。
function findPhone(text) {
  const hits = [];
  for (const m of text.matchAll(/(?<!\w)0[\d-]{8,12}(?!\w)/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length === 10 || digits.length === 11) hits.push(m[0]);
  }
  return hits;
}

// メールアドレス。差し替え用のもの（noreply・example）は通す。
const MAIL_OK = [
  /@users\.noreply\.github\.com$/,
  /^noreply@anthropic\.com$/,
  /^git@github\.com$/, // 人のアドレスではなく、GitHub へ SSH でつなぐときの決まった宛先（公開用へ送るのに使う）
  /@example\.(com|org|net|jp)$/,
  /@test\.(local|invalid)$/,
];
function findMail(text) {
  return [...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)]
    .map(m => m[0])
    .filter(a => !MAIL_OK.some(r => r.test(a)));
}

// 住所らしい文字。町名まで（例: 小倉北区城内、京町3丁目）は公の地名で、地図の試験でも使うので見ない。
// 住居が特定できるところまで書かれているもの（丁目のあとの番号・番地・号室）と郵便番号を見る。
function findAddress(text) {
  return [...text.matchAll(/\d+\s*丁目\s*\d|\d+\s*番地|\d+\s*号室|〒\s*\d{3}-?\d{4}/g)].map(m => m[0]);
}

// 実在の人を指す書き方。姓は漢字 2〜4 字が多いので、そこに「さん・様・氏」が付くものを見る。
// 「客さん」「奥さん」のような 1 字のものは初めから当たらない。
// 役割を表す言い方（担当者・運転手・店主…）は人の名前ではないので通す。
// 姓がこれらの字で終わることはほぼ無いので、接尾辞で見分ければ表を増やし続けなくてよい。
const ROLE_SUFFIX = /[者員師長係手主屋人]$/;
const ROLE_WORDS = new Set(['店員', '患者', '業者', '職員', '担当', '大家', '近所', '兄弟', '姉妹', '家族']);
function findPersonName(text) {
  return [...text.matchAll(/([一-龥]{2,4})(さん|様|氏)/g)]
    .filter(m => !ROLE_WORDS.has(m[1]) && !ROLE_SUFFIX.test(m[1]))
    .map(m => m[0]);
}

function report(into, hits, label, where) {
  const uniq = [...new Set(hits)];
  if (!uniq.length) return;
  const shown = uniq.slice(0, 3).join(' / ');
  const more = uniq.length > 3 ? ` ほか ${uniq.length - 3} 件` : '';
  into.push(`${where}: ${label}（${shown}${more}）`);
}

// ファイル名だけで決まる判定
function checkName(p) {
  if (BACKUP_NAME.test(p)) {
    problems.push(`${p}: バックアップのファイルは git に入れません（相手の名前と訪問の記録が入っています）`);
    return true;
  }
  if (p.startsWith('test-output/')) {
    problems.push(`${p}: 試験の画面写真は git に入れません（画面に記録が写っています）`);
    return true;
  }
  if (IMAGE.test(p) && !/^(icons|vendor)\//.test(p)) {
    problems.push(`${p}: 画面写真らしい画像は git に入れません（アイコンなら icons/ に置きます）`);
    return true;
  }
  return false;
}

// 中身がバックアップそのものかどうか（名前を変えて置かれても見分ける）
function checkBackupBody(p, text) {
  if (!/[[{]/.test(text.slice(0, 200))) return false;
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return false; }
  if (!obj || typeof obj !== 'object') return false;
  if (obj.format === BACKUP_FORMAT || (Array.isArray(obj.people) && Array.isArray(obj.visits))) {
    problems.push(`${p}: 中身が再訪問ノートのバックアップです。git に入れません`);
    return true;
  }
  return false;
}

// 文字の中身を見る。コードの中の「◯◯さん」は試験の架空の名前のこともあるので知らせるだけ。
function checkText(text, where, { nameBlocks = false } = {}) {
  report(problems, findPhone(text), '電話番号らしい並びがあります', where);
  report(problems, findMail(text), 'メールアドレスがあります', where);
  report(problems, findAddress(text), '番地まで入った住所があります', where);
  report(nameBlocks ? problems : warnings, findPersonName(text), '実在の人の名前らしい書き方があります', where);
}

function stagedBlob(p) {
  try { return git(['show', `:${p}`], { encoding: 'buffer' }); } catch (e) { return null; }
}

function addedLines(p) {
  let out = '';
  try { out = git(['diff', '--cached', '-U0', '--no-color', '--', p]); } catch (e) { return ''; }
  return out.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n');
}

function runStaged() {
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0').filter(Boolean);
  for (const p of names) {
    if (checkName(p)) continue;
    if (skipContent(p)) continue;
    const buf = stagedBlob(p);
    if (!buf || buf.includes(0)) continue;               // 読めない・中身が文字でないものは飛ばす
    if (checkBackupBody(p, buf.toString('utf8'))) continue;
    checkText(addedLines(p), `${p}（足した行）`);
  }
}

function runMessage(file) {
  const fs = require('fs');
  const raw = fs.readFileSync(file, 'utf8');
  // git が付ける案内（# で始まる行）は人が書いた文ではないので外す
  const text = raw.split('\n').filter(l => !l.startsWith('#')).join('\n');
  checkText(text, 'commit のメッセージ', { nameBlocks: true });
}

function runTree() {
  for (const p of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    if (checkName(p)) continue;
    if (skipContent(p)) continue;
    const buf = stagedBlob(p);
    if (!buf || buf.includes(0)) continue;
    const text = buf.toString('utf8');
    if (checkBackupBody(p, text)) continue;
    checkText(text, p);
  }
}

const mode = process.argv[2] || '--staged';
if (mode === '--staged') runStaged();
else if (mode === '--msg') runMessage(process.argv[3]);
else if (mode === '--tree') runTree();
else {
  console.log('使い方: node tools/check-private.js [--staged | --msg <ファイル> | --tree]');
  process.exit(2);
}

for (const w of warnings) console.log('  ! 注意 —', w);

if (problems.length) {
  console.log('✗ 個人の情報が入りそうなので止めました（アプリのファイルは公開されます）');
  for (const p of problems) console.log('  -', p);
  console.log('');
  console.log('  記録は iPhone の中だけに置くものです。git に入れると履歴から消せません。');
  if (mode === '--staged') console.log('  入れないなら: git restore --staged <ファイル>');
  if (mode === '--msg') console.log('  メッセージから名前を外して、何をしたかだけ書いてください（例: 「◯◯さんの記録が…」→「記録が…」）');
  process.exit(1);
}
if (mode === '--tree') console.log('✓ 個人の情報は見つかりませんでした');
