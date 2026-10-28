'use client'

import { useAppStore, type SectionId } from '@/lib/client/store'
import { api } from '@/lib/client/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  LayoutDashboard, Inbox, CalendarDays, Users, Receipt, BookOpen, BookMarked,
  Workflow, Bot, Store, Activity, LogOut, Menu, Bot as Logo, Plug, X, Mic, Database, BarChart3, Wifi, ShieldCheck, UserCog,
} from 'lucide-react'

const STAFF: string[] = ['owner', 'admin', 'agent']
const ADMINS: string[] = ['owner', 'admin']

const NAV: Array<{ id: SectionId; label: string; description: string; icon: typeof LayoutDashboard; group: string; roles?: string[] }> = [
  { id: 'dashboard', label: 'Dashboard', description: "Today's bookings, outstanding balance and receptionist status at a glance.", icon: LayoutDashboard, group: 'Overview' },
  { id: 'inbox', label: 'Inbox', description: 'Every web, SMS, WhatsApp and phone conversation in one place.', icon: Inbox, group: 'Conversations', roles: STAFF },
  { id: 'voice', label: 'Voice Console', description: 'Test the AI receptionist by speaking, and hear its reply.', icon: Mic, group: 'Conversations', roles: STAFF },
  { id: 'realtime', label: 'Realtime Voice', description: 'Low-latency voice test that uses the same receptionist tools and data.', icon: Wifi, group: 'Conversations', roles: ADMINS },
  { id: 'bookings', label: 'Bookings', description: 'Calendar, availability and the booking engine that prevents double-booking.', icon: CalendarDays, group: 'Operations', roles: STAFF },
  { id: 'customers', label: 'Customers', description: 'Contacts, consent, tags and per-customer channel preferences.', icon: Users, group: 'Operations', roles: STAFF },
  { id: 'invoices', label: 'Invoices & Payments', description: 'Draft, issue, send and collect invoices. Payments post to the ledger.', icon: Receipt, group: 'Money', roles: STAFF },
  { id: 'ledger', label: 'Ledger', description: 'Append-only double-entry ledger with reversals and a full audit trail.', icon: BookOpen, group: 'Money', roles: ADMINS },
  { id: 'usage', label: 'Usage & Billing', description: 'AI token usage, latency and estimated cost by provider and model.', icon: BarChart3, group: 'Money', roles: ADMINS },
  { id: 'knowledge', label: 'Knowledge & FAQs', description: 'Approved documents and answers the receptionist is allowed to use.', icon: BookMarked, group: 'AI', roles: ADMINS },
  { id: 'datasources', label: 'Data Sources', description: 'Ingest your own read-only database or JSON API into retrieval.', icon: Database, group: 'AI', roles: ADMINS },
  { id: 'automations', label: 'Automations', description: 'Rules that react to booking, invoice and message events.', icon: Workflow, group: 'AI', roles: ADMINS },
  { id: 'ai', label: 'AI Providers', description: 'Choose BYOK providers per capability and enforce local-only data mode.', icon: Bot, group: 'Settings', roles: ADMINS },
  { id: 'security', label: 'Security', description: 'Password, two-factor authentication and session protection.', icon: ShieldCheck, group: 'Settings' },
  { id: 'business', label: 'Business Profile', description: 'Identity, hours, services, policies and AI voice settings.', icon: Store, group: 'Settings', roles: ADMINS },
  { id: 'integrations', label: 'Integrations', description: 'BYOK email, SMS, WhatsApp, payments, calendars and webhooks.', icon: Plug, group: 'Settings', roles: ADMINS },
  { id: 'diagnostics', label: 'Diagnostics', description: 'Live infrastructure checks, backups, logs and channel readiness.', icon: Activity, group: 'Settings', roles: ADMINS },
  { id: 'team', label: 'Team', description: 'Staff accounts, roles, invitations, SSO and SCIM.', icon: UserCog, group: 'Settings', roles: ADMINS },
  { id: 'setup', label: 'Setup Wizard', description: 'Guided checklist from an empty database to a live receptionist.', icon: Menu, group: 'Settings', roles: ADMINS },
]

