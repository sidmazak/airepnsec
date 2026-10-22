'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/lib/client/store'
import { api, type SessionInfo } from '@/lib/client/api'
import { AuthScreen } from '@/components/sections/auth-screen'
import { Sidebar, MobileTopBar, isSectionAllowed } from '@/components/sections/sidebar'
import { DashboardSection } from '@/components/sections/dashboard-section'
import { InboxSection } from '@/components/sections/inbox-section'
import { VoiceSection } from '@/components/sections/voice-section'
import RealtimeSection from '@/components/sections/realtime-section'
import { BookingsSection } from '@/components/sections/bookings-section'
import { CustomersSection } from '@/components/sections/customers-section'
import { InvoicesSection } from '@/components/sections/invoices-section'
import { LedgerSection } from '@/components/sections/ledger-section'
import { KnowledgeSection } from '@/components/sections/knowledge-section'
import { DataSourcesSection } from '@/components/sections/data-sources-section'
import { AutomationsSection } from '@/components/sections/automations-section'
import { AiSection } from '@/components/sections/ai-section'
import { BusinessSection } from '@/components/sections/business-section'
import { IntegrationsSection } from '@/components/sections/integrations-section'
import UsageSection from '@/components/sections/usage-section'
import { DiagnosticsSection } from '@/components/sections/diagnostics-section'
import { SecuritySection } from '@/components/sections/security-section'
import { SetupSection } from '@/components/sections/setup-section'
import { Loader2 } from 'lucide-react'
import { GuidedTour } from '@/components/guided-tour'

function SectionRouter() {
  const activeSection = useAppStore((s) => s.activeSection)
  switch (activeSection) {
    case 'dashboard': return <DashboardSection />
    case 'inbox': return <InboxSection />
    case 'voice': return <VoiceSection />
    case 'realtime': return <RealtimeSection />
    case 'bookings': return <BookingsSection />
    case 'customers': return <CustomersSection />
    case 'invoices': return <InvoicesSection />
    case 'ledger': return <LedgerSection />
    case 'knowledge': return <KnowledgeSection />
    case 'datasources': return <DataSourcesSection />
    case 'automations': return <AutomationsSection />
    case 'ai': return <AiSection />
    case 'business': return <BusinessSection />
    case 'integrations': return <IntegrationsSection />
    case 'usage': return <UsageSection />
    case 'diagnostics': return <DiagnosticsSection />
    case 'security': return <SecuritySection />
    case 'setup': return <SetupSection />
    default: return <DashboardSection />
  }
}

export default function Home() {
  const { session, sessionLoading, setSession, setSessionLoading, activeSection, setActiveSection } = useAppStore()

  useEffect(() => {
    let cancelled = false
    api.get<SessionInfo>('/api/session')
      .then((s) => { if (!cancelled) setSession(s) })
      .catch(() => { if (!cancelled) setSession({ authenticated: false }) })
      .finally(() => { if (!cancelled) setSessionLoading(false) })
    return () => { cancelled = true }
  }, [setSession, setSessionLoading])

  // Role gate: deep links to sections this role cannot use fall back to the dashboard.
  useEffect(() => {
    if (!session?.authenticated) return
    if (!isSectionAllowed(session.user?.role, activeSection)) setActiveSection('dashboard')
  }, [session, activeSection, setActiveSection])

  // hash-based deep links (#bookings) + keep hash in sync
  useEffect(() => {
    const applyHash = () => {
      const h = window.location.hash.replace('#', '')
      if (h) setActiveSection(h as never)
    }
    applyHash()
    window.addEventListener('hashchange', applyHash)
    return () => window.removeEventListener('hashchange', applyHash)
  }, [setActiveSection])

  useEffect(() => {
    if (typeof window !== 'undefined' && `#${activeSection}` !== window.location.hash) {
      window.history.replaceState(null, '', `#${activeSection}`)
    }
  }, [activeSection])

  if (sessionLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background" role="status" aria-live="polite">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">Loading your workspace…</p>
      </div>
    )
  }

  if (!session?.authenticated) {
    return <AuthScreen />
  }

  const needsSetup = session.org && !session.org.setupComplete

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <MobileTopBar />
      <div className="flex flex-1">
        <Sidebar />
        <main className="flex-1 min-w-0 flex flex-col px-4 sm:px-6 lg:px-8 py-6" aria-label="Main content">
          {session.org && session.org.receptionistStatus && session.org.receptionistStatus !== 'running' && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center gap-2" role="status">
              <span className="font-medium">AI receptionist {session.org.receptionistStatus}.</span>
              <span>
                {session.org.receptionistStatus === 'paused'
                  ? 'Inbound is recorded for staff, but the assistant does not reply.'
                  : 'The app is not answering SMS, WhatsApp, calls or web chat.'}
              </span>
              <button onClick={() => setActiveSection('dashboard')} className="underline font-medium hover:no-underline" aria-label="Open the dashboard to restart the receptionist">
                Change in dashboard
              </button>
            </div>
          )}

          {needsSetup && activeSection !== 'setup' && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 flex flex-wrap items-center gap-2">
              <span>Setup is not complete — the assistant, reminders, and readiness checks depend on it.</span>
              <button onClick={() => setActiveSection('setup')} className="underline font-medium hover:no-underline" aria-label="Open setup wizard">
                Continue setup
              </button>
            </div>
          )}
          <div className="flex-1">
            <SectionRouter />
          </div>
        </main>
      </div>
      <GuidedTour />
      <footer className="mt-auto border-t bg-muted/40 px-4 sm:px-6 lg:px-8 py-3 text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <span className="font-medium">AI Secretary</span>
        <span>Self-hosted · local-first</span>
        {session.org?.demo && <span className="rounded bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200 px-1.5 py-0.5 font-medium">Demo data</span>}
        {session.org && <span>Data mode: {session.org.dataMode.replace('_', '-')}</span>}
        <span className="ml-auto">Signed in as {session.user?.name} ({session.user?.role})</span>
      </footer>
    </div>
  )
}
