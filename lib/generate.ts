import Anthropic from '@anthropic-ai/sdk'
import { optional } from './env.js'

export type Log = (message: string) => void

const SYSTEM = `당신은 웹앱을 단일 HTML 파일로 만드는 엔지니어입니다.

출력 규칙 (반드시 지킬 것):
- 완성된 단일 HTML 문서 하나만 출력한다. 설명 문장, 마크다운 코드펜스 금지.
- 외부 CDN / 외부 폰트 / 외부 이미지 금지. CSS와 JS는 전부 인라인. 오프라인에서도 떠야 한다.
- 모바일 우선. 심사위원이 휴대폰으로 QR을 찍어서 본다. 터치 타겟은 44px 이상.
- 다크 테마. 배경 #0b0d10 계열, 본문 #e8eaed 계열, 포인트 컬러 하나만 골라서 일관되게.
- 첫 화면에서 바로 뭔가 동작해야 한다. 빈 상태 금지 — 그럴듯한 더미 데이터를 미리 채워 넣는다.
- 인터랙션이 최소 하나는 실제로 동작해야 한다 (클릭, 입력, 투표, 필터 등). <button> 을 최소 하나 포함한다.
- <title> 을 반드시 넣는다.

<!doctype html> 로 시작해서 </html> 로 끝나는 문서만 출력하세요.`

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
      max_tokens: 8000,
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
          choices?: { delta?: { content?: string }; message?: { content?: string } }[]
        }
        const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content
        if (delta) {
          out += delta
          if (++ticks % 60 === 0) onLog(`코드 생성 중... (${out.length}자)`)
        }
      } catch {
        // 부분 프레임 — 다음 청크에서 이어진다
      }
    }
  }

  return out
}

/** Anthropic으로 생성 (ANTHROPIC_API_KEY 가 있을 때만) */
async function chatAnthropic(userPrompt: string, onLog: Log): Promise<string> {
  const stream = new Anthropic().messages.stream({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'low' }, // 데모는 속도가 생명
    messages: [{ role: 'user', content: userPrompt }],
  })

  let ticks = 0
  stream.on('text', () => {
    if (++ticks % 40 === 0) onLog(`코드 생성 중... (${ticks * 8}자 내외)`)
  })

  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') {
    throw new Error('모델이 이 요청을 거절했습니다. 다른 프롬프트로 시도하세요.')
  }

  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** 어떤 엔진으로 생성할지 — 설정된 것을 그대로 쓴다. */
export function activeProvider(): { kind: 'openai-compatible' | 'anthropic'; label: string } {
  const endpoint = optional('LLM_ENDPOINT')
  if (endpoint && optional('LLM_MODEL')) {
    const local = /localhost|127\.0\.0\.1/.test(endpoint)
    return {
      kind: 'openai-compatible',
      label: `${local ? '로컬' : 'Nosana GPU'} · ${optional('LLM_MODEL')}`,
    }
  }
  if (optional('ANTHROPIC_API_KEY')) return { kind: 'anthropic', label: 'Anthropic · claude-opus-5' }
  throw new Error(
    '.env 에 LLM_ENDPOINT + LLM_MODEL (Nosana/Ollama) 또는 ANTHROPIC_API_KEY 중 하나는 있어야 합니다.',
  )
}

export async function chat(userPrompt: string, onLog: Log): Promise<string> {
  const provider = activeProvider()
  return provider.kind === 'anthropic'
    ? chatAnthropic(userPrompt, onLog)
    : chatOpenAICompatible(userPrompt, onLog)
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
