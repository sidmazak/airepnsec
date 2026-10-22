import { centsToDecimal } from '@/lib/money'

/**
 * Email templates for invoice delivery and booking confirmations.
 * Pure functions — every dynamic value is substituted here (no client-side
 * templating), so what lands in the outbox is final content.
 */

export type InvoiceEmailInput = {
  invoice: {
    number: string
    currency: string
    subtotalCents: number
    taxCents: number
    totalCents: number
    paidCents: number
    dueDate: Date
    issueDate: Date
    notes?: string
  }
  items: Array<{ description: string; qty: number; unitPriceCents: number; totalCents: number }>
  customer: { name: string }
  org: { name: string; email?: string; phone?: string }
  paymentLink?: string
}

export type RenderedEmail = { subject: string; html: string; text: string }

function formatMoney(cents: number, currency: string): string {
  // Integer cents -> exact decimal string (no float division of the amount).
  const decimal = centsToDecimal(cents)
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(decimal))
  } catch {
    return `${decimal} ${currency}`
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function footer(org: InvoiceEmailInput['org']): string {
  const contact = [org.email, org.phone].filter((v): v is string => Boolean(v)).map(esc).join(' · ')
  return `<p style="margin:16px 0 0;color:#6b7280;font-size:12px">— ${esc(org.name)}${contact ? `<br>${contact}` : ''}<br>Sent by AI Secretary (self-hosted)</p>`
}

/** Professional invoice email: line-item table, totals, due date, optional pay button. */
export function renderInvoiceEmail(input: InvoiceEmailInput): RenderedEmail {
  const { invoice, items, customer, org, paymentLink } = input
  const currency = invoice.currency || 'USD'
  const money = (c: number) => formatMoney(c, currency)

  const rows = items
    .map(
      (item) => `<tr>
  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${esc(item.description)}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center">${item.qty}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${money(item.unitPriceCents)}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${money(item.totalCents)}</td>
</tr>`
    )
    .join('\n')

  const payButton = paymentLink
    ? `<p style="margin:24px 0"><a href="${esc(paymentLink)}" style="display:inline-block;background:#0f172a;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Pay now — ${money(Math.max(0, invoice.totalCents - invoice.paidCents))}</a></p>`
    : ''

  const subject = `Invoice ${invoice.number} from ${org.name} — ${money(invoice.totalCents)}`

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#111827">
  <h2 style="margin:0 0 4px;font-size:20px">Invoice ${esc(invoice.number)}</h2>
  <p style="margin:0 0 20px;color:#6b7280;font-size:14px">Issued ${formatDate(invoice.issueDate)} · Due ${formatDate(invoice.dueDate)}</p>
  <p style="margin:0 0 20px;font-size:14px">Hi ${esc(customer.name)}, here is your invoice from <strong>${esc(org.name)}</strong>.</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead>
      <tr style="background:#f9fafb;text-align:left">
        <th style="padding:8px 12px">Description</th>
        <th style="padding:8px 12px;text-align:center">Qty</th>
        <th style="padding:8px 12px;text-align:right">Unit</th>
        <th style="padding:8px 12px;text-align:right">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr><td colspan="3" style="padding:8px 12px;text-align:right;color:#6b7280">Subtotal</td><td style="padding:8px 12px;text-align:right">${money(invoice.subtotalCents)}</td></tr>
      <tr><td colspan="3" style="padding:8px 12px;text-align:right;color:#6b7280">Tax</td><td style="padding:8px 12px;text-align:right">${money(invoice.taxCents)}</td></tr>
      <tr><td colspan="3" style="padding:8px 12px;text-align:right;font-weight:700">Total</td><td style="padding:8px 12px;text-align:right;font-weight:700">${money(invoice.totalCents)}</td></tr>${
        invoice.paidCents > 0
          ? `<tr><td colspan="3" style="padding:8px 12px;text-align:right;color:#6b7280">Paid</td><td style="padding:8px 12px;text-align:right;color:#059669">−${money(invoice.paidCents)}</td></tr>
      <tr><td colspan="3" style="padding:8px 12px;text-align:right;font-weight:700">Balance due</td><td style="padding:8px 12px;text-align:right;font-weight:700">${money(Math.max(0, invoice.totalCents - invoice.paidCents))}</td></tr>`
          : ''
      }
    </tfoot>
  </table>
  ${payButton}${invoice.notes ? `<p style="margin:20px 0 0;font-size:13px;color:#374151">${esc(invoice.notes)}</p>` : ''}
  ${footer(org)}
</div>`

  const lines = [
    `Invoice ${invoice.number}`,
    `Issued ${formatDate(invoice.issueDate)} · Due ${formatDate(invoice.dueDate)}`,
    `Hi ${customer.name}, here is your invoice from ${org.name}.`,
    '',
    ...items.map((i) => `- ${i.description} × ${i.qty} @ ${money(i.unitPriceCents)} = ${money(i.totalCents)}`),
    `Subtotal: ${money(invoice.subtotalCents)}`,
    `Tax: ${money(invoice.taxCents)}`,
    `Total: ${money(invoice.totalCents)}`,
    ...(invoice.paidCents > 0
      ? [`Paid: ${money(invoice.paidCents)}`, `Balance due: ${money(Math.max(0, invoice.totalCents - invoice.paidCents))}`]
      : []),
    ...(paymentLink ? ['', `Pay online: ${paymentLink}`] : []),
    ...(invoice.notes ? ['', invoice.notes] : []),
    '',
    `— ${org.name}${org.email ? ` (${org.email})` : ''}`,
    'Sent by AI Secretary (self-hosted)',
  ]

  return { subject, html, text: lines.join('\n') }
}

export type BookingEmailInput = {
  booking: { startAt: Date; endAt: Date; status: string; notes?: string }
  service: { name: string; priceCents?: number; currency?: string }
  customer: { name: string }
  org: { name: string; email?: string; phone?: string }
  icsPath: string
}

/** Booking confirmation email with when/what + the .ics download path. */
export function renderBookingEmail(input: BookingEmailInput): RenderedEmail {
  const { booking, service, customer, org, icsPath } = input
  const fmt = (d: Date) =>
    d.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })

  const price = service.priceCents && service.currency ? formatMoney(service.priceCents, service.currency) : ''
  const subject = `Your ${service.name} appointment — ${org.name}`

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#111827">
  <h2 style="margin:0 0 16px;font-size:20px">You're booked, ${esc(customer.name)}!</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">What</td><td style="padding:6px 0"><strong>${esc(service.name)}</strong>${price ? ` — ${esc(price)}` : ''}</td></tr>
    <tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">When</td><td style="padding:6px 0">${esc(fmt(booking.startAt))} → ${esc(fmt(booking.endAt))}</td></tr>
    <tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">Status</td><td style="padding:6px 0">${esc(booking.status)}</td></tr>${
      booking.notes ? `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top">Notes</td><td style="padding:6px 0">${esc(booking.notes)}</td></tr>` : ''
    }
  </table>
  <p style="margin:20px 0 0;font-size:14px">A calendar file (.ics) for this appointment is available at: <strong>${esc(icsPath)}</strong> — add it to your calendar so you don't miss it.</p>
  ${footer(org)}
</div>`

  const lines = [
    `You're booked, ${customer.name}!`,
    '',
    `What: ${service.name}${price ? ` — ${price}` : ''}`,
    `When: ${fmt(booking.startAt)} → ${fmt(booking.endAt)}`,
    `Status: ${booking.status}`,
    ...(booking.notes ? [`Notes: ${booking.notes}`] : []),
    '',
    `A calendar file (.ics) for this appointment is available at: ${icsPath}`,
    '',
    `— ${org.name}${org.email ? ` (${org.email})` : ''}`,
    'Sent by AI Secretary (self-hosted)',
  ]

  return { subject, html, text: lines.join('\n') }
}
