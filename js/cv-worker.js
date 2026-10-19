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

/** คืน { corners } แบบสัดส่วน 0..1 หรือ null */
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
  return { corners: orderCorners(found.quad).map(([x, y]) => [x / w, y / h]) };
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
      best = { quad: [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]] };
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

/* ---------- ดัดภาพ + ฟิลเตอร์ ---------- */

function process({ image, corners, filter, rotation, contrast = 0.5, brightness = 0, sharpness = 0, straighten = false }) {
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
    mat.delete();
    mat = warped;
    to.delete();
    from.delete();
    M.delete();
  }

  if (straighten) {
    const flat = straightenLines(mat);
    if (flat) { mat.delete(); mat = flat; }
  }

  mat = applyFilter(mat, { filter, contrast, brightness, sharpness });

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

/* ---------- ดัดเส้นให้ตรง (กระดาษป่อง/โค้งกลางแผ่น) ---------- */

/**
 * ใช้ "เส้นที่ควรตรง" ในเอกสารเป็นตัวอ้างอิง: เส้นตารางแนวนอน + แนวบรรทัดตัวหนังสือ (ควรเป็นแนวนอน)
 * และเส้นตารางแนวตั้ง (ควรเป็นแนวตั้ง) → หาว่าแต่ละจุดเลื่อนไปเท่าไร แล้วดึงภาพกลับให้เส้นตรง
 * คืน Mat ใหม่ หรือ null ถ้าหาเส้นไม่พอ / เส้นตรงอยู่แล้ว / ผลไม่น่าเชื่อถือ
 */
