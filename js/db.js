// ที่เก็บข้อมูลในเครื่อง (IndexedDB) — เอกสาร หน้า โฟลเดอร์ และค่าตั้ง
const DB_NAME = 'docscan';
const DB_VERSION = 1;

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('docs', { keyPath: 'id' });
        db.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
        db.createObjectStore('folders', { keyPath: 'id' });
        db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function get(name, key) { return done((await store(name)).get(key)); }
export async function getAll(name) { return done((await store(name)).getAll()); }
export async function put(name, value, key) { return done((await store(name, 'readwrite')).put(value, key)); }
export async function del(name, key) { return done((await store(name, 'readwrite')).delete(key)); }

export async function pagesOf(doc) {
  const pages = await Promise.all(doc.pageIds.map((id) => get('pages', id)));
  return pages.filter(Boolean);
}

/** ลบเอกสารพร้อมทุกหน้าแบบถาวร */
export async function purgeDoc(doc) {
  const db = await openDb();
  const tx = db.transaction(['docs', 'pages'], 'readwrite');
  const pages = tx.objectStore('pages');
  const ids = await done(pages.index('docId').getAllKeys(doc.id));
  for (const id of ids) pages.delete(id);
  tx.objectStore('docs').delete(doc.id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta(key, fallback) {
  const v = await get('meta', key);
  return v === undefined ? fallback : v;
}
export const setMeta = (key, value) => put('meta', value, key);
