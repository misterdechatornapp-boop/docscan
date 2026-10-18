// งานประมวลผลภาพด้วย OpenCV — ทำใน worker เพื่อไม่ให้หน้าจอค้าง
// detect: หาขอบกระดาษ 4 มุม + จุดกลางขอบ (ขอบโค้ง) · process: ดัดภาพให้ตรง + ฟิลเตอร์ + หมุน
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

/** คืน { corners, mids } แบบสัดส่วน 0..1 หรือ null · mids = จุดกลางขอบ [บน, ขวา, ล่าง, ซ้าย] */
function detect(image) {
  const { w, h } = image;
  const src = toMat(image);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  src.delete();
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  let found = null;
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  // ลองหลายค่าความไว: ภาพคมชัด → ภาพแสงน้อย/ขอบจาง
  for (const [lo, hi] of [[40, 120], [20, 60], [70, 200]]) {
    cv.Canny(gray, edges, lo, hi);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    found = findQuad(edges, w * h);
    if (found) break;
  }
  kernel.delete();
  edges.delete();
  // สำรอง: แยกกระดาษสีขาวออกจากพื้นหลังด้วยความสว่าง
  if (!found) {
    const th = new cv.Mat();
    cv.threshold(gray, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    found = findQuad(th, w * h);
    th.delete();
  }
  gray.delete();
  if (!found) return null;
  const corners = orderCorners(found.quad);
  const mids = edgeMids(corners, found.contour);
  const norm = ([x, y]) => [x / w, y / h];
  return { corners: corners.map(norm), mids: mids ? mids.map(norm) : null };
}

function findQuad(bin, totalArea) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
  const hull = new cv.Mat();
  const approx = new cv.Mat();
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    cv.convexHull(c, hull);
    const hullArea = cv.contourArea(hull);
    if (hullArea < totalArea * 0.12 || hullArea <= bestArea) { c.delete(); continue; }
    const peri = cv.arcLength(hull, true);
    for (const eps of [0.02, 0.035, 0.05, 0.07]) {
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows <= 4) break;
    }
    const area = approx.rows === 4 ? cv.contourArea(approx) : 0;
    // ไม่เอากรอบที่ใหญ่เท่าภาพทั้งภาพ (มักเป็นขอบภาพเอง)
    if (approx.rows === 4 && area > bestArea && area < totalArea * 0.97) {
      bestArea = area;
      const d = approx.data32S;
      best = { quad: [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]], contour: Int32Array.from(c.data32S) };
    }
    c.delete();
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

const EDGES = [[0, 1], [1, 2], [3, 2], [0, 3]]; // บน ขวา ล่าง ซ้าย

/**
 * หาจุดกลางของขอบแต่ละด้านจากเส้นขอบจริงของกระดาษ (สำหรับกระดาษโค้ง)
 * ใช้เฉพาะช่วงเส้นขอบที่อยู่ระหว่างมุมสองมุมของด้านนั้น · คืน null ถ้าทุกด้านตรง
 */
function edgeMids(corners, contour) {
  const n = contour.length / 2;
  const nearest = ([x, y]) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (contour[2 * i] - x) ** 2 + (contour[2 * i + 1] - y) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const idx = corners.map(nearest);
  let curved = false;
  const mids = EDGES.map(([a, b], e) => {
    const A = corners[a], B = corners[b];
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L = Math.hypot(dx, dy);
    if (L < 10) return mid;
    const nx = -dy / L, ny = dx / L;
    // ช่วงของเส้นขอบระหว่างสองมุม (ทางที่ไม่ผ่านมุมอื่น)
    const others = idx.filter((_, k) => k !== a && k !== b);
    const fwd = (from, to) => { const out = []; for (let i = from; i !== to; i = (i + 1) % n) out.push(i); return out; };
    let seg = fwd(idx[a], idx[b]);
    if (others.some((o) => seg.includes(o))) seg = fwd(idx[b], idx[a]);
    if (others.some((o) => seg.includes(o))) return mid;
    const offs = [];
    for (const i of seg) {
      const px = contour[2 * i] - A[0], py = contour[2 * i + 1] - A[1];
      const t = (px * dx + py * dy) / (L * L);
      if (t < 0.42 || t > 0.58) continue;
      offs.push(px * nx + py * ny);
    }
    if (offs.length < 3) return mid;
    offs.sort((p, q) => p - q);
    const med = offs[offs.length >> 1];
    // โค้งน้อยมาก = ถือว่าตรง · โค้งมากเกินจริง = น่าจะจับผิด
    if (Math.abs(med) < 0.012 * L || Math.abs(med) > 0.2 * L) return mid;
    curved = true;
    return [mid[0] + nx * med, mid[1] + ny * med];
  });
  return curved ? mids : null;
}

/* ---------- ดัดภาพ + ฟิลเตอร์ ---------- */

