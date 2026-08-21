/**
 * Minimal PDF text extractor — enough to read a text-layer PDF back as plain text.
 *
 * It indexes the `N 0 obj` bodies, inflates the `/FlateDecode` content streams, and pulls the
 * string operands of the text-showing operators (`Tj`, `TJ`, `'`, `"`). Chromium's
 * `printToPDF` emits Identity-H subset fonts whose string bytes are glyph ids, not
 * characters, so the font's `/ToUnicode` CMap is parsed and applied to whatever font `Tf`
 * last selected — without it a printed page comes back as mojibake. Fonts with no CMap keep
 * their bytes, which is the right answer for plain WinAnsi Type1 text.
 *
 * It is deliberately not a PDF parser: no xref, no object streams, no font metrics.
 *
 * Pure Node (zlib only) so unit tests can bundle it without Electron.
 */
import zlib from "node:zlib";

const MAX_CHARS = 40_000;
/** TJ kerning is in thousandths of an em; a gap this wide is a word break, not tracking. */
const WORD_GAP = -200;
/** Ceiling on a single inflated stream, so a zip-bombed PDF cannot exhaust main-process memory. */
const MAX_INFLATE_BYTES = 64 * 1024 * 1024;

type Operand =
  | { t: "s"; v: string }
  | { t: "n"; v: number }
  | { t: "a"; v: Operand[] }
  | { t: "name"; v: string };

/** A `/ToUnicode` CMap: how many bytes make a code, and what each code means. */
type CMap = { width: number; map: Map<number, string> };

type PdfObject = { num: number; start: number; end: number; dict: string; streamAt: number };

/** Plain text of every content stream in `buf`, capped at 40,000 chars. */
export function extractPdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const objects = indexObjects(raw);
  const cmaps = new Map<number, CMap | null>();
  const out: string[] = [];

  // Long documents stop being decoded once the cap is reachable: a few thousand pages would
  // otherwise block the main process for seconds to produce text nobody sees.
  let collected = 0;
  for (const obj of objects) {
    if (collected >= MAX_CHARS) break;
    if (obj.streamAt < 0 || !isContentStream(obj.dict)) continue;
    const data = decodeStream(raw, obj);
    if (data === null) continue;
    const fonts = fontsFor(raw, objects, obj);
    const piece = readTextOperators(data, (name) => cmapForFont(raw, objects, cmaps, fonts.get(name)));
    if (piece.trim()) {
      out.push(piece);
      collected += piece.length + 1;
    }
  }

  return out
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CHARS);
}

/** Rough page count from the page objects in the file. Zero when none are found. */
export function pdfPageCount(buf: Buffer): number {
  const matches = buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------- object index

/** Every `N 0 obj … endobj` body, with the offset of its `stream` keyword if it has one. */
function indexObjects(raw: string): PdfObject[] {
  const objects: PdfObject[] = [];
  const re = /(\d+)\s+0\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const start = match.index;
    const firstEndObj = raw.indexOf("endobj", start);
    const streamKw = raw.indexOf("stream", start);
    // A stream body can hold anything, `endobj` and `N 0 obj` included, so the object's own
    // end is looked for past `endstream` rather than from the header.
    const hasStream = streamKw >= 0 && (firstEndObj < 0 || streamKw < firstEndObj);
    const searchFrom = hasStream ? Math.max(streamKw, raw.indexOf("endstream", streamKw)) : start;
    const endObj = raw.indexOf("endobj", searchFrom);
    const end = endObj < 0 ? raw.length : endObj;
    objects.push({
      num: Number(match[1]),
      start,
      end,
      dict: raw.slice(start, hasStream ? streamKw : end),
      streamAt: hasStream ? streamKw : -1,
    });
    re.lastIndex = end;
  }
  return objects;
}

function objectByNum(objects: PdfObject[], num: number | undefined): PdfObject | undefined {
  return num === undefined ? undefined : objects.find((o) => o.num === num);
}

