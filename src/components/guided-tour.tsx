'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/lib/client/store'
import { Button } from '@/components/ui/button'
import { X, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

type TourStep = {
  id: string
  selector: string | null // CSS selector to highlight; null = center modal
  title: string
  body: string
  section?: string // section to navigate to
  placement?: 'right' | 'bottom' | 'center'
}

const STEPS: TourStep[] = [
  { id: 'welcome', selector: null, title: 'Welcome to AI Secretary', body: 'Your self-hosted AI receptionist and back office. This quick tour (30 seconds) shows you where everything lives. You can skip anytime and replay it from Settings → Diagnostics.', placement: 'center' },
  { id: 'dashboard', selector: '[data-tour="sidebar-dashboard"]', title: 'Dashboard', body: 'Your at-a-glance view: today\'s bookings, revenue, open conversations, and readiness checklist. Numbers are live from your data.', section: 'dashboard', placement: 'right' },
  { id: 'inbox', selector: '[data-tour="sidebar-inbox"]', title: 'Inbox', body: 'Every conversation (web, SMS, WhatsApp, phone) lands here. Toggle AI on/off per thread, reply as a human, or let the receptionist handle it.', section: 'inbox', placement: 'right' },
  { id: 'bookings', selector: '[data-tour="sidebar-bookings"]', title: 'Bookings', body: 'The real booking engine — transactional conflict checks, reschedule, cancel, no-show. The AI books through this exact engine, never around it.', section: 'bookings', placement: 'right' },
  { id: 'invoices', selector: '[data-tour="sidebar-invoices"]', title: 'Invoices & Payments', body: 'Create invoices, record verified payments (cash/card/transfer), issue refunds. Customer "I paid" claims are recorded as pending verification — never auto-settled.', section: 'invoices', placement: 'right' },
  { id: 'ledger', selector: '[data-tour="sidebar-ledger"]', title: 'Ledger', body: 'Append-only double-entry ledger. Corrections are reversal entries, never edits or deletes. Export to CSV anytime.', section: 'ledger', placement: 'right' },
  { id: 'knowledge', selector: '[data-tour="sidebar-knowledge"]', title: 'Knowledge & FAQs', body: 'Approved answers the receptionist uses to reply. Retrieval is local (embeddings or lexical) — your data never leaves the machine in local-only mode.', section: 'knowledge', placement: 'right' },
  { id: 'ai', selector: '[data-tour="sidebar-ai"]', title: 'AI Providers', body: 'Bring your own key: local Ollama, or any OpenAI-compatible endpoint. Embeddings work out of the box with the built-in local model. No proprietary SDK.', section: 'ai', placement: 'right' },
  { id: 'integrations', selector: '[data-tour="sidebar-integrations"]', title: 'Integrations', body: 'SMTP, Twilio SMS/WhatsApp/Voice, Stripe, CalDAV, webhooks — all BYOK, AES-256-GCM encrypted at rest, never returned after save.', section: 'integrations', placement: 'right' },
  { id: 'setup', selector: '[data-tour="sidebar-setup"]', title: 'Setup Wizard', body: 'Walks you from empty database to live in 8 steps. Autosaves progress. Re-open anytime to tweak business profile, hours, collections policy, or AI.', section: 'setup', placement: 'right' },
  { id: 'done', selector: null, title: 'You\'re ready', body: 'Start with the Setup Wizard if this is a fresh install, or jump straight into the Inbox. Replay this tour anytime from Diagnostics. Happy hosting!', placement: 'center' },
]

const STORAGE_KEY = 'ais_tour_done_v1'

export function GuidedTour() {
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const session = useAppStore((s) => s.session)
  const [open, setOpen] = useState(false)
  const [idx, setIdx] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    if (!session?.authenticated) return
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') return
    } catch { /* ignore */ }
    const t = setTimeout(() => setOpen(true), 600)
    return () => clearTimeout(t)
  }, [session?.authenticated])

  const step = STEPS[idx]

  const measure = useCallback(() => {
    if (!step?.selector) { setRect(null); return }
    const el = document.querySelector(step.selector) as HTMLElement | null
    if (!el) { setRect(null); return }
    // Scroll the nearest scrollable ancestor so the target is visible.
    el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' })
    // Measure after scroll settles.
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setRect(r)
      else setRect(null)
    })
  }, [step])

  useEffect(() => {
    if (!open) return
    if (step?.section) setActiveSection(step.section as never)
    // Allow the section + sidebar to render before measuring.
    const t1 = setTimeout(measure, 400)
    const t2 = setTimeout(measure, 900)
    window.addEventListener('resize', measure)
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener('resize', measure) }
  }, [open, idx, step, measure, setActiveSection])

  const finish = useCallback(() => {
    setOpen(false)
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* ignore */ }
  }, [])

  const next = () => {
    if (idx >= STEPS.length - 1) finish()
    else setIdx((i) => i + 1)
  }
  const prev = () => setIdx((i) => Math.max(0, i - 1))

  if (!open) return null

  const sidebarVisible = typeof document !== 'undefined' && !!document.querySelector('[data-tour="sidebar-dashboard"]')
  const isCenter = !step.selector || !rect || !sidebarVisible
  const tooltipStyle: React.CSSProperties = isCenter
    ? { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
    : (() => {
        const r = rect!
        const vw = window.innerWidth
        const vh = window.innerHeight
        const tw = 380
        const th = 260
        const M = 24 // safety margin from viewport edge
        // Prefer right of the target.
        let left = r.right + M
        if (left + tw + M > vw) {
          // Flip to the left of the target.
          left = r.left - tw - M
        }
        if (left < M) left = M
        if (left + tw + M > vw) {
          // Still doesn't fit (very narrow viewport): center horizontally.
          left = Math.max(M, (vw - tw) / 2)
        }
        // Vertically: center on target, clamped.
        let top = r.top + r.height / 2 - th / 2
        if (top + th + M > vh) top = vh - th - M
        if (top < M) top = M
        return { top, left, maxWidth: `calc(100vw - ${M * 2}px)` }
      })()

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Guided tour">
      {/* Dim overlay with spotlight cutout */}
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {rect && (
              <rect x={rect.left - 6} y={rect.top - 6} width={rect.width + 12} height={rect.height + 12} rx="8" fill="black" />
            )}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask="url(#tour-mask)" />
      </svg>

      {/* Highlight ring */}
      {rect && (
        <div
          className="absolute rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background pointer-events-none transition-all"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
          aria-hidden
        />
      )}

      {/* Tooltip */}
      <div
        className={cn(
          'absolute w-[min(92vw,380px)] rounded-xl border bg-popover text-popover-foreground shadow-2xl p-5 space-y-3',
          isCenter && 'text-center'
        )}
        style={tooltipStyle}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary shrink-0" aria-hidden />
            <h3 className="font-semibold text-sm">{step.title}</h3>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 -mt-1 -mr-1" aria-label="Skip tour" title="Skip tour" onClick={finish}>
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{step.body}</p>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-muted-foreground">{idx + 1} / {STEPS.length}</span>
          <div className="flex gap-2">
            {idx > 0 && (
              <Button variant="outline" size="sm" className="min-h-[36px]" onClick={prev}>
                <ChevronLeft className="h-4 w-4" aria-hidden /> Back
              </Button>
            )}
            <Button size="sm" className="min-h-[36px]" onClick={next}>
              {idx === STEPS.length - 1 ? 'Finish' : 'Next'} <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
        <div className="flex gap-1 pt-1" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s.id} className={cn('h-1 flex-1 rounded-full transition-colors', i === idx ? 'bg-primary' : i < idx ? 'bg-primary/40' : 'bg-muted')} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function useResetTour() {
  return useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    window.location.reload()
  }, [])
}
