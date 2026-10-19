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
    else if (type === 'setSource') setSource(e.data.sourceId, e.data.image);
    else if (type === 'dropSource') dropSource(e.data.sourceId);
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

/*
 * ภาพต้นทางที่ส่งมาครั้งเดียวแล้วใช้ซ้ำ (หน้าปรับภาพ): ไม่ต้องส่งภาพใหม่ทุกครั้งที่เปลี่ยนฟิลเตอร์
 * และจำผลขั้นที่หนัก (ดัดภาพ/ดัดเส้น/เติมขอบ) ไว้ เปลี่ยนแค่ฟิลเตอร์หรือแถบปรับแสงจึงเร็วมาก
 */
const sources = new Map();
let geomCache = null; // { key, mat }

function setSource(id, image) {
  dropSource(id);
  for (const [k, m] of sources) { if (sources.size < 2) break; m.delete(); sources.delete(k); }
  sources.set(id, toMat(image));
}

function dropSource(id) {
  sources.get(id)?.delete();
  sources.delete(id);
  if (geomCache?.key.startsWith(id + '|')) { geomCache.mat.delete(); geomCache = null; }
}

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

function process({ image, sourceId, corners, filter, rotation, contrast = 0.5, brightness = 0, sharpness = 0, straighten = false, fillEdges = false }) {
  let mat;
  const key = sourceId && `${sourceId}|${JSON.stringify([corners, straighten, fillEdges])}`;
  if (sourceId && geomCache?.key === key) {
    mat = geomCache.mat.clone();
  } else {
    if (sourceId && !sources.has(sourceId)) throw new Error('NOSOURCE');
    mat = sourceId ? sources.get(sourceId).clone() : toMat(image);
    mat = geometry(mat, { corners, straighten, fillEdges });
    if (sourceId) {
      geomCache?.mat.delete();
      geomCache = { key, mat: mat.clone() };
    }
  }
  return finish(mat, { filter, rotation, contrast, brightness, sharpness });
}

