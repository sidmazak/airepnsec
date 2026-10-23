import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAllowedByRobots,
  normalizeCrawlUrl,
  parseRobotsTxt,
  parseSitemapLocs,
  sameOrigin,
} from '../../src/lib/knowledge/crawl-protocol.ts'
import { base64ToBuffer, extractDocument, extractTextFromHtml, normalizeWhitespace } from '../../src/lib/knowledge/extract.ts'

test('normalizeCrawlUrl keeps http(s), strips hashes/tracking, rejects assets and non-http', () => {
  assert.equal(normalizeCrawlUrl('https://Example.com/about#team'), 'https://example.com/about')
  assert.equal(
    normalizeCrawlUrl('https://example.com/pricing?utm_source=news&fbclid=x&plan=pro'),
    'https://example.com/pricing?plan=pro'
  )
  assert.equal(normalizeCrawlUrl('/contact', 'https://example.com/'), 'https://example.com/contact')
  assert.equal(normalizeCrawlUrl('mailto:hi@example.com'), null)
  assert.equal(normalizeCrawlUrl('javascript:alert(1)'), null)
  assert.equal(normalizeCrawlUrl('https://example.com/brochure.pdf'), null)
  assert.equal(normalizeCrawlUrl('https://example.com/logo.png?v=2'), null)
  assert.equal(normalizeCrawlUrl('not a url'), null)
  assert.equal(normalizeCrawlUrl('https://example.com'), 'https://example.com/')
})

test('sameOrigin compares only the origin', () => {
  assert.equal(sameOrigin('https://a.test/x', 'https://a.test/y'), true)
  assert.equal(sameOrigin('http://a.test/x', 'https://a.test/y'), false)
  assert.equal(sameOrigin('https://b.test', 'https://a.test'), false)
  assert.equal(sameOrigin('nonsense', 'https://a.test'), false)
})

test('parseRobotsTxt picks the matching group and longest-rule precedence holds', () => {
  const robots = parseRobotsTxt(`
User-agent: *
Disallow: /admin
Allow: /admin/public
Crawl-delay: 2

User-agent: AISecretaryBot
Disallow: /private
`, 'AISecretaryBot/1.0')
  assert.deepEqual(robots.disallow, ['/private'])
  assert.equal(robots.crawlDelayMs, 0)

  const star = parseRobotsTxt(`
User-agent: *
Disallow: /admin
Allow: /admin/public
Crawl-delay: 2
`)
  assert.equal(isAllowedByRobots('/admin/secret', star), false)
  assert.equal(isAllowedByRobots('/admin/public/page', star), true)
  assert.equal(isAllowedByRobots('/pricing', star), true)
  assert.equal(star.crawlDelayMs, 2000)
})

test('parseSitemapLocs reads url and index sitemaps', () => {
  const urlset = parseSitemapLocs(`<?xml version="1.0"?><urlset>
    <url><loc>https://example.com/a</loc></url>
    <url><loc> https://example.com/b </loc></url>
    <url><loc>not-a-url</loc></url>
  </urlset>`)
  assert.deepEqual(urlset, { locations: ['https://example.com/a', 'https://example.com/b'], isIndex: false })

  const index = parseSitemapLocs(`<sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap></sitemapindex>`)
  assert.equal(index.isIndex, true)
  assert.deepEqual(index.locations, ['https://example.com/sitemap-1.xml'])
})

test('extractTextFromHtml removes chrome and keeps readable blocks', () => {
  const { title, text } = extractTextFromHtml(`<html><head>
    <title>Hair Salon</title>
    <style>.x{color:red}</style>
    <script>alert('x')</script>
  </head><body>
    <nav><a href="/">Home</a></nav>
    <h1>Opening hours</h1>
    <p>Monday to Friday, 9am to 5pm.</p>
    <ul><li>Walk-ins welcome</li><li>Card payments</li></ul>
    <footer>© 2026</footer>
  </body></html>`)
  assert.equal(title, 'Hair Salon')
  assert.match(text, /Opening hours/)
  assert.match(text, /Monday to Friday, 9am to 5pm\./)
  assert.match(text, /Walk-ins welcome/)
  assert.doesNotMatch(text, /alert\('x'\)/)
  assert.doesNotMatch(text, /color:red/)
})

test('normalizeWhitespace trims, removes zero-width and collapses blank lines', () => {
  assert.equal(normalizeWhitespace('  a\t\tb  \n\n\n\n c \u200B'), 'a b\n\nc')
})

test('base64ToBuffer accepts data URLs and whitespace', () => {
  const raw = Buffer.from('hello').toString('base64')
  assert.equal(base64ToBuffer(`data:text/plain;base64,${raw}`).toString('utf8'), 'hello')
  assert.equal(base64ToBuffer(raw.split('').join(' ')).toString('utf8'), 'hello')
})

test('extractDocument handles pasted text and rejects unsupported binaries', async () => {
  const text = await extractDocument({ filename: 'cancellation-policy.txt', text: 'Free cancellation up to 24h before.' })
  assert.equal(text.title, 'cancellation policy')
  assert.equal(text.format, 'txt')
  assert.match(text.text, /Free cancellation/)

  const html = await extractDocument({
    filename: 'page.html',
    base64: Buffer.from('<html><head><title>FAQ</title></head><body><p>We open at nine.</p></body></html>').toString('base64'),
  })
  assert.equal(html.title, 'FAQ')
  assert.match(html.text, /We open at nine\./)

  await assert.rejects(
    () => extractDocument({ filename: 'photo.png', base64: Buffer.from('not an image').toString('base64') }),
    /Images cannot be imported as text/
  )
  await assert.rejects(
    () => extractDocument({ filename: 'old.doc', base64: Buffer.from('legacy').toString('base64') }),
    /Legacy \.doc files/
  )
  await assert.rejects(
    () => extractDocument({ filename: 'binary.bin', base64: Buffer.from([0, 1, 2, 3, 255, 254]).toString('base64') }),
    /Unsupported file type/
  )
})
