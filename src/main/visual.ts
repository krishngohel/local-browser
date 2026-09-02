import zlib from "node:zlib";

/**
 * A minimal PNG codec and image differ, for visual regression checks.
 *
 * Echo ships no image library, so this reads and writes the narrow slice of PNG that
 * Chromium's screenshots actually use: 8-bit, non-interlaced, RGB or RGBA. Pure Node —
 * `node:zlib` only — so it unit-tests without Electron.
 */

/** An 8-bit RGBA bitmap, row-major, 4 bytes per pixel. */
export type Rgba = { width: number; height: number; data: Uint8Array };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** ~64 megapixels. A screenshot past this is a bug, and decoding it would eat 256 MB. */
const MAX_PIXELS = 64_000_000;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** The PNG Paeth predictor, byte-for-byte as the spec defines it. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes a PNG to RGBA. Supports color types 2 (RGB) and 6 (RGBA) at bit depth 8,
 * non-interlaced — everything else throws with a message worth showing a user.
 */
export function decodePng(buf: Buffer): Rgba {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error("Not a PNG file.");
  }
  let width = 0;
  let height = 0;
  let colorType = -1;
  let seenHeader = false;
  const idat: Buffer[] = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (at + 12 + length > buf.length) throw new Error("PNG is truncated.");
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      colorType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8 is read).`);
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`Unsupported PNG color type ${colorType} (only 2 and 6 are read).`);
      }
      if (interlace !== 0) throw new Error("Interlaced PNGs are not supported.");
      if (!width || !height) throw new Error("PNG has no pixels.");
      if (width * height > MAX_PIXELS) throw new Error("PNG is too large to decode.");
      seenHeader = true;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (!seenHeader) throw new Error("PNG has no IHDR chunk.");
  if (!idat.length) throw new Error("PNG has no image data.");

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  // The IHDR dimensions bound the inflated size, so a zip bomb in IDAT cannot allocate
  // more than one image worth of scanlines.
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) });
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is short.");

  // Unfilter in place into one scanline-sized pair of buffers, then widen to RGBA.
  const data = new Uint8Array(width * height * 4);
  let prior = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let x = 0; x < stride; x++) {
      const value = raw[start + 1 + x];
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prior[x];
      const c = x >= bpp ? prior[x - bpp] : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + a;
          break;
        case 2:
          out = value + b;
          break;
        case 3:
          out = value + ((a + b) >> 1);
          break;
        case 4:
          out = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`Unknown PNG filter type ${filter} on row ${y}.`);
      }
      line[x] = out & 0xff;
    }
    const rowOut = y * width * 4;
    if (bpp === 4) {
      data.set(line, rowOut);
    } else {
      for (let px = 0; px < width; px++) {
        data[rowOut + px * 4] = line[px * 3];
        data[rowOut + px * 4 + 1] = line[px * 3 + 1];
        data[rowOut + px * 4 + 2] = line[px * 3 + 2];
        data[rowOut + px * 4 + 3] = 255;
      }
    }
    const swap = prior;
    prior = line;
    line = swap;
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encodes RGBA as a PNG. Every row uses filter 0, which deflate handles well enough here. */
export function encodePng(img: Rgba): Buffer {
  const { width, height, data } = img;
  if (!width || !height) throw new Error("Cannot encode an empty image.");
  if (data.length < width * height * 4) throw new Error("Image data is short for its size.");
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // non-interlaced
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Compares two same-sized bitmaps. A pixel counts as changed when any channel differs by
 * more than `tolerance`, which absorbs the antialiasing jitter between two screenshots of
 * the same page. The diff image shows the changed pixels in red over a faded copy of `b`.
 */
export function diff(
  a: Rgba,
  b: Rgba,
  tolerance = 16,
): { changedPct: number; diffImage: Rgba } {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Image size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}.`);
  }
  const total = a.width * a.height;
  const out = new Uint8Array(total * 4);
  let changed = 0;
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    const delta = Math.max(
      Math.abs(a.data[p] - b.data[p]),
      Math.abs(a.data[p + 1] - b.data[p + 1]),
      Math.abs(a.data[p + 2] - b.data[p + 2]),
      Math.abs(a.data[p + 3] - b.data[p + 3]),
    );
    if (delta > tolerance) {
      changed++;
      out[p] = 255;
      out[p + 1] = 0;
      out[p + 2] = 0;
      out[p + 3] = 255;
    } else {
      // Faded greyscale, so the red stands out but the layout is still readable.
      const grey = Math.round(0.299 * b.data[p] + 0.587 * b.data[p + 1] + 0.114 * b.data[p + 2]);
      const faded = Math.round(255 + (grey - 255) * 0.15);
      out[p] = faded;
      out[p + 1] = faded;
      out[p + 2] = faded;
      out[p + 3] = 255;
    }
  }
  const pct = total ? (changed / total) * 100 : 0;
  return {
    changedPct: Math.round(pct * 1000) / 1000,
    diffImage: { width: a.width, height: a.height, data: out },
  };
}
