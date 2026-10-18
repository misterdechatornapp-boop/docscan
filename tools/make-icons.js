// สร้างไอคอนแอป (PNG) โดยไม่ต้องใช้ไลบรารีภายนอก:  npm run icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [180, 192, 512];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// สีของจุด (u,v) ในพิกัด 0..1
function color(u, v) {
  const top = [20, 184, 166], bottom = [15, 118, 110];
  let c = top.map((t, i) => t + (bottom[i] - t) * v);
  // กระดาษ
  const L = 0.27, R = 0.73, T = 0.2, B = 0.8, fold = 0.13;
  const inPaper = u > L && u < R && v > T && v < B && !(u > R - fold && v < T + fold && (u - (R - fold)) > (v - T));
  if (inPaper) {
    c = [255, 255, 255];
    if (u > R - fold && v < T + fold) c = [204, 251, 241];
    for (const ly of [0.42, 0.51, 0.6, 0.69]) {
      const lr = ly === 0.69 ? 0.56 : 0.65;
      if (v > ly - 0.018 && v < ly + 0.018 && u > 0.35 && u < lr) c = [94, 234, 212];
    }
  }
  // กรอบสแกนที่มุม
  const s = 0.035, o1 = 0.14, o2 = 0.86, arm = 0.14;
  const nearX = (x) => Math.abs(u - x) < s / 2, nearY = (y) => Math.abs(v - y) < s / 2;
  for (const [cx, dx] of [[o1, 1], [o2, -1]]) {
    for (const [cy, dy] of [[o1, 1], [o2, -1]]) {
      const alongX = (u - cx) * dx > -s / 2 && (u - cx) * dx < arm;
      const alongY = (v - cy) * dy > -s / 2 && (v - cy) * dy < arm;
      if ((nearY(cy) && alongX) || (nearX(cx) && alongY)) c = [255, 255, 255];
    }
  }
  return c;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const S of SIZES) {
  const buf = Buffer.alloc(S * S * 3);
  const N = 4;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const c = color((x + (sx + 0.5) / N) / S, (y + (sy + 0.5) / N) / S);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const i = (y * S + x) * 3;
      buf[i] = acc[0] / (N * N); buf[i + 1] = acc[1] / (N * N); buf[i + 2] = acc[2] / (N * N);
    }
  }
  fs.writeFileSync(path.join(outDir, `icon-${S}.png`), png(S, S, buf));
  console.log('✓', `icons/icon-${S}.png`);
}
