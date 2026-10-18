// สแกนง่าย — ตัวแอปหลัก: หน้ารายการ / เอกสาร / หน้าเดี่ยว / ถังขยะ / ตั้งค่า
import * as db from './db.js';
import { icon } from './icons.js';
import { $, esc, modal, sheet, confirmBox, promptBox, toast, withBusy, progress, fmtDate, fmtSize } from './ui.js';
import { loadCanvas, toBlob, freeCanvas, scaleCanvas, detectPage, processCanvas, warmup, FULL_FRAME, THUMB_SIDE } from './imaging.js';
import { openEditor, FILTERS } from './editor.js';
import { buildPdf, buildJpgs, canShareFiles, shareFiles, downloadFiles, QUALITIES } from './exporter.js';
import { openCameraView, cameraSupported } from './camera.js';
import Sortable from '../vendor/sortable.esm.js';
import { VERSION, APP_NAME, TRASH_DAYS } from './config.js';

const DEFAULT_SETTINGS = { filter: 'color', contrast: 0.5, straighten: true, camera: 'app', camMode: 'batch', pageSize: 'a4', quality: 'medium', format: 'pdf' };
let settings = { ...DEFAULT_SETTINGS };

const app = $('#app');
const camInput = $('#in-camera');
const galInput = $('#in-gallery');

/* ---------- object URL ของภาพ (คืนหน่วยความจำทุกครั้งที่เปลี่ยนหน้า) ---------- */
let urls = [];
function blobUrl(blob) {
  if (!blob) return '';
  const u = URL.createObjectURL(blob);
  urls.push(u);
  return u;
}
function releaseUrls() {
  // คืนแบบหน่วงเวลา: ภาพของหน้าเดิมที่ยังโหลดค้างอยู่จะไม่ขึ้น error
  const old = urls;
  urls = [];
  setTimeout(() => old.forEach((u) => URL.revokeObjectURL(u)), 2000);
}

/* ---------- เส้นทางในแอป (#/...) ---------- */
function parseRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'trash') return { view: 'trash' };
  if (p[0] === 'folder' && p[1]) return { view: 'home', folderId: p[1] };
  if (p[0] === 'doc' && p[1] && p[2] === 'page') return { view: 'page', docId: p[1], index: Math.max(0, Number(p[3]) || 0) };
  if (p[0] === 'doc' && p[1]) return { view: 'doc', docId: p[1] };
  return { view: 'home' };
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const currentFolderId = () => parseRoute().folderId || null;

let sortable = null;
let searchQuery = '';

// วาดหน้าทีละครั้งตามลำดับ: หน้าที่สั่งทีหลังวาดทีหลังเสมอ (กันหน้าเก่าวาดทับหน้าใหม่)
let routing = Promise.resolve();
function route() {
  routing = routing.then(renderRoute, renderRoute);
  return routing;
}

async function renderRoute() {
  const r = parseRoute();
  releaseUrls();
  if (r.view !== 'doc') selection = null;
  sortable?.destroy();
  sortable = null;
  try {
    if (r.view === 'trash') await renderTrash();
    else if (r.view === 'doc') await renderDoc(r.docId);
    else if (r.view === 'page') await renderPage(r.docId, r.index);
    else await renderHome(r.folderId);
  } catch (err) {
    console.error(err);
    toast('เกิดข้อผิดพลาด: ' + err.message);
  }
}
window.addEventListener('hashchange', route);

