// งานประมวลผลภาพด้วย OpenCV — ทำใน worker เพื่อไม่ให้หน้าจอค้าง
// detect: หาขอบกระดาษ 4 มุม · process: ดัดภาพให้ตรง + ฟิลเตอร์ + หมุน
self.importScripts('../vendor/opencv.js');

let cv;
// Module ของ OpenCV มีเมธอด then ของตัวเอง (await ตรง ๆ จะวนไม่จบ) จึงลบทิ้งหลังพร้อมใช้งาน
const ready = new Promise((resolve) => {
  self.cv.then((m) => { delete m.then; cv = m; resolve(); });
});

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    await ready;
    let result = true;
    let transfer = [];
    if (type === 'detect') result = detect(e.data.image);
    else if (type === 'process') {
      result = process(e.data);
      transfer = [result.data];
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    const msg = typeof err === 'number' && cv?.exceptionFromPtr ? cv.exceptionFromPtr(err).msg : String(err?.message || err);
    self.postMessage({ id, ok: false, error: msg });
  }
};

function toMat(image) {
  const m = new cv.Mat(image.h, image.w, cv.CV_8UC4);
  m.data.set(new Uint8Array(image.data));
  return m;
}

/* ---------- หาขอบกระดาษ ---------- */

function detect(image) {
  const { w, h } = image;
  const src = toMat(image);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  src.delete();
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  let quad = null;
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  // ลองหลายค่าความไว: ภาพคมชัด → ภาพแสงน้อย/ขอบจาง
  for (const [lo, hi] of [[40, 120], [20, 60], [70, 200]]) {
    cv.Canny(gray, edges, lo, hi);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    quad = findQuad(edges, w * h);
    if (quad) break;
  }
  kernel.delete();
  edges.delete();
  // สำรอง: แยกกระดาษสีขาวออกจากพื้นหลังด้วยความสว่าง
  if (!quad) {
    const th = new cv.Mat();
    cv.threshold(gray, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    quad = findQuad(th, w * h);
    th.delete();
  }
  gray.delete();
  return quad ? orderCorners(quad).map(([x, y]) => [x / w, y / h]) : null;
}

function findQuad(bin, totalArea) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const hull = new cv.Mat();
  const approx = new cv.Mat();
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    cv.convexHull(c, hull);
    c.delete();
    const hullArea = cv.contourArea(hull);
    if (hullArea < totalArea * 0.12 || hullArea <= bestArea) continue;
    const peri = cv.arcLength(hull, true);
    for (const eps of [0.02, 0.035, 0.05, 0.07]) {
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows <= 4) break;
    }
    if (approx.rows !== 4) continue;
    const area = cv.contourArea(approx);
    // ไม่เอากรอบที่ใหญ่เท่าภาพทั้งภาพ (มักเป็นขอบภาพเอง)
    if (area > bestArea && area < totalArea * 0.97) {
      bestArea = area;
      const d = approx.data32S;
      best = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]];
    }
  }
  contours.delete(); hier.delete(); hull.delete(); approx.delete();
  return best;
}

/** เรียงมุมเป็น บนซ้าย → บนขวา → ล่างขวา → ล่างซ้าย */
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  sorted.forEach((p, i) => { if (p[0] + p[1] < sorted[start][0] + sorted[start][1]) start = i; });
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

/* ---------- ดัดภาพ + ฟิลเตอร์ ---------- */

function process({ image, corners, filter, rotation, contrast = 0.5 }) {
  let mat = toMat(image);
  if (corners) {
    const p = corners.map(([x, y]) => [x * image.w, y * image.h]);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const w = Math.max(1, Math.round(Math.max(dist(p[0], p[1]), dist(p[3], p[2]))));
    const h = Math.max(1, Math.round(Math.max(dist(p[0], p[3]), dist(p[1], p[2]))));
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, p.flat());
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const M = cv.getPerspectiveTransform(from, to);
    const warped = new cv.Mat();
    cv.warpPerspective(mat, warped, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    from.delete(); to.delete(); M.delete(); mat.delete();
    mat = warped;
  }

  mat = applyFilter(mat, filter, contrast);

  if (rotation) {
    const code = { 90: cv.ROTATE_90_CLOCKWISE, 180: cv.ROTATE_180, 270: cv.ROTATE_90_COUNTERCLOCKWISE }[rotation];
    const r = new cv.Mat();
    cv.rotate(mat, r, code);
    mat.delete();
    mat = r;
  }

  if (mat.channels() !== 4) {
    const r = new cv.Mat();
    cv.cvtColor(mat, r, mat.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
    mat.delete();
    mat = r;
  }
  const out = { w: mat.cols, h: mat.rows, data: mat.data.slice().buffer };
  mat.delete();
  return out;
}

function applyFilter(rgba, filter, contrast) {
  if (!filter || filter === 'original') return rgba;
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  rgba.delete();
  const flat = flattenLight(rgb);
  rgb.delete();
  if (filter === 'color') {
    levels(flat, contrast);
    return flat;
  }
  const gray = new cv.Mat();
  cv.cvtColor(flat, gray, cv.COLOR_RGB2GRAY);
  flat.delete();
  levels(gray, contrast);
  if (filter === 'gray') return gray;
  // ขาวดำคมชัด
  let block = Math.round(Math.min(gray.cols, gray.rows) / 40);
  block = Math.max(15, block % 2 ? block : block + 1);
  const bw = new cv.Mat();
  cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 10);
  gray.delete();
  return bw;
}

/**
 * ปรับระดับแสง: ค่าที่สว่างกว่าจุดขาวกลายเป็นขาวล้วน (เงาจาง ๆ ที่เหลือหายไป)
 * และค่าที่มืดกว่าจุดดำกลายเป็นดำ (ตัวหนังสือเข้มขึ้น) · contrast 0..1 (0.5 = ค่าเริ่มต้น)
 */
function levels(mat, contrast) {
  const s = Math.min(1, Math.max(0, contrast));
  const lo = 15 + 70 * s;
  const hi = 250 - 75 * s;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
  const d = mat.data;
  for (let i = 0; i < d.length; i++) d[i] = lut[d[i]];
}

/** ลบเงา/แสงไม่สม่ำเสมอ: ประมาณสีพื้นกระดาษจากภาพย่อ แล้วหารออก ให้พื้นขาวทั้งแผ่น */
function flattenLight(rgb) {
  // ย่อน้อยลง (เดิม 1/8) ให้ตามขอบเงาที่คมได้ใกล้ขึ้น
  // close (dilate แล้ว erode) ลบตัวหนังสือออกจากภาพพื้น แต่คงตำแหน่งขอบเงาไว้ ไม่เกิดเส้นเทาตามขอบ
  const f = 5;
  const small = new cv.Mat();
  cv.resize(rgb, small, new cv.Size(Math.max(1, Math.round(rgb.cols / f)), Math.max(1, Math.round(rgb.rows / f))), 0, 0, cv.INTER_AREA);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  cv.morphologyEx(small, small, cv.MORPH_CLOSE, k);
  k.delete();
  cv.medianBlur(small, small, 7);
  const bg = new cv.Mat();
  cv.resize(small, bg, rgb.size(), 0, 0, cv.INTER_LINEAR);
  small.delete();
  const out = new cv.Mat();
  cv.divide(rgb, bg, out, 255);
  bg.delete();
  return out;
}
