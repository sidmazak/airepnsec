import { createHash } from 'node:crypto'
import { z } from 'zod'
import { withAuth, json, fail, parseBody } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { indexDocument } from '@/lib/ai/embeddings'
import { chatComplete } from '@/lib/ai/llm'
import { getActiveProvider } from '@/lib/ai/providers'
import { assertOutboundUrl } from '@/lib/security/outbound'
import { crawlWebsite, CRAWL_MAX_DEPTH, CRAWL_MAX_PAGES } from '@/lib/knowledge/crawl'
import type { ProviderKind } from '@/lib/ai/providers'

const schema = z.object({
  url: z.string().url().max(2000),
  maxPages: z.number().int().min(1).max(CRAWL_MAX_PAGES).optional(),
  maxDepth: z.number().int().min(0).max(CRAWL_MAX_DEPTH).optional(),
  sameOrigin: z.boolean().optional(),
  useAi: z.boolean().optional(),
  approved: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(24).optional(),
})

const CLEANUP_SYSTEM = `You convert one web page into a clean knowledge-base entry for an AI receptionist.
Keep only factual business knowledge: services, prices, opening hours, locations, contact details, policies, FAQs.
Drop navigation, cookie banners, marketing filler, and repeated boilerplate.
Write short markdown paragraphs. Do not invent anything that is not on the page.
If the page has no useful business knowledge, reply with exactly NOTHING.`

/** POST /api/knowledge/crawl — import a website into the knowledge base (owner/admin). */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, schema)

    const llm = await getActiveProvider(ctx.org.id, 'llm')
    if (!llm) {
      return fail(
        409,
        'Configure and enable an AI model in AI Providers first — website extraction uses it to turn pages into clean knowledge.',
        { code: 'ai_not_configured' }
      )
    }

    let start: URL
    try {
      start = await assertOutboundUrl(body.url, { label: 'Website URL' })
    } catch (err) {
      return fail(422, err instanceof Error ? err.message : 'The website URL is not allowed', { code: 'bad_url' })
    }

    const useAi = body.useAi !== false
    const crawl = await crawlWebsite({
      startUrl: start.toString(),
      maxPages: body.maxPages,
      maxDepth: body.maxDepth,
      sameOrigin: body.sameOrigin !== false,
      validateUrl: (url) => assertOutboundUrl(url, { label: 'Website URL' }),
    })

    if (crawl.pages.length === 0) {
      return json(
        {
          ok: false,
          message:
            'No readable pages were found. Check that the site is public, allows crawling, and serves HTML (not only JavaScript-rendered content).',
          pages: [],
          errors: crawl.errors,
          skipped: crawl.skipped,
        },
        422
      )
    }

    const tags = [...new Set([...(body.tags ?? []), 'website'])]
    const approved = body.approved !== false
    let created = 0
    let updated = 0
    let chunks = 0
    let aiCleaned = 0
    const aiFailures: Array<{ url: string; message: string }> = []
    const saved: Array<{ url: string; title: string; docId: string; aiCleaned: boolean }> = []

    for (const page of crawl.pages) {
      let content = page.text
      let cleaned = false
      if (useAi) {
        try {
          const result = await chatComplete(
            ctx.org.id,
            [
              { role: 'system', content: CLEANUP_SYSTEM },
              { role: 'user', content: `Page URL: ${page.url}\nPage title: ${page.title}\n\n${page.text.slice(0, 16_000)}` },
            ],
            { temperature: 0.1, maxTokens: 1200, timeoutMs: 60_000 }
          )
          const text = result.content.trim()
          if (text && text.toUpperCase() !== 'NOTHING' && text.length >= 40) {
            content = text
            cleaned = true
            aiCleaned++
          }
        } catch (err) {
          aiFailures.push({ url: page.url, message: err instanceof Error ? err.message : 'AI cleanup failed' })
        }
      }

      content = content.slice(0, 200_000)
      const contentHash = createHash('sha256').update(content).digest('hex')
      const existing = await db.knowledgeDoc.findFirst({
        where: { orgId: ctx.org.id, source: 'website', externalId: page.url },
      })

      let docId: string
      if (existing) {
        await db.knowledgeDoc.update({
          where: { id: existing.id },
          data: {
            title: page.title,
            content,
            contentHash,
            approved,
            tags: JSON.stringify([...new Set([...tags, ...safeTags(existing.tags)])]),
          },
        })
        docId = existing.id
        updated++
      } else {
        const doc = await db.knowledgeDoc.create({
          data: {
            orgId: ctx.org.id,
            title: page.title,
            content,
            contentHash,
            approved,
            tags: JSON.stringify(tags),
            source: 'website',
            externalId: page.url,
          },
        })
        docId = doc.id
        created++
      }

      const indexed = await indexDocument(ctx.org.id, docId, content)
      chunks += indexed.chunkCount
      saved.push({ url: page.url, title: page.title, docId, aiCleaned: cleaned })
    }

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'knowledge.website_imported',
      entity: 'organization',
      entityId: ctx.org.id,
      meta: {
        startUrl: start.toString(),
        provider: llm.provider as ProviderKind,
        model: llm.model,
        useAi,
        created,
        updated,
        chunks,
        aiCleaned,
        pages: crawl.pages.length,
        errors: crawl.errors.length,
        skipped: crawl.skipped.length,
      },
    })

    return json({
      ok: true,
      message:
        `Imported ${created + updated} page${created + updated === 1 ? '' : 's'} from ${start.hostname}` +
        ` (${created} new, ${updated} updated, ${chunks} chunks indexed)` +
        (useAi ? ` — ${aiCleaned} AI-cleaned` : ' — deterministic text extraction') +
        (aiFailures.length ? `, ${aiFailures.length} AI cleanup failure${aiFailures.length === 1 ? '' : 's'}` : '') +
        '.',
      created,
      updated,
      chunks,
      aiCleaned,
      aiFailures,
      pages: saved,
      errors: crawl.errors,
      skipped: crawl.skipped,
    })
  },
  { roles: ['owner', 'admin'] }
)

function safeTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}
