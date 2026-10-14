'use client'

import { useAppStore, type SectionId } from '@/lib/client/store'
import { api } from '@/lib/client/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  LayoutDashboard, Inbox, CalendarDays, Users, Receipt, BookOpen, BookMarked,
  Workflow, Bot, Store, Activity, LogOut, Menu, Bot as Logo, Plug, X,
} from 'lucide-react'

const NAV: Array<{ id: SectionId; label: string; icon: typeof LayoutDashboard; group: string }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview' },
  { id: 'inbox', label: 'Inbox', icon: Inbox, group: 'Conversations' },
  { id: 'bookings', label: 'Bookings', icon: CalendarDays, group: 'Operations' },
  { id: 'customers', label: 'Customers', icon: Users, group: 'Operations' },
  { id: 'invoices', label: 'Invoices & Payments', icon: Receipt, group: 'Money' },
  { id: 'ledger', label: 'Ledger', icon: BookOpen, group: 'Money' },
  { id: 'knowledge', label: 'Knowledge & FAQs', icon: BookMarked, group: 'AI' },
  { id: 'automations', label: 'Automations', icon: Workflow, group: 'AI' },
  { id: 'ai', label: 'AI Providers', icon: Bot, group: 'Settings' },
  { id: 'business', label: 'Business Profile', icon: Store, group: 'Settings' },
  { id: 'integrations', label: 'Integrations', icon: Plug, group: 'Settings' },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity, group: 'Settings' },
  { id: 'setup', label: 'Setup Wizard', icon: Menu, group: 'Settings' },
]

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
      <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setMobileNavOpen(true)}>
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

  const navList = (
    <nav className="space-y-4" aria-label="Primary">
      {[...new Set(NAV.map((n) => n.group))].map((group) => (
        <div key={group}>
          <p className="px-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
          <ul className="space-y-0.5">
            {NAV.filter((n) => n.group === group).map((item) => (
              <li key={item.id}>
                <button
                  onClick={() => setActiveSection(item.id)}
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
      <Button variant="ghost" size="icon" className="ml-auto" aria-label="Close menu" onClick={() => setMobileNavOpen(false)}>
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
      <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r bg-muted/30 px-3 py-4 sticky top-0 h-screen overflow-y-auto" aria-label="Sidebar">
        <div className="flex items-center gap-2 px-2 py-1">
          <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shrink-0" aria-hidden>
            <Logo className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">AI Secretary</p>
            <p className="text-[11px] text-muted-foreground truncate">{session?.org?.name ?? 'Workspace'}</p>
          </div>
        </div>
        <div className="flex-1 mt-4">{navList}</div>
        {logoutBtn}
      </aside>
    </>
  )
}
