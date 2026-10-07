// commit のときの点検（tools/git-hooks）を有効にする。npm ci / npm install のときに勝手に走る。
// git は .git/hooks の中身を配れないので、リポジトリに入れたフォルダを使うよう向け先（core.hooksPath）を変える。
// 利用者が git の設定を知らなくても効くようにするのが目的。
// git が無い所やリポジトリでない所では、何もせず黙って終わる（npm ci を失敗させない）。
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WANT = 'tools/git-hooks';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' });
} catch (e) {
  process.exit(0); // git リポジトリではない
}

let now = '';
try {
  now = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch (e) { /* まだ設定が無い */ }

if (now === WANT) process.exit(0);

if (now) {
  // 別の向け先が既にある（利用者が自分で入れたもの）。黙って上書きしない
  console.log(`! commit のときの点検を入れられませんでした: core.hooksPath が ${now} になっています`);
  console.log(`  個人の情報の点検を効かせるには: git config core.hooksPath ${WANT}`);
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', WANT], { cwd: ROOT, stdio: 'ignore' });
  console.log('✓ commit のときの点検を有効にしました（個人の情報が入りそうなら止まります）');
} catch (e) {
  console.log('! commit のときの点検を入れられませんでした:', e.message);
}
