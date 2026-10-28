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
  BookMarked, CheckCircle2, ChevronDown, ChevronUp, Database, FileQuestion, FileUp, Globe2, Loader2,
  Pencil, Plus, RefreshCw, ScanEye, Search, ShieldAlert, Sparkles, Trash2,
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

type Hit = { docId?: string; docTitle: string; chunkId?: string; text: string; score: number; scores?: { dense: number | null; lexical: number } }

type IndexStatus = {
  provider: string
  model: string
  enabled: boolean
  providerLabel: string
  docs: number
  approvedDocs: number
  totalChunks: number
  chunksWithCurrentModel: number
  needsReindex: boolean
  neuralReady: boolean
}

export function KnowledgeSection() {
  const { toast } = useToast()
  const setActiveSection = useAppStore((s) => s.setActiveSection)
  const role = useAppStore((s) => s.session?.user?.role)
  const canManage = role === 'owner' || role === 'admin'

  const [docs, setDocs] = useState<DocRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)
  const [reindexing, setReindexing] = useState(false)
  const [reindexMsg, setReindexMsg] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<DocForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DocRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [testQuery, setTestQuery] = useState('')
  const [testing, setTesting] = useState(false)
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [testError, setTestError] = useState('')

  /* ---------- document import (PDF/DOCX/text/HTML) ---------- */
  type ExtractedDoc = { title: string; text: string; format: string; pages?: number; warnings: string[] }
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importDoc, setImportDoc] = useState<ExtractedDoc | null>(null)
  const [importTitle, setImportTitle] = useState('')
  const [importTags, setImportTags] = useState('')
  const [importApproved, setImportApproved] = useState(true)
  const [importError, setImportError] = useState('')
  const [importSaving, setImportSaving] = useState(false)

  /* ---------- website import ---------- */
  const [crawlOpen, setCrawlOpen] = useState(false)
  const [crawlUrl, setCrawlUrl] = useState('')
  const [crawlMaxPages, setCrawlMaxPages] = useState(15)
  const [crawlMaxDepth, setCrawlMaxDepth] = useState(2)
  const [crawlSameOrigin, setCrawlSameOrigin] = useState(true)
  const [crawlUseAi, setCrawlUseAi] = useState(true)
  const [crawlApproved, setCrawlApproved] = useState(true)
  const [crawling, setCrawling] = useState(false)
  const [crawlError, setCrawlError] = useState('')
  const [crawlResult, setCrawlResult] = useState<{
    message: string
    created: number
    updated: number
    chunks: number
    aiCleaned: number
    aiFailures: Array<{ url: string; message: string }>
    errors: Array<{ url: string; message: string }>
    skipped: Array<{ url: string; reason: string }>
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [d, idx] = await Promise.all([
        api.get<{ docs: DocRow[] }>('/api/knowledge'),
        api.get<{ index: IndexStatus }>('/api/knowledge/index').catch(() => null),
      ])
      setDocs(d.docs)
      setIndexStatus(idx?.index ?? null)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load knowledge documents')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /* ---------- vision (read an image with the configured vision model) ---------- */
  const [visionFile, setVisionFile] = useState<File | null>(null)
  const [visionPrompt, setVisionPrompt] = useState('Transcribe all text in this image exactly as it appears.')
  const [visionBusy, setVisionBusy] = useState(false)
  const [visionText, setVisionText] = useState('')
  const [visionError, setVisionError] = useState('')

  const readWithVision = async () => {
    if (!visionFile) return
    setVisionBusy(true)
    setVisionError('')
    setVisionText('')
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('The file could not be read'))
        reader.onload = () => {
          const result = String(reader.result ?? '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.readAsDataURL(visionFile)
      })
      const d = await api.post<{ text: string; model: string; latencyMs: number }>('/api/ai/vision', {
        imageBase64: base64,
        mimeType: visionFile.type || 'image/png',
        prompt: visionPrompt.trim() || 'Describe this image.',
      })
      setVisionText(d.text)
    } catch (err) {
      setVisionError(err instanceof Error ? err.message : 'The image could not be read')
    } finally {
      setVisionBusy(false)
    }
  }

  const saveVisionAsDoc = async () => {
    if (!visionText.trim()) return
    try {
      await api.post('/api/knowledge', {
        title: `Image read ${new Date().toLocaleDateString()}`,
        content: visionText.trim(),
        approved: true,
        tags: ['vision'],
      })
      toast({ title: 'Saved as a knowledge document', description: 'The text is now available to the AI receptionist.' })
      setVisionText('')
      setVisionFile(null)
      await load()
    } catch (err) {
      toast({ title: 'Save failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    }
  }

  const openNew = () => { setForm(EMPTY_FORM); setFormOpen(true) }

  const readFileBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('The file could not be read'))
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      }
      reader.readAsDataURL(file)
    })

  const resetImport = () => {
    setImportFile(null)
    setImportDoc(null)
    setImportTitle('')
    setImportTags('')
    setImportApproved(true)
    setImportError('')
    setImportBusy(false)
    setImportSaving(false)
  }

  const pickImportFile = async (file: File | null) => {
    setImportFile(file)
    setImportDoc(null)
    setImportError('')
    if (!file) return
    if (file.size > 25 * 1024 * 1024) {
      setImportError('The file is larger than the 25 MB upload limit.')
      return
    }
    setImportBusy(true)
    try {
      const base64 = await readFileBase64(file)
      const d = await api.post<{ document: ExtractedDoc }>('/api/knowledge/extract', {
        filename: file.name,
        mimeType: file.type || undefined,
        base64,
      })
      setImportDoc(d.document)
      setImportTitle(d.document.title)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'The file could not be read')
    } finally {
      setImportBusy(false)
    }
  }

  const saveImport = async () => {
    if (!importDoc) return
    setImportSaving(true)
    setImportError('')
    try {
      const tags = importTags.split(',').map((t) => t.trim()).filter(Boolean)
      await api.post('/api/knowledge', {
        title: importTitle.trim() || importDoc.title,
        content: importDoc.text,
        approved: importApproved,
        tags,
        source: 'file',
      })
      toast({
        title: 'Document imported',
        description: importApproved ? 'Indexed and available to the AI receptionist.' : 'Saved as a draft (not approved yet).',
      })
      setImportOpen(false)
      resetImport()
      await load()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'The document could not be saved')
    } finally {
      setImportSaving(false)
    }
  }

  const runCrawl = async () => {
    setCrawling(true)
    setCrawlError('')
    setCrawlResult(null)
    try {
      const d = await api.post<{
        message: string
        created: number
        updated: number
        chunks: number
        aiCleaned: number
        aiFailures: Array<{ url: string; message: string }>
        errors: Array<{ url: string; message: string }>
        skipped: Array<{ url: string; reason: string }>
      }>('/api/knowledge/crawl', {
        url: crawlUrl.trim(),
        maxPages: crawlMaxPages,
        maxDepth: crawlMaxDepth,
        sameOrigin: crawlSameOrigin,
        useAi: crawlUseAi,
        approved: crawlApproved,
      })
      setCrawlResult(d)
      toast({ title: 'Website imported', description: d.message })
      await load()
    } catch (err) {
      setCrawlError(err instanceof Error ? err.message : 'The website could not be imported')
    } finally {
      setCrawling(false)
    }
  }

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

  const reindex = async () => {
    setReindexing(true)
    setReindexMsg('')
    try {
      const d = await api.post<{ ok: boolean; message: string }>('/api/knowledge/reindex', {})
      setReindexMsg(d.message)
      toast({ title: 'Reindex complete', description: d.message })
      await load()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Reindex failed'
      setReindexMsg(msg)
      toast({ title: 'Reindex failed', description: msg, variant: 'destructive' })
    } finally {
      setReindexing(false)
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
        <Button variant="outline" onClick={() => { resetImport(); setImportOpen(true) }} className="min-h-[44px]" aria-label="Import a document file">
          <FileUp className="h-4 w-4" aria-hidden /> Import file
        </Button>
        <Button variant="outline" onClick={() => { setCrawlOpen(true); setCrawlError(''); setCrawlResult(null) }} className="min-h-[44px]" aria-label="Import a website">
          <Globe2 className="h-4 w-4" aria-hidden /> Import website
        </Button>
        <Button onClick={openNew} className="min-h-[44px]" aria-label="Add a knowledge document">
          <Plus className="h-4 w-4" aria-hidden /> New document
        </Button>
      </div>

      {/* embedding index status */}
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : indexStatus ? (
        <Card aria-label="Knowledge index status">
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" aria-hidden />
              <p className="font-medium text-sm">Search index</p>
              <Badge variant="secondary" className="font-mono text-[11px]">{indexStatus.model}</Badge>
              {indexStatus.provider === 'local_neural' && (
                <Badge className="bg-emerald-100 text-emerald-900">Semantic · on this machine</Badge>
              )}
              {indexStatus.provider === 'local_lexical' && (
                <Badge variant="outline" className="text-amber-800 border-amber-300">Keyword only</Badge>
              )}
              <span className="text-xs text-muted-foreground ml-auto">
                {indexStatus.totalChunks} chunk{indexStatus.totalChunks === 1 ? '' : 's'} indexed · {indexStatus.approvedDocs} of {indexStatus.docs} doc{indexStatus.docs === 1 ? '' : 's'} approved
              </span>
            </div>

            {indexStatus.provider === 'local_neural' && !indexStatus.neuralReady && (
              <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="status">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <AlertDescription>
                  The local embedding model could not be loaded — search is falling back to keyword scoring until it is available.
                </AlertDescription>
              </Alert>
            )}

            {indexStatus.needsReindex ? (
              <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="status">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
                  <AlertDescription className="flex-1 min-w-[12rem]">
                    {indexStatus.chunksWithCurrentModel} of {indexStatus.totalChunks} chunks use the current model ({indexStatus.model}). Re-index to restore full semantic quality — documents stay available during reindex.
                  </AlertDescription>
                  {canManage && (
                    <Button size="sm" onClick={() => void reindex()} disabled={reindexing} className="min-h-[44px]" aria-label="Reindex knowledge with the current embedding model">
                      {reindexing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                      Reindex
                    </Button>
                  )}
                </div>
              </Alert>
            ) : (
              reindexMsg ? (
                <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900" role="status">
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  <AlertDescription>{reindexMsg}</AlertDescription>
                </Alert>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  Every indexed chunk was embedded with the current model. Retrieval mixes semantic similarity (72%) with keyword matching (28%).
                </p>
              )
            )}
          </CardContent>
        </Card>
      ) : null}

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
                            aria-label={isOpen ? `Collapse preview of ${doc.title}` : `Expand preview of ${doc.title}`} title={isOpen ? `Collapse preview of ${doc.title}` : `Expand preview of ${doc.title}`}
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

        {/* vision: read an image with the configured vision model */}
        <Card className="self-start">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><ScanEye className="h-4 w-4" aria-hidden /> Read an image</CardTitle>
            <CardDescription>
              Send a photo (receipt, price list, damage report) to the vision model configured in AI Providers.
              The image is not stored — only the text you keep.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="vision-file">Image</Label>
              <Input
                id="vision-file"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => { setVisionFile(e.target.files?.[0] ?? null); setVisionText('') }}
                className="min-h-[44px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vision-prompt">What should the model look for?</Label>
              <Textarea
                id="vision-prompt"
                rows={2}
                value={visionPrompt}
                onChange={(e) => setVisionPrompt(e.target.value)}
                placeholder="Transcribe all text in this image."
              />
            </div>
            <Button
              onClick={() => void readWithVision()}
              disabled={!visionFile || visionBusy}
              className="min-h-[44px] w-full"
            >
              {visionBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ScanEye className="h-4 w-4" aria-hidden />}
              Read the image
            </Button>
            {visionError && (
              <Alert variant="destructive" role="alert">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <AlertDescription>{visionError}</AlertDescription>
              </Alert>
            )}
            {visionText && (
              <>
                <Textarea readOnly rows={6} value={visionText} aria-label="Text read from the image" />
                <Button onClick={() => void saveVisionAsDoc()} variant="outline" className="min-h-[44px] w-full">
                  <Plus className="h-4 w-4" aria-hidden /> Save as a knowledge document
                </Button>
              </>
            )}
          </CardContent>
        </Card>

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
              <Button type="submit" disabled={testing || !testQuery.trim()} aria-label="Run retrieval test" title="Run retrieval test" className="min-h-[44px]">
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
                        <div className="flex items-center gap-1 shrink-0">
                          {h.scores?.dense != null && (
                            <Badge variant="outline" className="text-[10px] font-mono" title="Semantic similarity (dense embedding)">dense {(h.scores.dense * 100).toFixed(0)}%</Badge>
                          )}
                          {h.scores && (
                            <Badge variant="outline" className="text-[10px] font-mono" title="Keyword match (BM25, normalized)">kw {(h.scores.lexical * 100).toFixed(0)}%</Badge>
                          )}
                          <Badge variant="secondary" className="text-[10px]">score {h.score.toFixed(3)}</Badge>
                        </div>
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
                {indexStatus?.provider === 'local_neural'
                  ? 'Semantic search runs on a built-in neural embedding model (MiniLM, 384-d) — entirely on this machine, no API key, no data leaves the server.'
                  : indexStatus?.provider === 'ollama' || indexStatus?.provider === 'openai_compatible'
                    ? `Semantic search uses your ${indexStatus.provider === 'ollama' ? 'local Ollama' : 'OpenAI-compatible'} embedding model (${indexStatus.model}).`
                    : 'Search currently uses the legacy keyword engine — switch the embedding provider to the built-in neural model for true semantic search.'}
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
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit document' : 'New knowledge document'}</DialogTitle>
            <DialogDescription>
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

      {/* document import dialog */}
      <Dialog open={importOpen} onOpenChange={(o) => { setImportOpen(o); if (!o) resetImport() }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Import a document</DialogTitle>
            <DialogDescription>
              Upload PDF, DOCX, HTML, Markdown, CSV, JSON or plain text (up to 25 MB). The text is extracted on this server — review it before saving.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="import-file">File</Label>
              <Input
                id="import-file"
                type="file"
                accept=".pdf,.docx,.html,.htm,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.rtf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*,application/json"
                onChange={(e) => void pickImportFile(e.target.files?.[0] ?? null)}
                disabled={importBusy || importSaving}
                className="min-h-[44px]"
              />
              {importFile && (
                <p className="text-xs text-muted-foreground">
                  {importFile.name} · {(importFile.size / 1024).toFixed(0)} KB
                  {importDoc ? ` · ${importDoc.format.toUpperCase()}${importDoc.pages ? ` · ${importDoc.pages} pages` : ''}` : ''}
                </p>
              )}
            </div>

            {importBusy && (
              <p className="text-sm text-muted-foreground flex items-center gap-2" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Extracting text…
              </p>
            )}

            {importError && (
              <Alert variant="destructive" role="alert">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <AlertDescription>{importError}</AlertDescription>
              </Alert>
            )}

            {importDoc?.warnings.length ? (
              <Alert className="border-amber-200 bg-amber-50 text-amber-900" role="status">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <AlertDescription>
                  <ul className="list-disc pl-4 space-y-1">
                    {importDoc.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {importDoc && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="import-title">Title</Label>
                  <Input
                    id="import-title"
                    value={importTitle}
                    onChange={(e) => setImportTitle(e.target.value)}
                    className="min-h-[44px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="import-preview">Extracted text ({importDoc.text.length.toLocaleString()} characters)</Label>
                  <Textarea
                    id="import-preview"
                    readOnly
                    rows={8}
                    value={importDoc.text.slice(0, 8_000)}
                    className="max-h-64 overflow-y-auto font-mono text-xs"
                    aria-label="Preview of the extracted document text"
                  />
                  {importDoc.text.length > 8_000 && (
                    <p className="text-xs text-muted-foreground">Showing the first 8,000 characters. The full text is saved.</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="import-tags">Tags (comma separated)</Label>
                  <Input
                    id="import-tags"
                    value={importTags}
                    onChange={(e) => setImportTags(e.target.value)}
                    placeholder="faq, policies"
                    className="min-h-[44px]"
                  />
                </div>
                <div className="flex items-start gap-3 rounded-md border p-3">
                  <Switch
                    id="import-approved"
                    checked={importApproved}
                    onCheckedChange={setImportApproved}
                    aria-label="Approve the imported document for AI use"
                  />
                  <div>
                    <Label htmlFor="import-approved" className="cursor-pointer">Approved for AI use</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">Approved documents are indexed and quoted by the AI receptionist.</p>
                  </div>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} className="min-h-[44px]">Cancel</Button>
            <Button onClick={() => void saveImport()} disabled={!importDoc || importSaving || !importTitle.trim()} className="min-h-[44px]">
              {importSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileUp className="h-4 w-4" aria-hidden />}
              Save document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* website import dialog */}
      <Dialog open={crawlOpen} onOpenChange={setCrawlOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Import a website</DialogTitle>
            <DialogDescription>
              Crawls a public site (robots.txt respected, same origin by default) and stores each readable page as a knowledge document.
              Your configured AI model is used to strip navigation and marketing filler.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="crawl-url">Website URL</Label>
              <Input
                id="crawl-url"
                type="url"
                value={crawlUrl}
                onChange={(e) => setCrawlUrl(e.target.value)}
                placeholder="https://example.com"
                disabled={crawling}
                className="min-h-[44px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="crawl-pages">Max pages</Label>
                <Input
                  id="crawl-pages"
                  type="number"
                  min={1}
                  max={50}
                  value={crawlMaxPages}
                  onChange={(e) => setCrawlMaxPages(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  disabled={crawling}
                  className="min-h-[44px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="crawl-depth">Max link depth</Label>
                <Input
                  id="crawl-depth"
                  type="number"
                  min={0}
                  max={4}
                  value={crawlMaxDepth}
                  onChange={(e) => setCrawlMaxDepth(Math.max(0, Math.min(4, Number(e.target.value) || 0)))}
                  disabled={crawling}
                  className="min-h-[44px]"
                />
              </div>
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-start gap-3">
                <Switch id="crawl-same-origin" checked={crawlSameOrigin} onCheckedChange={setCrawlSameOrigin} disabled={crawling} aria-label="Stay on the same website" />
                <div>
                  <Label htmlFor="crawl-same-origin" className="cursor-pointer">Stay on this website</Label>
                  <p className="text-xs text-muted-foreground">Skip links to other domains.</p>
                </div>
              </div>
              <Separator />
              <div className="flex items-start gap-3">
                <Switch id="crawl-use-ai" checked={crawlUseAi} onCheckedChange={setCrawlUseAi} disabled={crawling} aria-label="Clean pages with the configured AI model" />
                <div>
                  <Label htmlFor="crawl-use-ai" className="cursor-pointer flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" aria-hidden /> Clean with AI</Label>
                  <p className="text-xs text-muted-foreground">
                    One model call per page. Without it, pages are imported as deterministic extracted text. An AI model must be configured either way.
                  </p>
                </div>
              </div>
              <Separator />
              <div className="flex items-start gap-3">
                <Switch id="crawl-approved" checked={crawlApproved} onCheckedChange={setCrawlApproved} disabled={crawling} aria-label="Approve imported pages for AI use" />
                <div>
                  <Label htmlFor="crawl-approved" className="cursor-pointer">Approved for AI use</Label>
                  <p className="text-xs text-muted-foreground">Imported pages are indexed immediately when approved.</p>
                </div>
              </div>
            </div>

            {crawlError && (
              <Alert variant="destructive" role="alert">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <AlertDescription className="space-y-2">
                  <p>{crawlError}</p>
                  {crawlError.toLowerCase().includes('configure') && (
                    <Button size="sm" variant="outline" onClick={() => { setCrawlOpen(false); setActiveSection('ai') }} className="min-h-[44px]">
                      Open AI Providers
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {crawling && (
              <p className="text-sm text-muted-foreground flex items-center gap-2" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Crawling and indexing — this can take a minute for larger sites…
              </p>
            )}

            {crawlResult && (
              <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900" role="status">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                <AlertDescription className="space-y-2">
                  <p>{crawlResult.message}</p>
                  {(crawlResult.errors.length > 0 || crawlResult.aiFailures.length > 0 || crawlResult.skipped.length > 0) && (
                    <details>
                      <summary className="cursor-pointer text-xs underline underline-offset-2">
                        {crawlResult.errors.length + crawlResult.aiFailures.length + crawlResult.skipped.length} page(s) had issues
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-xs break-all">
                        {crawlResult.errors.slice(0, 8).map((e) => <li key={`e-${e.url}`}>{e.url} — {e.message}</li>)}
                        {crawlResult.aiFailures.slice(0, 8).map((e) => <li key={`a-${e.url}`}>{e.url} — AI cleanup failed ({e.message}); saved extracted text.</li>)}
                        {crawlResult.skipped.slice(0, 8).map((s) => <li key={`s-${s.url}`}>{s.url} — {s.reason}</li>)}
                      </ul>
                    </details>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCrawlOpen(false)} disabled={crawling} className="min-h-[44px]">Close</Button>
            <Button onClick={() => void runCrawl()} disabled={crawling || !crawlUrl.trim()} className="min-h-[44px]">
              {crawling ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Globe2 className="h-4 w-4" aria-hidden />}
              Start import
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