function straightenLines(src) {
  const W = src.cols, H = src.rows;
  const s = Math.min(1, 1000 / W); // วิเคราะห์ที่ภาพย่อ กว้างไม่เกิน 1000 px
  const aw = Math.max(1, Math.round(W * s)), ah = Math.max(1, Math.round(H * s));
  const small = new cv.Mat();
  cv.resize(src, small, new cv.Size(aw, ah), 0, 0, cv.INTER_AREA);
  const gray = new cv.Mat();
  cv.cvtColor(small, gray, small.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  small.delete();
  const ink = new cv.Mat();
  cv.adaptiveThreshold(gray, ink, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 25, 15);
  gray.delete();

  // เส้นแนวนอน: เส้นตาราง + บรรทัดตัวหนังสือ (เชื่อมตัวอักษรเป็นแถบยาวก่อน)
  const rows = lineCurves(ink, aw, ah, true);
  // เส้นแนวตั้ง: เฉพาะเส้นตาราง (หมุนภาพ 90° แล้วใช้วิธีเดียวกัน)
  const inkT = new cv.Mat();
  cv.transpose(ink, inkT);
  ink.delete();
  const cols = lineCurves(inkT, ah, aw, false).map((pts) => pts.map(([y, x]) => [x, y]));
  inkT.delete();

  // ตัวอย่างการเลื่อน: ณ ตำแหน่งปลายทาง (เส้นตรง) ต้องไปดึงพิกเซลจากตำแหน่งเดิมที่ห่างเท่าไร
  const dySamples = [];
  for (const pts of rows) {
    const c = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const wgt = pts.length;
    for (const [x, y] of pts) dySamples.push([x, c, y - c, wgt]);
  }
  const dxSamples = [];
  for (const pts of cols) {
    const c = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const wgt = pts.length;
    for (const [x, y] of pts) dxSamples.push([c, y, x - c, wgt]);
  }
  const spanOf = (curves, axis, size) => {
    if (!curves.length) return 0;
    const v = curves.map((pts) => pts.reduce((a, p) => a + p[axis], 0) / pts.length);
    return (Math.max(...v) - Math.min(...v)) / size;
  };
  // เส้นแนวนอนอย่างน้อย 4 เส้น กระจายเกิน 40% ของความสูง · เส้นแนวตั้งอย่างน้อย 2 เส้น ห่างกันเกิน 40% ของความกว้าง
  const fy = rows.length >= 4 && spanOf(rows, 1, ah) > 0.4 ? fitField(dySamples, aw, ah) : null;
  const fx = cols.length >= 2 && spanOf(cols, 0, aw) > 0.4 ? fitField(dxSamples, aw, ah) : null;
  if (!fy && !fx) return null;

  // ตรวจความสมเหตุสมผล: เลื่อนน้อยมาก = ตรงอยู่แล้ว · เลื่อนมากเกิน = น่าจะจับผิด
  let maxD = 0;
  for (let gy = 0; gy <= 10; gy++) for (let gx = 0; gx <= 10; gx++) {
    const x = (gx / 10) * aw, y = (gy / 10) * ah;
    maxD = Math.max(maxD, Math.abs(fy ? fy(x, y) : 0), Math.abs(fx ? fx(x, y) : 0));
  }
  if (maxD < 1.2 || maxD > 0.07 * Math.max(aw, ah)) return null;

  // คำนวณการเลื่อนบนตารางหยาบ (ทุก 8 px ของภาพวิเคราะห์) แล้วขยายเป็นความละเอียดจริงแบบนุ่มนวล
  const gw = Math.max(2, Math.ceil(aw / 8) + 1), gh = Math.max(2, Math.ceil(ah / 8) + 1);
  const gdx = new cv.Mat(gh, gw, cv.CV_32FC1), gdy = new cv.Mat(gh, gw, cv.CV_32FC1);
  const rowY = fy?.rowEval, rowX = fx?.rowEval;
  for (let j = 0; j < gh; j++) {
    const y = (j / (gh - 1)) * ah;
    const ey = rowY ? rowY(y) : null, ex = rowX ? rowX(y) : null;
    for (let i = 0; i < gw; i++) {
      const x = (i / (gw - 1)) * aw;
      gdx.data32F[j * gw + i] = ex ? ex(x) / s : 0;
      gdy.data32F[j * gw + i] = ey ? ey(x) / s : 0;
    }
  }
  const mapX = new cv.Mat(), mapY = new cv.Mat();
  cv.resize(gdx, mapX, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  cv.resize(gdy, mapY, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  gdx.delete();
  gdy.delete();
  const mx = mapX.data32F, my = mapY.data32F;
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      mx[i] += x;
      my[i] += y;
    }
  }
  const out = new cv.Mat();
  cv.remap(src, out, mapX, mapY, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  mapX.delete();
  mapY.delete();
  return out;
}

/**
 * หาเส้นแนวนอนยาว ๆ ในภาพขาวดำ (หมึก = 255) คืนจุดกึ่งกลางเส้นตามแนวยาว [[x, y], ...] ต่อเส้น
 * joinText = เชื่อมตัวอักษรในบรรทัดให้เป็นแถบเดียวก่อน (ใช้กับแนวนอน)
 */
function lineCurves(bin, w, h, joinText) {
  const m = new cv.Mat();
  // หนาขึ้นเล็กน้อยในแนวตั้ง: เส้นที่เอียง/โค้งจะยังต่อกันเป็นแถวยาว
  const k0 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 3));
  cv.dilate(bin, m, k0);
  k0.delete();
  if (joinText) {
    const k1 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(3, Math.round(w / 60)), 1));
    cv.morphologyEx(m, m, cv.MORPH_CLOSE, k1);
    k1.delete();
  }
  const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(5, Math.round(w / 14)), 1));
  cv.morphologyEx(m, m, cv.MORPH_OPEN, k2);
  k2.delete();

  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(m, labels, stats, cents, 8, cv.CV_32S);
  m.delete();
  cents.delete();
  const L = labels.data32S, S = stats.data32S;
  const step = Math.max(4, Math.round(w / 80));
  // ผู้สมัคร: ยาวพอ · ความสูงรวมไม่เกินช่วงโค้งที่เป็นไปได้
  const cand = [];
  for (let l = 1; l < n; l++) {
    const left = S[l * 5], top = S[l * 5 + 1], bw = S[l * 5 + 2], bh = S[l * 5 + 3], area = S[l * 5 + 4];
    if (bw < 0.3 * w || bh > 0.12 * h) continue;
    cand.push({ l, left, top, bw, bh, thick: area / bw });
  }
  // ตัดแถบที่หนาผิดปกติ (หลายบรรทัดติดกันเพราะเครื่องหมายถูก/ลายมือคร่อม หรือก้อนดำใหญ่)
  const thicks = cand.map((c) => c.thick).sort((p, q) => p - q);
  const medThick = thicks[thicks.length >> 1] || 0;
  const curves = [];
  for (const { l, left, top, bw, bh, thick } of cand) {
    if (thick > Math.max(2.2 * medThick, 4) || thick > 0.035 * h) continue;
    const pts = [];
    const col = [];
    for (let x = left; x < left + bw; x += step) {
      // ค่ากลางของแนวตั้งในคอลัมน์นี้ (ไม่ถูกหางตัวอักษร/ขีดที่ยื่นออกมาดึงเพี้ยน)
      col.length = 0;
      for (let y = top; y < top + bh; y++) if (L[y * w + x] === l) col.push(y);
      if (col.length) pts.push([x, col[col.length >> 1]]);
    }
    if (pts.length >= 6) curves.push(pts);
  }
  labels.delete();
  stats.delete();
  return curves;
}