/* ---------- ข้อมูล ---------- */
async function liveDocs() {
  return (await db.getAll('docs')).filter((d) => !d.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function newDocRecord(id, folderId) {
  const n = (await db.getMeta('counter', 0)) + 1;
  await db.setMeta('counter', n);
  const now = Date.now();
  return { id, name: `เอกสาร ${n}`, folderId: folderId || null, pageIds: [], size: 0, thumb: null, createdAt: now, updatedAt: now, deletedAt: null };
}

/** คำนวณขนาด/ภาพปก/ลำดับหน้าใหม่ แล้วบันทึก */
async function refreshDoc(doc) {
  const pages = await db.pagesOf(doc);
  doc.pageIds = pages.map((p) => p.id);
  doc.size = pages.reduce((s, p) => s + p.processed.size, 0);
  doc.thumb = pages[0]?.thumb || null;
  doc.updatedAt = Date.now();
  await db.put('docs', doc);
  return doc;
}

async function appendPages(docId, pages, folderId) {
  const doc = (await db.get('docs', docId)) || (await newDocRecord(docId, folderId));
  doc.pageIds.push(...pages.map((p) => p.id));
  await refreshDoc(doc);
  requestPersist();
}

/** ประมวลผลภาพจริง (ความละเอียดเต็ม) แล้วเก็บเป็นหน้าใหม่หรือทับหน้าเดิม */
async function buildPage(docId, srcCanvas, opts, existing) {
  const out = await processCanvas(srcCanvas, opts);
  const processed = await toBlob(out, 0.85);
  const thumbCanvas = scaleCanvas(out, THUMB_SIDE);
  const thumb = await toBlob(thumbCanvas, 0.7);
  freeCanvas(out);
  freeCanvas(thumbCanvas);
  const page = existing || { id: db.uid(), docId, createdAt: Date.now(), original: await toBlob(srcCanvas, 0.9) };
  Object.assign(page, {
    processed, thumb,
    corners: opts.corners, mids: opts.mids || null,
    filter: opts.filter, rotation: opts.rotation || 0, contrast: opts.contrast ?? 0.5,
    straighten: !!opts.straighten,
    needsReview: !!opts.needsReview,
  });
  await db.put('pages', page);
  return page;
}

// บันทึกทีละงานตามลำดับ (ถ่ายต่อเนื่องได้โดยไม่ต้องรอ)
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

let persistAsked = false;
function requestPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  navigator.storage.persist().catch(() => {});
}

/* ---------- ถ่ายรูป / เลือกรูป ---------- */
let camTarget = null;
let galTarget = null;

/** กล้องของระบบ (ภาพคมสุด แต่คุมไฟฉายไม่ได้) — ต้องเรียกในจังหวะแตะ */
function openSystemCamera(target) {
  camTarget = target;
  camInput.value = '';
  camInput.click();
}

/** กล้องในแอป (ไฟฉาย + กรอบสด) ถ้าใช้ไม่ได้จะใช้กล้องของระบบแทน */
async function openCamera(docId) {
  warmup().catch(() => {});
  const target = { docId: docId || db.uid(), folderId: currentFolderId() };
  if (settings.camera === 'system' || !cameraSupported()) return openSystemCamera(target);
  let saved = 0;
  const res = await openCameraView({
    mode: settings.camMode,
    onModeChange: (m) => { settings.camMode = m; db.setMeta('settings', settings); },
    onSystemCamera: () => openSystemCamera(target),
    onBatchShot: (blob) => {
      saved++;
      enqueue(() => autoPage(target.docId, blob, target.folderId))
        .catch((err) => toast('บันทึกไม่สำเร็จ: ' + err.message));
    },
    onShot: async (canvas) => {
      const r = await openEditor({ canvas, filter: settings.filter, contrast: settings.contrast, straighten: settings.straighten, onContinue: () => {} });
      if (!r) { freeCanvas(canvas); return 'cancel'; }
      rememberLook(r);
      saved++;
      enqueue(async () => {
        const page = await buildPage(target.docId, canvas, r);
        await appendPages(target.docId, [page], target.folderId);
      }).catch((err) => toast('บันทึกไม่สำเร็จ: ' + err.message)).finally(() => freeCanvas(canvas));
      return r.cont ? 'saved' : 'done';
    },
  });
  if (res.error) {
    toast('เปิดกล้องในแอปไม่ได้ · ใช้กล้องของระบบแทน', { ms: 3500 });
    console.warn(res.error);
    return;
  }
  if (!saved) return;
  const prog = progress('กำลังจัดขอบและบันทึก…');
  await queue;
  prog.close();
  if (parseRoute().view === 'doc' && parseRoute().docId === target.docId) route();
  else go(`#/doc/${target.docId}`);
}

/**
 * บันทึกภาพเป็นหน้าใหม่โดยไม่ต้องเปิดหน้าปรับภาพ: หาขอบ (รวมขอบโค้ง) + ฟิลเตอร์ล่าสุดอัตโนมัติ
 * หาขอบไม่เจอ = ใช้ทั้งภาพ แล้วติดป้าย "ตรวจขอบ" ไว้ให้มาแก้ทีหลัง
 */
async function autoPage(docId, blob, folderId) {
  const c = await loadCanvas(blob);
  try {
    const found = await detectPage(c);
    const page = await buildPage(docId, c, {
      corners: found?.corners || FULL_FRAME,
      mids: found?.mids || null,
      filter: settings.filter,
      contrast: settings.contrast,
      straighten: settings.straighten,
      rotation: 0,
      needsReview: !found,
    });
    await appendPages(docId, [page], folderId);
    return page;
  } finally {
    freeCanvas(c);
  }
}

/** จำฟิลเตอร์/คอนทราสต์ล่าสุดไว้ใช้กับภาพถัดไป */
function rememberLook(r) {
  if (settings.filter === r.filter && settings.contrast === r.contrast && settings.straighten === r.straighten) return;
  Object.assign(settings, { filter: r.filter, contrast: r.contrast, straighten: r.straighten });
  db.setMeta('settings', settings);
}

function openGallery(docId) {
  warmup().catch(() => {});
  galTarget = { docId: docId || null, folderId: currentFolderId() };
  galInput.value = '';
  galInput.click();
}

camInput.addEventListener('change', () => {
  const f = camInput.files[0];
  if (f) editAndSave(f, camTarget, true);
});

galInput.addEventListener('change', () => {
  const files = [...galInput.files];
  if (files.length === 1) editAndSave(files[0], galTarget, false);
  else if (files.length > 1) importMany(files, galTarget);
});

async function editAndSave(file, target, fromCamera) {
  const docId = target?.docId || db.uid();
  let canvas;
  try {
    canvas = await loadCanvas(file);
  } catch {
    toast('เปิดภาพนี้ไม่ได้');
    return;
  }
  const res = await openEditor({
    canvas,
    filter: settings.filter,
    contrast: settings.contrast,
    straighten: settings.straighten,
    onContinue: fromCamera ? () => openSystemCamera({ docId, folderId: target?.folderId }) : null,
  });
  if (!res) {
    freeCanvas(canvas);
    return;
  }
  rememberLook(res);
  toast('กำลังบันทึก…', { ms: 0 });
  try {
    await enqueue(async () => {
      const page = await buildPage(docId, canvas, res);
      await appendPages(docId, [page], target?.folderId);
    });
    toast('บันทึกแล้ว');
  } catch (err) {
    console.error(err);
    toast('บันทึกไม่สำเร็จ: ' + err.message);
  } finally {
    freeCanvas(canvas);
  }
  if (parseRoute().docId === docId && parseRoute().view === 'doc') route();
  else go(`#/doc/${docId}`);
}

async function importMany(files, target) {
  const docId = target?.docId || db.uid();
  const prog = progress(`กำลังเตรียม…`);
  let failed = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      prog.update(`กำลังประมวลผลภาพ ${i + 1}/${files.length}`);
      try {
        await enqueue(() => autoPage(docId, files[i], target?.folderId));
      } catch (err) {
        console.error(err);
        failed++;
      }
    }
  } finally {
    prog.close();
  }
  toast(failed ? `นำเข้าไม่สำเร็จ ${failed} ภาพ` : `นำเข้า ${files.length} ภาพแล้ว`);
  if ((await db.get('docs', docId))) go(`#/doc/${docId}`);
}