function process({ image, corners, mids, filter, rotation, contrast = 0.5 }) {
  let mat = toMat(image);
  if (corners) {
    const p = corners.map(([x, y]) => [x * image.w, y * image.h]);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const w = Math.max(1, Math.round(Math.max(dist(p[0], p[1]), dist(p[3], p[2]))));
    const h = Math.max(1, Math.round(Math.max(dist(p[0], p[3]), dist(p[1], p[2]))));
    // ขอบโค้งอาจป่องออกนอกกรอบมุม จึงเผื่อขอบรอบภาพไว้ให้เส้นโค้งดึงพิกเซลจริงได้
    const pad = mids ? Math.round(0.2 * Math.max(w, h)) : 0;
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, p.flat());
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [pad, pad, pad + w, pad, pad + w, pad + h, pad, pad + h]);
    const M = cv.getPerspectiveTransform(from, to);
    const warped = new cv.Mat();
    cv.warpPerspective(mat, warped, M, new cv.Size(w + 2 * pad, h + 2 * pad), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    mat.delete();
    mat = warped;
    if (mids) {
      const m = M.data64F;
      const project = ([x, y]) => {
        const X = x * image.w, Y = y * image.h;
        const z = m[6] * X + m[7] * Y + m[8];
        return [(m[0] * X + m[1] * Y + m[2]) / z, (m[3] * X + m[4] * Y + m[5]) / z];
      };
      const bent = straightenCurves(mat, w, h, pad, mids.map(project));
      mat.delete();
      mat = bent;
    }
    from.delete(); to.delete(); M.delete();
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

/**
 * กระดาษโค้ง: หลังดัดมุมแล้วขอบยังโค้งอยู่ ใช้ Coons patch ยืดขอบโค้งทั้ง 4 ด้านให้เป็นเส้นตรง
 * บรรทัดตัวหนังสือด้านในถูกดัดตามสัดส่วนระหว่างขอบบน-ล่าง และซ้าย-ขวา
 * src = ภาพที่ดัดมุมแล้ว โดยกระดาษอยู่ที่ (pad, pad) ขนาด w × h · midsR = จุดกลางขอบ [บน, ขวา, ล่าง, ซ้าย] ในภาพนั้น
 * ถ้าขอบตรงอยู่แล้ว ตัดเฉพาะส่วนกระดาษออกมาเฉย ๆ
 */
function straightenCurves(src, w, h, pad, midsR) {
  const o = pad;
  const P00 = [o, o], P10 = [o + w, o], P11 = [o + w, o + h], P01 = [o, o + h];
  const chordMid = [[o + w / 2, o], [o + w, o + h / 2], [o + w / 2, o + h], [o, o + h / 2]];
  const dev = Math.max(...midsR.map((m, i) => Math.hypot(m[0] - chordMid[i][0], m[1] - chordMid[i][1])));
  if (dev < 0.004 * Math.max(w, h)) return src.roi(new cv.Rect(o, o, w, h)).clone();

  // จุดควบคุมของเส้นโค้ง Bezier กำลังสองที่ผ่านจุดกลางขอบ: C = 2M − (A + B) / 2
  const ctrl = (M, A, B) => [2 * M[0] - (A[0] + B[0]) / 2, 2 * M[1] - (A[1] + B[1]) / 2];
  const [mT, mR, mB, mL] = midsR;
  const cT = ctrl(mT, P00, P10), cB = ctrl(mB, P01, P11), cL = ctrl(mL, P00, P01), cR = ctrl(mR, P10, P11);
  const bez = (A, C, B, t) => {
    const s = 1 - t;
    return [s * s * A[0] + 2 * s * t * C[0] + t * t * B[0], s * s * A[1] + 2 * s * t * C[1] + t * t * B[1]];
  };
  const arc = (A, C, B) => {
    let L = 0, prev = A;
    for (let i = 1; i <= 24; i++) {
      const p = bez(A, C, B, i / 24);
      L += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      prev = p;
    }
    return L;
  };
  // ขนาดผลลัพธ์ใช้ความยาวตามเส้นโค้ง (กระดาษที่โค้งยาวกว่าระยะตรง)
  const W = Math.max(2, Math.round(Math.max(arc(P00, cT, P10), arc(P01, cB, P11))));
  const H = Math.max(2, Math.round(Math.max(arc(P00, cL, P01), arc(P10, cR, P11))));

  const top = new Float32Array(W * 2), bot = new Float32Array(W * 2);
  for (let x = 0; x < W; x++) {
    const u = x / (W - 1);
    const t = bez(P00, cT, P10, u), b = bez(P01, cB, P11, u);
    top[2 * x] = t[0]; top[2 * x + 1] = t[1];
    bot[2 * x] = b[0]; bot[2 * x + 1] = b[1];
  }
  const left = new Float32Array(H * 2), right = new Float32Array(H * 2);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    const l = bez(P00, cL, P01, v), r = bez(P10, cR, P11, v);
    left[2 * y] = l[0]; left[2 * y + 1] = l[1];
    right[2 * y] = r[0]; right[2 * y + 1] = r[1];
  }

  const mapX = new cv.Mat(H, W, cv.CV_32FC1);
  const mapY = new cv.Mat(H, W, cv.CV_32FC1);
  const mx = mapX.data32F, my = mapY.data32F;
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1), sv = 1 - v;
    const lx = left[2 * y], ly = left[2 * y + 1], rx = right[2 * y], ry = right[2 * y + 1];
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1), su = 1 - u;
      const i = y * W + x;
      // Coons: ผสมขอบบน-ล่าง + ขอบซ้าย-ขวา แล้วหักส่วนที่นับซ้ำ (บิลิเนียร์ของมุม = (o + u·w, o + v·h))
      mx[i] = sv * top[2 * x] + v * bot[2 * x] + su * lx + u * rx - (o + u * w);
      my[i] = sv * top[2 * x + 1] + v * bot[2 * x + 1] + su * ly + u * ry - (o + v * h);
    }
  }
  const out = new cv.Mat();
  cv.remap(src, out, mapX, mapY, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  mapX.delete();
  mapY.delete();
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
