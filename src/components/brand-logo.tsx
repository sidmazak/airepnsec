import { cn } from '@/lib/utils'

/**
 * Self-contained brand marks for third-party services. Inline SVG only: no
 * external image requests, no CDN dependency, no tracking pixels. Each mark is a
 * rounded tile with the service's brand colour and a recognizable glyph; the
 * adjacent UI always carries the text label, so the SVG is decorative.
 */

export type BrandId =
  | 'smtp' | 'imap' | 'email' | 'sendgrid' | 'mailgun' | 'postmark' | 'resend' | 'brevo'
  | 'twilio' | 'whatsapp' | 'telegram' | 'slack'
  | 'stripe' | 'square' | 'paypal' | 'razorpay'
  | 'google' | 'microsoft' | 'quickbooks' | 'xero' | 'myob'
  | 'shopify' | 'woocommerce' | 'wix' | 'mailchimp'
  | 'caldav' | 'webhook' | 'zapier' | 'make'
  | 'textbee' | 'httpsms' | 'android_sms_gateway' | 'telnyx' | 'vonage' | 'messagebird' | 'plivo' | 'generic_http'
  | 'ollama' | 'openai' | 'openai_compatible' | 'anthropic' | 'gemini' | 'azure' | 'local' | 'browser'
  | 'generic'

type Brand = {
  label: string
  bg: string
  fg: string
  text?: string
  fontSize?: number
  glyph?: 'microsoft' | 'whatsapp' | 'twilio' | 'sendgrid' | 'shopify' | 'razorpay' | 'paypal' | 'slack' | 'telegram' | 'gemini' | 'chip' | 'globe' | 'envelope' | 'hook' | 'square' | 'zapier'
}

