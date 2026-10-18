// Service worker: เก็บไฟล์แอปทั้งหมดไว้ในเครื่อง เพื่อให้เปิดใช้ได้แม้ไม่มีอินเทอร์เน็ต
// เปลี่ยน VERSION ให้ตรงกับ js/config.js ทุกครั้งที่ปล่อยเวอร์ชันใหม่
const VERSION = '1.0.0';
const CACHE = `docscan-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/config.js',
  'js/db.js',
  'js/ui.js',
  'js/icons.js',
  'js/imaging.js',
  'js/editor.js',
  'js/exporter.js',
  'js/cv-worker.js',
  'vendor/opencv.js',
  'vendor/pdf-lib.esm.min.js',
  'vendor/sortable.esm.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
// ตอนพัฒนาบนเครื่อง ให้ดึงไฟล์ใหม่จากเซิร์ฟเวอร์ก่อนเสมอ (ไม่ติดแคชเก่า)
const DEV = ['localhost', '127.0.0.1'].includes(self.location.hostname);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(DEV ? networkFirst(req) : cacheFirst(req));
});

async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) return cached;
  try {
    return await fetch(req);
  } catch (err) {
    if (req.mode === 'navigate') return caches.match('index.html');
    throw err;
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
  }
}
