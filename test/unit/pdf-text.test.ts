import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { extractPdfText, pdfPageCount } from "../../src/main/pdf-text";

const CONTENT = "BT /F1 12 Tf 72 720 Td (Hello Echo) Tj ET";

type ObjSpec = string | { dict: string; stream: Buffer };

/** Assembles numbered objects into a PDF with a real xref table and trailer. */
function assemble(objects: ObjSpec[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let at = parts[0].length;

  objects.forEach((spec, i) => {
    const n = i + 1;
    offsets.push(at);
    const chunk =
      typeof spec === "string"
        ? Buffer.from(`${n} 0 obj\n${spec}\nendobj\n`, "latin1")
        : Buffer.concat([
            Buffer.from(
              `${n} 0 obj\n<< /Length ${spec.stream.length}${spec.dict} >>\nstream\n`,
              "latin1",
            ),
            spec.stream,
            Buffer.from("\nendstream\nendobj\n", "latin1"),
          ]);
    parts.push(chunk);
    at += chunk.length;
  });

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

/** A tiny one-page PDF whose single content stream is `streamBody`. */
function buildPdf(streamBody: Buffer, streamDict: string): Buffer {
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    { dict: streamDict, stream: streamBody },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

test("extracts text from an uncompressed content stream", () => {
  const pdf = buildPdf(Buffer.from(CONTENT, "latin1"), "");
  assert.match(extractPdfText(pdf), /Hello Echo/);
});

test("extracts text from a FlateDecode content stream", () => {
  const deflated = zlib.deflateSync(Buffer.from(CONTENT, "latin1"));
  const pdf = buildPdf(deflated, " /Filter /FlateDecode");
  assert.match(extractPdfText(pdf), /Hello Echo/);
});

test("a corrupt FlateDecode stream is skipped, not thrown", () => {
  const bad = Buffer.from("not actually deflate data", "latin1");
  const pdf = buildPdf(bad, " /Filter /FlateDecode");
  assert.equal(extractPdfText(pdf), "");
});

test("joins TJ array parts and spaces wide kerning gaps", () => {
  const body = "BT [(Echo)-500(reads)-20(PDFs)] TJ ET";
  const pdf = buildPdf(Buffer.from(body, "latin1"), "");
  assert.equal(extractPdfText(pdf), "Echo readsPDFs");
});

test("handles escaped parens and backslashes in string literals", () => {
  const body = String.raw`BT (a \(b\) c \\ d) Tj ET`;
  const pdf = buildPdf(Buffer.from(body, "latin1"), "");
  assert.match(extractPdfText(pdf), /a \(b\) c \\ d/);
});

test("breaks lines on T*, quote operators, and negative-y Td", () => {
  const body = "BT (one) Tj T* (two) Tj 0 -14 Td (three) Tj (four) ' ET";
  const pdf = buildPdf(Buffer.from(body, "latin1"), "");
  assert.deepEqual(extractPdfText(pdf).split("\n"), ["one", "two", "three", "four"]);
});

test("each Tm repositioning starts a new line", () => {
  const body =
    "BT /F1 12 Tf 1 0 0 -1 72 100 Tm (first) Tj ET BT /F1 12 Tf 1 0 0 -1 72 130 Tm (second) Tj ET";
  const pdf = buildPdf(Buffer.from(body, "latin1"), "");
  assert.deepEqual(extractPdfText(pdf).split("\n"), ["first", "second"]);
});

test("decodes Identity-H glyph codes through the font's /ToUnicode CMap", () => {
  // The string bytes are glyph ids, so they spell nothing without the CMap.
  const content = "BT /F1 12 Tf <00290048004F004F0052> Tj ET";
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin begincmap",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "2 beginbfchar",
    "<0029> <0048>",
    "<0052> <006F>",
    "endbfchar",
    "1 beginbfrange",
    "<0048> <004F> <0065>",
    "endbfrange",
    "endcmap end end",
  ].join("\n");
  const pdf = assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    { dict: "", stream: Buffer.from(content, "latin1") },
    "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>",
    { dict: "", stream: Buffer.from(cmap, "latin1") },
  ]);
  assert.equal(extractPdfText(pdf), "Hello");
});

test("embedded font programs and images are not scanned for text", () => {
  const pdf = assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    { dict: "", stream: Buffer.from("BT (real text) Tj ET", "latin1") },
    { dict: " /Length1 999", stream: Buffer.from("BT (font program junk) Tj ET", "latin1") },
    { dict: " /Subtype /Image", stream: Buffer.from("BT (pixel junk) Tj ET", "latin1") },
  ]);
  assert.equal(extractPdfText(pdf), "real text");
});

test("caps output at 40,000 chars", () => {
  const body = `BT ${"(0123456789) Tj ".repeat(5000)}ET`;
  const pdf = buildPdf(Buffer.from(body, "latin1"), "");
  assert.equal(extractPdfText(pdf).length, 40_000);
});

test("counts pages", () => {
  const pdf = buildPdf(Buffer.from(CONTENT, "latin1"), "");
  assert.equal(pdfPageCount(pdf), 1);
});

test("an empty buffer yields no text", () => {
  assert.equal(extractPdfText(Buffer.alloc(0)), "");
});