/**
 * ฟิตสนามการเลื่อน d(x, y) ด้วยพหุนามเรียบ (x กำลัง ≤ 4, y กำลัง ≤ 3) แบบตัดค่าผิดปกติ
 * samples = [[x, y, d, weight]] ในพิกัดภาพวิเคราะห์ (aw × ah)
 * คืนฟังก์ชัน f(x, y) และ f.rowEval(y) → (x) => d สำหรับคำนวณทีละแถวอย่างเร็ว
 * นอกช่วงที่มีตัวอย่าง ค่าการเลื่อนจะค่อย ๆ ลดเป็น 0 (ไม่เดาส่วนที่ไม่มีเส้นอ้างอิง)
 * คืน null ถ้าการดัดไม่ทำให้เส้นตรงขึ้นชัดเจน
 */
function fitField(samples, aw, ah) {
  if (samples.length < 20) return null;
  // พหุนามดีกรีต่ำ: ความโค้งของกระดาษเป็นแบบเรียบ ๆ ทั้งแผ่น (ดีกรีสูงทำให้เส้นเป็นคลื่น)
  const NX = 4, NY = 3, K = NX * NY;
  const nx = (x) => (x / aw) * 2 - 1, ny = (y) => (y / ah) * 2 - 1;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of samples) { x0 = Math.min(x0, nx(x)); x1 = Math.max(x1, nx(x)); y0 = Math.min(y0, ny(y)); y1 = Math.max(y1, ny(y)); }
  const cx = (v) => Math.min(x1, Math.max(x0, v)), cy = (v) => Math.min(y1, Math.max(y0, v));
  const powers = (v, N) => { const p = new Array(N); p[0] = 1; for (let i = 1; i < N; i++) p[i] = p[i - 1] * v; return p; };
  const basis = (X, Y) => {
    const px = powers(X, NX), py = powers(Y, NY), b = new Array(K);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) b[j * NX + i] = px[i] * py[j];
    return b;
  };
  const rowsB = samples.map(([x, y]) => basis(cx(nx(x)), cy(ny(y))));
  let w = samples.map((smp) => smp[3]);
  let coef = null;
  for (let iter = 0; iter < 3; iter++) {
    const A = Array.from({ length: K }, () => new Float64Array(K));
    const b = new Float64Array(K);
    for (let r = 0; r < samples.length; r++) {
      if (!w[r]) continue;
      const B = rowsB[r], d = samples[r][2], wr = w[r];
      for (let i = 0; i < K; i++) {
        b[i] += wr * B[i] * d;
        for (let j = 0; j < K; j++) A[i][j] += wr * B[i] * B[j];
      }
    }
    let tr = 0;
    for (let i = 0; i < K; i++) tr += A[i][i];
    for (let i = 0; i < K; i++) A[i][i] += 1e-4 * tr / K; // กันสมการไม่มีคำตอบเดียว
    coef = solve(A, b);
    if (!coef) return null;
    // ตัดตัวอย่างที่ห่างจากเส้นที่ฟิตได้มากผิดปกติ แล้วฟิตใหม่
    const res = samples.map((smp, r) => Math.abs(rowsB[r].reduce((a, v, i) => a + v * coef[i], 0) - smp[2]));
    const sorted = res.filter((_, r) => w[r]).sort((p, q) => p - q);
    const med = sorted[sorted.length >> 1] || 0;
    const cut = Math.max(1.5, 3 * med);
    w = w.map((wr, r) => (res[r] > cut ? 0 : samples[r][3]));
  }
  // วัดว่าดัดแล้วช่วยจริงไหม: ความคลาดก่อนดัด (d) เทียบหลังดัด (d − ค่าที่ฟิตได้) เฉพาะตัวอย่างที่ใช้
  let before = 0, after = 0, sw = 0;
  samples.forEach((smp, r) => {
    if (!w[r]) return;
    const fit = rowsB[r].reduce((a, v, i) => a + v * coef[i], 0);
    before += w[r] * smp[2] ** 2;
    after += w[r] * (smp[2] - fit) ** 2;
    sw += w[r];
  });
  before = Math.sqrt(before / sw);
  after = Math.sqrt(after / sw);
  if (before < 1 || after > 0.55 * before) return null;

  // นอกช่วงที่มีเส้นอ้างอิง: ลดการเลื่อนลงจนเป็น 0 ภายในระยะ 15% ของหน้า
  const FADE = 0.3; // หน่วยพิกัดปกติ (-1..1) = 15% ของหน้า
  const fade = (v, lo, hi) => {
    const out = v < lo ? lo - v : v > hi ? v - hi : 0;
    const t = Math.max(0, 1 - out / FADE);
    return t * t * (3 - 2 * t);
  };
  const f = (x, y) => {
    const X = nx(x), Y = ny(y);
    return basis(cx(X), cy(Y)).reduce((a, v, i) => a + v * coef[i], 0) * fade(X, x0, x1) * fade(Y, y0, y1);
  };
  f.rowEval = (y) => {
    // รวมพจน์ของ y ไว้ก่อน เหลือพหุนามของ x ต่อแถว
    const Y = ny(y);
    const py = powers(cy(Y), NY), cxs = new Float64Array(NX);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) cxs[i] += coef[j * NX + i] * py[j];
    const fy = fade(Y, y0, y1);
    return (x) => {
      const X = nx(x), Xc = cx(X);
      let v = 0;
      for (let i = NX - 1; i >= 0; i--) v = v * Xc + cxs[i];
      return v * fy * fade(X, x0, x1);
    };
  };
  return f;
}

