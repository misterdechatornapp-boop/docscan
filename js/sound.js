// เสียงชัตเตอร์สังเคราะห์ (ไม่ต้องมีไฟล์เสียง) · iPhone ที่เปิดโหมดเงียบจะไม่มีเสียง
let ctx;

export function shutterSound() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    // คลิกสองจังหวะ: ม่านชัตเตอร์เปิด-ปิด
    for (const [at, dur, gain, freq] of [[0, 0.03, 0.55, 3200], [0.065, 0.045, 0.4, 2200]]) {
      const len = Math.ceil(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = freq;
      band.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(band).connect(g).connect(ctx.destination);
      src.start(t + at);
    }
  } catch { /* เบราว์เซอร์ไม่รองรับเสียง: ข้าม */ }
}
