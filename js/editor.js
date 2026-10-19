// หน้าปรับภาพ 2 ขั้น: (1) ลากมุมให้ตรงขอบกระดาษ (2) เลือกฟิลเตอร์ + หมุน
import { icon } from './icons.js';
import { esc } from './ui.js';
import { detectPage, imageSource, scaleCanvas, freeCanvas, FULL_FRAME } from './imaging.js';

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

// เปิด/ปิดแผงปรับแสงค้างไว้ระหว่างใช้งาน (ปิดไว้ก่อน ให้ภาพพรีวิวใหญ่)
let adjustOpen = false;

/**
 * เปิดหน้าปรับภาพ
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas ภาพต้นฉบับ
 * @param {number[][]} [o.corners] มุมเดิม (ถ้าไม่ส่ง จะหาขอบอัตโนมัติ)
 * @param {string} o.filter
 * @param {number} [o.rotation]
 * @param {number} [o.contrast] 0..1
 * @param {number} [o.brightness] −1..1
 * @param {number} [o.sharpness] 0..1
 * @param {boolean} [o.straighten] ดัดเส้นตาราง/บรรทัดที่โค้งให้ตรง
 * @param {boolean} [o.fillEdges] เติมขอบที่แหว่ง/พื้นหลังที่ติดมาด้วยสีกระดาษ
 * @param {Function} [o.onContinue] ถ้ามี จะมีปุ่ม "บันทึก + ถ่ายต่อ" (เรียกทันทีในจังหวะแตะ เพื่อให้ iOS ยอมเปิดกล้อง)
 * @returns {Promise<{corners, filter, rotation, contrast, brightness, sharpness, straighten, fillEdges, cont, preview}|null>}
 *   preview = ภาพพรีวิวล่าสุด (canvas) ใช้แสดงทันทีระหว่างบันทึกภาพจริงเบื้องหลัง · ผู้เรียกต้อง freeCanvas เอง
 */