/** Section visibility by role — mirrors the server-side route role gates. */
export function isSectionAllowed(role: string | undefined, id: string): boolean {
  const item = NAV.find((n) => n.id === id)
  if (!item) return false
  if (!item.roles) return true
  return role ? item.roles.includes(role) : false
}

function useLogout() {
  const setSession = useAppStore((s) => s.setSession)
  return async () => {
    try {
      await api.post('/api/auth/logout')
    } finally {
      setSession(null)
      useAppStore.getState().setActiveSection('dashboard')
    }
  }
}

/** Mobile top bar — rendered in normal flow ABOVE the content row (page.tsx). */
export function MobileTopBar() {
  const setMobileNavOpen = useAppStore((s) => s.setMobileNavOpen)
  const session = useAppStore((s) => s.session)
  return (
    <div className="lg:hidden flex items-center gap-2 px-2 py-2 border-b bg-background sticky top-0 z-30">
      <Button variant="ghost" size="icon" aria-label="Open menu" title="Open menu" onClick={() => setMobileNavOpen(true)}>
        <Menu className="h-5 w-5" aria-hidden />
      </Button>
      <span className="font-semibold text-sm">AI Secretary</span>
      {session?.org?.demo && <span className="ml-auto rounded bg-amber-100 text-amber-900 px-1.5 py-0.5 text-[11px] font-medium">Demo</span>}
    </div>
  )
}

export function Sidebar() {
  const activeSection = useAppStore((s) => s.activeSection)
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const session = useAppStore((s) => s.session)
  const mobileNavOpen = useAppStore((s) => s.mobileNavOpen)
  const setMobileNavOpen = useAppStore((s) => s.setMobileNavOpen)
  const isMobile = useIsMobile()
  const logout = useLogout()

  const role = session?.user?.role
  const visibleNav = NAV.filter((n) => !n.roles || (role ? n.roles.includes(role) : false))

  const navList = (
    <nav className="space-y-4" aria-label="Primary">
      {[...new Set(visibleNav.map((n) => n.group))].map((group) => (
        <div key={group}>
          <p className="px-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
          <ul className="space-y-0.5">
            {visibleNav.filter((n) => n.group === group).map((item) => (
              <li key={item.id}>
                <button
                  onClick={() => setActiveSection(item.id)}
                  data-tour={`sidebar-${item.id}`}
                  title={item.description}
                  aria-current={activeSection === item.id ? 'page' : undefined}
                  className={cn(
                    'w-full flex items-center gap-2.5 rounded-md px-2 py-2 text-sm min-h-[44px] transition-colors',
                    activeSection === item.id
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )

  const header = (
    <div className="flex items-center gap-2 px-2 py-1">
      <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shrink-0" aria-hidden>
        <Logo className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold truncate">AI Secretary</p>
        <p className="text-[11px] text-muted-foreground truncate">{session?.org?.name ?? 'Workspace'}</p>
      </div>
      <Button variant="ghost" size="icon" className="ml-auto" aria-label="Close menu" title="Close menu" onClick={() => setMobileNavOpen(false)}>
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  )

  const logoutBtn = (
    <div className="pt-2 border-t">
      <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground min-h-[44px]" onClick={logout}>
        <LogOut className="h-4 w-4" aria-hidden />
        Sign out
      </Button>
    </div>
  )

  return (
    <>
      {isMobile && mobileNavOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNavOpen(false)} aria-hidden />
          <div className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-background border-r p-3 flex flex-col overflow-y-auto">
            {header}
            <div className="flex-1 mt-3">{navList}</div>
            {logoutBtn}
          </div>
        </div>
      )}
      <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r bg-muted/30 px-3 py-4 sticky top-0 h-screen" aria-label="Sidebar">
        <div className="shrink-0 flex items-center gap-2 px-2 py-1">
          <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shrink-0" aria-hidden>
            <Logo className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">AI Secretary</p>
            <p className="text-[11px] text-muted-foreground truncate">{session?.org?.name ?? 'Workspace'}</p>
          </div>
        </div>
        <div className="flex-1 mt-4 overflow-y-auto min-h-0">{navList}</div>
        <div className="shrink-0 pt-2">{logoutBtn}</div>
      </aside>
    </>
  )
}
