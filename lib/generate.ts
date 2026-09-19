import { optional } from './env.js'

export type Log = (message: string) => void

const SYSTEM = `당신은 코드 변경을 분석하고 테스트를 작성하는 시니어 엔지니어입니다.
요청받은 것만 정확히 출력하세요. 인사말·설명·사족을 붙이지 마세요.

/no_think`

/**
 * OpenAI 호환 엔드포인트로 생성 (Nosana GPU / 로컬 Ollama / vLLM).
 *
 * Nosana는 컨테이너를 GPU에 띄우고 URL을 노출하는 방식이라,
 * vLLM이나 Ollama 이미지를 배포하면 이 규격이 그대로 나온다.
 * 같은 이유로 로컬 Ollama(http://localhost:11434/v1)로 오프라인 테스트가 된다.
 */
async function chatOpenAICompatible(userPrompt: string, onLog: Log): Promise<string> {
  const base = optional('LLM_ENDPOINT').replace(/\/$/, '')
  const model = optional('LLM_MODEL')
  const apiKey = optional('LLM_API_KEY')

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 16000,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!res.ok || !res.body) {
    throw new Error(`생성 엔드포인트 오류 (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let out = ''
  let reasoning = ''
  let ticks = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let i: number
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:')) continue

      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue

      try {
        const json = JSON.parse(payload) as {
          choices?: {
            delta?: { content?: string; reasoning?: string }
            message?: { content?: string; reasoning?: string }
          }[]
        }
        const d = json.choices?.[0]?.delta ?? json.choices?.[0]?.message
        // 추론형 모델(qwen3 등)은 reasoning 으로 흘리고 content 가 비기도 한다.
        // 최종 답만 필요하므로 content 를 우선하되, 둘 다 모아둔다.
        const delta = d?.content || ''
        if (!delta && d?.reasoning) reasoning += d.reasoning
        if (delta) {
          out += delta
          if (++ticks % 60 === 0) onLog(`코드 생성 중... (${out.length}자)`)
        }
      } catch {
        // 부분 프레임 — 다음 청크에서 이어진다
      }
    }
  }

  return out || reasoning
}

/** 어떤 엔진으로 생성할지 — 설정된 것을 그대로 쓴다. */
export function activeProvider(): { label: string } {
  const endpoint = optional('LLM_ENDPOINT')
  if (!endpoint || !optional('LLM_MODEL')) {
    throw new Error('.env 에 LLM_ENDPOINT 와 LLM_MODEL (Nosana) 을 넣어야 합니다.')
  }
  const local = /localhost|127\.0\.0\.1/.test(endpoint)
  return { label: `${local ? '로컬' : 'Nosana GPU'} · ${optional('LLM_MODEL')}` }
}

export async function chat(userPrompt: string, onLog: Log): Promise<string> {
  activeProvider() // 설정 검증
  return chatOpenAICompatible(userPrompt, onLog)
}

/** 모델 출력에서 HTML 문서만 잘라낸다. 오픈모델은 코드펜스·잡담을 자주 붙인다. */
function extractHtml(raw: string): string {
  let html = raw.trim().replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim()

  const start = html.search(/<!doctype html|<html/i)
  if (start > 0) html = html.slice(start)

  const end = html.toLowerCase().lastIndexOf('</html>')
  if (end !== -1) html = html.slice(0, end + 7)

  if (!/<html/i.test(html)) {
    throw new Error('생성된 결과가 HTML 문서가 아닙니다. 모델을 바꾸거나 다시 시도하세요.')
  }
  return html
}

/** 사용자 요청 한 줄 → 단일 index.html */
export async function generateApp(userPrompt: string, onLog: Log): Promise<Record<string, string>> {
  onLog(`앱 설계 중... (${activeProvider().label})`)
  const html = extractHtml(await chat(userPrompt, onLog))
  onLog(`앱 완성 (${(html.length / 1024).toFixed(1)}KB)`)
  return { 'index.html': html }
}

/** 검증에서 나온 문제를 되먹여 앱을 고친다. */
export async function repairApp(
  html: string,
  issues: string[],
  onLog: Log,
): Promise<Record<string, string>> {
  onLog(`문제 ${issues.length}건 발견 — 수정 중...`)

  const prompt = `아래 HTML 앱을 샌드박스에서 실행했더니 다음 문제가 나왔습니다.

${issues.map((i) => `- ${i}`).join('\n')}

이 문제들을 고친 전체 HTML 문서를 다시 출력하세요.
디자인과 기능은 최대한 유지하고, 문제가 된 부분만 고치세요.

--- 현재 HTML ---
${html}`

  const fixed = extractHtml(await chat(prompt, onLog))
  onLog(`수정 완료 (${(fixed.length / 1024).toFixed(1)}KB)`)
  return { 'index.html': fixed }
}

/** <title> 추출 — 로그 표시에 쓴다. */
export function extractTitle(html: string): string {
  const m = html.match(/<title>([^<]*)<\/title>/i)
  return m?.[1]?.trim() || 'Untitled'
}