/** Streams worth scanning for text: not font programs, images, xref tables, or object stores. */
function isContentStream(dict: string): boolean {
  if (/\/Length1\b/.test(dict)) return false; // embedded font program
  if (/\/Subtype\s*\/Image\b/.test(dict)) return false;
  if (/\/Type\s*\/(XRef|ObjStm|Metadata)\b/.test(dict)) return false;
  return true;
}

/** Stream bytes as latin1, inflated when needed. Null when it cannot be read. */
function decodeStream(raw: string, obj: PdfObject): string | null {
  let start = obj.streamAt + "stream".length;
  if (raw[start] === "\r") start++;
  if (raw[start] === "\n") start++;
  const end = raw.indexOf("endstream", start);
  if (end < 0) return null;
  const body = raw.slice(start, end);
  if (/\/FlateDecode/.test(obj.dict)) {
    try {
      // A hostile or corrupt PDF can hide a zip bomb in a stream, so the inflated size is
      // bounded; over the limit zlib throws and the stream is skipped like any other.
      const opts = { maxOutputLength: MAX_INFLATE_BYTES };
      return zlib.inflateSync(Buffer.from(body, "latin1"), opts).toString("latin1");
    } catch {
      return null; // truncated, not really deflate, or too big — skip it, keep the rest
    }
  }
  // Any other filter (images, JBIG2, …) holds no text this extractor can read.
  return /\/Filter\b/.test(obj.dict) ? null : body;
}

// ------------------------------------------------------------------ font maps

/**
 * `/F4 → 4` for the fonts a content stream can select. Read from the stream's own
 * `/Resources`, else from the page that lists it in `/Contents`, else from the whole file.
 */
function fontsFor(raw: string, objects: PdfObject[], stream: PdfObject): Map<string, number> {
  const own = fontDict(raw, objects, stream.dict, 0);
  if (own.size) return own;

  const owner = objects.find(
    (o) => o.num !== stream.num && new RegExp(`/Contents\\s*\\[?[^\\]]*\\b${stream.num}\\s+0\\s+R`).test(o.dict),
  );
  if (owner) {
    const inherited = fontDict(raw, objects, owner.dict, 0);
    if (inherited.size) return inherited;
  }

  // Last resort: every font name in the file. Wrong only if two pages reuse one name
  // for different fonts, which costs a few glyphs rather than the whole document.
  const all = new Map<string, number>();
  for (const obj of objects) for (const [k, v] of fontDict(raw, objects, obj.dict, 0)) all.set(k, v);
  return all;
}

/** Pulls `/Font << /F4 4 0 R … >>` out of a dictionary, following indirect references. */
function fontDict(raw: string, objects: PdfObject[], dict: string, depth: number): Map<string, number> {
  const out = new Map<string, number>();
  if (depth > 3) return out;

  const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(dict);
  if (inline) {
    const re = /\/([^\s/<>[\]()]+)\s+(\d+)\s+0\s+R/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(inline[1]))) out.set(match[1], Number(match[2]));
    if (out.size) return out;
  }

  const indirect = /\/(?:Font|Resources)\s+(\d+)\s+0\s+R/.exec(dict);
  const target = objectByNum(objects, indirect ? Number(indirect[1]) : undefined);
  if (target) return fontDict(raw, objects, target.dict, depth + 1);
  return out;
}

/** The `/ToUnicode` CMap of a font object, parsed once and cached. */
function cmapForFont(
  raw: string,
  objects: PdfObject[],
  cache: Map<number, CMap | null>,
  fontNum: number | undefined,
): CMap | null {
  if (fontNum === undefined) return null;
  const cached = cache.get(fontNum);
  if (cached !== undefined) return cached;

  let result: CMap | null = null;
  const font = objectByNum(objects, fontNum);
  const ref = font ? /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font.dict) : null;
  const cmapObj = objectByNum(objects, ref ? Number(ref[1]) : undefined);
  if (cmapObj && cmapObj.streamAt >= 0) {
    const src = decodeStream(raw, cmapObj);
    if (src) result = parseCMap(src);
  }
  cache.set(fontNum, result);
  return result;
}