/* ---------- หน้ารายการเอกสาร ---------- */
async function renderHome(folderId) {
  const [docs, folders] = await Promise.all([liveDocs(), db.getAll('folders')]);
  const folder = folderId ? folders.find((f) => f.id === folderId) : null;
  if (folderId && !folder) return go('#/');
  const q = searchQuery.trim().toLowerCase();
  const shownDocs = q
    ? docs.filter((d) => d.name.toLowerCase().includes(q))
    : docs.filter((d) => (d.folderId || null) === (folderId || null));
  const shownFolders = !q && !folderId ? folders.sort((a, b) => a.name.localeCompare(b.name, 'th')) : [];
  const trashCount = (await db.getAll('docs')).filter((d) => d.deletedAt).length;

  app.innerHTML = `
    <header class="topbar">
      ${folder ? `<button class="icon-btn" data-act="up" aria-label="กลับ">${icon('back')}</button>` : ''}
      <h1>${folder ? esc(folder.name) : 'เอกสารของฉัน'} <span class="count">(${shownDocs.length})</span></h1>
      <button class="icon-btn" data-act="search" aria-label="ค้นหา">${icon('search')}</button>
      <button class="icon-btn" data-act="menu" aria-label="เมนู">${icon('more')}</button>
    </header>
    <div class="searchbar" ${q || searchOpen ? '' : 'hidden'}>
      <input type="search" class="input" id="search" placeholder="ค้นหาชื่อเอกสาร" value="${esc(searchQuery)}" enterkeyhint="search">
    </div>
    <main class="scroll list">
      ${shownFolders.map((f) => folderRow(f, docs)).join('')}
      ${shownDocs.map(docRow).join('')}
      ${!shownDocs.length && !shownFolders.length ? emptyState(q) : ''}
    </main>
    <footer class="bottombar">
      <button class="bar-btn" data-act="gallery">${icon('image')}<span>รูปภาพ</span></button>
      <button class="shutter" data-act="camera" aria-label="ถ่ายเอกสาร">${icon('camera')}</button>
      <span class="bar-spacer"></span>
    </footer>`;

  const search = $('#search');
  search.addEventListener('input', () => {
    searchQuery = search.value;
    const pos = search.selectionStart;
    renderHome(folderId).then(() => {
      const s = $('#search');
      s.focus();
      s.setSelectionRange(pos, pos);
    });
  });

  app.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    const id = t.closest('[data-id]')?.dataset.id;
    if (act === 'camera') openCamera(null);
    else if (act === 'gallery') openGallery(null);
    else if (act === 'up') go('#/');
    else if (act === 'search') toggleSearch(folderId);
    else if (act === 'menu') homeMenu(folder, trashCount);
    else if (act === 'open-doc') go(`#/doc/${id}`);
    else if (act === 'open-folder') { searchQuery = ''; go(`#/folder/${id}`); }
    else if (act === 'doc-menu') docMenu(await db.get('docs', id));
    else if (act === 'folder-menu') folderMenu(folders.find((f) => f.id === id));
  };
}

let searchOpen = false;
function toggleSearch(folderId) {
  searchOpen = !searchOpen;
  if (!searchOpen) searchQuery = '';
  renderHome(folderId).then(() => { if (searchOpen) $('#search')?.focus(); });
}

function emptyState(q) {
  if (q) return `<div class="empty">ไม่พบเอกสารที่ชื่อมีคำว่า “${esc(q)}”</div>`;
  return `<div class="empty">${icon('file', 'empty-ic')}<div>ยังไม่มีเอกสาร</div><div class="muted">แตะปุ่มกล้องด้านล่างเพื่อถ่ายเอกสารแผ่นแรก</div></div>`;
}

function folderRow(f, docs) {
  const n = docs.filter((d) => d.folderId === f.id).length;
  return `
    <div class="row" data-id="${f.id}">
      <button class="row-main" data-act="open-folder">
        <span class="row-thumb folder-thumb">${icon('folder')}</span>
        <span class="row-text"><span class="row-title">${esc(f.name)}</span><span class="row-sub">${n} เอกสาร</span></span>
      </button>
      <button class="icon-btn" data-act="folder-menu" aria-label="ตัวเลือกโฟลเดอร์">${icon('more')}</button>
    </div>`;
}

function docRow(d) {
  return `
    <div class="row" data-id="${d.id}">
      <button class="row-main" data-act="open-doc">
        <span class="row-thumb">${d.thumb ? `<img src="${blobUrl(d.thumb)}" alt="">` : icon('file')}</span>
        <span class="row-text">
          <span class="row-title">${esc(d.name)}</span>
          <span class="row-sub">${fmtSize(d.size || 0)} <span class="badge">${d.pageIds.length}</span></span>
          <span class="row-sub">${fmtDate(d.updatedAt)}</span>
        </span>
      </button>
      <button class="icon-btn" data-act="doc-menu" aria-label="ตัวเลือกเอกสาร">${icon('more')}</button>
    </div>`;
}

async function homeMenu(folder, trashCount) {
  const items = folder
    ? [
        { id: 'rename-folder', label: 'เปลี่ยนชื่อโฟลเดอร์', icon: 'pencil' },
        { id: 'delete-folder', label: 'ลบโฟลเดอร์', icon: 'trash', danger: true },
      ]
    : [{ id: 'new-folder', label: 'โฟลเดอร์ใหม่', icon: 'folderPlus' }];
  items.push(
    { id: 'trash', label: `ถังขยะ (${trashCount})`, icon: 'trash' },
    { id: 'settings', label: 'ตั้งค่า', icon: 'settings' },
  );
  const act = await sheet('', items);
  if (act === 'new-folder') await createFolder();
  else if (act === 'rename-folder' || act === 'delete-folder') return folderMenu(folder, act);
  else if (act === 'trash') go('#/trash');
  else if (act === 'settings') openSettings();
  route();
}

