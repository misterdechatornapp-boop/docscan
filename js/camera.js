// กล้องในแอป: เปิดไฟฉายได้ · ถ่ายต่อเนื่องหรือทีละหน้า · มีเสียงชัตเตอร์
import { icon } from './icons.js';
import { toast } from './ui.js';
import { detectCorners, scaleCanvas, freeCanvas, toBlob } from './imaging.js';
import { shutterSound } from './sound.js';

export const cameraSupported = () => !!navigator.mediaDevices?.getUserMedia;

/**
 * เปิดกล้องเต็มจอ
 * @param {object} o
 * @param {'batch'|'single'} o.mode ต่อเนื่อง = ถ่ายแล้วเก็บทันที จัดขอบอัตโนมัติ · ทีละหน้า = เปิดหน้าปรับภาพทุกครั้ง
 * @param {(mode: string) => void} o.onModeChange
 * @param {(canvas: HTMLCanvasElement) => Promise<'saved'|'done'|'cancel'>} o.onShot โหมดทีละหน้า: เปิดหน้าปรับภาพ/บันทึก
 * @param {(blob: Blob) => void} o.onBatchShot โหมดต่อเนื่อง: ส่งภาพไปจัดขอบ/บันทึกเบื้องหลัง
 * @param {Function} o.onSystemCamera เรียกทันทีในจังหวะแตะ เมื่อผู้ใช้เลือกกล้องของระบบ
 * @param {boolean} [o.sound] เสียงชัตเตอร์
 * @returns {Promise<{error?: Error}>} เสร็จเมื่อปิดกล้อง
 */
