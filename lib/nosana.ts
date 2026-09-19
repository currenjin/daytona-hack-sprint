import { optional } from './env.js'
import type { Log } from './generate.js'

/**
 * Nosana GPU에서 오픈모델로 생성된 앱을 검수한다.
 *
 * ⚠️ 전날 반드시 확인할 것:
 *   NOSANA_ENDPOINT 가 OpenAI 호환 /chat/completions 를 제공하는지.
 *   형식이 다르면 아래 body/파싱 두 줄만 고치면 된다.
 *   실패해도 전체 플로우는 절대 막지 않는다 (null 반환).
 */
export async function reviewApp(html: string, onLog: Log): Promise<string | null> {
  const endpoint = optional('NOSANA_ENDPOINT')
  const model = optional('NOSANA_MODEL')
  const apiKey = optional('NOSANA_API_KEY')

  if (!endpoint || !model) {
    onLog('Nosana 설정 미완료 — 검수를 건너뜁니다')
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)

  try {
    onLog('Nosana GPU에서 앱 검수 중...')
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 160,
        messages: [
          {
            role: 'system',
            content:
              'You review a single-file HTML app. Reply with ONE short Korean sentence: ' +
              'the single most important issue, or "이상 없음" if it looks fine. No preamble.',
          },
          { role: 'user', content: html.slice(0, 6000) },
        ],
      }),
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = json.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('빈 응답')

    onLog(`Nosana 검수: ${text}`)
    return text
  } catch (err) {
    onLog(`Nosana 검수 건너뜀 (${err instanceof Error ? err.message : String(err)})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
