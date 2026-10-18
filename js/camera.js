// กล้องในแอป: เปิดไฟฉายได้ และเห็นกรอบเอกสารสดขณะเล็ง
import { icon } from './icons.js';
import { toast } from './ui.js';
import { detectCorners, scaleCanvas, freeCanvas } from './imaging.js';

export const cameraSupported = () => !!navigator.mediaDevices?.getUserMedia;

/**
 * เปิดกล้องเต็มจอ
 * @param {object} o
 * @param {(canvas: HTMLCanvasElement) => Promise<'continue'|'done'>} o.onShot เรียกหลังกดชัตเตอร์ (เปิดหน้าปรับภาพ/บันทึก)
 * @param {Function} o.onSystemCamera เรียกทันทีในจังหวะแตะ เมื่อผู้ใช้เลือกกล้องของระบบ
 * @returns {Promise<{error?: Error}>} เสร็จเมื่อปิดกล้อง
 */
export async function openCameraView({ onShot, onSystemCamera }) {
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
  dlg.setAttribute('aria-label', 'กล้องถ่ายเอกสาร');
  dlg.innerHTML = `
    <video class="cam-video" playsinline muted autoplay></video>
    <canvas class="cam-overlay"></canvas>
    <div class="cam-flash"></div>
    <header class="cam-top">
      <button type="button" class="cam-btn" data-act="close" aria-label="ปิดกล้อง">${icon('close')}</button>
      <span class="cam-hint">เล็งให้เห็นกระดาษทั้งแผ่น</span>
      <button type="button" class="cam-btn" data-act="torch" aria-label="ไฟฉาย" aria-pressed="false">${icon('flash')}</button>
    </header>
    <footer class="cam-bottom">
      <button type="button" class="cam-side" data-act="system">${icon('camera')}<span>กล้องระบบ</span></button>
      <button type="button" class="cam-shutter" data-act="shoot" aria-label="ถ่าย"></button>
      <button type="button" class="cam-side" data-act="done"><span class="cam-count">0</span><span>เสร็จ</span></button>
    </footer>`;
  document.body.appendChild(dlg);

  const video = dlg.querySelector('video');
  const overlay = dlg.querySelector('.cam-overlay');
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

  /* ----- กรอบเอกสารสด ----- */
  function videoRect() {
    // ตำแหน่งภาพจริงบนจอ (video ใช้ object-fit: contain)
    const W = overlay.clientWidth, H = overlay.clientHeight;
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(W / vw, H / vh);
    return { s, x: (W - vw * s) / 2, y: (H - vh * s) / 2, vw, vh };
  }

  function drawQuad(corners) {
    const dpr = devicePixelRatio || 1;
    overlay.width = overlay.clientWidth * dpr;
    overlay.height = overlay.clientHeight * dpr;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!corners) return;
    const r = videoRect();
    ctx.scale(dpr, dpr);
    ctx.beginPath();
    corners.forEach(([x, y], i) => {
      const px = r.x + x * r.vw * r.s, py = r.y + y * r.vh * r.s;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(45, 212, 191, 0.18)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#2dd4bf';
    ctx.stroke();
  }

  async function detectLoop() {
    if (closed) return;
    if (!busy && !detecting && video.videoWidth) {
      detecting = true;
      try {
        const frame = grabFrame(640);
        const corners = await detectCorners(frame);
        freeCanvas(frame);
        if (!busy && !closed) {
          drawQuad(corners);
          hint.textContent = corners ? 'พบเอกสาร · กดถ่ายได้เลย' : 'เล็งให้เห็นกระดาษทั้งแผ่น';
        }
      } catch { /* ข้ามรอบนี้ */ }
      detecting = false;
    }
    setTimeout(detectLoop, 400);
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
      resolve({});
    };

    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!busy) close(); });
    dlg.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act || busy) return;
      if (act === 'close' || act === 'done') close();
      else if (act === 'torch') setTorch(!torchOn);
      else if (act === 'system') { onSystemCamera(); close(); }
      else if (act === 'shoot') {
        if (!video.videoWidth) return;
        busy = true;
        shutter.disabled = true;
        const canvas = grabFrame();
        dlg.querySelector('.cam-flash').animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 250 });
        drawQuad(null);
        try {
          const next = await onShot(canvas);
          if (next === 'saved' || next === 'done') {
            shots++;
            dlg.querySelector('.cam-count').textContent = shots;
          }
          if (next === 'done') return close();
        } finally {
          busy = false;
          shutter.disabled = false;
        }
      }
    });

    dlg.showModal();
    detectLoop();
  });
}