export async function openCameraView({ mode = 'batch', onModeChange, onShot, onBatchShot, onSystemCamera, sound = true }) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (error) {
    return { error };
  }
  const track = stream.getVideoTracks()[0];

  const dlg = document.createElement('dialog');
  dlg.className = 'camera';
  dlg.tabIndex = -1;
  dlg.setAttribute('aria-label', 'กล้องถ่ายเอกสาร');
  dlg.innerHTML = `
    <video class="cam-video" playsinline muted autoplay></video>
    <div class="cam-flash"></div>
    <header class="cam-top">
      <button type="button" class="cam-btn" data-act="close" aria-label="ปิดกล้อง">${icon('close')}</button>
      <div class="cam-center">
        <div class="cam-mode" role="radiogroup" aria-label="โหมดถ่าย">
          <button type="button" role="radio" data-mode="batch">ต่อเนื่อง</button>
          <button type="button" role="radio" data-mode="single">ทีละหน้า</button>
        </div>
        <span class="cam-hint">เล็งให้เห็นกระดาษทั้งแผ่น</span>
      </div>
      <button type="button" class="cam-btn" data-act="torch" aria-label="ไฟฉาย" aria-pressed="false">${icon('flash')}</button>
    </header>
    <footer class="cam-bottom">
      <button type="button" class="cam-side" data-act="system">${icon('camera')}<span>กล้องระบบ</span></button>
      <button type="button" class="cam-shutter" data-act="shoot" aria-label="ถ่าย"></button>
      <button type="button" class="cam-side" data-act="done"><span class="cam-count"><img alt="" hidden><b>0</b></span><span>เสร็จ</span></button>
    </footer>`;
  document.body.appendChild(dlg);

  const video = dlg.querySelector('video');
  const hint = dlg.querySelector('.cam-hint');
  const torchBtn = dlg.querySelector('[data-act="torch"]');
  const shutter = dlg.querySelector('[data-act="shoot"]');
  video.srcObject = stream;
  video.play().catch(() => {});

  let torchOn = false;
  let busy = false;      // กำลังเปิดหน้าปรับภาพอยู่
  let detecting = false;
  let shots = 0;
  let closed = false;
  const encoding = new Set(); // ภาพที่กำลังแปลงเป็นไฟล์ (รอให้ครบก่อนปิดกล้อง)
  const setMode = (m) => {
    mode = m;
    dlg.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
  };
  const bumpCount = (thumbUrl) => {
    shots++;
    dlg.querySelector('.cam-count b').textContent = shots;
    if (thumbUrl) {
      const img = dlg.querySelector('.cam-count img');
      img.src = thumbUrl;
      img.hidden = false;
    }
  };
  const flash = () => {
    if (sound) shutterSound();
    dlg.querySelector('.cam-flash').animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 220 });
  };

  // บอกเพียงข้อความว่าเห็นกระดาษหรือยัง (ไม่วาดกรอบทับภาพ เพื่อให้ภาพกล้องลื่น)
  async function detectLoop() {
    if (closed) return;
    if (!busy && !detecting && video.videoWidth) {
      detecting = true;
      try {
        const frame = grabFrame(480);
        const corners = await detectCorners(frame);
        freeCanvas(frame);
        if (!busy && !closed) hint.textContent = corners ? 'พบเอกสาร · กดถ่ายได้เลย' : 'เล็งให้เห็นกระดาษทั้งแผ่น';
      } catch { /* ข้ามรอบนี้ */ }
      detecting = false;
    }
    setTimeout(detectLoop, 800);
  }

  function grabFrame(maxSide = Infinity) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    if (maxSide === Infinity) return c;
    const small = scaleCanvas(c, maxSide);
    freeCanvas(c);
    return small;
  }

  /* ----- ไฟฉาย ----- */
  async function setTorch(on) {
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      torchOn = on;
      torchBtn.setAttribute('aria-pressed', String(on));
    } catch {
      toast('เครื่องนี้เปิดไฟฉายจากแอปไม่ได้ · ลองใช้กล้องระบบ แล้วกดปุ่มแฟลชในกล้องแทน', { ms: 4000 });
    }
  }

  return new Promise((resolve) => {
    const close = () => {
      if (closed) return;
      closed = true;
      stream.getTracks().forEach((t) => t.stop());
      if (dlg.open) dlg.close();
      dlg.remove();
      Promise.allSettled([...encoding]).then(() => resolve({}));
    };

    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!busy) close(); });
    dlg.addEventListener('click', async (e) => {
      const modeBtn = e.target.closest('[data-mode]');
      if (modeBtn && !busy) { setMode(modeBtn.dataset.mode); onModeChange?.(mode); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act || busy) return;
      if (act === 'close' || act === 'done') close();
      else if (act === 'torch') setTorch(!torchOn);
      else if (act === 'system') { onSystemCamera(); close(); }
      else if (act === 'shoot' && mode === 'batch') {
        if (!video.videoWidth || shutter.disabled) return;
        shutter.disabled = true;
        const canvas = grabFrame();
        flash();
        const thumb = scaleCanvas(canvas, 120);
        const thumbUrl = thumb.toDataURL('image/jpeg', 0.6);
        freeCanvas(thumb);
        // เก็บเป็นไฟล์ JPEG ทันทีแล้วคืนหน่วยความจำ (ถ่ายรัว ๆ หลายสิบหน้าก็ไม่ค้าง)
        const job = toBlob(canvas, 0.92).then((blob) => {
          freeCanvas(canvas);
          onBatchShot(blob);
        });
        encoding.add(job);
        job.finally(() => encoding.delete(job));
        bumpCount(thumbUrl);
        setTimeout(() => { shutter.disabled = false; }, 250);
      } else if (act === 'shoot') {
        if (!video.videoWidth) return;
        busy = true;
        shutter.disabled = true;
        const canvas = grabFrame();
        flash();
        try {
          const next = await onShot(canvas);
          if (next === 'saved' || next === 'done') bumpCount();
          if (next === 'done') return close();
        } finally {
          busy = false;
          shutter.disabled = false;
        }
      }
    });

    setMode(mode);
    dlg.showModal();
    // ไม่ให้ปุ่มแรกถูกเลือกค้าง (iPhone จะแสดงวงสีฟ้ารอบปุ่ม)
    dlg.focus({ preventScroll: true });
    detectLoop();
  });
}
