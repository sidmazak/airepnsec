/**
 * Pure crawl helpers (no I/O, no framework imports) so they can be unit-tested
 * with Node's built-in test runner. `crawl.ts` re-exports these.
 */

export const CRAWL_DEFAULT_MAX_PAGES = 20
export const CRAWL_MAX_PAGES = 50
export const CRAWL_DEFAULT_MAX_DEPTH = 2
export const CRAWL_MAX_DEPTH = 4

const ASSET_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.css', '.js', '.mjs',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.mp3', '.mp4', '.webm', '.wav', '.ogg', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.exe', '.dmg', '.apk', '.iso',
])

export function normalizeCrawlUrl(raw: string, baseUrl?: string): string | null {
  try {
    const url = new URL(raw, baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    // Drop common tracking parameters so the same page is not fetched twice.
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) {
      url.searchParams.delete(key)
    }
    const ext = (url.pathname.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase()
    if (ASSET_EXTENSIONS.has(ext)) return null
    if (url.pathname === '') url.pathname = '/'
    return url.toString()
  } catch {
    return null
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/* ---------------- robots.txt ---------------- */

export type RobotsRules = { disallow: string[]; allow: string[]; crawlDelayMs: number }

export function parseRobotsTxt(text: string, userAgent = '*'): RobotsRules {
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[]; crawlDelayMs: number }> = []
  let current: { agents: string[]; disallow: string[]; allow: string[]; crawlDelayMs: number } | null = null
  let startingNewGroup = false

  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'user-agent') {
      if (!current || startingNewGroup) {
        current = { agents: [], disallow: [], allow: [], crawlDelayMs: 0 }
        groups.push(current)
        startingNewGroup = false
      }
      current.agents.push(value.toLowerCase())
      continue
    }
    if (!current) continue
    startingNewGroup = true
    if (key === 'disallow' && value) current.disallow.push(value)
    if (key === 'allow' && value) current.allow.push(value)
    if (key === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) current.crawlDelayMs = Math.min(30_000, n * 1000)
    }
  }

  const wanted = userAgent.toLowerCase()
  const matching = groups.filter((g) => g.agents.includes('*') || g.agents.some((a) => wanted.includes(a)))
  const exact = matching.find((g) => !g.agents.includes('*'))
  const chosen = exact ?? matching[0]
  return chosen ? { disallow: chosen.disallow, allow: chosen.allow, crawlDelayMs: chosen.crawlDelayMs } : { disallow: [], allow: [], crawlDelayMs: 0 }
}

/** Longest-match robots rule (Google semantics). */
export function isAllowedByRobots(pathname: string, rules: RobotsRules): boolean {
  const test = pathname || '/'
  let best = 0
  let allowed = true
  for (const rule of rules.allow) {
    if (test.startsWith(rule) && rule.length >= best) {
      best = rule.length
      allowed = true
    }
  }
  for (const rule of rules.disallow) {
    if (test.startsWith(rule) && rule.length >= best) {
      best = rule.length
      allowed = false
    }
  }
  return allowed
}

/* ---------------- sitemaps ---------------- */

export function parseSitemapLocs(xml: string): { locations: string[]; isIndex: boolean } {
  const locations = [...(xml || '').matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)]
    .map((m) => m[1].trim())
    .filter((loc) => /^https?:\/\//i.test(loc))
  const isIndex = /<sitemapindex[\s>]/i.test(xml || '')
  return { locations, isIndex }
}