/** `beginbfchar`/`beginbfrange` sections of a ToUnicode CMap. */
function parseCMap(src: string): CMap | null {
  const map = new Map<number, string>();
  let width = 0;

  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(src);
  const spaceLow = space ? /<([0-9a-fA-F]+)>/.exec(space[1]) : null;
  if (spaceLow) width = Math.max(1, Math.round(spaceLow[1].length / 2));

  for (const block of src.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(block))) {
      if (!width) width = Math.max(1, Math.round(match[1].length / 2));
      map.set(parseInt(match[1], 16), utf16beToString(match[2]));
    }
  }

  for (const block of src.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(block))) {
      const lo = parseInt(match[1], 16);
      const hi = parseInt(match[2], 16);
      if (!width) width = Math.max(1, Math.round(match[1].length / 2));
      if (hi < lo || hi - lo > 65_535) continue;
      if (match[3] !== undefined) {
        const base = parseInt(match[3], 16);
        for (let code = lo; code <= hi; code++) {
          map.set(code, String.fromCharCode(base + (code - lo)));
        }
      } else {
        const items = match[4].match(/<([0-9a-fA-F]+)>/g) ?? [];
        items.forEach((item, i) => map.set(lo + i, utf16beToString(item.slice(1, -1))));
      }
    }
  }

  if (!map.size) return null;
  return { width: width || 2, map };
}

/** `<00480065>` → "He". */
function utf16beToString(hex: string): string {
  let out = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const unit = parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16);
    if (!Number.isNaN(unit)) out += String.fromCharCode(unit);
  }
  return out;
}

/** Reads raw string bytes as codes through a CMap. Unmapped codes are dropped. */
function decodeWithCMap(value: string, cmap: CMap): string {
  let out = "";
  for (let i = 0; i < value.length; i += cmap.width) {
    let code = 0;
    for (let b = 0; b < cmap.width; b++) code = (code << 8) | (value.charCodeAt(i + b) & 0xff);
    const mapped = cmap.map.get(code);
    if (mapped !== undefined) out += mapped;
    else if (cmap.width === 1) out += value[i];
  }
  return out;
}

// ------------------------------------------------------------ content scanner