const BRANDS: Record<BrandId, Brand> = {
  smtp: { label: 'SMTP', bg: '#475569', fg: '#ffffff', glyph: 'envelope' },
  imap: { label: 'IMAP', bg: '#0f766e', fg: '#ffffff', glyph: 'envelope' },
  email: { label: 'Email', bg: '#475569', fg: '#ffffff', glyph: 'envelope' },
  sendgrid: { label: 'SendGrid', bg: '#1a82e2', fg: '#ffffff', glyph: 'sendgrid' },
  mailgun: { label: 'Mailgun', bg: '#e8462b', fg: '#ffffff', glyph: 'envelope' },
  postmark: { label: 'Postmark', bg: '#ffcc00', fg: '#1f2937', text: 'P' },
  resend: { label: 'Resend', bg: '#111827', fg: '#ffffff', text: 'R' },
  brevo: { label: 'Brevo', bg: '#0b996e', fg: '#ffffff', text: 'B' },
  twilio: { label: 'Twilio', bg: '#f22f46', fg: '#ffffff', glyph: 'twilio' },
  whatsapp: { label: 'WhatsApp', bg: '#25d366', fg: '#ffffff', glyph: 'whatsapp' },
  telegram: { label: 'Telegram', bg: '#26a5e4', fg: '#ffffff', glyph: 'telegram' },
  slack: { label: 'Slack', bg: '#4a154b', fg: '#ffffff', glyph: 'slack' },
  stripe: { label: 'Stripe', bg: '#635bff', fg: '#ffffff', text: 'S', fontSize: 26 },
  square: { label: 'Square', bg: '#111111', fg: '#ffffff', glyph: 'square' },
  paypal: { label: 'PayPal', bg: '#003087', fg: '#ffffff', glyph: 'paypal' },
  razorpay: { label: 'Razorpay', bg: '#0c2451', fg: '#3395ff', glyph: 'razorpay' },
  google: { label: 'Google', bg: '#ffffff', fg: '#4285f4', text: 'G', fontSize: 27 },
  microsoft: { label: 'Microsoft', bg: '#ffffff', fg: '#ffffff', glyph: 'microsoft' },
  quickbooks: { label: 'QuickBooks', bg: '#2ca01c', fg: '#ffffff', text: 'qb', fontSize: 19 },
  xero: { label: 'Xero', bg: '#13b5ea', fg: '#ffffff', text: 'X', fontSize: 26 },
  myob: { label: 'MYOB', bg: '#6b2c91', fg: '#ffffff', text: 'MYOB', fontSize: 10 },
  shopify: { label: 'Shopify', bg: '#95bf47', fg: '#ffffff', glyph: 'shopify' },
  woocommerce: { label: 'WooCommerce', bg: '#7f54b3', fg: '#ffffff', text: 'W', fontSize: 26 },
  wix: { label: 'Wix', bg: '#111111', fg: '#ffffff', text: 'WIX', fontSize: 13 },
  mailchimp: { label: 'Mailchimp', bg: '#ffe01b', fg: '#241c15', text: 'MC', fontSize: 16 },
  caldav: { label: 'CalDAV', bg: '#0f766e', fg: '#ffffff', text: '31', fontSize: 17 },
  webhook: { label: 'Webhook', bg: '#475569', fg: '#ffffff', glyph: 'hook' },
  zapier: { label: 'Zapier', bg: '#ff4a00', fg: '#ffffff', glyph: 'zapier' },
  make: { label: 'Make', bg: '#6d00cc', fg: '#ffffff', text: 'M', fontSize: 26 },
  textbee: { label: 'TextBee', bg: '#f59e0b', fg: '#ffffff', text: 'TB', fontSize: 16 },
  httpsms: { label: 'httpSMS', bg: '#0ea5e9', fg: '#ffffff', text: 'SMS', fontSize: 12 },
  android_sms_gateway: { label: 'Android SMS Gateway', bg: '#3ddc84', fg: '#073b1e', text: 'AS', fontSize: 16 },
  telnyx: { label: 'Telnyx', bg: '#00c2a8', fg: '#ffffff', text: 'T', fontSize: 25 },
  vonage: { label: 'Vonage', bg: '#111111', fg: '#ffffff', text: 'V', fontSize: 25 },
  messagebird: { label: 'MessageBird', bg: '#2481d7', fg: '#ffffff', text: 'MB', fontSize: 16 },
  plivo: { label: 'Plivo', bg: '#f04a23', fg: '#ffffff', text: 'P', fontSize: 25 },
  generic_http: { label: 'Generic HTTP', bg: '#64748b', fg: '#ffffff', glyph: 'globe' },
  ollama: { label: 'Ollama', bg: '#111111', fg: '#ffffff', text: 'O', fontSize: 25 },
  openai: { label: 'OpenAI', bg: '#111111', fg: '#ffffff', text: '◎', fontSize: 24 },
  openai_compatible: { label: 'OpenAI-compatible', bg: '#111111', fg: '#ffffff', text: 'API', fontSize: 13 },
  anthropic: { label: 'Anthropic', bg: '#d97757', fg: '#ffffff', text: 'A', fontSize: 25 },
  gemini: { label: 'Google Gemini', bg: '#ffffff', fg: '#4285f4', glyph: 'gemini' },
  azure: { label: 'Azure OpenAI', bg: '#0078d4', fg: '#ffffff', text: 'A', fontSize: 25 },
  local: { label: 'Local model', bg: '#059669', fg: '#ffffff', glyph: 'chip' },
  browser: { label: 'Browser', bg: '#0ea5e9', fg: '#ffffff', glyph: 'globe' },
  generic: { label: 'Service', bg: '#64748b', fg: '#ffffff', glyph: 'globe' },
}

