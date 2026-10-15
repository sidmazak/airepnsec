import { z } from 'zod'
import { withAuth, json, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const schema = z.object({
  csv: z.string().min(1, 'CSV content is required').max(2_000_000),
})

/** Split a single CSV line on commas, honoring double-quoted cells ("a,b", "" → escaped quote). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[;|]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 24)
}

/**
 * POST /api/customers/import {csv}
 * Header row required with a `name` column; recognized columns:
 * name,email,phone,notes,tags. Valid rows are created, bad rows are reported
 * per line number. Audited once for the whole import.
 */
export const POST = withAuth(async (req, ctx) => {
  const { csv } = await parseBody(req, schema)

  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) {
    return json({ created: 0, errors: [{ row: 1, message: 'CSV needs a header row and at least one data row' }] }, 400)
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
  const idx = (col: string) => header.indexOf(col)
  if (idx('name') < 0) {
    return json({ created: 0, errors: [{ row: 1, message: "CSV header must include a 'name' column (name,email,phone,notes,tags)" }] }, 422)
  }
  const nameIdx = idx('name')
  const emailIdx = idx('email')
  const phoneIdx = idx('phone')
  const notesIdx = idx('notes')
  const tagsIdx = idx('tags')

  let created = 0
  const errors: Array<{ row: number; message: string }> = []

  for (let i = 1; i < lines.length; i++) {
    const rowNo = i + 1 // 1-based file line number (header is line 1)
    try {
      const cells = parseCsvLine(lines[i])
      const name = cells[nameIdx] ?? ''
      if (!name) throw new Error('name is required')
      if (name.length > 120) throw new Error('name is too long (max 120)')

      const email = emailIdx >= 0 ? (cells[emailIdx] ?? '') : ''
      if (email && !EMAIL_RE.test(email)) throw new Error(`invalid email '${email}'`)

      const phone = phoneIdx >= 0 ? (cells[phoneIdx] ?? '') : ''
      if (phone.length > 40) throw new Error('phone is too long (max 40)')

      const notes = notesIdx >= 0 ? (cells[notesIdx] ?? '') : ''
      const tags = tagsIdx >= 0 ? splitTags(cells[tagsIdx] ?? '') : []

      await db.customer.create({
        data: {
          orgId: ctx.org.id,
          name,
          email: email.toLowerCase(),
          phone,
          notes,
          tags: JSON.stringify(tags),
        },
      })
      created += 1
    } catch (err) {
      errors.push({ row: rowNo, message: err instanceof Error ? err.message : 'Row could not be imported' })
    }
  }

  await audit({
    orgId: ctx.org.id,
    actorType: 'user',
    actorId: ctx.user.id,
    action: 'customer.imported',
    entity: 'customer',
    meta: { created, failed: errors.length },
  })

  return json({ created, errors })
}, { roles: ['owner', 'admin'] })
