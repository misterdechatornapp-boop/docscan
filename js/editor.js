// หน้าปรับภาพ 2 ขั้น: (1) ลากมุม/จุดกลางขอบให้ตรงขอบกระดาษ (2) เลือกฟิลเตอร์ + หมุน
import { icon } from './icons.js';
import { esc } from './ui.js';
import { detectPage, processCanvas, scaleCanvas, freeCanvas, FULL_FRAME } from './imaging.js';

/** ค่าปรับภาพเริ่มต้น (ปุ่ม "ค่าเริ่มต้น") */
export const DEFAULT_LOOK = { contrast: 0.5, brightness: 0, sharpness: 0.3 };

const ADJUST = [
  { key: 'contrast', label: 'คอนทราสต์', min: 0, max: 100, scale: 100 },
  { key: 'brightness', label: 'ความสว่าง', min: -50, max: 50, scale: 50 },
  { key: 'sharpness', label: 'ความคมชัด', min: 0, max: 100, scale: 100 },
];

export const FILTERS = [
  { id: 'color', label: 'ปรับสี' },
  { id: 'gray', label: 'สีเทา' },
  { id: 'bw', label: 'ขาวดำ' },
  { id: 'original', label: 'ต้นฉบับ' },
];

/**
 * เปิดหน้าปรับภาพ
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas ภาพต้นฉบับ
 * @param {number[][]} [o.corners] มุมเดิม (ถ้าไม่ส่ง จะหาขอบอัตโนมัติ)
 * @param {number[][]} [o.mids] จุดกลางขอบ [บน, ขวา, ล่าง, ซ้าย] (null = ขอบตรง)
 * @param {string} o.filter
 * @param {number} [o.rotation]
 * @param {number} [o.contrast] 0..1
 * @param {number} [o.brightness] −1..1
 * @param {number} [o.sharpness] 0..1
 * @param {boolean} [o.straighten] ดัดเส้นตาราง/บรรทัดที่โค้งให้ตรง
 * @param {Function} [o.onContinue] ถ้ามี จะมีปุ่ม "บันทึก + ถ่ายต่อ" (เรียกทันทีในจังหวะแตะ เพื่อให้ iOS ยอมเปิดกล้อง)
 * @returns {Promise<{corners, mids, filter, rotation, contrast, cont}|null>} cont = กด "บันทึก + ถ่ายต่อ"
 */
