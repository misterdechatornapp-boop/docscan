// คัดลอกไลบรารีจาก node_modules ไปไว้ที่ vendor/ เพื่อให้แอปทำงานออฟไลน์ได้:  npm run vendor
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  ['node_modules/@techstark/opencv-js/dist/opencv.js', 'vendor/opencv.js'],
  ['node_modules/pdf-lib/dist/pdf-lib.esm.min.js', 'vendor/pdf-lib.esm.min.js'],
  ['node_modules/sortablejs/modular/sortable.esm.js', 'vendor/sortable.esm.js'],
];

fs.mkdirSync(path.join(ROOT, 'vendor'), { recursive: true });
for (const [from, to] of FILES) {
  fs.copyFileSync(path.join(ROOT, from), path.join(ROOT, to));
  console.log('✓', to);
}
