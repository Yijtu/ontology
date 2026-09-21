/**
 * Deterministic PDF fixture generator (LOCAL-023).
 *
 * The fixtures are real, minimal PDF 1.4 files written in plain PDF syntax and
 * committed next to this script, so the tests parse genuine PDF bytes with the
 * real PDF.js engine bundled by `unpdf`. Re-run with:
 *
 *   node tests/fixtures/documents/generate.mjs
 *
 * Fixtures:
 *   service-terms.pdf   two pages with a text layer: a numbered section, a clause
 *                       that carries its condition/exception on the next line, and
 *                       a captioned table on page 2.
 *   scanned-notice.pdf  one page with no text layer at all; only an image-ish
 *                       rectangle. It exercises the OCR path, which is explicitly
 *                       marked approximate and is driven by an injected provider.
 *   broken-page-2.pdf   two pages where page 2's content stream is corrupt. The
 *                       parser must keep page 1 and report the document as partial.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const OUT_DIR = fileURLToPath(new URL('.', import.meta.url))

function buildPdf(objects) {
  let out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'
  const offsets = []
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n`
  out += '0000000000 65535 f \n'
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  out += `startxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function textOperator(fontSize, x, y, text) {
  return `BT\n/F1 ${fontSize} Tf\n${x} ${y} Td\n(${text}) Tj\nET`
}

function contentStream(body) {
  return `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`
}

function pageObject(parentRef, contentsRef) {
  return [
    '<< /Type /Page',
    `/Parent ${parentRef} 0 R`,
    '/MediaBox [0 0 612 792]',
    '/Resources << /Font << /F1 7 0 R >> >>',
    `/Contents ${contentsRef} 0 R`,
    '>>',
  ].join(' ')
}

function serviceTermsPdf() {
  const pageOne = [
    textOperator(18, 72, 720, '3. Service Terms'),
    textOperator(12, 72, 692, '3.1 The service is provided on a best-effort basis.'),
    textOperator(12, 72, 674, 'Condition: only when the customer account is active.'),
    textOperator(12, 72, 656, 'Exception: outages caused by force majeure are excluded.'),
    textOperator(12, 72, 638, '3.2 Fees are invoiced monthly in arrears.'),
  ].join('\n')
  const pageTwo = [
    textOperator(13, 72, 720, 'Table 1: Rate schedule'),
    textOperator(11, 72, 700, 'Tier A | 0.10 | 100'),
    textOperator(11, 72, 686, 'Tier B | 0.20 | 250'),
    textOperator(11, 72, 672, 'Tier C | 0.35 | 500'),
  ].join('\n')

  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    pageObject(2, 4),
    contentStream(pageOne),
    pageObject(2, 6),
    contentStream(pageTwo),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ])
}

function scannedNoticePdf() {
  // A page whose content stream only paints a rectangle: there is no text layer,
  // so text extraction yields nothing and only an OCR provider can recover text.
  const pageOne = ['0.9 g', '72 600 468 120 re', 'f'].join('\n')
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    pageObject(2, 4),
    contentStream(pageOne),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ])
}

function brokenPageTwoPdf() {
  const pageOne = [textOperator(12, 72, 700, '1. Readable first page clause.')].join('\n')
  // Valid page 1, but page 2's stream declares FlateDecode while the payload is
  // not a zlib stream, so decoding page 2 fails while page 1 stays readable.
  const corrupt = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])
  const brokenStream = `<< /Length ${corrupt.length} /Filter /FlateDecode >>\nstream\n${corrupt.toString('latin1')}\nendstream`

  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    pageObject(2, 4),
    contentStream(pageOne),
    pageObject(2, 6),
    brokenStream,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ])
}

function compressedServiceTermsPdf() {
  const body = [textOperator(12, 72, 700, '1. Compressed clause body.')].join('\n')
  const compressed = deflateSync(Buffer.from(body, 'latin1'))
  const stream = `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream`
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    pageObject(2, 4),
    stream,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ])
}

writeFileSync(new URL('service-terms.pdf', import.meta.url), serviceTermsPdf())
writeFileSync(new URL('scanned-notice.pdf', import.meta.url), scannedNoticePdf())
writeFileSync(new URL('broken-page-2.pdf', import.meta.url), brokenPageTwoPdf())
writeFileSync(new URL('compressed-service-terms.pdf', import.meta.url), compressedServiceTermsPdf())
console.log('wrote PDF fixtures to', OUT_DIR)
