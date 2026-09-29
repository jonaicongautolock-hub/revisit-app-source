// バックアップファイルの作成と読み込み。
// 端末の中にしか記録が無いので、機種変更・紛失・誤って消したときの備えはこのファイルだけ。
// パスワードを付けると AES-GCM で暗号化する（鍵は PBKDF2 でパスワードから作る）。
// パスワードは保存しない — 忘れると開けない。
const Backup = (() => {
  const FORMAT = 'revisit-notes-backup';
  const VERSION = 1;
  const ITER = 210000;

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // 大きな配列を String.fromCharCode(...) に渡すと引数の数の上限で落ちるので分けて変換する
  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function build(data, password) {
    const body = { format: FORMAT, version: VERSION, exportedAt: data.exportedAt, people: data.people, visits: data.visits };
    if (!password) return JSON.stringify(body);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(body)));
    return JSON.stringify({
      format: FORMAT, version: VERSION, encrypted: true, exportedAt: data.exportedAt,
      kdf: 'PBKDF2-SHA256', iterations: ITER, salt: b64(salt), iv: b64(iv),
      data: bytesToB64(new Uint8Array(ct)),
    });
  }

  // 中身を読む。暗号化されていれば needsPassword を返し、パスワード付きで呼び直してもらう
  async function parse(text, password) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('バックアップのファイルではありません'); }
    if (!obj || obj.format !== FORMAT) throw new Error('再訪問ノートのバックアップではありません');
    if (obj.encrypted) {
      if (!password) return { needsPassword: true, exportedAt: obj.exportedAt };
      let plain;
      try {
        const key = await deriveKey(password, unb64(obj.salt));
        plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, key, unb64(obj.data));
      } catch (e) {
        throw new Error('パスワードが違います');
      }
      obj = JSON.parse(dec.decode(plain));
    }
    if (!Array.isArray(obj.people) || !Array.isArray(obj.visits)) throw new Error('バックアップの中身が壊れています');
    return { people: obj.people, visits: obj.visits, exportedAt: obj.exportedAt };
  }

  return { build, parse };
})();