/** ขั้นหนัก: ดัดภาพตามมุม → ดัดเส้นให้ตรง → เติมขอบ */
function geometry(mat, { corners, straighten, fillEdges }) {
  const iw = mat.cols, ih = mat.rows;
  if (corners) {
    const p = corners.map(([x, y]) => [x * iw, y * ih]);
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

  if (fillEdges && corners) fillEdgeBackground(mat);
  return mat;
}

/** ขั้นเบา: ฟิลเตอร์ + ปรับแสง + หมุน แล้วแปลงเป็นข้อมูลส่งกลับ */
function finish(mat, { filter, rotation, contrast, brightness, sharpness }) {
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
 * ดัดเส้นให้ตรงแบบแยกช่วง: แบ่งหน้ากระดาษเป็นช่วง ๆ ตามแถบว่างของกระดาษ (ช่องว่างระหว่างตาราง/ย่อหน้า)
 * แล้วหาความโค้งและตรวจผลของแต่ละช่วงแยกกัน — ช่วงไหนดัดแล้วไม่ตรงขึ้นจะไม่แตะช่วงนั้น
 * ในแถบว่างระหว่างช่วง ค่อย ๆ เปลี่ยนการเลื่อนจากช่วงบนไปช่วงล่าง (เป็นกระดาษเปล่า จึงไม่เห็นรอยต่อ)
 * คืน Mat ใหม่ หรือ null ถ้าไม่มีช่วงไหนต้องดัด
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

  const regions = splitByGaps(ink, aw, ah);
  // เส้นแนวนอนทั้งหน้า (เส้นตาราง + บรรทัดตัวหนังสือ) แล้วแบ่งให้ช่วงที่เส้นนั้นอยู่
  const rows = lineCurves(ink, aw, ah, true);

  for (const r of regions) {
    const rh = r.y1 - r.y0;
    const mine = rows.filter((pts) => {
      const c = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      return c >= r.y0 && c < r.y1;
    });
    // เส้นแนวตั้ง (เส้นตาราง) หาเฉพาะในช่วงนี้ — ตารางเล็กมีเส้นตั้งสั้น หาทั้งหน้าจะไม่เจอ
    const roi = ink.roi(new cv.Rect(0, r.y0, aw, rh));
    const inkT = new cv.Mat();
    cv.transpose(roi, inkT);
    roi.delete();
    const cols = lineCurves(inkT, rh, aw, false).map((pts) => pts.map(([y, x]) => [x, y]));
    inkT.delete();

    // ตัวอย่างการเลื่อน (พิกัดภายในช่วง): ณ ตำแหน่งเส้นตรง ต้องดึงพิกเซลจากตำแหน่งเดิมที่ห่างเท่าไร
    const dy = [];
    for (const pts of mine) {
      const c = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      for (const [x, y] of pts) dy.push([x, c - r.y0, y - c, pts.length]);
    }
    const dx = [];
    for (const pts of cols) {
      const c = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      for (const [x, y] of pts) dx.push([c, y, x - c, pts.length]);
    }
    const span = (curves, axis, size) => {
      if (curves.length < 2) return 0;
      const v = curves.map((pts) => pts.reduce((a, p) => a + p[axis], 0) / pts.length);
      return (Math.max(...v) - Math.min(...v)) / size;
    };
    const NY = rh > 0.35 * ah ? 3 : 2; // ช่วงเตี้ย: ความโค้งแนวตั้งน้อย ใช้ดีกรีต่ำ (กันเส้นเป็นคลื่น)
    r.fy = mine.length >= 3 && span(mine, 1, rh) > 0.3 ? fitField(dy, aw, rh, 4, NY) : null;
    r.fx = cols.length >= 2 && span(cols, 0, aw) > 0.4 ? fitField(dx, aw, rh, 4, NY) : null;

    // เลื่อนน้อยมาก = ช่วงนี้ตรงอยู่แล้ว · เลื่อนมากเกิน = น่าจะจับผิด → ไม่ดัดช่วงนี้
    let maxD = 0;
    for (let gy = 0; gy <= 8; gy++) for (let gx = 0; gx <= 8; gx++) {
      const x = (gx / 8) * aw, y = (gy / 8) * rh;
      maxD = Math.max(maxD, Math.abs(r.fy ? r.fy(x, y) : 0), Math.abs(r.fx ? r.fx(x, y) : 0));
    }
    if (maxD < 1.2 || maxD > 0.07 * Math.max(aw, ah)) { r.fy = null; r.fx = null; }
  }
  ink.delete();
  const active = regions.filter((r) => r.fy || r.fx);
  if (!active.length) return null;

  /** การเลื่อนของช่วง r ที่ x และแถว y (พิกัดภาพวิเคราะห์) · ช่วงที่ไม่ดัด = 0 */
  const rowFns = (r, y) => {
    const ly = Math.min(r.y1 - r.y0, Math.max(0, y - r.y0));
    return { ex: r.fx?.rowEval(ly), ey: r.fy?.rowEval(ly) };
  };

  // คำนวณการเลื่อนบนตารางหยาบ (ทุก 8 px ของภาพวิเคราะห์) แล้วขยายเป็นความละเอียดจริงแบบนุ่มนวล
  const gw = Math.max(2, Math.ceil(aw / 8) + 1), gh = Math.max(2, Math.ceil(ah / 8) + 1);
  const gdx = new cv.Mat(gh, gw, cv.CV_32FC1), gdy = new cv.Mat(gh, gw, cv.CV_32FC1);
  for (let j = 0; j < gh; j++) {
    const y = (j / (gh - 1)) * ah;
    // ช่วงที่แถวนี้อยู่ หรือสองช่วงที่แถวนี้อยู่ระหว่างกลาง (ในแถบว่าง)
    let a = null, b = null, t = 0;
    const inside = regions.find((r) => y >= r.y0 && y < r.y1);
    if (inside) a = inside;
    else {
      const above = regions.filter((r) => r.y1 <= y).pop();
      const below = regions.find((r) => r.y0 > y);
      if (above && below) { a = above; b = below; t = (y - above.y1) / (below.y0 - above.y1); }
      else a = above || below;
    }
    const A = a ? rowFns(a, y) : {}, B = b ? rowFns(b, y) : {};
    t = t * t * (3 - 2 * t);
    for (let i = 0; i < gw; i++) {
      const x = (i / (gw - 1)) * aw;
      const vx = (A.ex ? A.ex(x) : 0) * (1 - t) + (B.ex ? B.ex(x) : 0) * t;
      const vy = (A.ey ? A.ey(x) : 0) * (1 - t) + (B.ey ? B.ey(x) : 0) * t;
      gdx.data32F[j * gw + i] = vx / s;
      gdy.data32F[j * gw + i] = vy / s;
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
 * แบ่งหน้าเป็นช่วงตามแถบว่างแนวนอน (แถวที่แทบไม่มีหมึก ต่อกันสูงพอ)
 * คืน [{ y0, y1 }] เฉพาะช่วงที่มีเนื้อหา · ไม่มีแถบว่างเลย = ทั้งหน้าเป็นช่วงเดียว
 */
function splitByGaps(ink, w, h) {
  const d = ink.data;
  // ไม่นับขอบซ้ายขวา 3% (เงา/ขอบกระดาษที่เหลือ)
  const x0 = Math.round(w * 0.03), x1 = Math.round(w * 0.97);
  const blank = new Uint8Array(h);
  const limit = (x1 - x0) * 0.012;
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = x0, i = y * w + x0; x < x1; x++, i++) if (d[i]) n++;
    blank[y] = n <= limit ? 1 : 0;
  }
  const minGap = Math.max(8, Math.round(h * 0.012));
  const regions = [];
  let start = -1, gapRun = 0;
  for (let y = 0; y <= h; y++) {
    const b = y === h ? 1 : blank[y];
    if (!b) {
      if (start < 0) start = y;
      gapRun = 0;
    } else if (start >= 0) {
      gapRun++;
      if (gapRun >= minGap || y === h) {
        regions.push({ y0: start, y1: y - gapRun + 1 });
        start = -1;
        gapRun = 0;
      }
    }
  }
  // ช่วงเล็กมาก (เศษ/จุด/ลายเซ็น) รวมเข้ากับช่วงข้างเคียงที่ใกล้ที่สุด ถ้าห่างกันไม่มาก ไม่งั้นทิ้ง (ไม่ดัด = ปลอดภัย)
  const minH = Math.max(12, h * 0.03);
  const out = regions.filter((r) => r.y1 - r.y0 >= minH);
  return out.length ? out : [{ y0: 0, y1: h }];
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
function fitField(samples, aw, ah, NX = 4, NY = 3) {
  if (samples.length < 20) return null;
  // พหุนามดีกรีต่ำ: ความโค้งของกระดาษเป็นแบบเรียบ ๆ (ดีกรีสูงทำให้เส้นเป็นคลื่น)
  const K = NX * NY;
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
/* ---------- เติมขอบ: พื้นหลังที่ติดเข้ามาตรงขอบกระดาษที่แหว่ง/พับ ---------- */

/**
 * หาส่วนที่ "ไม่ใช่กระดาษ" ซึ่งต่อเนื่องมาจากขอบภาพ (โต๊ะ เงา มุมที่พับหาย) แล้วเติมด้วยสีกระดาษ
 * - ดูเฉพาะแถบรอบขอบภาพ (ไม่เกิน 12% ของด้านสั้น) — ตัวหนังสือ/ตารางกลางหน้าไม่ถูกแตะ
 * - ตัดเส้นบาง ๆ ออกก่อน (ตัวหนังสือ เส้นตาราง) จึงเหลือแต่ก้อนพื้นหลังใหญ่ ๆ
 * rgba = ภาพ 4 ช่อง (แก้ในที่) · คืน true ถ้ามีการเติม
 */
function fillEdgeBackground(rgba) {
  const W = rgba.cols, H = rgba.rows;
  const s = Math.min(1, 700 / Math.max(W, H)); // วิเคราะห์ที่ภาพย่อ
  const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
  const small = new cv.Mat();
  cv.resize(rgba, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
  const d = small.data;

  // สีกระดาษ = ค่ากลางของพื้นที่กลางหน้า (ตัดส่วนที่เข้มออก = ตัวหนังสือ)
  const rs = [], gs = [], bs = [];
  for (let y = Math.round(h * 0.2); y < h * 0.8; y += 2) {
    for (let x = Math.round(w * 0.2); x < w * 0.8; x += 2) {
      const i = (y * w + x) * 4;
      rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
  }
  const pct = (a, p) => { a.sort((m, n) => m - n); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
  // ใช้เปอร์เซ็นไทล์สูง: พื้นกระดาษสว่างกว่าหมึกเสมอ
  const paper = [pct(rs, 0.7), pct(gs, 0.7), pct(bs, 0.7)];
  const paperL = (paper[0] + paper[1] + paper[2]) / 3;

  // พิกเซลที่ต่างจากกระดาษชัดเจน: เข้มกว่ามาก หรือสีเพี้ยนไปมาก (ลายไม้/เงาสีน้ำตาล)
  const band = Math.round(Math.min(w, h) * 0.12);
  const mask = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0));
  const m = mask.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= band && y >= band && x < w - band && y < h - band) continue;
      const i = (y * w + x) * 4;
      const L = (d[i] + d[i + 1] + d[i + 2]) / 3;
      const dc = Math.abs(d[i] - paper[0]) + Math.abs(d[i + 1] - paper[1]) + Math.abs(d[i + 2] - paper[2]);
      if (L < paperL * 0.72 || dc > 110) m[y * w + x] = 255;
    }
  }
  small.delete();
  // ตัดเส้นบาง/ตัวหนังสือออก เหลือก้อนใหญ่
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
  k.delete();

  // เก็บเฉพาะก้อนที่แตะขอบภาพ
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
  cents.delete();
  const S = stats.data32S, Lb = labels.data32S;
  const keep = new Uint8Array(n);
  let any = false;
  for (let l = 1; l < n; l++) {
    const x = S[l * 5], y = S[l * 5 + 1], bw = S[l * 5 + 2], bh = S[l * 5 + 3], area = S[l * 5 + 4];
    const touches = x === 0 || y === 0 || x + bw >= w || y + bh >= h;
    if (touches && area >= 12) { keep[l] = 1; any = true; }
  }
  stats.delete();
  if (!any) { labels.delete(); mask.delete(); return false; }
  for (let i = 0; i < m.length; i++) m[i] = keep[Lb[i]] ? 255 : 0;
  labels.delete();
  // ขยายเล็กน้อยให้กินขอบเงาที่ติดอยู่ แล้วขยายกลับเป็นขนาดจริง
  const k2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
  cv.dilate(mask, mask, k2);
  k2.delete();
  const big = new cv.Mat();
  cv.resize(mask, big, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  mask.delete();
  // เติมสีกระดาษ (ขอบนุ่มตามค่าความทึบของหน้ากาก)
  const D = rgba.data, B = big.data;
  for (let i = 0, p = 0; p < B.length; p++, i += 4) {
    const a = B[p];
    if (!a) continue;
    const t = a / 255;
    D[i] = D[i] * (1 - t) + paper[0] * t;
    D[i + 1] = D[i + 1] * (1 - t) + paper[1] * t;
    D[i + 2] = D[i + 2] * (1 - t) + paper[2] * t;
  }
  big.delete();
  return true;
}

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
