'use client'

import { create } from 'zustand'
import type { SessionInfo } from '@/lib/client/api'

export type SectionId =
  | 'dashboard' | 'inbox' | 'voice' | 'bookings' | 'customers' | 'invoices'
  | 'ledger' | 'knowledge' | 'datasources' | 'automations' | 'ai' | 'business' | 'integrations' | 'diagnostics' | 'usage' | 'realtime' | 'security' | 'setup' | 'team'

type AppState = {
  activeSection: SectionId
  session: SessionInfo | null
  sessionLoading: boolean
  mobileNavOpen: boolean
  setActiveSection: (s: SectionId) => void
  setSession: (s: SessionInfo | null) => void
  setSessionLoading: (v: boolean) => void
  setMobileNavOpen: (v: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeSection: 'dashboard',
  session: null,
  sessionLoading: true,
  mobileNavOpen: false,
  setActiveSection: (s) => set({ activeSection: s, mobileNavOpen: false }),
  setSession: (session) => set({ session }),
  setSessionLoading: (sessionLoading) => set({ sessionLoading }),
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
}))