async function createFolder() {
  const name = await promptBox('โฟลเดอร์ใหม่', '', { ok: 'สร้าง', placeholder: 'ชื่อโฟลเดอร์' });
  if (!name) return null;
  const f = { id: db.uid(), name, createdAt: Date.now() };
  await db.put('folders', f);
  return f;
}

async function folderMenu(folder, preset) {
  const act = preset || (await sheet(folder.name, [
    { id: 'rename-folder', label: 'เปลี่ยนชื่อ', icon: 'pencil' },
    { id: 'delete-folder', label: 'ลบโฟลเดอร์', icon: 'trash', danger: true },
  ]));
  if (act === 'rename-folder') {
    const name = await promptBox('เปลี่ยนชื่อโฟลเดอร์', folder.name);
    if (name) await db.put('folders', { ...folder, name });
  } else if (act === 'delete-folder') {
    const ok = await confirmBox(`ลบโฟลเดอร์ “${folder.name}”?`, 'เอกสารข้างในจะย้ายออกมาอยู่หน้าหลัก ไม่ถูกลบ', { ok: 'ลบโฟลเดอร์', danger: true });
    if (!ok) return;
    for (const d of await db.getAll('docs')) {
      if (d.folderId === folder.id) await db.put('docs', { ...d, folderId: null });
    }
    await db.del('folders', folder.id);
    toast('ลบโฟลเดอร์แล้ว');
    if (parseRoute().folderId === folder.id) return go('#/');
  }
  route();
}

async function docMenu(doc, inDoc = false) {
  const act = await sheet(doc.name, [
    ...(inDoc && doc.pageIds.length ? [{ id: 'select', label: 'เลือกหน้า', icon: 'select' }] : []),
    { id: 'export', label: 'ส่งออก / แชร์', icon: 'share' },
    { id: 'rename', label: 'เปลี่ยนชื่อเอกสาร', icon: 'pencil' },
    { id: 'move', label: 'ย้ายไปโฟลเดอร์', icon: 'move' },
    { id: 'delete', label: 'ลบ', icon: 'trash', danger: true },
  ]);
  if (act === 'export') return openExport(doc);
  if (act === 'select') { selection = { docId: doc.id, ids: new Set() }; return route(); }
  if (act === 'rename') await renameDoc(doc);
  else if (act === 'move') await moveDoc(doc);
  else if (act === 'delete') {
    await deleteDoc(doc);
    if (parseRoute().docId === doc.id) return go(doc.folderId ? `#/folder/${doc.folderId}` : '#/');
  }
  route();
}

async function renameDoc(doc) {
  const name = await promptBox('เปลี่ยนชื่อเอกสาร', doc.name);
  if (name) await db.put('docs', { ...doc, name, updatedAt: Date.now() });
}

async function moveDoc(doc) {
  const folders = (await db.getAll('folders')).sort((a, b) => a.name.localeCompare(b.name, 'th'));
  const items = [
    { id: '__root', label: doc.folderId ? 'หน้าหลัก (ไม่อยู่ในโฟลเดอร์)' : 'หน้าหลัก ✓', icon: 'file' },
    ...folders.map((f) => ({ id: f.id, label: f.name + (f.id === doc.folderId ? ' ✓' : ''), icon: 'folder' })),
    { id: '__new', label: 'โฟลเดอร์ใหม่…', icon: 'folderPlus' },
  ];
  let target = await sheet('ย้ายไปที่', items);
  if (!target) return;
  if (target === '__new') {
    const f = await createFolder();
    if (!f) return;
    target = f.id;
  }
  const folderId = target === '__root' ? null : target;
  await db.put('docs', { ...doc, folderId });
  toast('ย้ายแล้ว');
}

async function deleteDoc(doc) {
  await db.put('docs', { ...doc, deletedAt: Date.now() });
  toast(`ย้าย “${doc.name}” ไปถังขยะแล้ว`, {
    ms: 5000,
    action: { label: 'เลิกทำ', onClick: async () => { await db.put('docs', { ...doc, deletedAt: null }); route(); } },
  });
}

/* ---------- หน้าเอกสาร (หลายหน้า) ---------- */
// โหมดเลือกหน้า: { docId, ids: Set } หรือ null
let selection = null;
const LONG_PRESS_MS = 550;

