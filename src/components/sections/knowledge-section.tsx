'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, formatDate, type KnowledgeDocRow } from '@/lib/client/api'
import { useAppStore } from '@/lib/client/store'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  BookMarked, CheckCircle2, ChevronDown, ChevronUp, FileQuestion, Loader2,
  Pencil, Plus, Search, ShieldAlert, Trash2,
} from 'lucide-react'

type DocForm = {
  id: string | null
  title: string
  content: string
  tags: string
  approved: boolean
  contentTouched: boolean
}

/** List endpoint returns a 300-char contentPreview instead of full content. */
type DocRow = KnowledgeDocRow & { contentPreview: string }

const EMPTY_FORM: DocForm = { id: null, title: '', content: '', tags: '', approved: true, contentTouched: false }

type Hit = { docId?: string; docTitle: string; chunkId?: string; text: string; score: number }

export function KnowledgeSection() {
  const { toast } = useToast()
  const setActiveSection = useAppStore((s) => s.setActiveSection)

  const [docs, setDocs] = useState<DocRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<DocForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DocRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [testQuery, setTestQuery] = useState('')
  const [testing, setTesting] = useState(false)
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [testError, setTestError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api.get<{ docs: DocRow[] }>('/api/knowledge')
      setDocs(d.docs)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load knowledge documents')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const openNew = () => { setForm(EMPTY_FORM); setFormOpen(true) }

  const openEdit = (doc: DocRow) => {
    // The list endpoint returns only a 300-char preview. Prefill with it; if the
    // user does not touch the content field we PATCH without `content` so the
    // stored document is never replaced by the truncated preview.
    setForm({
      id: doc.id,
      title: doc.title,
      content: doc.contentPreview ?? '',
      tags: (doc.tags ?? []).join(', '),
      approved: doc.approved,
      contentTouched: false,
    })
    setFormOpen(true)
  }

  const saveDoc = async () => {
    setSaving(true)
    try {
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean)
      if (form.id) {
        const patch: Record<string, unknown> = { title: form.title.trim(), approved: form.approved, tags }
        if (form.contentTouched) patch.content = form.content
        await api.patch(`/api/knowledge/${form.id}`, patch)
        toast({ title: 'Document updated', description: form.contentTouched ? 'Re-indexed with the new content.' : 'Metadata updated — content unchanged.' })
      } else {
        await api.post('/api/knowledge', { title: form.title.trim(), content: form.content, approved: form.approved, tags })
        toast({ title: 'Document added', description: form.approved ? 'Approved — the AI can use it immediately.' : 'Saved as a draft (not approved yet).' })
      }
      setFormOpen(false)
      await load()
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const deleteDoc = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/api/knowledge/${deleteTarget.id}`)
      toast({ title: 'Document deleted' })
      setDeleteTarget(null)
      await load()
    } catch (err) {
      toast({ title: 'Delete failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  const runTest = async () => {
    const q = testQuery.trim()
    if (!q) return
    setTesting(true)
    setTestError('')
    try {
      const d = await api.get<{ hits: Hit[] }>(`/api/knowledge/search?q=${encodeURIComponent(q)}`)
      setHits(d.hits)
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Search failed')
      setHits(null)
    } finally {
      setTesting(false)
    }
  }

  const approvedCount = docs.filter((d) => d.approved).length

  return (
    <div className="space-y-4" aria-label="Knowledge and FAQs">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold tracking-tight">Knowledge &amp; FAQs</h2>
          <p className="text-sm text-muted-foreground">
            What your AI receptionist is allowed to say. {approvedCount} of {docs.length} document{docs.length === 1 ? '' : 's'} approved.
          </p>
        </div>
        <Button onClick={openNew} className="min-h-[44px]" aria-label="Add a knowledge document">
          <Plus className="h-4 w-4" aria-hidden /> New document
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(300px,380px)]">
        {/* documents list */}
        <div className="space-y-3">
          {loading ? (
            <div className="space-y-3" aria-label="Loading documents">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
            </div>
          ) : error ? (
            <Alert variant="destructive" role="alert">
              <ShieldAlert className="h-4 w-4" aria-hidden />
              <AlertDescription className="space-y-2">
                <p>{error}</p>
                <Button size="sm" variant="outline" onClick={() => void load()} className="min-h-[44px]">Retry</Button>
              </AlertDescription>
            </Alert>
          ) : docs.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center space-y-3">
                <BookMarked className="h-8 w-8 mx-auto text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">
                  No knowledge yet. Add your business FAQs, prices and policies — the AI only answers from documents you approve here.
                </p>
                <Button onClick={openNew} className="min-h-[44px]"><Plus className="h-4 w-4" aria-hidden /> Add your first document</Button>
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-3 max-h-96 lg:max-h-[70vh] overflow-y-auto pr-1" aria-label="Knowledge documents">
              {docs.map((doc) => {
                const isOpen = Boolean(expanded[doc.id])
                const preview = (doc.contentPreview ?? '').slice(0, 200)
                return (
                  <li key={doc.id}>
                    <Card>
                      <CardContent className="p-4 space-y-2">
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{doc.title}</p>
                            <p className="text-xs text-muted-foreground">
                              Updated {formatDate(doc.updatedAt)} · {doc.chunkCount ?? 0} indexed chunk{(doc.chunkCount ?? 0) === 1 ? '' : 's'}
                            </p>
                          </div>
                          {doc.approved ? (
                            <Badge className="bg-emerald-100 text-emerald-900">Approved</Badge>
                          ) : (
                            <Badge variant="outline" className="text-amber-800 border-amber-300">Not approved</Badge>
                          )}
                        </div>

                        {(doc.tags ?? []).length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {doc.tags.map((t) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
                          </div>
                        )}

                        <p className={cn('text-sm text-muted-foreground whitespace-pre-wrap break-words', !isOpen && 'line-clamp-3')}>
                          {preview || '(no content)'}
                          {!isOpen && (doc.contentPreview ?? '').length > 200 ? '…' : ''}
                        </p>
                        {(doc.contentPreview ?? '').length > 200 && (
                          <button
                            type="button"
                            onClick={() => setExpanded((e) => ({ ...e, [doc.id]: !e[doc.id] }))}
                            className="text-xs text-muted-foreground underline underline-offset-2 min-h-[44px] flex items-center"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? `Collapse preview of ${doc.title}` : `Expand preview of ${doc.title}`}
                          >
                            {isOpen ? <ChevronUp className="h-3 w-3 mr-1" aria-hidden /> : <ChevronDown className="h-3 w-3 mr-1" aria-hidden />}
                            {isOpen ? 'Show less' : 'Show more'}
                          </button>
                        )}

                        <Separator />

                        <div className="flex flex-wrap items-center gap-2">
                          {!doc.approved && (
                            <span className="text-xs text-amber-800 flex items-center gap-1">
                              <ShieldAlert className="h-3 w-3" aria-hidden /> The AI ignores unapproved documents.
                            </span>
                          )}
                          <div className="ml-auto flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => openEdit(doc)} className="min-h-[44px]" aria-label={`Edit ${doc.title}`}>
                              <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(doc)} className="min-h-[44px] text-rose-700 hover:text-rose-800" aria-label={`Delete ${doc.title}`}>
                              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* retrieval tester */}
        <Card className="self-start">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Search className="h-4 w-4" aria-hidden /> Test retrieval</CardTitle>
            <CardDescription>Ask a question the way a customer would — this shows exactly what the AI sees.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void runTest() }}>
              <Input
                value={testQuery}
                onChange={(e) => setTestQuery(e.target.value)}
                placeholder="e.g. what is your cancellation policy?"
                aria-label="Retrieval test query"
                className="min-h-[44px]"
              />
              <Button type="submit" disabled={testing || !testQuery.trim()} aria-label="Run retrieval test" className="min-h-[44px]">
                {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />}
              </Button>
            </form>

            {testError && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{testError}</AlertDescription>
              </Alert>
            )}

            {hits !== null && !testError && (
              hits.length === 0 ? (
                <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="status">
                  <FileQuestion className="h-4 w-4" aria-hidden />
                  <AlertDescription>
                    No matching approved content. The AI would have to improvise or take a message — add or approve a document that covers this.
                  </AlertDescription>
                </Alert>
              ) : (
                <ul className="space-y-2 max-h-72 overflow-y-auto" aria-label="Retrieval results">
                  {hits.map((h, i) => (
                    <li key={h.chunkId ?? i} className="rounded-md border p-2.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium truncate">{h.docTitle}</p>
                        <Badge variant="secondary" className="text-[10px] shrink-0">score {h.score.toFixed(3)}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-4">{h.text}</p>
                    </li>
                  ))}
                </ul>
              )
            )}

            <Separator />
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <p className="flex items-start gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-emerald-600 shrink-0" aria-hidden />
                Retrieval uses the built-in local lexical engine. For semantic search connect an embedding model in AI Providers.
              </p>
              <button
                type="button"
                onClick={() => setActiveSection('ai')}
                className="underline underline-offset-2 min-h-[44px] flex items-center"
                aria-label="Open AI Providers settings"
              >
                Open AI Providers →
              </button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* new / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-xl" aria-describedby="doc-form-desc">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit document' : 'New knowledge document'}</DialogTitle>
            <DialogDescription id="doc-form-desc">
              Write it the way you would tell a new receptionist. Only approved documents are used by the AI.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="docTitle">Title</Label>
              <Input
                id="docTitle" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Cancellation policy" className="min-h-[44px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="docContent">Content</Label>
              <Textarea
                id="docContent" rows={8} value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value, contentTouched: true }))}
                placeholder="Cancellations are free up to 24 hours before the appointment…"
              />
              {form.id && !form.contentTouched && (
                <p className="text-xs text-amber-800">
                  Showing the first 300 characters of the stored document. Edit only if you want to replace the full content — otherwise it is sent unchanged.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="docTags">Tags (comma separated)</Label>
              <Input
                id="docTags" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                placeholder="faq, policies" className="min-h-[44px]"
              />
            </div>
            <div className="flex items-start gap-3 rounded-md border p-3">
              <Switch
                id="docApproved" checked={form.approved}
                onCheckedChange={(v) => setForm((f) => ({ ...f, approved: v }))}
                aria-label="Approved for AI use"
              />
              <div>
                <Label htmlFor="docApproved" className="cursor-pointer">Approved for AI use</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Approved documents are indexed and quoted by the AI receptionist. Drafts are stored but never shown to customers.
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} className="min-h-[44px]">Cancel</Button>
            <Button onClick={() => void saveDoc()} disabled={saving || !form.title.trim() || (!form.id && !form.content.trim())} className="min-h-[44px]">
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {form.id ? 'Save changes' : 'Add document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The document and its search index are removed. The AI will no longer be able to answer questions it covered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void deleteDoc() }}
              disabled={deleting}
              className="min-h-[44px] bg-rose-700 text-white hover:bg-rose-800"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden />}
              Delete document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
