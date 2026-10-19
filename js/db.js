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

/*
 * รูปภาพเก็บเป็น ArrayBuffer แทน Blob: Safari บน iPhone บางครั้งอ่าน Blob ที่เก็บใน IndexedDB ไม่ได้
 * (โดยเฉพาะหลังแอปอัปเดต/เปิดใหม่) ทำให้ "เปิดภาพไม่ได้" · อ่านออกมาแล้วแปลงกลับเป็น Blob ให้ใช้เหมือนเดิม
 */
async function encode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  for (const [k, v] of Object.entries(value)) {
    if (!(v instanceof Blob)) continue;
    try {
      out[k] = { __blob: 1, type: v.type, buf: await v.arrayBuffer() };
    } catch {
      out[k] = v; // อ่านไม่ได้ (Blob เสียอยู่แล้ว): เก็บแบบเดิมไว้
    }
  }
  return out;
}

function decode(value) {
  if (!value || typeof value !== 'object') return value;
  for (const [k, v] of Object.entries(value)) {
    if (v && v.__blob === 1) value[k] = new Blob([v.buf], { type: v.type });
  }
  return value;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function get(name, key) { return decode(await done((await store(name)).get(key))); }
export async function getAll(name) { return (await done((await store(name)).getAll())).map(decode); }
export async function put(name, value, key) {
  const v = await encode(value); // แปลงก่อนเปิด transaction (await ระหว่าง transaction จะทำให้มันปิดเอง)
  return done((await store(name, 'readwrite')).put(v, key));
}

/** แปลงรูปที่เก็บแบบ Blob (ข้อมูลจากเวอร์ชันก่อน) ให้เป็นแบบใหม่ · คืนจำนวนรูปที่อ่านไม่ได้ */
export async function migrateBlobs() {
  let broken = 0;
  for (const name of ['pages', 'docs']) {
    const rows = await done((await store(name)).getAll());
    for (const row of rows) {
      const blobs = Object.entries(row).filter(([, v]) => v instanceof Blob);
      if (!blobs.length) continue;
      const enc = await encode(row);
      broken += blobs.filter(([k]) => enc[k] instanceof Blob).length;
      await done((await store(name, 'readwrite')).put(enc));
    }
  }
  return broken;
}
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
