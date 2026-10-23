/**
 * Provider presets for the AI settings UI.
 *
 * Presets only pre-fill the base URL and suggest model ids. Any OpenAI-compatible
 * vendor can also be configured manually — the wire adapter is the same.
 * Nothing here contains credentials.
 */

export type PresetCapability = 'llm' | 'embedding' | 'stt' | 'tts' | 'realtime' | 'rerank' | 'vision'

export type AiPreset = {
  id: string
  label: string
  provider: string
  capabilities: PresetCapability[]
  baseUrl: string
  models: string[]
  keyHint?: string
  note?: string
}

export const PROVIDER_KIND_LABELS: Record<string, string> = {
  ollama: 'Ollama (local)',
  openai_compatible: 'OpenAI-compatible endpoint',
  anthropic: 'Anthropic (Claude)',
  google: 'Google Gemini',
  azure_openai: 'Azure OpenAI',
  browser: 'In-browser',
  local_neural: 'Built-in neural model (local)',
  local_lexical: 'Legacy keyword index (local)',
  local_speech: 'Local speech models (ONNX, offline)',
  none: 'Disabled',
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: 'ollama', label: 'Ollama (local)', provider: 'ollama',
    capabilities: ['llm', 'embedding'],
    baseUrl: 'http://localhost:11434',
    models: ['llama3.2', 'llama3.1:8b', 'qwen2.5:7b', 'mistral:7b', 'nomic-embed-text'],
    note: 'Fully local, no API key. Pull a model first with `ollama pull`.',
  },
  {
    id: 'openai', label: 'OpenAI', provider: 'openai_compatible',
    capabilities: ['llm', 'embedding', 'stt', 'tts', 'vision', 'realtime'],
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini', 'text-embedding-3-small', 'text-embedding-3-large', 'whisper-1', 'tts-1', 'gpt-4o-realtime-preview'],
    keyHint: 'sk-…',
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', provider: 'anthropic',
    capabilities: ['llm', 'vision'],
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-1-20250805', 'claude-3-5-haiku-latest'],
    keyHint: 'sk-ant-…',
    note: 'Uses the native Messages API (not OpenAI-compatible).',
  },
  {
    id: 'google', label: 'Google Gemini', provider: 'google',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-embedding-001', 'text-embedding-004'],
    keyHint: 'AIza…',
    note: 'Uses the native Generative Language API.',
  },
  {
    id: 'azure_openai', label: 'Azure OpenAI', provider: 'azure_openai',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT',
    models: ['YOUR-DEPLOYMENT'],
    keyHint: 'Azure key',
    note: 'Set the deployment endpoint as the base URL. Add apiVersion in config (default 2024-10-21).',
  },
  {
    id: 'xai', label: 'xAI (Grok)', provider: 'openai_compatible',
    capabilities: ['llm', 'vision'],
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-2-latest', 'grok-vision-beta'],
    keyHint: 'xai-…',
  },
  {
    id: 'groq', label: 'Groq', provider: 'openai_compatible',
    capabilities: ['llm', 'stt', 'vision'],
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'whisper-large-v3', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    keyHint: 'gsk_…',
  },
  {
    id: 'deepseek', label: 'DeepSeek', provider: 'openai_compatible',
    capabilities: ['llm'],
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'mistral', label: 'Mistral', provider: 'openai_compatible',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo', 'mistral-embed', 'pixtral-large-latest'],
  },
  {
    id: 'together', label: 'Together AI', provider: 'openai_compatible',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'BAAI/bge-large-en-v1.5'],
  },
  {
    id: 'openrouter', label: 'OpenRouter', provider: 'openai_compatible',
    capabilities: ['llm', 'vision'],
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct'],
    keyHint: 'sk-or-…',
  },
  {
    id: 'perplexity', label: 'Perplexity', provider: 'openai_compatible',
    capabilities: ['llm'],
    baseUrl: 'https://api.perplexity.ai',
    models: ['sonar', 'sonar-pro', 'sonar-reasoning'],
  },
  {
    id: 'fireworks', label: 'Fireworks AI', provider: 'openai_compatible',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen3-235b-a22b'],
    keyHint: 'fw_…',
  },
  {
    id: 'cohere', label: 'Cohere (rerank)', provider: 'openai_compatible',
    capabilities: ['rerank'],
    baseUrl: 'https://api.cohere.com/v1',
    models: ['rerank-v3.5', 'rerank-english-v3.0', 'rerank-multilingual-v3.0'],
  },
  {
    id: 'lmstudio', label: 'LM Studio (local)', provider: 'openai_compatible',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'http://localhost:1234/v1',
    models: ['local-model'],
    note: 'Start the LM Studio local server first.',
  },
  {
    id: 'vllm', label: 'vLLM (local)', provider: 'openai_compatible',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'http://localhost:8000/v1',
    models: ['model'],
  },
  {
    id: 'llamacpp', label: 'llama.cpp server (local)', provider: 'openai_compatible',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'http://localhost:8080/v1',
    models: ['model'],
  },
  {
    id: 'localai', label: 'LocalAI (local)', provider: 'openai_compatible',
    capabilities: ['llm', 'embedding', 'vision'],
    baseUrl: 'http://localhost:8080/v1',
    models: ['model'],
  },
  {
    id: 'browser', label: 'Browser (no server)', provider: 'browser',
    capabilities: ['stt', 'tts'],
    baseUrl: '',
    models: [],
  },
  {
    id: 'local_neural', label: 'Built-in neural model', provider: 'local_neural',
    capabilities: ['embedding'],
    baseUrl: '',
    models: [],
  },
  {
    id: 'local_speech', label: 'Local ONNX speech models', provider: 'local_speech',
    capabilities: ['stt', 'tts'],
    baseUrl: '',
    models: [],
  },
]

export function presetsFor(capability: PresetCapability): AiPreset[] {
  return AI_PRESETS.filter((p) => p.capabilities.includes(capability))
}

export function findPreset(capability: PresetCapability, baseUrl: string, provider: string): AiPreset | undefined {
  return presetsFor(capability).find((p) => p.provider === provider && p.baseUrl === baseUrl)
}
