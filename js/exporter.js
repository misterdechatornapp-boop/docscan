// สร้างไฟล์ PDF / JPG จากหน้าเอกสาร แล้วแชร์ผ่านเมนูแชร์ของ iOS (บันทึกลงไฟล์ อีเมล พิมพ์ LINE ฯลฯ)
import { PDFDocument } from '../vendor/pdf-lib.esm.min.js';
import { loadCanvas, toBlob, freeCanvas } from './imaging.js';

export const QUALITIES = {
  full: { label: 'ขนาดจริง', maxSide: Infinity, q: 0.85 },
  medium: { label: 'กลาง', maxSide: 2000, q: 0.72 },
  small: { label: 'เล็ก', maxSide: 1400, q: 0.6 },
};

const A4 = [595.28, 841.89];

async function pageJpeg(page, quality) {
  const qd = QUALITIES[quality] || QUALITIES.full;
  if (qd.maxSide === Infinity) return page.processed;
  const c = await loadCanvas(page.processed, qd.maxSide);
  const b = await toBlob(c, qd.q);
  freeCanvas(c);
  return b;
}

export async function buildPdf(pages, { name, quality, pageSize }, onProgress) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(name);
  pdf.setCreator('สแกนง่าย');
  pdf.setProducer('สแกนง่าย');
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i + 1, pages.length);
    const jpg = await pdf.embedJpg(await (await pageJpeg(pages[i], quality)).arrayBuffer());
    const landscape = jpg.width > jpg.height;
    let pw, ph;
    if (pageSize === 'a4') {
      [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    } else {
      // ตามสัดส่วนภาพ โดยให้ด้านสั้นกว้างเท่า A4
      const s = A4[0] / Math.min(jpg.width, jpg.height);
      [pw, ph] = [jpg.width * s, jpg.height * s];
    }
    const s = Math.min(pw / jpg.width, ph / jpg.height);
    const w = jpg.width * s;
    const h = jpg.height * s;
    pdf.addPage([pw, ph]).drawImage(jpg, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  const bytes = await pdf.save();
  return [new File([bytes], `${safeName(name)}.pdf`, { type: 'application/pdf' })];
}

export async function buildJpgs(pages, { name, quality }, onProgress) {
  const files = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i + 1, pages.length);
    const b = await pageJpeg(pages[i], quality);
    const suffix = pages.length > 1 ? `_${String(i + 1).padStart(2, '0')}` : '';
    files.push(new File([b], `${safeName(name)}${suffix}.jpg`, { type: 'image/jpeg' }));
  }
  return files;
}

export function safeName(name) {
  return (name || 'เอกสาร').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'เอกสาร';
}

export const canShareFiles = (files) => !!navigator.canShare?.({ files });

/** เปิดเมนูแชร์ (ต้องเรียกจากการแตะของผู้ใช้โดยตรง) คืน false ถ้าผู้ใช้ปิดเมนูเอง */
export async function shareFiles(files, title) {
  try {
    await navigator.share({ files, title });
    return true;
  } catch (err) {
    if (err.name === 'AbortError') return false;
    throw err;
  }
}

export function downloadFiles(files) {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
