"use strict";

/**
 * Ensures build/icon.png exists so electron-builder can make .ico / .icns.
 * Skips when a real icon is already there unless --force is passed.
 * Works on Mac/Linux CI (the PowerShell generator is Windows-only).
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 1024;
const destDir = path.join(__dirname, "..", "build");
const dest = path.join(destDir, "icon.png");
const force = process.argv.includes("--force");

if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
  process.stdout.write(`Using existing ${dest}\n`);
  process.exit(0);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcSrc = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcSrc), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function insideRoundedRect(x, y, pad, radius) {
  const left = pad;
  const top = pad;
  const right = SIZE - pad;
  const bottom = SIZE - pad;
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const cx = x < left + radius ? left + radius : x >= right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y >= bottom - radius ? bottom - radius : y;
  if (cx === x || cy === y) return true;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function inDisk(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inStrokeArc(x, y, cx, cy, r, thickness, startDeg, sweepDeg) {
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);
  if (Math.abs(dist - r) > thickness) return false;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const end = startDeg + sweepDeg;
  while (deg < startDeg) deg += 360;
  while (deg > end + 360) deg -= 360;
  return deg >= startDeg && deg <= end;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
const blue = [26, 115, 232, 255];
const white = [255, 255, 255, 255];
const cx = 390;
const cy = 512;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    let color = null;
    if (
      inDisk(x, y, cx, cy, 70) ||
      inStrokeArc(x, y, cx, cy, 180, 28, -55, 110) ||
      inStrokeArc(x, y, cx, cy, 310, 28, -55, 110) ||
      inStrokeArc(x, y, cx, cy, 440, 28, -55, 110)
    ) {
      color = white;
    } else if (insideRoundedRect(x, y, 48, 220)) {
      color = blue;
    }
    if (color) {
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = color[3];
    }
  }
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(destDir, { recursive: true });
fs.writeFileSync(dest, png);
process.stdout.write(`Wrote ${dest} (${png.length} bytes)\n`);
