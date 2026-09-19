import { optional } from './env.js'

export type Credits = {
  assigned: number
  reserved: number
  settled: number
  free: number
  level: 'ok' | 'low' | 'critical'
}

/** 남은 크레딧이 이 아래면 경고한다. */
const LOW = 3
const CRITICAL = 1

/**
 * Nosana 크레딧 잔액.
 *
 * 배포가 도는 동안 reserved 가 늘어난다. 데모 전에 남은 양을 보고
 * 리허설 횟수를 정하려고 화면에 띄운다.
 */
export async function nosanaCredits(): Promise<Credits | null> {
  const key = optional('NOSANA_API_KEY')
  if (!key) return null

  try {
    const res = await fetch('https://api.nosana.com/credits/balance', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null

    const d = (await res.json()) as {
      assignedCredits?: number
      reservedCredits?: number
      settledCredits?: number
    }
    const assigned = d.assignedCredits ?? 0
    const reserved = d.reservedCredits ?? 0
    const settled = d.settledCredits ?? 0
    const free = Math.max(0, assigned - reserved - settled)

    return {
      assigned,
      reserved,
      settled,
      free,
      level: free <= CRITICAL ? 'critical' : free <= LOW ? 'low' : 'ok',
    }
  } catch {
    return null
  }
}

/** 크레딧이 바닥나기 전에 멈출지 판단한다. */
export function shouldStop(c: Credits | null): boolean {
  return c !== null && c.level === 'critical'
}
