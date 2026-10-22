import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/**
 * Host capability probe.
 *
 * Everything here is read from the machine the app runs on — no external calls,
 * no telemetry. The numbers are used to recommend models that actually fit the
 * hardware instead of guessing in the docs.
 */

export type GpuInfo = {
  vendor: 'nvidia' | 'amd' | 'apple' | 'none'
  name: string
  vramGb: number | null
  count: number
}

export type HardwareInfo = {
  platform: string
  arch: string
  nodeVersion: string
  cpuModel: string
  cpuCores: number
  cpuSpeedMhz: number
  ramTotalGb: number
  ramFreeGb: number
  gpu: GpuInfo
  diskFreeGb: number | null
  diskPath: string
  /** Rough "how much can this box run" tier used by the model catalog. */
  tier: 'small' | 'medium' | 'large'
}

export type ModelRecommendation = {
  capability: 'llm' | 'embedding' | 'stt' | 'tts' | 'vision'
  model: string
  sizeGb: number
  minRamGb: number
  note: string
  fits: boolean
  reason: string
}

/** The catalog we recommend from. Sizes are the published download sizes. */
export const MODEL_CATALOG: Array<Omit<ModelRecommendation, 'fits' | 'reason'>> = [
  { capability: 'llm', model: 'llama3.2:1b', sizeGb: 1.3, minRamGb: 4, note: 'Tiny and fast — good for testing the pipeline, weak at multi-step tool use.' },
  { capability: 'llm', model: 'qwen2.5:3b', sizeGb: 2, minRamGb: 6, note: 'Best small receptionist model: solid tool calling on CPU.' },
  { capability: 'llm', model: 'llama3.2:3b', sizeGb: 2, minRamGb: 6, note: 'Solid general model, good JSON output for the tool loop.' },
  { capability: 'llm', model: 'qwen2.5:7b', sizeGb: 4.7, minRamGb: 10, note: 'Recommended for a 16 GB machine without a GPU.' },
  { capability: 'llm', model: 'llama3.1:8b', sizeGb: 4.9, minRamGb: 12, note: 'Strong all-round model; comfortable on 16 GB+.' },
  { capability: 'llm', model: 'qwen2.5:14b', sizeGb: 9, minRamGb: 20, note: 'High quality tool calling — needs a 24 GB machine or a 12 GB+ GPU.' },
  { capability: 'embedding', model: 'nomic-embed-text', sizeGb: 0.3, minRamGb: 4, note: 'RAG embeddings for Ollama (the built-in neural model needs no download).' },
  { capability: 'embedding', model: 'bge-m3', sizeGb: 1.2, minRamGb: 6, note: 'Multilingual embeddings — better for non-English corpora.' },
  { capability: 'stt', model: 'whisper-base', sizeGb: 0.15, minRamGb: 4, note: 'Speech-to-text via a local whisper server.' },
  { capability: 'stt', model: 'whisper-large-v3', sizeGb: 3, minRamGb: 10, note: 'Best transcription accuracy — needs a GPU for real time.' },
  { capability: 'tts', model: 'piper', sizeGb: 0.1, minRamGb: 2, note: 'Local neural TTS (one voice file per speaker).' },
  { capability: 'tts', model: 'kokoro', sizeGb: 0.1, minRamGb: 2, note: 'Local TTS with natural voices (Kokoro-FastAPI).' },
  { capability: 'vision', model: 'qwen2.5vl:3b', sizeGb: 3.2, minRamGb: 8, note: 'Reads images — useful for scanning invoices or damage photos.' },
  { capability: 'vision', model: 'llava:7b', sizeGb: 4.7, minRamGb: 10, note: 'Classic vision model for image questions.' },
]

function run(cmd: string, args: string[], timeoutMs = 2500): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : String(stdout))
      })
    } catch {
      resolve('')
    }
  })
}