function Glyph({ glyph, fg }: { glyph: NonNullable<Brand['glyph']>; fg: string }) {
  switch (glyph) {
    case 'microsoft':
      return (
        <>
          <rect x="10" y="10" width="12.5" height="12.5" rx="1" fill="#f25022" />
          <rect x="25.5" y="10" width="12.5" height="12.5" rx="1" fill="#7fba00" />
          <rect x="10" y="25.5" width="12.5" height="12.5" rx="1" fill="#00a4ef" />
          <rect x="25.5" y="25.5" width="12.5" height="12.5" rx="1" fill="#ffb900" />
        </>
      )
    case 'whatsapp':
      return (
        <>
          <path d="M15 12.5h18a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H22l-6 5v-5h-1a4 4 0 0 1-4-4v-12a4 4 0 0 1 4-4Z" fill={fg} />
          <path d="M24 17c-3.6 0-6.5 2.7-6.5 6.1 0 1.3.4 2.5 1.2 3.5l-.8 2.6 2.8-.8c.9.5 2 .8 3.3.8 3.6 0 6.5-2.7 6.5-6.1S27.6 17 24 17Zm3.7 8.4c-.2.5-1 1-1.4 1.1-.4.1-.9.1-1.5-.1-.4-.1-1.2-.4-2.2-1.3-.9-.9-1.5-1.9-1.7-2.3-.2-.4-.2-.8 0-1.1.1-.2.3-.5.5-.6.2-.2.3-.2.5-.2h.4c.1 0 .3 0 .4.3l.6 1.4c.1.2.1.3 0 .5l-.3.4c-.1.2-.2.3-.1.5.1.2.5.8 1.1 1.3.7.6 1.2.8 1.4.9.2.1.3.1.5-.1l.6-.7c.2-.2.3-.2.5-.1l1.4.7c.2.1.3.2.3.3.1.2.1.5 0 .9Z" fill="#25d366" />
        </>
      )
    case 'twilio':
      return (
        <>
          <circle cx="24" cy="24" r="13" fill={fg} />
          <circle cx="20" cy="20" r="2.6" fill="#f22f46" />
          <circle cx="28" cy="20" r="2.6" fill="#f22f46" />
          <circle cx="20" cy="28" r="2.6" fill="#f22f46" />
          <circle cx="28" cy="28" r="2.6" fill="#f22f46" />
        </>
      )
    case 'sendgrid':
      return (
        <>
          <path d="M12 26 36 12 26 36l-3-9-11-1Z" fill={fg} />
          <path d="M23 27l13-15" stroke="#1a82e2" strokeWidth="2" strokeLinecap="round" />
        </>
      )
    case 'shopify':
      return (
        <>
          <path d="M16 16l2.5-4.5c1-1.7 3.6-1.4 4.2.5l.6 2.2" stroke={fg} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <path d="M14 17h20l-1.8 18H15.8L14 17Z" fill={fg} />
          <path d="M21 22c.6 4.5 2.2 7 3 7s2.4-2.5 3-7" stroke="#95bf47" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      )
    case 'razorpay':
      return <path d="M29 10 16 27h8l-3 11 14-18h-9l3-10Z" fill={fg} />
    case 'paypal':
      return (
        <>
          <path d="M17 11h10c4 0 6 2.2 5.3 5.7-.8 4-3.6 6.1-7.7 6.1h-4.2l-1.6 8.2H12L17 11Z" fill={fg} />
          <path d="M22.5 18h6.2c3 0 4.5 1.6 4 4.2-.6 3-2.8 4.6-6 4.6h-3l-1.2 6.2h-6.1L22.5 18Z" fill="#009cde" opacity=".9" />
        </>
      )
    case 'slack':
      return (
        <>
          <rect x="20" y="10" width="5" height="14" rx="2.5" fill="#36c5f0" />
          <rect x="24" y="20" width="14" height="5" rx="2.5" fill="#2eb67d" />
          <rect x="23" y="24" width="5" height="14" rx="2.5" fill="#ecb22e" />
          <rect x="10" y="23" width="14" height="5" rx="2.5" fill="#e01e5a" />
        </>
      )
    case 'telegram':
      return <path d="M11 23.5 37 13l-6 22-7.5-6.5-3.5 4v-6L33 16l-16 9-6-.5Z" fill={fg} />
    case 'gemini':
      return <path d="M24 9c1.4 6.8 5.2 10.6 12 12-6.8 1.4-10.6 5.2-12 12-1.4-6.8-5.2-10.6-12-12 6.8-1.4 10.6-5.2 12-12Z" fill="#4285f4" />
    case 'chip':
      return (
        <>
          <rect x="15" y="15" width="18" height="18" rx="3" fill="none" stroke={fg} strokeWidth="2.5" />
          <rect x="20" y="20" width="8" height="8" rx="1.5" fill={fg} />
          <path d="M19 11v4M24 11v4M29 11v4M19 33v4M24 33v4M29 33v4M11 19h4M11 24h4M11 29h4M33 19h4M33 24h4M33 29h4" stroke={fg} strokeWidth="2" strokeLinecap="round" />
        </>
      )
    case 'globe':
      return (
        <>
          <circle cx="24" cy="24" r="12" fill="none" stroke={fg} strokeWidth="2.5" />
          <path d="M12 24h24M24 12c3.5 3.4 5.3 7.4 5.3 12S27.5 32.6 24 36c-3.5-3.4-5.3-7.4-5.3-12S20.5 15.4 24 12Z" fill="none" stroke={fg} strokeWidth="2" />
        </>
      )
    case 'envelope':
      return (
        <>
          <rect x="10" y="15" width="28" height="20" rx="3" fill="none" stroke={fg} strokeWidth="2.5" />
          <path d="m11 17 13 10 13-10" fill="none" stroke={fg} strokeWidth="2.5" strokeLinejoin="round" />
        </>
      )
    case 'hook':
      return (
        <>
          <path d="M28 12a7 7 0 0 0-7 7v4h-6a5 5 0 1 0 5 5v-3" fill="none" stroke={fg} strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="28" cy="12" r="2.6" fill={fg} />
          <circle cx="20" cy="33" r="2.6" fill={fg} />
        </>
      )
    case 'square':
      return (
        <>
          <rect x="14" y="14" width="20" height="20" rx="3" fill="none" stroke={fg} strokeWidth="3" />
          <rect x="21" y="21" width="6" height="6" rx="1" fill={fg} />
        </>
      )
    case 'zapier':
      return <path d="M24 10v28M10 24h28M14 14l20 20M34 14 14 34" stroke={fg} strokeWidth="3" strokeLinecap="round" />
    default:
      return null
  }
}

