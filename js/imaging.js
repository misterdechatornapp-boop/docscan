// โหลดภาพ ย่อขนาด แปลงเป็นไฟล์ และเรียกงาน OpenCV ใน worker
export const MAX_SIDE = 2800;   // ด้านยาวสุดของภาพที่เก็บ (พอสำหรับพิมพ์ A4 ~ 300 dpi)
export const THUMB_SIDE = 360;

export async function loadCanvas(blob, maxSide = MAX_SIDE) {
  const url = URL.createObjectURL(blob);
  try {
    // ใช้ onload แทน img.decode() เพราะ decode() อาจค้างเมื่อหน้าจอไม่ได้วาด
    // (drawImage ของ <img> หมุนภาพตามข้อมูล EXIF จากกล้องให้เอง)
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('เปิดภาพไม่ได้'));
      im.src = url;
    });
    return drawScaled(img, img.naturalWidth, img.naturalHeight, maxSide);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function scaleCanvas(src, maxSide) {
  return drawScaled(src, src.width, src.height, maxSide);
}

function drawScaled(source, w, h, maxSide) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

export const toBlob = (canvas, quality = 0.85) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

/** คืนหน่วยความจำของ canvas ทันที (สำคัญบน iPhone ที่จำกัดหน่วยความจำ canvas) */
export function freeCanvas(c) {
  if (c) { c.width = 0; c.height = 0; }
}

/* ---------- worker ---------- */

let worker;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker('js/cv-worker.js');
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'worker error'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function call(type, payload = {}, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, ...payload }, transfer);
  });
}

function imagePayload(canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  return { w: canvas.width, h: canvas.height, data: data.buffer };
}

/** โหลด OpenCV ล่วงหน้า (ไฟล์ใหญ่ ~10 MB) */
export const warmup = () => call('init');

/** หาขอบกระดาษ คืนมุม 4 จุดแบบสัดส่วน 0..1 หรือ null ถ้าหาไม่เจอ */
export async function detectCorners(canvas) {
  const small = scaleCanvas(canvas, 640);
  const image = imagePayload(small);
  freeCanvas(small);
  return call('detect', { image }, [image.data]);
}

/** ดัดภาพ + ฟิลเตอร์ + หมุน คืนเป็น canvas ใหม่ */
export async function processCanvas(canvas, { corners, filter, rotation }) {
  const image = imagePayload(canvas);
  const r = await call('process', { image, corners: isFullFrame(corners) ? null : corners, filter, rotation }, [image.data]);
  const out = document.createElement('canvas');
  out.width = r.w;
  out.height = r.h;
  out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
  return out;
}

export const FULL_FRAME = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** มุมเริ่มต้นเมื่อหาขอบไม่เจอ: ทั้งภาพ */
export const isFullFrame = (c) => !c || c.every((p, i) => Math.abs(p[0] - FULL_FRAME[i][0]) < 1e-3 && Math.abs(p[1] - FULL_FRAME[i][1]) < 1e-3);
