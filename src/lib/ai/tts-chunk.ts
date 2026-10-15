/** Pure helper for splitting TTS input into sentence-bounded chunks (no DB/SDK deps). */
export const TTS_MAX_INPUT = 1000

export function chunkForTts(text: string, max = TTS_MAX_INPUT): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]?|[^.!?…]+$/g) ?? [clean]
  const chunks: string[] = []
  let cur = ''
  for (const s of sentences) {
    const piece = s.trim()
    if (!piece) continue
    if (piece.length > max) {
      if (cur) { chunks.push(cur.trim()); cur = '' }
      let rest = piece
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max)
        if (cut < max * 0.5) cut = max
        chunks.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut)
      }
      if (rest.trim()) cur = rest.trim()
      continue
    }
    if ((cur + ' ' + piece).trim().length <= max) cur = (cur + ' ' + piece).trim()
    else { if (cur) chunks.push(cur); cur = piece }
  }
  if (cur) chunks.push(cur.trim())
  return chunks.filter(Boolean)
}