/** แก้ระบบสมการเชิงเส้นด้วย Gaussian elimination (pivot บางส่วน) */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = M[r][n];
    for (let j = r + 1; j < n; j++) v -= M[r][j] * x[j];
    x[r] = v / M[r][r];
  }
  return x;
}

/**
 * ฟิลเตอร์ + ปรับภาพ
 * contrast 0..1 (0.5 = ปกติ) · brightness −1..1 (0 = ปกติ) · sharpness 0..1 (0 = ไม่เพิ่มความคม)
 */
function applyFilter(rgba, { filter, contrast, brightness = 0, sharpness = 0 }) {
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  rgba.delete();
  if (!filter || filter === 'original') {
    sharpen(rgb, sharpness);
    tone(rgb, contrast, brightness);
    return rgb;
  }
  const flat = flattenLight(rgb);
  rgb.delete();
  // เพิ่มความคมก่อนปรับระดับแสง: ขอบตัวหนังสือ/เส้นปากกาชัดขึ้นโดยพื้นยังขาว
  sharpen(flat, sharpness);
  if (filter === 'color') {
    levels(flat, contrast, brightness);
    return flat;
  }
  const gray = new cv.Mat();
  cv.cvtColor(flat, gray, cv.COLOR_RGB2GRAY);
  flat.delete();
  if (filter === 'gray') {
    levels(gray, contrast, brightness);
    return gray;
  }
  // ขาวดำ: คอนทราสต์มาก = เก็บเส้นจาง ๆ ได้มากขึ้น · สว่างมาก = จุดดำเล็ก ๆ หายไป
  levels(gray, 0.3 + contrast * 0.4, 0);
  let block = Math.round(Math.min(gray.cols, gray.rows) / 40);
  block = Math.max(15, block % 2 ? block : block + 1);
  const bw = new cv.Mat();
  cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 10 + brightness * 8);
  gray.delete();
  return bw;
}

/**
 * ปรับระดับแสงหลังลบเงา: ค่าที่สว่างกว่าจุดขาวกลายเป็นขาวล้วน (เงาจาง ๆ ที่เหลือหายไป)
 * และค่าที่มืดกว่าจุดดำกลายเป็นดำ (ตัวหนังสือเข้มขึ้น) แล้วเลื่อนความสว่างทั้งภาพ
 */
function levels(mat, contrast, brightness = 0) {
  const s = Math.min(1, Math.max(0, contrast));
  const lo = 15 + 70 * s;
  const hi = 250 - 75 * s;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = clamp255(255 * (v - lo) / (hi - lo) + brightness * 60);
  applyLut(mat, lut);
}

/** ภาพต้นฉบับ: คอนทราสต์แบบเส้นตรงรอบค่ากลาง + ความสว่าง */
function tone(mat, contrast, brightness) {
  const k = 0.6 + Math.min(1, Math.max(0, contrast)) * 0.8; // 0.5 → ×1.0
  if (Math.abs(k - 1) < 0.01 && Math.abs(brightness) < 0.01) return;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = clamp255((v - 128) * k + 128 + brightness * 60);
  applyLut(mat, lut);
}

/** เพิ่มความคมแบบ unsharp mask: ภาพ + (ภาพ − ภาพเบลอ) × น้ำหนัก */
function sharpen(mat, amount) {
  if (!(amount > 0.01)) return;
  const sigma = Math.max(1, Math.min(mat.cols, mat.rows) / 1000);
  const blur = new cv.Mat();
  cv.GaussianBlur(mat, blur, new cv.Size(0, 0), sigma);
  const a = amount * 1.6;
  cv.addWeighted(mat, 1 + a, blur, -a, 0, mat);
  blur.delete();
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/** ใช้ตารางค่ากับทุกช่องสี (ภาพในขั้นนี้ไม่มีช่องความโปร่งใส) */
function applyLut(mat, lut) {
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
