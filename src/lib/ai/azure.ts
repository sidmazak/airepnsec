/**
 * Azure OpenAI URL/header helpers (pure — unit-testable).
 *
 * Two supported base URL shapes:
 *  - deployment endpoint: https://res.openai.azure.com/openai/deployments/my-deploy
 *    → {base}/chat/completions?api-version=2024-10-21
 *  - v1 endpoint: https://res.openai.azure.com/openai/v1
 *    → {base}/chat/completions (no api-version)
 */

export const AZURE_DEFAULT_API_VERSION = '2024-10-21'

export function azureHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { 'api-key': apiKey } : {}),
  }
}

function stripResourcePath(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '')
  base = base.replace(/\/(chat\/completions|embeddings|images\/generations)$/i, '')
  return base
}

export function azureEndpoint(baseUrl: string, model: string): string {
  const base = stripResourcePath(baseUrl)
  if (!base) return ''
  if (/\/openai\/v1$/i.test(base)) return base
  if (/\/openai\/deployments\/[^/]+$/i.test(base)) return base
  if (/\/openai$/i.test(base)) return `${base}/deployments/${encodeURIComponent(model)}`
  return `${base}/openai/deployments/${encodeURIComponent(model)}`
}

export function azureUrl(
  baseUrl: string,
  model: string,
  path: 'chat/completions' | 'embeddings',
  apiVersion = AZURE_DEFAULT_API_VERSION
): string {
  const endpoint = azureEndpoint(baseUrl, model)
  if (!endpoint) return ''
  if (/\/openai\/v1$/i.test(endpoint)) return `${endpoint}/${path}`
  return `${endpoint}/${path}?api-version=${encodeURIComponent(apiVersion || AZURE_DEFAULT_API_VERSION)}`
}
