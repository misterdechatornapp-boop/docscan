// โหลดภาพ ย่อขนาด แปลงเป็นไฟล์ และเรียกงาน OpenCV ใน worker
export const MAX_SIDE = 2800;   // ด้านยาวสุดของภาพที่เก็บ (พอสำหรับพิมพ์ A4 ~ 300 dpi)
export const THUMB_SIDE = 360;

export async function loadCanvas(blob, maxSide = MAX_SIDE) {
  try {
    return await loadViaImage(blob, maxSide);
  } catch {
    // สำรอง: ถอดรหัสภาพอีกวิธี (ช่วยเมื่อ <img> เปิดไม่ได้เพราะหน่วยความจำ/ไฟล์ใหญ่)
    try {
      await new Promise((r) => setTimeout(r, 150));
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const c = drawScaled(bmp, bmp.width, bmp.height, maxSide);
      bmp.close?.();
      return c;
    } catch {
      throw new Error('เปิดภาพไม่ได้');
    }
  }
}

async function loadViaImage(blob, maxSide) {
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
    worker.onerror = (e) => resetWorker('ตัวประมวลผลภาพหยุดทำงาน' + (e.message ? ` (${e.message})` : ''));
  }
  return worker;
}

/** ปิด worker ที่เสีย แล้วแจ้งงานที่ค้างอยู่ทั้งหมด · ครั้งหน้าจะสร้างใหม่อัตโนมัติ */
function resetWorker(reason) {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(Object.assign(new Error(reason), { crashed: true }));
  pending.clear();
}

// เวลารอสูงสุดต่องาน: บน iPhone ถ้าหน่วยความจำไม่พอ worker อาจเงียบหายไปเลยโดยไม่แจ้ง error
const TIMEOUT = { init: 60000, detect: 20000, process: 60000 };

function call(type, payload = {}, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) resetWorker('ตัวประมวลผลภาพไม่ตอบสนอง');
    }, TIMEOUT[type] || 60000);
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    pending.set(id, { resolve: done(resolve), reject: done(reject) });
    getWorker().postMessage({ id, type, ...payload }, transfer);
  }).catch((err) => {
    // OpenCV ล้มภายใน (เช่น หน่วยความจำเต็ม) ทำให้ worker ใช้ต่อไม่ได้ → เริ่มใหม่
    if (!err.crashed && /abort|memory|oom/i.test(err.message)) resetWorker(err.message);
    throw Object.assign(err, { crashed: err.crashed || /abort|memory|oom/i.test(err.message) });
  });
}

/** เรียกงานหนัก: ถ้า worker ล้มกลางทาง เริ่ม worker ใหม่แล้วลองอีกครั้งเดียว */
async function callWithRetry(type, makePayload) {
  try {
    const p = makePayload();
    return await call(type, p, [p.image.data]);
  } catch (err) {
    if (!err.crashed) throw err;
    const p = makePayload();
    return call(type, p, [p.image.data]);
  }
}

function imagePayload(canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  return { w: canvas.width, h: canvas.height, data: data.buffer };
}

/** โหลด OpenCV ล่วงหน้า (ไฟล์ใหญ่ ~10 MB) */
export const warmup = () => call('init');

/** หาขอบกระดาษ คืน { corners } แบบสัดส่วน 0..1 หรือ null */
export async function detectPage(canvas) {
  const small = scaleCanvas(canvas, 640);
  try {
    return await callWithRetry('detect', () => ({ image: imagePayload(small) }));
  } finally {
    freeCanvas(small);
  }
}

/** หาเฉพาะมุม 4 จุด (ใช้กับกรอบสดในกล้อง) */
export const detectCorners = async (canvas) => (await detectPage(canvas))?.corners ?? null;

/** ดัดภาพ + ฟิลเตอร์ + หมุน คืนเป็น canvas ใหม่ */
export async function processCanvas(canvas, { corners, filter, rotation, contrast = 0.5, brightness = 0, sharpness = 0, straighten = false }) {
  const plain = isFullFrame(corners);
  const r = await callWithRetry('process', () => ({
    image: imagePayload(canvas), corners: plain ? null : corners, filter, rotation, contrast, brightness, sharpness, straighten,
  }));
  const out = document.createElement('canvas');
  out.width = r.w;
  out.height = r.h;
  out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data), r.w, r.h), 0, 0);
  return out;
}

export const FULL_FRAME = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** มุมเริ่มต้นเมื่อหาขอบไม่เจอ: ทั้งภาพ */
export const isFullFrame = (c) => !c || c.every((p, i) => Math.abs(p[0] - FULL_FRAME[i][0]) < 1e-3 && Math.abs(p[1] - FULL_FRAME[i][1]) < 1e-3);
