import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { decodePng, encodePng, diff, type Rgba } from "../../src/main/visual";

function solid(w: number, h: number, rgba: [number, number, number, number]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

test("png round trip", () => {
  const img = solid(4, 3, [10, 20, 30, 255]);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 4);
  assert.equal(back.height, 3);
  assert.deepEqual(Array.from(back.data.slice(0, 4)), [10, 20, 30, 255]);
});

test("diff percent", () => {
  const a = solid(10, 10, [0, 0, 0, 255]);
  const b = solid(10, 10, [0, 0, 0, 255]);
  for (let i = 0; i < 25; i++) b.data.set([255, 255, 255, 255], i * 4);
  const r = diff(a, b);
  assert.equal(r.changedPct, 25);
  assert.equal(diff(a, a).changedPct, 0);
});

test("png round trip keeps every pixel of a gradient", () => {
  const w = 7;
  const h = 5;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255 - (i % 256)], i * 4);
  }
  const img: Rgba = { width: w, height: h, data };
  const back = decodePng(encodePng(img));
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual(Array.from(back.data), Array.from(data));
});

// --- Hand-built PNGs, so the decoder's unfilter path is exercised for every filter type ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** An independent CRC32 so the fixtures do not lean on the implementation under test. */
function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Builds a PNG straight from already-filtered scanlines: `[filterByte, ...bytes]` per row. */
function png(width: number, height: number, colorType: number, rows: number[][]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // non-interlaced
  const raw = Buffer.from(rows.flat());
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BASE = [10, 20, 30, 40, 50, 60, 70, 80];

test("decodePng unfilters None (0)", () => {
  const img = decodePng(png(2, 2, 6, [[0, ...BASE], [0, 1, 2, 3, 4, 5, 6, 7, 8]]));
  assert.deepEqual(Array.from(img.data), [...BASE, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("decodePng unfilters Sub (1)", () => {
  const img = decodePng(png(2, 2, 6, [[0, ...BASE], [1, 10, 20, 30, 40, 5, 5, 5, 5]]));
  assert.deepEqual(Array.from(img.data), [...BASE, 10, 20, 30, 40, 15, 25, 35, 45]);
});

test("decodePng unfilters Up (2)", () => {
  const img = decodePng(png(2, 2, 6, [[0, ...BASE], [2, 1, 1, 1, 1, 2, 2, 2, 2]]));
  assert.deepEqual(Array.from(img.data), [...BASE, 11, 21, 31, 41, 52, 62, 72, 82]);
});

test("decodePng unfilters Average (3)", () => {
  const img = decodePng(png(2, 2, 6, [[0, ...BASE], [3, 0, 0, 0, 0, 0, 0, 0, 0]]));
  assert.deepEqual(Array.from(img.data), [...BASE, 5, 10, 15, 20, 27, 35, 42, 50]);
});

test("decodePng unfilters Paeth (4)", () => {
  const img = decodePng(png(2, 2, 6, [[0, ...BASE], [4, 1, 2, 3, 4, 5, 6, 7, 8]]));
  assert.deepEqual(Array.from(img.data), [...BASE, 11, 22, 33, 44, 55, 66, 77, 88]);
});

test("decodePng expands color type 2 (RGB) to RGBA", () => {
  const img = decodePng(png(2, 1, 2, [[0, 1, 2, 3, 4, 5, 6]]));
  assert.equal(img.width, 2);
  assert.equal(img.height, 1);
  assert.deepEqual(Array.from(img.data), [1, 2, 3, 255, 4, 5, 6, 255]);
});

test("decodePng rejects unsupported PNGs", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /PNG/i);
  // Palette (color type 3) is not supported.
  assert.throws(() => decodePng(png(1, 1, 3, [[0, 0]])), /color type/i);
});

test("diff tolerance ignores small channel deltas", () => {
  const a = solid(2, 2, [100, 100, 100, 255]);
  const b = solid(2, 2, [100, 100, 100, 255]);
  b.data.set([110, 100, 100, 255], 0); // delta 10, inside the default tolerance of 16
  b.data.set([140, 100, 100, 255], 4); // delta 40, outside it
  const r = diff(a, b, 16);
  assert.equal(r.changedPct, 25);
  assert.equal(diff(a, b, 64).changedPct, 0);
});

test("diff marks changed pixels red and dims the rest", () => {
  const a = solid(2, 1, [0, 0, 0, 255]);
  const b = solid(2, 1, [0, 0, 0, 255]);
  b.data.set([255, 255, 255, 255], 0);
  const r = diff(a, b);
  assert.equal(r.diffImage.width, 2);
  assert.equal(r.diffImage.height, 1);
  assert.deepEqual(Array.from(r.diffImage.data.slice(0, 4)), [255, 0, 0, 255]);
  const unchanged = Array.from(r.diffImage.data.slice(4, 8));
  assert.equal(unchanged[3], 255);
  assert.equal(unchanged[0], unchanged[1]);
  assert.equal(unchanged[1], unchanged[2]);
});

test("diff rejects a size mismatch", () => {
  assert.throws(() => diff(solid(2, 2, [0, 0, 0, 255]), solid(3, 2, [0, 0, 0, 255])), /size/i);
});
