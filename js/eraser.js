// ลบข้อความ/รอยบนหน้ากระดาษ: ระบายด้วยแปรงหรือกรอบสี่เหลี่ยม ด้วยสีกระดาษ/สีที่ดูดจากภาพ
// รอยลบเก็บเป็นข้อมูล (ไม่ฝังในภาพ) จึงยกเลิก/แก้ทีหลังได้ และใช้ซ้ำเมื่อคำนวณหน้าใหม่ (หมุน เปลี่ยนฟิลเตอร์)
import { icon } from './icons.js';

/**
 * รอยลบ 1 รอย: { type: 'path' | 'rect', color, size, points: [[u, v], ...] }
 * u, v = ตำแหน่งแบบสัดส่วน 0..1 ของภาพผลลัพธ์ · size = ความกว้างแปรงเทียบกับด้านสั้นของภาพ
 */
export function drawStrokes(ctx, w, h, strokes) {
  const m = Math.min(w, h);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.fillStyle = ctx.strokeStyle = s.color;
    const pts = s.points.map(([u, v]) => [u * w, v * h]);
    if (s.type === 'rect' && pts.length === 2) {
      const [[x0, y0], [x1, y1]] = pts;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], (s.size * m) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (pts.length > 1) {
      ctx.lineWidth = s.size * m;
      ctx.beginPath();
      ctx.moveTo(...pts[0]);
      for (const p of pts.slice(1)) ctx.lineTo(...p);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** หมุนรอยลบตามการหมุนภาพ (ตามเข็มนาฬิกา 90/180/270) */
export function rotateStrokes(strokes, deg) {
  const d = ((deg % 360) + 360) % 360;
  const f = { 0: ([u, v]) => [u, v], 90: ([u, v]) => [1 - v, u], 180: ([u, v]) => [1 - u, 1 - v], 270: ([u, v]) => [v, 1 - u] }[d];
  return strokes.map((s) => ({ ...s, points: s.points.map(f) }));
}

/** สีกระดาษ: ค่ากลางของสีบริเวณขอบภาพ */
function paperColor(img) {
  const c = document.createElement('canvas');
  const s = Math.min(1, 200 / Math.max(img.width, img.height));
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const band = Math.max(2, Math.round(Math.min(c.width, c.height) * 0.04));
  const rs = [], gs = [], bs = [];
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (x > band && y > band && x < c.width - band && y < c.height - band) continue;
    const i = (y * c.width + x) * 4;
    rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
  }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1] ?? 255;
  return rgbHex(med(rs), med(gs), med(bs));
}

const rgbHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * เปิดหน้าลบข้อความ
 * @param {HTMLCanvasElement} image ภาพหน้าเอกสาร (ยังไม่มีรอยลบ)
 * @param {Array} strokes รอยลบเดิม
 * @returns {Promise<Array|null>} รอยลบใหม่ทั้งหมด หรือ null ถ้ายกเลิก
 */
