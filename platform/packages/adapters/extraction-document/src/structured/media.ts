import type { StructuredFormat } from '@ontology/contracts'
import { StructuredParseError } from './errors'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLSX_MACRO = 'application/vnd.ms-excel.sheet.macroenabled.12'

const SCANNED = ['image/']
const GEOMETRY = [
  'image/vnd.dwg',
  'image/x-dwg',
  'application/acad',
  'application/x-acad',
  'application/dwg',
  'application/x-dwg',
  'application/autocad_dwg',
]

export function normalizeMediaType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * Resolve the committed format for a media type, or refuse explicitly. An
 * unsupported declaration is never treated as plain text, and a scanned or CAD
 * document is refused instead of being reported as parsed.
 */
export function structuredFormatOf(mediaType: string): StructuredFormat {
  const normalized = normalizeMediaType(mediaType)
  if (normalized === 'text/plain' || normalized === 'text/markdown' || normalized === 'text/x-markdown') {
    return 'text'
  }
  if (normalized === 'application/json' || normalized === 'text/json') return 'json'
  if (normalized === 'text/csv' || normalized === 'application/csv') return 'csv'
  if (normalized === XLSX) return 'xlsx'
  if (normalized === XLSX_MACRO) {
    throw new StructuredParseError(
      'MACRO_ENABLED_WORKBOOK',
      'macro-enabled workbooks are not parsed; re-save as .xlsx without macros',
    )
  }
  if (GEOMETRY.includes(normalized) || normalized.includes('dwg')) {
    throw new StructuredParseError(
      'UNSUPPORTED_DOCUMENT_GEOMETRY',
      `CAD/DWG geometry is not a supported structured format (${mediaType})`,
    )
  }
  if (SCANNED.some((prefix) => normalized.startsWith(prefix))) {
    throw new StructuredParseError(
      'SCANNED_DOCUMENT',
      `an image-only/scanned document has no machine-readable cells (${mediaType})`,
    )
  }
  if (normalized === 'application/vnd.ms-excel') {
    throw new StructuredParseError(
      'UNSUPPORTED_DOCUMENT_TYPE',
      'legacy binary .xls is not supported; re-save as .xlsx',
    )
  }
  if (normalized === 'application/pdf') {
    throw new StructuredParseError(
      'UNSUPPORTED_MEDIA_TYPE',
      'PDF is handled by the historical document parser, not the structured parser',
    )
  }
  throw new StructuredParseError(
    'UNSUPPORTED_MEDIA_TYPE',
    `no structured parser is registered for media type ${mediaType}`,
  )
}
