const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'])
const START_WORDS = new Set(['START', 'UNSTOP', 'RESUME'])

export type ConsentKeyword = 'stop' | 'start' | null

export function consentKeyword(body: string): ConsentKeyword {
  const word = body.trim().toUpperCase().replace(/[^A-Z]/g, '')
  if (STOP_WORDS.has(word)) return 'stop'
  if (START_WORDS.has(word)) return 'start'
  return null
}