export function BrandLogo({
  id,
  size = 40,
  className,
  label,
}: {
  id: string
  size?: number
  className?: string
  label?: string
}) {
  const brand = BRANDS[id as BrandId] ?? BRANDS.generic
  const hasGlyph = Boolean(brand.glyph)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={cn('shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <rect x="0.5" y="0.5" width="47" height="47" rx="11" fill={brand.bg} stroke="rgba(0,0,0,0.08)" />
      {hasGlyph ? (
        <Glyph glyph={brand.glyph!} fg={brand.fg} />
      ) : (
        <text
          x="24"
          y="24"
          textAnchor="middle"
          dominantBaseline="central"
          fill={brand.fg}
          fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
          fontWeight="800"
          fontSize={brand.fontSize ?? 20}
          letterSpacing={brand.text && brand.text.length > 2 ? '0.5' : '0'}
        >
          {brand.text ?? brand.label.slice(0, 1)}
        </text>
      )}
    </svg>
  )
}

/** Map an AI provider id to a brand mark. */
export function aiBrandId(provider: string): BrandId {
  switch (provider) {
    case 'ollama': return 'ollama'
    case 'openai_compatible': return 'openai_compatible'
    case 'anthropic': return 'anthropic'
    case 'google': return 'gemini'
    case 'azure_openai': return 'azure'
    case 'local_speech':
    case 'local_neural':
    case 'local_lexical': return 'local'
    case 'browser': return 'browser'
    default: return 'openai'
  }
}
