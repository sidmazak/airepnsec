import { extname } from 'node:path'
import * as cheerio from 'cheerio'

/**
 * Server-side document extraction for the knowledge uploader.
 *
 * Supported formats: plain text/markdown/CSV/JSON/XML, HTML, PDF (unpdf) and
 * DOCX (mammoth). Legacy .doc and images are rejected with an honest message.
 * Nothing is stored here — the caller decides what to save and index.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_EXTRACTED_CHARS = 200_000

export type ExtractedDocument = {
  title: string
  text: string
  format: string
  pages?: number
  warnings: string[]
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.log', '.rtf'])

export function extensionOf(filename: string): string {
  return extname(filename || '').toLowerCase()
}

export function base64ToBuffer(base64: string): Buffer {
  const cleaned = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
  return Buffer.from(cleaned, 'base64')
}

/** Strip an HTML document down to readable text while keeping block breaks. */
export function extractTextFromHtml(html: string): { title: string; text: string } {
  const $ = cheerio.load(html || '')
  const title = ($('meta[property="og:title"]').attr('content') || $('title').first().text() || '').trim()
  $('script, style, noscript, svg, canvas, iframe, form, button, input, select, textarea, template').remove()
  $('br').replaceWith('\n')
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, section, article, header, footer, main').each((_, el) => {
    $(el).append('\n')
  })
  const raw = $('body').length ? $('body').text() : $.root().text()
  return { title, text: normalizeWhitespace(raw) }
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function titleFromFilename(filename: string): string {
  const base = (filename || 'document').replace(/^.*[\\/]/, '')
  const withoutExt = base.replace(/\.[^.]+$/, '')
  return withoutExt.replace(/[_-]+/g, ' ').trim() || 'Imported document'
}

function finalize(title: string, text: string, format: string, warnings: string[], pages?: number): ExtractedDocument {
  let body = normalizeWhitespace(text)
  if (!body) throw new Error('The file did not contain any readable text.')
  if (body.length > MAX_EXTRACTED_CHARS) {
    body = body.slice(0, MAX_EXTRACTED_CHARS)
    warnings.push(`Text was truncated to ${MAX_EXTRACTED_CHARS.toLocaleString()} characters (the knowledge document limit).`)
  }
  return { title: title.slice(0, 300) || titleFromFilename(''), text: body, format, warnings, ...(pages ? { pages } : {}) }
}

export async function extractDocument(input: {
  filename: string
  mimeType?: string
  base64?: string
  text?: string
}): Promise<ExtractedDocument> {
  const filename = input.filename || 'document.txt'
  const ext = extensionOf(filename)
  const mime = (input.mimeType || '').toLowerCase()
  const warnings: string[] = []
  const title = titleFromFilename(filename)

  // Plain-text path (also used for pasted content).
  if (!input.base64 && typeof input.text === 'string') {
    return finalize(title, input.text, ext.replace('.', '') || 'text', warnings)
  }
  if (!input.base64) throw new Error('No file content was received.')

  const buffer = base64ToBuffer(input.base64)
  if (buffer.length === 0) throw new Error('The uploaded file is empty.')
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`The file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit.`)
  }

  if (ext === '.pdf' || mime === 'application/pdf') {
    const { extractText } = await import('unpdf')
    const result = await extractText(new Uint8Array(buffer), { mergePages: true })
    const text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text
    if (result.totalPages > 500) warnings.push(`This PDF has ${result.totalPages} pages; extraction may be partial.`)
    return finalize(title, text, 'pdf', warnings, result.totalPages)
  }

  if (ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = (await import('mammoth')).default ?? (await import('mammoth'))
    const result = await mammoth.extractRawText({ buffer })
    for (const message of result.messages ?? []) {
      if (message.type === 'warning') warnings.push(message.message)
    }
    return finalize(title, result.value, 'docx', warnings)
  }

  if (ext === '.html' || ext === '.htm' || mime === 'text/html') {
    const parsed = extractTextFromHtml(buffer.toString('utf8'))
    return finalize(parsed.title || title, parsed.text, 'html', warnings)
  }

  if (ext === '.doc') {
    throw new Error('Legacy .doc files are not supported. Save the document as .docx or PDF and upload it again.')
  }
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
    throw new Error('Images cannot be imported as text. Use the “Read an image” card in Knowledge (it uses your configured vision model).')
  }

  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
    return finalize(title, buffer.toString('utf8'), ext.replace('.', '') || 'text', warnings)
  }

  // Last resort: accept printable UTF-8 rather than rejecting a valid text file
  // with an unknown extension. Binary data is rejected honestly.
  const asText = buffer.toString('utf8')
  const nonPrintable = asText.replace(/[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, '').length
  if (asText.length > 0 && nonPrintable / asText.length < 0.02) {
    warnings.push(`Unknown file type “${ext || mime || 'unknown'}” — imported as plain text.`)
    return finalize(title, asText, 'text', warnings)
  }
  throw new Error(`Unsupported file type “${ext || mime || 'unknown'}”. Supported: text, Markdown, CSV, JSON, HTML, PDF, DOCX.`)
}
