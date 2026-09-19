/**
 * 추론 엔드포인트 형태 자동 탐지.
 *
 * Nosana 배포마다 노출 경로가 다르다 (vLLM, Ollama, 커스텀 래퍼).
 * 데모 직전에 URL 형식 때문에 헤매지 않도록, 넣어준 주소에서
 * 실제로 동작하는 조합을 찾아낸다.
 */
const PATHS = ['/v1/chat/completions', '/chat/completions', '/api/v1/chat/completions']

export type Probe = {
  url: string
  /** OpenAI 호환 응답이면 여기에 텍스트가 담긴다 */
  sample: string
  status: number
}

function candidates(raw: string): string[] {
  const base = raw.replace(/\/+$/, '')
  const out = new Set<string>()

  // 이미 완전한 경로를 준 경우
  if (/chat\/completions$/.test(base)) out.add(base)

  // /v1 이 이미 붙어 있으면 그 뒤만 시도
  if (/\/v1$/.test(base)) out.add(`${base}/chat/completions`)

  for (const p of PATHS) out.add(`${base}${p}`)
  return [...out]
}

/** 후보 URL들을 돌려보고 OpenAI 호환으로 응답하는 첫 번째를 반환한다. */
export async function probeEndpoint(
  rawUrl: string,
  model: string,
  apiKey?: string,
): Promise<{ ok: true; probe: Probe } | { ok: false; tried: { url: string; why: string }[] }> {
  const tried: { url: string; why: string }[] = []

  for (const url of candidates(rawUrl)) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120000)

      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        }),
      }).finally(() => clearTimeout(timer))

      if (!res.ok) {
        tried.push({ url, why: `HTTP ${res.status} ${(await res.text()).slice(0, 120)}` })
        continue
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning?: string } }[]
        message?: { content?: string }
      }
      const msg = json.choices?.[0]?.message
      // 추론형 모델은 reasoning 에만 쓰고 content 가 빌 수 있다
      const text = msg?.content || msg?.reasoning || json.message?.content

      if (!text) {
        tried.push({ url, why: 'OpenAI 호환 응답 형태가 아님' })
        continue
      }
      return { ok: true, probe: { url, sample: text.trim(), status: res.status } }
    } catch (err) {
      tried.push({ url, why: err instanceof Error ? err.message : String(err) })
    }
  }

  return { ok: false, tried }
}

/** 동작하는 chat/completions URL 에서 .env 에 넣을 base 를 역산한다. */
export function baseFrom(workingUrl: string): string {
  return workingUrl.replace(/\/chat\/completions$/, '')
}
