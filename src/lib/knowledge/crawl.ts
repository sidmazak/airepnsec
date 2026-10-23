import { extractTextFromHtml, normalizeWhitespace } from './extract.ts'
import {
  CRAWL_DEFAULT_MAX_DEPTH,
  CRAWL_DEFAULT_MAX_PAGES,
  CRAWL_MAX_DEPTH,
  CRAWL_MAX_PAGES,
  isAllowedByRobots,
  normalizeCrawlUrl,
  parseRobotsTxt,
  parseSitemapLocs,
  sameOrigin,
  type RobotsRules,
} from './crawl-protocol.ts'

/**
 * Small, dependency-light website crawler for the knowledge importer.
 *
 * - same-origin by default, robots.txt respected, /sitemap.xml discovered
 * - depth/page caps, timeouts, static-asset filtering
 * - returns one row per page; the caller decides whether to AI-clean and store
 * - URL validation is injected (`validateUrl`) so the SSRF guard lives in the
 *   route, while the crawler stays unit-testable.
 */

export {
  CRAWL_DEFAULT_MAX_DEPTH,
  CRAWL_DEFAULT_MAX_PAGES,
  CRAWL_MAX_DEPTH,
  CRAWL_MAX_PAGES,
  isAllowedByRobots,
  normalizeCrawlUrl,
  parseRobotsTxt,
  parseSitemapLocs,
  sameOrigin,
}
export type { RobotsRules }

export type CrawledPage = { url: string; title: string; text: string; depth: number }
export type CrawlError = { url: string; message: string }

export type CrawlOptions = {
  startUrl: string
  maxPages?: number
  maxDepth?: number
  sameOrigin?: boolean
  useSitemap?: boolean
  validateUrl?: (url: string) => Promise<URL | null>
  fetchImpl?: typeof fetch
  userAgent?: string
  timeoutMs?: number
}

export type CrawlResult = {
  pages: CrawledPage[]
  errors: CrawlError[]
  skipped: Array<{ url: string; reason: string }>
  robotsFound: boolean
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  userAgent: string,
  timeoutMs: number,
  accept: string
): Promise<{ ok: boolean; status: number; text: string; contentType: string }> {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'user-agent': userAgent, accept },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const contentType = res.headers.get('content-type') ?? ''
  const text = res.ok ? await res.text() : ''
  return { ok: res.ok, status: res.status, text, contentType }
}

export async function crawlWebsite(options: CrawlOptions): Promise<CrawlResult> {
  const startUrl = normalizeCrawlUrl(options.startUrl)
  if (!startUrl) throw new Error('The website URL is not a valid http(s) URL.')
  const maxPages = Math.max(1, Math.min(CRAWL_MAX_PAGES, options.maxPages ?? CRAWL_DEFAULT_MAX_PAGES))
  const maxDepth = Math.max(0, Math.min(CRAWL_MAX_DEPTH, options.maxDepth ?? CRAWL_DEFAULT_MAX_DEPTH))
  const sameSite = options.sameOrigin !== false
  const fetchImpl = options.fetchImpl ?? fetch
  const userAgent = options.userAgent ?? 'AISecretaryBot/1.0'
  const timeoutMs = options.timeoutMs ?? 15_000
  const origin = new URL(startUrl).origin
  const validate = options.validateUrl ?? (async (u: string) => new URL(u))

  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }]
  const seen = new Set<string>([startUrl])
  const pages: CrawledPage[] = []
  const errors: CrawlError[] = []
  const skipped: Array<{ url: string; reason: string }> = []
  let robotsRules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: 0 }
  let robotsFound = false

  try {
    const robots = await fetchText(`${origin}/robots.txt`, fetchImpl, userAgent, 8_000, 'text/plain')
    if (robots.ok && robots.text.trim()) {
      robotsRules = parseRobotsTxt(robots.text, userAgent)
      robotsFound = true
    }
  } catch { /* no robots.txt — allowed */ }

  if (options.useSitemap !== false) {
    const sitemapBudget = Math.min(5, maxPages)
    const sitemaps = [`${origin}/sitemap.xml`]
    let fetchedMaps = 0
    while (sitemaps.length > 0 && fetchedMaps < sitemapBudget && queue.length < maxPages) {
      const sitemapUrl = sitemaps.shift()!
      fetchedMaps++
      try {
        const res = await fetchText(sitemapUrl, fetchImpl, userAgent, 8_000, 'application/xml,text/xml')
        if (!res.ok) continue
        const parsed = parseSitemapLocs(res.text)
        if (parsed.isIndex) {
          for (const child of parsed.locations.slice(0, sitemapBudget)) {
            if (sameOrigin(child, origin) || !sameSite) sitemaps.push(child)
          }
        } else {
          for (const loc of parsed.locations) {
            const normalized = normalizeCrawlUrl(loc)
            if (!normalized || seen.has(normalized)) continue
            if (sameSite && !sameOrigin(normalized, origin)) continue
            if (!isAllowedByRobots(new URL(normalized).pathname, robotsRules)) continue
            seen.add(normalized)
            queue.push({ url: normalized, depth: 1 })
            if (queue.length >= maxPages * 3) break
          }
        }
      } catch { /* sitemap is optional */ }
    }
  }

  let processed = 0
  while (queue.length > 0 && processed < maxPages) {
    const next = queue.shift()!
    if (!isAllowedByRobots(new URL(next.url).pathname, robotsRules)) {
      skipped.push({ url: next.url, reason: 'blocked by robots.txt' })
      continue
    }
    let safe: URL | null = null
    try {
      safe = await validate(next.url)
    } catch (err) {
      errors.push({ url: next.url, message: err instanceof Error ? err.message : 'URL is not allowed' })
      continue
    }
    if (!safe) {
      errors.push({ url: next.url, message: 'URL is not allowed' })
      continue
    }

    try {
      const res = await fetchText(next.url, fetchImpl, userAgent, timeoutMs, 'text/html,application/xhtml+xml')
      if (!res.ok) {
        errors.push({ url: next.url, message: `HTTP ${res.status}` })
        continue
      }
      if (!/text\/html|application\/xhtml/i.test(res.contentType)) {
        skipped.push({ url: next.url, reason: `skipped non-HTML content (${res.contentType || 'unknown'})` })
        continue
      }
      processed++
      const parsed = extractTextFromHtml(res.text)
      const text = normalizeWhitespace(parsed.text)
      if (text.length < 80) {
        skipped.push({ url: next.url, reason: 'not enough readable text' })
        continue
      }
      pages.push({ url: next.url, title: (parsed.title || new URL(next.url).pathname).slice(0, 300), text, depth: next.depth })

      if (next.depth < maxDepth) {
        const cheerio = await import('cheerio')
        const $ = cheerio.load(res.text)
        const links: string[] = []
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href')
          if (!href) return
          const normalized = normalizeCrawlUrl(href, next.url)
          if (!normalized) return
          if (sameSite && !sameOrigin(normalized, origin)) return
          links.push(normalized)
        })
        for (const link of links) {
          if (seen.has(link)) continue
          seen.add(link)
          queue.push({ url: link, depth: next.depth + 1 })
          if (queue.length >= maxPages * 5) break
        }
      }

      if (robotsRules.crawlDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(robotsRules.crawlDelayMs, 2_000)))
      }
    } catch (err) {
      const message = err instanceof Error ? (err.name === 'AbortError' ? 'request timed out' : err.message) : 'fetch failed'
      errors.push({ url: next.url, message })
    }
  }

  return { pages, errors, skipped, robotsFound }
}
