// Muxes still WebP frames (lossy VP8, from canvas.toBlob) into one looping animated WebP.
// usage: node mux-webp.mjs <frames-dir> <fps> <out.webp>
import fs from 'node:fs';
import path from 'node:path';
const [dir, fps, out] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webp')).sort();
const u24 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
const chunk = (id, data) => {
  const head = Buffer.alloc(8); head.write(id, 0, 'ascii'); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
let W = 0, H = 0;
const frames = files.map((f) => {
  const b = fs.readFileSync(path.join(dir, f));
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') throw new Error(`${f}: not a WebP`);
  let p = 12; const keep = [];
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    const whole = b.subarray(p, p + 8 + size + (size % 2));
    if (id === 'VP8 ') { // frame size from the VP8 key frame header
      const d = b.subarray(p + 8);
      W = d.readUInt16LE(6) & 0x3fff; H = d.readUInt16LE(8) & 0x3fff; keep.push(whole);
    } else if (id === 'VP8L' || id === 'ALPH') keep.push(whole);
    p += 8 + size + (size % 2);
  }
  return Buffer.concat(keep);
});
const dur = Math.round(1000 / Number(fps));
const vp8x = Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24(W - 1), u24(H - 1)]); // animation flag
const anim = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0])]); // background, loop forever
const anmf = frames.map((f) => chunk('ANMF', Buffer.concat([u24(0), u24(0), u24(W - 1), u24(H - 1), u24(dur), Buffer.from([0x02]), f])));
const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', vp8x), chunk('ANIM', anim), ...anmf]);
const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4);
fs.writeFileSync(out, Buffer.concat([riff, body]));
console.log(`${frames.length} frames ${W}x${H} @${fps}fps -> ${out} (${(fs.statSync(out).size / 1048576).toFixed(2)} MB)`);