async function renderDoc(docId) {
  const doc = await db.get('docs', docId);
  if (!doc || doc.deletedAt) return go('#/');
  const pages = await db.pagesOf(doc);
  const back = doc.folderId ? `#/folder/${doc.folderId}` : '#/';
  if (selection && selection.docId !== docId) selection = null;
  const sel = selection;
  if (sel) [...sel.ids].forEach((id) => { if (!doc.pageIds.includes(id)) sel.ids.delete(id); });
  const n = sel?.ids.size || 0;

  const header = sel
    ? `<button class="icon-btn" data-act="sel-cancel" aria-label="เลิกเลือก">${icon('close')}</button>
       <h1>เลือก ${n} หน้า</h1>
       <button class="btn btn-ghost" data-act="sel-all">${n === pages.length ? 'ไม่เลือกเลย' : 'เลือกทั้งหมด'}</button>`
    : `<button class="icon-btn" data-act="back" aria-label="กลับ">${icon('back')}</button>
       <h1><button class="title-btn" data-act="rename">${esc(doc.name)}</button></h1>
       <button class="icon-btn" data-act="menu" aria-label="เมนู">${icon('more')}</button>`;
  const hint = sel
    ? '<p class="hint">แตะหน้าเพื่อเลือกหรือเลิกเลือก</p>'
    : pages.length > 1 ? '<p class="hint">แตะค้างเพื่อเลือกหน้า · แตะค้างแล้วลากเพื่อเรียงลำดับ</p>' : '';
  const review = !sel && pages.some((p) => p.needsReview)
    ? `<p class="hint warn">${pages.filter((p) => p.needsReview).length} หน้าหาขอบกระดาษไม่เจอ · แตะหน้าที่มีป้าย “ตรวจขอบ” แล้วกด ขอบ/ฟิลเตอร์</p>` : '';
  const footer = sel
    ? `<footer class="bottombar sel-bar">
        <button class="bar-btn" data-act="sel-export" ${n ? '' : 'disabled'}>${icon('share')}<span>ส่งออก ${n} หน้า</span></button>
        <button class="bar-btn" data-act="sel-filter" ${n ? '' : 'disabled'}>${icon('sliders')}<span>ฟิลเตอร์</span></button>
        <button class="bar-btn danger" data-act="sel-delete" ${n ? '' : 'disabled'}>${icon('trash')}<span>ลบ ${n} หน้า</span></button>
      </footer>`
    : `<footer class="bottombar">
        <button class="bar-btn" data-act="gallery">${icon('image')}<span>รูปภาพ</span></button>
        <button class="shutter" data-act="camera" aria-label="ถ่ายเพิ่ม">${icon('camera')}</button>
        <button class="bar-btn" data-act="export" ${pages.length ? '' : 'disabled'}>${icon('share')}<span>ส่งออก</span></button>
      </footer>`;

  app.innerHTML = `
    <header class="topbar">${header}</header>
    <main class="scroll">
      ${review}
      ${hint}
      <div class="grid ${sel ? 'select-mode' : ''}" id="grid">
        ${pages.map((p, i) => {
          const on = sel?.ids.has(p.id);
          return `
          <button class="page-card ${on ? 'selected' : ''}" data-id="${p.id}" data-act="open-page" aria-label="หน้า ${i + 1}" ${sel ? `aria-pressed="${!!on}"` : ''}>
            <img src="${blobUrl(p.thumb)}" alt="" draggable="false">
            <span class="page-no">${i + 1}</span>
            ${p.needsReview ? '<span class="page-flag">ตรวจขอบ</span>' : ''}
            ${sel ? `<span class="page-check">${icon('check')}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
      ${!pages.length ? '<div class="empty"><div>เอกสารนี้ยังไม่มีหน้า</div><div class="muted">ถ่ายหรือเลือกรูปเพื่อเพิ่มหน้า</div></div>' : ''}
    </main>
    ${footer}`;

  const grid = $('#grid');
  let suppressClick = false;

  if (!sel) {
    // แตะค้างโดยไม่ขยับนิ้ว = เข้าโหมดเลือก (ถ้าขยับระหว่างค้าง = ลากเรียงหน้า)
    let pressTimer;
    let startXY = null;
    if (pages.length > 1) {
      sortable = new Sortable(grid, {
        animation: 160,
        delay: 220,
        delayOnTouchOnly: true,
        forceFallback: true, // ใช้ระบบลากของ Sortable เองทั้งนิ้วและเมาส์ ให้พฤติกรรมเหมือนกันทุกเครื่อง
        fallbackTolerance: 4,
        ghostClass: 'drag-ghost',
        chosenClass: 'drag-chosen',
        onStart: () => clearTimeout(pressTimer),
        onEnd: async (e) => {
          if (e.oldIndex === e.newIndex) return;
          const ids = [...grid.children].map((el) => el.dataset.id);
          grid.querySelectorAll('.page-no').forEach((el, i) => { el.textContent = i + 1; });
          const fresh = await db.get('docs', docId);
          fresh.pageIds = ids;
          await refreshDoc(fresh);
        },
      });
    }
    grid.addEventListener('pointerdown', (e) => {
      const card = e.target.closest('.page-card');
      if (!card || e.button !== 0) return;
      startXY = [e.clientX, e.clientY];
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        suppressClick = true;
        selection = { docId, ids: new Set([card.dataset.id]) };
        route();
      }, LONG_PRESS_MS);
    });
    grid.addEventListener('pointermove', (e) => {
      if (startXY && Math.hypot(e.clientX - startXY[0], e.clientY - startXY[1]) > 8) clearTimeout(pressTimer);
    });
    const cancelPress = () => { clearTimeout(pressTimer); startXY = null; };
    grid.addEventListener('pointerup', cancelPress);
    grid.addEventListener('pointercancel', cancelPress);
  }

  app.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (suppressClick) {
      suppressClick = false;
      if (act === 'open-page') return;
    }
    if (act === 'back') go(back);
    else if (act === 'rename') { await renameDoc(doc); route(); }
    else if (act === 'menu') docMenu(doc, true);
    else if (act === 'camera') openCamera(docId);
    else if (act === 'gallery') openGallery(docId);
    else if (act === 'export') openExport(doc);
    else if (act === 'open-page') {
      if (sel) {
        const id = t.dataset.id;
        if (sel.ids.has(id)) sel.ids.delete(id);
        else sel.ids.add(id);
        route();
      } else {
        go(`#/doc/${docId}/page/${[...grid.children].indexOf(t)}`);
      }
    } else if (act === 'sel-cancel') {
      selection = null;
      route();
    } else if (act === 'sel-all') {
      selection.ids = n === pages.length ? new Set() : new Set(doc.pageIds);
      route();
    } else if (act === 'sel-filter') {
      const filter = await sheet(`ฟิลเตอร์สำหรับ ${n} หน้าที่เลือก`, FILTERS.map((x) => ({ id: x.id, label: x.label, icon: 'sliders' })));
      if (!filter) return;
      await refilterPages(doc, [...sel.ids], filter);
      selection = null;
      route();
    } else if (act === 'sel-export') {
      openExport(doc, [...sel.ids]);
    } else if (act === 'sel-delete') {
      const ok = await confirmBox(`ลบ ${n} หน้าที่เลือก?`, 'ลบแล้วกู้คืนไม่ได้', { ok: `ลบ ${n} หน้า`, danger: true });
      if (!ok) return;
      for (const id of sel.ids) await db.del('pages', id);
      doc.pageIds = doc.pageIds.filter((id) => !sel.ids.has(id));
      await refreshDoc(doc);
      selection = null;
      toast(`ลบ ${n} หน้าแล้ว`);
      route();
    }
  };
}

