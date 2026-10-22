import dns from 'node:dns/promises'

/**
 * Shared SSRF guard for server-side outbound HTTP.
 *
 * Two layers:
 *  1. Literal-host check (localhost, loopback, RFC1918, link-local, ULA, etc.).
 *  2. DNS resolution of every address, rejecting any private result.
 *
 * This closes the common SSRF paths. It is not a substitute for network-level
 * egress policy because DNS can still rebind after this check (documented as
 * S10 in the security audit). Callers should not bypass it for user-provided
 * URLs unless the URL is inherently trusted.
 */

export function isPrivateIp(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true // unique local IPv6
    if (/^fe[89ab]/.test(h)) return true // link-local IPv6
    if (h.startsWith('::ffff:')) return isPrivateIp(h.slice('::ffff:'.length))
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
    if (a >= 224) return true // multicast / reserved
  }
  return false
}

export type OutboundUrlOptions = {
  /** Explicit opt-in for admin-configured endpoints on a trusted LAN. */
  allowPrivate?: boolean
  /** Label used in error messages (e.g. "Webhook URL"). */
  label?: string
}

/**
 * Cloud instance-metadata endpoints. These are blocked even when private
 * addresses are allowed: no legitimate self-hosted integration lives there, and
 * they hand out the cloud credentials of the host.
 */
const METADATA_IPS = ['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254']
const METADATA_HOSTS = ['metadata.google.internal', 'metadata.goog', 'instance-data']

export function isMetadataHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (METADATA_HOSTS.includes(h)) return true
  return METADATA_IPS.includes(h)
}

export async function assertOutboundUrl(raw: string, options: OutboundUrlOptions = {}): Promise<URL> {
  const label = options.label ?? 'URL'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http:// or https://`)
  }
  // Metadata endpoints are never reachable, not even with allowPrivate.
  if (isMetadataHost(url.hostname)) {
    throw new Error(`${label} points to a cloud metadata endpoint — this is blocked to prevent credential theft`)
  }
  if (options.allowPrivate) return url

  if (isPrivateIp(url.hostname)) {
    throw new Error(
      `${label} points to a private/local address. This is blocked to prevent SSRF; use a public endpoint or explicitly allow private addresses for this integration.`
    )
  }

  let addresses: Array<{ address: string }> = []
  try {
    addresses = await dns.lookup(url.hostname, { all: true })
  } catch {
    throw new Error(`Could not resolve the ${label.toLowerCase()} hostname (DNS lookup failed)`)
  }
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error(
      `${label} resolves to a private/local address. This is blocked to prevent SSRF; use a public endpoint or explicitly allow private addresses for this integration.`
    )
  }
  return url
}
