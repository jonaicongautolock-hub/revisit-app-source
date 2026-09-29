// 端末内の保存（IndexedDB）。サーバーには何も送らない。
// 件数は多くて数百人なので、起動時に全部読んで画面はメモリ上の配列を使い、書き込みだけ IndexedDB へ通す。
//
// people  … 相手1人に1件。場所・段階・次の約束はここに持つ
// visits  … 訪問1回に1件（personId で人に付く）。回数の制限なし
// meta    … 最後にバックアップした日など
//
// 日時は "YYYY-MM-DDTHH:mm" の端末の時刻の文字列で持つ（datetime-local の値そのまま）。
// 文字列の大小比較がそのまま時刻の前後になり、タイムゾーンの換算が要らない。
const Store = (() => {
  const DB_NAME = 'revisit-notes';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('people')) db.createObjectStore('people', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('visits')) {
          db.createObjectStore('visits', { keyPath: 'id' }).createIndex('personId', 'personId');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // 1つのトランザクションで fn(stores) を走らせ、完了（書き込みの確定）まで待つ
  async function run(names, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const stores = {};
      for (const n of names) stores[n] = tx.objectStore(n);
      let result;
      Promise.resolve(fn(stores)).then(r => { result = r; }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
    });
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function loadAll() {
    return run(['people', 'visits', 'meta'], 'readonly', async s => {
      const [people, visits, meta] = await Promise.all([
        reqP(s.people.getAll()), reqP(s.visits.getAll()), reqP(s.meta.getAll()),
      ]);
      const m = {};
      for (const row of meta) m[row.key] = row.value;
      return { people, visits, meta: m };
    });
  }

  const putPerson = p => run(['people'], 'readwrite', s => { s.people.put(p); });
  const putVisit = v => run(['visits'], 'readwrite', s => { s.visits.put(v); });
  const deleteVisit = id => run(['visits'], 'readwrite', s => { s.visits.delete(id); });
  const setMeta = (key, value) => run(['meta'], 'readwrite', s => { s.meta.put({ key, value }); });

  // 人と、その人の訪問を一緒に書く（記録の保存で次の約束も変わるため）
  const putPersonAndVisit = (p, v) => run(['people', 'visits'], 'readwrite', s => {
    s.people.put(p);
    s.visits.put(v);
  });

  const deletePerson = id => run(['people', 'visits'], 'readwrite', async s => {
    s.people.delete(id);
    const keys = await reqP(s.visits.index('personId').getAllKeys(id));
    for (const k of keys) s.visits.delete(k);
  });

  // バックアップの読み込み。同じ id は updatedAt の新しい方を残す（端末の記録を古い控えで潰さない）
  const merge = (people, visits) => run(['people', 'visits'], 'readwrite', async s => {
    let added = 0, updated = 0, kept = 0;
    const one = async (store, row) => {
      const cur = await reqP(store.get(row.id));
      if (!cur) { store.put(row); added++; }
      else if ((row.updatedAt || '') > (cur.updatedAt || '')) { store.put(row); updated++; }
      else kept++;
    };
    for (const p of people) await one(s.people, p);
    for (const v of visits) await one(s.visits, v);
    return { added, updated, kept };
  });

  return { loadAll, putPerson, putVisit, putPersonAndVisit, deleteVisit, deletePerson, setMeta, merge };
})();
