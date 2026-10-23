import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { extractDocument } from '@/lib/knowledge/extract'

const schema = z.object({
  filename: z.string().min(1).max(300),
  mimeType: z.string().max(200).optional(),
  base64: z.string().max(40_000_000).optional(),
  text: z.string().max(2_000_000).optional(),
})

/** POST /api/knowledge/extract — turn an uploaded file into plain text (owner/admin). */
export const POST = withAuth(
  async (req) => {
    const body = await parseBody(req, schema)
    if (!body.base64 && typeof body.text !== 'string') {
      return fail(422, 'Provide a base64 file payload or text content', { code: 'bad_upload' })
    }
    try {
      const extracted = await extractDocument(body)
      return json({ document: extracted })
    } catch (err) {
      return fail(422, err instanceof Error ? err.message : 'The file could not be read', { code: 'extract_failed' })
    }
  },
  { roles: ['owner', 'admin'] }
)