async function detectGpu(): Promise<GpuInfo> {
  const none: GpuInfo = { vendor: 'none', name: '', vramGb: null, count: 0 }

  if (os.platform() === 'darwin' && os.arch() === 'arm64') {
    // Apple Silicon: unified memory, the GPU shares the RAM budget.
    const totalGb = os.totalmem() / 1024 ** 3
    return { vendor: 'apple', name: `Apple Silicon (${os.cpus()[0]?.model ?? 'arm64'})`, vramGb: Math.round(totalGb), count: 1 }
  }

  const nvidia = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  if (nvidia.trim()) {
    const rows = nvidia
      .trim()
      .split('\n')
      .map((line) => line.split(',').map((v) => v.trim()))
      .filter((r) => r[0])
    const first = rows[0] ?? []
    const vramMb = Number(first[1])
    return {
      vendor: 'nvidia',
      name: first[0] ?? 'NVIDIA GPU',
      vramGb: Number.isFinite(vramMb) && vramMb > 0 ? Math.round((vramMb / 1024) * 10) / 10 : null,
      count: rows.length,
    }
  }

  const amd = await run('rocm-smi', ['--showproductname', '--csv'])
  if (amd.trim()) {
    return { vendor: 'amd', name: amd.trim().split('\n')[0]?.slice(0, 80) ?? 'AMD GPU', vramGb: null, count: 1 }
  }

  return none
}

function diskFreeGb(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir)
    const free = stat.bavail * stat.bsize
    return Math.round((free / 1024 ** 3) * 10) / 10
  } catch {
    return null
  }
}

export async function detectHardware(dataDir = process.cwd()): Promise<HardwareInfo> {
  const cpus = os.cpus()
  const ramTotalGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  const ramFreeGb = Math.round((os.freemem() / 1024 ** 3) * 10) / 10
  const gpu = await detectGpu()

  let tier: HardwareInfo['tier'] = 'small'
  if (gpu.vendor === 'nvidia' && (gpu.vramGb ?? 0) >= 10) tier = 'large'
  else if (ramTotalGb >= 16) tier = 'medium'
  if (gpu.vendor === 'apple' && ramTotalGb >= 16) tier = 'large'

  return {
    platform: `${os.platform()} ${os.arch()}`,
    arch: os.arch(),
    nodeVersion: process.version,
    cpuModel: cpus[0]?.model?.trim() || 'unknown',
    cpuCores: cpus.length,
    cpuSpeedMhz: cpus[0]?.speed ?? 0,
    ramTotalGb,
    ramFreeGb,
    gpu,
    diskFreeGb: diskFreeGb(path.resolve(dataDir)),
    diskPath: path.resolve(dataDir),
    tier,
  }
}

/**
 * Which catalog entries fit this machine? A model fits when the free RAM
 * covers its minimum and (for GPU boxes) the VRAM covers roughly the model
 * size. Disk space is checked too — a model that cannot be downloaded is not
 * a recommendation.
 */
export function recommendModels(hardware: HardwareInfo): ModelRecommendation[] {
  // The fit check uses TOTAL memory (what the machine can give the model), not
  // the memory that happens to be free right now — the OS caches and swaps.
  const totalRam = hardware.ramTotalGb
  return MODEL_CATALOG.map((entry) => {
    const reasons: string[] = []
    let fits = true

    if (totalRam < entry.minRamGb) {
      fits = false
      reasons.push(`needs ${entry.minRamGb} GB RAM (this machine has ${totalRam} GB)`)
    }
    if (hardware.gpu.vendor === 'nvidia' && hardware.gpu.vramGb) {
      if (entry.capability === 'llm' && entry.sizeGb > hardware.gpu.vramGb * 0.9) {
        fits = false
        reasons.push(`needs ~${entry.sizeGb} GB of VRAM (${hardware.gpu.vramGb} GB available)`)
      }
    }
    if (hardware.diskFreeGb !== null && entry.sizeGb > hardware.diskFreeGb * 0.8) {
      fits = false
      reasons.push(`needs ~${entry.sizeGb} GB of disk (${hardware.diskFreeGb} GB free)`)
    }
    if (hardware.gpu.vendor === 'none' && entry.capability === 'llm' && entry.sizeGb > 5) {
      reasons.push('CPU-only — expect slow answers')
    }

    return {
      ...entry,
      fits,
      reason: reasons.length ? reasons.join('; ') : 'fits this machine',
    }
  })
}

/** The single best chat model for this hardware (null when nothing fits). */
export function bestChatModel(recommendations: ModelRecommendation[]): ModelRecommendation | null {
  const chat = recommendations.filter((r) => r.capability === 'llm' && r.fits)
  if (!chat.length) return null
  // Prefer the largest model that still fits — quality scales with size.
  return chat.sort((a, b) => b.sizeGb - a.sizeGb)[0] ?? null
}