/* ---------- หน้าเดี่ยว ---------- */
async function renderPage(docId, index) {
  const doc = await db.get('docs', docId);
  if (!doc || doc.deletedAt) return go('#/');
  if (!doc.pageIds.length) return go(`#/doc/${docId}`);
  const i = Math.min(index, doc.pageIds.length - 1);
  const page = await db.get('pages', doc.pageIds[i]);
  const n = doc.pageIds.length;

  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" data-act="back" aria-label="กลับ">${icon('back')}</button>
      <h1>หน้า ${i + 1} / ${n}</h1>
      <span class="icon-btn-spacer"></span>
    </header>
    <main class="viewer" id="viewer">
      <img src="${blobUrl(page.processed)}" alt="หน้า ${i + 1}">
      ${i > 0 ? `<button class="nav-btn prev" data-act="prev" aria-label="หน้าก่อน">${icon('back')}</button>` : ''}
      ${i < n - 1 ? `<button class="nav-btn next" data-act="next" aria-label="หน้าถัดไป">${icon('next')}</button>` : ''}
    </main>
    <footer class="toolbar">
      <button class="tool" data-act="edit">${icon('crop')}<span>ขอบ/ฟิลเตอร์</span></button>
      <button class="tool" data-act="rotate">${icon('rotR')}<span>หมุน</span></button>
      <button class="tool" data-act="share">${icon('share')}<span>แชร์หน้านี้</span></button>
      <button class="tool danger" data-act="delete">${icon('trash')}<span>ลบหน้า</span></button>
    </footer>`;

  // ปัดซ้าย/ขวาเพื่อเปลี่ยนหน้า
  const viewer = $('#viewer');
  let sx = null;
  viewer.addEventListener('pointerdown', (e) => { sx = e.clientX; });
  viewer.addEventListener('pointerup', (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx;
    sx = null;
    if (dx < -60 && i < n - 1) location.replace(`#/doc/${docId}/page/${i + 1}`);
    else if (dx > 60 && i > 0) location.replace(`#/doc/${docId}/page/${i - 1}`);
  });

  app.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'back') go(`#/doc/${docId}`);
    else if (act === 'prev') location.replace(`#/doc/${docId}/page/${i - 1}`);
    else if (act === 'next') location.replace(`#/doc/${docId}/page/${i + 1}`);
    else if (act === 'edit') await pageAction(() => reEditPage(doc, page));
    else if (act === 'rotate') {
      await pageAction(async () => {
        const prog = progress('กำลังหมุน…');
        try {
          const c = await loadCanvas(page.original);
          await buildPage(docId, c, { ...pageLook(page), rotation: ((page.rotation || 0) + 90) % 360 }, page);
          freeCanvas(c);
          await refreshDoc(doc);
        } finally {
          prog.close();
        }
      });
    } else if (act === 'share') {
      const files = await buildJpgs([page], { name: `${doc.name}_หน้า${i + 1}`, quality: 'full' });
      if (canShareFiles(files)) await shareFiles(files, doc.name).catch((err) => toast('แชร์ไม่สำเร็จ: ' + err.message));
      else downloadFiles(files);
    } else if (act === 'delete') {
      const ok = await confirmBox(`ลบหน้า ${i + 1}?`, 'ลบแล้วกู้คืนไม่ได้', { ok: 'ลบหน้า', danger: true });
      if (!ok) return;
      doc.pageIds.splice(i, 1);
      await db.del('pages', page.id);
      await refreshDoc(doc);
      toast('ลบหน้าแล้ว');
      if (!doc.pageIds.length) go(`#/doc/${docId}`);
      else location.replace(`#/doc/${docId}/page/${Math.min(i, doc.pageIds.length - 1)}`);
    }
  };
}

/** ค่าการจัดหน้าเดิมของหน้า (ใช้คำนวณใหม่จากภาพต้นฉบับ) */
const pageLook = (page) => ({
  corners: page.corners, mids: page.mids, filter: page.filter, contrast: page.contrast ?? 0.5,
  rotation: page.rotation || 0, straighten: page.straighten ?? false, needsReview: page.needsReview,
});

// กันกดซ้ำระหว่างทำงาน + แจ้ง error ให้เห็น + วาดหน้าใหม่ทุกครั้ง (ไม่ค้างหน้าเดิม)
let pageBusy = false;
async function pageAction(fn) {
  if (pageBusy) return toast('กำลังทำงาน รอสักครู่…');
  pageBusy = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast('ทำรายการไม่สำเร็จ: ' + (err?.message || err), { ms: 5000 });
  } finally {
    pageBusy = false;
    route();
  }
}

/** เปลี่ยนฟิลเตอร์หลายหน้าพร้อมกัน (คำนวณใหม่จากภาพต้นฉบับ ขอบ/การหมุนเดิม) */
async function refilterPages(doc, ids, filter) {
  const prog = progress('กำลังปรับฟิลเตอร์…');
  try {
    for (let i = 0; i < ids.length; i++) {
      prog.update(`กำลังปรับฟิลเตอร์ ${i + 1}/${ids.length}`);
      const page = await db.get('pages', ids[i]);
      if (!page) continue;
      const c = await loadCanvas(page.original);
      await buildPage(doc.id, c, { ...pageLook(page), filter }, page);
      freeCanvas(c);
    }
    await refreshDoc(await db.get('docs', doc.id));
    toast(`ปรับฟิลเตอร์ ${ids.length} หน้าแล้ว`);
  } finally {
    prog.close();
  }
}