export function openEditor({ canvas, corners, mids = null, filter, rotation = 0, contrast = 0.5, brightness = 0, sharpness = DEFAULT_LOOK.sharpness, straighten = true, onContinue }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'editor';
  dlg.setAttribute('aria-label', 'ปรับภาพเอกสาร');
  dlg.innerHTML = `
    <section class="ed-step" data-step="1">
      <header class="ed-top">
        <button type="button" class="btn btn-ghost" data-act="cancel">ยกเลิก</button>
        <div class="ed-title">ปรับขอบเอกสาร</div>
        <button type="button" class="btn btn-primary" data-act="next">ถัดไป</button>
      </header>
      <div class="ed-stage">
        <div class="ed-frame">
          <svg class="ed-poly" viewBox="0 0 1 1" preserveAspectRatio="none"><path vector-effect="non-scaling-stroke"/></svg>
          ${[0, 1, 2, 3].map((i) => `<div class="ed-h" data-i="${i}" role="slider" aria-label="มุมที่ ${i + 1}" tabindex="0"></div>`).join('')}
          ${EDGE_NAMES.map((n, k) => `<div class="ed-h ed-m" data-m="${k}" role="slider" aria-label="จุดกลางขอบ${n} (ลากเพื่อดัดขอบโค้ง)" tabindex="0"></div>`).join('')}
        </div>
        <canvas class="ed-loupe" width="240" height="240"></canvas>
        <div class="ed-status"></div>
      </div>
      <footer class="ed-tools">
        <button type="button" class="tool" data-act="auto">${icon('wand')}<span>หาขอบอัตโนมัติ</span></button>
        <button type="button" class="tool" data-act="full">${icon('expand')}<span>ใช้ทั้งภาพ</span></button>
      </footer>
    </section>
    <section class="ed-step" data-step="2" hidden>
      <header class="ed-top">
        <button type="button" class="btn btn-ghost" data-act="back">${icon('back')}ขอบ</button>
        <div class="ed-title">ฟิลเตอร์</div>
        <button type="button" class="btn btn-primary" data-act="save">บันทึก</button>
      </header>
      <div class="ed-stage ed-preview"><div class="spinner"></div></div>
      <div class="ed-filters">
        ${FILTERS.map((f) => `<button type="button" class="chip" data-filter="${f.id}">${esc(f.label)}</button>`).join('')}
        <button type="button" class="chip chip-toggle" data-act="straighten" aria-pressed="${straighten}">${icon('lines')}ดัดเส้นให้ตรง</button>
      </div>
      <div class="ed-contrast">
        ${ADJUST.map((a) => `
          <div class="adj-row">
            <label for="adj-${a.key}">${a.label}</label>
            <input type="range" id="adj-${a.key}" data-adj="${a.key}" min="${a.min}" max="${a.max}" step="1" value="${Math.round({ contrast, brightness, sharpness }[a.key] * a.scale)}">
            <output>${Math.round({ contrast, brightness, sharpness }[a.key] * a.scale)}</output>
          </div>`).join('')}
        <button type="button" class="btn btn-ghost adj-reset" data-act="adj-reset">${icon('restore')}ค่าเริ่มต้น</button>
      </div>
      <footer class="ed-tools">
        <button type="button" class="tool" data-act="rotL">${icon('rotL')}<span>หมุนซ้าย</span></button>
        <button type="button" class="tool" data-act="rotR">${icon('rotR')}<span>หมุนขวา</span></button>
        ${onContinue ? `<button type="button" class="tool tool-accent" data-act="saveMore">${icon('camera')}<span>บันทึก + ถ่ายต่อ</span></button>` : ''}
      </footer>
    </section>`;
  document.body.appendChild(dlg);

  const frame = dlg.querySelector('.ed-frame');
  const stage = dlg.querySelector('.ed-stage');
  const outline = dlg.querySelector('.ed-poly path');
  const handles = [...dlg.querySelectorAll('.ed-h:not(.ed-m)')];
  const midHandles = [...dlg.querySelectorAll('.ed-m')];
  const loupe = dlg.querySelector('.ed-loupe');
  const status = dlg.querySelector('.ed-status');
  const nextBtn = dlg.querySelector('[data-act="next"]');
  const previewBox = dlg.querySelector('.ed-preview');

  const state = {
    corners: corners ? corners.map((p) => [...p]) : FULL_FRAME.map((p) => [...p]),
    mids: null,
    filter,
    rotation,
    contrast,
    brightness,
    sharpness,
    straighten,
  };

  state.mids = mids ? mids.map((p) => [...p]) : chordMids(state.corners);

  // ภาพสำหรับแสดงบนจอ (ย่อให้พอดีจอ เพื่อความลื่น)
  const display = scaleCanvas(canvas, Math.max(window.innerWidth, window.innerHeight) * Math.min(2, devicePixelRatio || 1));
  display.className = 'ed-img';
  frame.prepend(display);
  let previewSrc = null;

  function layout() {
    const r = stage.getBoundingClientRect();
    const pad = 24;
    const s = Math.min((r.width - pad * 2) / display.width, (r.height - pad * 2) / display.height);
    frame.style.width = `${display.width * s}px`;
    frame.style.height = `${display.height * s}px`;
  }

  function render() {
    state.corners.forEach(([x, y], i) => {
      handles[i].style.left = `${x * 100}%`;
      handles[i].style.top = `${y * 100}%`;
    });
    state.mids.forEach(([x, y], k) => {
      midHandles[k].style.left = `${x * 100}%`;
      midHandles[k].style.top = `${y * 100}%`;
    });
    outline.setAttribute('d', outlinePath(state.corners, state.mids));
    const ok = isConvex(state.corners);
    frame.classList.toggle('invalid', !ok);
    nextBtn.disabled = !ok;
    if (!ok) status.textContent = 'มุมไขว้กัน — ลากมุมให้เป็นสี่เหลี่ยม';
    else if (status.dataset.msg) status.textContent = status.dataset.msg;
    else status.textContent = '';
  }

  function setStatus(msg) {
    status.dataset.msg = msg;
    render();
  }

  async function autoDetect() {
    setStatus('กำลังหาขอบกระดาษ…');
    try {
      const found = await detectPage(canvas);
      if (found) {
        state.corners = found.corners;
        state.mids = found.mids || chordMids(found.corners);
        setStatus(found.mids ? 'พบขอบกระดาษโค้ง · ดัดให้ตรงอัตโนมัติ' : '');
      } else {
        state.corners = FULL_FRAME.map((p) => [...p]);
        state.mids = chordMids(state.corners);
        setStatus('ไม่พบขอบกระดาษ — ลากมุมทั้ง 4 เอง');
      }
    } catch (err) {
      console.error(err);
      setStatus('หาขอบไม่สำเร็จ — ลากมุมเอง');
    }
  }

  /* ----- ลากมุม / จุดกลางขอบ ----- */
  // ย้ายมุม: จุดกลางของสองขอบที่ติดมุมนั้นเลื่อนตามครึ่งหนึ่ง (รักษารูปโค้งเดิม)
  const setCorner = (i, p) => {
    const d = [p[0] - state.corners[i][0], p[1] - state.corners[i][1]];
    state.corners[i] = p;
    EDGES.forEach(([a, b], k) => {
      if (a === i || b === i) state.mids[k] = [clamp(state.mids[k][0] + d[0] / 2), clamp(state.mids[k][1] + d[1] / 2)];
    });
  };
  const points = [
    ...handles.map((h, i) => ({ h, get: () => state.corners[i], set: (p) => setCorner(i, p) })),
    ...midHandles.map((h, k) => ({ h, get: () => state.mids[k], set: (p) => { state.mids[k] = p; } })),
  ];
  points.forEach(({ h, get, set }) => {
    let off = [0, 0];
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      off = [e.clientX - (r.left + get()[0] * r.width), e.clientY - (r.top + get()[1] * r.height)];
      h.setPointerCapture(e.pointerId);
      h.classList.add('dragging');
      status.dataset.msg = '';
    });
    h.addEventListener('pointermove', (e) => {
      if (!h.hasPointerCapture(e.pointerId)) return;
      const r = frame.getBoundingClientRect();
      const x = clamp((e.clientX - off[0] - r.left) / r.width);
      const y = clamp((e.clientY - off[1] - r.top) / r.height);
      set([x, y]);
      render();
      drawLoupe(x, y, e.clientX < window.innerWidth / 2);
    });
    h.addEventListener('lostpointercapture', () => {
      h.classList.remove('dragging');
      loupe.classList.remove('show');
    });
    h.addEventListener('keydown', (e) => {
      const step = 0.005;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      set([clamp(get()[0] + d[0]), clamp(get()[1] + d[1])]);
      render();
    });
  });

  function drawLoupe(x, y, fingerOnLeft) {
    const ctx = loupe.getContext('2d');
    const zoom = 2.5;
    const r = frame.getBoundingClientRect();
    const scale = display.width / r.width; // พิกเซลภาพต่อพิกเซลจอ
    const srcSize = (loupe.width / 2 / zoom) * scale;
    const sx = x * display.width - srcSize / 2;
    const sy = y * display.height - srcSize / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, loupe.width, loupe.height);
    ctx.drawImage(display, sx, sy, srcSize, srcSize, 0, 0, loupe.width, loupe.height);
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(loupe.width / 2, loupe.height / 2 - 26); ctx.lineTo(loupe.width / 2, loupe.height / 2 + 26);
    ctx.moveTo(loupe.width / 2 - 26, loupe.height / 2); ctx.lineTo(loupe.width / 2 + 26, loupe.height / 2);
    ctx.stroke();
    loupe.classList.toggle('right', fingerOnLeft);
    loupe.classList.add('show');
  }

  /* ----- ขั้นที่ 2: พรีวิวฟิลเตอร์ ----- */
  let previewToken = 0;
  async function renderPreview() {
    const token = ++previewToken;
    previewBox.classList.add('loading');
    dlg.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));
    try {
      if (!previewSrc) previewSrc = scaleCanvas(canvas, 1400);
      const out = await processCanvas(previewSrc, result());
      if (token !== previewToken) { freeCanvas(out); return; }
      out.className = 'ed-preview-img';
      const old = previewBox.querySelector('canvas');
      if (old) { old.replaceWith(out); freeCanvas(old); } else previewBox.appendChild(out);
    } catch (err) {
      console.error(err);
    } finally {
      if (token === previewToken) previewBox.classList.remove('loading');
    }
  }

  /** ค่าที่ส่งออก: mids = null เมื่อขอบทุกด้านตรง */
  function result() {
    const straight = state.mids.every((m, k) => {
      const c = chordMids(state.corners)[k];
      return Math.hypot(m[0] - c[0], m[1] - c[1]) < 0.003;
    });
    return { ...state, mids: straight ? null : state.mids.map((p) => [...p]) };
  }

  function showStep(n) {
    dlg.querySelectorAll('.ed-step').forEach((s) => { s.hidden = s.dataset.step !== String(n); });
    if (n === 1) requestAnimationFrame(layout);
    else renderPreview();
  }

  return new Promise((resolve) => {
    // ปิดและคืนค่าทันที ไม่รอเหตุการณ์ close (บางเบราว์เซอร์ส่งช้าเมื่อหน้าจอไม่ได้วาด)
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('resize', layout);
      if (dlg.open) dlg.close();
      freeCanvas(display);
      freeCanvas(previewSrc);
      dlg.remove();
      resolve(value);
    };

    dlg.addEventListener('click', (e) => {
      const fb = e.target.closest('[data-filter]');
      if (fb) { state.filter = fb.dataset.filter; renderPreview(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') finish(null);
      else if (act === 'next') showStep(2);
      else if (act === 'back') showStep(1);
      else if (act === 'auto') autoDetect();
      else if (act === 'full') { state.corners = FULL_FRAME.map((p) => [...p]); state.mids = chordMids(state.corners); setStatus(''); }
      else if (act === 'adj-reset') {
        Object.assign(state, DEFAULT_LOOK);
        syncAdjust();
        renderPreview();
      }
      else if (act === 'straighten') {
        state.straighten = !state.straighten;
        e.target.closest('[data-act]').setAttribute('aria-pressed', String(state.straighten));
        renderPreview();
      }
      else if (act === 'rotL') { state.rotation = (state.rotation + 270) % 360; renderPreview(); }
      else if (act === 'rotR') { state.rotation = (state.rotation + 90) % 360; renderPreview(); }
      else if (act === 'save') finish({ ...result(), cont: false });
      else if (act === 'saveMore') { onContinue(); finish({ ...result(), cont: true }); }
    });
    // ลากแถบปรับภาพ: รอให้หยุดลากสักนิดค่อยคำนวณพรีวิวใหม่
    let adjTimer;
    const syncAdjust = () => ADJUST.forEach((a) => {
      const input = dlg.querySelector(`#adj-${a.key}`);
      input.value = Math.round(state[a.key] * a.scale);
      input.nextElementSibling.textContent = input.value;
    });
    dlg.addEventListener('input', (e) => {
      const key = e.target.dataset?.adj;
      if (!key) return;
      const a = ADJUST.find((x) => x.key === key);
      state[key] = Number(e.target.value) / a.scale;
      e.target.nextElementSibling.textContent = e.target.value;
      clearTimeout(adjTimer);
      adjTimer = setTimeout(renderPreview, 160);
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener('close', () => finish(null));

    window.addEventListener('resize', layout);
    dlg.tabIndex = -1;
    dlg.showModal();
    dlg.focus({ preventScroll: true }); // ไม่ให้ปุ่มแรกมีวงสีฟ้าค้าง
    layout();
    render();
    if (!corners) autoDetect();
  });
}

const clamp = (v) => Math.min(1, Math.max(0, v));

const EDGES = [[0, 1], [1, 2], [3, 2], [0, 3]]; // บน ขวา ล่าง ซ้าย (ตรงกับ cv-worker.js)
const EDGE_NAMES = ['บน', 'ขวา', 'ล่าง', 'ซ้าย'];

const chordMids = (c) => EDGES.map(([a, b]) => [(c[a][0] + c[b][0]) / 2, (c[a][1] + c[b][1]) / 2]);

/** เส้นกรอบที่ผ่านมุมและจุดกลางขอบ (Bezier กำลังสอง: จุดควบคุม = 2M − (A + B) / 2) */
function outlinePath(c, m) {
  const ctrl = (k) => {
    const [a, b] = EDGES[k];
    return [2 * m[k][0] - (c[a][0] + c[b][0]) / 2, 2 * m[k][1] - (c[a][1] + c[b][1]) / 2];
  };
  const P = (p) => `${p[0]} ${p[1]}`;
  return `M${P(c[0])} Q${P(ctrl(0))} ${P(c[1])} Q${P(ctrl(1))} ${P(c[2])} Q${P(ctrl(2))} ${P(c[3])} Q${P(ctrl(3))} ${P(c[0])}Z`;
}

function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}