/** Text-showing operators of one content stream, as lines. */
function readTextOperators(content: string, cmapFor: (fontName: string) => CMap | null): string {
  let out = "";
  const stack: Operand[] = [];
  let cmap: CMap | null = null;
  /** Last `Tm` vertical translation — moving to a new one starts a new line. */
  let lastY: number | null = null;
  let i = 0;

  const newline = (): void => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const decode = (value: string): string => (cmap ? decodeWithCMap(value, cmap) : value);
  const show = (op: Operand | undefined): void => {
    if (!op) return;
    if (op.t === "s") out += decode(op.v);
    else if (op.t === "a") out += joinArray(op.v, decode);
  };

  while (i < content.length) {
    const ch = content[i];
    if (ch === "(") {
      const literal = readLiteral(content, i);
      stack.push({ t: "s", v: literal.value });
      i = literal.next;
      continue;
    }
    if (ch === "<" && content[i + 1] === "<") {
      i += 2;
      continue;
    }
    if (ch === ">" && content[i + 1] === ">") {
      i += 2;
      continue;
    }
    if (ch === "<") {
      const close = content.indexOf(">", i);
      if (close < 0) break;
      stack.push({ t: "s", v: fromHex(content.slice(i + 1, close)) });
      i = close + 1;
      continue;
    }
    if (ch === "[") {
      const arr = readArray(content, i);
      stack.push({ t: "a", v: arr.items });
      i = arr.next;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      while (j < content.length && /[^\s/[\]<>()]/.test(content[j])) j++;
      stack.push({ t: "name", v: content.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      newline();
      show(stack[stack.length - 1]);
      stack.length = 0;
      i++;
      continue;
    }
    if (/[-+.\d]/.test(ch)) {
      let j = i + 1;
      while (j < content.length && /[-+.\d]/.test(content[j])) j++;
      stack.push({ t: "n", v: Number(content.slice(i, j)) || 0 });
      i = j;
      continue;
    }
    if (/[A-Za-z*]/.test(ch)) {
      let j = i;
      while (j < content.length && /[A-Za-z0-9*]/.test(content[j])) j++;
      const op = content.slice(i, j);
      i = j;
      if (op === "Tj" || op === "TJ") {
        show(stack[stack.length - 1]);
      } else if (op === "T*") {
        newline();
      } else if (op === "Td" || op === "TD") {
        const y = stack[stack.length - 1];
        if (y && y.t === "n" && y.v < 0) newline();
      } else if (op === "Tf") {
        const font = stack.find((entry) => entry.t === "name");
        cmap = font && font.t === "name" ? cmapFor(font.v) : null;
      } else if (op === "Tm") {
        // Printed pages position every line with its own text matrix rather than T*.
        const f = stack[stack.length - 1];
        const y = f && f.t === "n" ? f.v : null;
        if (y !== null && lastY !== null && y !== lastY) newline();
        if (y !== null) lastY = y;
      }
      stack.length = 0;
      continue;
    }
    i++;
  }
  return out;
}

/** A TJ array: string parts run together, wide negative kerning becomes a space. */
function joinArray(items: Operand[], decode: (value: string) => string): string {
  let out = "";
  for (const item of items) {
    if (item.t === "s") out += decode(item.v);
    else if (item.t === "n" && item.v < WORD_GAP && out && !out.endsWith(" ")) out += " ";
  }
  return out;
}

/** Reads a `(…)` literal starting at `start`, honouring nesting and backslash escapes. */
function readLiteral(content: string, start: number): { value: string; next: number } {
  let value = "";
  let depth = 1;
  let i = start + 1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "\\") {
      const esc = content[i + 1];
      i += 2;
      if (esc === "n") value += "\n";
      else if (esc === "r") value += "\r";
      else if (esc === "t") value += "\t";
      else if (esc === "b") value += "\b";
      else if (esc === "f") value += "\f";
      else if (esc === "\n") continue;
      else if (esc === "\r") {
        if (content[i] === "\n") i++;
        continue;
      } else if (esc >= "0" && esc <= "7") {
        let oct = esc;
        while (oct.length < 3 && content[i] >= "0" && content[i] <= "7") oct += content[i++];
        value += String.fromCharCode(parseInt(oct, 8));
      } else value += esc ?? "";
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return { value, next: i + 1 };
    }
    value += ch;
    i++;
  }
  return { value, next: i };
}

/** Reads a `[…]` array of strings and numbers starting at `start`. */
function readArray(content: string, start: number): { items: Operand[]; next: number } {
  const items: Operand[] = [];
  let i = start + 1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "]") return { items, next: i + 1 };
    if (ch === "(") {
      const literal = readLiteral(content, i);
      items.push({ t: "s", v: literal.value });
      i = literal.next;
      continue;
    }
    if (ch === "<") {
      const close = content.indexOf(">", i);
      if (close < 0) break;
      items.push({ t: "s", v: fromHex(content.slice(i + 1, close)) });
      i = close + 1;
      continue;
    }
    if (/[-+.\d]/.test(ch)) {
      let j = i + 1;
      while (j < content.length && /[-+.\d]/.test(content[j])) j++;
      items.push({ t: "n", v: Number(content.slice(i, j)) || 0 });
      i = j;
      continue;
    }
    i++;
  }
  return { items, next: i };
}

/** `<48656c6c6f>` hex strings. Odd-length runs pad with a trailing zero, per the spec. */
function fromHex(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const padded = clean.length % 2 ? `${clean}0` : clean;
  let out = "";
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}