export function openEditor({ canvas, corners, filter, rotation = 0, contrast = 0.5, brightness = 0, sharpness = DEFAULT_LOOK.sharpness, straighten = false, fillEdges = true, onContinue }) {
  const look = { contrast, brightness, sharpness };
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
          <svg class="ed-poly" viewBox="0 0 1 1" preserveAspectRatio="none"><polygon vector-effect="non-scaling-stroke"/></svg>
          ${[0, 1, 2, 3].map((i) => `<div class="ed-h" data-i="${i}" role="slider" aria-label="มุมที่ ${i + 1}" tabindex="0"></div>`).join('')}
        </div>
        <canvas class="ed-loupe" width="240" height="240"></canvas>
        <div class="ed-status"></div>
      </div>
      <footer class="ed-bar">
        <button type="button" class="chip chip-icon" data-act="auto">${icon('wand')}หาขอบอัตโนมัติ</button>
        <button type="button" class="chip chip-icon" data-act="full">${icon('expand')}ใช้ทั้งภาพ</button>
      </footer>
    </section>
    <section class="ed-step" data-step="2" hidden>
      <header class="ed-top">
        <button type="button" class="btn btn-ghost" data-act="back">${icon('back')}ขอบ</button>
        <span class="ed-title"></span>
        <button type="button" class="icon-btn" data-act="rotL" aria-label="หมุนซ้าย">${icon('rotL')}</button>
        <button type="button" class="icon-btn" data-act="rotR" aria-label="หมุนขวา">${icon('rotR')}</button>
        <button type="button" class="btn btn-primary" data-act="save">บันทึก</button>
      </header>
      <div class="ed-stage ed-preview"><div class="spinner"></div></div>
      <div class="ed-panel">
        <div class="ed-chips">
          ${FILTERS.map((f) => `<button type="button" class="chip" data-filter="${f.id}">${esc(f.label)}</button>`).join('')}
        </div>
        <div class="ed-chips">
          <button type="button" class="chip chip-toggle" data-act="straighten" aria-pressed="${straighten}">${icon('lines')}ดัดเส้นให้ตรง</button>
          <button type="button" class="chip chip-toggle" data-act="fillEdges" aria-pressed="${fillEdges}">${icon('fill')}เติมขอบ</button>
          <button type="button" class="chip chip-toggle" data-act="adjust" aria-pressed="${adjustOpen}">${icon('sliders')}ปรับแสง</button>
          ${onContinue ? `<button type="button" class="chip chip-icon chip-accent" data-act="saveMore">${icon('camera')}บันทึก+ถ่ายต่อ</button>` : ''}
        </div>
        <div class="ed-adjust" ${adjustOpen ? '' : 'hidden'}>
          ${ADJUST.map((a) => `
            <div class="adj-row">
              <label for="adj-${a.key}">${a.label}</label>
              <input type="range" id="adj-${a.key}" data-adj="${a.key}" min="${a.min}" max="${a.max}" step="1" value="${Math.round(look[a.key] * a.scale)}">
              <output>${Math.round(look[a.key] * a.scale)}</output>
            </div>`).join('')}
          <button type="button" class="btn btn-ghost adj-reset" data-act="adj-reset">${icon('restore')}ค่าเริ่มต้น</button>
        </div>
      </div>
    </section>`;
  document.body.appendChild(dlg);

  const frame = dlg.querySelector('.ed-frame');
  const stage = dlg.querySelector('.ed-stage');
  const poly = dlg.querySelector('.ed-poly polygon');
  const handles = [...dlg.querySelectorAll('.ed-h')];
  const loupe = dlg.querySelector('.ed-loupe');
  const status = dlg.querySelector('.ed-status');
  const nextBtn = dlg.querySelector('[data-act="next"]');
  const previewBox = dlg.querySelector('.ed-preview');

  const state = {
    corners: corners ? corners.map((p) => [...p]) : FULL_FRAME.map((p) => [...p]),
    filter,
    rotation,
    ...look,
    straighten,
    fillEdges,
  };

  // ภาพสำหรับแสดงบนจอ (ย่อให้พอดีจอ เพื่อความลื่น)
  const display = scaleCanvas(canvas, Math.max(window.innerWidth, window.innerHeight) * Math.min(2, devicePixelRatio || 1));
  display.className = 'ed-img';
  frame.prepend(display);
  let source = null;        // ภาพต้นทางของพรีวิว ส่งให้ตัวประมวลผลครั้งเดียว
  let shownLook = null;     // ค่าปรับแสงของภาพพรีวิวที่แสดงอยู่ (ใช้ทำพรีวิวทันทีระหว่างลากแถบ)

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
    poly.setAttribute('points', state.corners.map((p) => p.join(',')).join(' '));
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
        setStatus('');
      } else {
        state.corners = FULL_FRAME.map((p) => [...p]);
        setStatus('ไม่พบขอบกระดาษ — ลากมุมทั้ง 4 เอง');
      }
    } catch (err) {
      console.error(err);
      setStatus('หาขอบไม่สำเร็จ — ลากมุมเอง');
    }
  }

  /* ----- ลากมุม ----- */
  handles.forEach((h, i) => {
    let off = [0, 0];
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      off = [e.clientX - (r.left + state.corners[i][0] * r.width), e.clientY - (r.top + state.corners[i][1] * r.height)];
      h.setPointerCapture(e.pointerId);
      h.classList.add('dragging');
      status.dataset.msg = '';
      drawLoupe(i);
    });
    h.addEventListener('pointermove', (e) => {
      if (!h.hasPointerCapture(e.pointerId)) return;
      const r = frame.getBoundingClientRect();
      state.corners[i] = [clamp((e.clientX - off[0] - r.left) / r.width), clamp((e.clientY - off[1] - r.top) / r.height)];
      render();
      drawLoupe(i);
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
      state.corners[i] = [clamp(state.corners[i][0] + d[0]), clamp(state.corners[i][1] + d[1])];
      render();
    });
  });

  /**
   * แว่นขยาย: ภาพรอบมุมที่กำลังลาก + เส้นขอบสองเส้นที่ต่อจากมุมนั้น จุดกลางแว่น = ตำแหน่งมุมพอดี
   * แสดงที่มุมจอฝั่งตรงข้ามกับมุมที่ลาก เพื่อไม่บังนิ้วและจุดที่ลาก
   */
  function drawLoupe(i) {
    const ctx = loupe.getContext('2d');
    const L = loupe.width;
    const zoom = 3; // เท่าของภาพบนจอ
    const r = frame.getBoundingClientRect();
    const k = display.width / r.width;          // พิกเซลภาพ ต่อ พิกเซลจอ
    const LOUPE_CSS = 120;                       // ขนาดแว่นบนจอ (ตรงกับ .ed-loupe ใน app.css)
    const half = (LOUPE_CSS / zoom) * k / 2;     // ครึ่งความกว้างของพื้นที่ภาพที่แสดงในแว่น (พิกเซลภาพ)
    const cx = state.corners[i][0] * display.width;
    const cy = state.corners[i][1] * display.height;
    const s = L / (2 * half);                    // พิกเซลแว่น ต่อ พิกเซลภาพ
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, L, L);
    // วาดด้วยการแปลงพิกัด (ไม่ใช้ source rect ที่เลยขอบภาพ ซึ่ง Safari วาดต่างจากเบราว์เซอร์อื่น)
    ctx.setTransform(s, 0, 0, s, L / 2 - cx * s, L / 2 - cy * s);
    ctx.drawImage(display, 0, 0);
    // เส้นขอบกรอบ (พิกัดภาพ)
    const P = state.corners.map(([x, y]) => [x * display.width, y * display.height]);
    ctx.lineWidth = 2 / s;
    ctx.strokeStyle = '#2dd4bf';
    ctx.beginPath();
    P.forEach((p, j) => (j ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.closePath();
    ctx.stroke();
    // เป้าเล็งตรงกลาง
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(L / 2, L / 2, 9, 0, Math.PI * 2);
    ctx.moveTo(L / 2 - 22, L / 2); ctx.lineTo(L / 2 - 12, L / 2);
    ctx.moveTo(L / 2 + 12, L / 2); ctx.lineTo(L / 2 + 22, L / 2);
    ctx.moveTo(L / 2, L / 2 - 22); ctx.lineTo(L / 2, L / 2 - 12);
    ctx.moveTo(L / 2, L / 2 + 12); ctx.lineTo(L / 2, L / 2 + 22);
    ctx.stroke();
    // มุมซ้าย (0, 3) → แว่นไปขวา · มุมบน (0, 1) → แว่นไปล่าง
    loupe.classList.toggle('right', i === 0 || i === 3);
    loupe.classList.toggle('bottom', i === 0 || i === 1);
    loupe.classList.add('show');
  }

  /* ----- ขั้นที่ 2: พรีวิวฟิลเตอร์ ----- */
  let previewToken = 0;
  let spinTimer;
  let closed = false;
  let adjTimer;
  async function renderPreview() {
    if (closed) return;
    const token = ++previewToken;
    // ไม่หรี่ภาพเดิม · ขึ้นวงหมุนเล็ก ๆ เฉพาะเมื่อรอนานเกิน 300 ms
    clearTimeout(spinTimer);
    spinTimer = setTimeout(() => previewBox.classList.add('loading'), 300);
    dlg.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));
    try {
      if (!source) {
        const src = scaleCanvas(canvas, 1100);
        source = imageSource(src);
        source.canvas = src;
      }
      const look = { ...state };
      const out = await source.process(look);
      if (token !== previewToken || closed) { freeCanvas(out); return; }
      out.className = 'ed-preview-img';
      const old = previewBox.querySelector('canvas');
      if (old) { old.replaceWith(out); freeCanvas(old); } else previewBox.appendChild(out);
      shownLook = look;
      liveAdjust();
    } catch (err) {
      console.error(err);
    } finally {
      if (token === previewToken) {
        clearTimeout(spinTimer);
        previewBox.classList.remove('loading');
      }
    }
  }

  /** ระหว่างลากแถบปรับแสง: ปรับภาพที่แสดงอยู่ด้วย CSS ทันที แล้วค่อยแทนด้วยผลจริง */
  function liveAdjust() {
    const c = previewBox.querySelector('canvas');
    if (!c || !shownLook) return;
    const db = state.brightness - shownLook.brightness;
    const dc = state.contrast - shownLook.contrast;
    c.style.filter = Math.abs(db) + Math.abs(dc) < 0.005 ? '' : `brightness(${1 + db * 0.6}) contrast(${1 + dc * 1.4})`;
  }

  const result = () => ({ ...state, corners: state.corners.map((p) => [...p]), mids: null });

  /** ภาพพรีวิวล่าสุด (ถ้าตรงกับค่าที่บันทึก) ส่งให้ผู้เรียกแสดงทันที */
  function takePreview() {
    const c = previewBox.querySelector('canvas');
    if (!c || !shownLook) return null;
    const same = ['filter', 'rotation', 'contrast', 'brightness', 'straighten', 'fillEdges'].every((k) => shownLook[k] === state[k])
      && JSON.stringify(shownLook.corners) === JSON.stringify(state.corners);
    if (!same) return null;
    c.remove();
    c.style.filter = '';
    return c;
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
      closed = true;
      clearTimeout(adjTimer);
      clearTimeout(spinTimer);
      window.removeEventListener('resize', layout);
      if (dlg.open) dlg.close();
      freeCanvas(display);
      source?.drop();
      freeCanvas(source?.canvas);
      previewBox.querySelectorAll('canvas').forEach(freeCanvas);
      dlg.remove();
      resolve(value);
    };

    dlg.addEventListener('click', (e) => {
      const fb = e.target.closest('[data-filter]');
      if (fb) { state.filter = fb.dataset.filter; renderPreview(); return; }
      const btn = e.target.closest('[data-act]');
      const act = btn?.dataset.act;
      if (act === 'cancel') finish(null);
      else if (act === 'next') showStep(2);
      else if (act === 'back') showStep(1);
      else if (act === 'auto') autoDetect();
      else if (act === 'full') { state.corners = FULL_FRAME.map((p) => [...p]); setStatus(''); }
      else if (act === 'adjust') {
        adjustOpen = !adjustOpen;
        btn.setAttribute('aria-pressed', String(adjustOpen));
        dlg.querySelector('.ed-adjust').hidden = !adjustOpen;
      } else if (act === 'adj-reset') {
        Object.assign(state, DEFAULT_LOOK);
        syncAdjust();
        renderPreview();
      } else if (act === 'straighten' || act === 'fillEdges') {
        state[act] = !state[act];
        btn.setAttribute('aria-pressed', String(state[act]));
        renderPreview();
      }
      else if (act === 'rotL' || act === 'rotR') {
        const d = act === 'rotL' ? -90 : 90;
        state.rotation = (state.rotation + 360 + d) % 360;
        // หมุนภาพที่แสดงอยู่ทันที แล้วแทนด้วยผลจริงเมื่อเสร็จ
        const c = previewBox.querySelector('canvas');
        if (c) {
          c.dataset.turn = String((Number(c.dataset.turn) || 0) + d);
          c.style.rotate = `${c.dataset.turn}deg`;
        }
        renderPreview();
      }
      else if (act === 'save') finish({ ...result(), cont: false, preview: takePreview() });
      else if (act === 'saveMore') { onContinue(); finish({ ...result(), cont: true, preview: takePreview() }); }
    });
    // ลากแถบปรับภาพ: รอให้หยุดลากสักนิดค่อยคำนวณพรีวิวใหม่
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
      liveAdjust();
      clearTimeout(adjTimer);
      adjTimer = setTimeout(renderPreview, 220);
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
