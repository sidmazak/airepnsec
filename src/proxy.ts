import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export default function proxy(req: NextRequest) {
  const res = NextResponse.next()
  // Security headers (defense-in-depth; no CSP configured to avoid breaking scripts)
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.headers.set('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=(self)')
  res.headers.set('X-DNS-Prefetch-Control', 'off')
  // Prevent sensitive pages caching at intermediate proxies
  if (req.nextUrl.pathname.startsWith('/api/') || req.nextUrl.pathname === '/') {
    res.headers.set('Cache-Control', 'no-store, must-revalidate')
  }
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map)).*)'],
}