export function openEraser({ image, strokes = [] }) {
  const paper = paperColor(image);
  const state = {
    strokes: strokes.map((s) => ({ ...s, points: s.points.map((p) => [...p]) })),
    redo: [],
    mode: 'brush',
    color: paper,
    size: 36, // พิกเซลบนจอ
    picking: false,
  };

  const dlg = document.createElement('dialog');
  dlg.className = 'editor eraser';
  dlg.tabIndex = -1;
  dlg.setAttribute('aria-label', 'ลบข้อความ');
  dlg.innerHTML = `
    <section class="ed-step">
      <header class="ed-top">
        <button type="button" class="btn btn-ghost" data-act="cancel">ยกเลิก</button>
        <div class="ed-title">ลบข้อความ</div>
        <button type="button" class="icon-btn" data-act="undo" aria-label="ย้อนกลับ">${icon('undo')}</button>
        <button type="button" class="icon-btn" data-act="redo" aria-label="ทำซ้ำ">${icon('redo')}</button>
        <button type="button" class="btn btn-primary" data-act="save">บันทึก</button>
      </header>
      <div class="ed-stage er-stage">
        <canvas class="er-canvas"></canvas>
        <div class="ed-status er-hint">ระบายทับข้อความที่จะลบ · ใช้สองนิ้วซูม/เลื่อน</div>
      </div>
      <div class="er-tools">
        <div class="seg" role="radiogroup" data-name="mode">
          <button type="button" role="radio" data-v="brush">${icon('brush')}แปรง</button>
          <button type="button" role="radio" data-v="rect">${icon('square')}กรอบสี่เหลี่ยม</button>
        </div>
        <div class="adj-row er-size">
          <label for="er-size">ขนาดแปรง</label>
          <input type="range" id="er-size" min="6" max="120" step="1" value="${state.size}">
          <output>${state.size}</output>
        </div>
        <div class="er-colors">
          <button type="button" class="swatch" data-color="${paper}" aria-label="สีกระดาษ" style="--c:${paper}"><span>สีกระดาษ</span></button>
          ${paper !== '#ffffff' ? '<button type="button" class="swatch" data-color="#ffffff" aria-label="ขาว" style="--c:#ffffff"><span>ขาว</span></button>' : ''}
          <button type="button" class="swatch picked" data-color="" aria-label="สีที่ดูดมา" style="--c:transparent" hidden><span>ที่เลือก</span></button>
          <button type="button" class="chip chip-toggle" data-act="pick" aria-pressed="false">${icon('pipette')}ดูดสี</button>
        </div>
      </div>
    </section>`;
  document.body.appendChild(dlg);

  const stage = dlg.querySelector('.er-stage');
  const canvas = dlg.querySelector('.er-canvas');
  const ctx = canvas.getContext('2d');
  const hint = dlg.querySelector('.er-hint');
  // ภาพสำหรับดูดสี (อ่านพิกเซลได้เร็ว)
  const pickSrc = document.createElement('canvas');
  pickSrc.width = image.width;
  pickSrc.height = image.height;
  pickSrc.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0);

  const view = { s: 1, x: 0, y: 0 }; // พิกเซลภาพ → พิกเซลแคนวาส
  let dpr = 1;
  const iw = image.width, ih = image.height;

  function fit() {
    const r = stage.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    const pad = 16 * dpr;
    view.s = Math.min((canvas.width - pad * 2) / iw, (canvas.height - pad * 2) / ih);
    view.x = (canvas.width - iw * view.s) / 2;
    view.y = (canvas.height - ih * view.s) / 2;
    draw();
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.s, 0, 0, view.s, view.x, view.y);
    ctx.drawImage(image, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, iw, ih);
    ctx.clip();
    drawStrokes(ctx, iw, ih, state.strokes);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    dlg.querySelector('[data-act="undo"]').disabled = !state.strokes.length;
    dlg.querySelector('[data-act="redo"]').disabled = !state.redo.length;
  }

  const toImage = (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = (e.clientX - r.left) * dpr, cy = (e.clientY - r.top) * dpr;
    return [(cx - view.x) / view.s, (cy - view.y) / view.s];
  };
  const norm = ([x, y]) => [Math.min(1, Math.max(0, x / iw)), Math.min(1, Math.max(0, y / ih))];

  function syncTools() {
    dlg.querySelectorAll('[data-name="mode"] [data-v]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === state.mode)));
    dlg.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', !!b.dataset.color && b.dataset.color === state.color));
    dlg.querySelector('[data-act="pick"]').setAttribute('aria-pressed', String(state.picking));
    // ซ่อนแบบยังกินที่ เพื่อไม่ให้พื้นที่วาดขยับตอนสลับโหมด
    dlg.querySelector('.er-size').style.visibility = state.mode === 'brush' ? '' : 'hidden';
    hint.hidden = false;
    hint.textContent = state.picking ? 'แตะบนภาพตรงสีที่ต้องการ' : state.mode === 'rect' ? 'ลากเป็นกรอบทับข้อความที่จะลบ · สองนิ้วซูม/เลื่อน' : 'ระบายทับข้อความที่จะลบ · สองนิ้วซูม/เลื่อน';
  }

  /* ----- นิ้ว: 1 นิ้ว = ระบาย/ลากกรอบ/ดูดสี · 2 นิ้ว = ซูม/เลื่อน ----- */
  const pointers = new Map();
  let current = null; // รอยที่กำลังวาด
  let pinch = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      // เริ่มซูม: ยกเลิกรอยที่เพิ่งเริ่ม
      if (current) { state.strokes.pop(); current = null; }
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s: view.s, x: view.x, y: view.y };
      draw();
      return;
    }
    if (pointers.size > 2) return;
    const p = toImage(e);
    if (state.picking) {
      const x = Math.round(p[0]), y = Math.round(p[1]);
      if (x >= 0 && y >= 0 && x < iw && y < ih) {
        const d = pickSrc.getContext('2d').getImageData(x, y, 1, 1).data;
        state.color = rgbHex(d[0], d[1], d[2]);
        const picked = dlg.querySelector('.swatch.picked');
        picked.dataset.color = state.color;
        picked.style.setProperty('--c', state.color);
        picked.hidden = false;
      }
      state.picking = false;
      syncTools();
      return;
    }
    hint.hidden = true; // เริ่มวาดแล้ว ไม่ต้องบังภาพ
    const pt = norm(p);
    current = state.mode === 'rect'
      ? { type: 'rect', color: state.color, size: 0, points: [pt, pt] }
      : { type: 'path', color: state.color, size: state.size / view.s * dpr / Math.min(iw, ih), points: [pt] };
    state.strokes.push(current);
    state.redo = [];
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const k = Math.min(8, Math.max(0.5, d / pinch.d));
      const r = canvas.getBoundingClientRect();
      const m0 = [(pinch.mid[0] - r.left) * dpr, (pinch.mid[1] - r.top) * dpr];
      const m1 = [(mid[0] - r.left) * dpr, (mid[1] - r.top) * dpr];
      view.s = pinch.s * k;
      // จุดภาพที่อยู่ใต้จุดกึ่งกลางสองนิ้วตอนเริ่ม ต้องตามนิ้วไปด้วย
      view.x = m1[0] - (m0[0] - pinch.x) * k;
      view.y = m1[1] - (m0[1] - pinch.y) * k;
      draw();
      return;
    }
    if (!current) return;
    const pt = norm(toImage(e));
    if (current.type === 'rect') current.points[1] = pt;
    else current.points.push(pt);
    draw();
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) current = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('resize', fit);
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };

    dlg.addEventListener('click', (e) => {
      const modeBtn = e.target.closest('[data-name="mode"] [data-v]');
      if (modeBtn) { state.mode = modeBtn.dataset.v; state.picking = false; syncTools(); return; }
      const sw = e.target.closest('.swatch');
      if (sw && sw.dataset.color) { state.color = sw.dataset.color; state.picking = false; syncTools(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') finish(null);
      else if (act === 'save') finish(state.strokes);
      else if (act === 'pick') { state.picking = !state.picking; syncTools(); }
      else if (act === 'undo' && state.strokes.length) { state.redo.push(state.strokes.pop()); draw(); }
      else if (act === 'redo' && state.redo.length) { state.strokes.push(state.redo.pop()); draw(); }
    });
    dlg.querySelector('#er-size').addEventListener('input', (e) => {
      state.size = Number(e.target.value);
      e.target.nextElementSibling.textContent = e.target.value;
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener('close', () => finish(null));

    window.addEventListener('resize', fit);
    dlg.showModal();
    dlg.focus({ preventScroll: true });
    syncTools();
    requestAnimationFrame(fit);
  });
}