async function reEditPage(doc, page) {
  const loading = progress('กำลังเปิดภาพ…');
  let canvas;
  try {
    canvas = await loadCanvas(page.original);
  } finally {
    loading.close();
  }
  try {
    const res = await openEditor({ canvas, ...pageLook(page) });
    if (!res) return;
    const prog = progress('กำลังบันทึก…');
    try {
      await buildPage(doc.id, canvas, res, page);
      await refreshDoc(doc);
    } finally {
      prog.close();
    }
  } finally {
    freeCanvas(canvas);
  }
}

/* ---------- ถังขยะ ---------- */
async function renderTrash() {
  const docs = (await db.getAll('docs')).filter((d) => d.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" data-act="back" aria-label="กลับ">${icon('back')}</button>
      <h1>ถังขยะ <span class="count">(${docs.length})</span></h1>
      <button class="btn btn-ghost danger" data-act="empty" ${docs.length ? '' : 'disabled'}>ล้างทั้งหมด</button>
    </header>
    <main class="scroll list">
      <p class="hint">เอกสารในถังขยะจะถูกลบถาวรอัตโนมัติเมื่อครบ ${TRASH_DAYS} วัน</p>
      ${docs.map((d) => `
        <div class="row" data-id="${d.id}">
          <span class="row-main">
            <span class="row-thumb">${d.thumb ? `<img src="${blobUrl(d.thumb)}" alt="">` : icon('file')}</span>
            <span class="row-text">
              <span class="row-title">${esc(d.name)}</span>
              <span class="row-sub">${d.pageIds.length} หน้า · ลบเมื่อ ${fmtDate(d.deletedAt)}</span>
            </span>
          </span>
          <button class="icon-btn" data-act="restore" aria-label="กู้คืน">${icon('restore')}</button>
          <button class="icon-btn danger" data-act="purge" aria-label="ลบถาวร">${icon('trash')}</button>
        </div>`).join('')}
      ${!docs.length ? '<div class="empty">ถังขยะว่าง</div>' : ''}
    </main>`;

  app.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    const doc = docs.find((d) => d.id === t.closest('[data-id]')?.dataset.id);
    if (act === 'back') return go('#/');
    if (act === 'restore') {
      const folderExists = doc.folderId && (await db.get('folders', doc.folderId));
      await db.put('docs', { ...doc, deletedAt: null, folderId: folderExists ? doc.folderId : null });
      toast('กู้คืนแล้ว');
    } else if (act === 'purge') {
      if (!(await confirmBox(`ลบ “${doc.name}” ถาวร?`, 'ลบแล้วกู้คืนไม่ได้', { ok: 'ลบถาวร', danger: true }))) return;
      await db.purgeDoc(doc);
    } else if (act === 'empty') {
      if (!(await confirmBox(`ลบเอกสารทั้ง ${docs.length} รายการถาวร?`, 'ลบแล้วกู้คืนไม่ได้', { ok: 'ล้างถังขยะ', danger: true }))) return;
      for (const d of docs) await db.purgeDoc(d);
    }
    route();
  };
}

async function purgeOldTrash() {
  const limit = Date.now() - TRASH_DAYS * 864e5;
  for (const d of await db.getAll('docs')) {
    if (d.deletedAt && d.deletedAt < limit) await db.purgeDoc(d);
  }
}

/* ---------- ส่งออก ---------- */
function seg(name, options, value) {
  return `<div class="seg" role="radiogroup" data-name="${name}">
    ${options.map(([v, label]) => `<button type="button" role="radio" aria-checked="${v === value}" data-v="${v}">${esc(label)}</button>`).join('')}
  </div>`;
}

/** ส่งออกทั้งเอกสาร หรือเฉพาะหน้าที่เลือก (onlyIds) ตามลำดับในเอกสาร */
async function openExport(doc, onlyIds) {
  let pages = await db.pagesOf(doc);
  const partial = Array.isArray(onlyIds) && onlyIds.length < pages.length;
  if (onlyIds) pages = pages.filter((p) => onlyIds.includes(p.id));
  if (!pages.length) return toast('เอกสารนี้ยังไม่มีหน้า');
  const name = partial ? `${doc.name} (${pages.length} หน้า)` : doc.name;
  const opts = { format: settings.format, quality: settings.quality, pageSize: settings.pageSize, name };
  let files = null;

  const html = `
    <h2>ส่งออก “${esc(doc.name)}”${partial ? ` · ${pages.length} หน้าที่เลือก` : ''}</h2>
    <div class="field"><span class="label">รูปแบบ</span>${seg('format', [['pdf', 'PDF'], ['jpg', 'JPG']], opts.format)}</div>
    <label class="field"><span class="label">ชื่อไฟล์</span><input class="input" name="name" value="${esc(opts.name)}" autocomplete="off"></label>
    <div class="field"><span class="label">ขนาดไฟล์</span>${seg('quality', Object.entries(QUALITIES).map(([k, q]) => [k, q.label]), opts.quality)}</div>
    <div class="field pdf-only"><span class="label">ขนาดหน้า</span>${seg('pageSize', [['a4', 'A4'], ['fit', 'ตามภาพ']], opts.pageSize)}</div>
    <div class="export-result muted" aria-live="polite">${pages.length} หน้า</div>
    <div class="dlg-actions">
      <button type="button" class="btn" data-act="close">ปิด</button>
      <button type="button" class="btn" data-act="download" hidden>${icon('download')}ดาวน์โหลด</button>
      <button type="button" class="btn btn-primary" data-act="make">สร้างไฟล์</button>
    </div>`;

  await modal(html, {
    cls: 'box export', label: 'ส่งออก',
    setup(dlg, finish) {
      const result = dlg.querySelector('.export-result');
      const makeBtn = dlg.querySelector('[data-act="make"]');
      const dlBtn = dlg.querySelector('[data-act="download"]');
      const sync = () => {
        dlg.querySelector('.pdf-only').hidden = opts.format !== 'pdf';
        dlg.querySelectorAll('.seg').forEach((s) => s.querySelectorAll('[data-v]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === opts[s.dataset.name]))));
      };
      const invalidate = () => {
        files = null;
        makeBtn.innerHTML = 'สร้างไฟล์';
        dlBtn.hidden = true;
        result.textContent = `${pages.length} หน้า`;
      };
      sync();
      dlg.querySelector('[name="name"]').addEventListener('input', (e) => { opts.name = e.target.value; invalidate(); });
      dlg.addEventListener('click', async (e) => {
        const sb = e.target.closest('.seg [data-v]');
        if (sb) {
          opts[sb.closest('.seg').dataset.name] = sb.dataset.v;
          sync();
          invalidate();
          return;
        }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') finish(null);
        else if (act === 'download' && files) downloadFiles(files);
        else if (act === 'make') {
          if (files) {
            // ไฟล์พร้อมแล้ว: เปิดเมนูแชร์ทันทีในจังหวะแตะ (iOS ต้องการแบบนี้)
            if (canShareFiles(files)) shareFiles(files, opts.name).catch((err) => toast('แชร์ไม่สำเร็จ: ' + err.message));
            else downloadFiles(files);
            return;
          }
          await withBusy(makeBtn, async () => {
            try {
              const build = opts.format === 'pdf' ? buildPdf : buildJpgs;
              files = await build(pages, opts, (k, n) => { result.textContent = `กำลังสร้าง… ${k}/${n}`; });
              const total = files.reduce((s, f) => s + f.size, 0);
              result.textContent = `${files.length > 1 ? `${files.length} ไฟล์` : files[0].name} · ${fmtSize(total)}`;
              makeBtn.innerHTML = `${icon('share')}แชร์ / บันทึก`;
              dlBtn.hidden = canShareFiles(files) ? !matchMedia('(pointer: fine)').matches : false;
              Object.assign(settings, { format: opts.format, quality: opts.quality, pageSize: opts.pageSize });
              db.setMeta('settings', settings);
            } catch (err) {
              console.error(err);
              result.textContent = 'สร้างไฟล์ไม่สำเร็จ: ' + err.message;
              files = null;
            }
          });
        }
      });
    },
  });
}

/* ---------- ตั้งค่า ---------- */
async function openSettings() {
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) usage = `ใช้พื้นที่ ${fmtSize(est.usage || 0)}`;
    const persisted = await navigator.storage?.persisted?.();
    if (persisted !== undefined) usage += persisted ? ' · เก็บถาวร ✓' : ' · ยังไม่ได้รับสิทธิ์เก็บถาวร';
  } catch { /* ไม่รองรับ */ }

  const html = `
    <h2>ตั้งค่า</h2>
    <div class="field"><span class="label">กล้อง</span>${seg('camera', [['app', 'กล้องในแอป (มีไฟฉาย)'], ['system', 'กล้องของระบบ']], settings.camera)}</div>
    <div class="field"><span class="label">ฟิลเตอร์เริ่มต้น</span>${seg('filter', FILTERS.map((f) => [f.id, f.label]), settings.filter)}</div>
    <div class="field"><span class="label">ขนาดหน้า PDF</span>${seg('pageSize', [['a4', 'A4'], ['fit', 'ตามภาพ']], settings.pageSize)}</div>
    <div class="field"><span class="label">ขนาดไฟล์ส่งออก</span>${seg('quality', Object.entries(QUALITIES).map(([k, q]) => [k, q.label]), settings.quality)}</div>
    <p class="muted small">${esc(usage)}</p>
    <p class="muted small">${APP_NAME} เวอร์ชัน ${VERSION} · ข้อมูลทั้งหมดเก็บในเครื่องนี้เท่านั้น</p>
    <div class="dlg-actions"><button type="button" class="btn btn-primary" data-act="close">เสร็จ</button></div>`;
  await modal(html, {
    cls: 'box', label: 'ตั้งค่า',
    setup(dlg, finish) {
      dlg.addEventListener('click', (e) => {
        const sb = e.target.closest('.seg [data-v]');
        if (sb) {
          const s = sb.closest('.seg');
          settings[s.dataset.name] = sb.dataset.v;
          s.querySelectorAll('[data-v]').forEach((b) => b.setAttribute('aria-checked', String(b === sb)));
          db.setMeta('settings', settings);
        } else if (e.target.closest('[data-act="close"]')) finish(null);
      });
    },
  });
}

/* ---------- เริ่มแอป + ใช้ออฟไลน์ (service worker) ---------- */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offerUpdate = (w) => toast('มีเวอร์ชันใหม่', { ms: 0, action: { label: 'อัปเดต', onClick: () => w.postMessage('skipWaiting') } });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
  }).catch((err) => console.warn('SW', err));
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast('เกิดข้อผิดพลาด: ' + (e.reason?.message || e.reason), { ms: 5000 });
});

async function init() {
  settings = { ...DEFAULT_SETTINGS, ...(await db.getMeta('settings', {})) };
  await route();
  purgeOldTrash().catch(() => {});
  registerServiceWorker();
  // โหลด OpenCV ไว้ล่วงหน้าตอนว่าง เพื่อให้ถ่ายรูปแรกได้เร็ว
  setTimeout(() => warmup().catch(() => {}), 2500);
}

init();
