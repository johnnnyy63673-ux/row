// scripts/gen-icons.js
// Generates icon-192.png and icon-512.png for the PWA manifest.
// Run with: node scripts/gen-icons.js
// Zero npm dependencies — uses only built-in Node.js modules.

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC-32 (required by PNG format) ───────────────────────────────────────
const CRC_TABLE = (() => {
  const t = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const lenBuf  = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type);
  const crcVal  = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcVal]);
}

// ── PNG builder ────────────────────────────────────────────────────────────
function makePNG(w, h, drawFn) {
  // Each row: 1 filter byte (0 = None) + w×3 RGB bytes
  const raw = Buffer.alloc(h * (1 + w * 3), 0);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0;

  function setPixel(x, y, r, g, b) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = y * (1 + w * 3) + 1 + x * 3;
    raw[i] = r; raw[i+1] = g; raw[i+2] = b;
  }
  function fillRect(x, y, rw, rh, r, g, b) {
    for (let dy = 0; dy < rh; dy++)
      for (let dx = 0; dx < rw; dx++)
        setPixel(x + dx, y + dy, r, g, b);
  }
  function fillCircle(cx, cy, radius, r, g, b) {
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++)
        if (dx*dx + dy*dy <= radius*radius) setPixel(cx+dx, cy+dy, r, g, b);
  }

  drawFn({ w, h, setPixel, fillRect, fillCircle });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  const sig      = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdrChunk = chunk('IHDR', ihdr);
  const idatChunk = chunk('IDAT', zlib.deflateSync(raw));
  const iendChunk = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

// ── Icon design ────────────────────────────────────────────────────────────
// Dark background (#0A0A0B) with an orange accent ring and white "J"
// The design keeps all content within the inner 80% so it's safe for
// Android adaptive icons (maskable purpose).

//  "J" glyph defined on a 5-wide × 8-tall grid (1=white, 0=transparent)
const J_GLYPH = [
  [0,1,1,1,1],
  [0,0,0,1,0],
  [0,0,0,1,0],
  [0,0,0,1,0],
  [0,0,0,1,0],
  [1,0,0,1,0],
  [1,0,1,1,0],
  [0,1,0,0,0],
];

function drawIcon({ w, h, fillRect, fillCircle }) {
  const BG  = [10, 10, 11];         // #0A0A0B
  const ACC = [224, 118, 88];       // #E07658 — warm orange, matches index.html glow
  const FG  = [250, 250, 250];      // #FAFAFA

  // 1. Fill background
  fillRect(0, 0, w, h, ...BG);

  // 2. Subtle warm glow in top-right (matches the dashboard's radial gradient)
  const glowR = Math.round(w * 0.38);
  for (let r = glowR; r > 0; r--) {
    const alpha = (1 - r / glowR) * 0.22;
    const pr = Math.round(BG[0] + (ACC[0] - BG[0]) * alpha);
    const pg = Math.round(BG[1] + (ACC[1] - BG[1]) * alpha);
    const pb = Math.round(BG[2] + (ACC[2] - BG[2]) * alpha);
    fillCircle(Math.round(w * 0.72), Math.round(h * 0.28), r, pr, pg, pb);
  }

  // 3. Accent ring — thin circle outline
  const ringR  = Math.round(w * 0.34);
  const ringCx = Math.round(w / 2);
  const ringCy = Math.round(h / 2);
  const ringThick = Math.max(2, Math.round(w * 0.025));
  for (let dy = -ringR - ringThick; dy <= ringR + ringThick; dy++) {
    for (let dx = -ringR - ringThick; dx <= ringR + ringThick; dx++) {
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist >= ringR - ringThick && dist <= ringR + ringThick) {
        // Fade alpha based on distance from ring edge
        const t = 1 - Math.abs(dist - ringR) / ringThick;
        const pr = Math.round(BG[0] + (ACC[0] - BG[0]) * t * 0.7);
        const pg = Math.round(BG[1] + (ACC[1] - BG[1]) * t * 0.7);
        const pb = Math.round(BG[2] + (ACC[2] - BG[2]) * t * 0.7);
        const x = ringCx + dx, y = ringCy + dy;
        if (x >= 0 && x < w && y >= 0 && y < h) fillRect(x, y, 1, 1, pr, pg, pb);
      }
    }
  }

  // 4. "J" letter — pixel grid scaled to fit inside the ring
  const scale    = Math.max(1, Math.floor(w * 0.46 / 8));
  const glyphW   = 5 * scale;
  const glyphH   = 8 * scale;
  const startX   = Math.round((w - glyphW) / 2);
  const startY   = Math.round((h - glyphH) / 2);

  for (let row = 0; row < J_GLYPH.length; row++) {
    for (let col = 0; col < J_GLYPH[row].length; col++) {
      if (!J_GLYPH[row][col]) continue;
      fillRect(startX + col * scale, startY + row * scale, scale, scale, ...FG);
    }
  }
}

// ── Write files ────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const buf  = makePNG(size, size, drawIcon);
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, buf);
  console.log(`✓ icons/icon-${size}.png  (${buf.length} bytes)`);
}

// apple-touch-icon is conventionally 180×180 but 192 is fine; symlink/copy
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), makePNG(192, 192, drawIcon));
console.log('✓ icons/apple-touch-icon.png');
