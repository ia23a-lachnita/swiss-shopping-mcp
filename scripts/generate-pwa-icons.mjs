// Generate the PWA icon PNGs (pwa/public/pwa-192.png, pwa-512.png) without
// image dependencies: a minimal PNG encoder over a raw RGBA buffer drawing a
// rounded emerald square with a simple white shopping-basket glyph.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pwa', 'public');

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const bg = [5, 150, 105]; // emerald-600
  const fg = [255, 255, 255];

  const insideRoundedRect = (x, y) => {
    const rx = Math.max(radius - x, x - (size - 1 - radius), 0);
    const ry = Math.max(radius - y, y - (size - 1 - radius), 0);
    return rx * rx + ry * ry <= radius * radius;
  };

  // Basket glyph in normalized coordinates.
  const insideGlyph = (x, y) => {
    const u = x / size;
    const v = y / size;
    // Basket body: trapezoid
    if (v >= 0.45 && v <= 0.78) {
      const t = (v - 0.45) / 0.33;
      const halfWidth = 0.27 - 0.05 * t;
      if (Math.abs(u - 0.5) <= halfWidth) {
        // Cut two vertical slots for texture
        const slot = Math.abs(u - 0.5);
        if ((slot > 0.075 && slot < 0.115) || slot < 0.02) {
          return v > 0.5 && v < 0.73 ? false : true;
        }
        return true;
      }
      return false;
    }
    // Handle: ring segment above the body
    const dx = u - 0.5;
    const dy = v - 0.47;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return v < 0.45 && dist >= 0.17 && dist <= 0.23;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      if (!insideRoundedRect(x, y)) continue;
      const [r, g, b] = insideGlyph(x, y) ? fg : bg;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = join(OUT_DIR, `pwa-${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log('wrote', file);
}
