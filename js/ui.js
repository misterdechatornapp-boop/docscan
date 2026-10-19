// ส่วนติดต่อผู้ใช้ที่ใช้ร่วมกัน: ป๊อปอัป เมนูด้านล่าง กล่องยืนยัน กล่องกรอกข้อความ และแถบแจ้งเตือน
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const supportsClosedBy = 'closedBy' in HTMLDialogElement.prototype;

/** สร้าง <dialog> แบบ modal ที่แตะนอกกล่องเพื่อปิดได้ แล้วคืน Promise ของค่าที่ส่งกลับตอนปิด */
export function modal(html, { cls = '', label = '', setup } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = cls;
  dlg.setAttribute('closedby', 'any');
  if (label) dlg.setAttribute('aria-label', label);
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  if (!supportsClosedBy) {
    dlg.addEventListener('click', (e) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
      if (!inside) dlg.close();
    });
  }
  return new Promise((resolve) => {
    // คืนค่าทันทีตอนกดปุ่ม ไม่รอเหตุการณ์ close (บางเบราว์เซอร์ส่งช้า)
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('close', () => finish(null));
    dlg.tabIndex = -1;
    dlg.showModal();
    dlg.focus({ preventScroll: true }); // ไม่ให้ปุ่มแรกมีวงสีฟ้าค้าง (ช่องกรอกจะได้โฟกัสเองใน setup)
    setup?.(dlg, finish);
  });
}

/** เมนูเลื่อนขึ้นจากด้านล่าง: items = [{ id, label, icon, danger }] คืน id ที่เลือก */
export function sheet(title, items) {
  const html = `
    ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
    <div class="sheet-items">
      ${items.map((it) => `<button type="button" class="sheet-item ${it.danger ? 'danger' : ''}" data-id="${esc(it.id)}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`).join('')}
    </div>
    <button type="button" class="sheet-cancel">ยกเลิก</button>`;
  return modal(html, {
    cls: 'sheet', label: title || 'เมนู',
    setup(dlg, finish) {
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest('.sheet-item');
        if (b) finish(b.dataset.id);
        else if (e.target.closest('.sheet-cancel')) finish(null);
      });
    },
  });
}

export function confirmBox(title, message, { ok = 'ตกลง', danger = false } = {}) {
  const html = `
    <h2>${esc(title)}</h2>
    ${message ? `<p class="muted">${esc(message)}</p>` : ''}
    <div class="dlg-actions">
      <button type="button" class="btn" data-v="0">ยกเลิก</button>
      <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-v="1">${esc(ok)}</button>
    </div>`;
  return modal(html, {
    cls: 'box', label: title,
    setup(dlg, finish) {
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (b) finish(b.dataset.v === '1');
      });
    },
  }).then(Boolean);
}

export function promptBox(title, value = '', { ok = 'บันทึก', placeholder = '' } = {}) {
  const html = `
    <form method="dialog">
      <h2>${esc(title)}</h2>
      <input class="input" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done">
      <div class="dlg-actions">
        <button type="button" class="btn" data-cancel>ยกเลิก</button>
        <button type="submit" class="btn btn-primary">${esc(ok)}</button>
      </div>
    </form>`;
  return modal(html, {
    cls: 'box', label: title,
    setup(dlg, finish) {
      const input = dlg.querySelector('input');
      dlg.querySelector('[data-cancel]').onclick = () => finish(null);
      dlg.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v) finish(v);
        else input.focus();
      });
      requestAnimationFrame(() => { input.focus(); input.select(); });
    },
  });
}

let toastTimer;
/** แถบแจ้งเตือนด้านล่าง; action = { label, onClick } (ไม่บังคับ) */
export function toast(message, { action, ms = 2600 } = {}) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.onClick(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** แสดงสถานะกำลังทำงานบนปุ่มระหว่างรอ แล้วคืนค่าผลลัพธ์ของ fn */
export async function withBusy(btn, fn) {
  if (!btn) return fn();
  btn.disabled = true;
  btn.classList.add('busy');
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove('busy'); }
}

/**
 * ตัวบอกความคืบหน้าแบบเต็มจอ · แสดงเฉพาะเมื่อรอนานเกิน 300 ms (งานเร็วจะไม่เห็นหน้าจอกะพริบ)
 */
let progressOwners = 0;
export function progress(text) {
  let el = $('#progress');
  if (!el) {
    el = document.createElement('div');
    el.id = 'progress';
    el.innerHTML = '<div class="spinner"></div><div class="progress-text"></div>';
    document.body.appendChild(el);
  }
  el.querySelector('.progress-text').textContent = text;
  progressOwners++;
  let closed = false;
  const timer = setTimeout(() => { if (!closed) el.classList.add('show'); }, 300);
  return {
    update(t) { el.querySelector('.progress-text').textContent = t; },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (--progressOwners <= 0) { progressOwners = 0; el.classList.remove('show'); }
    },
  };
}

const dateFmt = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (ts) => dateFmt.format(new Date(ts));

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
